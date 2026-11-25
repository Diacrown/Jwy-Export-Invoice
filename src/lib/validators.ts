/** V1–V16 validators. Ported from Python validators.py, extended for the
 *  rules recovered from the manual workbooks. */
import Decimal from "decimal.js";
import type {
  AppSettings, HsnEntry, JewelleryType, Lot, PerInvoiceInputs, Piece,
  ValidationFinding, ValidationReport,
} from "../types";
import { ktNumber } from "./mappings";

interface Ctx {
  pieces: Piece[];
  lots: Lot[];
  inputs: PerInvoiceInputs;
  hsnTable: Record<JewelleryType, HsnEntry>;
  defaultWastagePct: Decimal;
  settings?: AppSettings;
  /** Optional SDJ-JB vendor invoice lines, for the V1 cross-check. */
  vendorPieceCount?: number | null;
  /** Remaining balance (g) of the gold purchase before this invoice. */
  goldBalanceBeforeGm?: Decimal | null;
  goldUsedGm?: Decimal | null;
}

function finding(
  code: string, severity: "hard" | "soft", passed: boolean,
  message: string, detail?: unknown,
): ValidationFinding {
  return { code, severity, passed, message, detail };
}

export function runAll(ctx: Ctx): ValidationReport {
  const F: ValidationFinding[] = [];

  // V1 piece count
  const sjPcs = ctx.pieces.reduce((a, p) => a + p.qty, 0);
  const lotPcs = ctx.lots.reduce((a, l) => a + l.pieces.reduce((aa, p) => aa + p.qty, 0), 0);
  F.push(finding("V1", "hard", sjPcs === lotPcs,
    sjPcs === lotPcs ? `Piece counts agree (${sjPcs})` : `Piece count mismatch selected=${sjPcs} lots=${lotPcs}`));
  if (ctx.vendorPieceCount != null) {
    const ok = ctx.vendorPieceCount === sjPcs;
    F.push(finding("V1b", "soft", ok,
      ok ? `SDJ-JB vendor invoice also has ${sjPcs} pieces`
        : `SDJ-JB vendor invoice has ${ctx.vendorPieceCount} pieces, this invoice has ${sjPcs} — check the vendor file matches the shipment`));
  }

  // V2 gross weight
  const sjGross = ctx.pieces.reduce((a, p) => a.add(p.gross_wt), new Decimal(0));
  const lotGross = ctx.lots.reduce((a, l) => a.add(l.pieces.reduce((aa, p) => aa.add(p.gross_wt), new Decimal(0))), new Decimal(0));
  const v2 = sjGross.sub(lotGross).abs().lt(new Decimal("0.01"));
  F.push(finding("V2", "hard", v2,
    v2 ? `Gross wt agrees (${sjGross.toFixed(3)}g)` : `Gross wt mismatch ${sjGross.toFixed(3)} vs ${lotGross.toFixed(3)}`));

  // V3 net weight consistency (skip pieces without raw)
  const bad: unknown[] = [];
  for (const p of ctx.pieces) {
    if (!p.net_wt_raw || p.net_wt_raw.eq(0)) continue;
    const computed = p.gross_wt
      .sub(p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0)).div(5))
      .sub(p.stones.reduce((a, s) => a.add(s.cts), new Decimal(0)).div(5));
    const diff = p.net_wt_raw.sub(computed).abs();
    if (diff.gt(new Decimal("0.05"))) bad.push({ stock_no: p.stock_no, diff: diff.toFixed(3) });
  }
  F.push(finding("V3", "hard", bad.length === 0,
    bad.length === 0 ? "Net wt matches raw" : `Net wt drift on ${bad.length} piece(s)`,
    bad.length ? { mismatches: bad } : undefined));

  // V4 studding totals still match the packing list after any sieve-size split
  const bad4: unknown[] = [];
  for (const p of ctx.pieces) {
    if (p.studding_raw_cts === undefined) continue;
    const cts = p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
    const pcs = p.diamonds.reduce((a, d) => a + d.pcs, 0);
    if (cts.sub(p.studding_raw_cts).abs().gt(new Decimal("0.02")) || pcs !== p.studding_raw_pcs)
      bad4.push({ stock_no: p.stock_no, pcs: `${pcs} vs ${p.studding_raw_pcs}`, cts: `${cts.toFixed(3)} vs ${p.studding_raw_cts.toFixed(3)}` });
  }
  F.push(finding("V4", "hard", bad4.length === 0,
    bad4.length === 0 ? "Studding pcs / carats match the packing list"
      : `Studding rows don't add up to the packing list on ${bad4.length} piece(s)`,
    bad4.length ? { mismatches: bad4 } : undefined));

  // V5 wastage ceiling (per lot — mounting lots carry 2 %, studded 4 %)
  const offenders5: unknown[] = [];
  for (const l of ctx.lots) {
    const hsn = ctx.hsnTable[l.jewellery_type];
    if (l.wastage_pct.gt(new Decimal(hsn.max_wastage_handcrafted)))
      offenders5.push({ lot: l.lot_no, hsn: hsn.code, wastage: l.wastage_pct.toFixed(4), max: hsn.max_wastage_handcrafted });
  }
  F.push(finding("V5", "hard", offenders5.length === 0,
    offenders5.length === 0 ? "Wastage within HSN max on every lot"
      : `Wastage exceeds HSN max on ${offenders5.length} lot(s)`,
    offenders5.length ? { offenders: offenders5 } : undefined));

  // V6 value-addition floor
  const offenders6: unknown[] = [];
  for (const l of ctx.lots) {
    if (!l.totals) continue;
    const hsn = ctx.hsnTable[l.jewellery_type];
    if (l.totals.value_addition_ratio.lt(new Decimal(hsn.min_value_addition)))
      offenders6.push({
        lot: l.lot_no, hsn: hsn.code,
        actual: l.totals.value_addition_ratio.mul(100).toFixed(2) + "%",
        min: (hsn.min_value_addition * 100).toFixed(2) + "%",
      });
  }
  F.push(finding("V6", "hard", offenders6.length === 0,
    offenders6.length === 0 ? "Value addition ≥ HSN min on all lots"
      : `Value addition below HSN floor on ${offenders6.length} lot(s)`,
    offenders6.length ? { offenders: offenders6 } : undefined));

  // V7 — by construction: AK = ROUND(BA,2) is written as a live formula
  F.push(finding("V7", "hard", true, "MFG cost is formula-driven in the generated workbook (AK = ROUND(BA, 2))"));

  // V8 FX — written once per role; warn when labour FX ≠ invoice FX (the manual workbooks drift)
  const fxSame = ctx.inputs.labour_inr_usd_rate.eq(ctx.inputs.inr_usd_rate);
  F.push(finding("V8", "soft", fxSame,
    fxSame ? "Labour FX equals invoice FX"
      : `Labour FX (${ctx.inputs.labour_inr_usd_rate}) differs from invoice FX (${ctx.inputs.inr_usd_rate}) — intended?`));
  F.push(finding("V9", "hard", true, "Gold rate written once and referenced"));

  // V10 preferential agreement chosen
  const pref = (ctx.inputs.preferential_agreement_override ?? ctx.inputs.preferential_agreement_text ?? "").trim();
  F.push(finding("V10", "soft", pref !== "",
    pref ? `Preferential agreement: ${pref}` : "No preferential agreement selected (samples use NCPTI or ECTA-AU)"));

  // V11 HSN vs description
  const bad11: unknown[] = [];
  for (const l of ctx.lots) {
    const hsn = ctx.hsnTable[l.jewellery_type];
    if (hsn.code !== l.hsn_code || !l.description.includes(hsn.description_tail))
      bad11.push({ lot: l.lot_no, expected: hsn.code, got: l.hsn_code });
  }
  F.push(finding("V11", "hard", bad11.length === 0,
    bad11.length === 0 ? "HSN matches description"
      : `HSN/description mismatch on ${bad11.length} lot(s)`,
    bad11.length ? { mismatches: bad11 } : undefined));

  // V12 gold drawdown balance
  if (ctx.goldBalanceBeforeGm != null && ctx.goldUsedGm != null) {
    const after = ctx.goldBalanceBeforeGm.sub(ctx.goldUsedGm);
    F.push(finding("V12", "soft", after.gte(0),
      after.gte(0) ? `Gold purchase balance after this invoice: ${after.toFixed(3)} g`
        : `Gold purchase over-drawn by ${after.abs().toFixed(3)} g`));
  }

  // V13 studding completeness
  const bad13: unknown[] = [];
  for (const p of ctx.pieces) {
    for (const d of p.diamonds) {
      if (d.pcs > 0 && (d.cts.eq(0) || !d.rate_usd_per_ct)) {
        bad13.push({ stock_no: p.stock_no, shape: d.shape, pcs: d.pcs, has_rate: !!d.rate_usd_per_ct });
      }
    }
  }
  F.push(finding("V13", "soft", bad13.length === 0,
    bad13.length === 0 ? "Studding complete"
      : `Studding rate missing on ${bad13.length} row(s) — their value counts as $0`,
    bad13.length ? { incomplete: bad13 } : undefined));

  // V14 certificate uniqueness
  const seen = new Map<string, string[]>();
  for (const p of ctx.pieces) {
    for (const d of p.diamonds) {
      if (d.certificate_no) {
        const list = seen.get(d.certificate_no) ?? [];
        list.push(p.stock_no);
        seen.set(d.certificate_no, list);
      }
    }
  }
  const dupes: Record<string, string[]> = {};
  for (const [c, stocks] of seen) if (stocks.length > 1) dupes[c] = stocks;
  F.push(finding("V14", "hard", Object.keys(dupes).length === 0,
    Object.keys(dupes).length === 0 ? "No duplicate certificates"
      : `${Object.keys(dupes).length} cert(s) used on >1 piece`,
    Object.keys(dupes).length ? { duplicates: dupes } : undefined));

  // V16 standing config present
  if (ctx.settings) {
    const s = ctx.settings;
    const missing = (["exporter_name", "exporter_address", "iec_no", "pan", "gstin", "lut_arn_number", "lut_arn_date"] as const)
      .filter((k) => !String(s[k] ?? "").trim());
    const kts = [...new Set(ctx.lots.map((l) => String(ktNumber(l.kt))))];
    const noTouch = kts.filter((k) => !(s.kt_touch?.[k] > 0));
    F.push(finding("V16", "hard", missing.length === 0,
      missing.length === 0 ? "Exporter settings present" : `Missing settings: ${missing.join(", ")}`));
    if (noTouch.length) {
      F.push(finding("V16b", "soft", false,
        `No base-lock touch factor for KT ${noTouch.join(", ")} — using KT/24. Add it in Settings → Base-gold lock.`));
    }
  }

  return { findings: F };
}

export function isBlocked(report: ValidationReport): boolean {
  return report.findings.some((f) => f.severity === "hard" && !f.passed);
}
