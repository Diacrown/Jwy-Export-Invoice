/** ExcelJS-based master-details workbook generator.
 *
 * Writes INVOICE + CUSTOMS PL sheets with live formulas at the same cell
 * addresses the current manual workbook uses. Returns a Blob suitable for
 * upload to Supabase Storage and for direct download.
 */
import ExcelJS from "exceljs";
import Decimal from "decimal.js";

import type {
  AppSettings, Bank, Buyer, Lot, PerInvoiceInputs,
} from "../types";

function dec(x: Decimal | number): number {
  return typeof x === "number" ? x : x.toNumber();
}

function amountInWordsUsd(amount: Decimal): string {
  // Thin num2words — handles 0..999,999 inclusive for typical invoice amounts.
  const whole = Math.trunc(amount.toNumber());
  const cents = Math.round(amount.minus(whole).mul(100).toNumber());
  const words = numToWords(whole).toUpperCase();
  return cents ? `${words} & ${numToWords(cents).toUpperCase()} CENTS ONLY`
               : `${words} ONLY`;
}

function numToWords(n: number): string {
  if (n === 0) return "zero";
  const u = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
             "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
             "seventeen", "eighteen", "nineteen"];
  const t = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const parts: string[] = [];
  if (n >= 1_000_000) {
    parts.push(numToWords(Math.floor(n / 1_000_000)), "million");
    n %= 1_000_000;
  }
  if (n >= 1_000) {
    parts.push(numToWords(Math.floor(n / 1_000)), "thousand");
    n %= 1_000;
  }
  if (n >= 100) {
    parts.push(u[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    parts.push(t[Math.floor(n / 10)]);
    if (n % 10) parts.push(u[n % 10]);
  } else if (n > 0) {
    parts.push(u[n]);
  }
  return parts.filter(Boolean).join(" ");
}

export interface GenerateArgs {
  settings: AppSettings;
  buyer: Buyer;
  bank: Bank;
  inputs: PerInvoiceInputs;
  lots: Lot[];
  totals_usd: Decimal;
  totals_inr: Decimal;
}

/** Build the workbook, return a Blob (.xlsx). */
export async function generateXlsx(args: GenerateArgs): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "JWY Invoice";
  wb.created = new Date();

  const inv = wb.addWorksheet("INVOICE");
  const cpl = wb.addWorksheet("CUSTOMS PL");

  writeInvoiceSheet(inv, args);
  writeCustomsPlSheet(cpl, args);

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ───────────────────────── INVOICE sheet ─────────────────────────

function writeInvoiceSheet(inv: ExcelJS.Worksheet, args: GenerateArgs): void {
  const { settings, buyer, bank, inputs, lots, totals_usd, totals_inr } = args;

  // Standing widths
  for (let c = 1; c <= 20; c++) inv.getColumn(c).width = 12;
  inv.getColumn(2).width = 20;
  inv.getColumn(4).width = 24;
  inv.getColumn(6).width = 20;

  inv.getCell("B3").value = "TAX INVOICE";
  inv.getCell("B3").font = { bold: true, size: 14 };
  inv.getCell("B4").value =
    "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF IGST";
  inv.getCell("B4").font = { italic: true };

  inv.getCell("B5").value = "EXPORTER";
  inv.getCell("B5").font = { bold: true };
  inv.getCell("B6").value = settings.exporter_name;
  inv.getCell("B7").value = settings.exporter_address;

  inv.getCell("I5").value = "INV. NO. & DATE :-";
  inv.getCell("I6").value = inputs.invoice_number;
  inv.getCell("J6").value = "DT.";
  inv.getCell("K6").value = inputs.invoice_date;

  inv.getCell("L5").value = "IEC NO.";
  inv.getCell("L6").value = settings.iec_no;

  inv.getCell("I9").value = "Other Reference(s)";
  inv.getCell("M9").value = "PAN NO.";
  inv.getCell("N9").value = settings.gstin;
  inv.getCell("I10").value = "LUT /ARN NO.";
  inv.getCell("J10").value = `${settings.lut_arn_number} DT. ${settings.lut_arn_date}`;
  inv.getCell("M10").value = "GST NO.";
  inv.getCell("N10").value = settings.pan;

  inv.getCell("B11").value = "CONSIGNEE";
  inv.getCell("B11").font = { bold: true };
  inv.getCell("B12").value = buyer.name;
  inv.getCell("B13").value = buyer.address;

  inv.getCell("I18").value = "Country of Origin of Goods";
  inv.getCell("I19").value = "INDIA";
  inv.getCell("L18").value = "Country of Final Destination";
  inv.getCell("L19").value = buyer.country;

  inv.getCell("I20").value = "Terms of Delivery and Payment";
  inv.getCell("I21").value = "         TERMS:";
  inv.getCell("J21").value = inputs.terms_override ?? buyer.default_terms;

  inv.getCell("B21").value = "Pre-Carriage by";
  inv.getCell("B22").value = inputs.terms_override ?? "SEQUEL";    // placeholder; UI will fill
  inv.getCell("F21").value = "Place of Receipt by Pre-carrier";
  inv.getCell("F22").value = "N.A.";
  inv.getCell("B23").value = "Vessel/Flight No.";
  inv.getCell("B24").value = inputs.flight_mode_override ?? "BY AIR FREIGHT";
  inv.getCell("F23").value = "Port of Loading";
  inv.getCell("F24").value = "MUMBAI / INDIA";
  inv.getCell("B25").value = "Port of Discharge";
  inv.getCell("B26").value = buyer.city;
  inv.getCell("F25").value = "Final Destination";
  inv.getCell("F26").value = buyer.country;

  // Bank block
  inv.getCell("I22").value = bank.name;
  inv.getCell("I25").value = "SWIFT CODE";
  inv.getCell("J25").value = bank.swift;
  inv.getCell("L25").value = "IFSC CODE";
  inv.getCell("N25").value = bank.ifsc;
  inv.getCell("I26").value = "AD CODE";
  inv.getCell("J26").value = bank.ad_code;
  inv.getCell("L26").value = "ACCOUNT NO.";
  inv.getCell("N26").value = bank.account_no;

  // Anchor cells for the gold rate + purity + FX — formulas elsewhere reference these.
  const goldRateRow = 167;
  const purityRow = 167;
  const fxRow = 176;
  const goldRateCellRef = `INVOICE!$E$${goldRateRow}`;
  const purityCellRef = `INVOICE!$F$${purityRow}`;

  // Lot blocks
  let row = 27;
  for (const lot of lots) {
    if (!lot.totals) throw new Error(`Lot ${lot.lot_no} missing totals; compute first.`);
    const ktNum = parseInt(lot.kt.replace("-PD", ""), 10);
    const t = lot.totals;

    inv.getCell(`B${row}`).value = "MARKS & NOS"; inv.getCell(`B${row}`).font = { bold: true };
    inv.getCell(`D${row}`).value = "NO. & KIND OF PKGS."; inv.getCell(`D${row}`).font = { bold: true };
    inv.getCell(`F${row}`).value = "DESCRIPTION OF GOODS"; inv.getCell(`F${row}`).font = { bold: true };

    inv.getCell(`B${row + 1}`).value = `${settings.container_prefix} ${inputs.container_number}`;
    inv.getCell(`D${row + 1}`).value = settings.tin_box_text;
    inv.getCell(`G${row + 1}`).value = lot.hsn_code;

    inv.getCell(`B${row + 2}`).value = `LOT NO-${lot.lot_no}`;
    inv.getCell(`D${row + 2}`).value = lot.description;
    inv.getCell(`D${row + 2}`).font = { bold: true };

    inv.getCell(`I${row + 3}`).value = "GROSS  WT. GMS."; inv.getCell(`I${row + 3}`).font = { bold: true };
    inv.getCell(`K${row + 3}`).value = "US $ / GM"; inv.getCell(`K${row + 3}`).font = { bold: true };
    inv.getCell(`N${row + 3}`).value = "US$"; inv.getCell(`N${row + 3}`).font = { bold: true };

    inv.getCell(`B${row + 4}`).value = "ITEM"; inv.getCell(`B${row + 4}`).font = { bold: true };
    inv.getCell(`D${row + 4}`).value = "KT"; inv.getCell(`D${row + 4}`).font = { bold: true };
    inv.getCell(`E${row + 4}`).value = "QTY"; inv.getCell(`E${row + 4}`).font = { bold: true };
    inv.getCell(`F${row + 4}`).value = "UOM"; inv.getCell(`F${row + 4}`).font = { bold: true };
    inv.getCell(`H${row + 4}`).value = settings.handcrafted_text; inv.getCell(`H${row + 4}`).font = { bold: true };
    inv.getCell(`I${row + 4}`).value = dec(t.gross_wt);

    const totalQty = lot.pieces.reduce((a, p) => a + p.qty, 0);
    inv.getCell(`B${row + 5}`).value = lot.pieces[0]?.item ?? "RING";
    inv.getCell(`D${row + 5}`).value = ktNum;
    inv.getCell(`E${row + 5}`).value = totalQty;
    inv.getCell(`F${row + 5}`).value = "PCS";
    inv.getCell(`I${row + 5}`).value = "NET WT. GMS.";
    inv.getCell(`I${row + 5}`).font = { bold: true };

    inv.getCell(`I${row + 6}`).value = dec(t.net_wt);
    inv.getCell(`K${row + 6}`).value = {
      formula: `${goldRateCellRef}/31.1035/24*${ktNum}/${purityCellRef}`,
    };
    inv.getCell(`N${row + 6}`).value = { formula: `I${row + 6}*K${row + 6}` };

    inv.getCell(`I${row + 7}`).value = "WASTAGE"; inv.getCell(`I${row + 7}`).font = { bold: true };
    inv.getCell(`K${row + 7}`).value = dec(lot.wastage_pct);
    inv.getCell(`I${row + 8}`).value = dec(t.wastage_wt);
    inv.getCell(`K${row + 8}`).value = { formula: `K${row + 6}` };
    inv.getCell(`N${row + 8}`).value = { formula: `I${row + 8}*K${row + 8}` };

    inv.getCell(`B${row + 9}`).value = "TOTAL"; inv.getCell(`B${row + 9}`).font = { bold: true };
    inv.getCell(`E${row + 9}`).value = totalQty;

    // Studding block
    const sr = row + 11;
    inv.getCell(`B${sr}`).value = "DETAILS OF STUDDING"; inv.getCell(`B${sr}`).font = { bold: true };
    inv.getCell(`B${sr + 1}`).value = "STUDD TYPE"; inv.getCell(`B${sr + 1}`).font = { bold: true };
    inv.getCell(`D${sr + 1}`).value = "PCS"; inv.getCell(`D${sr + 1}`).font = { bold: true };
    inv.getCell(`F${sr + 1}`).value = "WT (CTS.)"; inv.getCell(`F${sr + 1}`).font = { bold: true };
    inv.getCell(`H${sr + 1}`).value = "TOTAL US$"; inv.getCell(`H${sr + 1}`).font = { bold: true };

    const studdLabel = {
      gold_studded_lgd: "LG DIAMONDS",
      gold_studded_diamond: "DIAMONDS",
      gold_studded_colorstone: "SEMI-PRECIOUS STONE",
      gold_plain: "",
      gold_mounting: "",
    }[lot.jewellery_type];
    const studdingPcs = lot.pieces.reduce(
      (a, p) => a + p.diamonds.reduce((aa, d) => aa + d.pcs, 0) + p.stones.reduce((aa, s) => aa + s.pcs, 0), 0,
    );
    const studdingCts = lot.pieces.reduce(
      (a, p) => a
        .add(p.diamonds.reduce((aa, d) => aa.add(d.cts), new Decimal(0)))
        .add(p.stones.reduce((aa, s) => aa.add(s.cts), new Decimal(0))),
      new Decimal(0),
    );
    const studdingValue = t.diamond_value_usd.add(t.stone_value_usd);

    inv.getCell(`B${sr + 2}`).value = studdLabel;
    inv.getCell(`D${sr + 2}`).value = studdingPcs;
    inv.getCell(`F${sr + 2}`).value = dec(studdingCts);
    inv.getCell(`H${sr + 2}`).value = dec(studdingValue);

    inv.getCell(`L${sr + 2}`).value = "COST OF GOLD"; inv.getCell(`L${sr + 2}`).font = { bold: true };
    inv.getCell(`N${sr + 2}`).value = dec(t.gold_value_usd);
    inv.getCell(`K${sr + 3}`).value = dec(t.value_addition_ratio);
    inv.getCell(`M${sr + 3}`).value = "MFG. COST"; inv.getCell(`M${sr + 3}`).font = { bold: true };
    inv.getCell(`N${sr + 3}`).value = dec(t.mfg_cost_usd);
    inv.getCell(`L${sr + 4}`).value = "COST OF STUDDING"; inv.getCell(`L${sr + 4}`).font = { bold: true };
    inv.getCell(`N${sr + 4}`).value = dec(studdingValue);
    inv.getCell(`L${sr + 5}`).value = ` TOTAL LOT NO. ${lot.lot_no}`; inv.getCell(`L${sr + 5}`).font = { bold: true };
    inv.getCell(`N${sr + 5}`).value = dec(t.total_usd);

    inv.getCell(`B${sr + 5}`).value = "TOTAL"; inv.getCell(`B${sr + 5}`).font = { bold: true };
    inv.getCell(`D${sr + 5}`).value = studdingPcs;
    inv.getCell(`F${sr + 5}`).value = dec(studdingCts);
    inv.getCell(`H${sr + 5}`).value = dec(studdingValue);

    row = sr + 7;
  }

  // Package + state + totals
  inv.getCell(`B${row + 1}`).value = "GROSS WT. OF PACKAGE"; inv.getCell(`B${row + 1}`).font = { bold: true };
  inv.getCell(`F${row + 1}`).value = dec(inputs.package_gross_wt_kg);
  inv.getCell(`G${row + 1}`).value = "KGS";
  inv.getCell(`L${row + 1}`).value = "TOTAL COST"; inv.getCell(`L${row + 1}`).font = { bold: true };
  inv.getCell(`N${row + 1}`).value = dec(totals_usd);

  inv.getCell(`B${row + 2}`).value = "STATE CODE OF ORIGIN OF GOODS :-"; inv.getCell(`B${row + 2}`).font = { bold: true };
  inv.getCell(`G${row + 2}`).value = args.settings.state_code;
  inv.getCell(`H${row + 2}`).value = args.settings.state_name;
  inv.getCell(`L${row + 2}`).value = "FREIGHT";
  inv.getCell(`N${row + 2}`).value = dec(inputs.freight_usd);

  inv.getCell(`B${row + 3}`).value = "DISTRICT OF ORIGIN OF GOODS       :-"; inv.getCell(`B${row + 3}`).font = { bold: true };
  inv.getCell(`G${row + 3}`).value = args.settings.district_code;
  inv.getCell(`H${row + 3}`).value = args.settings.district_name;
  inv.getCell(`L${row + 3}`).value = "INSURANCE";
  inv.getCell(`N${row + 3}`).value = dec(inputs.insurance_usd);

  inv.getCell(`B${row + 4}`).value = "DETAILS OF PREFERENTIAL AGREEMENT:-"; inv.getCell(`B${row + 4}`).font = { bold: true };
  inv.getCell(`G${row + 4}`).value =
    inputs.preferential_agreement_override ?? buyer.default_preferential_agreement ?? "";
  inv.getCell(`L${row + 4}`).value = "DISCOUNT";
  inv.getCell(`N${row + 4}`).value = dec(inputs.discount_usd);

  inv.getCell(`B${row + 5}`).value = "STANDARD UNIT QUANTITY CODE:-"; inv.getCell(`B${row + 5}`).font = { bold: true };
  inv.getCell(`G${row + 5}`).value = " KGS ";
  inv.getCell(`L${row + 5}`).value = "COMMSSION";
  inv.getCell(`N${row + 5}`).value = dec(inputs.commission_usd);

  inv.getCell(`B${row + 6}`).value = "Amount Chargebe in words"; inv.getCell(`B${row + 6}`).font = { bold: true };
  inv.getCell(`M${row + 6}`).value = "C&F"; inv.getCell(`M${row + 6}`).font = { bold: true };
  inv.getCell(`N${row + 6}`).value = dec(totals_usd);

  inv.getCell(`B${row + 7}`).value = "C&F";
  inv.getCell(`C${row + 7}`).value = "US$:-";
  inv.getCell(`D${row + 7}`).value = amountInWordsUsd(totals_usd);

  // Payment instructions
  const payRow = row + 9;
  inv.getCell(`B${payRow}`).value = "PAYMENT  INSTRUCTION"; inv.getCell(`B${payRow}`).font = { bold: true };
  settings.payment_instructions.forEach((line, i) => {
    inv.getCell(`C${payRow + i + 1}`).value = line;
  });

  // Declarations
  const declRow = payRow + settings.payment_instructions.length + 2;
  settings.declarations.forEach((line, i) => {
    inv.getCell(`C${declRow + i}`).value = `• ${line}`;
  });

  // Gold-rate anchor block (at row 166/167 by convention; keep in sync with ref addresses).
  inv.getCell(`B${166}`).value = `GOLD PURCHASE FROM : ${inputs.gold_purchase_party}`;
  inv.getCell(`E${166}`).value =
    `INVOICE NO. ${inputs.gold_purchase_invoice_no} DTD. ${inputs.gold_purchase_date}`;
  inv.getCell(`B${goldRateRow}`).value = "GOLD RATE";
  inv.getCell(`E${goldRateRow}`).value = dec(inputs.gold_rate_usd_per_troy_oz);
  inv.getCell(`F${purityRow}`).value = dec(inputs.gold_purity);

  // Exchange rate
  inv.getCell(`C${fxRow}`).value = "Exchange Rate";
  inv.getCell(`E${fxRow}`).value = dec(inputs.inr_usd_rate);
  inv.getCell(`H${fxRow}`).value = dec(totals_inr);
}

// ───────────────────────── CUSTOMS PL sheet ─────────────────────────

function writeCustomsPlSheet(cpl: ExcelJS.Worksheet, args: GenerateArgs): void {
  const { settings, buyer, inputs, lots } = args;

  for (let c = 1; c <= 40; c++) cpl.getColumn(c).width = 12;

  cpl.getCell("C2").value = "PACKING LIST";
  cpl.getCell("C2").font = { bold: true, size: 14 };

  let row = 5;
  for (const lot of lots) {
    cpl.getCell(`C${row}`).value = "CUSTOMS VALUE ADDITION OF INVOICE # :-";
    cpl.getCell(`H${row}`).value = inputs.invoice_number;
    cpl.getCell(`K${row}`).value = "DATE";
    cpl.getCell(`M${row}`).value = inputs.invoice_date;

    cpl.getCell(`E${row + 1}`).value = `LOT NO ${lot.lot_no}`;
    cpl.getCell(`F${row + 1}`).value = lot.description;

    cpl.getCell(`C${row + 2}`).value = "CUSTOMER NAME & NO. :-";
    cpl.getCell(`F${row + 2}`).value = buyer.name;

    cpl.getCell(`K${row + 3}`).value = "GOLD";
    cpl.getCell(`Q${row + 3}`).value = "DIAMONDS";

    const headers = [
      [3, "Sr. No."], [4, "STYLE #"], [5, "ITEM"], [6, "KT"], [7, "COLOR"], [8, "QTY."],
      [9, "UOM"], [10, "GROSS WT. GMS"], [11, "NET WT GMS."], [12, "WASTAGE GMS."],
      [13, "NET GOLD & WASTAGE WT."], [14, "GOLD RATE PER GRMS"], [15, "GOLD VALUE USD"],
    ] as const;
    for (const [c, label] of headers) {
      const cell = cpl.getRow(row + 4).getCell(c);
      cell.value = label; cell.font = { bold: true };
      cell.alignment = { horizontal: "center", wrapText: true };
    }

    // Dynamic shape columns per lot
    const shapes = [...new Set(lot.pieces.flatMap((p) => p.diamonds.map((d) => d.shape)))].sort();
    shapes.forEach((shape, i) => {
      cpl.getRow(row + 4).getCell(16 + i).value = shape;
      cpl.getRow(row + 4).getCell(16 + i).font = { bold: true };
    });
    const certCol = 16 + shapes.length;
    const diaCols = ["CERTIFICATE NO & LAB", "DIA DETAILS", "DIA COLOR & QLTY.",
                     "DIAM. CTS.", "DIA. RATE (USD)", "TOTAL VALUE (USD)",
                     "TOTAL MFG. COST (USD)", "TOTAL COST (USD)"];
    diaCols.forEach((label, i) => {
      cpl.getRow(row + 4).getCell(certCol + i).value = label;
      cpl.getRow(row + 4).getCell(certCol + i).font = { bold: true };
    });

    cpl.getCell(`L${row + 6}`).value = dec(lot.wastage_pct);

    const pieceStart = row + 7;
    lot.pieces.forEach((p, i) => {
      const r = pieceStart + i;
      cpl.getCell(`A${r}`).value = i + 1;
      cpl.getCell(`C${r}`).value = i + 1;
      cpl.getCell(`D${r}`).value = p.cust_style_no;
      cpl.getCell(`E${r}`).value = p.item;
      cpl.getCell(`F${r}`).value = parseInt(p.kt.replace("-PD", ""), 10);
      cpl.getCell(`G${r}`).value = p.color;
      cpl.getCell(`H${r}`).value = p.qty;
      cpl.getCell(`I${r}`).value = "PCS";
      cpl.getCell(`J${r}`).value = dec(p.gross_wt);
      const diaCts = p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
      const stoneCts = p.stones.reduce((a, s) => a.add(s.cts), new Decimal(0));
      cpl.getCell(`K${r}`).value = dec(p.gross_wt.sub(diaCts.div(5)).sub(stoneCts.div(5)));

      shapes.forEach((shape, j) => {
        const dia = p.diamonds.find((d) => d.shape === shape);
        if (dia) cpl.getRow(r).getCell(16 + j).value = dia.pcs;
      });

      if (p.diamonds.length) {
        const d0 = p.diamonds[0];
        if (d0.certificate_no) cpl.getRow(r).getCell(certCol).value = d0.certificate_no;
        if (d0.origin) cpl.getRow(r).getCell(certCol + 1).value = d0.origin;
        if (d0.color_clarity) cpl.getRow(r).getCell(certCol + 2).value = d0.color_clarity;
        if (diaCts.gt(0)) cpl.getRow(r).getCell(certCol + 3).value = dec(diaCts);
        if (d0.rate_usd_per_ct) {
          cpl.getRow(r).getCell(certCol + 4).value = dec(d0.rate_usd_per_ct);
          cpl.getRow(r).getCell(certCol + 5).value = dec(d0.rate_usd_per_ct.mul(diaCts));
        }
      }
    });

    row = pieceStart + lot.pieces.length + 4;
  }

  cpl.getCell(`B${row + 2}`).value = `Prepared with JWY-invoice-web @ ${new Date().toISOString().slice(0, 10)}`;
  cpl.getCell(`B${row + 2}`).font = { italic: true, size: 9 };
  void settings; // referenced for parity with Python; not written here
}
