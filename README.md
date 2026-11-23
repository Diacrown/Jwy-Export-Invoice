# JWY Export Invoice — Web app

Browser-side invoice generator. React + Vite + TypeScript on the frontend,
Supabase (Postgres + Storage + Auth) for data and file persistence, deployed
to Netlify.

```
┌─────────────────────┐    ┌─────────────────────┐
│  React/Vite UI      │◄──►│  Supabase            │
│  on Netlify         │    │   • Postgres (data)  │
│                     │    │   • Storage (files)  │
│  SheetJS reads .xls │    │   • Auth             │
│  ExcelJS writes     │    │                      │
│  the master-details │    │  Row-level security  │
│  xlsx in-browser    │    │  enforced per role   │
└─────────────────────┘    └─────────────────────┘
```

All the business logic (parser, calculations, grouping, validators,
xlsx generator) runs client-side in TypeScript, so there's no backend
to run and no serverless functions needed. Supabase is only used for
data persistence, file storage, and auth.

## Setup

**1. Supabase project**

Create a new Supabase project. In the SQL editor, paste and run
`supabase/schema.sql`, then every file in `supabase/migrations/` in date
order (existing projects: just the migrations not yet run). It creates every table, enables row-level
security, and seeds the lookup tables (buyers, banks, HSN, etc.) from
the sample invoice data.

Then in the Supabase Storage tab, create three **private** buckets:
`raw-sj50`, `vendor-sdjjb`, `generated-invoices`.

Finally, in Authentication → Users, create your clerk's account and
set `app_metadata.role = "accounts"` on them. Only users with that role
or `"admin"` can write.

**2. Local dev**

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

Open http://127.0.0.1:5173.

**3. Deploy to Netlify**

- Push to a Git repo.
- Create a Netlify site from that repo, build command `npm run build`,
  publish dir `dist`.
- Add the four `VITE_*` env vars in Netlify → Site settings → Env.
- `netlify.toml` sets SPA redirects and security headers.

## Input file

Upload the `SDJ-JB-<nnn> # 26-27 # DCJ # Dt-<date>.xls` file from Swan. The
module reads **only its "Packing List" sheet** (sheet 2); the tax-invoice
sheet is ignored. Older `SJ-50 … pcs.xls` packing lists also work. Anything
the sheet does not carry (certificates, grades, USD/ct, buyer, bank, gold
rate, exchange rates, package weight) is entered in the app.

## Overridable dropdown fields

Each dropdown reads from its own lookup table and has an "Add new…"
option that inserts a row and immediately picks it. The tables that
feed dropdowns:

| Dropdown | Lookup table |
|---|---|
| Buyer | `buyers` |
| Bank | `banks` |
| Pre-carriage | `freight_carriers` |
| Flight mode | `freight_modes` |
| Port of Loading | `ports` |
| Payment terms | `payment_terms` |
| Preferential agreement | `preferential_agreements` |
| Per-lot jewellery type | `hsn_table` (enum of 5 classifications) |

Per-piece diamond cert, grade and rate are typed in the pieces grid;
the module stores every entry in `stones_register` keyed by cert
number so the second time a cert shows up, the fields prefill.

## Data persistence

Every invoice generation writes:

1. The uploaded raw SJ-50 file to `raw-sj50/<invoice_id>/<name>`
2. The uploaded SDJ-JB file (if any) to `vendor-sdjjb/<invoice_id>/<name>`
3. The generated `.xlsx` to `generated-invoices/<invoice_id>/<name>`
4. A row in `invoices` with totals, lot rollups, piece rows, diamonds,
   stones, and references to all three files
5. A gold-drawdown line against the matching `gold_purchases` row
6. An entry in `audit_log` with who generated it + when

The dashboard lists every invoice with a filter by date, buyer, status.
Clicking an invoice shows the lots + validation findings + download links
for the three files.

## Project layout

```
web/
├── index.html
├── package.json, tsconfig.json, vite.config.ts
├── netlify.toml, .env.example
├── supabase/schema.sql
└── src/
    ├── main.tsx, App.tsx
    ├── supabase.ts                   client singleton
    ├── types.ts                      domain types
    ├── parsers/{sj50,sdjjb}.ts       SheetJS-based
    ├── lib/{mappings,calculations,grouping,validators}.ts   pure TS
    ├── generators/xlsx.ts            ExcelJS
    ├── storage/                      Supabase CRUD wrappers
    ├── hooks/                        React data hooks
    ├── components/                   UI
    └── styles/                       VS-Code-light theme
```

v0.1 goals: everything from the Python module (`../module/`) ported to
TypeScript, running in the browser, with the Supabase persistence layer
and overridable dropdowns.

## Tests and the local diff tool

```bash
npm test          # rebuilds EXP535 / EXP546 / EXP615 from the raw files and checks them to the cent
# newer samples still in Downloads?  JWY_EXTRA_SAMPLES_DIR="C:/Users/<you>/Downloads" npm test
npm run local-run -- "../Raw Data Sheet From Jwy/SJ-50 # DCJ # 1.10.2026 # 10 pcs.xls" \
  "../Raw Data Sheet From Jwy/SDJ-JB-045 # 26-27 # DCJ # Dt-30.09.2026.xls" \
  --ref "../Previous Export Invoices Reference/INVOICE NO. EXP535-2026-27 (B-JEW) MASTER DETAILS.xls" \
  --ref-gross --fx 95.35 --labour-fx 95.1 --inv EXP535/2026-27 --date 2026-10-01
```

The sample files are business data and live outside the repo (default: the
repo's parent folder; override with `JWY_SAMPLES_DIR`). Tests skip when they
are absent. `--ref` copies the hand-typed studding details from a manual
workbook and prints a per-piece diff (gross, net, AR, AK) plus the grand
total delta.
