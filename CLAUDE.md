# CLAUDE.md — context for Claude Code

This file is auto-loaded by Claude Code on every session in this repo. It
is the single place to catch up on what the project is, where it stands,
and what to do next. Read it start to finish before touching code.

## What this project is

A browser-based generator for DIACROWN's jewellery export invoices. It
replaces the Accounts team's current manual process of hand-typing the
`EXP*/<FY> MASTER DETAILS.xlsx` workbook from three source files each
time a shipment leaves India:

1. **SJ-50** — per-shipment packing list from the Jewellery Department.
2. **SDJ-JB** — vendor tax invoice from Swan Diamond Jewellery LLP
   (labour rate per KT).
3. **Diamond India** gold purchase invoice (gold rate, purity).

The generated workbook has two sheets — `INVOICE` (ships with the
parcel) and `CUSTOMS PL` (packing list + value-addition worksheet).

**Non-goals.** Not an ERP replacement. Not a redesign of the invoice
layout. **Byte-for-byte compatibility with the manual workbook is a hard
requirement** — the shipping-bill process reads specific cells.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript, deployed to Netlify |
| Data | Supabase Postgres with row-level security |
| Files | Supabase Storage — three private buckets (`raw-sj50`, `vendor-sdjjb`, `generated-invoices`) |
| Auth | Supabase Auth; write access gated on `app_metadata.role in ("accounts","admin")` |
| xlsx I/O | SheetJS (`xlsx@0.18.5`) for reading, ExcelJS for writing — both run in the browser |
| Money | `decimal.js` throughout; Excel cell conversion only at the boundary |
| No backend | all business logic is in-browser; Netlify just serves static assets |

## Where to find what

```
src/
  types.ts                   domain types (Piece, Lot, LotTotals, inputs)
  lib/
    mappings.ts              SJ-50 → invoice value lookups (KT, colour, category)
    calculations.ts          all §5 formulas, numbered to match docs/01-*.md
    grouping.ts              pieces → lots by (KT, Color, JewelleryType)
    validators.ts            V1–V16 as pure functions
  parsers/
    sj50.ts                  SheetJS SJ-50 reader with shape auto-detection
    sdjjb.ts                 SDJ-JB vendor-invoice reader (labour rate)
  generators/
    xlsx.ts                  ExcelJS workbook writer — biggest known gap lives here
  storage/
    settings.ts              loads app_settings, hsn_table, labor_rates
    lookups.ts               generic dropdown lookup CRUD
    invoices.ts              persists invoices + lots + pieces + diamonds + audit
  components/
    App.tsx (one file up)    top-level shell + 6 tabs
    Dashboard.tsx            past-invoice list with filter/download/void
    Dropdown.tsx             overridable dropdown with inline Add-new
    Toast.tsx, Skeleton.tsx  UX primitives
  styles/index.css           VS-Code-light theme, mobile card-stack tables
supabase/schema.sql          20 tables + RLS + seeded lookups — paste into SQL editor
docs/
  01-workflow-analysis.md    business problem, formulas, HSN rules
  02-gaps-and-build-spec.md  what's decided, what's open
  03-handoff-2026-11-23.md   the latest handoff brief (read this second)
scripts/local-run.ts         node runner: parse → group → compute → write xlsx locally
.env.example                 the two Supabase keys to fill in locally
netlify.toml                 build + security headers
```

## Current state (as of 2026-11-23)

**Live on Netlify.** The user (handle `diacrown`, company DIACROWN) has:
- Supabase project provisioned, `schema.sql` run, three private buckets
  created with the "accounts write" RLS policy on `storage.objects`.
- At least one auth user set up with `raw_app_meta_data.role = "accounts"`.
- Netlify site connected to `main` branch of this repo.
- Login works end-to-end.

**Last known step.** User was about to run their first real SJ-50 through
the deployed app to produce a diff against the manual workbook. We
shipped commit `df36899` to make that run smoother:
- Parser now gives a clear error if the user drops the gold ledger or an
  SDJ-JB vendor invoice in the SJ-50 slot.
- Pieces grid has two new inputs per piece: **Base lock USD (AR)** and
  **Addon USD (AZ)** — needed to match the manual workbook's value
  addition %.

## Open blockers (ordered by impact)

1. **Byte-match with the manual workbook.** Our generator's output is
   functionally correct (right totals, lots, formulas) but structurally
   thinner than the real `EXP570 B-JEW MASTER DETAILS.xlsx`: the real
   file has ~760 rows and lookup `IF` chains off a staging area at
   columns Q:AE, ours has ~176 rows with literal values. Until a real
   diff is in hand, this is the top-priority task.
2. **AR base-gold-lock values.** Now editable per piece, but the clerk
   has to type them. If the user confirms how AR is chosen in the
   manual workbook (prior-quote carryover, tuned for VA%, ERP lookup),
   we can derive it.
3. **Preferential agreement rules** for NZ / UK / USA / EU — currently
   seeded as blanks in `preferential_agreements`. Confirm with Accounts.
