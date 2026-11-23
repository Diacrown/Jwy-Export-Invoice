/** SJ-50 packing-list parser using SheetJS. Handles both .xls (legacy) and .xlsx.
 *
 * - Scans EVERY sheet, so the "Packing List" sheet inside an SDJ-JB vendor
 *   invoice works too (EXP535 includes B00718, which only appears there).
 * - A sheet may hold several blocks, each with its own header row and its own
 *   shape columns ("SJ-50 DCJ 07.10.2026 13 & 5 pcs.xls" has two; the second
 *   swaps Emerld for Marquise in the same column).
 * - Shape columns are detected by header text over a "Pcs | Wt" sub-header,
 *   never by position.
 */
import Decimal from "decimal.js";
import * as XLSX from "xlsx";
import type { DiamondDetail, Piece } from "../types";
import { SHAPE_CANONICAL, applyMappings, normalizeShape } from "../lib/mappings";

const HDR_SR_NO = ["sr. no.", "sr no", "sr.no", "sno", "sr. no"];
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
const HDR_REMARKS = ["remarks", "remark"];
const HDR_LABOUR = ["labour", "labor", "labour rate", "labor rate"];
const HDR_REGION = ["region", "loc", "loc.", "location"];
const HDR_PCS = ["pcs"];
const HDR_WT = ["wt"];

const SKIP_SHAPES = new Set([
  "sr. no.", "sr no", "stock no.", "category", "cust po", "cust challan no.",
  "cust order no.", "cust style no.", "style no.", "bag no", "gold kt.",
  "gold col.", "size", "qty", "gross wt.", "net wt.", "diamond quality",
  "remarks", "remark", "labour", "labor", "region", "loc",
]);

/** Values of the packing list's second "Category" column (product category). */
const PRODUCT_CATEGORY_RE = /(studded|semi|mount|mined|\blab\b|gemstone|plain|precious)/i;
const BAG_NO_RE = /^\d+\/[A-Z]\/\d+$/i;
/** "Total Dia." / "Total Diamond" / "Total" sit over Pcs|Wt too — never a shape. */
const isTotalHeader = (s: string) => /^total\b/i.test(s.trim());

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
function cellLower(ws: XLSX.WorkSheet, a: string): string {
  const c = ws[a];
  return (c?.v ?? "").toString().trim().toLowerCase();
}
function cellValue(ws: XLSX.WorkSheet, a: string): unknown {
  return ws[a]?.v;
}
function addr(row: number, col: number): string {
  return XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
}

const LEDGER_MARKERS = ["inward date", "raw material", "pure gold balance", "stock ledger"];
const VENDOR_MARKERS = ["making charges", "sgst", "cgst", "igst", "tax invoice"];

/** "Sr. No." plus a piece identifier. Newer SJ-50s (29.10.2026) have no
 *  "Stock No." column, only "Cust Style No.". */
function isHeaderRow(ws: XLSX.WorkSheet, r: number, lastCol: number): boolean {
  const vals: string[] = [];
  for (let c = 1; c <= Math.min(lastCol, 60); c++) vals.push(cellLower(ws, addr(r, c)));
  return HDR_SR_NO.some((h) => vals.includes(h)) &&
    (HDR_STOCK.some((h) => vals.includes(h)) || HDR_CUST_STYLE.some((h) => vals.includes(h))) &&
    HDR_KT.some((h) => vals.includes(h));
}

interface Block { headerRow: number; endRow: number }

/** Every header row in the sheet; each block runs until the next header. */
function findBlocks(ws: XLSX.WorkSheet, lastRow: number, lastCol: number): Block[] {
  const headers: number[] = [];
  for (let r = 1; r <= lastRow; r++) if (isHeaderRow(ws, r, lastCol)) headers.push(r);
  return headers.map((h, i) => ({ headerRow: h, endRow: (headers[i + 1] ?? lastRow + 1) - 1 }));
}

