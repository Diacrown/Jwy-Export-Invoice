/** SJ-50 → invoice value mappings. Ported from Python mappings.py, then
 *  corrected against the manual MASTER DETAILS workbooks (EXP535 … EXP602). */
import type { JewelleryType, Piece } from "../types";

export const CATEGORY_MAP: Record<string, string> = {
  "Cust RG": "RING",
  "Cust PD": "PENDANT",
  "Cust PN": "PENDANT",
  "Cust BR": "BRACELET",
  "Cust EN": "EARRING",
  "Cust ER": "EARRING",
  "Cust NK": "NECKLACE",
  "Cust BG": "BANGLE",
  "Cust CH": "CHAIN",
};

const CATEGORY_BARE: Record<string, string> = {
  RG: "RING", PD: "PENDANT", PN: "PENDANT", BR: "BRACELET", EN: "EARRING",
  ER: "EARRING", NK: "NECKLACE", BG: "BANGLE", CH: "CHAIN",
};

/** Piece colour as printed in CUSTOMS PL!G. Two-tone pieces print as
 *  "YELLOW & WHITE" (EXP535 R0222-0300-18YWLG, SJ-50 colour "Y-W"). */
export const COLOR_MAP: Record<string, string> = {
  Y: "YELLOW",
  W: "WHITE",
  R: "ROSE",
  P: "ROSE",
  "Y-W": "YELLOW & WHITE",
  "Y/W": "YELLOW & WHITE",
  "W-Y": "YELLOW & WHITE",
  "W/Y": "YELLOW & WHITE",
  "Y-R": "YELLOW & ROSE",
  "Y/R": "YELLOW & ROSE",
  "R-W": "ROSE & WHITE",
  "R/W": "ROSE & WHITE",
  "W-R": "ROSE & WHITE",
  "Y-W-R": "YELLOW & WHITE & ROSE",
};

const BASE_COLOR_ORDER = ["YELLOW", "WHITE", "ROSE"];

export const SHAPE_CANONICAL: Record<string, string> = {
  round: "ROUND",
  rd: "ROUND",
  "round pointer": "ROUND",
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
  pears: "PEAR",
  pr: "PEAR",
  taper: "TAPER_BAGUETTE",
  "taper baguette": "TAPER_BAGUETTE",
  baguette: "BAGUETTE",
  baguettes: "BAGUETTE",
  bug: "BAGUETTE",
  plate: "PLATE",
  trapezoid: "TRAPEZOID",
  trap: "TRAPEZOID",
  trpz: "TRAPEZOID",
  marquise: "MARQUISE",
  mq: "MARQUISE",
  princess: "PRINCESS",
  heart: "HEART",
  trillion: "TRILLION",
  "clr onyx": "ONYX",
  onyx: "ONYX",
  // colour-stone columns in the newer packing lists ("Col Stn", "Clr Stn")
  "col stn": "COLOR STONE",
  "clr stn": "COLOR STONE",
  "color stone": "COLOR STONE",
  "colour stone": "COLOR STONE",
  "col stone": "COLOR STONE",
};

/** Shapes that are coloured / semi-precious stones, not diamonds. */
export const COLOR_STONE_SHAPES = new Set(["COLOR STONE", "ONYX", "RUBY", "SAPPHIRE", "EMERALD_STONE", "AMETHYST", "TOPAZ", "GARNET"]);

const PRECIOUS_STONES = ["RUBY", "SAPPHIRE", "EMERALD"];
const STONE_NAMES = [...PRECIOUS_STONES, "ONYX", "AMETHYST", "TOPAZ", "GARNET", "TANZANITE", "TOURMALINE", "PERIDOT", "CITRINE", "OPAL", "PEARL"];
/** Diamond-shape codes used in the "Diamond Quality" column (RD-50, OVL-50, …). */
const DIAMOND_CODES = new Set(["RD", "RDNT", "OVL", "OV", "EM", "CU", "MQ", "PE", "PR", "BUG", "TRPZ", "TRAP", "PRN", "HRT", "TRL"]);

/** Named coloured stone in a "Diamond Quality" code such as "OVL-50,Ruby-50" → "RUBY". */
export function stoneNameFromQuality(code: string | null | undefined): string | null {
  for (const tok of (code ?? "").toUpperCase().split(/[,;/ ]+/)) {
    const name = tok.replace(/-\d+$/, "");
    if (!name || DIAMOND_CODES.has(name) || name === "CLR" || name === "-") continue;
    const hit = STONE_NAMES.find((st) => name.startsWith(st));
    if (hit) return hit;
  }
  return null;
}

/** Returns [kt_number, is_palladium]. */
export function normalizeKt(raw: string): [string, boolean] {
  const s = (raw ?? "").toUpperCase().replace(/\s+/g, "");
  const isPd = s.includes("-PD") || (s.includes("PD") && s.startsWith("18K"));
  const prefixes = ["22K", "18K-PD", "18KPD", "18K", "14KUK", "14K", "10K", "9KUK", "9K"];
  for (const p of prefixes) {
    if (s.startsWith(p)) {
      const num = p.replace("UK", "").replace("-PD", "").replace("PD", "").replace("K", "");
      return [num, isPd];
    }
  }
  throw new Error(`Unknown KT value: '${raw}'`);
}

/** '18-PD' → 18 */
export function ktNumber(kt: string): number {
  return parseInt(kt.replace("-PD", ""), 10);
}

