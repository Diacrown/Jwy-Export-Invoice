/** SJ-50 raw file parser using SheetJS. Handles both .xls (legacy) and .xlsx.
 *
 * Mirrors the Python parser: locates the header row by matching "Sr. No." + "Stock No.",
 * then auto-detects shape columns by header text (Round / Radiant / Emerld / Cushion …).
 */
import Decimal from "decimal.js";
import * as XLSX from "xlsx";
import type { DiamondDetail, Piece } from "../types";
import { applyMappings, normalizeShape } from "../lib/mappings";

const HDR_SR_NO = ["sr. no.", "sr no", "sr.no", "sno"];
const HDR_STOCK = ["stock no.", "stock no", "stockno"];
const HDR_CATEGORY = ["category"];
const HDR_CUST_PO = ["cust po", "cust order no.", "cust order no", "cust challan no."];
const HDR_CUST_STYLE = ["cust style no.", "cust style no", "cust style"];
const HDR_INT_STYLE = ["style no.", "style no", "styleno"];
const HDR_BAG = ["bag no", "bagno"];
const HDR_KT = ["gold kt.", "gold kt"];
const HDR_COL = ["gold col.", "gold col"];
const HDR_SIZE = ["size"];
const HDR_QTY = ["qty"];
const HDR_GROSS = ["gross wt.", "gross wt", "grosswt"];
const HDR_NET = ["net wt.", "net wt", "netwt"];
const HDR_DIA_Q = ["diamond quality"];
const HDR_REMARKS = ["remarks"];
const HDR_PCS = ["pcs"];
const HDR_WT = ["wt"];

const SKIP_SHAPES = new Set([
  "sr. no.", "sr no", "stock no.", "category", "cust po", "cust challan no.",
  "cust order no.", "cust style no.", "style no.", "bag no", "gold kt.",
  "gold col.", "size", "qty", "gross wt.", "net wt.", "diamond quality",
  "total dia.", "remarks",
]);

function toDecimal(v: unknown): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  try { return new Decimal(String(v)); } catch { return new Decimal(0); }
}
function toInt(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function cellLower(ws: XLSX.WorkSheet, addr: string): string {
  const c = ws[addr];
  return (c?.v ?? "").toString().trim().toLowerCase();
}
function cellValue(ws: XLSX.WorkSheet, addr: string): unknown {
  return ws[addr]?.v;
}
function addr(row: number, col: number): string {
  return XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
}

/** Scan for the row holding Sr. No. + Stock No. */
function findHeaderRow(ws: XLSX.WorkSheet, lastRow: number, lastCol: number): number {
  for (let r = 1; r <= Math.min(lastRow, 50); r++) {
    const rowVals: string[] = [];
    for (let c = 1; c <= Math.min(lastCol, 40); c++) rowVals.push(cellLower(ws, addr(r, c)));
    if (HDR_SR_NO.some((h) => rowVals.includes(h)) && HDR_STOCK.some((h) => rowVals.includes(h))) return r;
  }
  throw new Error("Could not find SJ-50 header row (expecting 'Sr. No.' + 'Stock No.')");
}

function colMatching(ws: XLSX.WorkSheet, headerRow: number, aliases: string[], lastCol: number): number | null {
  for (let c = 1; c <= lastCol; c++) {
    if (aliases.includes(cellLower(ws, addr(headerRow, c)))) return c;
  }
  return null;
}

function detectShapeColumns(ws: XLSX.WorkSheet, headerRow: number, lastCol: number): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const sub = headerRow + 1;
  for (let c = 1; c <= lastCol; c++) {
    const label = (cellValue(ws, addr(headerRow, c)) ?? "").toString().trim();
    if (!label) continue;
    if (SKIP_SHAPES.has(label.toLowerCase())) continue;
    const below = cellLower(ws, addr(sub, c));
    const rightBelow = cellLower(ws, addr(sub, c + 1));
    if (HDR_PCS.includes(below) && HDR_WT.includes(rightBelow)) {
      out.set(normalizeShape(label), [c, c + 1]);
    }
  }
  return out;
}

