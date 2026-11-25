/** ExcelJS MASTER DETAILS workbook generator.
 *
 * Reproduces the layout of the manual workbooks (EXP535 / EXP553 / EXP570):
 * the same labels, the same relative positions and — most importantly — the
 * same live formula chain, so Accounts can keep tweaking the file by hand:
 *
 *  INVOICE
 *    rows 2–25   header; buyer / bank blocks are IF-chains off a staging
 *                area (Q11 buyer index → S11:AD20, Q24 bank index → S24:AF33)
 *    row 26+     one 19-row block per lot, every number pulled from the
 *                CUSTOMS PL lot TOTAL row
 *    then        totals / freight / C&F / amount in words / payment
 *                instructions / declarations / A/C OF GOLD / PURCHASE
 *                DETAILS ledger / GOLD RATE (E,F) / insurance / exchange rate
 *  CUSTOMS PL
 *    one block per lot, ≥3 rows per piece (one per studding row), with the
 *    full K → P gold chain, AD studding values and the AR → BA MFG chain;
 *    AK = ROUND(BA, 2) is a formula, never a typed number (validator V7).
 *
 * Row numbers depend on lot count, exactly like the manual files (gold rate
 * sits at E164 in EXP535 and E167 in EXP570). Every formula also carries a
 * cached result so viewers that don't recalculate still show the numbers;
 * Excel recalculates on open (fullCalcOnLoad).
 *
 * Deliberate deviations from the manual files: PAN / GST labels are paired
 * with the right numbers (the manual swaps them), C&F subtracts discount and
 * commission (the manual adds them; always 0 in samples), the 700-row
 * state/district list in AF:AL is not copied, and page 2 is a page break
 * instead of a repeated header.
 */
import ExcelJS from "exceljs";
import Decimal from "decimal.js";

import type {
  AppSettings, Bank, Buyer, GoldDrawdown, Lot, PerInvoiceInputs, PieceCalc,
} from "../types";
import { ktNumber, studdingLabel } from "../lib/mappings";
import { pureGoldUsedGm } from "../lib/calculations";

// ───────────────────────── small helpers ─────────────────────────

type Res = number | string | null | undefined;
const num = (x: Decimal | number): number => (typeof x === "number" ? x : x.toNumber());

export function amountInWordsUsd(amount: Decimal): string {
  const cents2 = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const whole = cents2.trunc().toNumber();
  const cents = cents2.sub(whole).mul(100).round().toNumber();
  const words = numToWords(whole).toUpperCase();
  return cents ? `${words} & ${numToWords(cents).toUpperCase()} CENTS ONLY` : `${words} ONLY`;
}

function numToWords(n: number): string {
  if (n === 0) return "zero";
  const u = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
             "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
             "seventeen", "eighteen", "nineteen"];
  const t = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const parts: string[] = [];
  if (n >= 1_000_000) { parts.push(numToWords(Math.floor(n / 1_000_000)), "million"); n %= 1_000_000; }
  if (n >= 1_000) { parts.push(numToWords(Math.floor(n / 1_000)), "thousand"); n %= 1_000; }
  if (n >= 100) { parts.push(u[Math.floor(n / 100)], "hundred"); n %= 100; }
  if (n >= 20) { parts.push(t[Math.floor(n / 10)]); if (n % 10) parts.push(u[n % 10]); }
  else if (n > 0) parts.push(u[n]);
  return parts.filter(Boolean).join(" ");
}

/** ISO yyyy-mm-dd → dd.mm.yyyy (as typed in the manual workbooks). */
export function dotDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso ?? "";
}

const BOLD: Partial<ExcelJS.Font> = { bold: true };
const FMT_WT = "0.000";
const FMT_USD = "#,##0.00";
const FMT_PCT = "0.00%";

class Sheet {
  constructor(readonly ws: ExcelJS.Worksheet) {}
  v(a: string, value: string | number | null | undefined, opts?: { bold?: boolean; fmt?: string; size?: number }) {
    if (value === null || value === undefined || value === "") return;
    const c = this.ws.getCell(a);
    c.value = value;
    if (opts?.bold || opts?.size) c.font = { ...(opts.bold ? BOLD : {}), ...(opts.size ? { size: opts.size } : {}) };
    if (opts?.fmt) c.numFmt = opts.fmt;
  }
  f(a: string, formula: string, result: Res, fmt?: string, bold?: boolean) {
    const c = this.ws.getCell(a);
    c.value = (result === null || result === undefined
      ? { formula }
      : { formula, result }) as ExcelJS.CellFormulaValue;
    if (fmt) c.numFmt = fmt;
    if (bold) c.font = BOLD;
  }
}

/** IF(+Q11=1,+S11,"")&IF(+Q11=2,+S12,"")… — the manual workbook's lookup idiom. */
function ifChain(indexCell: string, col: string, firstRow: number, count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i++) parts.push(`IF(+${indexCell}=${i},+${col}${firstRow + i - 1},"")`);
  return parts.join("&");
}

/** Assign 1..N slots for the staging list, keeping display_index when set. */
function slotted<T extends { id: string; display_index: number | null | undefined }>(rows: T[], selected: T): Array<T & { slot: number }> {
  const list = rows.some((r) => r.id === selected.id) ? rows : [...rows, selected];
  const used = new Set<number>();
  const out: Array<T & { slot: number }> = [];
  for (const r of [...list].sort((a, b) => (a.display_index ?? 999) - (b.display_index ?? 999))) {
    let s = r.display_index && r.display_index > 0 && !used.has(r.display_index) ? r.display_index : 0;
    if (!s) { s = 1; while (used.has(s)) s++; }
    used.add(s);
    out.push({ ...r, slot: s });
  }
  return out;
}

// ───────────────────────── layout ─────────────────────────

const SHAPE_COLS = ["Q", "R", "S", "T", "U", "V", "W"];

interface PieceRows { first: number; n: number }
interface CplLot { start: number; gold: number; header: number; usd: number; pieces: PieceRows[]; total: number }
interface CplLayout { lots: CplLot[]; grand: number; shapes: string[] }

