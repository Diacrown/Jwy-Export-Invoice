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
`supabase/schema.sql`. It creates every table, enables row-level
security, and seeds the lookup tables (buyers, banks, HSN, etc.) from
the sample invoice data.

Then in the Supabase Storage tab, create three **private** buckets:
`raw-sj50`, `vendor-sdjjb`, `generated-invoices`.

Finally, in Authentication → Users, create your clerk's account and
set `app_metadata.role = "accounts"` on them. Only users with that role
or `"admin"` can write.

**2. Local dev**

```bash
cd web
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

## Local sanity test

Before deploying, you can run the full generator pipeline against a real
SJ-50 raw file to see what the output looks like:

```bash
npm install
npx tsx scripts/local-run.ts path/to/some-sj-50.xls
# writes generated-by-ts.xlsx next to the input
```

Open the generated xlsx side-by-side with a real master-details workbook
to see structural differences. The output is functionally correct
(right totals, right lots) but not yet byte-identical to the manual
workbook — iterate on `src/generators/xlsx.ts` based on what Accounts flags.
