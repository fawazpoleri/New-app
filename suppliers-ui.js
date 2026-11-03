/* ============================================================================================
   Suppliers screen (Kaapi POS port of MyCafe). Admin-only; no cashbook: payments record the method only.
   Suppliers screen (purchases, payments, reports). Pure UI: every number and every rule lives in
   backend.js (window.Suppliers). This file only collects input, calls that API and draws results.
   It talks to the rest of the app through window.AppBridge (set in index.html).
   ============================================================================================ */
(function () {
  "use strict";
  const B = () => window.AppBridge;
  const API = () => window.Suppliers;
  const esc = (s) => B().escapeHtml(s === undefined || s === null ? "" : s);
  const m = (p) => B().money(p / 100);                      // paise -> "₹1234.50", same look as the rest of the app
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dmy = (s) => { if (!s) return "—"; const p = String(s).split("-"); return p.length === 3 ? Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0] : s; };
  const METHOD = { cash: "Cash", upi: "UPI", bank: "Bank transfer", card: "Card", other: "Other" };
  const ACCOUNT = { drawer: "Cash", bank: "Bank / UPI" };
  const rid = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

  /* ---- input parsing: decimal text -> integer paise / thousandths, never floating point ---- */
  function toPaise(str) {
    str = String(str === undefined || str === null ? "" : str).trim().replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
    const p = str.split("."); return Number(p[0]) * 100 + Number(((p[1] || "") + "00").slice(0, 2));
  }
  function toMilli(str) {
    str = String(str === undefined || str === null ? "" : str).trim();
    if (!/^\d+(\.\d{1,3})?$/.test(str)) return null;
    const p = str.split("."); return Number(p[0]) * 1000 + Number(((p[1] || "") + "000").slice(0, 3));
  }
  const lineOf = (qtyMilli, pricePaise) => Math.floor((qtyMilli * pricePaise + 500) / 1000);

  /* ---- screen state (kept while the tab is open; the app re-renders freely) ---- */
  const monthStart = () => API().today().slice(0, 8) + "01";
  const S = {
    view: "home", section: "suppliers", supplierId: null, billId: null, search: "", archived: false,
    bills: { status: "", due: "", supplierId: "", from: "", to: "" },
    pays: { supplierId: "", method: "", from: "", to: "" },
    report: { kind: "purchases", from: null, to: null }
  };
  let modal = null;           // { title, html, saveLabel, onSave, danger, busy, onOpen }
  let bound = false;

  const fileApi = () => { try { return typeof API().hasFile === "function" && typeof API().attachFile === "function"; } catch (_) { return false; } };
  const can = (perm) => B().can(perm);
  const empty = (icon, title, body) => `<div class="empty-state"><div class="big">${icon}</div><div style="font-weight:700; font-size:15px;">${esc(title)}</div><p>${esc(body || "")}</p></div>`;
  const statCard = (label, val, cls, sub) => `<div class="stat-card ${cls || ""}"><div class="slabel">${esc(label)}</div><div class="sval">${val}</div>${sub ? `<div class="ksub">${sub}</div>` : ""}</div>`;
  function statusBadge(b) {
    const cls = b.status === "PAID" ? "badge-cash" : b.status === "PARTIAL" ? "badge-upi" : b.status === "UNPAID" ? "badge-mixed" : "";
    const label = b.status === "PARTIAL" ? "Partly paid" : b.status === "PAID" ? "Paid" : b.status === "UNPAID" ? "Unpaid" : "Cancelled";
    return `<span class="badge ${cls}" ${cls ? "" : `style="background:var(--surface-2); color:var(--text-faint);"`}>${label}</span>` +
      (b.overdue ? ` <span class="badge badge-mixed" style="background:rgba(196,87,59,.35);">Overdue ${b.daysOverdue}d</span>` : "");
  }
  const sel = (id, opts, cur) => `<select id="${id}">${opts.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(cur) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;

  /* ============================================================ screens */
  function render() {
    try {
      if (!can("suppliers.manage")) return empty("🔒", "Admin only", "Log in as admin (🔒 at the top) to open Suppliers.");
      // Online app only: the supplier books are read from the server first (the offline database is already in memory).
      const st = API().status ? API().status() : null;
      if (st) {
        if (!st.ready) {
          if (st.error) return empty("⚠️", "Couldn't load suppliers", st.error) + `<div style="text-align:center;"><button class="btn btn-amber" data-sup="retry">Try again</button></div>`;
          if (!st.loading) API().ensureLoaded().then(() => B().render());
          return empty("⏳", "Loading suppliers…", "One moment.");
        }
        if (st.ageMs > 15000 && !st.loading) API().refreshQuietly(() => B().render());   // another device may have recorded something
      }
      if (S.view === "supplier") return renderSupplier();
      if (S.view === "bill") return renderBill();
      return renderHome();
    } catch (e) {
      console.error("suppliers screen", e);
      return empty("⚠️", "Couldn't load suppliers", e && e.message ? e.message : "Try again.");
    }
  }

  function renderHome() {
    const d = API().dashboard();
    const cards = `<div class="stat-grid">
      ${statCard("You owe", m(d.outstandingPaise), "accent", d.unusedAdvancePaise ? "Advances " + m(d.unusedAdvancePaise) : (d.unpaidCount + d.partialCount) + " unpaid bill" + ((d.unpaidCount + d.partialCount) === 1 ? "" : "s"))}
      ${statCard("Overdue", m(d.overduePaise), "", d.overdueCount ? d.overdueCount + " bill" + (d.overdueCount === 1 ? "" : "s") : "Nothing overdue")}</div>`;
    const tabs = [["suppliers", "🏪", "Suppliers"], ["bills", "🧾", "Bills"], ["payments", "💸", "Paid"], ["reports", "📊", "Reports"]];
    const seg = `<div class="rtabs">${tabs.map(t => `<button data-sup="section" data-v="${t[0]}" class="${S.section === t[0] ? "active" : ""}"><span>${t[1]}</span>${t[2]}</button>`).join("")}</div>`;
    const actions = `<div class="cb-actions" style="margin-bottom:14px;"><button class="btn btn-amber" data-sup="new-purchase">🧾 New bill</button><button class="btn btn-outline" data-sup="new-supplier">➕ Supplier</button></div>`;
    let body = "";
    if (S.section === "suppliers") body = suppliersList();
    else if (S.section === "bills") body = billsList();
    else if (S.section === "payments") body = paymentsList();
    else body = reportsView();
    return cards + actions + seg + body;
  }

  function suppliersList() {
    const list = API().list({ search: S.search, includeInactive: S.archived });
    const rows = list.map(s => `
      <div class="order-row" data-sup="open-supplier" data-id="${esc(s.id)}" style="cursor:pointer;">
        <div class="otop"><div><div class="oleft">${esc(s.name)} ${s.active ? "" : `<span class="badge" style="background:var(--surface-2);color:var(--text-faint);">Archived</span>`}</div>
          <div class="otime">${esc(s.phone || "No phone")}</div></div>
          <div style="text-align:right;"><div style="font-weight:700; color:${s.outstandingPaise > 0 ? "#e79080" : "var(--teal)"};">${m(s.outstandingPaise)}</div>
          <div class="otime">${s.overdueCount ? `<span style="color:#e79080;">${s.overdueCount} overdue</span>` : "owed"}</div></div></div></div>`).join("");
    return `<div class="field"><input type="search" id="supSearch" placeholder="Search suppliers by name or phone" value="${esc(S.search)}" autocomplete="off"></div>
      ${rows || empty("🏪", S.search ? "No supplier matches" : "No suppliers yet", S.search ? "Try a different name." : "Tap “➕ Supplier” to add the first one.")}
      <button class="linkbtn" data-sup="toggle-archived" style="margin:6px 0 14px;">${S.archived ? "Hide archived suppliers" : "Show archived suppliers"}</button>`;
  }

  function supplierOptions(cur, withAll) {
    const list = API().list({ includeInactive: true });
    return (withAll ? [["", "All suppliers"]] : []).concat(list.map(s => [s.id, s.name + (s.active ? "" : " (archived)")]));
  }

  function billRow(b, showSupplier) {
    const canPay = b.outstandingPaise > 0 && !b.cancelled;
    return `<div class="order-row" data-sup="open-bill" data-id="${esc(b.id)}" style="cursor:pointer;">
      <div class="otop"><div><div class="oleft">${showSupplier ? esc(b.supplierName) + " · " : ""}${b.kind === "opening" ? "Opening balance" : b.billNo ? "Bill " + esc(b.billNo) : "Bill"}</div>
        <div class="otime">${dmy(b.billDate)}${b.dueDate ? " · due " + dmy(b.dueDate) : ""} · total ${m(b.totalPaise)}</div>
        <div style="margin-top:5px;">${statusBadge(b)}</div></div>
        <div style="text-align:right;"><div style="font-weight:700; color:${b.outstandingPaise > 0 ? "#e79080" : "var(--teal)"};">${m(b.outstandingPaise)}</div><div class="otime">${b.outstandingPaise > 0 ? "left" : ""}</div>
        ${canPay ? `<button class="btn btn-amber" data-sup="add-payment" data-id="${esc(b.id)}" style="padding:6px 14px; margin-top:6px;">Pay</button>` : ""}</div></div></div>`;
  }

  function billsList() {
    const f = S.bills;
    const list = API().bills({ status: f.status || undefined, supplierId: f.supplierId || undefined });
    const chips = [["", "All"], ["UNPAID", "Unpaid"], ["PARTIAL", "Part paid"], ["PAID", "Paid"]];
    return `<div class="field">${sel("supBFSupplier", supplierOptions(f.supplierId, true), f.supplierId)}</div>
      <div class="segmented scroll" style="margin-bottom:10px;">${chips.map(c => `<button data-sup="bill-status" data-v="${c[0]}" class="${(f.status || "") === c[0] ? "active" : ""}">${c[1]}</button>`).join("")}</div>
      <div class="rhead"><span>${list.length} bill${list.length === 1 ? "" : "s"} · ${m(list.reduce((s, b) => s + b.outstandingPaise, 0))} left to pay</span></div>
      ${list.map(b => billRow(b, true)).join("") || empty("🧾", "No bills here", "Add one with “🧾 New bill”.")}`;
  }

  function payRow(p, canReverse) {
    return `<div class="order-row"><div class="otop"><div><div class="oleft">${esc(p.supplierName || "")}${p.billNo !== null && p.billNo !== undefined ? " · " + (p.billNo ? "Bill " + esc(p.billNo) : "Bill") : " · Advance"}</div>
      <div class="otime">${dmy(p.paidOn)} · ${esc(METHOD[p.method])} → ${esc(ACCOUNT[p.account])}${p.reference ? " · ref " + esc(p.reference) : ""}</div>
      ${p.notes ? `<div class="otime">${esc(p.notes)}</div>` : ""}${p.status === "reversed" ? `<div class="otime" style="color:#e79080;">Reversed: ${esc(p.reverseReason || "")}</div>` : ""}</div>
      <div style="text-align:right;"><div style="font-weight:700; ${p.status === "reversed" ? "text-decoration:line-through; color:var(--text-faint);" : ""}">${m(p.amountPaise)}</div>
      ${canReverse && p.status === "valid" && can("suppliers.reverse") ? `<button class="linkbtn" data-sup="reverse-payment" data-id="${esc(p.id)}">↩ Reverse</button>` : ""}</div></div></div>`;
  }

  function paymentsList() {
    const f = S.pays;
    const list = API().payments({ supplierId: f.supplierId || undefined, includeReversed: true });
    const valid = list.filter(p => p.status === "valid");
    return `<div class="field">${sel("supPFSupplier", supplierOptions(f.supplierId, true), f.supplierId)}</div>
      <div class="rhead"><span>${valid.length} payment${valid.length === 1 ? "" : "s"} · ${m(valid.reduce((s, p) => s + p.amountPaise, 0))}</span></div>
      ${list.map(p => payRow(p, true)).join("") || empty("💸", "No payments yet", "Payments appear here as soon as they are recorded.")}`;
  }

  function renderSupplier() {
    let d; try { d = API().get(S.supplierId); } catch (e) { S.view = "home"; return renderHome(); }
    const s = d.supplier;
    const head = `<button class="linkbtn" data-sup="back" style="margin-bottom:10px;">← All suppliers</button>
      <div style="font-weight:800; font-size:18px;">${esc(s.name)} ${s.active ? "" : `<span class="badge" style="background:var(--surface-2);color:var(--text-faint);">Archived</span>`}</div>
      <div class="otime" style="margin:4px 0 12px;">${esc([s.phone, s.address].filter(Boolean).join(" · ") || "No contact details")}${s.notes ? "<br>" + esc(s.notes) : ""}</div>`;
    const cards = `<div class="stat-grid">${statCard("You owe", `<span style="color:${s.outstandingPaise > 0 ? "#e79080" : "var(--teal)"};">${m(s.outstandingPaise)}</span>`, "accent", s.overdueCount ? s.overdueCount + " overdue" : "")}
      ${statCard("Bought / Paid", m(s.totalPurchasesPaise), "", "Paid " + m(s.totalPaidPaise))}</div>`;
    const actions = `<div class="cb-actions" style="margin-bottom:14px; flex-wrap:wrap;">
      ${s.active ? `<button class="btn btn-amber" data-sup="new-purchase" data-supplier="${esc(s.id)}">🧾 New bill</button><button class="btn btn-outline" data-sup="advance" data-supplier="${esc(s.id)}">💸 Advance</button>` : ""}
      <button class="btn btn-outline" data-sup="edit-supplier" data-id="${esc(s.id)}">✏️ Edit</button></div>`;
    const adv = d.advances.length ? `<div class="rhead"><span>Unused advances</span></div>` + d.advances.map(a => `<div class="order-row"><div class="otop"><div><div class="oleft">Advance ${dmy(a.paidOn)}</div>
      <div class="otime">${esc(METHOD[a.method])} → ${esc(ACCOUNT[a.account])} · ${m(a.amountPaise)} paid, ${m(a.amountPaise - a.allocatedPaise)} unused</div></div>
      <button class="btn btn-outline" data-sup="allocate" data-id="${esc(a.id)}" style="padding:8px 12px;">Use on a bill</button></div></div>`).join("") : "";
    const bills = `<div class="rhead"><span>Bills</span></div>` + (d.bills.map(b => billRow(b, false)).join("") || empty("🧾", "No bills yet", "Tap “New bill” to record the first one."));
    const pays = `<div class="rhead" style="margin-top:14px;"><span>Payment history</span></div>` + (d.payments.map(p => payRow(p, true)).join("") || empty("💸", "No payments yet", ""));
    const archive = `<button class="linkbtn" data-sup="${s.active ? "archive" : "restore"}" data-id="${esc(s.id)}" style="margin:14px 0;">${s.active ? "🗄️ Archive this supplier" : "♻️ Restore this supplier"}</button>`;
    return head + cards + actions + adv + bills + pays + archive;
  }

  function renderBill() {
    let d; try { d = API().bill(S.billId); } catch (e) { S.view = "home"; return renderHome(); }
    const b = d.bill;
    return `<button class="linkbtn" data-sup="back-supplier" data-id="${esc(b.supplierId)}" style="margin-bottom:10px;">← ${esc(b.supplierName)}</button>
      <div style="font-weight:800; font-size:18px;">${b.kind === "opening" ? "Opening balance" : "Bill " + esc(b.billNo || "(no number)")}</div>
      <div class="otime" style="margin:4px 0 8px;">${dmy(b.billDate)}${b.dueDate ? " · due " + dmy(b.dueDate) : " · no due date"}</div><div style="margin-bottom:12px;">${statusBadge(b)}</div>
      <div class="stat-grid">${statCard("Bill total", m(b.totalPaise), "accent")}${statCard("Paid", m(b.paidPaise))}${statCard("Outstanding", `<span style="color:${b.outstandingPaise > 0 ? "#e79080" : "var(--teal)"};">${m(b.outstandingPaise)}</span>`)}</div>
      <div class="cb-actions" style="margin-bottom:14px;">${b.outstandingPaise > 0 ? `<button class="btn btn-amber" data-sup="add-payment" data-id="${esc(b.id)}">➕ Add payment</button>` : ""}
        ${can("suppliers.reverse") && b.kind === "purchase" && !b.cancelled ? `<button class="btn btn-outline" data-sup="cancel-bill" data-id="${esc(b.id)}">🚫 Cancel bill</button>` : ""}</div>
      ${b.notes ? `<div class="hint-text">${esc(b.notes)}</div>` : ""}
      ${b.kind === "purchase" && fileApi() ? `<div class="cb-actions" style="margin-bottom:14px;"><button class="btn btn-outline" data-sup="bill-file" data-id="${esc(b.id)}">${API().hasFile(b.id) ? "📎 View original bill" : "📎 Upload original bill"}</button></div>` : ""}
      <div class="rhead"><span>Payments (${d.payments.length})</span></div>
      ${d.payments.map(p => payRow({ ...p, billNo: "", supplierName: "" }, true).replace(/<div class="oleft"> · Bill<\/div>/, '<div class="oleft">Payment</div>')).join("") || empty("💸", "No payments yet", b.cancelled ? "This bill was cancelled." : "Tap “Add payment” whenever you pay this supplier — in parts if you like.")}`;
  }

  /* ---------- reports ---------- */
  function reportsView() {
    const r = S.report;
    if (!r.from) r.from = monthStart();
    if (!r.to) r.to = API().today();
    const kinds = [["purchases", "Purchases"], ["payments", "Payments"], ["outstanding", "Outstanding"], ["paid", "Paid bills"]];
    const bar = `<div class="segmented scroll">${kinds.map(k => `<button data-sup="report-kind" data-v="${k[0]}" class="${r.kind === k[0] ? "active" : ""}">${k[1]}</button>`).join("")}</div>
      ${r.kind === "outstanding" ? `<div class="hint-text">Outstanding is as of today (${dmy(API().today())}).</div>` : `<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;"><div class="field"><label>From</label><input type="date" id="supRFrom" value="${esc(r.from)}"></div><div class="field"><label>To</label><input type="date" id="supRTo" value="${esc(r.to)}"></div></div>`}`;
    const f = { from: r.from, to: r.to };
    let body = "";
    if (r.kind === "purchases") {
      const x = API().report("purchases", f);
      body = `<div class="stat-grid">${statCard("Purchases", m(x.totalPaise), "accent", x.billCount + " bills")}${statCard("Paid so far", m(x.paidPaise))}${statCard("Still owed", m(x.outstandingPaise))}</div>
        <div class="rhead"><span>By supplier</span><button class="linkbtn" data-sup="csv">⬇️ CSV</button></div>
        ${x.bySupplier.map(s => `<div class="rline"><span>${esc(s.supplierName)} (${s.bills})</span><span>${m(s.totalPaise)} · owes ${m(s.outstandingPaise)}</span></div>`).join("") || empty("🧾", "No purchases in this period", "")}
        <div class="rhead" style="margin-top:12px;"><span>Bills</span></div>${x.rows.map(b => billRow(b, true)).join("")}`;
    } else if (r.kind === "payments") {
      const x = API().report("payments", f);
      body = `<div class="stat-grid">${statCard("Paid in period", m(x.totalPaise), "accent", x.count + " payments")}${statCard("Paid in cash", m(x.cashPaise), "", x.cashCount + " payments")}${statCard("From bank / UPI", m(x.bankPaise), "", x.bankCount + " payments")}</div>
        ${x.reversedCount ? `<div class="hint-text">${x.reversedCount} payment(s) worth ${m(x.reversedPaise)} were reversed in this period and are not counted.</div>` : ""}
        <div class="rhead"><span>Payments</span><button class="linkbtn" data-sup="csv">⬇️ CSV</button></div>
        ${[["Cash", x.rows.filter(p => p.account === "drawer")], ["Bank / UPI", x.rows.filter(p => p.account === "bank")]].map(g => `<div class="rhead" style="margin-top:8px;"><span>${g[0]}</span></div>${g[1].map(p => payRow(p, false)).join("") || `<div class="hint-text">None</div>`}`).join("")}`;
    } else if (r.kind === "outstanding") {
      const x = API().report("outstanding", {});
      body = `<div class="stat-grid">${statCard("Total outstanding", m(x.grandOutstandingPaise), "accent")}${statCard("Overdue", m(x.grandOverduePaise))}${statCard("Unpaid bills", x.unpaidBills)}${statCard("Partly paid", x.partialBills)}</div>
        <div class="rhead"><span>By supplier</span><button class="linkbtn" data-sup="csv">⬇️ CSV</button></div>
        ${x.suppliers.map(s => `<div class="order-row"><div class="otop"><div class="oleft">${esc(s.supplierName)}</div><div style="font-weight:700; color:#e79080;">${m(s.outstandingPaise)}</div></div>
          ${s.bills.map(b => `<div class="rline" data-sup="open-bill" data-id="${esc(b.id)}" style="cursor:pointer;"><span>${b.kind === "opening" ? "Opening balance" : "Bill " + esc(b.billNo || "(no number)")} · ${b.dueDate ? "due " + dmy(b.dueDate) : "no due date"}${b.overdue ? ` · <span style="color:#e79080;">${b.daysOverdue}d overdue</span>` : ""}</span><span>${m(b.outstandingPaise)}</span></div>`).join("")}</div>`).join("") || empty("✅", "Nothing outstanding", "Every supplier bill is paid.")}
        ${x.unusedAdvancePaise ? `<div class="hint-text">Unused supplier advances (not deducted above): ${m(x.unusedAdvancePaise)}</div>` : ""}`;
    } else if (r.kind === "paid") {
      const x = API().report("paid", f);
      body = `<div class="stat-grid">${statCard("Bills completed", x.count, "accent")}${statCard("Total value", m(x.totalPaise))}</div>
        <div class="rhead"><span>Fully paid bills (by date of final payment)</span><button class="linkbtn" data-sup="csv">⬇️ CSV</button></div>
        ${x.rows.map(b => `<div class="order-row" data-sup="open-bill" data-id="${esc(b.id)}" style="cursor:pointer;"><div class="otop"><div class="oleft">${esc(b.supplierName)} · ${b.kind === "opening" ? "Opening balance" : "Bill " + esc(b.billNo || "(no number)")}</div><div style="font-weight:700;">${m(b.totalPaise)}</div></div>
          ${b.payments.map(p => `<div class="rline dim"><span>${dmy(p.paidOn)} · ${esc(METHOD[p.method])}${p.reference ? " · " + esc(p.reference) : ""}</span><span>${m(p.allocatedToThisBillPaise)}</span></div>`).join("")}</div>`).join("") || empty("✅", "No completed bills in this period", "")}`;
    }
    return bar + body;
  }

  function csvRows() {
    const r = S.report, f = { from: r.from, to: r.to }, rp = (p) => (p / 100).toFixed(2);
    if (r.kind === "purchases") { const x = API().report("purchases", f); return ["purchases", [["Date", "Supplier", "Bill no", "Total", "Paid", "Outstanding", "Status", "Due date"]].concat(x.rows.map(b => [b.billDate, b.supplierName, b.billNo, rp(b.totalPaise), rp(b.paidPaise), rp(b.outstandingPaise), b.status, b.dueDate || ""])).concat([["TOTAL", "", "", rp(x.totalPaise), rp(x.paidPaise), rp(x.outstandingPaise), "", ""]])]; }
    if (r.kind === "payments") { const x = API().report("payments", f); return ["supplier_payments", [["Date", "Supplier", "Bill", "Amount", "Method", "Account", "Reference", "Notes"]].concat(x.rows.map(p => [p.paidOn, p.supplierName, p.billNo === null ? "Advance" : p.billNo, rp(p.amountPaise), METHOD[p.method], ACCOUNT[p.account], p.reference, p.notes])).concat([["TOTAL", "", "", rp(x.totalPaise), "", "", "", ""], ["Cash drawer", "", "", rp(x.cashPaise), "", "", "", ""], ["Bank / UPI", "", "", rp(x.bankPaise), "", "", "", ""]])]; }
    if (r.kind === "outstanding") { const x = API().report("outstanding", {}); const rows = [["Supplier", "Bill no", "Due date", "Outstanding", "Days overdue"]]; x.suppliers.forEach(s => s.bills.forEach(b => rows.push([s.supplierName, b.kind === "opening" ? "Opening balance" : b.billNo, b.dueDate || "", rp(b.outstandingPaise), b.daysOverdue]))); rows.push(["GRAND TOTAL", "", "", rp(x.grandOutstandingPaise), ""]); return ["supplier_outstanding", rows]; }
    if (r.kind === "paid") { const x = API().report("paid", f); const rows = [["Supplier", "Bill no", "Bill total", "Payment date", "Method", "Reference", "Amount"]]; x.rows.forEach(b => b.payments.forEach(p => rows.push([b.supplierName, b.billNo, rp(b.totalPaise), p.paidOn, METHOD[p.method], p.reference, rp(p.allocatedToThisBillPaise)]))); return ["supplier_paid_bills", rows]; }
    return null;
  }

  /* ============================================================ modal (own root, same look as the app's dialogs) */
  function modalRoot() { let el = document.getElementById("supModalRoot"); if (!el) { el = document.createElement("div"); el.id = "supModalRoot"; document.body.appendChild(el); } return el; }
  function drawModal() {
    const root = modalRoot();
    if (!modal) { root.innerHTML = ""; return; }
    root.innerHTML = `<div class="modal-backdrop" id="supModalBackdrop" style="z-index:260; align-items:flex-start; overflow-y:auto;"><div class="modal" style="max-width:440px; margin:auto;">
      <h3>${esc(modal.title)}</h3><div id="supModalBody">${modal.html}</div><div id="supErr" role="alert" style="color:#e79080; font-size:13px; margin:0 0 10px; display:none;"></div>
      <div class="modal-actions"><button class="btn btn-outline" id="supModalCancel">Cancel</button><button class="btn ${modal.danger ? "btn-danger" : "btn-amber"}" id="supModalSave">${esc(modal.saveLabel || "Save")}</button></div></div></div>`;
    if (modal.onOpen) modal.onOpen();
  }
  function openModal(cfg) { modal = { busy: false, ...cfg }; drawModal(); B().pushOverlay("supplier-modal", () => { modal = null; drawModal(); }); const f = document.querySelector("#supModalBody input, #supModalBody select"); if (f && !cfg.noFocus) f.focus(); }
  function closeModal() { if (modal) B().closeTopOverlay(); }
  function showErr(msg) { const e = document.getElementById("supErr"); if (e) { e.textContent = msg; e.style.display = msg ? "block" : "none"; } }
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  async function submitModal() {
    if (!modal || modal.busy) return;                               // second tap while saving does nothing
    modal.busy = true; const btn = document.getElementById("supModalSave"); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; } showErr("");
    try { const done = await modal.onSave(); if (done !== false) { closeModal(); await B().refreshLedger(); B().render(); } }
    catch (e) { showErr(e && e.message ? e.message : "Couldn't save"); if (e && e.denied) B().showToast("Not permitted"); }
    finally { if (modal) { modal.busy = false; const b2 = document.getElementById("supModalSave"); if (b2) { b2.disabled = false; b2.textContent = modal.saveLabel || "Save"; } } }
  }

  const payFields = (idp, outstandingHint, defAmt) => `
    <div class="field"><label>Amount (₹)</label><input type="text" inputmode="decimal" id="${idp}Amt" value="${defAmt ? (defAmt / 100).toFixed(2).replace(/\.00$/, "") : ""}" placeholder="0" autocomplete="off" style="font-size:20px; font-weight:700;">${outstandingHint ? `<div class="otime" style="margin-top:4px;">${outstandingHint}</div>` : ""}</div>
    <div class="field"><label>Paid by</label>${sel(idp + "Method", [["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank transfer"], ["card", "Card"]], "cash")}</div>
    <div class="field"><label>Note — optional</label><input type="text" id="${idp}Ref" maxlength="80" autocomplete="off"></div>`;
  function readPay(idp) {
    const amt = toPaise(val(idp + "Amt"));
    if (!amt || amt <= 0) throw new Error("Enter a payment amount more than zero (like 2500 or 2500.50)");
    const method = val(idp + "Method");
    return { amountPaise: amt, method, account: undefined, reference: val(idp + "Ref"), notes: "" };
  }
  function wirePay(idp) { /* nothing to wire: simple form */ }

  /* ---- original bill file: photo (shrunk in the browser) or PDF ---- */
  const MAX_FILE = 3 * 1024 * 1024;
  function readAsDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("That file could not be read")); r.readAsDataURL(file); }); }
  async function prepareFile(file) {
    if (!file) return null;
    if (file.type === "application/pdf") {
      if (file.size > MAX_FILE) throw new Error("That PDF is larger than 3 MB. Take a photo of the bill instead, or use a smaller PDF.");
      return { name: file.name, mime: file.type, dataUrl: await readAsDataUrl(file) };
    }
    if (!/^image\//.test(file.type)) throw new Error("Choose a photo or a PDF");
    const src = await readAsDataUrl(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That photo could not be opened")); i.src = src; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.8, out = c.toDataURL("image/jpeg", q);
    while (out.length > MAX_FILE * 1.3 && q > 0.35) { q -= 0.15; out = c.toDataURL("image/jpeg", q); }
    return { name: (file.name || "bill").replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg", dataUrl: out };
  }
  const fileInput = (id) => `<input type="file" id="${id}" accept="image/*,application/pdf" style="font-size:14px; max-width:100%;">`;

  function formBillFile(billId) {
    if (!fileApi()) { B().showToast("Please refresh the app to use bill files"); return; }
    const has = API().hasFile(billId);
    openModal({ title: "Original bill", saveLabel: has ? "Close" : "Upload", noFocus: true,
      html: `<div id="bfView" class="otime" style="text-align:center; margin-bottom:10px;">${has ? "Loading…" : "No file uploaded yet."}</div>
        <div class="field"><label>${has ? "Replace with another photo or PDF" : "Photo or PDF of the supplier's bill"}</label>${fileInput("bfFile")}</div>
        ${has ? `<div style="display:flex; gap:14px; flex-wrap:wrap;"><a id="bfDl" class="linkbtn" style="display:none;">⬇️ Download</a><button type="button" class="linkbtn" id="bfRemove" style="color:#e79080;">🗑 Remove file</button></div>` : ""}`,
      onOpen: async () => {
        const rm = document.getElementById("bfRemove");
        if (rm) rm.addEventListener("click", async () => { try { await API().removeFile(billId); B().showToast("File removed"); closeModal(); B().render(); } catch (e) { showErr(e.message); } });
        if (!has) return;
        try {
          const f = await API().billFile(billId), box = document.getElementById("bfView"); if (!f || !box) return;
          box.innerHTML = f.mime === "application/pdf" ? `<object data="${f.dataUrl}" type="application/pdf" style="width:100%; height:55vh;"><div>PDF preview isn't available here — use Download.</div></object>`
            : `<img src="${f.dataUrl}" alt="Original bill" style="max-width:100%; max-height:55vh; border-radius:8px;">`;
          const dl = document.getElementById("bfDl"); if (dl) { dl.href = f.dataUrl; dl.download = f.name || "bill"; dl.style.display = ""; }
        } catch (e) { const box = document.getElementById("bfView"); if (box) box.textContent = e.message || "Couldn't load the file"; }
      },
      onSave: async () => {
        const inp = document.getElementById("bfFile"), file = inp && inp.files && inp.files[0];
        if (!file) { if (has) return; throw new Error("Choose a photo or a PDF first"); }
        await API().attachFile(billId, await prepareFile(file)); B().showToast("Original bill saved");
      } });
  }

  /* ---- forms ---- */
  function formSupplier(id) {
    let cur = null; if (id) cur = API().get(id).supplier;
    openModal({ title: cur ? "Edit supplier" : "Add supplier", saveLabel: cur ? "Save" : "Add supplier",
      html: `<div class="field"><label>Supplier name</label><input type="text" id="supName" maxlength="120" value="${esc(cur ? cur.name : "")}" autocomplete="off"></div>
        <div class="field"><label>Phone — optional</label><input type="tel" id="supPhone" maxlength="30" value="${esc(cur ? cur.phone : "")}" autocomplete="off"></div>
        <div class="field"><label>Address — optional</label><input type="text" id="supAddr" maxlength="300" value="${esc(cur ? cur.address : "")}" autocomplete="off"></div>
        <div class="field"><label>Notes — optional</label><input type="text" id="supNotes" maxlength="500" value="${esc(cur ? cur.notes : "")}" autocomplete="off"></div>
        ${cur ? "" : `<div class="field"><label>Opening balance — amount you already owe (₹, optional)</label><input type="text" inputmode="decimal" id="supOpening" placeholder="0" autocomplete="off"></div>`}`,
      onSave: async () => {
        const o = { id: cur ? cur.id : undefined, name: val("supName"), phone: val("supPhone"), address: val("supAddr"), notes: val("supNotes") };
        if (!cur) { const raw = val("supOpening").trim(); if (raw) { const p = toPaise(raw); if (p === null) throw new Error("Enter the opening balance like 2500 or 2500.50"); o.openingPaise = p; } }
        const s = await API().save(o); B().showToast(cur ? "Supplier updated" : "Supplier added"); if (!cur) { S.view = "supplier"; S.supplierId = s.id; }
      } });
  }

  function formPurchase(supplierId) {
    const sups = API().list({});
    if (!sups.length) { B().showToast("Add a supplier first"); return formSupplier(); }
    const key = rid(); const today = API().today();
    const dupCheck = () => {
      const sid = val("pbSupplier"), no = val("pbNo").trim(), w = document.getElementById("pbDup"); if (!w) return;
      const hit = no ? API().bills({ supplierId: sid }).find(b => b.kind === "purchase" && b.billNo.toUpperCase().replace(/\s+/g, "") === no.toUpperCase().replace(/\s+/g, "")) : null;
      w.style.display = hit ? "block" : "none"; w.textContent = hit ? `⚠ Bill “${hit.billNo}” from this supplier was already entered on ${dmy(hit.billDate)}.` : "";
    };
    openModal({ title: "New purchase", saveLabel: "Save purchase",
      html: `<div class="field"><label>Supplier</label>${sel("pbSupplier", sups.map(s => [s.id, s.name]), supplierId || sups[0].id)}</div>
        <div class="field"><label>Bill total (₹)</label><input type="text" inputmode="decimal" id="pbTotalAmt" placeholder="0" autocomplete="off" style="font-size:20px; font-weight:700;"></div>
        <div class="field"><label>Paid now (₹) — optional</label><input type="text" inputmode="decimal" id="pbPayAmt" placeholder="0 — leave empty to pay later" autocomplete="off">
          <div style="display:flex; gap:8px; margin-top:6px;"><button type="button" class="linkbtn" id="pbPayFull">Paid in full</button><button type="button" class="linkbtn" id="pbPayNone">Pay later</button></div></div>
        <div class="field" id="pbMethodWrap" style="display:none;"><label>Paid by</label>${sel("pbPayMethod", [["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank transfer"], ["card", "Card"]], "cash")}</div>
        <div id="pbBalance" class="otime" style="margin:-4px 0 12px;"></div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;"><div class="field"><label>Date</label><input type="date" id="pbDate" value="${today}"></div><div class="field"><label>Due date — optional</label><input type="date" id="pbDue"></div></div>
        <div class="field"><label>Bill number — optional</label><input type="text" id="pbNo" maxlength="60" autocomplete="off"><div id="pbDup" style="display:none; color:#e79080; font-size:12.5px; margin-top:4px;"></div></div>
        ${fileApi() ? `<div class="field"><label>📎 Original bill — photo or PDF (optional)</label>${fileInput("pbFile")}</div>` : ""}`,
      onOpen: () => {
        const upd = () => {
          const t = toPaise(val("pbTotalAmt")) || 0, p = toPaise(val("pbPayAmt")) || 0;
          document.getElementById("pbMethodWrap").style.display = p > 0 ? "" : "none";
          const el = document.getElementById("pbBalance");
          el.innerHTML = t > 0 ? (p > t ? `<span style="color:#e79080;">Paid is more than the bill total</span>` : `Left to pay: <b>${m(t - p)}</b>`) : "";
        };
        dupCheck(); upd();
        const body = document.getElementById("supModalBody");
        body.addEventListener("input", (e) => { if (e.target.id === "pbTotalAmt" || e.target.id === "pbPayAmt") upd(); if (e.target.id === "pbNo") dupCheck(); });
        body.addEventListener("change", (e) => { if (e.target.id === "pbSupplier") dupCheck(); });
        body.addEventListener("click", (e) => {
          if (e.target.id === "pbPayFull") { document.getElementById("pbPayAmt").value = val("pbTotalAmt"); upd(); }
          if (e.target.id === "pbPayNone") { document.getElementById("pbPayAmt").value = ""; upd(); }
        });
      },
      onSave: async () => {
        const total = toPaise(val("pbTotalAmt"));
        if (!total || total <= 0) throw new Error("Enter the bill total (like 2500 or 2500.50)");
        const paid = val("pbPayAmt").trim() ? toPaise(val("pbPayAmt")) : 0;
        if (paid === null) throw new Error("Enter the paid amount like 1000 or 1000.50");
        if (paid > total) throw new Error("Paid amount can't be more than the bill total");
        const inp = { requestId: key, supplierId: val("pbSupplier"), billNo: val("pbNo"), billDate: val("pbDate"), dueDate: val("pbDue") || null,
          items: [{ name: "Purchase bill", qtyMilli: 1000, unit: "", unitPricePaise: total }],
          discountPaise: 0, taxPaise: 0, otherPaise: 0, notes: "", expectedTotalPaise: total };
        if (paid > 0) inp.payment = { amountPaise: paid, method: val("pbPayMethod") || "cash", reference: "", notes: "" };
        const picked = document.getElementById("pbFile"), file = picked && picked.files && picked.files[0];
        const prepared = file ? await prepareFile(file) : null;          // checked before anything is saved
        const r = await API().createPurchase(inp);
        let fileMsg = "";
        if (prepared) { try { await API().attachFile(r.bill.id, prepared); } catch (e) { fileMsg = " (bill file not saved: " + (e.message || "error") + ")"; } }
        if (fileMsg) B().showToast("Purchase saved" + fileMsg, 4500); else
        B().showToast(r.bill.status === "PAID" ? "Purchase saved — fully paid" : r.bill.status === "PARTIAL" ? "Purchase saved — " + m(r.bill.outstandingPaise) + " left to pay" : "Purchase saved — unpaid");
        S.view = "bill"; S.billId = r.bill.id;
      } });
  }

  function formPayment(billId) {
    const d = API().bill(billId), b = d.bill;
    const key = rid();                                      // one request id per opened dialog: re-tapping Save can never pay twice
    openModal({ title: "Add payment", saveLabel: "Save payment",
      html: `<div class="otime" style="margin-bottom:10px;">${esc(b.supplierName)} · ${b.kind === "opening" ? "Opening balance" : "Bill " + esc(b.billNo || "(no number)")} · total ${m(b.totalPaise)}</div>${payFields("pp", "Outstanding " + m(b.outstandingPaise) + " — you can pay part now and the rest later", b.outstandingPaise)}`,
      onOpen: () => wirePay("pp"),
      onSave: async () => {
        const p = readPay("pp");
        if (p.amountPaise > b.outstandingPaise) throw new Error("That is more than the " + m(b.outstandingPaise) + " still owed on this bill. Pay up to " + m(b.outstandingPaise) + ", or use “💸 Advance” on the supplier for extra money paid ahead.");
        const r = await API().pay({ requestId: key, billId, ...p });
        B().showToast(r.bill.status === "PAID" ? "Payment saved — bill fully paid" : "Payment saved — " + m(r.bill.outstandingPaise) + " left");
      } });
  }

  function formAdvance(supplierId) {
    const key = rid(), s = API().get(supplierId).supplier;
    openModal({ title: "Advance to " + s.name, saveLabel: "Save advance",
      html: `<div class="hint-text">Money paid before a bill exists. It is recorded as paid now and stays as an unused advance until you apply it to a bill.</div>${payFields("av", "", 0)}`,
      onOpen: () => wirePay("av"),
      onSave: async () => { await API().pay({ requestId: key, supplierId, advance: true, ...readPay("av") }); B().showToast("Advance recorded"); } });
  }

  function formAllocate(paymentId) {
    let adv = null, sup = null;
    API().list({ includeInactive: true }).forEach(s => { const d = API().get(s.id); const a = d.advances.find(x => x.id === paymentId); if (a) { adv = a; sup = d; } });
    if (!adv) { B().showToast("That advance is no longer available"); return; }
    const free = adv.amountPaise - adv.allocatedPaise;
    const open = sup.bills.filter(b => b.outstandingPaise > 0);
    if (!open.length) { B().showToast("This supplier has no unpaid bill to apply it to"); return; }
    openModal({ title: "Use advance on a bill", saveLabel: "Apply",
      html: `<div class="otime" style="margin-bottom:10px;">Unused advance: ${m(free)} — applying it does not move any more cash or bank money.</div>
        <div class="field"><label>Bill</label>${sel("alBill", open.map(b => [b.id, (b.kind === "opening" ? "Opening balance" : "Bill " + (b.billNo || "(no number)")) + " — owes " + m(b.outstandingPaise)]), open[0].id)}</div>
        <div class="field"><label>Amount (₹)</label><input type="text" inputmode="decimal" id="alAmt" value="${(Math.min(free, open[0].outstandingPaise) / 100).toFixed(2).replace(/\.00$/, "")}" autocomplete="off"></div>`,
      onSave: async () => { const a = toPaise(val("alAmt")); if (!a) throw new Error("Enter an amount"); await API().allocateAdvance({ paymentId, billId: val("alBill"), amountPaise: a }); B().showToast("Advance applied"); } });
  }

  function formReason(title, label, saveLabel, fn) {
    openModal({ title, saveLabel, danger: true, html: `<div class="field"><label>${esc(label)}</label><input type="text" id="supReason" maxlength="200" autocomplete="off"></div>`, onSave: async () => { await fn(val("supReason")); } });
  }

  /* ============================================================ events */
  function bind() {
    if (bound) return; bound = true;
    document.addEventListener("click", async (e) => {
      const modalBtn = e.target.closest("#supModalSave, #supModalCancel, #supModalBackdrop");
      if (modalBtn) {
        if (modalBtn.id === "supModalSave") submitModal();
        else if (modalBtn.id === "supModalCancel" || (modalBtn.id === "supModalBackdrop" && e.target === modalBtn)) closeModal();
        return;
      }
      const el = e.target.closest("[data-sup]"); if (!el || !document.getElementById("view").contains(el)) return;
      const a = el.dataset.sup, id = el.dataset.id;
      const go = () => B().render();
      try {
        if (a === "retry") { API().reset(); return go(); }
        if (a === "section") { S.section = el.dataset.v; return go(); }
        if (a === "open-supplier") { S.view = "supplier"; S.supplierId = id; return go(); }
        if (a === "open-bill") { S.view = "bill"; S.billId = id; return go(); }
        if (a === "back") { S.view = "home"; return go(); }
        if (a === "back-supplier") { S.view = "supplier"; S.supplierId = id; return go(); }
        if (a === "bill-status") { S.bills.status = el.dataset.v; return go(); }
        if (a === "toggle-archived") { S.archived = !S.archived; return go(); }
        if (a === "report-kind") { S.report.kind = el.dataset.v; return go(); }
        if (a === "new-supplier") return formSupplier();
        if (a === "edit-supplier") return formSupplier(id);
        if (a === "new-purchase") return formPurchase(el.dataset.supplier || (S.view === "supplier" ? S.supplierId : undefined));
        if (a === "add-payment") return formPayment(id);
        if (a === "bill-file") return formBillFile(id);
        if (a === "advance") return formAdvance(el.dataset.supplier);
        if (a === "allocate") return formAllocate(id);
        if (a === "archive") { await API().setActive(id, false); B().showToast("Supplier archived"); S.view = "home"; return go(); }
        if (a === "restore") { await API().setActive(id, true); B().showToast("Supplier restored"); return go(); }
        if (a === "reverse-payment") return formReason("Reverse this payment?", "Reason (required) — the amount becomes payable again", "Reverse payment", async (r) => { await API().reversePayment(id, r); B().showToast("Payment reversed"); });
        if (a === "cancel-bill") return formReason("Cancel this bill?", "Reason (required)", "Cancel bill", async (r) => { await API().cancelBill(id, r); B().showToast("Bill cancelled"); });
        if (a === "csv") { const c = csvRows(); if (c) { B().downloadCsv(c[0] + "_" + API().today() + ".csv", c[1]); B().showToast("CSV downloaded"); } }
      } catch (err) { B().showToast(err && err.message ? err.message : "Something went wrong", 3500); }
    });
    const onFilter = (e) => {
      const id = e.target.id; if (!id || !document.getElementById("view").contains(e.target)) return;
      const map = { supBFSupplier: ["bills", "supplierId"], supBFStatus: ["bills", "status"], supBFDue: ["bills", "due"], supBFFrom: ["bills", "from"], supBFTo: ["bills", "to"],
                    supPFSupplier: ["pays", "supplierId"], supPFMethod: ["pays", "method"], supPFFrom: ["pays", "from"], supPFTo: ["pays", "to"], supRFrom: ["report", "from"], supRTo: ["report", "to"] };
      if (map[id]) { S[map[id][0]][map[id][1]] = e.target.value; B().render(); }
    };
    document.addEventListener("change", onFilter);
    document.addEventListener("input", (e) => {
      if (e.target.id !== "supSearch") return;
      S.search = e.target.value; const pos = e.target.selectionStart; B().render();
      const n = document.getElementById("supSearch"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) { /* not supported */ } }
    });
  }
  bind();

  window.SupplierUI = { render, reset() { S.view = "home"; S.section = "suppliers"; S.search = ""; S.supplierId = null; S.billId = null; }, _state: S };
})();
