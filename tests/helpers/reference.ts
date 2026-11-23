/** Test helpers: read the real sample files that live next to the repo.
 *
 * The samples are business data and are NOT committed. Point
 * JWY_SAMPLES_DIR at the folder holding "Raw Data Sheet From Jwy" and
 * "Previous Export Invoices Reference" (default: the repo's parent folder).
 * Tests that need them skip when the folder is absent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

import { parsePackingLists } from "../../src/parsers/sj50";
import type { AppSettings, Bank, Buyer, HsnEntry, JewelleryType, Piece } from "../../src/types";
import { ktNumber } from "../../src/lib/mappings";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..");
export const SAMPLES = process.env.JWY_SAMPLES_DIR ?? path.resolve(REPO, "..");
export const RAW_DIR = path.join(SAMPLES, "Raw Data Sheet From Jwy");
export const REF_DIR = path.join(SAMPLES, "Previous Export Invoices Reference");
export const haveSamples = fs.existsSync(RAW_DIR) && fs.existsSync(REF_DIR);

export function findFile(dir: string, contains: string): string {
  const f = fs.readdirSync(dir).find((n) => n.includes(contains));
  if (!f) throw new Error(`No file containing '${contains}' in ${dir}`);
  return path.join(dir, f);
}

/** Extra folder for newer samples not yet filed into the two sample folders
 *  (e.g. JWY_EXTRA_SAMPLES_DIR=%USERPROFILE%\Downloads). */
export const EXTRA_DIR = process.env.JWY_EXTRA_SAMPLES_DIR ?? "";

/** Look in the raw / reference folders and the extra folder; null if absent. */
export function findSample(contains: string): string | null {
  for (const dir of [RAW_DIR, REF_DIR, EXTRA_DIR]) {
    if (!dir || !fs.existsSync(dir)) continue;
    const f = fs.readdirSync(dir).find((n) => n.includes(contains) && !n.startsWith("~$"));
    if (f) return path.join(dir, f);
  }
  return null;
}

export async function parseFiles(paths: string[]): Promise<Piece[]> {
  const files = paths.map((p) => {
    const buf = fs.readFileSync(p);
    return { file: new Blob([buf]), name: path.basename(p) };
  });
  return (await parsePackingLists(files)).pieces;
}

export interface RefStud { shape?: string; pcs: number; cts: number; rate?: number; cert?: string; origin?: string; grade?: string }
export interface RefPiece {
  row: number; style: string; kt: number; gross: number; net: number;
  ak: number; ar?: number; at?: number; au?: number; az?: number; studs: RefStud[];
}

/** Piece rows of a manual CUSTOMS PL (EXP535-style layout). */
export function readReference(file: string): { pieces: RefPiece[]; ws: XLSX.WorkSheet; inv: XLSX.WorkSheet } {
  // The ESM build of SheetJS has no fs access, so read the bytes ourselves.
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", cellFormula: true });
  const ws = wb.Sheets["CUSTOMS PL"];
  const inv = wb.Sheets["INVOICE"];
  const v = (a: string) => ws[a]?.v;
  const n = (a: string) => (typeof v(a) === "number" ? (v(a) as number) : undefined);
  const s = (a: string) => (typeof v(a) === "string" ? String(v(a)).trim() : undefined);
  const last = XLSX.utils.decode_range(ws["!ref"]!).e.r + 1;
  const isPiece = (r: number) => typeof v(`D${r}`) === "string" && typeof v(`F${r}`) === "number" && typeof v(`J${r}`) === "number";
  const isTotal = (r: number) => /TOTAL/.test(String(v(`C${r}`) ?? ""));
  const pieces: RefPiece[] = [];
  const shapeCols = ["Q", "R", "S", "T", "U", "V", "W"];
  let shapeHdr: Record<string, string> = {};
  for (let r = 1; r <= last; r++) {
    if (/^Sr\.?\s+No\.?$/i.test(String(v(`C${r}`) ?? "").trim())) {
      shapeHdr = Object.fromEntries(shapeCols.map((c) => [c, String(v(`${c}${r}`) ?? "").trim()]));
    }
    if (!isPiece(r)) continue;
    const studs: RefStud[] = [];
    for (let rr = r; rr <= last && (rr === r || (!isPiece(rr) && !isTotal(rr))); rr++) {
      const cts = n(`AB${rr}`);
      if (!cts || cts <= 0) continue;
      const col = shapeCols.find((c) => (n(`${c}${rr}`) ?? 0) > 0);
      studs.push({
        shape: col ? shapeHdr[col] : undefined, pcs: col ? n(`${col}${rr}`)! : 0,
        cts, rate: n(`AC${rr}`), cert: s(`X${rr}`), origin: s(`Y${rr}`), grade: s(`AA${rr}`),
      });
    }
    pieces.push({
      row: r, style: String(v(`D${r}`)).trim(), kt: n(`F${r}`)!, gross: n(`J${r}`)!, net: n(`K${r}`)!,
      ak: n(`AK${r}`)!, ar: n(`AR${r}`), at: n(`AT${r}`), au: n(`AU${r}`), az: n(`AZ${r}`), studs,
    });
  }
  return { pieces, ws, inv };
}

