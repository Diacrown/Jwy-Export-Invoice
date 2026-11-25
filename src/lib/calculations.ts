/** Pure-function invoice calculations, mirroring the manual CUSTOMS PL row.
 *
 * Column letters refer to CUSTOMS PL in the manual MASTER DETAILS workbooks
 * (EXP535 / EXP553 / EXP570 layout). Formula numbering matches the analysis
 * doc §5. Values are kept at full precision exactly like Excel; the only
 * rounding the manual workbook applies is AK (MFG cost, typed as
 * ROUND(BA, 2)) and AJ (stone value, ROUND(...,2)).
 *
 * Verified against EXP535: all 11 pieces' MFG cost and the C&F total
 * (9296.84) reproduce exactly — see tests/exp535.test.ts.
 */
import Decimal from "decimal.js";
import type { HsnEntry, Lot, LotTotals, Piece, PieceCalc } from "../types";
import { ktNumber } from "./mappings";

const GRAMS_PER_TROY_OZ = new Decimal("31.1035");
const PURE_GOLD_KT = new Decimal(24);
const FIVE = new Decimal(5);
const ZERO = new Decimal(0);

/** AR base-gold lock rate (USD per gram of pure gold) as a ratio of the invoice
 *  gold rate (USD/oz). 139.395 / 4339.8413 (EXP535–EXP573) = 135.176 / 4208.4878
 *  (EXP615) = 0.0321199 — i.e. ≈ gold ÷ 31.1035 × 0.99904. (EXP602 kept 139.395
 *  after the gold rate moved, so it is a default, not a law — the form lets the
 *  clerk override it per invoice.) */
export const DEFAULT_BASE_GOLD_LOCK_RATIO = 0.0321199;

/** Default base-lock rate for an invoice: gold rate × ratio, 3 dp. */
export function defaultBaseGoldRate(goldRateUsdPerOz: Decimal, ratio: number = DEFAULT_BASE_GOLD_LOCK_RATIO): Decimal {
  return goldRateUsdPerOz.mul(ratio).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}
/** Purity ("touch") per KT used for the AR base-gold lock. */
export const DEFAULT_KT_TOUCH: Record<string, number> = { "9": 0.385, "14": 0.595, "18": 0.76, "22": 0.92 };

