# JWY Export Invoice Module — Gaps & Build Spec

> Companion to the live document on claude.ai —
> this file is the plain-markdown copy for the repo.

A working document to decide where every field on the final export invoice
gets its value when the module runs.

## The ask — what the module does

A browser-based tool (React + Vite deployed to Netlify, data in Supabase)
that replaces the Accounts clerk's current workflow of hand-typing the
`EXP*/2026-27 MASTER DETAILS` workbook from the SJ-50 raw file + Diamond
India invoice + per-piece diamond knowledge. Instead:

1. Jewellery team hands over the SJ-50 `.xls` for the shipment, same format
   they already produce.
2. The clerk opens the module, picks a few per-invoice choices (buyer, bank,
   invoice no / date, preferential agreement) and types today's gold rate +
   FX.
3. For each piece, any diamond details not in SJ-50 are filled from a stones
   register the module keeps in Supabase (or from a prompt if the stone is
   new).
4. The module writes a `MASTER DETAILS.xlsx` identical to today's format —
   same `INVOICE` + `CUSTOMS PL` sheets, same formulas, same cell addresses —
   and downloads it. Raw file + generated file both land in Supabase Storage.
5. Before writing, the module runs the V1–V16 checklist and blocks on hard
   failures.

**Non-goals:** not an ERP replacement; not re-architecting the invoice
format; not changing the shipping-bill process. Byte-for-byte compatibility
with today's output is a hard requirement so customs filings see no change.

## What SJ-50 raw file already gives us

| SJ-50 column | What it is | Invoice field it populates |
| --- | --- | --- |
| `C` Stock No | Internal piece ID | kept for traceability (not on invoice) |
| `D` Category | `Cust RG`, `Cust PD`, `Cust BR`, `Cust EN`… | `CUSTOMS PL!E` Item |
| `F` Cust Style No | Buyer-facing style code | `CUSTOMS PL!D` Style # |
| `I` Gold Kt | `9K`, `9K UK`, `14K UK`, `18K`, `18K-PD` | `CUSTOMS PL!F` KT (normalized) |
| `J` Gold Col | `Y`, `W`, `Y-W`, `Y/W` | `CUSTOMS PL!G` Color |
| `L` Qty | Pieces | `CUSTOMS PL!H` Qty |
| `M` Gross Wt | Gross grams | `CUSTOMS PL!J` Gross Wt |
| `N` Net Wt | Gross − stones | overridden by computed `K = J - Σstones/5` |
| `O` Diamond Quality | short codes (`RD-50`, `EM-50`…) | hint for shape mapping |
| `P/R/T/V…` shape Pcs | Per-shape counts | `CUSTOMS PL!Q–W` shape pcs |
| `Q/S/U/W…` shape Wt | Per-shape carat weights | `CUSTOMS PL!AB` DIAM. CTS |
| `X` Remarks | `MINED`, `LGD`, `PLAIN`, `MOUNT`, `COLOR` | **drives HSN + lot grouping** |

From SDJ-JB we also get the **labor rate per gram per KT** (₹1,275 for 9K/14K/
18K, ₹2,000 for 18K-PD in samples).

From the SJ-50 cust-copy ledger we get the **running gold stock balance** per
KT for ledger reconciliation.

## Gaps to fill

For each field, decide one of: `extend SJ-50`, `settings file`, `stones
register`, `ask at run`, `vendor file`, `external file`, `ledger`, `derive`.

### A. External rate inputs

| Field | Example | Current source | Your decision | Default if blank |
| --- | --- | --- | --- | --- |
| Gold rate (USD / troy oz) — `INVOICE!E98` / `E167` | `4662.4965` | typed from Diamond India invoice | | `ask at run` |
| Gold purity — `INVOICE!F98` / `F167` | `0.999` | typed | | `ask at run`, default `0.999` |
| Gold purchase party | `DIAMOND INDIA LIMITED` | typed | | `settings file` |
| Gold purchase invoice no + date | `OX26100MUM879 DTD. 24.08.2026` | typed | | `ask at run` |
| INR→USD rate — `E114` / `E176` / `AU` | `95.25` | typed daily | | `ask at run` |

