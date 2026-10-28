# JWY Export Invoice — Workflow Analysis

> Companion to the live document on claude.ai —
> this file is the plain-markdown copy for the repo.

## At a glance

Every export invoice (`EXP*/2026-27`) is one Excel workbook with two sheets —
**INVOICE** (final document shipped with the parcel) and **CUSTOMS PL** (packing
list + value-addition worksheet). The workbook pulls together three raw inputs:

1. The Jewellery Department's per-piece packing list — `SJ-50` / `SDJ-JB` files.
2. The local supplier's job-work tax invoice for making charges — `SDJ-JB-xxx`
   from Swan Diamond Jewellery LLP.
3. The gold-import purchase invoice from Diamond India Ltd (`OX26100MUM*`
   reference numbers).

Formulas inside the workbook compute per-piece gold value, wastage, studding
value, mfg cost, lot totals and the C&F invoice total in USD, with INR
equivalence at the bottom.

Across the 9 invoice workbooks sampled (EXP532, 535, 546, 553, 559, 570, 573,
602 — markets S / B / UK / B-no-JEW), the structure is identical. What varies
by invoice is the buyer selected from a reference list (rows R12:S21 on
INVOICE), the number of lots, and the HSN code / preferential-agreement row
filled on INVOICE based on destination country. Everything else is driven off
two hand-entered values: the **gold rate** (`E98` / `E167`) copied from the
Diamond India purchase invoice, and the **INR→USD exchange rate** (`E114` /
`E176`) at the bottom.

The workbook already works, but much of what looks automatic is actually a
chain of lookups into hand-typed cells. The automation opportunity is **not**
to replace the invoice format — it is to replace the hand-typing of each row
of CUSTOMS PL from the raw SJ-50 / SDJ-JB files, and to catch the four or five
classes of silent error documented in this doc.

## Process flow

```
┌─────────┐  ┌──────────┐  ┌──────────────┐           ┌───────────┐
│ SJ-50   │  │ SDJ-JB   │  │ Diamond India│   ─ ─ ─ ─│ HSN Norms │
│ (DCJ)   │  │ (vendor) │  │ (gold purch) │   dashed  │ (caps)    │
└────┬────┘  └────┬─────┘  └──────┬───────┘           └─────┬─────┘
     │           │                │                         │
     ▼           ▼                ▼                         │
    ┌──────────────────────────────────────┐                │
    │  CUSTOMS PL (Accounts formatted)     │                │
    │  packing list + value addition       │                │
    └──────────────────────────────────────┘                │
                      │                                     │
                      ▼                                     │
    ┌──────────────────────────────────────┐                │
    │  INVOICE sheet (final export doc)    │                │
    └──────────────────────────────────────┘                │
                      │                                     │
                      ▼                                     │
    ┌──────────────────────────────────────┐◄───────────────┘
    │  Validation gate (V1–V16)            │
    └──────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │ pass                   │ fail → fix & retry
          ▼                        │
    ┌──────────┐                   │
    │ Ship     │                   │
    └──────────┘                   │
                                   └───┐
                                       ▼ loops back to CUSTOMS PL
```

Only the arrows between the first row and `CUSTOMS PL` cross a human handoff —
everything below `CUSTOMS PL` is formula-driven inside one Excel workbook.
`HSN Norms` never flows IN as data; it only sets ceilings and floors the
Validation gate checks.

## Documents in play

| # | File pattern | Who issues it | What it is |
| --- | --- | --- | --- |
| 1 | `SJ-50  DCJ  <date>  <n> pcs.xls` | Jewellery Dept (DIACROWN) | Per-shipment **packing list** of pieces being exported, one row per piece. |
| 2 | `SDJ-JB-<nnn>  26-27  DCJ  Dt-<date>.xls` | Swan Diamond Jewellery LLP | **Vendor tax invoice** charging DIACROWN labor + wastage. HSN 998892, labor rate per gram per KT (seen: ₹1,275 for 9K/18K, ₹2,000 for 18K-PD). |
| 3 | `SJ-50  updated  <date>  cust copy.xls` | Jewellery Dept | **Running stock ledger** of raw gold inward/outward by KT. Used for reconciliation, not direct invoice input. |
| 4 | `INVOICE NO. EXP<nnn>-2026-27 <mkt>-JEW MASTER DETAILS.xlsx` | Accounts | **The invoice workbook itself.** Two sheets — `INVOICE` + `CUSTOMS PL`. |
| 5 | `HSN Code Wastage and value addition Norms.pdf` | Govt / Trade Harmonised System | Reference: max wastage % and min value-addition % per HSN code. |

Two observations:

