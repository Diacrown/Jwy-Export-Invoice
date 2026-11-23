/** Node runner — exercises the full pipeline on real files, writes the
 *  workbook and (optionally) diffs it against a manual MASTER DETAILS file.
 *
 *  Usage:
 *    npm run local-run -- <packing-list.xls> [more.xls …] [options]
 *
 *  Options:
 *    --ref <manual.xls>   copy studding details (cert / grade / rate, sieve
 *                         splits, typed AR) from a manual workbook, keep only
 *                         its pieces, and print a per-piece / per-lot diff
 *    --ref-gross          use the manual's gross weights (EXP535 rounded them)
 *    --round-gross        round gross weights to 2 dp (EXP535 / EXP615 practice)
 *    --base 135.176       base-gold lock rate; default = gold × 0.0321199 (3 dp)
 *    --hsn-natural        print "…STUDDED WITH NATURAL DIAMONDS" (EXP615 wording)
 *    --ar-full            keep AR at full precision (EXP535); default rounds to 2 dp (EXP615)
 *    --pkg 2.19           package gross weight in kg
 *    --out <file.xlsx>    output path (default: ./generated-by-ts.xlsx)
 *    --gold 4339.8413 --purity 0.999 --fx 95.35 --labour-fx 95.1
 *    --inv EXP999/2026-27 --date 2026-10-15
 *
 *  Example (reproduces EXP535 to the cent):
 *    npm run local-run -- "../Raw Data Sheet From Jwy/SJ-50 # DCJ # 1.10.2026 # 10 pcs.xls" \
 *      "../Raw Data Sheet From Jwy/SDJ-JB-045 # 26-27 # DCJ # Dt-30.09.2026.xls" \
 *      --ref "../Previous Export Invoices Reference/INVOICE NO. EXP535-2026-27 (B-JEW) MASTER DETAILS.xls" \
 *      --ref-gross --fx 95.35 --labour-fx 95.1 --inv EXP535/2026-27 --date 2026-10-01
 */
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";

import { groupPiecesIntoLots } from "../src/lib/grouping";
import { computeLotTotals, defaultBaseGoldRate, grandTotalCf, grandTotalInr, pureGoldUsedGm, withGrossRounded } from "../src/lib/calculations";
import { generateXlsx } from "../src/generators/xlsx";
import { runAll } from "../src/lib/validators";
import type { PerInvoiceInputs } from "../src/types";
import { BANKS, BUYERS, HSN, LABOUR, SETTINGS, applyReference, hsnWith, parseFiles, readReference } from "../tests/helpers/reference";

function parseArgs(argv: string[]) {
  const files: string[] = [];
  const opt: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (["ref-gross", "round-gross", "hsn-natural", "ar-full"].includes(key)) opt[key] = true;
      else { opt[key] = next; i++; }
    } else files.push(a);
  }
  return { files, opt };
}