function layoutCustomsPl(lots: Lot[]): CplLayout {
  const shapes: string[] = [];
  for (const l of lots) for (const p of l.pieces) for (const d of p.diamonds) {
    if (!shapes.includes(d.shape)) shapes.push(d.shape);
  }
  const out: CplLot[] = [];
  let s = 8;
  lots.forEach((lot, i) => {
    const extra = i === 0 ? 0 : 1;        // lots ≥2 carry one spacer row (EXP535)
    const gold = s + 3 + extra;
    const header = gold + 1;
    const usd = header + 2;
    let r = usd + 1;
    const pieces: PieceRows[] = lot.pieces.map((p) => {
      const n = Math.max(3, p.diamonds.length + p.stones.length);
      const pr = { first: r, n };
      r += n;
      return pr;
    });
    const total = r + 1;
    out.push({ start: s, gold, header, usd, pieces, total });
    s = total + 2;
  });
  const grand = (out[out.length - 1]?.total ?? 10) + 2;
  return { lots: out, grand, shapes: shapes.slice(0, 7) };
}

const LOT_BLOCK_ROWS = 19;
const FIRST_LOT_ROW = 26;

interface InvLayout {
  lotHead: number[];          // h for each lot
  totals: number;             // "GROSS WT. OF PACKAGE" row
  cf: number;                 // C&F row (O)
  payStart: number;
  declStart: number;
  acct: number;               // "A/C OF GOLD"
  acctRows: number[];
  acctTotal: number;
  purchase: number;
  drawRows: number[];
  balance: number;
  goldBlock: number;          // GOLD PURCHASE FROM row; rate is +1
  goldRate: number;
  fx: number;
}

function layoutInvoice(nLots: number, settings: AppSettings, nDraw: number): InvLayout {
  const lotHead = Array.from({ length: nLots }, (_, i) => FIRST_LOT_ROW + i * LOT_BLOCK_ROWS);
  const totals = FIRST_LOT_ROW + nLots * LOT_BLOCK_ROWS;
  const cf = totals + 6;
  const payStart = totals + 9;
  const declStart = payStart + 1 + settings.payment_instructions.length + 1;
  const acct = declStart + Math.max(1, settings.declarations.length) + 1;
  const acctRows = Array.from({ length: nLots }, (_, i) => acct + 4 + i);
  const acctTotal = acct + 4 + nLots;
  const purchase = acctTotal + 3;
  const drawRows = Array.from({ length: nDraw + 1 }, (_, i) => purchase + 5 + i);
  const balance = purchase + 5 + nDraw + 1;
  const goldBlock = balance + 3;
  return {
    lotHead, totals, cf, payStart, declStart, acct, acctRows, acctTotal,
    purchase, drawRows, balance, goldBlock, goldRate: goldBlock + 1, fx: goldBlock + 10,
  };
}

// ───────────────────────── public API ─────────────────────────

export interface GenerateArgs {
  settings: AppSettings;
  buyer: Buyer;
  bank: Bank;
  /** Full lookup lists for the staging area (defaults to just the selection). */
  buyers?: Buyer[];
  banks?: Bank[];
  inputs: PerInvoiceInputs;
  lots: Lot[];
  totals_usd: Decimal;
  totals_inr: Decimal;
  /** Earlier uses of the same gold purchase (excluding this invoice). */
  drawdowns?: GoldDrawdown[];
}

