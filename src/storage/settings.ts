/** CRUD wrappers for app settings + HSN table + labor rates. */
import type { AppSettings, HsnEntry, JewelleryType } from "../types";
import { supabase } from "../supabase";

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
    lut_arn_date: data.lut_arn_date,
    insurance_wording: data.insurance_wording,
    container_prefix: data.container_prefix,
    tin_box_text: data.tin_box_text,
    handcrafted_text: data.handcrafted_text,
    mfg_fixed_addon_usd: Number(data.mfg_fixed_addon_usd),
    default_wastage_pct: Number(data.default_wastage_pct),
    payment_instructions: data.payment_instructions,
    declarations: data.declarations,
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
