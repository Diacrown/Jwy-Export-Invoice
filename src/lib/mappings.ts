/** SJ-50 → invoice value mappings. Ported from Python mappings.py. */
import type { JewelleryType, Piece } from "../types";

export const CATEGORY_MAP: Record<string, string> = {
  "Cust RG": "RING",
  "Cust PD": "PENDANT",
  "Cust BR": "BRACELET",
  "Cust EN": "EARRING",
  "Cust NK": "NECKLACE",
  "Cust BG": "BANGLE",
  "Cust CH": "CHAIN",
};

export const COLOR_MAP: Record<string, string> = {
  Y: "YELLOW",
  W: "WHITE",
  R: "ROSE",
  "Y-W": "YELLOW/WHITE",
  "Y/W": "YELLOW/WHITE",
  "W-Y": "WHITE/YELLOW",
  "W/Y": "WHITE/YELLOW",
  "Y-R": "YELLOW/ROSE",
  "R/W": "ROSE/WHITE",
};

export const SHAPE_CANONICAL: Record<string, string> = {
  round: "ROUND",
  rd: "ROUND",
  radiant: "RADIANT",
  rdnt: "RADIANT",
  emerald: "EMERALD",
  emerld: "EMERALD",       // SJ-50 files misspell it
  em: "EMERALD",
  cushion: "CUSHION",
  cu: "CUSHION",
  oval: "OVAL",
  ov: "OVAL",
  pear: "PEAR",
  pr: "PEAR",
  taper: "TAPER_BAGUETTE",
  "taper baguette": "TAPER_BAGUETTE",
  baguette: "BAGUETTE",
  plate: "PLATE",
  trapezoid: "TRAPEZOID",
  trap: "TRAPEZOID",
  marquise: "MARQUISE",
  princess: "PRINCESS",
  heart: "HEART",
};

/** Returns [kt_number, is_palladium]. */
export function normalizeKt(raw: string): [string, boolean] {
  const s = (raw ?? "").toUpperCase().replace(/\s+/g, "");
  const isPd = s.includes("-PD") || (s.includes("PD") && s.startsWith("18K"));
  const prefixes = ["18K-PD", "18KPD", "18K", "14KUK", "14K", "9KUK", "9K"];
  for (const p of prefixes) {
    if (s.startsWith(p)) {
      const num = p.replace("UK", "").replace("-PD", "").replace("PD", "").replace("K", "");
      return [num, isPd];
    }
  }
  throw new Error(`Unknown KT value: '${raw}'`);
}

export function normalizeColor(raw: string): string {
  const key = (raw ?? "").trim().toUpperCase();
  return COLOR_MAP[key] ?? key;
}

export function normalizeCategory(raw: string): string {
  const key = (raw ?? "").trim();
  if (key in CATEGORY_MAP) return CATEGORY_MAP[key];
  const bare = key.replace("Cust ", "").toUpperCase();
  return (
    { RG: "RING", PD: "PENDANT", BR: "BRACELET", EN: "EARRING", NK: "NECKLACE" }[bare] ??
    (bare || "JEWELLERY")
  );
}

export function normalizeShape(raw: string): string {
  const key = (raw ?? "").trim().toLowerCase();
  return SHAPE_CANONICAL[key] ?? key.toUpperCase();
}

/** Decide HSN category from remarks + stud content. */
export function classifyJewellery(piece: Piece): JewelleryType {
  const r = (piece.remarks ?? "").trim().toUpperCase();
  if (r.includes("LGD")) return "gold_studded_lgd";
  if (r.includes("MINED")) return "gold_studded_diamond";
  if (r.includes("COLOR")) return "gold_studded_colorstone";
  if (r.includes("MOUNT")) return "gold_mounting";
  if (piece.diamonds.some((d) => d.cts.gt(0))) return "gold_studded_diamond";
  if (piece.stones.some((s) => s.cts.gt(0))) return "gold_studded_colorstone";
  if (r === "PLAIN") return "gold_plain";
  return "gold_plain";
}

export function applyMappings(piece: Piece): Piece {
  const [kt, isPd] = normalizeKt(piece.kt_raw);
  piece.kt = isPd ? `${kt}-PD` : kt;
  piece.color = normalizeColor(piece.color_raw);
  piece.item = normalizeCategory(piece.item_category_raw);
  piece.jewellery_type = classifyJewellery(piece);
  return piece;
}

export function lotDescription(
  kt: string,
  color: string,
  hsnTail: string,
): string {
  const ktNum = kt.replace("-PD", "");
  const pdNote = kt.endsWith("-PD") ? " WITH PALLADIUM" : "";
  return `${ktNum} KT ${color} GOLD${pdNote} ${hsnTail}`;
}
