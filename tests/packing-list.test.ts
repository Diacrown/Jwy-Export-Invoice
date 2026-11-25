/** Newer packing-list formats:
 *   - SDJ-JB-058 (05.11.2026): only sheet 2 "Packing List" is used; sheet 1
 *     (Swan's tax invoice) is ignored. Adds Labour, Region, a product Category
 *     and a "Col Stn" colour-stone column.
 *   - SJ-50 29.10.2026: no "Stock No." column; product category sits under a
 *     mislabelled "Bag No" header. Its manual invoice EXP615 is the newest
 *     reference and is reconciled to the cent.
 *
 * These files may not be filed into the sample folders yet — set
 * JWY_EXTRA_SAMPLES_DIR (e.g. to your Downloads folder) or copy them in. Each
 * suite skips when its file is missing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";

import { groupPiecesIntoLots } from "../src/lib/grouping";
import { computeLotTotals, defaultBaseGoldRate, grandTotalCf, withGrossRounded } from "../src/lib/calculations";
import { buildWorkbook } from "../src/generators/xlsx";
import { runAll, isBlocked } from "../src/lib/validators";
import type { PerInvoiceInputs, Piece } from "../src/types";
import {
  BANKS, BUYERS, LABOUR, SETTINGS, applyReference, findSample, hsnWith, parseFiles, readReference,
} from "./helpers/reference";

const HSN_NEW = hsnWith("JEWELLERY STUDDED WITH NATURAL DIAMONDS");
const sdj058 = findSample("SDJ-JB-058");
const sj2910 = findSample("SJ-50 # DCJ # 29.10.2026");
const exp615 = findSample("EXP615");
const by = (ps: Piece[], style: string) => ps.find((p) => p.cust_style_no === style)!;

describe("base-lock default follows the gold rate", () => {
  it("reproduces 139.395 (EXP535 @ 4339.8413) and 135.176 (EXP615 @ 4208.4878)", () => {
    assert.equal(defaultBaseGoldRate(new Decimal("4339.8413")).toString(), "139.395");
    assert.equal(defaultBaseGoldRate(new Decimal("4208.4878")).toString(), "135.176");
  });
});

describe("SDJ-JB-058 — Packing List sheet only", { skip: !sdj058 && "SDJ-JB-058 not found (set JWY_EXTRA_SAMPLES_DIR)" }, () => {
  it("reads the 12 pieces of sheet 2 and nothing from sheet 1", async () => {
    const ps = await parseFiles([sdj058!]);
    assert.equal(ps.length, 12);
    assert.ok(ps.every((p) => /Packing List$/.test(p.source ?? "")), "every piece comes from the Packing List sheet");
    assert.equal(ps.reduce((a, p) => a + p.qty, 0), 12);
    const gross = ps.reduce((a, p) => a.add(p.gross_wt), new Decimal(0));
    assert.equal(gross.toFixed(3), "50.186");
    const cts = ps.reduce((a, p) => a.add(p.studding_raw_cts!), new Decimal(0));
    assert.equal(cts.toFixed(2), "16.98");              // Total Dia. 16.46 + Col Stn 0.52
  });

  it("takes labour, region and category from the sheet", async () => {
    const ps = await parseFiles([sdj058!]);
    assert.equal(by(ps, "R0272-0200-18YGLG").labour_rate_inr_per_gm!.toNumber(), 1275);
    assert.equal(by(ps, "R0275-0150-18WGLG").labour_rate_inr_per_gm!.toNumber(), 2000);
    assert.equal(by(ps, "R0221-O0200-18YGLG").region, "B");
    assert.equal(by(ps, "S01564").region, "S");
    const semi = by(ps, "S01436");
    assert.equal(semi.jewellery_type, "gold_studded_lgd");
    assert.equal(semi.semi_mount, true);
    assert.equal(by(ps, "B00820").jewellery_type, "gold_mounting");
    const ruby = by(ps, "B00469-R");                     // "Mined, Precious gemstone Studded"
    assert.equal(ruby.jewellery_type, "gold_studded_diamond");
    const stone = ruby.diamonds.find((d) => d.shape === "COLOR STONE")!;
    assert.equal(stone.cts.toNumber(), 0.01);
    assert.equal(stone.color_clarity, "RUBY");
    assert.equal(stone.origin, "PRECIOUS STONE");
    const gem = by(ps, "M00352");                        // "Gemstone Semi"
    assert.equal(gem.jewellery_type, "gold_studded_colorstone");
    assert.equal(gem.semi_mount, true);
    assert.equal(gem.diamonds[0].origin, "SEMI-PRECIOUS STONE");
  });

  it("groups into 5 lots and builds a workbook that passes the hard validators", async () => {
    const pieces = withGrossRounded(await parseFiles([sdj058!]), true);
    for (const p of pieces) for (const d of p.diamonds) d.rate_usd_per_ct = new Decimal(100);   // clerk fills rates
    const lots = groupPiecesIntoLots(pieces, HSN_NEW, new Decimal(0.04));
    assert.deepEqual(lots.map((l) => [l.description, l.pieces.length, l.wastage_pct.toNumber()]), [
      ["18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS", 6, 0.04],
      ["18 KT YELLOW GOLD SEMI-MOUNTING JEWELLERY STUDDED WITH LABGROWN DIAMONDS", 1, 0.04],
      ["18 KT YELLOW GOLD MOUNTING JEWELLERY", 1, 0.02],
      ["18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH NATURAL DIAMONDS", 3, 0.04],
      ["18 KT WHITE GOLD SEMI-MOUNTING JEWELLERY STUDDED WITH SEMI PRECIOUS STONE", 1, 0.04],
    ]);
    const gold = new Decimal("4208.4878");
    const inputs: PerInvoiceInputs = {
      invoice_number: "EXP999/2026-27", invoice_date: "2026-11-05", buyer_id: "b1", bank_id: "k2",
      preferential_agreement_text: "ECTA-AU",
      gold_rate_usd_per_troy_oz: gold, gold_purity: new Decimal("0.999"),
      gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "TEST", gold_purchase_date: "2026-11-01",
      inr_usd_rate: new Decimal("95.25"), labour_inr_usd_rate: new Decimal("95.25"),
      base_gold_rate_usd_per_gm: defaultBaseGoldRate(gold),
      package_gross_wt_kg: new Decimal("2"), container_number: 1,
      discount_usd: new Decimal(0), freight_usd: new Decimal(0), insurance_usd: new Decimal(0), commission_usd: new Decimal(0),
    };
    for (const lot of lots) {
      computeLotTotals({
        lot, gold_rate_usd_per_troy_oz: gold, gold_purity: inputs.gold_purity, labour_inr_usd_rate: inputs.labour_inr_usd_rate,
        base_gold_rate_usd_per_gm: inputs.base_gold_rate_usd_per_gm, kt_touch: SETTINGS.kt_touch, labor_rates: {},
        fixed_addon_usd: new Decimal(10),
      });
    }
    // labour came from the sheet: Settings rates were empty
    assert.equal(lots[0].piece_calcs![1].labour_rate_inr.toNumber(), 2000);
    const rep = runAll({ pieces, lots, inputs, hsnTable: HSN_NEW, defaultWastagePct: new Decimal(0.04), settings: SETTINGS });
    assert.equal(isBlocked(rep), false, JSON.stringify(rep.findings.filter((f) => !f.passed)));
    const usd = grandTotalCf({ lots });
    const wb = buildWorkbook({ settings: SETTINGS, buyer: BUYERS[0], bank: BANKS[1], buyers: BUYERS, banks: BANKS, inputs, lots, totals_usd: usd, totals_inr: usd.mul(95.25) });
    assert.equal(wb.getWorksheet("CUSTOMS PL")!.getCell("AK15").formula, "ROUND(BA15,2)");
  });
});

describe("SJ-50 29.10.2026 → EXP615 (B-JEW, newest reference)", { skip: !(sj2910 && exp615) && "SJ-50 29.10 / EXP615 not found (set JWY_EXTRA_SAMPLES_DIR)" }, () => {
  it("parses a file without a Stock No. column, category under 'Bag No'", async () => {
    const ps = await parseFiles([sj2910!]);
    assert.equal(ps.length, 9);
    assert.ok(ps.every((p) => p.synthetic_stock));
    assert.equal(by(ps, "M00334").product_category, "Semi-Mined");
    assert.equal(by(ps, "M00334").semi_mount, true);
    assert.equal(by(ps, "B00724-01-A").semi_mount, false);   // remark "MINED SEMI", category "Mined Studded"
    assert.equal(by(ps, "B00724-01-A").bag_no, null);
    assert.equal(by(ps, "M00233-WG").labour_rate_inr_per_gm!.toNumber(), 2000);
  });

  it("reproduces every piece's AR, MFG cost and the C&F total", async () => {
    const ref = readReference(exp615!);
    const gold = new Decimal("4208.4878");
    const base = defaultBaseGoldRate(gold);                  // 135.176
    const parsed = withGrossRounded(await parseFiles([sj2910!]), true);
    // No AR replay: the derived AR must match the manual on its own.
    const pieces = applyReference(parsed, ref.pieces);
    const lots = groupPiecesIntoLots(pieces, HSN_NEW, new Decimal(0.04));
    assert.deepEqual(lots.map((l) => l.description), [
      "18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS",
      "9 KT YELLOW GOLD JEWELLERY STUDDED WITH NATURAL DIAMONDS",
      "18 KT WHITE GOLD JEWELLERY STUDDED WITH NATURAL DIAMONDS",
      "18 KT WHITE GOLD SEMI-MOUNTING JEWELLERY STUDDED WITH NATURAL DIAMONDS",
    ]);
    for (const lot of lots) {
      computeLotTotals({
        lot, gold_rate_usd_per_troy_oz: gold, gold_purity: new Decimal("0.999"), labour_inr_usd_rate: new Decimal("94.2"),
        base_gold_rate_usd_per_gm: base, kt_touch: SETTINGS.kt_touch, labor_rates: LABOUR, fixed_addon_usd: new Decimal(10),
      });
    }
    const calcs = lots.flatMap((l) => l.pieces.map((p, i) => ({ p, c: l.piece_calcs![i] })));
    for (const rp of ref.pieces) {
      const hit = calcs.find(({ p }) => p.cust_style_no.trim() === rp.style.trim())!;
      assert.ok(hit, rp.style);
      assert.equal(hit.p.gross_wt.toNumber(), rp.gross, `gross ${rp.style}`);
      assert.ok(Math.abs(hit.c.base_lock.toNumber() - rp.ar!) < 0.0051, `AR ${rp.style}: ${hit.c.base_lock} vs ${rp.ar}`);
      assert.equal(hit.c.labour_rate_inr.toNumber(), rp.at, `labour ${rp.style}`);
      assert.equal(hit.c.mfg.toNumber(), rp.ak, `AK ${rp.style}: ${hit.c.mfg} vs ${rp.ak}`);
    }
    const manual = Object.keys(ref.ws).filter((k) => /^AL\d+$/.test(k) && /GRAND/.test(String(ref.ws[`C${k.slice(2)}`]?.v))).map((k) => ref.ws[k].v as number)[0];
    assert.ok(grandTotalCf({ lots }).sub(manual).abs().lt(1e-6), `${grandTotalCf({ lots })} vs ${manual}`);
  });
});
