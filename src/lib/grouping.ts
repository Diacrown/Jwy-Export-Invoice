/** Group pieces into lots the way the manual workbooks do.
 *
 * Key = (KT number, jewellery type, semi-mount). Colour is NOT part of the
 * key and 18K / 18K-PD share a lot: EXP535 lot 2 holds 18K-PD Y-W, 18K-PD W
 * and plain 18K Y pieces as "18 KT YELLOW & WHITE GOLD …". Labour rate is
 * still chosen per piece (PD ₹2,000 vs ₹1,275).
 *
 * Wastage per lot = min(default, HSN max): mounting lots print 2 % while
 * studded lots print 4 % (EXP535 lot 3, EXP553 lot 2, EXP573).
 */
import Decimal from "decimal.js";
import type { HsnEntry, JewelleryType, Lot, Piece } from "../types";
import { ktNumber, lotColor, lotDescription } from "./mappings";

export function lotWastagePct(hsn: HsnEntry, defaultWastagePct: Decimal, override?: Decimal | null): Decimal {
  if (override) return override;
  const max = new Decimal(hsn.max_wastage_handcrafted);
  return Decimal.min(defaultWastagePct, max);
}

export function groupPiecesIntoLots(
  pieces: Piece[],
  hsnTable: Record<JewelleryType, HsnEntry>,
  defaultWastagePct: Decimal,
  wastageOverride?: Decimal | null,
): Lot[] {
  const buckets = new Map<string, { pieces: Piece[]; kt: string; jtype: JewelleryType; semi: boolean }>();
  for (const p of pieces) {
    const kt = String(ktNumber(p.kt));
    const k = `${kt}|${p.jewellery_type}|${p.semi_mount ? "semi" : ""}`;
    const b = buckets.get(k);
    if (b) b.pieces.push(p);
    else buckets.set(k, { pieces: [p], kt, jtype: p.jewellery_type, semi: p.semi_mount });
  }
  const lots: Lot[] = [];
  let lotNo = 1;
  for (const { pieces: ps, kt, jtype, semi } of buckets.values()) {
    const hsn = hsnTable[jtype];
    if (!hsn) throw new Error(`HSN table has no row for '${jtype}'. Add it in Settings → HSN table.`);
    const color = lotColor(ps.map((p) => p.color));
    lots.push({
      lot_no: lotNo++,
      kt,
      color,
      jewellery_type: jtype,
      semi_mount: semi,
      hsn_code: hsn.code,
      description: lotDescription(kt, color, hsn.description_tail, semi),
      pieces: ps,
      wastage_pct: lotWastagePct(hsn, defaultWastagePct, wastageOverride),
    });
  }
  return lots;
}