function sniffWrongFile(ws: XLSX.WorkSheet, lastRow: number, lastCol: number, sheetName: string) {
  let ledger = false; let vendor = false;
  const sn = (sheetName ?? "").toLowerCase();
  if (sn.includes("raw material") || sn.includes("stock ledger") || sn.includes("sale")) ledger = true;
  for (let r = 1; r <= Math.min(lastRow, 60); r++) {
    for (let c = 1; c <= Math.min(lastCol, 40); c++) {
      const v = cellLower(ws, addr(r, c));
      if (!v) continue;
      if (LEDGER_MARKERS.some((m) => v.includes(m))) ledger = true;
      if (VENDOR_MARKERS.some((m) => v.includes(m))) vendor = true;
    }
  }
  return { ledger, vendor };
}

function colMatching(ws: XLSX.WorkSheet, headerRow: number, aliases: string[], lastCol: number): number | null {
  for (let c = 1; c <= lastCol; c++) {
    if (aliases.includes(cellLower(ws, addr(headerRow, c)))) return c;
  }
  return null;
}

function colsMatching(ws: XLSX.WorkSheet, headerRow: number, aliases: string[], lastCol: number): number[] {
  const out: number[] = [];
  for (let c = 1; c <= lastCol; c++) if (aliases.includes(cellLower(ws, addr(headerRow, c)))) out.push(c);
  return out;
}

function detectShapeColumns(ws: XLSX.WorkSheet, headerRow: number, lastCol: number): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const sub = headerRow + 1;
  for (let c = 1; c <= lastCol; c++) {
    const label = (cellValue(ws, addr(headerRow, c)) ?? "").toString().trim();
    if (!label) continue;
    if (SKIP_SHAPES.has(label.toLowerCase()) || isTotalHeader(label)) continue;
    const below = cellLower(ws, addr(sub, c));
    const rightBelow = cellLower(ws, addr(sub, c + 1));
    const pcsWt = HDR_PCS.includes(below) && HDR_WT.includes(rightBelow);
    // 29.10.2026 SJ-50: "Clr Stn" has no Pcs|Wt sub-header — accept a known
    // shape/stone label whose right-hand neighbour header is empty.
    const known = label.trim().toLowerCase().replace(/\s+/g, " ") in SHAPE_CANONICAL || /\b(stn|stone)\b/i.test(label);
    const neighbourEmpty = !cellLower(ws, addr(headerRow, c + 1));
    if (pcsWt || (known && neighbourEmpty && !below)) {
      out.push([normalizeShape(label), c, c + 1]);
    }
  }
  return out;
}

/** The second "Category" column ("Lab Studded", "Semi-Mined", "Mount"…). In the
 *  29.10.2026 SJ-50 it sits under a mislabelled "Bag No" header, so look at the
 *  values, not just the header. */
function detectProductCategoryCol(ws: XLSX.WorkSheet, block: Block, lastCol: number, itemCatCol: number | null): number | null {
  const looksLikeCategory = (c: number) => {
    let hits = 0; let bags = 0; let filled = 0;
    for (let r = block.headerRow + 1; r <= block.endRow; r++) {
      const v = toStr(cellValue(ws, addr(r, c)));
      if (!v || v === "*") continue;
      filled++;
      if (PRODUCT_CATEGORY_RE.test(v)) hits++;
      if (BAG_NO_RE.test(v)) bags++;
    }
    return filled > 0 && bags === 0 && hits / filled >= 0.6;
  };
  const cats = colsMatching(ws, block.headerRow, HDR_CATEGORY, lastCol).filter((c) => c !== itemCatCol);
  for (const c of cats) if (looksLikeCategory(c)) return c;
  for (const c of colsMatching(ws, block.headerRow, HDR_BAG, lastCol)) if (looksLikeCategory(c)) return c;
  return null;
}

/** "2000/gm", "1275", "₹1,275 / g" → 2000 / 1275. */
function parseLabour(v: unknown): Decimal | null {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(v ?? ""));
  if (!m) return null;
  const n = new Decimal(m[1].replace(/,/g, ""));
  return n.gt(0) ? n : null;
}

