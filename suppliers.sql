-- =====================================================================================
-- Suppliers (purchases & payments) for Kaapi POS — run ONCE in Supabase → SQL editor. Safe to re-run.
--   * A supplier bill is a PAYABLE. Only a payment reduces what you owe. Bill status is never stored:
--     it is worked out from the bill total vs. its valid payments. All money is integer paise.
--   * The app can only READ these tables. Every change goes through one of the sup_* functions below,
--     each of which is a single database transaction with row locks:
--       - no overpaying a bill, no paying a cancelled bill, no duplicate bill number per supplier
--       - request-id idempotency (double tap / retry never pays or saves twice)
--       - corrections are "Reverse payment" / "Cancel bill" (nothing is ever deleted)
--   * Supplier payments do NOT touch sales, closing or cash-drawer figures in the POS.
--   * NOTE: like the rest of this app (kv table) there is no server-side login; the Admin password is
--     checked in the browser. Anyone holding the site's anon key could read or call these functions.
-- =====================================================================================

create table if not exists public.suppliers (
  id            text primary key,
  name          text not null check (length(btrim(name)) between 1 and 120),
  name_key      text not null,
  phone         text not null default '',
  address       text not null default '',
  notes         text not null default '',
  opening_paise bigint not null default 0 check (opening_paise >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists suppliers_name_key on public.suppliers(name_key);

create table if not exists public.purchase_bills (
  id             text primary key,
  supplier_id    text not null references public.suppliers(id),
  kind           text not null default 'purchase' check (kind in ('purchase','opening')),
  bill_no        text not null default '',
  bill_key       text not null default '',
  bill_date      date not null,
  due_date       date,
  subtotal_paise bigint not null check (subtotal_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  tax_paise      bigint not null default 0 check (tax_paise >= 0),
  other_paise    bigint not null default 0 check (other_paise >= 0),
  total_paise    bigint not null check (total_paise > 0),
  notes          text not null default '',
  status         text not null default 'active' check (status in ('active','cancelled')),
  cancelled_at   timestamptz,
  cancel_reason  text,
  request_id     text unique,
  created_at     timestamptz not null default now(),
  check (due_date is null or due_date >= bill_date)
);
create unique index if not exists purchase_bill_no_unique on public.purchase_bills(supplier_id, bill_key) where status = 'active' and bill_key <> '';
create index if not exists purchase_bills_supplier_idx on public.purchase_bills(supplier_id);

create table if not exists public.purchase_items (
  id               text primary key,
  bill_id          text not null references public.purchase_bills(id),
  line_no          integer not null,
  name             text not null,
  qty_milli        bigint not null check (qty_milli > 0),
  unit             text not null default '',
  unit_price_paise bigint not null check (unit_price_paise >= 0),
  line_paise       bigint not null check (line_paise >= 0)
);
create index if not exists purchase_items_bill_idx on public.purchase_items(bill_id);

create table if not exists public.supplier_payments (
  id             text primary key,
  supplier_id    text not null references public.suppliers(id),
  bill_id        text references public.purchase_bills(id),
  kind           text not null check (kind in ('bill','advance')),
  amount_paise   bigint not null check (amount_paise > 0),
  method         text not null check (method in ('cash','upi','bank','card','other')),
  account        text not null check (account in ('drawer','bank')),
  paid_on        date not null,
  paid_at        bigint not null,
  reference      text not null default '',
  notes          text not null default '',
  status         text not null default 'valid' check (status in ('valid','reversed')),
  reversed_at    bigint,
  reverse_reason text,
  request_id     text unique,
  created_at     timestamptz not null default now()
);
create index if not exists supplier_payments_supplier_idx on public.supplier_payments(supplier_id);
create index if not exists supplier_payments_bill_idx on public.supplier_payments(bill_id);

create table if not exists public.supplier_allocations (
  id           text primary key,
  payment_id   text not null references public.supplier_payments(id),
  bill_id      text not null references public.purchase_bills(id),
  amount_paise bigint not null check (amount_paise > 0),
  created_at   timestamptz not null default now()
);
create index if not exists supplier_alloc_bill_idx on public.supplier_allocations(bill_id);
create index if not exists supplier_alloc_payment_idx on public.supplier_allocations(payment_id);

-- ---------- row level security: the app may only READ; writes happen only inside the functions ----------
do $$
declare t text;
begin
  foreach t in array array['suppliers','purchase_bills','purchase_items','supplier_payments','supplier_allocations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format('create policy %1$s_read on public.%1$I for select using (true)', t);
  end loop;
end $$;

-- ---------- helpers ----------
create or replace function public.sup_fmt(p bigint) returns text language sql immutable as $$
  select '₹' || case when p % 100 = 0 then (p / 100)::text else to_char(p / 100.0, 'FM999999999990.00') end
$$;
create or replace function public.sup_newid(p text) returns text language sql volatile as $$
  select p || replace(gen_random_uuid()::text, '-', '')
$$;
create or replace function public.sup_now_ms() returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;
create or replace function public.sup_bill_paid(p_bill text) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(a.amount_paise), 0)::bigint from public.supplier_allocations a
    join public.supplier_payments p on p.id = a.payment_id where a.bill_id = p_bill and p.status = 'valid'
$$;

-- The one place a payment is recorded. Caller has already locked the supplier / bill row.
create or replace function public.sup_insert_payment(
  p_supplier public.suppliers, p_bill public.purchase_bills, p_amount bigint,
  p_method text, p_account text, p_reference text, p_notes text, p_request_id text, p_today date)
returns text language plpgsql security definer set search_path = public as $$
declare v_acct text; v_id text := public.sup_newid('sp_');
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Enter a payment amount more than zero'; end if;
  if p_method not in ('cash','upi','bank','card','other') then raise exception 'Choose a payment method'; end if;
  if p_method = 'other' then
    if coalesce(p_account, '') not in ('drawer','bank') then raise exception 'Choose whether this was paid from the cash drawer or the bank'; end if;
    v_acct := p_account;
  else v_acct := case when p_method = 'cash' then 'drawer' else 'bank' end; end if;
  if p_today is null or abs(p_today - current_date) > 1 then raise exception 'The payment date is not valid'; end if;
  insert into public.supplier_payments(id, supplier_id, bill_id, kind, amount_paise, method, account, paid_on, paid_at, reference, notes, status, request_id)
  values (v_id, p_supplier.id, p_bill.id, case when p_bill.id is null then 'advance' else 'bill' end, p_amount, p_method, v_acct, p_today, public.sup_now_ms(),
          coalesce(p_reference, ''), coalesce(p_notes, ''), 'valid', p_request_id);
  if p_bill.id is not null then
    insert into public.supplier_allocations(id, payment_id, bill_id, amount_paise) values (public.sup_newid('sa_'), v_id, p_bill.id, p_amount);
  end if;
  return v_id;
end $$;

-- ---------- public functions ----------
create or replace function public.sup_save(p_id text, p_name text, p_phone text, p_address text, p_notes text, p_opening bigint, p_today date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text; v_id text := p_id; v_dup record; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then raise exception 'Enter the supplier''s name'; end if;
  if length(v_name) > 120 then raise exception 'The supplier name is too long'; end if;
  if coalesce(p_phone, '') <> '' and coalesce(p_phone, '') !~ '^[0-9+()\-\s.]{3,30}$' then raise exception 'Enter a valid phone number'; end if;
  v_key := lower(regexp_replace(v_name, '\s+', ' ', 'g'));
  select id, name, active into v_dup from public.suppliers where name_key = v_key and id is distinct from v_id;
  if found then
    raise exception 'A supplier named "%" already exists%', v_dup.name, case when v_dup.active then '.' else ' (archived — open it and tap Restore).' end;
  end if;
  if v_id is not null then
    update public.suppliers set name = v_name, name_key = v_key, phone = btrim(coalesce(p_phone,'')), address = btrim(coalesce(p_address,'')),
           notes = btrim(coalesce(p_notes,'')), updated_at = now() where id = v_id;
    if not found then raise exception 'Supplier not found'; end if;
  else
    if coalesce(p_opening, 0) < 0 or coalesce(p_opening, 0) > 100000000000 then raise exception 'Opening balance is not a valid amount'; end if;
    v_id := public.sup_newid('sup_');
    insert into public.suppliers(id, name, name_key, phone, address, notes, opening_paise)
    values (v_id, v_name, v_key, btrim(coalesce(p_phone,'')), btrim(coalesce(p_address,'')), btrim(coalesce(p_notes,'')), coalesce(p_opening, 0));
    if coalesce(p_opening, 0) > 0 then
      insert into public.purchase_bills(id, supplier_id, kind, bill_no, bill_key, bill_date, subtotal_paise, total_paise, notes)
      values (public.sup_newid('pb_'), v_id, 'opening', 'Opening balance', '', p_today, p_opening, p_opening, 'Balance owed before this app was used');
    end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.sup_set_active(p_id text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.suppliers set active = p_active, updated_at = now() where id = p_id;
  if not found then raise exception 'Supplier not found'; end if;
end $$;

create or replace function public.sup_create_purchase(
  p_request_id text, p_supplier_id text, p_bill_no text, p_bill_date date, p_due_date date, p_items jsonb,
  p_discount bigint, p_tax bigint, p_other bigint, p_notes text, p_expected_total bigint, p_payment jsonb, p_today date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sup public.suppliers; v_prev public.purchase_bills; v_bill public.purchase_bills;
  v_id text := public.sup_newid('pb_'); v_key text; v_no text := btrim(coalesce(p_bill_no, ''));
  v_sub bigint := 0; v_total bigint; v_line bigint; v_i int := 0; it jsonb; v_qty bigint; v_price bigint; v_nm text; v_dup record;
  v_pay_amt bigint; v_pid text;
begin
  if coalesce(p_request_id, '') = '' then raise exception 'Missing request id'; end if;
  select * into v_prev from public.purchase_bills where request_id = p_request_id;
  if found then return jsonb_build_object('billId', v_prev.id, 'replayed', true); end if;
  select * into v_sup from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'Choose the supplier'; end if;
  if not v_sup.active then raise exception 'This supplier is archived — restore it first'; end if;
  if p_bill_date is null then raise exception 'Enter a valid purchase date'; end if;
  if p_due_date is not null and p_due_date < p_bill_date then raise exception 'The due date cannot be before the purchase date'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 200 then raise exception 'Add at least one purchase item'; end if;
  if coalesce(p_discount,0) < 0 or coalesce(p_tax,0) < 0 or coalesce(p_other,0) < 0 then raise exception 'Discount, tax and other charges must be zero or more'; end if;
  v_key := upper(regexp_replace(v_no, '\s+', '', 'g'));
  if v_key <> '' then
    select id, bill_date into v_dup from public.purchase_bills where supplier_id = v_sup.id and bill_key = v_key and status = 'active';
    if found then raise exception 'Bill "%" from % was already entered (dated %). Check it isn''t a duplicate.', v_no, v_sup.name, v_dup.bill_date using hint = 'duplicate_bill'; end if;
  end if;
  insert into public.purchase_bills(id, supplier_id, kind, bill_no, bill_key, bill_date, due_date, subtotal_paise, discount_paise, tax_paise, other_paise, total_paise, notes, status, request_id)
  values (v_id, v_sup.id, 'purchase', v_no, v_key, p_bill_date, p_due_date, 0, 0, 0, 0, 1, btrim(coalesce(p_notes,'')), 'active', p_request_id);
  for it in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    v_nm := btrim(coalesce(it->>'name', ''));
    if v_nm = '' then raise exception 'Item % needs a name', v_i; end if;
    if (it->>'qtyMilli') !~ '^\d{1,12}$' or (it->>'unitPricePaise') !~ '^\d{1,12}$' then raise exception 'Quantity or price of % is not a valid amount', v_nm; end if;
    v_qty := (it->>'qtyMilli')::bigint; v_price := (it->>'unitPricePaise')::bigint;
    if v_qty < 1 then raise exception 'Quantity of % is not a valid amount', v_nm; end if;
    v_line := (v_qty * v_price + 500) / 1000;
    v_sub := v_sub + v_line;
    insert into public.purchase_items(id, bill_id, line_no, name, qty_milli, unit, unit_price_paise, line_paise)
    values (public.sup_newid('pi_'), v_id, v_i, left(v_nm, 120), v_qty, left(btrim(coalesce(it->>'unit','')), 12), v_price, v_line);
  end loop;
  if coalesce(p_discount,0) > v_sub then raise exception 'The discount is more than the items total'; end if;
  v_total := v_sub - coalesce(p_discount,0) + coalesce(p_tax,0) + coalesce(p_other,0);
  if v_total <= 0 then raise exception 'The bill total must be more than zero'; end if;
  if p_expected_total is not null and p_expected_total <> v_total then raise exception 'The total on screen doesn''t match the items — please re-check the amounts'; end if;
  update public.purchase_bills set subtotal_paise = v_sub, discount_paise = coalesce(p_discount,0), tax_paise = coalesce(p_tax,0), other_paise = coalesce(p_other,0), total_paise = v_total where id = v_id returning * into v_bill;
  v_pay_amt := coalesce(nullif(p_payment->>'amountPaise','')::bigint, 0);
  if v_pay_amt > 0 then
    if v_pay_amt > v_total then raise exception 'The first payment is more than the bill total. Save the bill, then record any extra as a supplier advance.'; end if;
    v_pid := public.sup_insert_payment(v_sup, v_bill, v_pay_amt, p_payment->>'method', p_payment->>'account', left(coalesce(p_payment->>'reference',''), 80), left(coalesce(p_payment->>'notes',''), 300), p_request_id || ':first-payment', p_today);
  end if;
  return jsonb_build_object('billId', v_id, 'paymentId', v_pid, 'replayed', false);
end $$;

create or replace function public.sup_pay(
  p_request_id text, p_bill_id text, p_supplier_id text, p_advance boolean, p_amount bigint,
  p_method text, p_account text, p_reference text, p_notes text, p_today date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sup public.suppliers; v_bill public.purchase_bills; v_prev public.supplier_payments; v_out_amt bigint; v_pid text;
begin
  if coalesce(p_request_id, '') = '' then raise exception 'Missing request id'; end if;
  select * into v_prev from public.supplier_payments where request_id = p_request_id;
  if found then return jsonb_build_object('paymentId', v_prev.id, 'billId', v_prev.bill_id, 'replayed', true); end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000000000 then raise exception 'Payment amount is not a valid amount'; end if;
  if coalesce(p_advance, false) then
    select * into v_sup from public.suppliers where id = p_supplier_id for update;
    if not found then raise exception 'Choose the supplier'; end if;
    v_pid := public.sup_insert_payment(v_sup, null, p_amount, p_method, p_account, left(coalesce(p_reference,''), 80), left(coalesce(p_notes,''), 300), p_request_id, p_today);
    return jsonb_build_object('paymentId', v_pid, 'billId', null, 'replayed', false);
  end if;
  select * into v_bill from public.purchase_bills where id = p_bill_id for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_sup from public.suppliers where id = v_bill.supplier_id for update;
  if v_bill.status = 'cancelled' then raise exception 'This bill was cancelled'; end if;
  v_out_amt := v_bill.total_paise - public.sup_bill_paid(v_bill.id);
  if v_out_amt <= 0 then raise exception 'This bill is already fully paid'; end if;
  if p_amount > v_out_amt then
    raise exception 'That is more than the balance (%). Pay at most %, or record the extra as a supplier advance.', public.sup_fmt(v_out_amt), public.sup_fmt(v_out_amt) using hint = 'overpay';
  end if;
  v_pid := public.sup_insert_payment(v_sup, v_bill, p_amount, p_method, p_account, left(coalesce(p_reference,''), 80), left(coalesce(p_notes,''), 300), p_request_id, p_today);
  return jsonb_build_object('paymentId', v_pid, 'billId', v_bill.id, 'replayed', false);
end $$;

create or replace function public.sup_allocate_advance(p_payment_id text, p_bill_id text, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_p public.supplier_payments; v_b public.purchase_bills; v_free bigint; v_left bigint;
begin
  if p_amount is null or p_amount < 1 then raise exception 'Amount is not a valid amount'; end if;
  select * into v_p from public.supplier_payments where id = p_payment_id for update;
  if not found or v_p.kind <> 'advance' or v_p.status <> 'valid' then raise exception 'That advance isn''t available'; end if;
  select * into v_b from public.purchase_bills where id = p_bill_id for update;
  if not found or v_b.supplier_id <> v_p.supplier_id then raise exception 'Choose a bill from the same supplier'; end if;
  if v_b.status = 'cancelled' then raise exception 'This bill was cancelled'; end if;
  v_free := v_p.amount_paise - coalesce((select sum(amount_paise) from public.supplier_allocations where payment_id = v_p.id), 0);
  if p_amount > v_free then raise exception 'Only % of this advance is still unused', public.sup_fmt(v_free); end if;
  v_left := v_b.total_paise - public.sup_bill_paid(v_b.id);
  if p_amount > v_left then raise exception 'The bill only has % left to pay', public.sup_fmt(v_left); end if;
  insert into public.supplier_allocations(id, payment_id, bill_id, amount_paise) values (public.sup_newid('sa_'), v_p.id, v_b.id, p_amount);
  return jsonb_build_object('billId', v_b.id);
end $$;

create or replace function public.sup_reverse_payment(p_payment_id text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_p public.supplier_payments; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for reversing this payment'; end if;
  select * into v_p from public.supplier_payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.status <> 'valid' then raise exception 'This payment was already reversed'; end if;
  update public.supplier_payments set status = 'reversed', reversed_at = public.sup_now_ms(), reverse_reason = left(v_reason, 200) where id = v_p.id;
  return jsonb_build_object('billId', v_p.bill_id);
end $$;

create or replace function public.sup_cancel_bill(p_bill_id text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b public.purchase_bills; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for cancelling this bill'; end if;
  select * into v_b from public.purchase_bills where id = p_bill_id for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_b.kind = 'opening' then raise exception 'An opening balance can''t be cancelled'; end if;
  if v_b.status = 'cancelled' then raise exception 'This bill is already cancelled'; end if;
  if public.sup_bill_paid(v_b.id) > 0 then raise exception 'This bill has payments. Reverse them first, then cancel the bill.'; end if;
  update public.purchase_bills set status = 'cancelled', cancelled_at = now(), cancel_reason = left(v_reason, 200) where id = v_b.id;
  return jsonb_build_object('billId', v_b.id);
end $$;

-- helpers are internal; only the seven sup_* functions are callable from the app
revoke all on function public.sup_fmt(bigint), public.sup_newid(text), public.sup_now_ms(), public.sup_bill_paid(text),
  public.sup_insert_payment(public.suppliers, public.purchase_bills, bigint, text, text, text, text, text, date) from public, anon, authenticated;
grant execute on function public.sup_save(text, text, text, text, text, bigint, date), public.sup_set_active(text, boolean),
  public.sup_create_purchase(text, text, text, date, date, jsonb, bigint, bigint, bigint, text, bigint, jsonb, date),
  public.sup_pay(text, text, text, boolean, bigint, text, text, text, text, date), public.sup_allocate_advance(text, text, bigint),
  public.sup_reverse_payment(text, text), public.sup_cancel_bill(text, text) to anon, authenticated;

-- =====================================================================================
-- Original supplier bill (photo / PDF) attached to a purchase bill
--   * One file per bill, stored as a data URL (photos are shrunk in the browser first; max ~3 MB).
--   * The app can only READ it (the list loads just which bills have a file; the file itself is fetched on demand).
--     Writes go through sup_attach_file / sup_remove_file.
-- =====================================================================================
create table if not exists public.purchase_bill_files (
  bill_id    text primary key references public.purchase_bills(id),
  name       text not null default '',
  mime       text not null,
  size_bytes integer not null,
  data       text not null,
  created_at timestamptz not null default now()
);
alter table public.purchase_bill_files enable row level security;
revoke all on public.purchase_bill_files from anon, authenticated;
grant select on public.purchase_bill_files to anon, authenticated;
drop policy if exists purchase_bill_files_read on public.purchase_bill_files;
create policy purchase_bill_files_read on public.purchase_bill_files for select using (true);

create or replace function public.sup_attach_file(p_bill_id text, p_name text, p_mime text, p_data text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.purchase_bills where id = p_bill_id;
  if not found then raise exception 'Bill not found'; end if;
  if coalesce(p_mime, '') not in ('image/jpeg','image/png','image/webp','application/pdf') then raise exception 'Upload a photo or a PDF'; end if;
  if coalesce(p_data, '') !~ '^data:[a-z/+-]+;base64,' then raise exception 'That file could not be read'; end if;
  if length(p_data) > 4200000 then raise exception 'That file is too large (max about 3 MB)'; end if;
  insert into public.purchase_bill_files(bill_id, name, mime, size_bytes, data)
  values (p_bill_id, left(coalesce(p_name, ''), 120), p_mime, length(p_data), p_data)
  on conflict (bill_id) do update set name = excluded.name, mime = excluded.mime, size_bytes = excluded.size_bytes, data = excluded.data, created_at = now();
  return jsonb_build_object('billId', p_bill_id);
end $$;

create or replace function public.sup_remove_file(p_bill_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from public.purchase_bill_files where bill_id = p_bill_id;
  return jsonb_build_object('billId', p_bill_id);
end $$;

grant execute on function public.sup_attach_file(text, text, text, text), public.sup_remove_file(text) to anon, authenticated;
notify pgrst, 'reload schema';
