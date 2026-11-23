# CLAUDE.md — context for Claude Code

This file is auto-loaded by Claude Code on every session in this repo. It
is the single place to catch up on what the project is, where it stands,
and what to do next. Read it start to finish before touching code.

## What this project is

A browser-based generator for DIACROWN's jewellery export invoices. It
replaces the Accounts team's current manual process of hand-typing the
`EXP*/<FY> MASTER DETAILS.xlsx` workbook each time a shipment leaves India.

**Input (from Nov 2026): the `SDJ-JB-<nnn> … .xls` file from Swan Diamond
Jewellery LLP — only sheet 2, "Packing List".** Sheet 1 (Swan's tax invoice)
is ignored by this module. The packing list carries per piece: style, item,
KT, colour, qty, gross / net wt, studding pcs & carats per shape, colour
stones ("Col Stn"), **Labour ₹/g**, **Region** (M/B/S, display only) and a
product **Category** ("Lab Studded", "Semi-Mined", "Mount", "Gemstone Semi"…).
Older `SJ-50 DCJ … pcs.xls` files still parse (with or without Stock No.).

Typed by the clerk in the app: certificate / grade / USD-per-ct per studding
row (stones register autofills repeats), buyer, bank, gold rate + purity +
Diamond India invoice no., invoice and labour FX, package weight.

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
    App.tsx (one file up)    auth gate, invoice-wizard state + actions, view routing
    Shell.tsx                navy sidebar (top bar < 960px) + wizard Stepper
    ui.tsx                   Card, Field, Badge, Callout, Kpi, ActionBar, ConfirmDialog, fmt* helpers
    steps/                   Upload / Pieces / Details / Review / Generate step screens + form.ts (form state, validation)
    Dashboard.tsx            Invoices list: KPIs, search/status/country filters, download, void (dialog)
    Settings.tsx             app_settings / base-lock touch / HSN / labour-rate editor
    Dropdown.tsx             overridable dropdown with inline Add-new
    Toast.tsx, Skeleton.tsx  UX primitives
  styles/index.css           DIACROWN finance-console theme (tokens on :root), mobile card-stack tables
supabase/schema.sql          20 tables + RLS + seeded lookups — paste into SQL editor
docs/
  01-workflow-analysis.md    business problem, formulas, HSN rules
  02-gaps-and-build-spec.md  what's decided, what's open
  03-handoff-2026-11-23.md   the latest handoff brief (read this second)
scripts/local-run.ts         node runner: parse → compute → write xlsx, optional diff vs a manual workbook
tests/                       node:test suites + helpers that read the real sample workbooks
supabase/migrations/         run after schema.sql; 2026-11-23 adds the recovered business rules
.env.example                 the two Supabase keys to fill in locally
netlify.toml                 build + security headers
```

## Current state (as of 2026-11-23, branch `fix/manual-workbook-parity`)

**Live on Netlify** from `main` (login works). This branch closes the
blockers found when the pipeline was run against the real samples — see
"Business rules recovered" below. **Before deploying this branch, run
`supabase/migrations/2026-11-23-manual-workbook-rules.sql`** in the Supabase
SQL editor (the app keeps working without it, but Settings saves, the new
invoice columns and bank addresses need it).

Verified:
- `npm test` — 17 tests. Reconciled to the cent against three manual
  invoices: **EXP535** (C&F 9296.84), **EXP546**, and **EXP615** — the
  newest (29.10.2026), with AR derived from the gold rate and labour from the
  sheet, no hand values replayed. SDJ-JB-058's Packing List parses to 12
  pieces / 5 lots with sheet 1 ignored. Tests read samples from the parent
  folder (or `JWY_SAMPLES_DIR`) plus `JWY_EXTRA_SAMPLES_DIR` for files not
  yet filed there (SDJ-JB-058, SJ-50 29.10, EXP615 were in Downloads); each
  suite skips if its file is absent — sample data is never committed.
- Full UI flow run in a browser against a local mock of Supabase:
  upload → pieces (include/exclude, split rows, stones-register autofill) →
  form → review → generate → re-generate (replaces the earlier save).
- NOT yet run against the real Supabase project — local `.env` still holds
  the placeholder keys.

## Business rules recovered from the manual workbooks

| Rule | Evidence |
|---|---|
| **AR base-gold lock** = round(net wt, 2) × touch[KT] × base rate; touch 9K .385, 14K .595, 18K .760 | every AR in EXP535–EXP615 |
| **Base rate = gold rate (USD/oz) × 0.0321199**, 3 dp → 139.395 @ 4339.8413, 135.176 @ 4208.4878 | EXP535–573 and EXP615 (EXP602 kept 139.395 after the gold rate moved, so the form allows an override) |
| AR rounded to 2 dp on EXP570/573/602/615, full precision on EXP535/546/553 → form option, default rounded | EXP615 R0210 vs EXP535 B00718 |
| Gross weight printed at 2 dp on EXP535/EXP615, 3 dp on EXP570 → form option, default 2 dp | EXP615 5.808 → 5.81 |
| MFG (AK) = ROUND(P − AR + K × labour/FX + AZ, 2); AZ default $10 (EXP553/602 use 20/35/50 on some pieces) | AR→BA chain |
| Labour rate is **per piece** — read from the packing list's Labour column ("2000/gm"); Settings rate per KT only fills gaps | EXP535 lot 2, EXP615 |
| Type / semi-mount come from the product **Category** column when present, not Remarks | EXP615: B00724 remark "MINED SEMI" under "Mined Studded" → not semi; M00334 "Semi-Mined" → semi |
| Diamond lots print "…STUDDED WITH **NATURAL** DIAMONDS" (EXP615); EXP535 printed "…WITH DIAMONDS" — HSN tail is a Setting | EXP615 lots 2–4 |
| Region (M/B/S) is not the invoice split — EXP615 (B-JEW) holds M, B and S pieces | EXP615 lot 1 |
| Labour FX (CUSTOMS PL!AU) can differ from invoice FX | EXP535 95.10 vs 95.35; EXP546 95.25 vs 92.10 |
| Lots group by **(KT number, type, semi-mount)**; colours merge ("YELLOW & WHITE"); 18K-PD shares the 18K lot; palladium is not printed | EXP535 lot 2 |
| Wastage = min(4 %, HSN max) → mounting lots 2 % | EXP535 lot 3, EXP553 lot 2, EXP573 |
| Clerk may split one SJ-50 shape row by sieve size with different rates | EXP546 Round 54 pcs → 24/13/17 |
| Colour stones sit in the diamond columns with DIA DETAILS "SEMI-PRECIOUS STONE" | EXP570 lot 3 |
| One SJ-50 can feed two buyers' invoices; vendor packing lists add pieces | 05.10 → EXP546 + EXP553; B00718 from SDJ-JB-045 |

Manual-file inconsistencies the app deliberately does NOT copy: EXP535
rounded gross weights to 2 dp ($0.96 total effect — the SJ-50's own net-wt
column agrees with the 3-dp values); AR sometimes typed at 2 dp (enter as an
override); EXP546 INVOICE total is 0.3¢ off its own CUSTOMS PL; PAN/GST
labels swapped; C&F adds discount/commission instead of subtracting.

## Open items (need a business answer, not code)

1. **Confirm the IndusInd SWIFT/IFSC.** Manual workbooks print
   INDBINBBBOO / INDB0000342; the seed has INDBINBB / INDB0000018. The
   migration has a commented-out UPDATE — uncomment once Accounts confirms.
2. **Preferential agreement per destination** — samples use NCPTI and
   ECTA-AU for Australia and NCPTI for UK. Buyer defaults print when none is
   picked; confirm the rule for NZ / UK / USA / EU.
3. **Rounding** — the app defaults to the newest invoice (EXP615): gross
   2 dp, AR 2 dp. Both are form checkboxes; confirm with Accounts.
3b. **Base-lock rate** — default gold × 0.0321199 fits EXP535 and EXP615 but
   not EXP602. Ask Accounts how they pick it.
3c. **Precious stone + mined diamonds on one piece** (SDJ-JB-058 B00469-R,
   "Mined, Precious gemstone Studded") is classed as studded-with-diamonds
   (HSN 71131913); the ruby sits in the studding rows as PRECIOUS STONE.
4. **Diamond India purchase invoice format** — still no sample, so gold rate
   / purity / invoice no. are typed on the form.
5. **Byte-identical output is not achievable** (ExcelJS ≠ Excel, and the
   manual layout itself shifts with lot count). The generator reproduces the
   EXP535 layout, labels, header/lot-block cell addresses and the full
   formula chain; it omits the 700-row state/district list in AF:AL and uses
   a page break instead of a repeated page-2 header.

## What's done, what works

| Area | Status |
|---|---|
| Parser | ✅ SDJ-JB "Packing List" sheet only (sheet 1 ignored), SJ-50s with or without Stock No., Labour / Region / product Category / Col Stn columns, multiple blocks per sheet, multi-file merge, wrong-file detection |
| Business logic | ✅ rules above; reconciles to EXP535 and EXP546 |
| Generator | ✅ EXP535 layout: IF-chain buyer/bank staging (Q11/Q24), lot blocks, totals, A/C OF GOLD, PURCHASE DETAILS ledger, live CUSTOMS PL formulas incl. AR→BA |
| Validators | ✅ V1–V16 incl. V4 split totals, per-lot V5, V8 FX drift, V10, V12 gold balance, V16 config |
| UI | ✅ Finance-console design (navy sidebar, gold accent, Inter): 5-step wizard with stepper + sticky action bar showing running stats; drag-and-drop upload; Pieces with search, "Needs input" filter, progress, collapsible cards, stones-register autofill, split rows, AR/AZ tuning tucked away; Details in cards with live errors and an Advanced section; Review with status banner, KPIs, lot totals, readable checks; Generate with re-download; Invoices list with KPIs and void dialog; Settings in cards |
| Persistence | ✅ re-generate replaces the earlier save; gold purchase + drawdown ledger; stones register with times_seen; base lock used per piece |
| Tests | ✅ `npm test` (node:test via tsx) |

## What to do next (priority order)

1. Paste the real `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` into
   `.env`, run the migration, `npm run dev`, and generate one real invoice
   end-to-end against Supabase.
2. Get answers to the open items above.
3. `npm run local-run -- <sj50.xls> [more.xls] --ref <manual.xls>` on the
   next real shipment to diff before Accounts switches over.
4. Nice-to-have: dashboard CSV export; re-open a saved invoice for editing;
   code-split the 1.7 MB bundle (SheetJS + ExcelJS) with dynamic import.

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
- Keyboard shortcut: Ctrl/Cmd+Enter advances the current wizard step.
- Design: colours, radii and shadows are CSS tokens on `:root` in
  `styles/index.css` — use them, don't hard-code hex. Build screens from the
  `components/ui.tsx` primitives; icons come from `lucide-react` (no emoji).
  Inter is self-hosted via `@fontsource-variable/inter` (the CSP only allows
  `font-src 'self'`). Money/weights shown with `fmtUsd` / `fmtInr` / `fmtNum`
  (tabular figures).
- Any change to `src/lib/*` or the generator: run `npm test` (reconciles
  against the real EXP535 / EXP546 workbooks).
- `tsconfig.json` has `noEmit` — never let `tsc` write `.js` next to the
  sources: Vite resolves `.js` before `.tsx`, so stale compiled files
  silently shadow the real code (this happened once; `.gitignore` hid it).

## Running locally

```bash
npm install
cp .env.example .env     # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev              # http://127.0.0.1:5173
npm run build            # typecheck + production bundle
npm test                 # node:test suite (needs the sample folders next to the repo)
npm run typecheck        # app + scripts/tests
npm run local-run -- <sj50.xls> [more.xls] [--ref <manual.xls> --ref-gross] [--out file.xlsx]
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
