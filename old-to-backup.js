/* Converts data exported from the OLD single-table app (Supabase table `kv`, keys
   cafe-config / cafe-orders / cafe-deleted-orders) into a backup file that the CURRENT app
   can restore (Admin > Backup > Restore).  Works in the browser and in Node:
       node tools/old-to-backup.js kv-export.json  my-backup.json
   Input: either [{key, value}, ...] (Supabase "kv" rows) or {"cafe-config": {...}, ...}. */
(function (root) {
  "use strict";
  const DEVICE_KEYS = ["directPrint", "printerName", "printerId"];   // per-device settings, not stored in the database
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const iso = (ms) => { const n = num(ms); return n && n > 0 ? new Date(n).toISOString() : null; };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function normalise(kv) {
    const map = {};
    if (Array.isArray(kv)) kv.forEach(r => { if (r && typeof r.key === "string") map[r.key] = r.value; });
    else if (kv && typeof kv === "object") Object.assign(map, kv);
    // a dashboard export may hand the value back as a JSON string
    Object.keys(map).forEach(k => { if (typeof map[k] === "string") { try { map[k] = JSON.parse(map[k]); } catch (_) {} } });
    return map;
  }

  async function convert(kv, opts) {
    opts = opts || {};
    const data = normalise(kv);
    const cfg = data["cafe-config"] && typeof data["cafe-config"] === "object" ? data["cafe-config"] : null;
    const rawOrders = Array.isArray(data["cafe-orders"]) ? data["cafe-orders"] : [];
    const deleted = new Set((Array.isArray(data["cafe-deleted-orders"]) ? data["cafe-deleted-orders"] : []).map(String));
    if (!cfg && !rawOrders.length) throw new Error("No app data found. Expected the keys cafe-config and cafe-orders from the old kv table.");
    const c = cfg || {};
    const warnings = [];
    const now = Date.now();

    // ---- menu
    const seen = new Set();
    const uniq = (list, kind, build) => (Array.isArray(list) ? list : []).reduce((out, x) => {
      if (!x || x.id == null || !x.name) return out;
      const id = String(x.id); if (seen.has(kind + id)) return out; seen.add(kind + id);
      out.push(build(x, id)); return out; }, []);
    const categories = uniq(c.categories, "c", (x, id) => ({ id, name: String(x.name), data: { ...x, id }, created_at: iso(x.updatedAt) }));
    const products = uniq(c.items, "p", (x, id) => ({ id, category_id: x.categoryId != null ? String(x.categoryId) : null, name: String(x.name),
      price: num(x.price) || 0, data: { ...x, id }, created_at: iso(x.updatedAt) }));
    const dining_tables = uniq(c.tables, "t", (x, id) => ({ id, name: String(x.name), data: { ...x, id }, created_at: iso(x.updatedAt) }));

    // ---- settings (per-device printer settings are not stored in the database)
    const settings = { ...(c.settings || {}) }; DEVICE_KEYS.forEach(k => delete settings[k]);
    if (!settings.cafeName) settings.cafeName = "Kaapi Cafe";

    // ---- business days: the database allows only ONE open day
    let days = [];
    const dayIds = new Set();
    (Array.isArray(c.businessDays) ? c.businessDays : []).forEach(d => {
      if (!d || d.id == null || num(d.openedAt) === null || dayIds.has(String(d.id))) return;
      dayIds.add(String(d.id)); days.push({ ...d, id: String(d.id), openedAt: num(d.openedAt), closedAt: num(d.closedAt) });
    });
    days.sort((a, b) => a.openedAt - b.openedAt);
    const open = days.filter(d => !d.closedAt);
    if (open.length > 1) {
      open.slice(0, -1).forEach(d => { const next = days.find(x => x.openedAt > d.openedAt); d.closedAt = next ? next.openedAt - 1 : d.openedAt + 1; });
      warnings.push(`${open.length - 1} extra open business day(s) were closed (only one day can be open).`);
    }

    // ---- orders
    const byId = new Map();
    rawOrders.forEach(o => { if (o && o.id != null && !deleted.has(String(o.id)) && !byId.has(String(o.id))) byId.set(String(o.id), o); });
    const removed = rawOrders.length - byId.size;
    if (removed > 0) warnings.push(`${removed} order(s) skipped (sales you had deleted, or duplicates).`);
    const orders = [...byId.values()].map(o => ({ ...clone(o), id: String(o.id) }));
    const paid = orders.filter(o => o.status === "paid").sort((a, b) => (num(a.paidAt) || 0) - (num(b.paidAt) || 0));

    // invoice numbers must be unique: first sale keeps its number, duplicates / missing get new ones
    const used = new Set(); let maxNo = 0;
    paid.forEach(o => { const n = num(o.invoiceNo); if (n && n > 0) maxNo = Math.max(maxNo, n); });
    let next = Math.max(maxNo, (num(c.nextInvoiceNo) || 1) - 1) + 1, renumbered = 0, assigned = 0;
    paid.forEach(o => {
      const n = num(o.invoiceNo);
      if (n && n > 0 && !used.has(n)) { used.add(n); o.invoiceNo = n; return; }
      o.invoiceNo = next++; used.add(o.invoiceNo); n ? renumbered++ : assigned++;
    });
    if (renumbered) warnings.push(`${renumbered} sale(s) had a duplicate bill number and got a new one.`);
    if (assigned) warnings.push(`${assigned} sale(s) had no bill number and were numbered.`);

    // every paid sale must belong to a business day (reports group by it)
    const dayFor = (t) => { for (let i = days.length - 1; i >= 0; i--) if (t >= days[i].openedAt && (!days[i].closedAt || t <= days[i].closedAt)) return days[i].id; return null; };
    let dayFixed = 0, noDay = 0;
    const rows = orders.map(o => {
      const isPaid = o.status === "paid";
      const items = Array.isArray(o.items) ? o.items : [];
      let total = null, paidAt = null, invoice = null, dayId = null;
      if (isPaid) {
        const sub = items.reduce((s, l) => s + (num(l.qty) || 0) * (num(l.price) || 0), 0);
        total = num(o.total); if (total === null) total = o.payment && num(o.payment.total) !== null ? num(o.payment.total) : sub;
        paidAt = num(o.paidAt) || num(o.createdAt) || now; invoice = o.invoiceNo;
        dayId = o.businessDayId != null && dayIds.has(String(o.businessDayId)) ? String(o.businessDayId) : null;
        if (!dayId) { dayId = dayFor(paidAt); dayId ? dayFixed++ : noDay++; }
        o.paidAt = paidAt; o.businessDayId = dayId; o.total = total;
      } else { o.status = "open"; delete o.invoiceNo; delete o.paidAt; delete o.businessDayId; }
      return { id: o.id, status: o.status, table_id: o.tableId != null ? String(o.tableId) : null, invoice_no: invoice, business_day_id: dayId,
               paid_at: paidAt, total, data: o, created_at: iso(o.createdAt) || iso(paidAt), updated_at: iso(o.updatedAt) || iso(paidAt) || iso(o.createdAt) };
    });
    if (dayFixed) warnings.push(`${dayFixed} sale(s) were assigned to a business day by their payment time.`);
    if (noDay) warnings.push(`${noDay} sale(s) fall outside every business day and will not show in daily reports.`);

    const ingredients = Array.isArray(c.ingredients) ? c.ingredients : [];
    if (ingredients.length) warnings.push(`${ingredients.length} stock ingredient(s) can NOT be imported (the current app has no Stock feature). They are kept in the file under "unsupported".`);

    const tables = {
      categories, products, dining_tables, outlet_settings: [{ data: { ...settings, updatedAt: now } }],
      business_days: days.map(d => ({ id: d.id, opened_at: d.openedAt, closed_at: d.closedAt || null, data: d })),
      orders: rows, cashbook_entries: [],
      cashbook_config: [{ data: { drawerOpeningBalance: 0, bankOpeningBalance: 0, openingSetAt: 0, updatedAt: now } }]
    };
    const paidRows = rows.filter(r => r.status === "paid");
    const doc = {
      app: "froolla-pos", format: 1, createdAt: new Date(now).toISOString(), createdBy: "Old-app migration",
      organization: { id: null, name: settings.cafeName }, outlet: { id: null, name: settings.cafeName },
      invoiceNextNo: next, source: "old-app-kv",
      counts: Object.keys(tables).reduce((m, k) => (m[k] = tables[k].length, m), {}),
      paidSales: paidRows.length, paidTotal: paidRows.reduce((s, r) => s + (r.total || 0), 0),
      checksum: opts.sha256 ? await opts.sha256(JSON.stringify(tables)) : null,
      tables, auditLog: [], unsupported: { ingredients }
    };
    return { doc, warnings };
  }

  const api = { convert };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.OldToBackup = api;

  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    const fs = require("fs"), cr = require("crypto");
    const [inp, out] = process.argv.slice(2);
    if (!inp || !out) { console.error("usage: node old-to-backup.js <kv-export.json> <backup-out.json>"); process.exit(1); }
    convert(JSON.parse(fs.readFileSync(inp, "utf8")), { sha256: async (t) => cr.createHash("sha256").update(t).digest("hex") })
      .then(({ doc, warnings }) => { fs.writeFileSync(out, JSON.stringify(doc)); console.log(`Wrote ${out}: ${doc.paidSales} sales, ${doc.counts.products} items.`); warnings.forEach(w => console.log(" - " + w)); })
      .catch(e => { console.error("Failed: " + e.message); process.exit(1); });
  }
})(typeof window !== "undefined" ? window : globalThis);
