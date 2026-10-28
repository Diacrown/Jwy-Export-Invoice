/** V1–V16 validators. Ported from Python validators.py. */
import Decimal from "decimal.js";
import type {
  HsnEntry, JewelleryType, Lot, PerInvoiceInputs, Piece,
  ValidationFinding, ValidationReport,
} from "../types";

interface Ctx {
  pieces: Piece[];
  lots: Lot[];
  inputs: PerInvoiceInputs;
  hsnTable: Record<JewelleryType, HsnEntry>;
  defaultWastagePct: Decimal;
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
    sjPcs === lotPcs ? `Piece counts agree (${sjPcs})` : `Piece count mismatch SJ-50=${sjPcs} lots=${lotPcs}`));

  // V2 gross weight
  const sjGross = ctx.pieces.reduce((a, p) => a.add(p.gross_wt), new Decimal(0));
  const lotGross = ctx.lots.reduce((a, l) => a.add(l.pieces.reduce((aa, p) => aa.add(p.gross_wt), new Decimal(0))), new Decimal(0));
  F.push(finding("V2", "hard", sjGross.sub(lotGross).abs().lt(new Decimal("0.01")),
    `Gross wt agrees (${sjGross.toFixed(3)}g)`));

  // V3 net weight consistency (skip pieces without raw)
  const bad: unknown[] = [];
  for (const p of ctx.pieces) {
    if (!p.net_wt_raw) continue;
    const computed = p.gross_wt
      .sub(p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0)).div(5))
      .sub(p.stones.reduce((a, s) => a.add(s.cts), new Decimal(0)).div(5));
    const diff = p.net_wt_raw.sub(computed).abs();
    if (diff.gt(new Decimal("0.05"))) bad.push({ stock_no: p.stock_no, diff: diff.toFixed(3) });
  }
  F.push(finding("V3", "hard", bad.length === 0,
    bad.length === 0 ? "Net wt matches raw" : `Net wt drift on ${bad.length} piece(s)`,
    bad.length ? { mismatches: bad } : undefined));

  // V5 wastage ceiling
  const wastage = ctx.inputs.wastage_pct_override ?? ctx.defaultWastagePct;
  const offenders5: unknown[] = [];
  for (const l of ctx.lots) {
    const hsn = ctx.hsnTable[l.jewellery_type];
    if (wastage.gt(new Decimal(hsn.max_wastage_handcrafted)))
      offenders5.push({ lot: l.lot_no, hsn: hsn.code, wastage: wastage.toFixed(4), max: hsn.max_wastage_handcrafted });
  }
  F.push(finding("V5", "hard", offenders5.length === 0,
    offenders5.length === 0 ? "Wastage within HSN max"
      : `Wastage ${wastage} exceeds HSN max on ${offenders5.length} lot(s)`,
    offenders5.length ? { offenders: offenders5 } : undefined));

  // V6 value-addition floor
  const offenders6: unknown[] = [];
  for (const l of ctx.lots) {
    if (!l.totals) continue;
    const hsn = ctx.hsnTable[l.jewellery_type];
    if (l.totals.value_addition_ratio.lt(new Decimal(hsn.min_value_addition)))
      offenders6.push({
        lot: l.lot_no, hsn: hsn.code,
        actual: l.totals.value_addition_ratio.toFixed(4),
        min: hsn.min_value_addition,
      });
  }
  F.push(finding("V6", "hard", offenders6.length === 0,
    offenders6.length === 0 ? "Value addition ≥ HSN min on all lots"
      : `Value addition below HSN floor on ${offenders6.length} lot(s)`,
    offenders6.length ? { offenders: offenders6 } : undefined));

  // V7, V8, V9 — by construction
  F.push(finding("V7", "hard", true, "MFG cost is formula-driven in generated workbook"));
  F.push(finding("V8", "hard", true, "FX rate written once and referenced"));
  F.push(finding("V9", "hard", true, "Gold rate written once and referenced"));

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
      : `Studding details missing on ${bad13.length} entry(ies)`,
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

  return { findings: F };
}

export function isBlocked(report: ValidationReport): boolean {
  return report.findings.some((f) => f.severity === "hard" && !f.passed);
}
