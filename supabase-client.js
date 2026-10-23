/* ============================================================================================
   Supabase connection — the ONLY file you need to edit to point this app at your own
   Supabase project.

   1. Create a project at supabase.com (free tier is fine).
   2. SQL Editor → New query → paste supabase-schema.sql from this folder → Run.
   3. Project Settings → API → copy the "Project URL" and the "anon public" key below.

   Every table/menu/sale read and write in the app goes through the two helpers exported
   here (SupabaseDB.cloudGet / SupabaseDB.cloudSet). Keeping the connection in its own file
   means the credentials live in exactly one place and the main app file never needs to be
   touched to move to a different Supabase project.
   ============================================================================================ */
(function () {
  "use strict";

  const SUPABASE_URL = "https://qptfzlbcgtxeidtdruau.supabase.co";       // e.g. "https://xxxxxxxx.supabase.co"
  const SUPABASE_ANON_KEY = "sb_publishable_YWqc-crm-tvhqb00uo0ZFQ_OCz_FuEM"; // your project's "anon public" API key

  const supabaseClient = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  if (!supabaseClient) {
    console.error("Supabase is not configured (missing URL/key, or the supabase-js script " +
      "didn't load) — sales cannot be saved until this is fixed.");
  }

  // Every table/category/menu-item/sale in the app is stored as one JSON blob per key in a
  // simple `kv` table (key TEXT PRIMARY KEY, value JSONB). See supabase-schema.sql.
  async function cloudGet(key) {
    if (!supabaseClient) throw new Error("Supabase is not configured");
    const { data, error } = await supabaseClient.from("kv").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? data.value : undefined;
  }

  async function cloudSet(key, value) {
    if (!supabaseClient) throw new Error("Supabase is not configured");
    const { error } = await supabaseClient.from("kv").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  }

  // Real connectivity check. navigator.onLine only says "the device has a network
  // interface" (true on wifi with no internet), so this does a tiny round trip to Supabase
  // with a hard timeout. Sale add/update/delete call it first and do NOTHING if it fails.
  async function ping(timeoutMs) {
    if (!supabaseClient) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    try {
      const { error } = await supabaseClient.from("kv").select("key").limit(1).abortSignal(ctrl.signal);
      return !error;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================================================
     Orders for MULTIPLE DEVICES — one database ROW per order (table pos_orders, see
     supabase-multidevice.sql) instead of one shared JSON blob.
       * Each order is saved on its own, so two devices can never overwrite each other's bills.
       * Optimistic lock: a save only lands if the order's `version` is what this device last saw.
         If another device changed an OPEN table meanwhile, the two edits are merged (quantity
         changes applied as deltas). A paid bill is never silently overwritten.
       * Deleting = marking the row deleted (tombstone), so every device learns about it.
       * Invoice numbers come from a database counter (RPC pos_next_invoice_no): no duplicates.
       * Only one open bill per table (unique index) — a second device joins the first.
     ============================================================================================ */
  const ordersApi = (function () {
    const T = "pos_orders";
    const PAGE = 1000;
    const COLS = "id, data, version, deleted, updated_at";
    const meta = new Map();      // id -> { version, base }  what the database held when this device last read/wrote it
    let lastSeen = null;         // newest updated_at this device has applied

    function sb() { if (!supabaseClient) throw new Error("Supabase is not configured"); return supabaseClient; }
    function ok(res) { if (res.error) throw res.error; return res.data; }
    function stable(v) {
      if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
      if (v && typeof v === "object") {
        return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
      }
      return JSON.stringify(v === undefined ? null : v);
    }
    function conflict(msg) { const e = new Error(msg); e.conflict = true; return e; }
    function isMissing(e) {
      const m = ((e && e.code) || "") + " " + ((e && e.message) || "");
      return /42P01|PGRST205/.test(m) || (/pos_orders/.test(m) && /(does not exist|schema cache|could not find)/i.test(m));
    }
    const lineKey = l => (l.itemId || l.name);
    const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));   // meta.base must never share objects with live orders

    /* Is the multi-device table installed? false => the app keeps using the old single-blob mode. */
    async function available() {
      if (!supabaseClient) return false;
      try {
        const r = await sb().from(T).select("id").limit(1);
        if (r.error) { if (isMissing(r.error)) return false; throw r.error; }
        return true;
      } catch (e) { if (isMissing(e)) return false; throw e; }
    }

    /* One-time import of the old single-blob orders into rows (only while the table is still empty). */
    async function migrateLegacyIfEmpty() {
      const any = ok(await sb().from(T).select("id").limit(1));
      if (any && any.length) return false;
      const legacy = await cloudGet("cafe-orders");
      if (!Array.isArray(legacy) || !legacy.length) return false;
      let deleted = [];
      try { const d = await cloudGet("cafe-deleted-orders"); if (Array.isArray(d)) deleted = d.map(String); } catch (e) { /* none */ }
      const dead = new Set(deleted);
      const byTable = new Map();
      const rows = [];
      legacy.forEach(o => {
        if (!o || o.id == null || dead.has(String(o.id))) return;
        const order = { ...o, id: String(o.id) };
        if (order.status === "open" && order.tableId != null) {
          // the unique "one open bill per table" rule: fold duplicate open bills of a table together
          const first = byTable.get(order.tableId);
          if (first) {
            (order.items || []).forEach(l => {
              const t = (first.items = first.items || []).find(x => lineKey(x) === lineKey(l));
              if (t) t.qty = (Number(t.qty) || 0) + (Number(l.qty) || 0); else first.items.push({ ...l });
            });
            return;
          }
          byTable.set(order.tableId, order);
        }
        rows.push({ id: order.id, data: order });
      });
      for (let i = 0; i < rows.length; i += 200) {
        ok(await sb().from(T).upsert(rows.slice(i, i + 200), { onConflict: "id", ignoreDuplicates: true }));
      }
      return true;
    }

    /* Full load. Returns { orders, commit } — call commit() once the result is actually applied,
       so a response that gets discarded never leaves this device with newer versions than data. */
    async function loadAll() {
      const out = []; let last = null;
      for (;;) {
        let q = sb().from(T).select(COLS).eq("deleted", false).order("id").limit(PAGE);
        if (last !== null) q = q.gt("id", last);
        const rows = ok(await q);
        out.push(...rows);
        if (rows.length < PAGE) break;
        last = rows[rows.length - 1].id;
      }
      out.sort((a, b) => ((a.data && a.data.createdAt) || 0) - ((b.data && b.data.createdAt) || 0));
      return {
        orders: out.map(r => r.data),
        commit() {
          meta.clear(); lastSeen = null;
          out.forEach(r => { meta.set(r.id, { version: r.version, base: clone(r.data) }); if (r.updated_at && (!lastSeen || r.updated_at > lastSeen)) lastSeen = r.updated_at; });
        }
      };
    }

    /* Cheap poll: only rows changed since the last one applied (includes deletions). */
    async function loadChanges() {
      const rows = [];
      const since = lastSeen ? new Date(new Date(lastSeen).getTime() - 15000).toISOString() : null;
      for (let from = 0; from < 20 * PAGE; from += PAGE) {
        let q = sb().from(T).select(COLS).order("updated_at").order("id").range(from, from + PAGE - 1);
        if (since) q = q.gt("updated_at", since);
        const part = ok(await q);
        rows.push(...part);
        if (part.length < PAGE) break;
      }
      return {
        rows,
        commitCursor() { rows.forEach(r => { if (r.updated_at && (!lastSeen || r.updated_at > lastSeen)) lastSeen = r.updated_at; }); }
      };
    }
    function adopt(row) { meta.set(row.id, { version: row.version, base: clone(row.data) }); }
    function forget(id) { meta.delete(id); }

    // Three-way merge of an OPEN order: base = what this device last saw, local = what it wants to save,
    // remote = what the database holds now. Quantity changes are applied as deltas.
    function mergeOpen(local, base, remote) {
      const b = base || {};
      const out = { ...remote };
      Object.keys(local).forEach(k => {
        if (k === "items" || k === "kot" || k === "id" || k === "createdAt") return;
        if (stable(local[k]) !== stable(b[k])) out[k] = local[k];
      });
      const bm = new Map((b.items || []).map(l => [lineKey(l), l]));
      const rm = new Map((remote.items || []).map(l => [lineKey(l), l]));
      const lm = new Map((local.items || []).map(l => [lineKey(l), l]));
      const ids = [...new Set([...rm.keys(), ...lm.keys(), ...bm.keys()])];
      const items = [];
      ids.forEach(id => {
        const bq = bm.has(id) ? Number(bm.get(id).qty) || 0 : 0;
        const lq = lm.has(id) ? Number(lm.get(id).qty) || 0 : 0;
        const rq = rm.has(id) ? Number(rm.get(id).qty) || 0 : 0;
        const q = rq + (lq - bq);
        if (q <= 0) return;
        const line = { ...(lm.get(id) || rm.get(id)), qty: q };
        if (lm.has(id) && rm.has(id) && stable(lm.get(id).note) === stable(bm.has(id) ? bm.get(id).note : undefined)) line.note = rm.get(id).note;
        items.push(line);
      });
      out.items = items;
      const lk = local.kot, rk = remote.kot;
      if (lk && (!rk || (stable(lk) !== stable(b.kot) && (Number(lk.updatedAt) || 0) >= (Number(rk.updatedAt) || 0)))) out.kot = lk;
      else if (rk) out.kot = rk;
      return out;
    }

    async function updateOrder(o) {
      let m = meta.get(o.id);
      let data = o, merged = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        let q = sb().from(T).update({ data }).eq("id", o.id).eq("deleted", false);
        if (m && m.version != null) q = q.eq("version", m.version);
        const rows = ok(await q.select("id, data, version"));
        if (rows && rows.length === 1) {
          meta.set(rows[0].id, { version: rows[0].version, base: clone(rows[0].data) });
          return { id: rows[0].id, data: rows[0].data, merged };
        }
        const cur = ok(await sb().from(T).select("id, data, version, deleted").eq("id", o.id).maybeSingle());
        if (!cur || cur.deleted) throw conflict("This bill no longer exists - it was changed or deleted on another device.");
        if (cur.data && cur.data.status === "paid") {
          // Same sale already saved (our earlier request got through but the reply was lost) -> success.
          if (o.status === "paid" && stable(cur.data.items) === stable(o.items) && stable(cur.data.payment) === stable(o.payment)) {
            meta.set(cur.id, { version: cur.version, base: clone(cur.data) });
            return { id: cur.id, data: cur.data, merged: true };
          }
          if (o.status === "paid" && m && m.base && m.base.status === "paid") throw conflict("This sale was changed on another device - please refresh and try again.");
          throw conflict("This bill was already completed on another device.");
        }
        if (o.status === "paid") {
          // Paying a bill whose items changed behind our back would charge the wrong amount.
          if (stable(cur.data.items) !== stable(m && m.base ? m.base.items : undefined)) {
            throw conflict("Items on this bill changed on another device - reopen the table and check before paying.");
          }
          data = { ...o, kot: cur.data.kot !== undefined ? cur.data.kot : o.kot };
        } else {
          data = mergeOpen(o, m && m.base, cur.data);
          merged = true;
        }
        m = { version: cur.version, base: clone(cur.data) };
      }
      throw conflict("This table is being edited on several devices - please try again.");
    }

    // Two devices opened the same empty table at once: put this device's items onto the bill that won.
    async function joinExistingTable(o) {
      const ex = ok(await sb().from(T).select("id, data, version").eq("table_id", o.tableId).eq("status", "open").eq("deleted", false).maybeSingle());
      if (!ex) throw conflict("Could not open this table - please try again.");
      meta.set(ex.id, { version: ex.version, base: clone(ex.data) });
      const target = { ...mergeOpen(o, { items: [] }, ex.data), id: ex.id };
      const r = await updateOrder(target);
      return { id: ex.id, data: r.data, merged: true, replaceId: o.id };
    }

    async function remove(id, opts) {
      const m = meta.get(id);
      let q = sb().from(T).update({ deleted: true }).eq("id", id);
      if (!(opts && opts.force) && m && m.version != null) q = q.eq("version", m.version);
      const rows = ok(await q.select("id"));
      if (!rows || rows.length === 0) {
        const cur = ok(await sb().from(T).select("id, deleted").eq("id", id).maybeSingle());
        if (cur && !cur.deleted) throw conflict("This table was changed on another device - nothing was deleted.");
      }
      meta.delete(id);
    }

    /* Push every difference between `snapshot` (id -> stable(order) as confirmed in the database) and `orders`.
       Returns { saved: [{id, data, merged?, replaceId?}], deleted: [id] }. */
    async function sync(snapshot, orders) {
      const saved = [];
      const present = new Set();
      for (const o of orders) {
        present.add(o.id);
        if (snapshot.get(o.id) === stable(o)) continue;
        if (!snapshot.has(o.id)) {
          const res = await sb().from(T).insert({ id: o.id, data: o }).select("id, data, version");
          if (res.error && res.error.code === "23505") {
            if (/one_open_per_table/.test(res.error.message || "")) saved.push(await joinExistingTable(o));
            else saved.push(await updateOrder(o));      // same id already saved (a retry) -> idempotent
            continue;
          }
          const rows = ok(res);
          if (!rows || rows.length !== 1) throw new Error("Insert returned no row");
          meta.set(rows[0].id, { version: rows[0].version, base: clone(rows[0].data) });
          saved.push({ id: rows[0].id, data: rows[0].data });
        } else {
          saved.push(await updateOrder(o));
        }
      }
      const deleted = [];
      for (const id of [...snapshot.keys()].filter(id => !present.has(id))) {
        const m = meta.get(id);
        await remove(id, { force: !!(m && m.base && m.base.status === "paid") });
        deleted.push(id);
      }
      return { saved, deleted };
    }

    /* Next invoice number from the database counter (never repeats across devices). p_min keeps it
       above any number already printed before the upgrade. */
    async function nextInvoiceNo(min) {
      const v = ok(await sb().rpc("pos_next_invoice_no", { p_min: Math.max(1, Math.floor(min) || 1) }));
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) throw new Error("Invoice counter returned nothing");
      return n;
    }

    return { available, migrateLegacyIfEmpty, loadAll, loadChanges, adopt, forget, sync, remove, nextInvoiceNo, stable, _mergeOpen: mergeOpen };
  })();

  window.SupabaseDB = { client: supabaseClient, cloudGet, cloudSet, ping, orders: ordersApi };
})();
