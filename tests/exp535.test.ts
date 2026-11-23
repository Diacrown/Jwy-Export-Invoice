/** Regression: rebuild EXP535 from the raw SJ-50 + SDJ-JB packing list and
 *  check it against the manual MASTER DETAILS workbook to the cent. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

import { groupPiecesIntoLots } from "../src/lib/grouping";
import { computeLotTotals, grandTotalCf, grandTotalInr } from "../src/lib/calculations";
import { buildWorkbook } from "../src/generators/xlsx";
import { runAll, isBlocked } from "../src/lib/validators";
import type { Lot, PerInvoiceInputs } from "../src/types";
import {
  BANKS, BUYERS, HSN, LABOUR, RAW_DIR, REF_DIR, SETTINGS, applyReference, findFile, haveSamples, parseFiles, readReference,
} from "./helpers/reference";

const skip = !haveSamples && "sample files not found (set JWY_SAMPLES_DIR)";

const inputs: PerInvoiceInputs = {
  invoice_number: "EXP535/2026-27", invoice_date: "2026-10-01",
  buyer_id: "b3", bank_id: "k1",
  pre_carriage_text: "SEQUEL", flight_mode_text: "BY AIR FREIGHT", port_of_loading_text: "MUMBAI / INDIA",
  terms_text: "150 DAYS DA", preferential_agreement_text: "NCPTI",
  gold_rate_usd_per_troy_oz: new Decimal("4339.8413"), gold_purity: new Decimal("0.999"),
  gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "OX26100MUM1059",
  gold_purchase_date: "2026-09-22", gold_opening_stock_gm: new Decimal(200),
  inr_usd_rate: new Decimal("95.35"), labour_inr_usd_rate: new Decimal("95.1"),
  base_gold_rate_usd_per_gm: new Decimal("139.395"),
  package_gross_wt_kg: new Decimal("5.68"), container_number: 1,
  discount_usd: new Decimal(0), freight_usd: new Decimal(0), insurance_usd: new Decimal(0), commission_usd: new Decimal(0),
};

async function build(useRefGross: boolean) {
  const parsed = await parseFiles([
    findFile(RAW_DIR, "SJ-50 # DCJ # 1.10.2026"),
    findFile(RAW_DIR, "SDJ-JB-045"),
  ]);
  const ref = readReference(findFile(REF_DIR, "EXP535"));
  const pieces = applyReference(parsed, ref.pieces, {
    useRefGross,
    baseLock: { touch: SETTINGS.kt_touch, rate: 139.395 },
  });
  const lots = groupPiecesIntoLots(pieces, HSN, new Decimal(SETTINGS.default_wastage_pct));
  for (const lot of lots) {
    computeLotTotals({
      lot,
      gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz,
      gold_purity: inputs.gold_purity,
      labour_inr_usd_rate: inputs.labour_inr_usd_rate,
      base_gold_rate_usd_per_gm: inputs.base_gold_rate_usd_per_gm,
      kt_touch: SETTINGS.kt_touch,
      labor_rates: LABOUR,
      fixed_addon_usd: new Decimal(SETTINGS.mfg_fixed_addon_usd),
      round_base_lock_2dp: false,   // EXP535 kept AR at full precision
    });
  }
  const usd = grandTotalCf({ lots });
  return { pieces, lots, ref, usd, inr: grandTotalInr(usd, inputs.inr_usd_rate) };
}

const byDesc = (lots: Lot[], d: string) => lots.find((l) => l.description === d);

describe("EXP535 (B-JEW, 4 lots, 11 pcs)", { skip }, () => {
  it("groups into the manual workbook's 4 lots with the same descriptions and wastage", async () => {
    const { lots } = await build(true);
    const want: Array<[string, number, number]> = [
      ["14 KT YELLOW GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS", 1, 0.04],
      ["18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS", 8, 0.04],
      ["9 KT YELLOW GOLD MOUNTING JEWELLERY", 1, 0.02],
      ["18 KT YELLOW & WHITE GOLD JEWELLERY STUDDED WITH DIAMONDS", 1, 0.04],
    ];
    assert.equal(lots.length, 4);
    for (const [desc, pcs, w] of want) {
      const l = byDesc(lots, desc);
      assert.ok(l, `missing lot: ${desc} (have: ${lots.map((x) => x.description).join(" | ")})`);
      assert.equal(l!.pieces.length, pcs);
      assert.equal(l!.wastage_pct.toNumber(), w);
    }
  });

  it("derives AR and reproduces every piece's MFG cost (AK) to the cent", async () => {
    const { lots, ref } = await build(true);
    const calcs = lots.flatMap((l) => l.pieces.map((p, i) => ({ p, c: l.piece_calcs![i] })));
    for (const rp of ref.pieces) {
      const hit = calcs.find(({ p }) => Math.abs(p.gross_wt.toNumber() - rp.gross) < 1e-9 && p.diamonds.reduce((a, d) => a + d.cts.toNumber(), 0) - rp.studs.reduce((a, d) => a + d.cts, 0) < 1e-9 && Number(p.kt.replace("-PD", "")) === rp.kt);
      assert.ok(hit, `no calc for ${rp.style}`);
      assert.equal(hit!.c.mfg.toNumber(), rp.ak, `AK mismatch on ${rp.style}: got ${hit!.c.mfg}, manual ${rp.ak}`);
      if (rp.ar !== undefined) assert.ok(Math.abs(hit!.c.base_lock.toNumber() - rp.ar) < 1e-6, `AR on ${rp.style}: ${hit!.c.base_lock} vs ${rp.ar}`);
      assert.equal(hit!.c.labour_rate_inr.toNumber(), rp.at, `labour rate on ${rp.style}`);
    }
  });

  it("reproduces the C&F total 9296.84 and lot value-addition ratios", async () => {
    const { lots, usd, ref } = await build(true);
    const manualCf = ref.ws["AL84"].v as number;
    assert.ok(Math.abs(usd.toNumber() - manualCf) < 1e-6, `C&F ${usd} vs manual ${manualCf}`);
    assert.equal(usd.toFixed(2), "9296.84");
    const va = (d: string) => byDesc(lots, d)!.totals!.value_addition_ratio.toNumber();
    assert.ok(Math.abs(va("14 KT YELLOW GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS") - (ref.inv["L40"].v as number)) < 1e-9);
    assert.ok(Math.abs(va("9 KT YELLOW GOLD MOUNTING JEWELLERY") - (ref.inv["L80"].v as number)) < 1e-9);
  });

  it("raw SJ-50 weights (3 dp) differ from EXP535 only because the clerk rounded gross to 2 dp", async () => {
    const raw = await build(false);
    const delta = raw.usd.sub(new Decimal("9296.838879450846")).abs();
    assert.ok(delta.lt(2), `unexpected drift ${delta}`);
  });

  it("passes the hard validators and writes a workbook whose cached values match", async () => {
    const { pieces, lots, usd, inr } = await build(true);
    const rep = runAll({ pieces, lots, inputs, hsnTable: HSN, defaultWastagePct: new Decimal(0.04), settings: SETTINGS });
    assert.equal(isBlocked(rep), false, JSON.stringify(rep.findings.filter((f) => !f.passed)));

    const wb = buildWorkbook({
      settings: SETTINGS, buyer: BUYERS[1], bank: BANKS[0], buyers: BUYERS, banks: BANKS,
      inputs, lots, totals_usd: usd, totals_inr: inr,
      drawdowns: [{ exp_number: "EXP532/2026-27", exp_date: "2026-10-01", quantity_gm: 0.784 }],
    });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const back = XLSX.read(buf, { type: "buffer", cellFormula: true });
    const inv = back.Sheets["INVOICE"]; const cpl = back.Sheets["CUSTOMS PL"];

    // Header cells at the manual addresses
    assert.equal(inv["I5"].v, "EXP535/2026-27");
    assert.equal(inv["L5"].v, "01.10.2026");
    assert.equal(inv["B11"].v, "WORLD SHINER PTY LTD");
    assert.match(String(inv["B11"].f), /^IF\(\+Q11=1,\+S11,""\)&IF\(\+Q11=2,\+S12,""\)/);
    assert.equal(inv["Q11"].v, 3);
    assert.equal(inv["B25"].v, "BRISBANE");
    assert.equal(inv["I21"].v, "INDUSIND BANK LTD.");
    assert.equal(inv["K24"].v, "INDBINBBBOO");
    // Lot 1 block (same rows as EXP535 lot 1)
    assert.equal(inv["B28"].v, "LOT NO 1");
    assert.match(String(inv["L32"].f), /^\$E\$\d+\/31\.1035\/24\*D31\/\$F\$\d+$/);
    // C&F and gold anchor
    const cfCell = Object.keys(inv).find((k) => inv[k]?.v === "C&F" && k.startsWith("N"))!;
    const cfRow = Number(cfCell.slice(1));
    assert.equal(Number(inv[`O${cfRow}`].v).toFixed(2), "9296.84");
    assert.equal(inv[`D${cfRow + 1}`].v, "NINE THOUSAND TWO HUNDRED NINETY SIX & EIGHTY FOUR CENTS ONLY");
    const goldRow = Object.keys(inv).find((k) => k.startsWith("B") && inv[k]?.v === "GOLD RATE")!.slice(1);
    assert.equal(inv[`E${goldRow}`].v, 4339.8413);
    // CUSTOMS PL first piece row = manual row 15, AK is a formula
    assert.equal(cpl["C8"].v, "CUSTOMS VALUE ADDITION OF INVOICE # :- ");
    assert.equal(cpl["AK15"].f, "ROUND(BA15,2)");
    assert.equal(cpl["AR15"].v, 367.42);                  // clerk-typed override replayed as a value
    const arFormulas = Object.keys(cpl).filter((k) => /^AR\d+$/.test(k) && cpl[k].f).map((k) => String(cpl[k].f));
    assert.equal(arFormulas.length, 10);
    assert.ok(arFormulas.every((f) => /^\d+\.\d{2}\*0\.(76|385|595)\*139\.395$/.test(f)), arFormulas.join(" | "));
    assert.match(String(cpl["O15"].f), new RegExp(`^INVOICE!\\$E\\$${goldRow}/31\\.1035/24\\*F15/INVOICE!\\$F\\$${goldRow}$`));
  });
});