function parseBlock(ws: XLSX.WorkSheet, block: Block, lastCol: number, source: string): Piece[] {
  const h = block.headerRow;
  const colSrNo = colMatching(ws, h, HDR_SR_NO, lastCol);
  const colStock = colMatching(ws, h, HDR_STOCK, lastCol);
  const colCat = colMatching(ws, h, HDR_CATEGORY, lastCol);
  const colPo = colMatching(ws, h, HDR_CUST_PO, lastCol);
  const colCustStyle = colMatching(ws, h, HDR_CUST_STYLE, lastCol);
  const colIntStyle = colMatching(ws, h, HDR_INT_STYLE, lastCol);
  const colBag = colMatching(ws, h, HDR_BAG, lastCol);
  const colKt = colMatching(ws, h, HDR_KT, lastCol);
  const colCol = colMatching(ws, h, HDR_COL, lastCol);
  const colSize = colMatching(ws, h, HDR_SIZE, lastCol);
  const colQty = colMatching(ws, h, HDR_QTY, lastCol);
  const colGross = colMatching(ws, h, HDR_GROSS, lastCol);
  const colNet = colMatching(ws, h, HDR_NET, lastCol);
  const colDiaQ = colMatching(ws, h, HDR_DIA_Q, lastCol);
  const colRem = colMatching(ws, h, HDR_REMARKS, lastCol);
  const colLabour = colMatching(ws, h, HDR_LABOUR, lastCol);
  const colRegion = colMatching(ws, h, HDR_REGION, lastCol);
  const colProdCat = detectProductCategoryCol(ws, block, lastCol, colCat);
  const colBagReal = colBag && colBag !== colProdCat ? colBag : null;

  if ((!colStock && !colCustStyle) || !colQty || !colGross || !colKt) {
    throw new Error(`${source}: header row ${h} is missing required columns (Stock No or Cust Style No / Qty / Gross Wt / Gold Kt)`);
  }
  const shapeCols = detectShapeColumns(ws, h, lastCol);

  const pieces: Piece[] = [];
  const usedIds = new Map<string, number>();
  // The Pcs|Wt sub-header row has no KT / identifier, so it is skipped below.
  for (let r = h + 1; r <= block.endRow; r++) {
    const stockCell = colStock ? toStr(cellValue(ws, addr(r, colStock))) : null;
    const styleCell = colCustStyle ? toStr(cellValue(ws, addr(r, colCustStyle))) : null;
    const ident = stockCell ?? styleCell;
    if (!ident || ident === "*" || ident === "-" || /^(total|grand total)$/i.test(ident)) continue;
    const ktRaw = toStr(cellValue(ws, addr(r, colKt)));
    if (!ktRaw || ktRaw === "*" || ktRaw === "-") continue;
    // No Stock No. column: use the style no., made unique within the file.
    let stock = stockCell ?? styleCell!.trim();
    if (!stockCell) {
      const n = (usedIds.get(stock) ?? 0) + 1;
      usedIds.set(stock, n);
      if (n > 1) stock = `${stock} #${n}`;
    }
    // A repeated header inside the block range would have been split into its
    // own block; guard anyway so "Gold Kt." can never reach normalizeKt.
    if (HDR_KT.includes(ktRaw.toLowerCase())) continue;
    if (colSrNo && toStr(cellValue(ws, addr(r, colSrNo))) === "*") continue;

    const diamonds: DiamondDetail[] = [];
    for (const [shape, pcsC, wtC] of shapeCols) {
      const pcs = toInt(cellValue(ws, addr(r, pcsC)));
      const cts = toDecimal(cellValue(ws, addr(r, wtC)));
      if (pcs > 0 || cts.gt(0)) diamonds.push({ shape, pcs, cts });
    }

    const piece: Piece = {
      stock_no: stock,
      cust_po: colPo ? toStr(cellValue(ws, addr(r, colPo))) : null,
      cust_style_no: ((colCustStyle && toStr(cellValue(ws, addr(r, colCustStyle)))) || "").trim(),
      internal_style_no: colIntStyle ? toStr(cellValue(ws, addr(r, colIntStyle))) : null,
      bag_no: colBagReal ? toStr(cellValue(ws, addr(r, colBagReal))) : null,
      region: colRegion ? toStr(cellValue(ws, addr(r, colRegion))) : null,
      product_category: colProdCat ? toStr(cellValue(ws, addr(r, colProdCat))) : null,
      labour_rate_inr_per_gm: colLabour ? parseLabour(cellValue(ws, addr(r, colLabour))) : null,
      synthetic_stock: !stockCell,
      kt_raw: ktRaw,
      color_raw: (colCol && toStr(cellValue(ws, addr(r, colCol)))) || "",
      size: colSize ? toStr(cellValue(ws, addr(r, colSize))) : null,
      qty: Math.max(1, toInt(cellValue(ws, addr(r, colQty)))),
      gross_wt: toDecimal(cellValue(ws, addr(r, colGross))),
      net_wt_raw: colNet ? toDecimal(cellValue(ws, addr(r, colNet))) : null,
      diamond_quality_code: colDiaQ ? toStr(cellValue(ws, addr(r, colDiaQ))) : null,
      remarks: colRem ? toStr(cellValue(ws, addr(r, colRem))) : null,
      item_category_raw: (colCat && toStr(cellValue(ws, addr(r, colCat)))) || "",
      source,
      item: "",
      kt: "",
      color: "",
      jewellery_type: "gold_plain",
      semi_mount: false,
      diamonds,
      stones: [],
      studding_raw_pcs: diamonds.reduce((a, d) => a + d.pcs, 0),
      studding_raw_cts: diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0)),
    };
    try {
      applyMappings(piece);
    } catch (e) {
      throw new Error(`${source} row ${r} (stock ${stock}): ${(e as Error).message}`);
    }
    pieces.push(piece);
  }
  return pieces;
}

