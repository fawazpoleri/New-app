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

  window.SupabaseDB = { client: supabaseClient, cloudGet, cloudSet };
})();