/** Parse SJ-50 file (Blob/File) into Pieces. */
export async function parseSj50(file: Blob): Promise<Piece[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const ref = ws["!ref"];
  if (!ref) throw new Error("SJ-50: empty sheet");
  const range = XLSX.utils.decode_range(ref);
  const lastRow = range.e.r + 1;
  const lastCol = range.e.c + 1;

  const headerRow = findHeaderRow(ws, lastRow, lastCol);

  const colSrNo = colMatching(ws, headerRow, HDR_SR_NO, lastCol);
  const colStock = colMatching(ws, headerRow, HDR_STOCK, lastCol);
  const colCat = colMatching(ws, headerRow, HDR_CATEGORY, lastCol);
  const colPo = colMatching(ws, headerRow, HDR_CUST_PO, lastCol);
  const colCustStyle = colMatching(ws, headerRow, HDR_CUST_STYLE, lastCol);
  const colIntStyle = colMatching(ws, headerRow, HDR_INT_STYLE, lastCol);
  const colBag = colMatching(ws, headerRow, HDR_BAG, lastCol);
  const colKt = colMatching(ws, headerRow, HDR_KT, lastCol);
  const colCol = colMatching(ws, headerRow, HDR_COL, lastCol);
  const colSize = colMatching(ws, headerRow, HDR_SIZE, lastCol);
  const colQty = colMatching(ws, headerRow, HDR_QTY, lastCol);
  const colGross = colMatching(ws, headerRow, HDR_GROSS, lastCol);
  const colNet = colMatching(ws, headerRow, HDR_NET, lastCol);
  const colDiaQ = colMatching(ws, headerRow, HDR_DIA_Q, lastCol);
  const colRem = colMatching(ws, headerRow, HDR_REMARKS, lastCol);

  if (!colStock || !colQty || !colGross || !colKt) {
    throw new Error("SJ-50 missing required columns (Stock No / Qty / Gross Wt / Gold Kt)");
  }

  const shapeCols = detectShapeColumns(ws, headerRow, lastCol);

  const pieces: Piece[] = [];
  const dataStart = headerRow + 2;
  for (let r = dataStart; r <= lastRow; r++) {
    const srVal = colSrNo ? cellValue(ws, addr(r, colSrNo)) : (r - dataStart + 1);
    const stock = toStr(cellValue(ws, addr(r, colStock)));
    if (!stock || stock === "*" || stock === "-" || stock.toLowerCase() === "total") continue;
    const ktRaw = toStr(cellValue(ws, addr(r, colKt)));
    if (!ktRaw || ktRaw === "*" || ktRaw === "-") continue;
    if (srVal === "*" || srVal === null) {
      // keep going only if there's still a stock number
    }

    const diamonds: DiamondDetail[] = [];
    for (const [shape, [pcsC, wtC]] of shapeCols) {
      const pcs = toInt(cellValue(ws, addr(r, pcsC)));
      const cts = toDecimal(cellValue(ws, addr(r, wtC)));
      if (pcs > 0 || cts.gt(0)) {
        diamonds.push({ shape, pcs, cts });
      }
    }

    const piece: Piece = {
      stock_no: stock,
      cust_po: colPo ? toStr(cellValue(ws, addr(r, colPo))) : null,
      cust_style_no: (colCustStyle && toStr(cellValue(ws, addr(r, colCustStyle)))) || "",
      internal_style_no: colIntStyle ? toStr(cellValue(ws, addr(r, colIntStyle))) : null,
      bag_no: colBag ? toStr(cellValue(ws, addr(r, colBag))) : null,
      kt_raw: ktRaw,
      color_raw: (colCol && toStr(cellValue(ws, addr(r, colCol)))) || "",
      size: colSize ? toStr(cellValue(ws, addr(r, colSize))) : null,
      qty: Math.max(1, toInt(cellValue(ws, addr(r, colQty)))),
      gross_wt: toDecimal(cellValue(ws, addr(r, colGross))),
      net_wt_raw: colNet ? toDecimal(cellValue(ws, addr(r, colNet))) : null,
      diamond_quality_code: colDiaQ ? toStr(cellValue(ws, addr(r, colDiaQ))) : null,
      remarks: colRem ? toStr(cellValue(ws, addr(r, colRem))) : null,
      item_category_raw: (colCat && toStr(cellValue(ws, addr(r, colCat)))) || "",
      item: "",
      kt: "",
      color: "",
      jewellery_type: "gold_plain",
      diamonds,
      stones: [],
    };
    applyMappings(piece);
    pieces.push(piece);
  }
  if (pieces.length === 0) throw new Error("No pieces parsed from SJ-50");
  return pieces;
}