1. Swan Diamond Jewellery LLP issues both the raw packing lists (SJ-50) and
   the tax invoices (SDJ-JB) — treat them as two artifacts of one job-work
   relationship, not two independent sources.
2. The letter after `EXP<nnn>-2026-27` encodes the destination (`S` = Sydney,
   `B` = Brisbane, `UK` = United Kingdom). The suffix `JEW` vs plain is **not**
   functional — appears to be a naming habit.

## Field-mapping table (abridged)

One row = one piece. Column refs are from EXP570 (B-JEW, 4 lots).

| Field | SJ-50 raw | SDJ-JB vendor | CUSTOMS PL | INVOICE | How it arrives |
| --- | --- | --- | --- | --- | --- |
| Stock No | `C` | — | not retained | not retained | Internal only |
| Style # | `F` (Cust Style No) | — | `D15, D29…` | packing-list body | Hand-copied |
| Item type | `D` (Category) | — | `E15` (RING…) | `B32, B51…` | Mapped: `Cust RG` → `RING` |
| Gold KT | `I` | `C18` description | `F15` | `D31, D51…` | Normalized |
| Gold Color | `J` | — | `G15` | lot description | Mapped |
| Qty | `L` | `E18` per KT | `H15` | `E31, E51…` | Should tie across all three |
| Gross Wt | `M` | `F18` per KT | `J15` | `I30` | Direct copy |
| Net Wt | `N` | `G18` per KT | `K15` = `J - Σ(dia+stone)/5` | `I33` | Computed |
| Diamond Pcs (by shape) | `P, R, T, V` (variable) | `H18` sum | `Q15, R15…` | `D39, D59…` | Hand-reshaped |
| Diamond Cts | `Q, S, U, W` | `H18` | `AB15` | `F39, F59…` | Summed per piece |
| Diamond color/quality | `O` (short codes) | — | `AA15` (full), `Y15`, `X15` | not shown | **Mostly hand-entered** |
| Dia rate USD/ct | — | — | `AC15` | derived | **Hand-entered per piece** |
| Wastage % | — | — | `L11` | `J34` | **Hand-entered**; must satisfy HSN max |
| Labor rate INR/gm | — | `J18` | `AT15` | implicit in MFG | **From SDJ-JB** |
| Gold rate | — | — | via `INVOICE!E167` | `E98` / `E167` | **Hand-entered from Diamond India** |
| INR→USD rate | — | — | `AU15` | `E114` / `E176` | **Hand-entered**; same value in two places |
| Fixed MFG add-on `AZ` | — | — | `AZ15` ($10) | folded into MFG | **Hand-entered constant** |
| Base-gold lock `AR` | — | — | `AQ15` | implicit | **Hand-entered.** Reverse-engineers MFG to hit value-addition % |
| Buyer | — | — | `E10` | `B12` via lookup `P12` | **Hand-selected index** 1–10 |
| HSN code | — | `D18` 998892 (vendor) | implicit | `G28` 71131913/14/15 | **Hand-entered** |

Five aggregates roll up on INVOICE: Cost of gold, MFG cost, Cost of studding,
Lot total, Grand total C&F.

## Calculation engine (formulas, in plain English)

1. **Net gold weight.** `K = J - Σdiamond_cts/5 - Σstone_cts/5`.
2. **Wastage weight.** `M = K × wastage_pct` (usually 4%).
3. **Net + wastage.** `N = K + M`.
4. **Per-gram USD rate.** `O = (E167 / 31.1035 / 24) × (KT / F167)`.
   > `E98` / `E167` is **USD per troy ounce of pure gold** (e.g. 4662.4965),
   > not INR per gram. The INR/USD rate is applied separately at the C&F total.
5. **Gold value per piece.** `P = N × O`.
6. **Diamond value.** `AD = AB × AC` summed over diamonds on the piece.
7. **Stone value.** `AJ = round(AI × AH, 2)` summed over stones.
8. **MFG cost per piece** — the reverse-engineered formula:
   - `AV = AT / AU` (labor rate USD/gm)
   - `AW = K × AV` (labor cost in USD)
   - `AS = P - AR` (residual gold value above a hand-locked base)
   - `AY = AS + AW`
   - `BA = AY + AZ` (final MFG cost incl. $10 fixed add-on)
9. **Total cost per piece.** `AL = P + AK + Σ(AD) + Σ(AJ)`.
10. **Lot aggregates** — plain SUMs over the pieces.
11. **Value-addition ratio per lot.** `AO = MFG / (gold + studding)`.
    Must satisfy the HSN minimum.
12. **C&F grand total.** `Σ lot totals + freight + insurance - discount - commission`.
13. **INR equivalent.** `C&F USD × INR/USD`.

## HSN compliance