/** Build the workbook, return a Blob (.xlsx). */
export async function generateXlsx(args: GenerateArgs): Promise<Blob> {
  const wb = buildWorkbook(args);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function buildWorkbook(args: GenerateArgs): ExcelJS.Workbook {
  for (const lot of args.lots) {
    if (!lot.totals || !lot.piece_calcs) throw new Error(`Lot ${lot.lot_no} missing totals; compute first.`);
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "JWY Invoice";
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const inv = wb.addWorksheet("INVOICE", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cpl = wb.addWorksheet("CUSTOMS PL", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const cLay = layoutCustomsPl(args.lots);
  const iLay = layoutInvoice(args.lots.length, args.settings, args.drawdowns?.length ?? 0);

  writeInvoice(new Sheet(inv), args, iLay, cLay);
  writeCustomsPl(new Sheet(cpl), args, iLay, cLay);
  return wb;
}

// ───────────────────────── INVOICE ─────────────────────────

function lotTotalQty(lot: Lot) { return lot.pieces.reduce((a, p) => a + p.qty, 0); }

function writeInvoice(S: Sheet, args: GenerateArgs, L: InvLayout, C: CplLayout) {
  const { settings, inputs, lots } = args;
  const ws = S.ws;
  const widths: Record<string, number> = { A: 2, B: 14, C: 8, D: 12, E: 10, F: 10, G: 11, H: 13, I: 12, J: 6, K: 12, L: 12, M: 10, N: 10, O: 14 };
  for (const [col, w] of Object.entries(widths)) ws.getColumn(col).width = w;
  for (const col of ["Q", "R", "S", "T", "U", "V", "AC", "AD", "AE", "AF"]) ws.getColumn(col).width = 14;
  ws.getColumn("S").width = 28; ws.getColumn("T").width = 40; ws.getColumn("V").width = 40;

  const g = `$E$${L.goldRate}`; const pur = `$F$${L.goldRate}`;
  const goldPerGmPure = inputs.gold_rate_usd_per_troy_oz.div("31.1035");

  // Header
  S.v("B2", "TAX INVOICE", { bold: true, size: 14 });
  S.v("B3", "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF  IGST", { bold: true });
  ws.mergeCells("B2:O2"); ws.mergeCells("B3:O3");
  ws.getCell("B2").alignment = { horizontal: "center" };
  ws.getCell("B3").alignment = { horizontal: "center" };
  S.v("B4", "EXPORTER", { bold: true }); S.v("I4", "INV. NO. & DATE :", { bold: true }); S.v("M4", "IEC NO.", { bold: true });
  S.v("B5", settings.exporter_name, { bold: true });
  S.v("I5", inputs.invoice_number, { bold: true }); S.v("K5", "DT."); S.v("L5", dotDate(inputs.invoice_date), { bold: true });
  S.v("M5", settings.iec_no);
  // exporter address staging (Q5 index → S5)
  S.v("S4", "OUR ADDRESS"); ws.getCell("Q5").value = 0; ws.getCell("R5").value = 0; S.v("S5", settings.exporter_address);
  S.f("B6", `IF(+Q5=0,+S5,"")`, settings.exporter_address);
  ws.getCell("B6").alignment = { wrapText: true, vertical: "top" }; ws.mergeCells("B6:H8");
  S.v("I6", "Buyer's Order No.&Date");
  if (inputs.buyer_order_no) S.v("I7", `${inputs.buyer_order_no}${inputs.buyer_order_date ? " DT. " + dotDate(inputs.buyer_order_date) : ""}`);
  S.v("I8", "Other Reference(s)"); S.v("N8", "PAN NO."); S.v("O8", settings.pan);
  S.v("I9", "LUT/ARN NO."); S.v("K9", `${settings.lut_arn_number} DT. ${settings.lut_arn_date}`);
  S.v("N9", "GST NO."); S.v("O9", settings.gstin);

  // Buyer staging + IF chains
  const buyers = slotted(args.buyers?.length ? args.buyers : [args.buyer], args.buyer);
  const nB = Math.max(10, ...buyers.map((b) => b.slot));
  const sel = buyers.find((b) => b.id === args.buyer.id)!;
  S.v("B10", "CONSIGNEE", { bold: true }); S.v("I10", "Buyer (if other than consignee)", { bold: true });
  S.v("Q10", "CONSIGNEE"); S.v("S10", "CONSIGNEE"); S.v("T10", "ADDRESS"); S.v("AC10", "Port of Discharge"); S.v("AD10", "Final Destination");
  ws.getCell("Q11").value = sel.slot;
  for (let i = 1; i <= nB; i++) ws.getCell(`R${10 + i}`).value = i;
  for (const b of buyers) {
    const r = 10 + b.slot;
    S.v(`S${r}`, b.name); S.v(`T${r}`, b.address); S.v(`AC${r}`, b.city); S.v(`AD${r}`, b.country);
  }
  S.v("Q15", "BUYER");
  S.f("B11", ifChain("Q11", "S", 11, nB), args.buyer.name, undefined, true);
  S.f("B12", ifChain("Q11", "T", 11, nB), args.buyer.address);
  ws.getCell("B12").alignment = { wrapText: true, vertical: "top" }; ws.mergeCells("B12:H16");
  S.f("I11", "B11", args.buyer.name, undefined, true);
  S.f("I12", "B12", args.buyer.address);
  ws.getCell("I12").alignment = { wrapText: true, vertical: "top" }; ws.mergeCells("I12:O16");

  S.v("I17", "Country of Origin of Goods"); S.v("M17", "Country of Final Destination");
  S.v("I18", "INDIA", { bold: true }); S.f("M18", "F25", args.buyer.country, undefined, true);
  S.v("I19", "Terms of Delivery and Payment");
  S.v("B20", "Pre-Carriage by"); S.v("F20", "Place of Receipt by Pre-carrier");
  S.v("I20", "         TERMS:"); S.v("K20", (inputs.terms_override ?? inputs.terms_text ?? args.buyer.default_terms ?? "").toUpperCase(), { bold: true });
  S.v("B21", inputs.pre_carriage_text || "SEQUEL", { bold: true }); S.v("F21", "N.A.");
  S.v("B22", "Vessel/Flight No."); S.v("F22", "Port of Loading");
  S.v("B23", inputs.flight_mode_override || inputs.flight_mode_text || "BY AIR FREIGHT", { bold: true });
  S.v("F23", inputs.port_of_loading_text || "MUMBAI / INDIA", { bold: true });
  S.v("B24", "Port of Discharge"); S.v("F24", "Final Destination");
  S.f("B25", ifChain("Q11", "AC", 11, nB), args.buyer.city, undefined, true);
  S.f("F25", ifChain("Q11", "AD", 11, nB), args.buyer.country, undefined, true);

  // Bank staging + IF chains
  const banks = slotted(args.banks?.length ? args.banks : [args.bank], args.bank);
  const nK = Math.max(10, ...banks.map((b) => b.slot));
  const selBank = banks.find((b) => b.id === args.bank.id)!;
  S.v("S23", "BANK "); S.v("T23", "AD CODE"); S.v("U23", "ACCOUNT NO."); S.v("V23", "ADDRESS"); S.v("AE23", "SWIFT"); S.v("AF23", "IFSC");
  ws.getCell("Q24").value = selBank.slot;
  for (let i = 1; i <= nK; i++) ws.getCell(`R${23 + i}`).value = i;
  for (const b of banks) {
    const r = 23 + b.slot;
    S.v(`S${r}`, b.name); S.v(`T${r}`, b.ad_code); S.v(`U${r}`, b.account_no);
    S.v(`V${r}`, b.address ?? ""); S.v(`AE${r}`, b.swift); S.v(`AF${r}`, b.ifsc);
  }
  S.f("I21", ifChain("Q24", "S", 24, nK), args.bank.name, undefined, true);
  S.f("I22", ifChain("Q24", "V", 24, nK), args.bank.address ?? "");
  ws.getCell("I22").alignment = { wrapText: true, vertical: "top" }; ws.mergeCells("I22:O23");
  S.v("I24", "SWIFT CODE"); S.f("K24", ifChain("Q24", "AE", 24, nK), args.bank.swift);
  S.v("M24", "IFSC CODE"); S.f("O24", ifChain("Q24", "AF", 24, nK), args.bank.ifsc);
  S.v("I25", "AD CODE"); S.f("K25", ifChain("Q24", "T", 24, nK), args.bank.ad_code);
  S.v("M25", "A/C NO."); S.f("O25", ifChain("Q24", "U", 24, nK), args.bank.account_no);

  // Lot blocks
  lots.forEach((lot, i) => {
    const h = L.lotHead[i];
    const c = C.lots[i];
    const t = lot.totals!;
    const kt = ktNumber(lot.kt);
    const rate = goldPerGmPure.div(24).mul(kt).div(inputs.gold_purity);
    const studd = studdingLabel(lot.jewellery_type);
    const studPcs = lot.pieces.reduce((a, p) => a + p.diamonds.reduce((x, d) => x + d.pcs, 0), 0);
    const studCts = lot.pieces.reduce((a, p) => a.add(p.diamonds.reduce((x, d) => x.add(d.cts), new Decimal(0))).add(p.stones.reduce((x, s) => x.add(s.cts), new Decimal(0))), new Decimal(0));
    const studVal = t.diamond_value_usd.add(t.stone_value_usd);
    const goldNet = t.net_wt.mul(rate);
    const goldWaste = t.wastage_wt.mul(rate);

    if (i > 0 && i % 3 === 0) ws.getRow(h - 1).addPageBreak();
    S.v(`B${h}`, "   Marks & Nos./             ", { bold: true });
    S.v(`D${h}`, "No. & Kind of Pkgs.               Description of Goods", { bold: true });
    S.v(`I${h}`, "WEIGHT", { bold: true }); S.v(`L${h}`, "RATE", { bold: true }); S.v(`O${h}`, "AMOUNT", { bold: true });
    S.v(`B${h + 1}`, `${settings.container_prefix} ${inputs.container_number}`);
    S.v(`D${h + 1}`, settings.tin_box_text);
    const hsn = Number(lot.hsn_code);
    S.v(`G${h + 1}`, Number.isFinite(hsn) ? hsn : lot.hsn_code, { bold: true });
    S.v(`B${h + 2}`, `LOT NO ${lot.lot_no}`, { bold: true });
    S.v(`D${h + 2}`, lot.description, { bold: true });
    S.v(`I${h + 3}`, "GROSS  WT. GMS.", { bold: true }); S.v(`L${h + 3}`, "US $ / GM", { bold: true }); S.v(`O${h + 3}`, "US$", { bold: true });
    S.v(`B${h + 4}`, "ITEM", { bold: true }); S.v(`D${h + 4}`, "KT", { bold: true }); S.v(`E${h + 4}`, "QTY.", { bold: true });
    S.v(`F${h + 4}`, "UOM", { bold: true }); S.v(`H${h + 4}`, settings.handcrafted_text, { bold: true });
    S.f(`I${h + 4}`, `'CUSTOMS PL'!J${c.total}`, num(t.gross_wt), FMT_WT);

    // one item row per item type (EXP553 lot 3: RING ×3 + PENDANT ×1)
    const items = new Map<string, number>();
    for (const p of lot.pieces) items.set(p.item, (items.get(p.item) ?? 0) + p.qty);
    if (items.size > 4) throw new Error(`Lot ${lot.lot_no} has ${items.size} item types; the invoice block fits 4.`);
    [...items.entries()].forEach(([item, qty], k) => {
      S.v(`B${h + 5 + k}`, item); S.v(`D${h + 5 + k}`, kt); S.v(`E${h + 5 + k}`, qty); S.v(`F${h + 5 + k}`, "PCS");
    });
    S.v(`I${h + 5}`, "NET WT. GMS.", { bold: true });
    S.f(`I${h + 6}`, `'CUSTOMS PL'!K${c.total}`, num(t.net_wt), FMT_WT);
    S.f(`L${h + 6}`, `${g}/31.1035/24*D${h + 5}/${pur}`, num(rate), FMT_USD);
    S.f(`O${h + 6}`, `I${h + 6}*L${h + 6}`, num(goldNet), FMT_USD);
    S.v(`I${h + 7}`, "WASTAGE ", { bold: true });
    S.v(`K${h + 7}`, num(lot.wastage_pct), { fmt: FMT_PCT });
    S.f(`I${h + 8}`, `I${h + 6}*K${h + 7}`, num(t.wastage_wt), FMT_WT);
    S.f(`L${h + 8}`, `${g}/31.1035/24*D${h + 5}/${pur}`, num(rate), FMT_USD);
    S.f(`O${h + 8}`, `I${h + 8}*L${h + 8}`, num(goldWaste), FMT_USD);
    S.v(`B${h + 9}`, "TOTAL", { bold: true });
    S.f(`E${h + 9}`, `SUM(E${h + 5}:E${h + 8})`, lotTotalQty(lot), undefined, true);

    S.v(`B${h + 11}`, "DETAILS OF STUDDING", { bold: true });
    S.v(`B${h + 12}`, "STUDD TYPE", { bold: true }); S.v(`D${h + 12}`, "PCS", { bold: true });
    S.v(`F${h + 12}`, "WT (CTS.)", { bold: true }); S.v(`H${h + 12}`, "TOTAL US$", { bold: true });
    S.v(`B${h + 13}`, studd.invoice);
    S.f(`D${h + 13}`, `SUM('CUSTOMS PL'!Q${c.total}:W${c.total})`, studPcs);
    S.f(`F${h + 13}`, `'CUSTOMS PL'!AB${c.total}+'CUSTOMS PL'!AH${c.total}`, num(studCts), "0.00");
    S.f(`H${h + 13}`, `'CUSTOMS PL'!AD${c.total}+'CUSTOMS PL'!AJ${c.total}`, num(studVal), FMT_USD);
    S.v(`L${h + 13}`, "COST OF GOLD", { bold: true });
    S.f(`O${h + 13}`, `O${h + 6}+O${h + 8}`, num(t.gold_value_usd), FMT_USD);
    S.f(`L${h + 14}`, `O${h + 14}/(O${h + 13}+O${h + 15})`, num(t.value_addition_ratio), FMT_PCT);
    S.v(`M${h + 14}`, "MFG. COST", { bold: true });
    S.f(`O${h + 14}`, `'CUSTOMS PL'!AK${c.total}`, num(t.mfg_cost_usd), FMT_USD);
    S.v(`L${h + 15}`, "COST OF STUDDING", { bold: true });
    S.f(`O${h + 15}`, `H${h + 17}`, num(studVal), FMT_USD);
    S.v(`L${h + 16}`, ` TOTAL LOT NO. ${lot.lot_no}`, { bold: true });
    S.f(`O${h + 16}`, `SUM(O${h + 13}:O${h + 15})`, num(t.total_usd), FMT_USD, true);
    S.v(`B${h + 17}`, "TOTAL ", { bold: true });
    S.f(`D${h + 17}`, `SUM(D${h + 13}:D${h + 16})`, studPcs, undefined, true);
    S.f(`F${h + 17}`, `SUM(F${h + 13}:F${h + 16})`, num(studCts), "0.00", true);
    S.f(`H${h + 17}`, `SUM(H${h + 13}:H${h + 16})`, num(studVal), FMT_USD, true);
  });

  // Totals
  const t0 = L.totals;
  const lotsSum = lots.reduce((a, l) => a.add(l.totals!.total_usd), new Decimal(0));
  const grandCts = lots.reduce((a, l) => a.add(l.pieces.reduce((x, p) => x.add(p.diamonds.reduce((y, d) => y.add(d.cts), new Decimal(0))), new Decimal(0))), new Decimal(0));
  S.v(`B${t0}`, "GROSS WT. OF PACKAGE", { bold: true });
  S.v(`F${t0}`, num(inputs.package_gross_wt_kg), { fmt: "0.00" }); S.v(`H${t0}`, "KGS");
  S.v(`L${t0}`, `TOTAL COST (LOT+${lots.map((l) => l.lot_no).join("+")})`, { bold: true });
  S.f(`O${t0}`, L.lotHead.map((h) => `O${h + 16}`).join("+"), num(lotsSum), FMT_USD, true);
  S.v(`B${t0 + 1}`, "STATE CODE OF ORIGIN OF GOODS :", { bold: true });
  S.v(`G${t0 + 1}`, settings.state_code); S.v(`H${t0 + 1}`, settings.state_name);
  S.v(`I${t0 + 1}`, "DIAMONDS STUDDING WT IN CTS:");
  S.v(`L${t0 + 1}`, "FREIGHT"); S.v(`O${t0 + 1}`, num(inputs.freight_usd), { fmt: FMT_USD });
  S.v(`B${t0 + 2}`, "DISTRICT OF ORIGIN OF GOODS       :", { bold: true });
  S.v(`G${t0 + 2}`, settings.district_code); S.v(`H${t0 + 2}`, settings.district_name);
  S.f(`I${t0 + 2}`, `'CUSTOMS PL'!AB${C.grand}`, num(grandCts), "0.00");
  S.v(`L${t0 + 2}`, "INSURANCE"); S.v(`O${t0 + 2}`, num(inputs.insurance_usd), { fmt: FMT_USD });
  S.v(`B${t0 + 3}`, "DETAILS OF PREFERENTIAL AGREEMENT:", { bold: true });
  S.v(`G${t0 + 3}`, inputs.preferential_agreement_override ?? inputs.preferential_agreement_text ?? args.buyer.default_preferential_agreement ?? "", { bold: true });
  S.v(`L${t0 + 3}`, "COMMISSION"); S.v(`O${t0 + 3}`, num(inputs.commission_usd), { fmt: FMT_USD });
  S.v(`B${t0 + 4}`, "STANDARD UNIT QUANTITY CODE:", { bold: true }); S.v(`G${t0 + 4}`, " KGS");
  S.v(`M${t0 + 4}`, "DISCOUNT"); S.v(`O${t0 + 4}`, num(inputs.discount_usd), { fmt: FMT_USD });
  S.v(`L${t0 + 5}`, "ADD OTHER CHARGES"); ws.getCell(`O${t0 + 5}`).value = 0;
  S.v(`B${L.cf}`, "Amount Chargable in words", { bold: true }); S.v(`N${L.cf}`, "C&F", { bold: true });
  S.f(`O${L.cf}`, `O${t0}+O${t0 + 1}+O${t0 + 2}-O${t0 + 3}-O${t0 + 4}+O${t0 + 5}`, num(args.totals_usd), FMT_USD, true);
  S.f(`B${L.cf + 1}`, `N${L.cf}`, "C&F", undefined, true); S.v(`C${L.cf + 1}`, "US$:", { bold: true });
  S.v(`D${L.cf + 1}`, amountInWordsUsd(args.totals_usd), { bold: true });

  // Signature (page 1) + payment instructions + declarations
  S.v(`N${L.payStart}`, settings.signatory_block_1, { bold: true });
  S.v(`N${L.payStart + 4}`, settings.signatory_block_2, { bold: true });
  S.v(`N${L.payStart + 5}`, settings.signatory_name, { bold: true });
  S.v(`B${L.payStart}`, "PAYMENT  INSTRATION ", { bold: true });
  settings.payment_instructions.forEach((line, i) => S.v(`C${L.payStart + 1 + i}`, line));
  settings.declarations.forEach((line, i) => S.v(`C${L.declStart + i}`, /^[•·]/.test(line.trim()) ? line : `• ${line}`));

  // A/C OF GOLD
  const a = L.acct;
  S.v(`B${a}`, "A/C OF GOLD", { bold: true });
  S.v(`B${a + 1}`, "KIND  ", { bold: true }); S.v(`D${a + 1}`, " KT", { bold: true }); S.v(`E${a + 1}`, "GROSS WT GMS", { bold: true });
  S.v(`G${a + 1}`, "NET WT GMS.", { bold: true }); S.v(`H${a + 1}`, "PURE GMS. GOLD", { bold: true });
  S.f(`I${a + 1}`, `F${L.goldRate}`, num(inputs.gold_purity));
  S.v(`K${a + 1}`, "WASTAGE  %", { bold: true }); S.v(`L${a + 1}`, "WASTAGE WT.", { bold: true });
  S.v(`M${a + 1}`, "TOTAL GMS. GOLD", { bold: true }); S.v(`O${a + 1}`, "GOLD VALUE  US$", { bold: true });
  S.v(`I${a + 3}`, " GMS.");
  let pureSum = new Decimal(0); let pureNoWasteSum = new Decimal(0); let pureKtSum = new Decimal(0);
  lots.forEach((lot, i) => {
    const r = L.acctRows[i]; const h = L.lotHead[i]; const t = lot.totals!;
    const kt = ktNumber(lot.kt);
    const ktPure = t.net_wt.div(24).mul(kt);
    const pure = ktPure.div(inputs.gold_purity);
    const used = pureGoldUsedGm(lot, inputs.gold_purity);
    pureSum = pureSum.add(used); pureNoWasteSum = pureNoWasteSum.add(pure); pureKtSum = pureKtSum.add(ktPure);
    S.v(`B${r}`, lot.jewellery_type === "gold_mounting" ? "GOLD/MOUNT" : lot.jewellery_type === "gold_plain" ? "GOLD/PLAIN" : "GOLD/STUDDED");
    S.v(`D${r}`, kt);
    S.f(`E${r}`, `I${h + 4}`, num(t.gross_wt), FMT_WT);
    S.f(`G${r}`, `I${h + 6}`, num(t.net_wt), FMT_WT);
    S.f(`H${r}`, `G${r}/24*D${r}`, num(ktPure), FMT_WT);
    S.f(`I${r}`, `H${r}/I${a + 1}`, num(pure), FMT_WT);
    S.f(`K${r}`, `K${h + 7}`, num(lot.wastage_pct), FMT_PCT);
    S.f(`L${r}`, `I${r}*K${r}`, num(pure.mul(lot.wastage_pct)), FMT_WT);
    S.f(`M${r}`, `I${r}+L${r}`, num(used), FMT_WT);
    S.f(`O${r}`, `${g}/31.1035*M${r}`, num(goldPerGmPure.mul(used)), FMT_USD);
  });
  const at = L.acctTotal; const ar0 = L.acctRows[0]; const ar1 = L.acctRows[L.acctRows.length - 1];
  const grossAll = lots.reduce((x, l) => x.add(l.totals!.gross_wt), new Decimal(0));
  const netAll = lots.reduce((x, l) => x.add(l.totals!.net_wt), new Decimal(0));
  S.v(`B${at}`, "TOTAL", { bold: true });
  S.f(`E${at}`, `SUM(E${ar0}:E${ar1})`, num(grossAll), FMT_WT, true);
  S.f(`G${at}`, `SUM(G${ar0}:G${ar1})`, num(netAll), FMT_WT, true);
  S.f(`H${at}`, `SUM(H${ar0}:H${ar1})`, num(pureKtSum), FMT_WT, true);
  S.f(`I${at}`, `SUM(I${ar0}:I${ar1})`, num(pureNoWasteSum), FMT_WT, true);
  S.f(`L${at}`, `SUM(L${ar0}:L${ar1})`, num(pureSum.sub(pureNoWasteSum)), FMT_WT, true);
  S.f(`M${at}`, `SUM(M${ar0}:M${ar1})`, num(pureSum), FMT_WT, true);
  S.f(`O${at}`, `SUM(O${ar0}:O${ar1})`, num(goldPerGmPure.mul(pureSum)), FMT_USD, true);

  // PURCHASE DETAILS ledger
  const p = L.purchase;
  S.v(`G${p}`, "PURCHASE DETAILS", { bold: true });
  S.v(`G${p + 1}`, `PARTY NAME : ${inputs.gold_purchase_party}`);
  S.v(`G${p + 2}`, `DATE : ${dotDate(inputs.gold_purchase_date)} & INV NO. ${inputs.gold_purchase_invoice_no}`);
  S.v(`G${p + 3}`, "OPENING STOCK");
  if (inputs.gold_opening_stock_gm) S.v(`I${p + 3}`, num(inputs.gold_opening_stock_gm), { fmt: FMT_WT });
  S.v(`G${p + 4}`, "DATE", { bold: true }); S.v(`H${p + 4}`, "EXP INVOICE NO.", { bold: true }); S.v(`I${p + 4}`, "USE (GMS)", { bold: true });
  const draws = args.drawdowns ?? [];
  draws.forEach((d, i) => {
    const r = L.drawRows[i];
    S.v(`G${r}`, dotDate(d.exp_date)); S.v(`H${r}`, d.exp_number); S.v(`I${r}`, d.quantity_gm, { fmt: FMT_WT });
  });
  const thisRow = L.drawRows[draws.length];
  const usedRounded = pureSum.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  S.v(`G${thisRow}`, dotDate(inputs.invoice_date)); S.v(`H${thisRow}`, inputs.invoice_number);
  S.f(`I${thisRow}`, `ROUND(M${at},3)`, num(usedRounded), FMT_WT);
  S.v(`G${L.balance}`, "BALANCE", { bold: true });
  if (inputs.gold_opening_stock_gm) {
    const usedAll = draws.reduce((x, d) => x.add(d.quantity_gm), new Decimal(0)).add(usedRounded);
    S.f(`I${L.balance}`, `I${p + 3}-SUM(I${L.drawRows[0]}:I${thisRow})`, num(inputs.gold_opening_stock_gm.sub(usedAll)), FMT_WT, true);
  }

  // Gold rate + insurance + declaration + exchange rate
  const gb = L.goldBlock;
  S.v(`B${gb}`, `GOLD PURCHASE FROM : ${inputs.gold_purchase_party}`, { bold: true });
  S.v(`E${gb}`, `INVOICE NO. ${inputs.gold_purchase_invoice_no} DTD. ${dotDate(inputs.gold_purchase_date)}`, { bold: true });
  S.v(`B${L.goldRate}`, "GOLD RATE", { bold: true });
  S.v(`E${L.goldRate}`, num(inputs.gold_rate_usd_per_troy_oz), { fmt: "0.0000", bold: true });
  S.v(`F${L.goldRate}`, num(inputs.gold_purity), { fmt: "0.000", bold: true });
  S.v(`N${gb + 2}`, settings.signatory_block_1, { bold: true });
  S.v(`B${gb + 4}`, "INSURANCE COVERED DOOR TO DOOR BY", { bold: true });
  S.v(`F${gb + 4}`, inputs.pre_carriage_text || "SEQUEL", { bold: true });
  S.v(`B${gb + 5}`, "Declaration :", { bold: true });
  S.v(`B${gb + 6}`, "We declare that this Invoice shows  the actual price of the goods  ");
  S.v(`N${gb + 6}`, settings.signatory_block_2, { bold: true });
  S.v(`B${gb + 7}`, "described and that all particulars  are  true and correct.");
  S.v(`N${gb + 7}`, settings.signatory_name, { bold: true });
  S.v(`C${L.fx}`, "Exchange Rate", { bold: true });
  S.v(`E${L.fx}`, num(inputs.inr_usd_rate), { fmt: "0.00" });
  S.f(`H${L.fx}`, `O${L.cf}*E${L.fx}`, num(args.totals_inr), FMT_USD);

  ws.pageSetup.printArea = `A1:O${L.fx + 1}`;
}

// ───────────────────────── CUSTOMS PL ─────────────────────────

const CPL_HEADERS: Array<[string, string]> = [
  ["C", "Sr.  No."], ["D", "STYLE #"], ["E", "ITEM"], ["F", "KT"], ["G", "COLOR"], ["H", "QTY."],
  ["I", "UOM"], ["J", "GROSS WT. GMS"], ["K", "GOLD  NET WT. GMS"], ["L", "WASTAGE % & WEIGHT"],
  ["N", "NET GOLD + WASTAGE WT. GMS."], ["O", "GOLD RATE "], ["P", "GOLD VALUE"],
  ["X", "CERTIFICATE LAB & NO"], ["Y", "DIA DETAILS"], ["Z", "DIA LAB & CERTIFICATE NO"],
  ["AA", "DIA COLOR & QLTY."], ["AB", "DIAM. CTS"], ["AC", "DIA. RATE"], ["AD", "DIA. VALUE"],
  ["AE", "STONE TYPE"], ["AF", "SHAPE"], ["AG", "PCS"], ["AH", "STONE CTS."], ["AI", "STONE RATE"],
  ["AJ", "STONE  VALUE"], ["AK", "TOTAL MFG. COST "], ["AL", "TOTAL COST"], ["AM", "MEKING "],
  ["AR", "BASE GOLD LOCK"], ["AS", "GOLD − LOCK"], ["AT", "LABOUR ₹/GM"], ["AU", "LABOUR FX"],
  ["AV", "LABOUR $/GM"], ["AW", "LABOUR $"], ["AY", "SUB-TOTAL"], ["AZ", "ADD-ON $"], ["BA", "MFG $"],
];

function writeCustomsPl(S: Sheet, args: GenerateArgs, L: InvLayout, C: CplLayout) {
  const { lots, inputs, settings } = args;
  const ws = S.ws;
  ws.getColumn("A").width = 4; ws.getColumn("B").width = 2; ws.getColumn("C").width = 6;
  ws.getColumn("D").width = 20; ws.getColumn("E").width = 10; ws.getColumn("G").width = 16;
  for (const col of ["J", "K", "L", "M", "N", "O", "P"]) ws.getColumn(col).width = 11;
  for (const col of SHAPE_COLS) ws.getColumn(col).width = 8;
  ws.getColumn("X").width = 18; ws.getColumn("Y").width = 16; ws.getColumn("AA").width = 14;
  for (const col of ["AB", "AC", "AD", "AK", "AL", "AR", "AS", "AT", "AU", "AV", "AW", "AY", "AZ", "BA"]) ws.getColumn(col).width = 11;

  const g = `INVOICE!$E$${L.goldRate}`; const pur = `INVOICE!$F$${L.goldRate}`;
  S.v("C4", "PACKING LIST", { bold: true, size: 14 });

  lots.forEach((lot, li) => {
    const c = C.lots[li];
    const h = L.lotHead[li];
    const calcs = lot.piece_calcs!;
    const t = lot.totals!;
    const first = li === 0;

    S.v(`C${c.start}`, "CUSTOMS VALUE ADDITION OF INVOICE # :- ", { bold: true });
    S.f(`G${c.start}`, first ? "INVOICE!I5" : `G${C.lots[0].start}`, inputs.invoice_number, undefined, true);
    S.v(`J${c.start}`, "DATE :", { bold: true });
    S.f(`K${c.start}`, first ? "INVOICE!L5" : `K${C.lots[0].start}`, dotDate(inputs.invoice_date), undefined, true);
    S.f(`C${c.start + 1}`, `INVOICE!B${h + 2}`, `LOT NO ${lot.lot_no}`, undefined, true);
    S.f(`E${c.start + 1}`, `INVOICE!D${h + 2}`, lot.description, undefined, true);
    S.v(`C${c.start + 2}`, "CUSTOMER NAME & NO. :- ", { bold: true });
    S.f(`E${c.start + 2}`, first ? "INVOICE!B11" : `E${C.lots[0].start + 2}`, args.buyer.name, undefined, true);
    S.v(`K${c.gold}`, "GOLD", { bold: true });
    S.v(`Q${c.gold}`, studdingLabel(lot.jewellery_type).customs, { bold: true });
    S.v(`AF${c.gold}`, "PRE- STONE ", { bold: true });
    for (const [col, label] of CPL_HEADERS) {
      const cell = ws.getCell(`${col}${c.header}`);
      cell.value = label; cell.font = BOLD; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
    C.shapes.forEach((shape, k) => {
      const cell = ws.getCell(`${SHAPE_COLS[k]}${c.header}`);
      cell.value = shape; cell.font = BOLD; cell.alignment = { horizontal: "center", wrapText: true };
    });
    ws.getRow(c.header).height = 42;
    S.f(`AO${c.header}`, `INVOICE!L${h + 14}`, num(t.value_addition_ratio), FMT_PCT);
    for (const col of ["O", "P", "AC", "AD", "AI", "AJ", "AK", "AL"]) S.v(`${col}${c.usd}`, "US$", { bold: true });
    if (first) S.v(`AY${c.usd}`, "FINAL");

    lot.pieces.forEach((p, pi) => {
      const { first: r, n } = c.pieces[pi];
      const last = r + n - 1;
      const k: PieceCalc = calcs[pi];
      if (pi === 0) ws.getCell(`A${r}`).value = lot.lot_no;
      if (pi === 0) ws.getCell(`C${r}`).value = 1;
      else S.f(`C${r}`, `C${c.pieces[pi - 1].first}+1`, pi + 1);
      S.v(`D${r}`, p.cust_style_no || p.stock_no); S.v(`E${r}`, p.item); S.v(`F${r}`, ktNumber(p.kt));
      S.v(`G${r}`, p.color); S.v(`H${r}`, p.qty); S.v(`I${r}`, "PCS");
      S.v(`J${r}`, num(p.gross_wt), { fmt: FMT_WT });
      S.f(`K${r}`, `J${r}-(SUM(AB${r}:AB${last})/5+SUM(AH${r}:AH${last})/5)`, num(k.net_wt), FMT_WT);
      S.v(`L${r}`, num(lot.wastage_pct), { fmt: FMT_PCT });
      S.f(`M${r}`, `K${r}*L${r}`, num(k.wastage_wt), FMT_WT);
      S.f(`N${r}`, `K${r}+M${r}`, num(k.net_plus_wastage), FMT_WT);
      S.f(`O${r}`, `${g}/31.1035/24*F${r}/${pur}`, num(k.gold_rate_per_gm), FMT_USD);
      S.f(`P${r}`, `N${r}*O${r}`, num(k.gold_value), FMT_USD);

      p.diamonds.forEach((d, j) => {
        const rr = r + j;
        const si = C.shapes.indexOf(d.shape);
        const col = SHAPE_COLS[si >= 0 ? si : SHAPE_COLS.length - 1];
        const cell = ws.getCell(`${col}${rr}`);
        cell.value = (typeof cell.value === "number" ? cell.value : 0) + d.pcs;
        S.v(`X${rr}`, d.certificate_no ?? undefined);
        S.v(`Y${rr}`, d.origin ?? undefined);
        S.v(`AA${rr}`, d.color_clarity ?? undefined);
        S.v(`AB${rr}`, num(d.cts), { fmt: "0.00" });
        if (d.rate_usd_per_ct) S.v(`AC${rr}`, num(d.rate_usd_per_ct), { fmt: FMT_USD });
      });
      p.stones.forEach((s, j) => {
        const rr = r + p.diamonds.length + j;
        if (rr > last) return;
        S.v(`AE${rr}`, s.stone_type); S.v(`AF${rr}`, s.shape ?? undefined); S.v(`AG${rr}`, s.pcs);
        S.v(`AH${rr}`, num(s.cts), { fmt: "0.00" });
        if (s.rate_usd_per_ct) S.v(`AI${rr}`, num(s.rate_usd_per_ct), { fmt: FMT_USD });
      });
      for (let rr = r; rr <= last; rr++) {
        const d = p.diamonds[rr - r];
        const s = p.stones[rr - r - p.diamonds.length];
        S.f(`AD${rr}`, `AB${rr}*AC${rr}`, d?.rate_usd_per_ct ? num(d.rate_usd_per_ct.mul(d.cts)) : 0, FMT_USD);
        S.f(`AJ${rr}`, `ROUND(AI${rr}*AH${rr},2)`, s?.rate_usd_per_ct ? num(s.rate_usd_per_ct.mul(s.cts).toDecimalPlaces(2)) : 0, FMT_USD);
      }

      S.f(`AK${r}`, `ROUND(BA${r},2)`, num(k.mfg), FMT_USD);
      S.f(`AL${r}`, `P${r}+SUM(AD${r}:AD${last})+SUM(AJ${r}:AJ${last})+AK${r}`, num(k.total), FMT_USD);
      if (k.base_lock_auto) {
        const ar = `${k.base_lock_net_wt.toFixed(2)}*${k.base_lock_touch.toString()}*${inputs.base_gold_rate_usd_per_gm.toString()}`;
        S.f(`AR${r}`, k.base_lock_rounded ? `ROUND(${ar},2)` : ar, num(k.base_lock), FMT_USD);
      } else {
        S.v(`AR${r}`, num(k.base_lock), { fmt: FMT_USD });
      }
      S.f(`AS${r}`, `P${r}-AR${r}`, num(k.residual), FMT_USD);
      S.v(`AT${r}`, num(k.labour_rate_inr));
      S.v(`AU${r}`, num(k.labour_fx));
      S.f(`AV${r}`, `AT${r}/AU${r}`, num(k.labour_usd_per_gm), "0.0000");
      S.f(`AW${r}`, `K${r}*AV${r}`, num(k.labour_cost), FMT_USD);
      S.f(`AY${r}`, `AS${r}+AW${r}`, num(k.residual.add(k.labour_cost)), FMT_USD);
      S.v(`AZ${r}`, num(k.addon));
      S.f(`BA${r}`, `AY${r}+AZ${r}`, num(k.mfg_unrounded), FMT_USD);
    });

    // Lot TOTAL row
    const T = c.total;
    const r0 = c.pieces[0].first;
    const r1 = T - 1;
    const sumCol = (col: string, result: Res, fmt?: string) => S.f(`${col}${T}`, `SUM(${col}${r0}:${col}${r1})`, result, fmt, true);
    S.v(`C${T}`, "TOTAL", { bold: true });
    sumCol("H", lotTotalQty(lot));
    sumCol("J", num(t.gross_wt), FMT_WT);
    sumCol("K", num(t.net_wt), FMT_WT);
    sumCol("M", num(t.wastage_wt), FMT_WT);
    sumCol("N", num(t.net_wt.add(t.wastage_wt)), FMT_WT);
    sumCol("P", num(t.gold_value_usd), FMT_USD);
    C.shapes.forEach((shape, k) => {
      const pcs = lot.pieces.reduce((a, p) => a + p.diamonds.filter((d) => d.shape === shape).reduce((x, d) => x + d.pcs, 0), 0);
      sumCol(SHAPE_COLS[k], pcs);
    });
    const cts = lot.pieces.reduce((a, p) => a.add(p.diamonds.reduce((x, d) => x.add(d.cts), new Decimal(0))), new Decimal(0));
    const stCts = lot.pieces.reduce((a, p) => a.add(p.stones.reduce((x, s) => x.add(s.cts), new Decimal(0))), new Decimal(0));
    sumCol("AB", num(cts), "0.00");
    sumCol("AD", num(t.diamond_value_usd), FMT_USD);
    sumCol("AG", lot.pieces.reduce((a, p) => a + p.stones.reduce((x, s) => x + s.pcs, 0), 0));
    sumCol("AH", num(stCts), "0.00");
    sumCol("AJ", num(t.stone_value_usd), FMT_USD);
    sumCol("AK", num(t.mfg_cost_usd), FMT_USD);
    sumCol("AL", num(t.total_usd), FMT_USD);
  });

  // GRAND TOTAL
  const G = C.grand;
  const totRows = C.lots.map((l) => l.total);
  const plus = (col: string) => totRows.map((r) => `${col}${r}`).join("+");
  const tot = (f: (l: Lot) => Decimal | number) => lots.reduce((a, l) => a.add(f(l) as Decimal.Value), new Decimal(0));
  S.v(`C${G}`, "GRAND TOTAL", { bold: true });
  S.f(`H${G}`, plus("H"), num(tot(lotTotalQty)), undefined, true);
  S.f(`J${G}`, plus("J"), num(tot((l) => l.totals!.gross_wt)), FMT_WT, true);
  S.f(`K${G}`, plus("K"), num(tot((l) => l.totals!.net_wt)), FMT_WT, true);
  S.f(`M${G}`, plus("M"), num(tot((l) => l.totals!.wastage_wt)), FMT_WT, true);
  S.f(`N${G}`, plus("N"), num(tot((l) => l.totals!.net_wt.add(l.totals!.wastage_wt))), FMT_WT, true);
  S.f(`P${G}`, plus("P"), num(tot((l) => l.totals!.gold_value_usd)), FMT_USD, true);
  C.shapes.forEach((shape, k) => {
    const pcs = lots.reduce((a, l) => a + l.pieces.reduce((b, p) => b + p.diamonds.filter((d) => d.shape === shape).reduce((x, d) => x + d.pcs, 0), 0), 0);
    S.f(`${SHAPE_COLS[k]}${G}`, plus(SHAPE_COLS[k]), pcs, undefined, true);
  });
  S.f(`AB${G}`, plus("AB"), num(tot((l) => l.pieces.reduce((a, p) => a.add(p.diamonds.reduce((x, d) => x.add(d.cts), new Decimal(0))), new Decimal(0)))), "0.00", true);
  S.f(`AD${G}`, plus("AD"), num(tot((l) => l.totals!.diamond_value_usd)), FMT_USD, true);
  S.f(`AJ${G}`, plus("AJ"), num(tot((l) => l.totals!.stone_value_usd)), FMT_USD, true);
  S.f(`AK${G}`, plus("AK"), num(tot((l) => l.totals!.mfg_cost_usd)), FMT_USD, true);
  S.f(`AL${G}`, plus("AL"), num(tot((l) => l.totals!.total_usd)), FMT_USD, true);

  S.v(`AK${G + 2}`, settings.signatory_block_1, { bold: true });
  S.v(`AK${G + 6}`, settings.signatory_block_2, { bold: true });
  S.v(`AK${G + 7}`, settings.signatory_name, { bold: true });
  ws.views = [{ state: "frozen", xSplit: 4, ySplit: 0 }];
  ws.pageSetup.printArea = `A1:AM${G + 8}`;
}
