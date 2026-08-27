-- Run this once in your Supabase project's SQL Editor (Database > SQL Editor > New query).

create table if not exists kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security must be enabled, then explicitly allowed — Supabase blocks all
-- access by default once RLS is on. This policy allows the app's anon key to read and
-- write freely, which matches a single-till internal tool with no login screen.
alter table kv enable row level security;

create policy "Allow anon read" on kv
  for select using (true);

create policy "Allow anon write" on kv
  for insert with check (true);

create policy "Allow anon update" on kv
  for update using (true);

-- SECURITY NOTE: anyone who has your site's URL and anon key can read/write this table,
-- since there's no login flow in the app. That's fine for a private, unlisted staff tool,
-- but do not link to it publicly. If you want this locked down properly later (e.g. a PIN
-- or staff login before the app can read/write), say so and the app + these policies can
-- be updated to require an authenticated Supabase session instead of "using (true)".
