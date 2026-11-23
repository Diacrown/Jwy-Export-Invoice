/** CRUD wrappers for app settings + HSN table + labor rates.
 *
 * Loaders fall back to the values recovered from the manual workbooks when a
 * column from migration 2026-11-23 is not there yet, so the app keeps working
 * on a database that has not been migrated (Settings → save will then fail
 * with a clear message instead).
 */
import type { AppSettings, HsnEntry, JewelleryType } from "../types";
import { supabase } from "../supabase";
import { DEFAULT_BASE_GOLD_LOCK_RATIO, DEFAULT_KT_TOUCH } from "../lib/calculations";

const MIGRATION_HINT =
  "Run supabase/migrations/2026-11-23-manual-workbook-rules.sql in the Supabase SQL editor.";

/** Turn PostgREST "column does not exist" errors into an actionable message. */
export function explainDbError(e: unknown): Error {
  const err = e as { message?: string; code?: string };
  const msg = err?.message ?? String(e);
  if (err?.code === "PGRST204" || err?.code === "42703" || /column .* does not exist|Could not find the '.*' column/i.test(msg)) {
    return new Error(`${msg} — the database is missing columns. ${MIGRATION_HINT}`);
  }
  return e instanceof Error ? e : new Error(msg);
}

function parseTouch(v: unknown): Record<string, number> {
  if (v && typeof v === "object") {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      const x = Number(n);
      if (Number.isFinite(x) && x > 0) out[String(k)] = x;
    }
    if (Object.keys(out).length) return out;
  }
  return { ...DEFAULT_KT_TOUCH };
}

/** dd/mm/yyyy for ISO dates; passes other strings through. */
function isoToSlashDate(v: unknown): string {
  const s = String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

export async function loadAppSettings(): Promise<AppSettings> {
  const { data, error } = await supabase.from("app_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return {
    exporter_name: data.exporter_name,
    exporter_address: data.exporter_address,
    iec_no: data.iec_no,
    pan: data.pan,
    gstin: data.gstin,
    state_code: data.state_code,
    state_name: data.state_name,
    district_code: data.district_code,
    district_name: data.district_name,
    signatory_block_1: data.signatory_block_1,
    signatory_block_2: data.signatory_block_2,
    signatory_name: data.signatory_name,
    lut_arn_number: data.lut_arn_number,
    lut_arn_date: isoToSlashDate(data.lut_arn_date),
    insurance_wording: data.insurance_wording,
    container_prefix: data.container_prefix,
    tin_box_text: data.tin_box_text,
    handcrafted_text: data.handcrafted_text,
    mfg_fixed_addon_usd: Number(data.mfg_fixed_addon_usd),
    default_wastage_pct: Number(data.default_wastage_pct),
    base_gold_lock_ratio:
      data.base_gold_lock_ratio != null ? Number(data.base_gold_lock_ratio) : DEFAULT_BASE_GOLD_LOCK_RATIO,
    kt_touch: parseTouch(data.kt_touch),
    payment_instructions: data.payment_instructions ?? [],
    declarations: data.declarations ?? [],
  };
}

export async function loadHsnTable(): Promise<Record<JewelleryType, HsnEntry>> {
  const { data, error } = await supabase.from("hsn_table").select("*");
  if (error) throw error;
  const out: Partial<Record<JewelleryType, HsnEntry>> = {};
  for (const r of data) {
    out[r.jewellery_type as JewelleryType] = {
      jewellery_type: r.jewellery_type,
      code: r.code,
      description_tail: r.description_tail,
      max_wastage_handcrafted: Number(r.max_wastage_handcrafted),
      min_value_addition: Number(r.min_value_addition),
    };
  }
  return out as Record<JewelleryType, HsnEntry>;
}

export async function loadLaborRates(): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("labor_rates").select("kt, rate_inr_per_gm").eq("current", true);
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of data) out[r.kt] = Number(r.rate_inr_per_gm);
  return out;
}

// ───────────────────────── writes (Settings tab) ─────────────────────────

async function audit(action: string, details: Record<string, unknown>) {
  // Audit failures must not hide a successful save; surface in console only.
  const { error } = await supabase.from("audit_log").insert({ action, details });
  if (error) console.warn("audit_log insert failed", error);
}

/** Patch the app_settings singleton. `lut_arn_date` accepts dd/mm/yyyy or ISO. */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<void> {
  const row: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (typeof patch.lut_arn_date === "string") {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(patch.lut_arn_date.trim());
    row.lut_arn_date = m ? `${m[3]}-${m[2]}-${m[1]}` : patch.lut_arn_date;
  }
  const { error } = await supabase.from("app_settings").update(row).eq("id", 1);
  if (error) throw explainDbError(error);
  await audit("settings.app", { fields: Object.keys(patch) });
}

export async function saveHsnEntry(entry: HsnEntry): Promise<void> {
  const { error } = await supabase.from("hsn_table").update({
    code: entry.code,
    description_tail: entry.description_tail,
    max_wastage_handcrafted: entry.max_wastage_handcrafted,
    min_value_addition: entry.min_value_addition,
  }).eq("jewellery_type", entry.jewellery_type);
  if (error) throw explainDbError(error);
  await audit("settings.hsn", { ...entry });
}

/** Labour rates keep history: flip the old current row off, insert a new one. */
export async function saveLaborRate(kt: string, rateInrPerGm: number): Promise<void> {
  const { error: offErr } = await supabase.from("labor_rates")
    .update({ current: false }).eq("kt", kt).eq("current", true);
  if (offErr) throw explainDbError(offErr);
  const { error } = await supabase.from("labor_rates")
    .insert({ kt, rate_inr_per_gm: rateInrPerGm, current: true });
  if (error) throw explainDbError(error);
  await audit("settings.labor_rate", { kt, rate_inr_per_gm: rateInrPerGm });
}