### B. Per-piece diamond / stone details (the biggest miss)

| Field | Example | Your decision | Default if blank |
| --- | --- | --- | --- |
| Diamond certificate lab + number — `CUSTOMS PL!X` | `IGI-LG825665739` | | `stones register` keyed by stock no |
| Diamond origin tag — `CUSTOMS PL!Y` | `LGD001-CVD`, `LGD002-HPHT`, `MINED` | | `derive` from SJ-50 `X` Remarks |
| Color-clarity grade — `CUSTOMS PL!AA` | `D-VVS1`, `WHITE-VS2` | | `stones register` or `ask at run` |
| Per-carat USD rate — `CUSTOMS PL!AC` | `86`, `60.38`, `560` | | `stones register` keyed by (lab, grade) |
| Coloured stone shape / pcs / cts / rate | — | | `extend SJ-50` + `stones register` |

### C. Per-invoice manual selections

| Field | Example | Current source | Default |
| --- | --- | --- | --- |
| Invoice number — `I6` | `EXP532/2026-27` | manual sequence | `ask at run`, suggest next from `ledger` |
| Invoice date — `K6` | `01.10.2026` | manual | `ask at run`, default today |
| Buyer index — `P12` | `1` = Shiner Sydney | manual, 10 choices | `ask at run` dropdown from `buyers` |
| Bank index — `P25` | `2` = ICICI | manual | `ask at run` dropdown from `banks` |
| Terms — `J21` | `150 Days DA` | manual, per buyer | `settings file` keyed by buyer |
| Pre-carriage — `B22` | `SEQUEL` | manual | `settings file`, default `SEQUEL` |
| Vessel / Flight — `B24` | `BY AIR FREIGHT` | manual | `settings file` |
| Container number — `B28` | `CONTAINER N0. 1` | standing | `derive` from lot count |
| Tin-box text — `D28` | `THREE INVOICES IN 1 TIN BOX` | manual | `ask at run` |
| Package gross wt kg — `F44` / `H118` | `1.68` | physical weighing | `ask at run` |
| Preferential agreement — `G47` / `G121` | `NCPTI`, `ECTA-AU` | manual | `settings file` destination→agreement |
| LUT / ARN number & date — `J10` | `AD270326095695I DT. 27/03/2026` | standing, annual | `settings file` |

### D. Standing exporter block (one-time config)

Exporter name/address, IEC, PAN, GSTIN, state + district codes, signatory
block, payment-instructions boilerplate, Kimberley-style declarations, buyers
list (10), banks list (10), insurance line — all live in the `app_settings`
singleton + lookup tables in Supabase.

### E. Tuning levers (value-addition control)

| Field | Example | Current source | Default |
| --- | --- | --- | --- |
| Wastage % per lot — `L11` | `0.04` | manual, HSN-capped | `settings file` per HSN; alert if > HSN max |
| Base-gold lock per piece — `AR` / `AQ` | `632.46`, `223.94` | hand-tuned per piece | **I don't know — need you to explain** |
| Fixed per-piece add-on — `AZ` | `$10` | standing (?) | `settings file`, default `10` |
| Labor rate INR/gm per KT — `AT` | `1275` (9K/14K/18K), `2000` (18K-PD) | from SDJ-JB | `vendor file` or `settings file` per KT |

### F. Cross-invoice state

- **EXP sequence** → `ledger` auto-increment per fiscal year.
- **Gold drawdown ledger** per Diamond India purchase → `ledger` persistent,
  auto-appends on each invoice.
- **Opening stock per purchase** → `ask at run` when a new purchase is
  registered.
- **Lot grouping rule** → need confirmation; current rule is `(KT, Color,
  JewelleryType)`.

