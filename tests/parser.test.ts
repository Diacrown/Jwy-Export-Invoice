/** Parser + second reconciliation (EXP546 from the 05.10 SJ-50). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Decimal from "decimal.js";

import { parseSj50 } from "../src/parsers/sj50";
import { parseSdjjb } from "../src/parsers/sdjjb";
import { groupPiecesIntoLots } from "../src/lib/grouping";
import { computeLotTotals, grandTotalCf } from "../src/lib/calculations";
import { lotColor, normalizeColor, normalizeShape, normalizeCategory } from "../src/lib/mappings";
import {
  HSN, LABOUR, RAW_DIR, REF_DIR, SETTINGS, applyReference, findFile, haveSamples, parseFiles, readReference,
} from "./helpers/reference";

const skip = !haveSamples && "sample files not found (set JWY_SAMPLES_DIR)";
const blob = (p: string) => new Blob([fs.readFileSync(p)]);

describe("mappings", () => {
  it("normalises the values seen in real files", () => {
    assert.equal(normalizeColor("Y-W"), "YELLOW & WHITE");
    assert.equal(normalizeColor("Y/W"), "YELLOW & WHITE");
    assert.equal(lotColor(["YELLOW & WHITE", "WHITE", "YELLOW"]), "YELLOW & WHITE");
    assert.equal(lotColor(["WHITE", "WHITE"]), "WHITE");
    assert.equal(normalizeShape("Emerld"), "EMERALD");
    assert.equal(normalizeShape("Baguettes"), "BAGUETTE");
    assert.equal(normalizeShape("Round Pointer"), "ROUND");
    assert.equal(normalizeCategory("Cust PN"), "PENDANT");
  });
});

describe("SJ-50 parser on real files", { skip }, () => {
  it("1.10 file: 10 pieces, 4 shapes, no 'Total Dia.' shape", async () => {
    const ps = await parseSj50(blob(findFile(RAW_DIR, "SJ-50 # DCJ # 1.10.2026")), "1.10");
    assert.equal(ps.length, 10);
    const shapes = new Set(ps.flatMap((p) => p.diamonds.map((d) => d.shape)));
    assert.deepEqual([...shapes].sort(), ["CUSHION", "EMERALD", "RADIANT", "ROUND"]);
    // Σ carats must equal the sheet's "Total Dia." Wt (18.97) — no double counting
    const cts = ps.reduce((a, p) => a + p.diamonds.reduce((x, d) => x + d.cts.toNumber(), 0), 0);
    assert.ok(Math.abs(cts - 18.97) < 1e-9, `cts=${cts}`);
  });

  it("07.10 file: two blocks with different shape columns → 18 pieces", async () => {
    const ps = await parseSj50(blob(findFile(RAW_DIR, "07.10.2026")), "07.10");
    assert.equal(ps.length, 18);
    const r0228 = ps.find((p) => p.cust_style_no === "R0228-0250-N50")!;
    assert.equal(r0228.diamonds[0].shape, "MARQUISE");     // block 2 has Marquise where block 1 had Emerld
    const m00232 = ps.find((p) => p.cust_style_no === "M00232")!;
    assert.equal(m00232.diamonds[0].shape, "EMERALD");
    assert.equal(ps.filter((p) => p.semi_mount).length, 0);
  });

  it("SDJ-JB vendor file: reads the Packing List sheet and the labour rates", async () => {
    const path = findFile(RAW_DIR, "SDJ-JB-045");
    const ps = await parseSj50(blob(path), "SDJ-JB-045");
    assert.deepEqual(ps.map((p) => p.cust_style_no), ["T00544", "S01287", "B00718"]);
    assert.equal(ps[0].semi_mount, true);                  // "LGD SEMI"
    assert.equal(ps[0].jewellery_type, "gold_studded_lgd");
    const v = await parseSdjjb(blob(path));
    assert.equal(v.labor_rate_by_kt["14"].toNumber(), 1275);
    assert.equal(v.labor_rate_by_kt["18"].toNumber(), 1275);
  });

  it("rejects the gold ledger with a specific message", async () => {
    await assert.rejects(parseSj50(blob(findFile(RAW_DIR, "23.09.2026 # cust copy")), "ledger"), /gold stock ledger/);
  });
});

describe("EXP546 (UK-JEW, 3 pendants)", { skip }, () => {
  it("reproduces MFG per piece and the lot total", async () => {
    const parsed = await parseFiles([findFile(RAW_DIR, "SJ-50 # DCJ # 5.10.2026")]);
    const ref = readReference(findFile(REF_DIR, "EXP546"));
    const pieces = applyReference(parsed, ref.pieces, {
      useRefGross: true, baseLock: { touch: SETTINGS.kt_touch, rate: 139.395 },
    });
    const lots = groupPiecesIntoLots(pieces, HSN, new Decimal(0.04));
    assert.equal(lots.length, 1);
    assert.equal(lots[0].description, "9 KT YELLOW GOLD JEWELLERY STUDDED WITH LABGROWN DIAMONDS");
    computeLotTotals({
      lot: lots[0],
      gold_rate_usd_per_troy_oz: new Decimal("4339.8413"), gold_purity: new Decimal("0.999"),
      labour_inr_usd_rate: new Decimal("95.25"), base_gold_rate_usd_per_gm: new Decimal("139.395"),
      kt_touch: SETTINGS.kt_touch, labor_rates: LABOUR, fixed_addon_usd: new Decimal(10),
      round_base_lock_2dp: false,   // EXP546 kept AR at full precision
    });
    assert.deepEqual(lots[0].piece_calcs!.map((c) => c.mfg.toNumber()), ref.pieces.map((p) => p.ak));
    // Match the manual CUSTOMS PL total exactly. The manual INVOICE!N44
    // (635.6811) disagrees with its own packing list (635.6843) by 0.3¢.
    const manualTotal = ref.ws["AL25"].v as number;
    assert.ok(grandTotalCf({ lots }).sub(manualTotal).abs().lt(1e-6), `${grandTotalCf({ lots })} vs ${manualTotal}`);
    assert.ok(Math.abs((ref.inv["N44"].v as number) - manualTotal) < 0.01);
  });
});