4. **Settings UI** doesn't exist yet. For now, edit `app_settings`,
   `hsn_table`, `labor_rates` directly in the Supabase Table Editor.
5. **Diamond details** per piece are still typed manually. The
   `stones_register` table auto-fills on repeat certificates (code is
   written in `storage/invoices.ts`), so this gets better over time.

## What's done, what works

| Area | Status |
|---|---|
| Tech stack | ✅ production-grade |
| Code structure | ✅ pure functions in `lib/`, DOM-free; Supabase isolated in `storage/` |
| Database schema | ✅ 20 tables, enums, FKs, indexes, RLS on every table, seeded lookups, audit log |
| Security | ✅ RLS gated on role, bcrypt via Supabase Auth, file MIME + size validation, formula-injection guard, CSP in `netlify.toml` |
| Business logic | ✅ full parser + mappings + calc + V1–V16 validators, matches Python prototype 1:1 |
| UI shell | ✅ 6-tab flow (Dashboard, Upload, Pieces, Per-invoice, Review, Generate) with toasts, loading skeletons, inline validation, keyboard shortcuts |
| Mobile | ✅ tables collapse to card stacks below 640px, 44px touch targets, scrollable tab bar |
| Dashboard | ✅ past-invoice list with filter by text/status/country, download, void |
| Byte-match | ⚠️ partial — see blocker #1 |

## What to do next (priority order)

1. **`npm install && npm run local-run <path-to-sj50.xls>`** on a real
   SJ-50 (from `C:\External Projects\Jwy Export Invoices\Raw Data Sheet
   From Jwy\`). Writes `generated-by-ts.xlsx` next to the input.
2. **Open the generated file beside the matching manual workbook**
   (`C:\External Projects\Jwy Export Invoices\Previous Export Invoices
   Reference\`). List the top 5–10 cell-level differences.
3. **Iterate `src/generators/xlsx.ts`** against that list. The real
   workbook uses `=IF(Q11=1,S11,"")&IF(Q11=2,S12,"")…` chains for the
   buyer/consignee/bank blocks — that's the structural gap. One option
   is to switch to a template-fill approach: load a cleaned copy of the
   sample workbook, keep the staging area intact, only overwrite data
   cells. This trades flexibility for byte-match fidelity.
4. **Run one invoice through the deployed app** end-to-end: upload,
   fill AR values per piece, generate. Confirm it saves to Supabase
   (`invoices` table + `generated-invoices` bucket) and appears in
   Dashboard.
5. **Then**: add a Settings tab for in-UI editing of `app_settings`,
   `hsn_table`, `labor_rates`; dashboard CSV export; stones-register
   autofill in the Pieces grid.

## Conventions

- Pure functions in `src/lib/*.ts`, DOM-free.
- Supabase calls live only in `src/storage/*.ts`.
- UI components in `src/components/*.tsx`.
- Money and weights are `decimal.js` — only convert to `number` at the
  Excel cell boundary.
- Toasts (`useToast`) for user-facing errors; never `alert()`.
- RLS policies gate writes. Do not bypass with the service-role key in
  the client — that key never leaves Supabase.
- Mobile-first: new tables use the `.table-wrap.cards` pattern with
  `data-label` attributes on every `<td>`.
- Keyboard shortcut: Ctrl/Cmd+Enter advances the current tab.

## Running locally

```bash
npm install
cp .env.example .env     # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev              # http://127.0.0.1:5173
npm run build            # production bundle
npm run local-run <path-to-sj50.xls>   # smoke test the pipeline on disk
```

## Supabase credentials to get

1. Supabase dashboard → Project Settings → API
2. Copy **Project URL** and **anon public** key
3. Paste into `.env`:
   ```
   VITE_SUPABASE_URL=https://xxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```
4. Never copy the `service_role` key.

## Deploy pipeline

- `main` → Netlify autodeploys.
- Env vars live in Netlify → Site settings → Environment variables:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_BUCKET_RAW_SJ50`, `VITE_BUCKET_VENDOR_SDJJB`,
  `VITE_BUCKET_GENERATED`.
- `netlify.toml` sets SPA fallback + CSP.

## Testing against real data

Sample files live on the user's PC at:

```
C:\External Projects\Jwy Export Invoices\
├── Raw Data Sheet From Jwy\              SJ-50 per-shipment files
├── Previous Export Invoices Reference\   real master-details workbooks
└── HSN Code, Wastage and value addition Norms.pdf
```

Also attached to the related claude.ai Project ("Jwy Export Invoices") —
19 files including 9 sample invoices across markets S / B / UK.

## Pointers to deeper docs

- Business workflow + formulas → `docs/01-workflow-analysis.md`
- Gap matrix + path choices → `docs/02-gaps-and-build-spec.md`
- This session's handoff → `docs/03-handoff-2026-11-23.md`
- Supabase docs: https://supabase.com/docs/reference/javascript
- ExcelJS docs: https://github.com/exceljs/exceljs
- SheetJS docs: https://docs.sheetjs.com