export function q2(x: Decimal): Decimal {
  return x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
export function q4(x: Decimal): Decimal {
  return x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

const sum = <T>(xs: T[], f: (x: T) => Decimal) => xs.reduce((a, x) => a.add(f(x)), ZERO);

/** EXP535 and EXP615 (the newest sample) print gross weight at 2 dp
 *  (5.808 → 5.81) and compute net gold from that; EXP570 kept 3 dp. Returns
 *  copies so the parsed pieces stay untouched. */
export function withGrossRounded(pieces: Piece[], round2: boolean): Piece[] {
  return round2 ? pieces.map((p) => ({ ...p, gross_wt: q2(p.gross_wt) })) : pieces;
}

/** §5.1  K = J − Σdiamond_cts/5 − Σstone_cts/5. */
export function netWtGm(piece: Piece): Decimal {
  const diaCts = sum(piece.diamonds, (d) => d.cts);
  const stoneCts = sum(piece.stones, (s) => s.cts);
  return piece.gross_wt.sub(diaCts.div(FIVE)).sub(stoneCts.div(FIVE));
}

/** §5.4  O = E_gold / 31.1035 / 24 × KT / F_purity  (USD per gram at KT).
 *
 * `usdPerTroyOz` is the international gold rate (e.g. 4339.8413), NOT INR/gm.
 */
export function goldRateUsdPerGm(usdPerTroyOz: Decimal, purity: Decimal, ktNum: number): Decimal {
  return usdPerTroyOz.div(GRAMS_PER_TROY_OZ).div(PURE_GOLD_KT).mul(ktNum).div(purity);
}

/** §5.6 Σ(AB × AC). */
export function diamondValueUsd(piece: Piece): Decimal {
  return sum(piece.diamonds, (d) => (d.rate_usd_per_ct ? d.rate_usd_per_ct.mul(d.cts) : ZERO));
}

/** §5.7 Σ ROUND(AI × AH, 2). */
export function stoneValueUsd(piece: Piece): Decimal {
  return sum(piece.stones, (s) => (s.rate_usd_per_ct ? q2(s.rate_usd_per_ct.mul(s.cts)) : ZERO));
}

/** AR base-gold lock = ROUND(SJ-50 net wt, 2) × touch[KT] × base rate.
 *  Kept at full precision like most manual AR cells (EXP535 548.770236,
 *  EXP553 682.254888); some invoices typed AR at 2 dp (EXP570) — enter
 *  those as a per-piece override. Falls back to round(K, 2) when the SJ-50
 *  net weight is missing. */
export function baseGoldLockUsd(args: {
  net_wt_raw: Decimal | null | undefined;
  computed_net_wt: Decimal;
  touch: Decimal;
  base_rate_usd_per_gm: Decimal;
}): { value: Decimal; net: Decimal } {
  const raw = args.net_wt_raw && args.net_wt_raw.gt(0) ? args.net_wt_raw : args.computed_net_wt;
  const net = q2(raw);
  return { value: net.mul(args.touch).mul(args.base_rate_usd_per_gm), net };
}

/** Touch factor for a KT; theoretical purity (KT/24) if not configured. */
export function touchFor(kt: string, ktTouch: Record<string, number>): { touch: Decimal; configured: boolean } {
  const n = String(ktNumber(kt));
  const t = ktTouch[n];
  if (t && t > 0) return { touch: new Decimal(t), configured: true };
  return { touch: new Decimal(ktNumber(kt)).div(PURE_GOLD_KT), configured: false };
}

/** Labour rate for one piece: '18-PD' has its own rate (₹2,000 vs ₹1,275). */
export function laborRateFor(kt: string, rates: Record<string, number | Decimal>): Decimal | null {
  const v = rates[kt] ?? (kt.endsWith("-PD") ? undefined : rates[String(ktNumber(kt))]);
  return v === undefined || v === null ? null : new Decimal(v.toString());
}

/** §5.11  MFG / (gold + studding). */
export function valueAdditionRatio(mfg: Decimal, gold: Decimal, studding: Decimal): Decimal {
  const denom = gold.add(studding);
  if (denom.eq(0)) return ZERO;
  return mfg.div(denom);
}

export interface CalcParams {
  gold_rate_usd_per_troy_oz: Decimal;
  gold_purity: Decimal;
  /** CUSTOMS PL!AU — labour INR → USD. */
  labour_inr_usd_rate: Decimal;
  base_gold_rate_usd_per_gm: Decimal;
  kt_touch: Record<string, number>;
  /** INR/gm keyed by piece KT ('9', '14', '18', '18-PD'). */
  labor_rates: Record<string, number | Decimal>;
  fixed_addon_usd: Decimal;
  /** Round the derived AR to 2 dp (default true — EXP615, the newest sample,
   *  does; EXP535 did not). Typed overrides are used as entered. */
  round_base_lock_2dp?: boolean;
}

/** One CUSTOMS PL row, every column the manual sheet computes. */
export function computePiece(p: Piece, wastagePct: Decimal, prm: CalcParams): PieceCalc {
  const K = netWtGm(p);
  const M = K.mul(wastagePct);
  const N = K.add(M);
  const O = goldRateUsdPerGm(prm.gold_rate_usd_per_troy_oz, prm.gold_purity, ktNumber(p.kt));
  const P = N.mul(O);
  const dia = diamondValueUsd(p);
  const stone = stoneValueUsd(p);

  const { touch } = touchFor(p.kt, prm.kt_touch);
  const derived = baseGoldLockUsd({
    net_wt_raw: p.net_wt_raw, computed_net_wt: K, touch, base_rate_usd_per_gm: prm.base_gold_rate_usd_per_gm,
  });
  const override = p.base_gold_lock_usd ?? null;
  const roundAr = prm.round_base_lock_2dp ?? true;
  const AR = override ?? (roundAr ? q2(derived.value) : derived.value);

  // The packing list's own "Labour" column (e.g. "2000/gm") wins over Settings.
  const AT = p.labour_rate_inr_per_gm ?? laborRateFor(p.kt, prm.labor_rates);
  if (!AT) throw new Error(`No labour rate for KT '${p.kt}' (piece ${p.cust_style_no || p.stock_no}). Add it in Settings → Labour rates.`);
  const AU = prm.labour_inr_usd_rate;
  const AV = AT.div(AU);
  const AW = K.mul(AV);
  const AS = P.sub(AR);
  const AY = AS.add(AW);
  const AZ = p.fixed_addon_usd ?? prm.fixed_addon_usd;
  const BA = AY.add(AZ);
  const AK = q2(BA);
  const AL = P.add(dia).add(stone).add(AK);

  return {
    net_wt: K, wastage_pct: wastagePct, wastage_wt: M, net_plus_wastage: N,
    gold_rate_per_gm: O, gold_value: P, diamond_value: dia, stone_value: stone,
    base_lock: AR, base_lock_auto: override === null, base_lock_rounded: override === null && roundAr,
    base_lock_net_wt: derived.net, base_lock_touch: touch,
    residual: AS, labour_rate_inr: AT, labour_fx: AU, labour_usd_per_gm: AV, labour_cost: AW,
    addon: AZ, mfg_unrounded: BA, mfg: AK, total: AL,
  };
}

/** Compute all per-piece values and aggregate for a lot.
 *  Mutates `lot.totals` and `lot.piece_calcs`. */
export function computeLotTotals(args: { lot: Lot; hsn?: HsnEntry } & CalcParams): LotTotals {
  const { lot, ...prm } = args;
  const calcs = lot.pieces.map((p) => computePiece(p, lot.wastage_pct, prm));

  const gold = sum(calcs, (c) => c.gold_value);
  const dia = sum(calcs, (c) => c.diamond_value);
  const stone = sum(calcs, (c) => c.stone_value);
  const mfg = sum(calcs, (c) => c.mfg);
  const studding = dia.add(stone);

  const totals: LotTotals = {
    gross_wt: sum(lot.pieces, (p) => p.gross_wt),
    net_wt: sum(calcs, (c) => c.net_wt),
    wastage_wt: sum(calcs, (c) => c.wastage_wt),
    gold_value_usd: gold,
    diamond_value_usd: dia,
    stone_value_usd: stone,
    mfg_cost_usd: mfg,
    total_usd: gold.add(mfg).add(studding),
    value_addition_ratio: valueAdditionRatio(mfg, gold, studding),
  };
  lot.piece_calcs = calcs;
  lot.totals = totals;
  return totals;
}

/** §5.12  Σ lot totals + freight + insurance − discount − commission. */
export function grandTotalCf(args: {
  lots: Lot[];
  freight?: Decimal;
  insurance?: Decimal;
  discount?: Decimal;
  commission?: Decimal;
}): Decimal {
  const lotsSum = args.lots.reduce((a, l) => a.add(l.totals?.total_usd ?? 0), ZERO);
  return lotsSum
    .add(args.freight ?? 0)
    .add(args.insurance ?? 0)
    .sub(args.discount ?? 0)
    .sub(args.commission ?? 0);
}

/** §5.13 */
export function grandTotalInr(cfUsd: Decimal, inrUsdRate: Decimal): Decimal {
  return cfUsd.mul(inrUsdRate);
}

/** A/C OF GOLD block: pure gold incl. wastage drawn from the purchase, per lot
 *  (INVOICE!M146 = G/24×KT/purity × (1+wastage)). */
export function pureGoldUsedGm(lot: Lot, purity: Decimal): Decimal {
  const net = lot.totals?.net_wt ?? sum(lot.pieces, netWtGm);
  const pure = net.div(PURE_GOLD_KT).mul(ktNumber(lot.kt)).div(purity);
  return pure.add(pure.mul(lot.wastage_pct));
}