export function normalizeColor(raw: string): string {
  const key = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return COLOR_MAP[key] ?? (raw ?? "").trim().toUpperCase();
}

/** Lot colour = union of the base colours of its pieces, YELLOW → WHITE → ROSE.
 *  EXP535 lot 2 mixes Y-W, W and Y pieces → "YELLOW & WHITE". */
export function lotColor(pieceColors: string[]): string {
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const c of pieceColors) {
    for (const part of c.split("&").map((x) => x.trim()).filter(Boolean)) {
      if (BASE_COLOR_ORDER.includes(part)) seen.add(part);
      else if (!extra.includes(part)) extra.push(part);
    }
  }
  return [...BASE_COLOR_ORDER.filter((c) => seen.has(c)), ...extra].join(" & ");
}

export function normalizeCategory(raw: string): string {
  const key = (raw ?? "").trim();
  if (key in CATEGORY_MAP) return CATEGORY_MAP[key];
  const bare = key.replace(/^Cust\s+/i, "").toUpperCase();
  return CATEGORY_BARE[bare] ?? (bare || "JEWELLERY");
}

export function normalizeShape(raw: string): string {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return SHAPE_CANONICAL[key] ?? key.toUpperCase();
}

/** Decide HSN category. The packing list's second "Category" column
 *  ("Lab Studded", "Mined, Precious gemstone Studded", "Gemstone Semi", "Mount")
 *  wins over Remarks when present. */
export function classifyJewellery(piece: Piece): JewelleryType {
  const r = (piece.product_category || piece.remarks || "").trim().toUpperCase();
  if (r.includes("LGD") || /\bLAB\b/.test(r)) return "gold_studded_lgd";
  if (r.includes("MINED") || r.includes("NATURAL")) return "gold_studded_diamond";
  if (r.includes("COLOR") || r.includes("COLOUR") || r.includes("GEMSTONE") || r.includes("PRECIOUS")) return "gold_studded_colorstone";
  if (piece.diamonds.some((d) => COLOR_STONE_SHAPES.has(d.shape)) && !piece.diamonds.some((d) => !COLOR_STONE_SHAPES.has(d.shape)))
    return "gold_studded_colorstone";
  if (r.includes("MOUNT") && !r.includes("SEMI")) return "gold_mounting";
  if (piece.diamonds.some((d) => d.cts.gt(0))) return "gold_studded_diamond";
  if (piece.stones.some((s) => s.cts.gt(0))) return "gold_studded_colorstone";
  return "gold_plain";
}

/** "LGD SEMI", "SEMI MOUNT", "Semi-Mined", "Gemstone Semi" → semi-mounting
 *  (EXP570 lot 4, EXP602 lot 6, EXP615 lot 4). Pass the product category when
 *  the file has one — EXP615 ignored "MINED SEMI" in Remarks. */
export function isSemiMount(text: string | null | undefined): boolean {
  return /\bSEMI\b/i.test(text ?? "");
}

/** Default "DIA DETAILS" text for a studding row (CUSTOMS PL!Y). */
export function defaultOrigin(jtype: JewelleryType, shape: string, stoneName?: string | null): string | null {
  if (COLOR_STONE_SHAPES.has(shape) || jtype === "gold_studded_colorstone") {
    return stoneName && PRECIOUS_STONES.includes(stoneName) ? "PRECIOUS STONE" : "SEMI-PRECIOUS STONE";
  }
  return null;
}

export function applyMappings(piece: Piece): Piece {
  const [kt, isPd] = normalizeKt(piece.kt_raw);
  piece.kt = isPd ? `${kt}-PD` : kt;
  piece.color = normalizeColor(piece.color_raw);
  piece.item = normalizeCategory(piece.item_category_raw);
  piece.jewellery_type = classifyJewellery(piece);
  piece.semi_mount = isSemiMount(piece.product_category || piece.remarks);
  const stone = stoneNameFromQuality(piece.diamond_quality_code);
  for (const d of piece.diamonds) {
    const isStone = COLOR_STONE_SHAPES.has(d.shape);
    if (!d.origin) d.origin = defaultOrigin(piece.jewellery_type, d.shape, isStone ? stone : null);
    if (isStone && !d.color_clarity && stone) d.color_clarity = stone;
  }
  return piece;
}

/** "18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS"
 *  "9 KT YELLOW GOLD MOUNTING JEWELLERY"
 *  "18 KT WHITE GOLD SEMI-MOUNTING JEWELLERY STUDDED WITH DIAMONDS"
 *  Palladium alloy is NOT printed (EXP535 lot 2 is all 18K-PD). */
export function lotDescription(
  kt: string,
  color: string,
  hsnTail: string,
  semiMount = false,
): string {
  const ktNum = kt.replace("-PD", "");
  return `${ktNum} KT ${color} GOLD ${semiMount ? "SEMI-MOUNTING " : ""}${hsnTail}`;
}

/** Studding labels used on the two sheets. */
export function studdingLabel(jtype: JewelleryType): { invoice: string; customs: string } {
  switch (jtype) {
    case "gold_studded_lgd": return { invoice: "LG DIAMONDS", customs: "LABGROWN DIAMONDS" };
    case "gold_studded_diamond": return { invoice: "DIAMONDS", customs: "NATURAL DIAMONDS" };
    case "gold_studded_colorstone": return { invoice: "SEMI-PRECIOUS STONE", customs: "SEMI-PRECIOUS STONE" };
    default: return { invoice: "", customs: "DIAMONDS" };
  }
}