/** Parse one packing-list file: an SDJ-JB vendor file (only its "Packing List"
 *  sheet — sheet 1, the tax invoice, is ignored) or an SJ-50. */
export async function parseSj50(file: Blob, fileName = (file as File).name ?? "SJ-50"): Promise<Piece[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  const pieces: Piece[] = [];
  let ledger = false; let vendor = false;
  // A workbook with a "Packing List" sheet is read from that sheet alone.
  const packing = wb.SheetNames.filter((n) => /packing\s*list/i.test(n));
  for (const sheetName of packing.length ? packing : wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const ref = ws?.["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    // Vendor files report a huge used range (B2:AC65521); cap the scan.
    const lastRow = Math.min(range.e.r + 1, 5000);
    const lastCol = Math.min(range.e.c + 1, 60);
    const blocks = findBlocks(ws, lastRow, lastCol);
    if (!blocks.length) {
      const s = sniffWrongFile(ws, lastRow, lastCol, sheetName);
      ledger ||= s.ledger; vendor ||= s.vendor;
      continue;
    }
    const label = wb.SheetNames.length > 1 ? `${fileName} › ${sheetName}` : fileName;
    for (const b of blocks) pieces.push(...parseBlock(ws, b, lastCol, label));
  }

  if (pieces.length) return pieces;
  if (ledger) {
    throw new Error(
      "This looks like the running gold stock ledger (e.g. 'SJ-50 updated DD.MM.YYYY cust copy.xls'), " +
      "not a per-shipment packing list. Please upload a file named 'SJ-50 DCJ <date> <N> pcs.xls' instead.",
    );
  }
  if (vendor) {
    throw new Error(
      "This SDJ-JB file has no Packing List sheet (sheet 2). Export it again with the packing list, " +
      "or upload the SJ-50 packing list instead.",
    );
  }
  throw new Error("Could not find a packing-list header row (expecting 'Sr. No.', 'Cust Style No.' / 'Stock No.' and 'Gold Kt.').");
}

/** Parse several files and merge. The same stock number appearing twice
 *  (e.g. the 05.10 block repeated inside the 07.10 file) is kept once. */
export async function parsePackingLists(files: Array<{ file: Blob; name: string }>): Promise<{ pieces: Piece[]; duplicates: string[] }> {
  const seen = new Map<string, Piece>();
  const duplicates: string[] = [];
  for (const { file, name } of files) {
    for (const p of await parseSj50(file, name)) {
      if (seen.has(p.stock_no)) {
        // Real stock numbers are unique, so a repeat is the same piece. Made-up
        // ids (no Stock No. column) are only unique per file — keep both.
        if (!p.synthetic_stock) { duplicates.push(p.stock_no); continue; }
        p.stock_no = `${p.stock_no} (${name})`;
      }
      seen.set(p.stock_no, p);
    }
  }
  if (!seen.size) throw new Error("No pieces parsed from the uploaded files.");
  return { pieces: [...seen.values()], duplicates };
}
