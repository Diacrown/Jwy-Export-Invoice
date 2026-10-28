/** Pure-function invoice calculations. Ported from Python calculations.py.
 *
 * Formula numbering matches the analysis doc §5.
 */
import Decimal from "decimal.js";
import type { HsnEntry, Lot, LotTotals, Piece } from "../types";

const GRAMS_PER_TROY_OZ = new Decimal("31.1035");
const PURE_GOLD_KT = new Decimal(24);
const FIVE = new Decimal(5);

export function q2(x: Decimal): Decimal {
  return x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
export function q4(x: Decimal): Decimal {
  return x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** §5.1  K = J − Σdiamond_cts/5 − Σstone_cts/5. */
export function netWtGm(piece: Piece): Decimal {
  const diaCts = piece.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
  const stoneCts = piece.stones.reduce((a, s) => a.add(s.cts), new Decimal(0));
  return q4(piece.gross_wt.sub(diaCts.div(FIVE)).sub(stoneCts.div(FIVE)));
}

/** §5.2 */
export function wastageWtGm(netWt: Decimal, wastagePct: Decimal): Decimal {
  return q4(netWt.mul(wastagePct));
}

/** §5.3 */
export function netPlusWastage(netWt: Decimal, wastageWt: Decimal): Decimal {
  return q4(netWt.add(wastageWt));
}

/** §5.4  O = (E167 / 31.1035 / 24) × KT / F167.
 *
 * `gold_rate_usd_per_troy_oz` is the international gold rate (e.g. 4662.4965),
 * NOT INR/gm. The INR/USD rate is applied separately at the C&F total.
 */
export function goldRateUsdPerGm(
  usdPerTroyOz: Decimal,
  purity: Decimal,
  ktNumber: number,
): Decimal {
  const kt = new Decimal(ktNumber);
  const perGmPure = usdPerTroyOz.div(GRAMS_PER_TROY_OZ);
  const perGmAtKt = perGmPure.mul(kt).div(PURE_GOLD_KT);
  return q4(perGmAtKt.div(purity));
}

/** §5.5 */
export function goldValueUsd(netPlusWaste: Decimal, ratePerGm: Decimal): Decimal {
  return q2(netPlusWaste.mul(ratePerGm));
}

/** §5.6 Σ(AB × AC). */
export function diamondValueUsd(piece: Piece): Decimal {
  return q2(
    piece.diamonds.reduce(
      (a, d) =>
        d.rate_usd_per_ct ? a.add(d.rate_usd_per_ct.mul(d.cts)) : a,
      new Decimal(0),
    ),
  );
}

/** §5.7 Σ round(AI × AH, 2). */
export function stoneValueUsd(piece: Piece): Decimal {
  return q2(
    piece.stones.reduce(
      (a, s) =>
        s.rate_usd_per_ct ? a.add(s.rate_usd_per_ct.mul(s.cts)) : a,
      new Decimal(0),
    ),
  );
}

/** §5.8  BA = AS + AW + AZ. */
export function mfgCostUsd(args: {
  net_wt_gm: Decimal;
  gold_value_usd_piece: Decimal;
  base_gold_lock_usd: Decimal;
  labor_rate_inr_per_gm: Decimal;
  inr_usd_rate: Decimal;
  fixed_addon_usd: Decimal;
}): Decimal {
  const laborUsd = args.labor_rate_inr_per_gm.div(args.inr_usd_rate);
  const laborCost = args.net_wt_gm.mul(laborUsd);
  const residual = args.gold_value_usd_piece.sub(args.base_gold_lock_usd);
  return q2(residual.add(laborCost).add(args.fixed_addon_usd));
}

/** §5.11 */
export function valueAdditionRatio(
  mfg: Decimal,
  gold: Decimal,
  studding: Decimal,
): Decimal {
  const denom = gold.add(studding);
  if (denom.eq(0)) return new Decimal(0);
  return q4(mfg.div(denom));
}

/** Compute all per-piece values and aggregate for a lot. Mutates `lot.totals`. */
export function computeLotTotals(args: {
  lot: Lot;
  hsn: HsnEntry;
  gold_rate_usd_per_troy_oz: Decimal;
  gold_purity_imported: Decimal;
  inr_usd_rate: Decimal;
  wastage_pct: Decimal;
  labor_rate_inr_per_gm: Decimal;
  fixed_addon_usd: Decimal;
}): LotTotals {
  const { lot, gold_rate_usd_per_troy_oz, gold_purity_imported,
          inr_usd_rate, wastage_pct, labor_rate_inr_per_gm, fixed_addon_usd } = args;
  const ktNum = parseInt(lot.kt.replace("-PD", ""), 10);
  const ratePerGm = goldRateUsdPerGm(gold_rate_usd_per_troy_oz, gold_purity_imported, ktNum);

  let totalGross = new Decimal(0);
  let totalNet = new Decimal(0);
  let totalWaste = new Decimal(0);
  let totalGold = new Decimal(0);
  let totalDia = new Decimal(0);
  let totalStone = new Decimal(0);
  let totalMfg = new Decimal(0);

  for (const p of lot.pieces) {
    const k = netWtGm(p);
    const m = wastageWtGm(k, wastage_pct);
    const n = netPlusWastage(k, m);
    const g = goldValueUsd(n, ratePerGm);
    const d = diamondValueUsd(p);
    const s = stoneValueUsd(p);

    const base = p.base_gold_lock_usd ?? new Decimal(0);
    const addon = p.fixed_addon_usd ?? fixed_addon_usd;
    const mfg = mfgCostUsd({
      net_wt_gm: k,
      gold_value_usd_piece: g,
      base_gold_lock_usd: base,
      labor_rate_inr_per_gm,
      inr_usd_rate,
      fixed_addon_usd: addon,
    });

    totalGross = totalGross.add(p.gross_wt);
    totalNet = totalNet.add(k);
    totalWaste = totalWaste.add(m);
    totalGold = totalGold.add(g);
    totalDia = totalDia.add(d);
    totalStone = totalStone.add(s);
    totalMfg = totalMfg.add(mfg);
  }

  const studding = totalDia.add(totalStone);
  const total = totalGold.add(totalMfg).add(studding);
  const vaRatio = valueAdditionRatio(totalMfg, totalGold, studding);

  const totals: LotTotals = {
    gross_wt: q4(totalGross),
    net_wt: q4(totalNet),
    wastage_wt: q4(totalWaste),
    gold_value_usd: q2(totalGold),
    diamond_value_usd: q2(totalDia),
    stone_value_usd: q2(totalStone),
    mfg_cost_usd: q2(totalMfg),
    total_usd: q2(total),
    value_addition_ratio: vaRatio,
  };
  lot.totals = totals;
  return totals;
}

/** §5.12 */
export function grandTotalCf(args: {
  lots: Lot[];
  freight?: Decimal;
  insurance?: Decimal;
  discount?: Decimal;
  commission?: Decimal;
}): Decimal {
  const sum = args.lots.reduce(
    (a, l) => a.add(l.totals?.total_usd ?? 0),
    new Decimal(0),
  );
  return q2(
    sum
      .add(args.freight ?? 0)
      .add(args.insurance ?? 0)
      .sub(args.discount ?? 0)
      .sub(args.commission ?? 0),
  );
}

/** §5.13 */
export function grandTotalInr(cfUsd: Decimal, inrUsdRate: Decimal): Decimal {
  return q2(cfUsd.mul(inrUsdRate));
}
