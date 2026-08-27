# Kaapi POS — hosting on GitHub Pages + Supabase

## 1. Create the Supabase project (cloud database)
1. Go to supabase.com → New project (free tier is fine).
2. Once it's up, open **SQL Editor → New query**, paste in the contents of
   `supabase-schema.sql` from this folder, and run it. This creates the `kv` table
   the app reads/writes.
3. Go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **anon public** key (a long string)

## 2. Wire the keys into the app
Open `index.html`, find these two lines near the top of the `<script>` block:

```js
const SUPABASE_URL = "";       // e.g. "https://xxxxxxxx.supabase.co"
const SUPABASE_ANON_KEY = "";  // your project's "anon" public API key
```

Paste your values in between the quotes and save. That's the only code change needed —
every table/category/order read and write now goes through Supabase automatically, with
local storage kept as an offline cache/fallback.

## 3. Push this folder to GitHub
This folder is already a git repo with one commit. To publish it:

```bash
# Create an empty repo on github.com first (no README/license), then:
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

## 4. Turn on GitHub Pages
In your new repo on GitHub: **Settings → Pages → Source → Deploy from a branch →
Branch: main, folder: / (root) → Save**.

GitHub gives you a live URL after a minute or two, typically:
`https://<your-username>.github.io/<repo-name>/`

That's your hosted app — open it on any device's browser and it now shares live data
through Supabase.

## 4b. Or host on Vercel instead (recommended if you want a custom domain later)
`vercel.json` is already included (sets sensible cache headers so updates to `index.html`
and `sw.js` show up immediately instead of being stuck in a cached copy).

**Option A — from the Vercel dashboard (no CLI needed):**
1. Push this repo to GitHub first (steps above).
2. Go to vercel.com → **Add New → Project → Import Git Repository** → pick this repo.
3. Framework preset: **Other** (it's static files, no build step). Leave Build Command
   and Output Directory blank. Click **Deploy**.
4. Every future `git push` to `main` auto-deploys.

**Option B — straight from this folder, no GitHub needed:**
```bash
npm i -g vercel     # one-time
cd kaapipos-pwa-fixed
vercel --prod
```
Follow the prompts (log in, confirm the project name) and it deploys directly, giving
you a `https://<project>.vercel.app` URL.

## 5. Android app
If you also build the Android app (see the separate Capacitor project), paste the same
`SUPABASE_URL` / `SUPABASE_ANON_KEY` into its `www/index.html` before rebuilding, so the
phone app and the web version share the same live data.

## Notes / limits
- **Security:** the current Supabase policies allow anyone with the URL + anon key to
  read/write the `kv` table — there's no login screen in the app. Fine for a private,
  unlisted staff tool; don't share the link publicly. Say the word if you want a PIN or
  proper login added later.
- **Concurrent edits:** config/orders are stored as one JSON blob per key, so two
  devices saving at the exact same instant will have the later write win. Not an issue
  for normal single-till use; ask if you want this split into real relational tables
  (rows per order/item) for safe simultaneous multi-device editing.
- **Offline:** if the internet drops, the app keeps working off its local cache and
  shows a toast that it saved locally — but changes made while offline won't reach
  other devices until it's back online and saves again.