| Category | HSN | Max wastage % | Min value-addition % (handcrafted) |
| --- | --- | --- | --- |
| Gold Mounting | 71131911 | 2.00% | 2.50% |
| Gold Jewellery Plain | 71131911 | 2.25% | 3.50% |
| Gold Jewellery Studded with Diamonds | 71131913 | 4.00% | 7.00% |
| Gold Jewellery Studded with Lab Grown Diamonds | 71131914 | 4.00% | 7.00% |
| Gold Jewellery Studded with Precious / Semi-Precious | 71131915 | 4.00% | 6.00% |

Worked examples from samples:

- **EXP570 Lot 1** (14K Y LGD): Gold $228.78, Studding $93.32, MFG $50.98 →
  value addition **15.83%** ✓ (≥ 7%).
- **EXP532** (18K Y Diamond): Gold $698.97, Studding $134.40, MFG $156.58 →
  value addition **18.79%** ✓ (≥ 7%).

## Where manual entry hides, and what can go wrong

1. **Hard-typed MFG cost that masquerades as a formula.** `AK15 = 50.98` is
   literally typed; if labor/FX/wastage changes, the AX/BA block re-computes
   but the displayed MFG does not.
2. **Base-gold lock `AR` is hand-entered.** Copy a wrong `AR` from a prior
   invoice and the value addition can breach the HSN floor silently.
3. **FX rate typed twice.** `AU15` and `E114` / `E176` are independent cells;
   update one and the other drifts.
4. **Gold rate typed twice.** `E98` and `E167` both hold a gold rate; EXP532
   even shows TWO different purchases.
5. **Buyer / bank is an index number.** `P12` 1–10 drives the entire buyer
   block through nested `IF` chains; a one-off typo swaps the entire buyer.
6. **HSN code typed per lot** — a mis-selection is a customs misdeclaration.
7. **Diamond certificate numbers, grade, rate** are all typed per piece —
   SJ-50 only has short codes like `RD-50`.
8. **SJ-50 shape columns vary file-to-file** — hardcoded column indices break.
9. **Stock number is not preserved** anywhere on the invoice.
10. **Date formats drift** across three files: `1-10-26` / `2026-09-21` /
    `01.10.2026`.
11. **Discount / freight / insurance always zero** in samples — confirm.

## Validation and reconciliation checks (V1–V16)

| # | Check | Severity |
| --- | --- | --- |
| V1 | Piece count agrees across SJ-50 / lots / SDJ-JB | **Hard** |
| V2 | Gross weight agrees | **Hard** |
| V3 | Net weight within 0.05g | **Hard** |
| V4 | Diamond carats within 0.02 ct | **Hard** |
| V5 | Wastage ≤ HSN max | **Hard** |
| V6 | Value addition ≥ HSN min | **Hard** |
| V7 | MFG cost formula-driven, not hand-typed | **Hard** |
| V8 | FX rate single-source | **Hard** |
| V9 | Gold rate single-source | **Hard** |
| V10 | Preferential agreement matches destination | **Soft** |
| V11 | HSN code consistent with description | **Hard** |
| V12 | Gold drawdown ledger balance ≥ 0 | **Soft** |
| V13 | Studding complete (cert, grade, rate present) | **Soft** |
| V14 | Certificate uniqueness within invoice | **Hard** |
| V15 | Amount-in-words matches grand total | **Soft** |
| V16 | Standing config present | **Hard** |

## Open questions (see `02-gaps-and-build-spec.md` for the latest status)

1. Who edits CUSTOMS PL today? Where exactly does the handoff happen?
2. Where do per-piece diamond details (cert, lab, grade, rate) come from?
3. What is the `AR` base-gold number? Prior-quote cost / tuned-for-VA /
   carryover?
4. What is the `AZ` $10 fixed add-on?
5. **Gold rate unit** — INR/gm or USD/troy oz? (Reconciled to **USD/troy oz**
   in later analysis; see spec doc.)
6. Full set of invoice-suffix letters.
7. EXP sequence allocation rule.
8. Preferential-agreement rule per destination.
9. Any destination-to-HSN defaults?
10. Is `LOCAL PURCHASE DETAILS` block the source of truth for gold drawdown?
11. Who issues the SDJ-JB vendor invoice first?
12. Volume — invoices per month?
13. Target end state — desktop EXE vs web app?

## Recommended automation shape

Five modules mirroring the business stages: Ingestors → CUSTOMS PL builder →
Formula renderer → INVOICE renderer → Validation checker. Preserve the current
workbook byte-for-byte; the module just produces it. Build the Checker first
to catch real errors in today's manual files before touching how Accounts
works.

See `02-gaps-and-build-spec.md` for the current implementation shape, which
replaces the earlier desktop Python module with a browser-side React + Vite +
Supabase app running on Netlify.
