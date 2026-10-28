/** Node runner — exercises the full generator pipeline on a real SJ-50
 *  sample, writes the output xlsx, and prints key diagnostics.
 *
 *  Usage: npx tsx scripts/local-run.ts <path-to-sj50.xls|.xlsx>
 */
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";

import { parseSj50 } from "../src/parsers/sj50";
import { groupPiecesIntoLots } from "../src/lib/grouping";
import { computeLotTotals, grandTotalCf, grandTotalInr } from "../src/lib/calculations";
import { generateXlsx } from "../src/generators/xlsx";
import type { AppSettings, HsnEntry, JewelleryType, Buyer, Bank, PerInvoiceInputs } from "../src/types";

// Minimal in-memory settings mirror of settings.example.yaml / schema.sql seeds
const settings: AppSettings = {
  exporter_name: "M/S. DIACROWN",
  exporter_address: "DE-7010, Bharat Diamond Bourse, Bandra Kurla Complex, Bandra East, Mumbai-400051, Mumbai, Maharashtra, India",
  iec_no: "0390030252", pan: "AACFD9509R", gstin: "27AACFD9509R1ZS",
  state_code: 27, state_name: "MAHARASHTRA",
  district_code: 483, district_name: "MUMBAI SUBURBAN",
  signatory_block_1: "FOR DIACROWN", signatory_block_2: "PARTNER",
  signatory_name: "ANAND M. JHAVERI",
  lut_arn_number: "AD270326095695I", lut_arn_date: "27/03/2026",
  insurance_wording: "INSURANCE COVERED DOOR TO DOOR BY - SEQUEL",
  container_prefix: "CONTAINER N0.", tin_box_text: "THREE INVOICES IN 1 TIN BOX",
  handcrafted_text: "HANDCRAFTED",
  mfg_fixed_addon_usd: 10, default_wastage_pct: 0.04,
  payment_instructions: [
    "Correspondent Bank: The Bank of New York (New York United States)",
    "SWIFT: IRVTUS3N",
    "For Credit To A/c No: 8900444096",
  ],
  declarations: [
    "Based on personal knowledge...",
    "No E way bill is required...",
  ],
};

const buyer: Buyer = {
  id: "test-buyer", display_index: 1, name: "WORLD SHINER PTY LTD",
  address: "Suite 301, Level 3, The Cullinan Building, 70 Castlereagh Street, Sydney, NSW 2000, Australia",
  city: "SYDNEY", country: "AUSTRALIA",
  default_terms: "150 Days DA", default_preferential_agreement: "ECTA-AU",
};
const bank: Bank = {
  id: "test-bank", display_index: 2, name: "ICICI BANK LTD",
  ad_code: "6391864-2910009", account_no: "121705005648",
  swift: "ICICINBBCTS", ifsc: "ICIC0001217",
};

const hsnTable: Record<JewelleryType, HsnEntry> = {
  gold_plain: { jewellery_type: "gold_plain", code: "71131911", description_tail: "JEWELLERY PLAIN", max_wastage_handcrafted: 0.0225, min_value_addition: 0.035 },
  gold_mounting: { jewellery_type: "gold_mounting", code: "71131911", description_tail: "MOUNTING", max_wastage_handcrafted: 0.02, min_value_addition: 0.025 },
  gold_studded_diamond: { jewellery_type: "gold_studded_diamond", code: "71131913", description_tail: "JEWELLERY STUDDED WITH DIAMONDS", max_wastage_handcrafted: 0.04, min_value_addition: 0.07 },
  gold_studded_lgd: { jewellery_type: "gold_studded_lgd", code: "71131914", description_tail: "JEWELLERY STUDDED WITH LAB GROWN DIAMONDS", max_wastage_handcrafted: 0.04, min_value_addition: 0.07 },
  gold_studded_colorstone: { jewellery_type: "gold_studded_colorstone", code: "71131915", description_tail: "JEWELLERY STUDDED WITH PRECIOUS & SEMI PRECIOUS STONE", max_wastage_handcrafted: 0.04, min_value_addition: 0.06 },
};

const laborRates: Record<string, number> = { "9": 1275, "14": 1275, "18": 1275, "18-PD": 2000 };

async function main() {
  const sj50Path = process.argv[2];
  if (!sj50Path) { console.error("Usage: tsx scripts/local-run.ts <sj50.xls|xlsx>"); process.exit(2); }

  const buf = fs.readFileSync(sj50Path);
  const blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]);
  const pieces = await parseSj50(blob);
  console.log(`Parsed ${pieces.length} pieces from ${path.basename(sj50Path)}`);
  console.log("Shapes seen:", [...new Set(pieces.flatMap(p => p.diamonds.map(d => d.shape)))].sort());
  console.log("Jewellery types:", [...new Set(pieces.map(p => p.jewellery_type))]);

  const wastagePct = new Decimal(settings.default_wastage_pct);
  const lots = groupPiecesIntoLots(pieces, hsnTable, wastagePct);
  console.log(`Grouped into ${lots.length} lots:`);
  for (const l of lots) {
    console.log(`  Lot ${l.lot_no}: KT=${l.kt} color=${l.color} HSN=${l.hsn_code} (${l.pieces.length} pcs)`);
  }

  const inputs: PerInvoiceInputs = {
    invoice_number: "EXP999/2026-27", invoice_date: "2026-10-15",
    buyer_id: buyer.id, bank_id: bank.id,
    gold_rate_usd_per_troy_oz: new Decimal("4339.8413"), gold_purity: new Decimal("0.999"),
    gold_purchase_party: "DIAMOND INDIA LIMITED",
    gold_purchase_invoice_no: "OX26100MUM1059",
    gold_purchase_date: "2026-09-22",
    inr_usd_rate: new Decimal("95.25"),
    package_gross_wt_kg: new Decimal("1.68"), container_number: 1,
    discount_usd: new Decimal(0), freight_usd: new Decimal(0),
    insurance_usd: new Decimal(0), commission_usd: new Decimal(0),
  };

  for (const lot of lots) {
    computeLotTotals({
      lot, hsn: hsnTable[lot.jewellery_type],
      gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz,
      gold_purity_imported: inputs.gold_purity,
      inr_usd_rate: inputs.inr_usd_rate,
      wastage_pct: wastagePct,
      labor_rate_inr_per_gm: new Decimal(laborRates[lot.kt] ?? 1275),
      fixed_addon_usd: new Decimal(settings.mfg_fixed_addon_usd),
    });
    const t = lot.totals!;
    const vap = t.value_addition_ratio.mul(100).toFixed(2);
    console.log(`  Lot ${lot.lot_no} totals: gross=${t.gross_wt} net=${t.net_wt} gold=$${t.gold_value_usd} mfg=$${t.mfg_cost_usd} total=$${t.total_usd} VA=${vap}%`);
  }

  const usd = grandTotalCf({ lots });
  const inr = grandTotalInr(usd, inputs.inr_usd_rate);
  console.log(`Grand total: USD $${usd.toFixed(2)}  INR ₹${inr.toFixed(2)}`);

  const blobOut = await generateXlsx({ settings, buyer, bank, inputs, lots, totals_usd: usd, totals_inr: inr });
  const outPath = path.join(path.dirname(sj50Path), "generated-by-ts.xlsx");
  const bufOut = Buffer.from(await blobOut.arrayBuffer());
  fs.writeFileSync(outPath, bufOut);
  console.log(`Wrote ${outPath} (${bufOut.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