/** Pick the parsed pieces that appear on a manual invoice, and copy the
 *  hand-typed studding details (cert / origin / grade / rate) onto them.
 *  Matching is by KT + total carats + gross (to 0.01 — EXP535 rounds gross). */
export function applyReference(
  parsed: Piece[], ref: RefPiece[],
  opts: { useRefGross?: boolean; baseLock?: { touch: Record<string, number>; rate: number } } = {},
): Piece[] {
  const pool = [...parsed];
  const out: Piece[] = [];
  for (const rp of ref) {
    const refCts = rp.studs.reduce((a, d) => a + d.cts, 0);
    const idx = pool.findIndex((p) =>
      ktNumber(p.kt) === rp.kt &&
      Math.abs(p.gross_wt.toNumber() - rp.gross) < 0.0051 &&
      Math.abs(p.diamonds.reduce((a, d) => a + d.cts.toNumber(), 0) - refCts) < 0.0001);
    if (idx < 0) throw new Error(`No parsed piece matches reference row ${rp.row} (${rp.style})`);
    const p = pool.splice(idx, 1)[0];
    if (opts.useRefGross) p.gross_wt = new Decimal(rp.gross);
    const studs = [...rp.studs];
    const next: typeof p.diamonds = [];
    for (const d of p.diamonds) {
      const j = studs.findIndex((x) => Math.abs(x.cts - d.cts.toNumber()) < 0.0001);
      if (j >= 0) {
        const st = studs.splice(j, 1)[0];
        next.push({ ...d, rate_usd_per_ct: st.rate !== undefined ? new Decimal(st.rate) : null,
          certificate_no: st.cert ?? null, origin: st.origin ?? d.origin ?? null, color_clarity: st.grade ?? null });
        continue;
      }
      // The clerk split this SJ-50 row by sieve size (EXP546: Round 54 pcs 0.83 ct
      // → 24/0.15 @60.38 + 13/0.37 @48.03 + 17/0.31 @52.68). Take the split rows.
      const parts = studs.filter((x) => x.pcs > 0 && (!x.shape || x.shape.toUpperCase().startsWith(d.shape.slice(0, 3))));
      const ctsSum = parts.reduce((a, x) => a + x.cts, 0);
      const pcsSum = parts.reduce((a, x) => a + x.pcs, 0);
      if (parts.length > 1 && Math.abs(ctsSum - d.cts.toNumber()) < 0.0001 && pcsSum === d.pcs) {
        for (const st of parts) {
          studs.splice(studs.indexOf(st), 1);
          next.push({ shape: d.shape, pcs: st.pcs, cts: new Decimal(st.cts), rate_usd_per_ct: st.rate !== undefined ? new Decimal(st.rate) : null,
            certificate_no: st.cert ?? null, origin: st.origin ?? d.origin ?? null, color_clarity: st.grade ?? null });
        }
      } else {
        next.push(d);
      }
    }
    p.diamonds = next;
    if (rp.az !== undefined && rp.az !== 10) p.fixed_addon_usd = new Decimal(rp.az);
    // A manual AR that differs from the formula was typed by the clerk
    // (EXP535 B00752: 367.42 vs 367.4245) — replay it as a per-piece override.
    if (opts.baseLock && rp.ar !== undefined && p.net_wt_raw) {
      const formula = new Decimal(p.net_wt_raw.toFixed(2)).mul(opts.baseLock.touch[String(rp.kt)]).mul(opts.baseLock.rate);
      if (formula.sub(rp.ar).abs().gt(1e-6)) p.base_gold_lock_usd = new Decimal(rp.ar);
    }
    out.push(p);
  }
  return out;
}

