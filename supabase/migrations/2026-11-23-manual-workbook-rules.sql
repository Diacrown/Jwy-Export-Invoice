-- Migration 2026-11-23 — rules recovered from the manual MASTER DETAILS workbooks
--
-- Run once in the Supabase SQL editor on the live project (safe to re-run).
-- Fresh installs get the same shape from supabase/schema.sql.
--
-- What it adds / changes and why (evidence: EXP535, EXP546, EXP553, EXP570,
-- EXP573, EXP602 — every piece row reconciles to the cent):
--
--  1. app_settings.base_gold_lock_ratio + app_settings.kt_touch
--     The manual "AR" base-gold-lock cell is NOT hand-tuned. It is
--       round(SJ-50 net wt, 2) × touch[KT] × base rate
--     where touch = {9: 0.385, 14: 0.595, 18: 0.760} and the base rate (USD per
--     gram of pure gold) = invoice gold rate (USD/oz) × 0.0321199, 3 dp:
--     139.395 at 4339.8413 (EXP535–EXP573), 135.176 at 4208.4878 (EXP615).
--  2. banks.address — the INVOICE bank block prints the branch address.
--  3. hsn_table.description_tail — wording used on the real invoices.
--  4. invoices: labour FX (CUSTOMS PL!AU, can differ from the invoice FX),
--     freight / insurance / discount / commission, base-lock rate used.
--  5. invoice_pieces.semi_mount — "LGD SEMI" / "SEMI" remarks print as
--     "… SEMI-MOUNTING JEWELLERY …" and form their own lot.

-- 1 ─ settings
alter table app_settings
  add column if not exists base_gold_lock_ratio numeric(12,8) not null default 0.0321199,
  add column if not exists kt_touch jsonb not null
    default '{"9": 0.385, "14": 0.595, "18": 0.76, "22": 0.92}'::jsonb;

-- Seeded label defaults → the wording printed on the manual invoices
-- (only touched while still at the original seed value).
update app_settings set container_prefix = 'Container No.' where container_prefix = 'CONTAINER N0.';
update app_settings set tin_box_text = 'THREE INVOICES IN ONE TIN BOX(1)' where tin_box_text = 'THREE INVOICES IN 1 TIN BOX';

-- 2 ─ bank address
alter table banks add column if not exists address text not null default '';

update banks set address = 'C-2 West Core, Ground Floor, Tower-3, Bharat Diamond Bourse, Bandra Kurla Complex, Bandra East, Mumbai-400051, India'
 where name ilike 'INDUSIND%' and address = '';
update banks set address = 'Bharat Diamond Bourse, G Block Tower 5 E1, BKC, Bandra East, Mumbai-400051, India'
 where name ilike 'ICICI%' and address = '';

-- The manual workbooks print different IndusInd codes from the original seed:
--   SWIFT INDBINBBBOO (seed: INDBINBB) · IFSC INDB0000342 (seed: INDB0000018)
-- Confirm with Accounts, then uncomment:
-- update banks set swift = 'INDBINBBBOO', ifsc = 'INDB0000342' where name ilike 'INDUSIND%';

-- 3 ─ HSN wording as printed on EXP535 / EXP553 / EXP570
update hsn_table set description_tail = 'JEWELLERY STUDDED WITH LABGROWN DIAMONDS'
 where jewellery_type = 'gold_studded_lgd';
-- EXP615 (newest sample, 29.10.2026) prints "NATURAL DIAMONDS"; EXP535 printed "DIAMONDS".
update hsn_table set description_tail = 'JEWELLERY STUDDED WITH NATURAL DIAMONDS'
 where jewellery_type = 'gold_studded_diamond';
update hsn_table set description_tail = 'MOUNTING JEWELLERY'
 where jewellery_type = 'gold_mounting';
update hsn_table set description_tail = 'JEWELLERY STUDDED WITH SEMI PRECIOUS STONE'
 where jewellery_type = 'gold_studded_colorstone';

-- 4 ─ per-invoice inputs that were computed but never stored
alter table invoices
  add column if not exists labour_inr_usd_rate numeric(10,4),
  add column if not exists base_gold_rate_usd_per_gm numeric(12,4),
  add column if not exists freight_usd numeric(12,2) not null default 0,
  add column if not exists insurance_usd numeric(12,2) not null default 0,
  add column if not exists discount_usd numeric(12,2) not null default 0,
  add column if not exists commission_usd numeric(12,2) not null default 0,
  add column if not exists pre_carriage_text text,
  add column if not exists flight_mode_text text,
  add column if not exists port_of_loading_text text,
  add column if not exists terms_text text,
  add column if not exists preferential_agreement_text text;

-- 5 ─ semi-mount flag + base lock actually used
alter table invoice_pieces
  add column if not exists semi_mount boolean not null default false,
  -- new packing-list columns (SDJ-JB "Packing List" sheet / SJ-50 from 29.10.2026)
  add column if not exists region text,
  add column if not exists product_category text,
  add column if not exists labour_rate_inr_per_gm numeric(10,2);

alter table invoice_piece_tuning
  alter column base_gold_lock_usd type numeric(14,6);

-- Rate precision: manual rates carry up to 4 dp (95.04, 60.38, 196.8086)
alter table invoice_diamonds alter column rate_usd_per_ct type numeric(12,4);
alter table invoice_stones   alter column rate_usd_per_ct type numeric(12,4);
alter table stones_register  alter column last_rate_usd_per_ct type numeric(12,4);
