-- JWY Export Invoice — Supabase schema
--
-- Run this top-to-bottom in the Supabase SQL editor (or via `supabase db reset`
-- in a local project). Idempotent where it can be.
--
-- Storage buckets to create manually in the Supabase dashboard (private):
--   raw-sj50          — uploaded Jewellery-dept packing lists (.xls/.xlsx)
--   vendor-sdjjb      — uploaded Swan Diamond vendor invoices
--   generated-invoices — module output (.xlsx + .pdf)
--
-- Row-level security is ON for every table. Only authenticated users with
-- role 'accounts' or 'admin' can read/write; the role is read from JWT.

-- ───────────────────────── enums ─────────────────────────

create type jewellery_type as enum (
  'gold_plain', 'gold_mounting',
  'gold_studded_diamond', 'gold_studded_lgd', 'gold_studded_colorstone'
);

create type invoice_status as enum (
  'draft', 'generated', 'shipped', 'void'
);

create type validator_severity as enum ('hard', 'soft');

-- ───────────────────────── lookup tables (feed dropdowns) ────────────────

-- Buyers: each row = one option in the Buyer dropdown.
create table if not exists buyers (
  id          uuid primary key default gen_random_uuid(),
  display_index int unique,                              -- preserves 1..10 ordering
  name        text not null,
  address     text not null,
  city        text not null,
  country     text not null,
  default_terms text not null default '150 Days DA',
  default_preferential_agreement text,                   -- 'ECTA-AU', 'UKFTA', ''
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on buyers (display_index) where active;

-- Banks
create table if not exists banks (
  id          uuid primary key default gen_random_uuid(),
  display_index int unique,
  name        text not null,
  ad_code     text not null,
  account_no  text not null,
  swift       text not null,
  ifsc        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Freight carriers (SEQUEL / FEDEX / DHL / SELF / ARAMEX…)
create table if not exists freight_carriers (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null,
  active boolean not null default true
);

-- Freight modes (BY AIR FREIGHT / BY SEA / BY COURIER)
create table if not exists freight_modes (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null,
  active boolean not null default true
);

-- Ports of loading
create table if not exists ports (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null,
  country text not null,
  active boolean not null default true
);

-- Payment terms
create table if not exists payment_terms (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null,
  active boolean not null default true
);

-- Preferential agreements
create table if not exists preferential_agreements (
  id   uuid primary key default gen_random_uuid(),
  code text unique not null,                 -- 'ECTA-AU', 'UKFTA', 'AANZFTA'…
  description text not null default '',
  active boolean not null default true
);

-- HSN table — one row per jewellery-type classification
create table if not exists hsn_table (
  jewellery_type jewellery_type primary key,
  code text not null,
  description_tail text not null,
  max_wastage_handcrafted numeric(6,4) not null,
  min_value_addition numeric(6,4) not null
);

-- Labor rate per KT (INR / gm). Multiple historical rows allowed; module uses the
-- row flagged current=true. Updating creates a new row and flips `current`.
create table if not exists labor_rates (
  id uuid primary key default gen_random_uuid(),
  kt text not null,                           -- '9', '14', '18', '18-PD'
  rate_inr_per_gm numeric(10,2) not null,
  effective_from date not null default current_date,
  "current" boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index labor_rates_current_per_kt on labor_rates (kt) where "current";

-- ───────────────────────── app settings singleton ─────────────────────────

create table if not exists app_settings (
  id int primary key default 1,
  check (id = 1),
  -- Exporter block
  exporter_name text not null,
  exporter_address text not null,
  iec_no text not null,
  pan text not null,
  gstin text not null,
  state_code int not null,
  state_name text not null,
  district_code int not null,
  district_name text not null,
  signatory_block_1 text not null,
  signatory_block_2 text not null,
  signatory_name text not null,
  -- LUT / ARN
  lut_arn_number text not null,
  lut_arn_date date not null,
  -- Insurance line
  insurance_wording text not null,
  -- Container defaults
  container_prefix text not null default 'CONTAINER N0.',
  tin_box_text text not null default 'THREE INVOICES IN 1 TIN BOX',
  handcrafted_text text not null default 'HANDCRAFTED',
  -- MFG tuning defaults
  mfg_fixed_addon_usd numeric(10,2) not null default 10,
  default_wastage_pct numeric(6,4) not null default 0.04,
  -- Payment instructions + declarations: JSON arrays of strings
  payment_instructions jsonb not null default '[]'::jsonb,
  declarations jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── invoices ─────────────────────────

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  exp_number text not null unique,            -- 'EXP570/2026-27'
  fiscal_year text not null,                  -- '2026-27'
  invoice_date date not null,
  status invoice_status not null default 'draft',

  -- Selections (foreign keys to lookup tables)
  buyer_id uuid references buyers(id),
  bank_id uuid references banks(id),
  pre_carriage_id uuid references freight_carriers(id),
  flight_mode_id uuid references freight_modes(id),
  port_of_loading_id uuid references ports(id),
  terms_id uuid references payment_terms(id),
  preferential_agreement_id uuid references preferential_agreements(id),

  -- Overrides (null = use lookup/default; non-null = per-invoice override)
  terms_override text,
  preferential_agreement_override text,
  flight_mode_override text,

  -- Rate inputs
  gold_rate_usd_per_troy_oz numeric(12,4) not null,
  gold_purity numeric(5,3) not null default 0.999,
  gold_purchase_party text not null,
  gold_purchase_invoice_no text not null,
  gold_purchase_date date not null,
  inr_usd_rate numeric(10,4) not null,

  -- Freight / packaging
  package_gross_wt_kg numeric(10,3) not null,
  container_number int not null default 1,

  -- Totals (persisted after generation for quick dashboards)
  totals_usd numeric(14,2),
  totals_inr numeric(16,2),

  -- File references in Supabase Storage
  raw_sj50_path text,                         -- raw-sj50/<uuid>/<name>.xls
  vendor_sdjjb_path text,                     -- vendor-sdjjb/<uuid>/<name>.xls
  generated_xlsx_path text,                   -- generated-invoices/<uuid>/EXP*.xlsx
  generated_pdf_path text,

  -- Audit
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on invoices (invoice_date desc);
create index on invoices (status);
create index on invoices (buyer_id);

-- Per-lot rollups
create table if not exists invoice_lots (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  lot_no int not null,
  kt text not null,
  color text not null,
  jewellery_type jewellery_type not null,
  jewellery_type_override jewellery_type,     -- clerk-chosen override, affects HSN
  hsn_code text not null,
  description text not null,
  wastage_pct numeric(6,4) not null,
  -- Totals
  gross_wt numeric(12,4) not null,
  net_wt numeric(12,4) not null,
  wastage_wt numeric(12,4) not null,
  gold_value_usd numeric(14,2) not null,
  diamond_value_usd numeric(14,2) not null,
  stone_value_usd numeric(14,2) not null,
  mfg_cost_usd numeric(14,2) not null,
  total_usd numeric(14,2) not null,
  value_addition_ratio numeric(8,6) not null,
  unique (invoice_id, lot_no)
);

-- Pieces as parsed from SJ-50 + edits from the UI
create table if not exists invoice_pieces (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  lot_id uuid references invoice_lots(id) on delete cascade,
  stock_no text not null,
  cust_po text,
  cust_style_no text not null,
  internal_style_no text,
  bag_no text,
  kt_raw text not null,
  color_raw text not null,
  size text,
  qty int not null,
  gross_wt numeric(12,4) not null,
  net_wt_raw numeric(12,4),
  diamond_quality_code text,
  remarks text,
  item_category_raw text,
  -- Normalized
  item text,
  kt text,
  color text,
  jewellery_type jewellery_type,
  unique (invoice_id, stock_no)
);

-- Per-piece diamond details (zero or more rows per piece)
create table if not exists invoice_diamonds (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references invoice_pieces(id) on delete cascade,
  shape text not null,
  pcs int not null,
  cts numeric(10,3) not null,
  certificate_no text,
  origin text,                               -- 'MINED' | 'LGD001-CVD' | 'LGD002-HPHT'
  color_clarity text,
  rate_usd_per_ct numeric(10,2)
);
create index on invoice_diamonds (certificate_no);

-- Per-piece coloured / semi-precious stones
create table if not exists invoice_stones (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references invoice_pieces(id) on delete cascade,
  stone_type text not null,
  shape text,
  pcs int not null,
  cts numeric(10,3) not null,
  rate_usd_per_ct numeric(10,2)
);

-- Per-piece MFG tuning (gap §3.E) — overrides for AR base-gold-lock + add-on
create table if not exists invoice_piece_tuning (
  piece_id uuid primary key references invoice_pieces(id) on delete cascade,
  base_gold_lock_usd numeric(14,2),
  fixed_addon_usd numeric(10,2)
);

-- ───────────────────────── gold ledger ─────────────────────────

create table if not exists gold_purchases (
  id uuid primary key default gen_random_uuid(),
  party_name text not null,
  invoice_no text not null,
  invoice_date date not null,
  rate_usd_per_troy_oz numeric(12,4) not null,
  purity numeric(5,3) not null default 0.999,
  opening_qty_gm numeric(14,4) not null,
  created_at timestamptz not null default now(),
  unique (party_name, invoice_no)
);

create table if not exists gold_drawdowns (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references gold_purchases(id) on delete restrict,
  invoice_id uuid not null references invoices(id) on delete cascade,
  exp_number text not null,
  exp_date date not null,
  quantity_gm numeric(12,4) not null,
  created_at timestamptz not null default now(),
  unique (purchase_id, invoice_id)
);
create index on gold_drawdowns (purchase_id);
create index on gold_drawdowns (invoice_id);

-- Computed balance view
create or replace view v_gold_purchase_balance as
  select p.id, p.party_name, p.invoice_no, p.opening_qty_gm,
         coalesce(sum(d.quantity_gm), 0) as used_gm,
         (p.opening_qty_gm - coalesce(sum(d.quantity_gm), 0)) as balance_gm
    from gold_purchases p
    left join gold_drawdowns d on d.purchase_id = p.id
   group by p.id;

-- ───────────────────────── stones register ─────────────────────────

create table if not exists stones_register (
  certificate_no text primary key,
  lab_origin text,                           -- MINED / LGD001-CVD / LGD002-HPHT
  color_clarity text,
  shape text,
  cts numeric(10,3),
  last_rate_usd_per_ct numeric(10,2),
  times_seen int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

-- ───────────────────────── audit log ─────────────────────────

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) default auth.uid(),
  action text not null,                      -- 'generate' | 'edit' | 'override' | 'void'
  invoice_id uuid references invoices(id) on delete set null,
  exp_number text,
  details jsonb
);
create index on audit_log (invoice_id);
create index on audit_log (created_at desc);

-- ───────────────────────── RLS ─────────────────────────

-- The approach: every authenticated user can read lookup tables; only users
-- with role claim 'accounts' or 'admin' in their JWT (`app_metadata.role`) can
-- write. Change to taste.

create or replace function auth_role() returns text as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', 'viewer')
$$ language sql stable;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', r.tablename);
  end loop;
end$$;

-- Read: any authenticated user
-- Write: role in (accounts, admin)
do $$
declare t text;
begin
  foreach t in array array[
    'buyers','banks','freight_carriers','freight_modes','ports','payment_terms',
    'preferential_agreements','hsn_table','labor_rates','app_settings',
    'invoices','invoice_lots','invoice_pieces','invoice_diamonds','invoice_stones',
    'invoice_piece_tuning','gold_purchases','gold_drawdowns','stones_register','audit_log'
  ] loop
    execute format('drop policy if exists %I on %I', 'read_auth_'||t, t);
    execute format('create policy %I on %I for select to authenticated using (true)',
                   'read_auth_'||t, t);
    execute format('drop policy if exists %I on %I', 'write_accounts_'||t, t);
    execute format(
      'create policy %I on %I for all to authenticated '
      'using (auth_role() in (''accounts'',''admin'')) '
      'with check (auth_role() in (''accounts'',''admin''))',
      'write_accounts_'||t, t);
  end loop;
end$$;

-- ───────────────────────── seed data (from samples) ─────────────────────────

insert into buyers (display_index, name, address, city, country, default_terms, default_preferential_agreement) values
  (1, 'WORLD SHINER PTY LTD', 'Suite 301, Level 3, The Cullinan Building, 70 Castlereagh Street, Sydney, NSW 2000, Australia', 'SYDNEY', 'AUSTRALIA', '150 Days DA', 'ECTA-AU'),
  (2, 'ISHA TRADING PTY LTD', 'Suite 502, Level 5, Wales Corner Bldg, 227 Collins Street, Melbourne 3000, Victoria, Australia (ABN No. 49096379547)', 'MELBOURNE', 'AUSTRALIA', '150 Days DA', 'ECTA-AU'),
  (3, 'WORLD SHINER PTY LTD', 'Unit 17, Level 11, 138 Albert Street, Brisbane, QLD 4000, Australia', 'BRISBANE', 'AUSTRALIA', '150 Days DA', 'ECTA-AU'),
  (4, 'WORLD SHINER NZ LTD', 'Suite 4K, 4th Floor, 47 High Street, Auckland 1010, New Zealand, Tel : +64 9 358 3443', 'AUCKLAND', 'NEW ZEALAND', '150 Days DA', NULL),
  (5, 'WORLD SHINER (UK) LTD', 'Suite 9, 2nd Floor, Monument House, 215 Marsh Road, Pinner, Middlesex, HA5 5NE, United Kingdom', 'LONDON', 'UNITED KINGDOM', '150 Days DA', NULL),
  (6, 'WORLD SHINER ITALIA S.R.L.', 'Via Camilo Cavour 108, 50121 Firenze, Italy', 'FIRENZE', 'ITALY', '150 Days DA', NULL),
  (7, 'DIAMANTRA, INC. (AUSTIN)', '3303 Northland Drive, #203 Austin, TX 78731, USA, Tel : +1 (512) 535-5333', 'AUSTIN', 'USA', '150 Days DA', NULL)
on conflict do nothing;

insert into banks (display_index, name, ad_code, account_no, swift, ifsc) values
  (1, 'INDUSIND BANK LTD', '6380002-600009', '200999949087', 'INDBINBB', 'INDB0000018'),
  (2, 'ICICI BANK LTD',    '6391864-2910009', '121705005648', 'ICICINBBCTS', 'ICIC0001217')
on conflict do nothing;

insert into freight_carriers (name) values ('SEQUEL'),('FEDEX'),('DHL'),('ARAMEX'),('SELF') on conflict do nothing;
insert into freight_modes (name) values ('BY AIR FREIGHT'),('BY SEA'),('BY COURIER'),('BY HAND') on conflict do nothing;
insert into ports (name, country) values ('MUMBAI / INDIA','INDIA'),('DELHI / INDIA','INDIA'),('CHENNAI / INDIA','INDIA'),('BANGALORE / INDIA','INDIA') on conflict do nothing;
insert into payment_terms (name) values ('150 Days DA'),('90 Days DA'),('60 Days DA'),('LC at Sight'),('TT in advance'),('30 Days DA') on conflict do nothing;
insert into preferential_agreements (code, description) values
  ('ECTA-AU','India-Australia ECTA'),
  ('UKFTA','India-UK FTA'),
  ('AANZFTA','ASEAN-Australia-NZ FTA'),
  ('NCPTI','Not applicable / National — confirm'),
  ('EU-GSP','EU GSP'),
  ('','(none)')
on conflict do nothing;

insert into hsn_table (jewellery_type, code, description_tail, max_wastage_handcrafted, min_value_addition) values
  ('gold_plain',                 '71131911', 'JEWELLERY PLAIN',                                       0.0225, 0.035),
  ('gold_mounting',               '71131911', 'MOUNTING',                                             0.0200, 0.025),
  ('gold_studded_diamond',        '71131913', 'JEWELLERY STUDDED WITH DIAMONDS',                      0.0400, 0.070),
  ('gold_studded_lgd',            '71131914', 'JEWELLERY STUDDED WITH LAB GROWN DIAMONDS',            0.0400, 0.070),
  ('gold_studded_colorstone',     '71131915', 'JEWELLERY STUDDED WITH PRECIOUS & SEMI PRECIOUS STONE',0.0400, 0.060)
on conflict (jewellery_type) do nothing;

insert into labor_rates (kt, rate_inr_per_gm, "current") values
  ('9', 1275, true), ('14', 1275, true), ('18', 1275, true), ('18-PD', 2000, true)
on conflict do nothing;

insert into app_settings (
  id, exporter_name, exporter_address, iec_no, pan, gstin,
  state_code, state_name, district_code, district_name,
  signatory_block_1, signatory_block_2, signatory_name,
  lut_arn_number, lut_arn_date, insurance_wording,
  payment_instructions, declarations
) values (
  1,
  'M/S. DIACROWN',
  'DE-7010, Bharat Diamond Bourse, Bandra Kurla Complex, Bandra East, Mumbai-400051, Mumbai, Maharashtra, India',
  '0390030252', 'AACFD9509R', '27AACFD9509R1ZS',
  27, 'MAHARASHTRA', 483, 'MUMBAI SUBURBAN',
  'FOR DIACROWN', 'PARTNER', 'ANAND M. JHAVERI',
  'AD270326095695I', '2026-03-27',
  'INSURANCE COVERED DOOR TO DOOR BY - SEQUEL',
  '["Correspondent Bank: The Bank of New York (New York United States)","SWIFT: IRVTUS3N","For Credit To A/c No: 8900444096","CYBER CRIME ALERT: You must reconfirm any changes in payment instructions by phone before transmission."]'::jsonb,
  '["Based on personal knowledge and / or written guarantees provided by the supplier of these goods, the seller of these goods hereby guarantees that these diamonds and / or diamond jewellery and / or coloured gemstones:","are exclusively of natural origin, labgrown and are untreated unless otherwise noted.","have been purchased from legitimate sources not involved in funding conflict and in compliance with the United Nations Resolutions.","have not been obtained in violation of applicable National or International laws.","have not originated from, manufactured in or transited through sanctioned countries.","have not originated from the MBDA / Marange Resources or related entities.","We certify that the particulars above are true and correct to the best of our knowledge and belief.","No E way bill is required to be generated as the goods are exempted.","We shall not file any claim against this invoice under the Foreign Trade Policy / RoDTEP scheme."]'::jsonb
) on conflict (id) do nothing;