// ───────────── fixtures mirroring supabase/schema.sql seeds + migration ─────────────

/** EXP615 (newest) wording; EXP535-era invoices printed "…STUDDED WITH DIAMONDS". */
export function hsnWith(diamondTail: string): Record<JewelleryType, HsnEntry> {
  return { ...HSN, gold_studded_diamond: { ...HSN.gold_studded_diamond, description_tail: diamondTail } };
}

export const HSN: Record<JewelleryType, HsnEntry> = {
  gold_plain: { jewellery_type: "gold_plain", code: "71131911", description_tail: "JEWELLERY PLAIN", max_wastage_handcrafted: 0.0225, min_value_addition: 0.035 },
  gold_mounting: { jewellery_type: "gold_mounting", code: "71131911", description_tail: "MOUNTING JEWELLERY", max_wastage_handcrafted: 0.02, min_value_addition: 0.025 },
  gold_studded_diamond: { jewellery_type: "gold_studded_diamond", code: "71131913", description_tail: "JEWELLERY STUDDED WITH DIAMONDS", max_wastage_handcrafted: 0.04, min_value_addition: 0.07 },
  gold_studded_lgd: { jewellery_type: "gold_studded_lgd", code: "71131914", description_tail: "JEWELLERY STUDDED WITH LABGROWN DIAMONDS", max_wastage_handcrafted: 0.04, min_value_addition: 0.07 },
  gold_studded_colorstone: { jewellery_type: "gold_studded_colorstone", code: "71131915", description_tail: "JEWELLERY STUDDED WITH SEMI PRECIOUS STONE", max_wastage_handcrafted: 0.04, min_value_addition: 0.06 },
};

export const LABOUR = { "9": 1275, "14": 1275, "18": 1275, "18-PD": 2000 };

export const SETTINGS: AppSettings = {
  exporter_name: "M/S. DIACROWN",
  exporter_address: "DE7010, Bharat Diamond Bourse, Bandra Kurla Complex, Bandra East, Mumbai-400051, Mumbai, Maharashtra, India",
  iec_no: "0390030252", pan: "AACFD9509R", gstin: "27AACFD9509R1ZS",
  state_code: 27, state_name: "MAHARASHTRA", district_code: 483, district_name: "MUMBAI SUBURBAN",
  signatory_block_1: "FOR DIACROWN", signatory_block_2: "PARTNER", signatory_name: "ANAND M JHAVERI",
  lut_arn_number: "AD270326095695I", lut_arn_date: "27/03/2026",
  insurance_wording: "INSURANCE COVERED DOOR TO DOOR BY", container_prefix: "Container No.",
  tin_box_text: "THREE INVOICES IN ONE TIN BOX(1)", handcrafted_text: "HANDCRAFTED",
  mfg_fixed_addon_usd: 10, default_wastage_pct: 0.04,
  base_gold_lock_ratio: 0.0321199, kt_touch: { "9": 0.385, "14": 0.595, "18": 0.76 },
  payment_instructions: ["Correspondent Bank: The Bank of New York (New York United States)", "SWIFT: IRVTUS3N", "For Credit To A/c No: 8900444096"],
  declarations: ["We certify that the particulars above are true and correct."],
};

export const BUYERS: Buyer[] = [
  { id: "b1", display_index: 1, name: "WORLD SHINER PTY LTD", address: "Sydney address", city: "SYDNEY", country: "AUSTRALIA", default_terms: "150 Days DA", default_preferential_agreement: "ECTA-AU" },
  { id: "b3", display_index: 3, name: "WORLD SHINER PTY LTD", address: "Unit 17, Level 11, 138 Albert Street, Brisbane, QLD 4000, Australia", city: "BRISBANE", country: "AUSTRALIA", default_terms: "150 Days DA", default_preferential_agreement: "ECTA-AU" },
];
export const BANKS: Bank[] = [
  { id: "k1", display_index: 1, name: "INDUSIND BANK LTD.", ad_code: "6380002-600009", account_no: "200999949087", swift: "INDBINBBBOO", ifsc: "INDB0000342", address: "BDB, Mumbai" },
  { id: "k2", display_index: 2, name: "ICICI BANK LTD", ad_code: "6391864-2910009", account_no: "121705005648", swift: "ICICINBBCTS", ifsc: "ICIC0001217", address: "BKC, Mumbai" },
];
