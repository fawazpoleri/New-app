/* ============================================================================================
   Suppliers — Supabase data layer (window.Suppliers) for Kaapi POS. Ported from MyCafe.
   * READS: the five supplier tables are loaded into a cache and every figure (bill status, outstanding,
     overdue, reports) is derived from those rows.
   * WRITES: only the sup_* database functions in suppliers.sql (each one transaction; they enforce
     no-overpay, duplicate-bill and double-tap protection). After every write the cache is reloaded.
   * Amounts are integer paise, dates are plain YYYY-MM-DD text.
   ============================================================================================ */
(function () {
  "use strict";
  const sb = () => window.SupabaseDB.client;
  const PAGE = 1000;
  let cache = null, loading = null, loadError = null, loadedAt = 0;
  let version = 0;

  /* ---------- errors ---------- */
  function fail(error) {
    let msg = (error && error.message) || "Request failed";
    const e = new Error(msg);
    e.code = error && error.code;
    if (error && (error.code === "PGRST202" || error.code === "42883" || error.code === "42P01" || error.code === "PGRST205" || /could not find the (function|table)|does not exist/i.test(msg))) {
      e.message = "Suppliers aren't set up yet — run migrations/0011_suppliers.sql in the Supabase SQL editor.";
    } else if (error && !error.code && /fetch|network|abort|load failed/i.test(msg)) {
      e.message = "Can't reach the server. Check your internet connection and try again.";
    }
    const hint = (error && error.hint) || "";
    e.denied = (error && (error.code === "42501" || error.status === 401 || error.status === 403)) || /row-level security|permission denied/i.test(msg);
    e.overpay = hint === "overpay"; e.insufficient = hint === "insufficient"; if (hint === "duplicate_bill") e.duplicateBill = true;
    return e;
  }
  async function rpc(name, args) {
    let res;
    try { res = await sb().rpc(name, args); } catch (x) { throw fail({ message: x && x.message }); }
    if (res.error) throw fail(res.error);
    return res.data;
  }
  async function fetchAll(table, orderBy) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const res = await sb().from(table).select("*").order(orderBy || "id").range(from, from + PAGE - 1);
      if (res.error) throw fail(res.error);
      out.push(...res.data);
      if (res.data.length < PAGE) break;
    }
    return out;
  }

  /* ---------- loading ---------- */
  async function fetchFileIds() {        // only which bills have a file; the file itself is fetched on demand
    const res = await sb().from("purchase_bill_files").select("bill_id").limit(5000);
    if (res.error) return new Set();     // suppliers.sql not re-run yet: the rest of Suppliers keeps working
    return new Set(res.data.map(r => r.bill_id));
  }
  async function load() {
    if (!sb()) throw new Error("Supabase is not configured");
    const [suppliers, bills, items, payments, allocs] = await Promise.all([
      fetchAll("suppliers"), fetchAll("purchase_bills"), fetchAll("purchase_items"), fetchAll("supplier_payments"), fetchAll("supplier_allocations")]);
    const files = await fetchFileIds();
    cache = { suppliers, bills, items, payments, allocs, files };
    loadedAt = Date.now(); loadError = null; version++;
    index();
  }
  let byId = {}, paidByBill = {}, allocByPay = {}, itemsByBill = {};
  function index() {
    byId = {}; paidByBill = {}; allocByPay = {}; itemsByBill = {};
    cache.suppliers.forEach(s => { byId["s" + s.id] = s; });
    const pay = {}; cache.payments.forEach(p => { pay[p.id] = p; });
    cache.allocs.forEach(a => {
      allocByPay[a.payment_id] = (allocByPay[a.payment_id] || 0) + Number(a.amount_paise);
      const p = pay[a.payment_id];
      if (p && p.status === "valid") paidByBill[a.bill_id] = (paidByBill[a.bill_id] || 0) + Number(a.amount_paise);
    });
    cache.items.forEach(i => { (itemsByBill[i.bill_id] = itemsByBill[i.bill_id] || []).push(i); });
    Object.values(itemsByBill).forEach(l => l.sort((a, b) => a.line_no - b.line_no));
  }
  function ensureLoaded() {
    if (cache && !loadError) return Promise.resolve();
    if (!loading) loading = load().catch(e => { loadError = e; }).finally(() => { loading = null; });
    return loading;
  }
  function refreshQuietly(then) {            // another device may have recorded something: re-read, then redraw
    if (loading) return;
    loading = load().catch(() => { loadedAt = Date.now(); /* keep showing the last good data; try again later */ }).finally(() => { loading = null; if (then) then(); });
  }
  const status = () => ({ ready: !!cache && !loadError, loading: !!loading, error: loadError ? loadError.message : null, ageMs: Date.now() - loadedAt, version });
  function reset() { cache = null; loadError = null; loading = null; loadedAt = 0; }
  async function reloadAfterWrite() { reset(); await ensureLoaded(); if (loadError) throw loadError; }

  /* ---------- dates / helpers (identical rules to the offline app) ---------- */
  const pad2 = (n) => String(n).padStart(2, "0");
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function validDate(s) {
    if (typeof s !== "string" || !DATE_RE.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const localToday = (ts) => { const d = ts ? new Date(ts) : new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); };
  const asOfOf = (v) => (validDate(v) ? v : localToday());
  const daysBetween = (a, b) => { const x = a.split("-").map(Number), y = b.split("-").map(Number); return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 86400000); };
  const sumP = (a, k) => a.reduce((s, x) => s + x[k], 0);
  const groupBy = (a, fn) => { const m = new Map(); a.forEach(x => { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };
  const inRange = (d, f) => (!f.from || d >= f.from) && (!f.to || d <= f.to);
  const need = () => { if (!cache) throw new Error("Suppliers are still loading"); };

  /* ---------- views ---------- */
  function billView(r, asOf) {
    const cancelled = r.status === "cancelled", paid = paidByBill[r.id] || 0, total = Number(r.total_paise);
    const outstanding = cancelled ? 0 : Math.max(0, total - paid);
    const st = cancelled ? "CANCELLED" : outstanding === 0 ? "PAID" : paid === 0 ? "UNPAID" : "PARTIAL";
    const overdue = !cancelled && outstanding > 0 && !!r.due_date && r.due_date < asOf;
    const sup = byId["s" + r.supplier_id];
    return { id: r.id, supplierId: r.supplier_id, supplierName: sup ? sup.name : "", kind: r.kind, billNo: r.bill_no, billDate: r.bill_date, dueDate: r.due_date || null,
      subtotalPaise: Number(r.subtotal_paise), discountPaise: Number(r.discount_paise), taxPaise: Number(r.tax_paise), otherPaise: Number(r.other_paise),
      totalPaise: total, paidPaise: cancelled ? 0 : paid, outstandingPaise: outstanding, status: st, overdue, daysOverdue: overdue ? daysBetween(r.due_date, asOf) : 0,
      notes: r.notes || "", cancelled, cancelReason: r.cancel_reason || null, createdAt: Date.parse(r.created_at) || 0 };
  }
  function paymentView(r) {
    const sup = byId["s" + r.supplier_id], bill = r.bill_id ? cache.bills.find(b => b.id === r.bill_id) : null;
    return { id: r.id, supplierId: r.supplier_id, supplierName: sup ? sup.name : null, billId: r.bill_id || null, billNo: bill ? bill.bill_no : null, kind: r.kind,
      amountPaise: Number(r.amount_paise), method: r.method, account: r.account, paidOn: r.paid_on, paidAt: Number(r.paid_at), reference: r.reference || "", notes: r.notes || "",
      ledgerId: r.ledger_id, status: r.status, reversedAt: r.reversed_at == null ? null : Number(r.reversed_at), reverseReason: r.reverse_reason || null, createdBy: r.created_by || null,
      allocatedPaise: allocByPay[r.id] || 0 };
  }
  function supplierTotals(id, asOf) {
    const live = cache.bills.filter(b => b.supplier_id === id).map(b => billView(b, asOf)).filter(b => !b.cancelled);
    const pays = cache.payments.filter(p => p.supplier_id === id && p.status === "valid");
    const adv = pays.filter(p => p.kind === "advance").reduce((s, p) => s + Number(p.amount_paise) - (allocByPay[p.id] || 0), 0);
    return { totalPurchasesPaise: sumP(live.filter(b => b.kind === "purchase"), "totalPaise"), totalPaidPaise: pays.reduce((s, p) => s + Number(p.amount_paise), 0),
      outstandingPaise: sumP(live, "outstandingPaise"), overduePaise: sumP(live.filter(b => b.overdue), "outstandingPaise"), advancePaise: adv,
      billCount: live.length, unpaidCount: live.filter(b => b.status === "UNPAID").length, partialCount: live.filter(b => b.status === "PARTIAL").length,
      paidCount: live.filter(b => b.status === "PAID").length, overdueCount: live.filter(b => b.overdue).length };
  }
  const supplierView = (r, asOf) => ({ id: r.id, name: r.name, phone: r.phone || "", address: r.address || "", notes: r.notes || "", openingPaise: Number(r.opening_paise), active: !!r.active, createdAt: Date.parse(r.created_at) || 0, ...supplierTotals(r.id, asOf) });
  const allBills = (asOf) => cache.bills.slice().sort((a, b) => (a.bill_date < b.bill_date ? 1 : a.bill_date > b.bill_date ? -1 : (a.created_at < b.created_at ? 1 : -1))).map(b => billView(b, asOf));

  /* ---------- reads ---------- */
  function list(opts) {
    need(); opts = opts || {};
    const asOf = asOfOf(opts.asOf), term = String(opts.search || "").toLowerCase().replace(/\s+/g, " ").trim();
    return cache.suppliers.slice().sort((a, b) => (a.name_key < b.name_key ? -1 : 1)).filter(r => (opts.includeInactive || r.active) && (!term || r.name_key.includes(term) || String(r.phone || "").includes(term))).map(r => supplierView(r, asOf));
  }
  function get(id, opts) {
    need(); const asOf = asOfOf(opts && opts.asOf), r = byId["s" + id];
    if (!r) throw new Error("Supplier not found");
    const pays = cache.payments.filter(p => p.supplier_id === id).sort((a, b) => Number(b.paid_at) - Number(a.paid_at)).map(paymentView);
    return { supplier: supplierView(r, asOf), bills: allBills(asOf).filter(b => b.supplierId === id), payments: pays,
             advances: pays.filter(p => p.kind === "advance" && p.status === "valid" && p.amountPaise - p.allocatedPaise > 0).reverse() };
  }
  function bill(id, opts) {
    need(); const asOf = asOfOf(opts && opts.asOf), r = cache.bills.find(b => b.id === id);
    if (!r) throw new Error("Bill not found");
    const ids = new Set(cache.allocs.filter(a => a.bill_id === id).map(a => a.payment_id));
    return { bill: billView(r, asOf),
      items: (itemsByBill[id] || []).map(i => ({ id: i.id, name: i.name, qtyMilli: Number(i.qty_milli), unit: i.unit, unitPricePaise: Number(i.unit_price_paise), linePaise: Number(i.line_paise) })),
      payments: cache.payments.filter(p => ids.has(p.id)).sort((a, b) => Number(a.paid_at) - Number(b.paid_at)).map(p => ({ ...paymentView(p), recordedBy: null,
        allocatedToThisBillPaise: cache.allocs.filter(a => a.payment_id === p.id && a.bill_id === id).reduce((s, a) => s + Number(a.amount_paise), 0) })) };
  }
  function filterBills(f) {
    f = f || {}; const asOf = asOfOf(f.asOf);
    return allBills(asOf).filter(b => (!f.supplierId || b.supplierId === f.supplierId) && (!f.status || b.status === f.status) &&
      (f.due === "overdue" ? b.overdue : f.due === "upcoming" ? (!b.cancelled && b.outstandingPaise > 0 && !b.overdue && !!b.dueDate) : f.due === "none" ? !b.dueDate : true) &&
      (f.includeCancelled || !b.cancelled) && (!f.kind || b.kind === f.kind));
  }
  const bills = (f) => { need(); f = f || {}; return filterBills(f).filter(b => inRange(b.billDate, f)); };
  function payments(f) {
    need(); f = f || {};
    return cache.payments.slice().sort((a, b) => Number(b.paid_at) - Number(a.paid_at)).map(paymentView).filter(p =>
      (!f.supplierId || p.supplierId === f.supplierId) && (!f.method || p.method === f.method) && (!f.account || p.account === f.account) && (f.includeReversed || p.status === "valid") && inRange(p.paidOn, f));
  }
  const unusedAdvance = () => cache.payments.filter(p => p.kind === "advance" && p.status === "valid").reduce((s, p) => s + Number(p.amount_paise) - (allocByPay[p.id] || 0), 0);

  function report(kind, f) {
    need(); f = f || {}; const asOf = asOfOf(f.asOf);
    if (kind === "purchases") {
      const bs = bills({ ...f, kind: "purchase", asOf });
      const bySupplier = [...groupBy(bs, b => b.supplierId)].map(([id, x]) => ({ supplierId: id, supplierName: x[0].supplierName, bills: x.length, totalPaise: sumP(x, "totalPaise"), paidPaise: sumP(x, "paidPaise"), outstandingPaise: sumP(x, "outstandingPaise") }));
      return { from: f.from || null, to: f.to || null, billCount: bs.length, totalPaise: sumP(bs, "totalPaise"), paidPaise: sumP(bs, "paidPaise"), outstandingPaise: sumP(bs, "outstandingPaise"), bySupplier, rows: bs };
    }
    if (kind === "payments") {
      const pays = payments({ ...f }), cash = pays.filter(p => p.account === "drawer"), bank = pays.filter(p => p.account === "bank");
      const rev = payments({ includeReversed: true }).filter(p => p.status === "reversed" && p.reversedAt && inRange(localToday(p.reversedAt), f));
      return { from: f.from || null, to: f.to || null, count: pays.length, totalPaise: sumP(pays, "amountPaise"), cashPaise: sumP(cash, "amountPaise"), bankPaise: sumP(bank, "amountPaise"),
        cashCount: cash.length, bankCount: bank.length, reversedCount: rev.length, reversedPaise: sumP(rev, "amountPaise"), rows: pays };
    }
    if (kind === "outstanding") {
      const bs = filterBills({ ...f, asOf }).filter(b => b.outstandingPaise > 0);
      const sups = [...groupBy(bs, b => b.supplierId)].map(([id, x]) => ({ supplierId: id, supplierName: x[0].supplierName, outstandingPaise: sumP(x, "outstandingPaise"), overduePaise: sumP(x.filter(b => b.overdue), "outstandingPaise"),
        unpaidBills: x.filter(b => b.status === "UNPAID").length, partialBills: x.filter(b => b.status === "PARTIAL").length, bills: x })).sort((a, b) => b.outstandingPaise - a.outstandingPaise);
      return { asOf, suppliers: sups, grandOutstandingPaise: sumP(sups, "outstandingPaise"), grandOverduePaise: sumP(sups, "overduePaise"), unpaidBills: sumP(sups, "unpaidBills"), partialBills: sumP(sups, "partialBills"), unusedAdvancePaise: unusedAdvance() };
    }
    if (kind === "paid") {
      const rows = filterBills({ ...f, asOf, status: "PAID" }).map(b => {
        const d = bill(b.id, { asOf }), valid = d.payments.filter(p => p.status === "valid");
        const last = valid.reduce((m, p) => (p.paidOn > m ? p.paidOn : m), "");
        return { ...b, completedOn: last || b.billDate, payments: valid };
      }).filter(b => inRange(b.completedOn, f));
      return { from: f.from || null, to: f.to || null, count: rows.length, totalPaise: sumP(rows, "totalPaise"), rows };
    }
    throw new Error("Unknown report");
  }
  function dashboard(opts) {
    need(); const asOf = asOfOf(opts && opts.asOf), live = filterBills({ asOf });
    const today = payments({ from: asOf, to: asOf }), todayBills = live.filter(b => b.kind === "purchase" && b.billDate === asOf);
    return { asOf, purchasesTodayPaise: sumP(todayBills, "totalPaise"), purchasesTodayCount: todayBills.length, paymentsTodayPaise: sumP(today, "amountPaise"),
      paymentsTodayCashPaise: sumP(today.filter(p => p.account === "drawer"), "amountPaise"), paymentsTodayBankPaise: sumP(today.filter(p => p.account === "bank"), "amountPaise"),
      outstandingPaise: sumP(live, "outstandingPaise"), unpaidCount: live.filter(b => b.status === "UNPAID").length, partialCount: live.filter(b => b.status === "PARTIAL").length,
      paidCount: live.filter(b => b.status === "PAID" && b.kind === "purchase").length, overdueCount: live.filter(b => b.overdue).length, overduePaise: sumP(live.filter(b => b.overdue), "outstandingPaise"), unusedAdvancePaise: unusedAdvance() };
  }

  /* ---------- writes (each is one database function = one transaction) ---------- */
  const txt = (v, max) => String(v === undefined || v === null ? "" : v).trim().slice(0, max);
  const isPaise = (v, min) => Number.isSafeInteger(v) && v >= (min || 0) && v <= 100000000000;
  async function save(inp) {
    inp = inp || {}; const name = txt(inp.name, 120);
    if (!name) throw new Error("Enter the supplier's name");
    if (inp.openingPaise !== undefined && !isPaise(inp.openingPaise)) throw new Error("Opening balance is not a valid amount");
    const r = await rpc("sup_save", { p_id: inp.id || null, p_name: name, p_phone: txt(inp.phone, 30), p_address: txt(inp.address, 300), p_notes: txt(inp.notes, 500), p_opening: inp.id ? 0 : (inp.openingPaise || 0), p_today: localToday() });
    await reloadAfterWrite(); return supplierView(byId["s" + r.id], asOfOf());
  }
  async function setActive(id, active) { await rpc("sup_set_active", { p_id: id, p_active: !!active }); await reloadAfterWrite(); return true; }
  async function createPurchase(inp) {
    inp = inp || {};
    if (!Array.isArray(inp.items) || !inp.items.length) throw new Error("Add at least one purchase item");
    if (!validDate(inp.billDate)) throw new Error("Enter a valid purchase date");
    if (inp.dueDate && !validDate(inp.dueDate)) throw new Error("Enter a valid due date");
    const pay = inp.payment && Number(inp.payment.amountPaise) > 0 ? { amountPaise: Number(inp.payment.amountPaise), method: inp.payment.method, account: inp.payment.account || null, reference: txt(inp.payment.reference, 80), notes: txt(inp.payment.notes, 300) } : null;
    const r = await rpc("sup_create_purchase", { p_request_id: txt(inp.requestId, 80), p_supplier_id: inp.supplierId, p_bill_no: txt(inp.billNo, 60), p_bill_date: inp.billDate, p_due_date: inp.dueDate || null,
      p_items: inp.items.map(i => ({ name: i.name, qtyMilli: i.qtyMilli, unit: i.unit || "", unitPricePaise: i.unitPricePaise })),
      p_discount: inp.discountPaise || 0, p_tax: inp.taxPaise || 0, p_other: inp.otherPaise || 0, p_notes: txt(inp.notes, 500),
      p_expected_total: inp.expectedTotalPaise === undefined ? null : inp.expectedTotalPaise, p_payment: pay, p_today: localToday() });
    await reloadAfterWrite(); return { replayed: !!r.replayed, ...bill(r.billId) };
  }
  /* ---- original bill (photo / PDF) ---- */
  const hasFile = (billId) => { need(); return !!(cache.files && cache.files.has(billId)); };
  async function billFile(billId) {
    need(); const res = await sb().from("purchase_bill_files").select("name,mime,data").eq("bill_id", billId).maybeSingle();
    if (res.error) throw fail(res.error);
    return res.data ? { name: res.data.name, mime: res.data.mime, dataUrl: res.data.data } : null;
  }
  async function attachFile(billId, f) { f = f || {}; await rpc("sup_attach_file", { p_bill_id: billId, p_name: f.name || "", p_mime: f.mime, p_data: f.dataUrl }); await reloadAfterWrite(); return true; }
  async function removeFile(billId) { await rpc("sup_remove_file", { p_bill_id: billId }); await reloadAfterWrite(); return true; }
  async function pay(inp) {
    inp = inp || {};
    const r = await rpc("sup_pay", { p_request_id: txt(inp.requestId, 80), p_bill_id: inp.billId || null, p_supplier_id: inp.supplierId || null, p_advance: !!inp.advance, p_amount: inp.amountPaise,
      p_method: txt(inp.method, 10).toLowerCase(), p_account: inp.account || null, p_reference: txt(inp.reference, 80), p_notes: txt(inp.notes, 300), p_today: localToday() });
    await reloadAfterWrite(); return { replayed: !!r.replayed, paymentId: r.paymentId, ...(r.billId ? bill(r.billId) : {}) };
  }
  async function allocateAdvance(inp) { inp = inp || {}; const r = await rpc("sup_allocate_advance", { p_payment_id: inp.paymentId, p_bill_id: inp.billId, p_amount: inp.amountPaise }); await reloadAfterWrite(); return bill(r.billId); }
  async function reversePayment(paymentId, reason) { const r = await rpc("sup_reverse_payment", { p_payment_id: paymentId, p_reason: txt(reason, 200) }); await reloadAfterWrite(); return r.billId ? bill(r.billId) : { ok: true }; }
  async function cancelBill(billId, reason) { const r = await rpc("sup_cancel_bill", { p_bill_id: billId, p_reason: txt(reason, 200) }); await reloadAfterWrite(); return bill(r.billId); }

  window.Suppliers = { hasFile, billFile, attachFile, removeFile, list, get, bill, save, setActive, createPurchase, pay, allocateAdvance, reversePayment, cancelBill, bills, payments, report, dashboard, today: () => localToday(),
    // the screen asks these before drawing
    status, ensureLoaded, refreshQuietly, reset };
})();