async function main() {
  const { files, opt } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.error("Usage: npm run local-run -- <packing-list.xls> [more.xls] [--ref manual.xls] [--out out.xlsx]");
    process.exit(2);
  }
  const s = (k: string, d: string) => (typeof opt[k] === "string" ? (opt[k] as string) : d);

  const gold = new Decimal(s("gold", "4339.8413"));
  const base = typeof opt.base === "string" ? new Decimal(opt.base) : defaultBaseGoldRate(gold, SETTINGS.base_gold_lock_ratio);
  const hsn = opt["hsn-natural"] ? hsnWith("JEWELLERY STUDDED WITH NATURAL DIAMONDS") : HSN;

  let pieces = withGrossRounded(await parseFiles(files), !!opt["round-gross"]);
  console.log(`Parsed ${pieces.length} pieces from ${files.map((f) => path.basename(f)).join(", ")} · base-lock rate ${base}`);
  const ref = typeof opt.ref === "string" ? readReference(opt.ref) : null;
  if (ref) {
    pieces = applyReference(pieces, ref.pieces, {
      useRefGross: !!opt["ref-gross"],
      baseLock: { touch: SETTINGS.kt_touch, rate: base.toNumber() },
    });
    console.log(`Kept the ${pieces.length} pieces that appear on ${path.basename(opt.ref as string)}`);
  }

  const fx = new Decimal(s("fx", "95.25"));
  const inputs: PerInvoiceInputs = {
    invoice_number: s("inv", "EXP999/2026-27"), invoice_date: s("date", "2026-10-15"),
    buyer_id: BUYERS[1].id, bank_id: BANKS[0].id,
    pre_carriage_text: "SEQUEL", flight_mode_text: "BY AIR FREIGHT", port_of_loading_text: "MUMBAI / INDIA",
    terms_text: "150 DAYS DA", preferential_agreement_text: "NCPTI",
    gold_rate_usd_per_troy_oz: gold, gold_purity: new Decimal(s("purity", "0.999")),
    gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "OX26100MUM1059",
    gold_purchase_date: "2026-09-22", gold_opening_stock_gm: new Decimal(200),
    inr_usd_rate: fx, labour_inr_usd_rate: new Decimal(s("labour-fx", fx.toString())),
    base_gold_rate_usd_per_gm: base,
    package_gross_wt_kg: new Decimal(s("pkg", "1.68")), container_number: 1,
    discount_usd: new Decimal(0), freight_usd: new Decimal(0), insurance_usd: new Decimal(0), commission_usd: new Decimal(0),
  };

  const lots = groupPiecesIntoLots(pieces, hsn, new Decimal(SETTINGS.default_wastage_pct));
  for (const lot of lots) {
    computeLotTotals({
      lot,
      gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz, gold_purity: inputs.gold_purity,
      labour_inr_usd_rate: inputs.labour_inr_usd_rate, base_gold_rate_usd_per_gm: inputs.base_gold_rate_usd_per_gm,
      kt_touch: SETTINGS.kt_touch, labor_rates: LABOUR, fixed_addon_usd: new Decimal(SETTINGS.mfg_fixed_addon_usd),
      round_base_lock_2dp: !opt["ar-full"],
    });
    const t = lot.totals!;
    console.log(`  Lot ${lot.lot_no}: ${lot.description} · HSN ${lot.hsn_code} · ${lot.pieces.length} pcs · wastage ${lot.wastage_pct.mul(100)}%`);
    console.log(`         gold $${t.gold_value_usd.toFixed(2)}  studd $${t.diamond_value_usd.add(t.stone_value_usd).toFixed(2)}  mfg $${t.mfg_cost_usd.toFixed(2)}  total $${t.total_usd.toFixed(2)}  VA ${t.value_addition_ratio.mul(100).toFixed(2)}%`);
  }
  const usd = grandTotalCf({ lots });
  const inr = grandTotalInr(usd, inputs.inr_usd_rate);
  console.log(`C&F: USD $${usd.toFixed(2)}  ·  INR ₹${inr.toFixed(2)}`);

  const rep = runAll({ pieces, lots, inputs, hsnTable: hsn, defaultWastagePct: new Decimal(0.04), settings: SETTINGS });
  for (const f of rep.findings.filter((x) => !x.passed)) console.log(`  [${f.severity}] ${f.code} ${f.message}`);

  if (ref) {
    console.log("\nDiff vs manual workbook (CUSTOMS PL):");
    const calcs = lots.flatMap((l) => l.pieces.map((p, i) => ({ p, c: l.piece_calcs![i] })));
    let diffs = 0;
    ref.pieces.forEach((rp, i) => {
      const { p, c } = calcs.find(({ p }) => p === pieces[i])!;
      const row = (label: string, ours: number, theirs: number | undefined, tol: number) => {
        if (theirs === undefined || Math.abs(ours - theirs) <= tol) return;
        diffs++;
        console.log(`  row ${rp.row} ${rp.style.padEnd(20)} ${label.padEnd(6)} ours ${ours.toFixed(4)}  manual ${theirs.toFixed(4)}`);
      };
      row("gross", p.gross_wt.toNumber(), rp.gross, 1e-9);
      row("net K", c.net_wt.toNumber(), rp.net, 1e-9);
      row("AR", c.base_lock.toNumber(), rp.ar, 1e-6);
      row("AK", c.mfg.toNumber(), rp.ak, 1e-9);
    });
    const manualCf = Object.keys(ref.ws).filter((k) => /^AL\d+$/.test(k)).map((k) => ref.ws[k]).filter((c) => typeof c.v === "number").pop();
    console.log(diffs ? `${diffs} cell difference(s).` : "All piece rows match (gross, net, AR, AK).");
    if (manualCf) console.log(`Manual grand total ${Number(manualCf.v).toFixed(4)}  ·  ours ${usd.toFixed(4)}  ·  Δ ${usd.sub(Number(manualCf.v)).toFixed(4)}`);
  }

  const used = lots.reduce((a, l) => a.add(pureGoldUsedGm(l, inputs.gold_purity)), new Decimal(0));
  console.log(`Gold drawn: ${used.toFixed(3)} g pure incl. wastage`);

  const blob = await generateXlsx({
    settings: SETTINGS, buyer: BUYERS[1], bank: BANKS[0], buyers: BUYERS, banks: BANKS,
    inputs, lots, totals_usd: usd, totals_inr: inr,
  });
  const outPath = path.resolve(s("out", "generated-by-ts.xlsx"));
  fs.writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
