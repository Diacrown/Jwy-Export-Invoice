/** Main File "Main WS" lookup: reading the export, normalising certificates and
 *  grades, and filling only what is safe. All values here are made up — the
 *  real Main WS is business data and never committed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";

import { parseMainWs } from "../src/parsers/mainws";
import {
  applyMainWs, buyerForShipTo, centreRowIndex, extractCertificates, parseShapeGrade, parseStonePairs, suggestBuyer,
} from "../src/lib/mainws";
import type { Buyer, DiamondDetail, JewelleryType, MainWsRow, Piece } from "../src/types";

const d = (shape: string, pcs: number, cts: string, extra: Partial<DiamondDetail> = {}): DiamondDetail =>
  ({ shape, pcs, cts: new Decimal(cts), ...extra });

function piece(style: string, po: string | null, jtype: JewelleryType, diamonds: DiamondDetail[]): Piece {
  return {
    stock_no: `S-${style}`, cust_po: po, cust_style_no: style, kt_raw: "18", color_raw: "Y", qty: 1,
    gross_wt: new Decimal(3), item_category_raw: "RING", item: "RING", kt: "18", color: "YELLOW",
    jewellery_type: jtype, semi_mount: false, diamonds, stones: [],
  };
}

function row(over: Partial<MainWsRow>): MainWsRow {
  return {
    row: 2, customer: "Test Customer", loc: "B", ship_to: "WS-BNE", job_no: "", item_no: "", style_code: "",
    status: "Shipped", vendor: "Swan", ship_date: "", centre: "", side: "", mined_or_lab: "", shape_grade: "",
    cert_cells: [], remark_cells: [], ...over,
  };
}

describe("Main WS text helpers", () => {
  it("normalises certificates the way the manual workbook prints them", () => {
    const lab = { certColumn: false, labGrown: true };
    assert.deepEqual(extractCertificates("R9001 Ring M(UK) 18KTYG LGD IGI 111222333", lab), ["IGI-LG111222333"]);
    assert.deepEqual(extractCertificates("IGI111222333 IGI 444555666", lab), ["IGI-LG111222333", "IGI-LG444555666"]);
    assert.deepEqual(extractCertificates("LG777888999 SWAN", { certColumn: true, labGrown: false }), ["IGI-LG777888999"]);
    assert.deepEqual(extractCertificates("IGI-LG123123123", lab), ["IGI-LG123123123"]);
    assert.deepEqual(extractCertificates("GIA 2141438171", { certColumn: false, labGrown: false }), ["GIA-2141438171"]);
    assert.deepEqual(extractCertificates("IGI 555666777", { certColumn: false, labGrown: false }), ["IGI-555666777"]);
    // A bare number counts only inside a Cert No. column; weights and typos never do.
    assert.deepEqual(extractCertificates("call 98765432100", lab), []);
    assert.deepEqual(extractCertificates("123456789", { certColumn: true, labGrown: true }), ["IGI-LG123456789"]);
    assert.deepEqual(extractCertificates("4.21", { certColumn: true, labGrown: true }), []);
    assert.deepEqual(extractCertificates("IGI 7+94661734", lab), []);
  });

  it("splits shape from colour/clarity", () => {
    assert.deepEqual(parseShapeGrade("Oval D/VS1"), { shape: "Oval", grade: "D-VS1" });
    assert.deepEqual(parseShapeGrade("Long Radiant D/VS1"), { shape: "Long Radiant", grade: "D-VS1" });
    assert.deepEqual(parseShapeGrade("D VS1"), { shape: null, grade: "D-VS1" });
    assert.deepEqual(parseShapeGrade("Round G/SI2"), { shape: "Round", grade: "G-SI2" });
    assert.deepEqual(parseShapeGrade("E/VVS2"), { shape: null, grade: "E-VVS2" });
    assert.deepEqual(parseShapeGrade("Emerald F-VS2"), { shape: "Emerald", grade: "F-VS2" });
    assert.deepEqual(parseShapeGrade("Mount"), { shape: null, grade: null });
    assert.deepEqual(parseShapeGrade("LGD"), { shape: null, grade: null });
  });

  it("reads pcs/carat pairs, including a re-set centre stone", () => {
    assert.deepEqual(parseStonePairs("1/2.50"), [{ pcs: 1, cts: 2.5 }]);
    assert.deepEqual(parseStonePairs("1/2.03 1/2.06"), [{ pcs: 1, cts: 2.03 }, { pcs: 1, cts: 2.06 }]);
    assert.deepEqual(parseStonePairs(""), []);
    const rows = [d("ROUND", 16, "0.06"), d("OVAL", 1, "2.06")];
    assert.equal(centreRowIndex(rows, "1/2.03 1/2.06"), 1);
    assert.equal(centreRowIndex(rows, "1/1.50"), null);
  });
});

describe("parseMainWs", () => {
  it("finds the columns by heading in a CSV download and keeps the text as typed", async () => {
    const csv = [
      "Customer,Loc,ShipTo,JobNo,ItemNo,Status,Vendor,Ship Date,Remarks,Customer Name,Loc,Po No.,Item Size,"
        + "Center Diam Details,Side Diam Details,Mined or Lab,Shape Col/Clarity,Style code,Metal KT/COL,Nt Wt,Cert No.,Cert No.,Cert No.,Remarks",
      "Stock Order,B,WS-BNE,9001-04,R9001-0200-18YGLG,Shipped,Swan,5-11-2026,,Stock Order,B,9001-04,Ring,"
        + "1/2.00,,LGD,Oval D/VS1,R9001-0200-18YGLG,18KTYG,,,,,\"R9001-0200-18YGLG Ring 18KTYG LGD IGI 111222333\"",
      ",,,,,,,,,,,,,,,,,,,,,,,",
      "Shop 2,S,WS-SYD,9002,S09002,QC Pass,Swan,,,Shop 2,S,9002,Ring,1/0.40,16/0.10,Mined,D VS1,S09002,18KTYG,3.1,LG444555666,,,",
    ].join("\n");
    const rows = await parseMainWs(new Blob([csv]), "Main File - Main WS.csv");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].job_no, "9001-04");           // not a date
    assert.equal(rows[0].centre, "1/2.00");            // not a date either
    assert.equal(rows[0].ship_to, "WS-BNE");
    assert.equal(rows[0].customer, "Stock Order");
    assert.equal(rows[0].shape_grade, "Oval D/VS1");
    assert.deepEqual(rows[0].remark_cells, ["R9001-0200-18YGLG Ring 18KTYG LGD IGI 111222333"]);
    assert.equal(rows[0].row, 2);
    assert.deepEqual(rows[1].cert_cells, ["LG444555666"]);
    assert.equal(rows[1].row, 4);
  });

  it("says plainly when the file isn't Main WS", async () => {
    await assert.rejects(parseMainWs(new Blob(["Sr. No.,Style No.,Gold Kt.\n1,A,18"]), "packing.csv"), /Main WS/);
  });
});

describe("applyMainWs", () => {
  const lgd = (style: string, po: string, centre: string) =>
    piece(style, po, "gold_studded_lgd", [d("ROUND", 16, "0.22"), d("OVAL", 1, centre)]);

  it("matches on job no. even when the style is typed differently, and fills the centre row only", () => {
    const p = lgd("R9001-O0200-18YGLG", "9001-04", "2.00");
    const rows = [row({ job_no: "9001-04", item_no: "R9001-0200-18YGLG", centre: "1/2.00", mined_or_lab: "LGD",
      shape_grade: "Oval D/VS1", remark_cells: ["R9001-0200-18YGLG Ring LGD IGI 111222333"] })];
    const { pieces, summary } = applyMainWs([p], rows);
    const [melee, centre] = pieces[0].diamonds;
    assert.equal(centre.certificate_no, "IGI-LG111222333");
    assert.equal(centre.color_clarity, "D-VS1");
    assert.equal(melee.certificate_no, undefined);
    assert.equal(melee.color_clarity, undefined);
    assert.equal(pieces[0].main_ws?.by, "job");
    assert.deepEqual(pieces[0].main_ws?.notes, []);
    assert.deepEqual(summary, { rows: 1, matched: 1, unmatched: [], certificates: 1, grades: 1, toCheck: 0 });
    assert.equal(p.diamonds[1].certificate_no, undefined, "input pieces are not mutated");
  });

  it("never overwrites what the clerk typed", () => {
    const p = lgd("R9001", "9001", "2.00");
    p.diamonds[1].certificate_no = "IGI-LG999";
    p.diamonds[1].color_clarity = "E-VS2";
    const { pieces } = applyMainWs([p], [row({ job_no: "9001", centre: "1/2.00", shape_grade: "D/VS1", cert_cells: ["LG111222333"] })]);
    assert.equal(pieces[0].diamonds[1].certificate_no, "IGI-LG999");
    assert.equal(pieces[0].diamonds[1].color_clarity, "E-VS2");
    assert.equal(pieces[0].main_ws?.filled_certificate, false);
  });

  it("shows two certificates instead of guessing, but still fills the grade", () => {
    const p = lgd("S09003", "9003", "2.06");
    const { pieces, summary } = applyMainWs([p], [row({ job_no: "9003", centre: "1/2.03 1/2.06", mined_or_lab: "LGD",
      shape_grade: "Oval D/VS1", cert_cells: ["LG777888999 SWAN"], remark_cells: ["S09003 LGD IGI 111222333"] })]);
    assert.equal(pieces[0].diamonds[1].certificate_no, undefined);
    assert.equal(pieces[0].diamonds[1].color_clarity, "D-VS1");
    assert.match(pieces[0].main_ws!.notes![0], /2 certificates/);
    assert.equal(summary.toCheck, 1);
  });

  it("fills nothing when the centre stone's carats don't match a row", () => {
    const p = lgd("S09004", "9004", "1.57");
    const { pieces } = applyMainWs([p], [row({ job_no: "9004", centre: "1/1.53", shape_grade: "Oval D/VS1", cert_cells: ["LG111222333"] })]);
    assert.equal(pieces[0].diamonds[1].certificate_no, undefined);
    assert.equal(pieces[0].diamonds[1].color_clarity, undefined);
    assert.match(pieces[0].main_ws!.notes![0], /doesn't match/);
  });

  it("falls back to the style no. only when it is unique", () => {
    const a = piece("B09005", null, "gold_studded_diamond", [d("ROUND", 1, "1.02")]);
    const b = piece("R0000", null, "gold_studded_diamond", [d("ROUND", 1, "1.00")]);
    const rows = [
      row({ job_no: "9005", item_no: "B09005", centre: "1/1.02", mined_or_lab: "Mined", shape_grade: "Round G/SI2", remark_cells: ["IGI 555666777"] }),
      row({ job_no: "9006", item_no: "R0000" }), row({ job_no: "9007", item_no: "R0000" }),
    ];
    const { pieces, summary } = applyMainWs([a, b], rows);
    assert.equal(pieces[0].main_ws?.by, "style");
    assert.equal(pieces[0].diamonds[0].certificate_no, "IGI-555666777");   // natural: no LG
    assert.equal(pieces[0].diamonds[0].color_clarity, "G-SI2");
    assert.equal(pieces[1].main_ws?.found, false);
    assert.match(pieces[1].main_ws!.notes![0], /2 Main WS rows/);
    assert.deepEqual(summary.unmatched, ["R0000"]);
  });

  it("finds a palladium job tagged -PD on the packing list", () => {
    const p = piece("R9010", "9010-PD", "gold_studded_lgd", [d("ROUND", 1, "2.05")]);
    const { pieces } = applyMainWs([p], [row({ job_no: "9010", item_no: "R9010", centre: "1/2.05", shape_grade: "Round D/VS1", remark_cells: ["IGI 101010101"] })]);
    assert.equal(pieces[0].main_ws?.by, "job");
    assert.equal(pieces[0].diamonds[0].certificate_no, "IGI-LG101010101");
  });

  it("splits the centre stone out of a same-shape row the way the manual workbook does", () => {
    // Packing list: ROUND 4 / 0.26 + MARQUISE 5 / 5.03; Main WS: centre 1/4.56 Marquise.
    const p = piece("B09011", "9011", "gold_studded_lgd", [d("ROUND", 4, "0.26"), d("MARQUISE", 5, "5.03")]);
    const { pieces } = applyMainWs([p], [row({ job_no: "9011", centre: "1/4.56", side: "4/0.26 4/0.47",
      mined_or_lab: "LGD", shape_grade: "Marquise D/VS1", remark_cells: ["IGI 202020202"] })]);
    const rows = pieces[0].diamonds.map((x) => [x.shape, x.pcs, x.cts.toFixed(2), x.certificate_no ?? null, x.color_clarity ?? null]);
    assert.deepEqual(rows, [
      ["ROUND", 4, "0.26", null, null],
      ["MARQUISE", 1, "4.56", "IGI-LG202020202", "D-VS1"],
      ["MARQUISE", 4, "0.47", null, null],
    ]);
    assert.match(pieces[0].main_ws!.notes![0], /Split MARQUISE 5 pcs/);
    // A row the clerk already priced is never split.
    const priced = piece("B09012", "9012", "gold_studded_lgd", [d("MARQUISE", 5, "5.03", { rate_usd_per_ct: new Decimal(90) })]);
    const again = applyMainWs([priced], [row({ job_no: "9012", centre: "1/4.56", shape_grade: "Marquise D/VS1", remark_cells: ["IGI 202020202"] })]);
    assert.equal(again.pieces[0].diamonds.length, 1);
  });

  it("flags Main WS and the packing list disagreeing on lab-grown vs natural", () => {
    const p = piece("S09008", "9008", "gold_studded_diamond", [d("ROUND", 1, "0.44")]);
    const { pieces } = applyMainWs([p], [row({ job_no: "9008", centre: "1/0.44", mined_or_lab: "LGD" })]);
    assert.match(pieces[0].main_ws!.notes![0], /natural/);
  });
});

describe("buyer from ShipTo", () => {
  const buyers = [
    { id: "syd", name: "WORLD SHINER PTY LTD", city: "SYDNEY", country: "AUSTRALIA" },
    { id: "mel", name: "ISHA TRADING PTY LTD", city: "MELBOURNE", country: "AUSTRALIA" },
    { id: "bne", name: "WORLD SHINER PTY LTD", city: "BRISBANE", country: "AUSTRALIA" },
    { id: "uk", name: "WORLD SHINER (UK) LTD", city: "LONDON", country: "UNITED KINGDOM" },
  ] as Buyer[];
  const shipped = (to: string) => ({ ...piece("X", null, "gold_mounting", []), main_ws: { found: true, ship_to: to } });

  it("maps ShipTo accounts to buyers", () => {
    assert.equal(buyerForShipTo("WS-BNE", buyers)?.id, "bne");
    assert.equal(buyerForShipTo("ws-uk", buyers)?.id, "uk");
    assert.equal(buyerForShipTo("WS-POL", buyers), null);
  });

  it("is unanimous only when every piece ships to one account", () => {
    const one = suggestBuyer([shipped("WS-BNE"), shipped("WS-BNE")], buyers)!;
    assert.equal(one.unanimous, true);
    assert.equal(one.buyer?.id, "bne");
    const mixed = suggestBuyer([shipped("WS-BNE"), shipped("WS-SYD"), shipped("WS-BNE")], buyers)!;
    assert.equal(mixed.unanimous, false);
    assert.deepEqual(mixed.counts, [["WS-BNE", 2], ["WS-SYD", 1]]);
    assert.equal(suggestBuyer([piece("X", null, "gold_mounting", [])], buyers), null);
  });
});