## Mapping rules the module applies (derivations, not gaps)

**Category → Item name**

| SJ-50 `D` | Invoice `E` |
| --- | --- |
| `Cust RG` | `RING` |
| `Cust PD` | `PENDANT` |
| `Cust BR` | `BRACELET` |
| `Cust EN` | `EARRING` |
| `Cust NK` | `NECKLACE` |

**Gold Kt normalization**

| SJ-50 `I` | KT | Alloy note |
| --- | --- | --- |
| `9K`, `9K UK` | `9` | — |
| `14K`, `14K UK` | `14` | — |
| `18K` | `18` | — |
| `18K-PD` | `18` | `PALLADIUM` |

**Gold color**: `Y → YELLOW`, `W → WHITE`, `Y-W` / `Y/W → YELLOW/WHITE`, `R → ROSE`.

**Remarks → jewellery type → HSN**

| SJ-50 `X` | Description tail | HSN code |
| --- | --- | --- |
| `MINED` or diamond pcs > 0 with no `LGD` | `JEWELLERY STUDDED WITH DIAMONDS` | `71131913` |
| `LGD` | `JEWELLERY STUDDED WITH LAB GROWN DIAMONDS` | `71131914` |
| `COLOR` | `JEWELLERY STUDDED WITH PRECIOUS & SEMI PRECIOUS STONE` | `71131915` |
| `PLAIN`, `MOUNT` | `JEWELLERY PLAIN` / `MOUNTING` | `71131911` |

**Lot grouping (proposed):** group SJ-50 rows by `(KT, Color,
JewelleryType)`. All pieces sharing the tuple sit in one lot. Example on
EXP570 would produce 4 lots.

**Diamond shape columns**: auto-detect by header text (not column position) —
SJ-50 files are inconsistent.

**Net weight**: `K = J - Σdiamond_cts/5 - Σstone_cts/5`.

**Preferential agreement by destination (proposed):** Australia → `ECTA-AU`;
NZ → `AANZFTA` or `ECTA-NZ` (**confirm**); UK → `UKFTA` or blank
(**confirm**); USA → blank or `GSP` (**confirm**); EU → blank (**confirm**).

## Three paths forward — pick one

**Path 1 — Thin module (fastest).** SJ-50 + SDJ-JB + one-time settings +
run-time form. Clerk types diamond cert/grade/rate per piece. Covers 100% of
invoices from day one; still 15–20 min of per-piece typing per shipment.

**Path 2 — SJ-50 extended.** Add four columns to SJ-50 (Dia Cert, Dia Grade,
Dia Rate USD/ct, Stone Rate USD/ct); Jewellery team fills them. Zero
per-piece typing in Accounts.

**Path 3 — Stones register + settings DB (CHOSEN).** Browser-based with
Supabase persistent store that remembers every certificate seen before.
One-click gen for repeat pieces; the register fills itself in over a few
weeks. All lookup tables also feed overridable dropdowns.

**Recommendation**: Path 1 → Path 3 as foundation is set.

## Tech stack (final)

- **React 18 + Vite + TypeScript**, hosted on **Netlify**.
- **Supabase** for Postgres (data), Storage (files), Auth (users + roles).
- **SheetJS** for `.xls`/`.xlsx` reading, **ExcelJS** for writing.
- No backend — all business logic runs in the browser.
- RLS gates writes on `app_metadata.role` in (`accounts`, `admin`).

See `/supabase/schema.sql` for the full data model and `/README.md` for
deployment steps.

## Open questions blocking v0.2

1. **`AR` base-gold lock** — how is it chosen today? Prior-quote cost /
   hand-tuned to value-addition % / prior-invoice carryover?
2. **Diamond India purchase invoice format** — a sample would let the module
   read it directly.
3. **Preferential-agreement rules** — confirm NZ / UK / USA / EU values.
4. **SJ-50 Path 2 columns** — will the Jewellery team add the four columns?
