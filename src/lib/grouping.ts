/** Group pieces into lots by (KT, Color, JewelleryType). */
import Decimal from "decimal.js";
import type { HsnEntry, JewelleryType, Lot, Piece } from "../types";
import { lotDescription } from "./mappings";

export function groupPiecesIntoLots(
  pieces: Piece[],
  hsnTable: Record<JewelleryType, HsnEntry>,
  defaultWastagePct: Decimal,
): Lot[] {
  const buckets = new Map<string, { pieces: Piece[]; key: [string, string, JewelleryType] }>();
  for (const p of pieces) {
    const k = `${p.kt}|${p.color}|${p.jewellery_type}`;
    const b = buckets.get(k);
    if (b) b.pieces.push(p);
    else buckets.set(k, { pieces: [p], key: [p.kt, p.color, p.jewellery_type] });
  }
  const lots: Lot[] = [];
  let lotNo = 1;
  for (const { pieces: ps, key } of buckets.values()) {
    const [kt, color, jtype] = key;
    const hsn = hsnTable[jtype];
    lots.push({
      lot_no: lotNo++,
      kt,
      color,
      jewellery_type: jtype,
      hsn_code: hsn.code,
      description: lotDescription(kt, color, hsn.description_tail),
      pieces: ps,
      wastage_pct: defaultWastagePct,
    });
  }
  return lots;
}
