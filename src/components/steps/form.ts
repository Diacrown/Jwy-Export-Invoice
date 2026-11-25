/** Per-invoice form state, its validation, and small helpers shared by the wizard steps. */
import Decimal from "decimal.js";
import type { Piece } from "../../types";

export type Step = "upload" | "pieces" | "details" | "review" | "generate";
export const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "pieces", label: "Pieces" },
  { key: "details", label: "Details" },
  { key: "review", label: "Review" },
  { key: "generate", label: "Generate" },
];

export interface FormState {
  invoice_number: string;
  invoice_date: string;
  buyer_id: string | null;
  bank_id: string | null;
  terms_id: string | null;
  pre_carriage_id: string | null;
  flight_mode_id: string | null;
  port_of_loading_id: string | null;
  preferential_agreement_id: string | null;
  terms_text: string;
  pre_carriage_text: string;
  flight_mode_text: string;
  port_of_loading_text: string;
  preferential_agreement_text: string;
  buyer_order_no: string;
  buyer_order_date: string;
  gold_rate_usd_per_troy_oz: string;
  gold_purity: string;
  gold_purchase_party: string;
  gold_purchase_invoice_no: string;
  gold_purchase_date: string;
  gold_opening_stock_gm: string;
  inr_usd_rate: string;
  labour_inr_usd_rate: string;
  base_gold_rate_usd_per_gm: string;
  package_gross_wt_kg: string;
  container_number: string;
  wastage_pct_override: string;
  discount_usd: string;
  freight_usd: string;
  insurance_usd: string;
  commission_usd: string;
  /** Print gross weight at 2 dp like EXP535 / EXP615 (EXP570 kept 3 dp). */
  round_gross_2dp: boolean;
  /** Round the derived base lock (AR) to 2 dp like EXP570/615 (EXP535 did not). */
  round_base_lock_2dp: boolean;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const initialForm = (): FormState => ({
  invoice_number: "", invoice_date: today(),
  buyer_id: null, bank_id: null, terms_id: null, pre_carriage_id: null,
  flight_mode_id: null, port_of_loading_id: null, preferential_agreement_id: null,
  terms_text: "", pre_carriage_text: "", flight_mode_text: "", port_of_loading_text: "", preferential_agreement_text: "",
  buyer_order_no: "", buyer_order_date: "",
  gold_rate_usd_per_troy_oz: "", gold_purity: "0.999",
  gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "",
  gold_purchase_date: today(), gold_opening_stock_gm: "",
  inr_usd_rate: "", labour_inr_usd_rate: "", base_gold_rate_usd_per_gm: "",
  package_gross_wt_kg: "", container_number: "1",
  wastage_pct_override: "", discount_usd: "0", freight_usd: "0", insurance_usd: "0", commission_usd: "0",
  round_gross_2dp: true,
  round_base_lock_2dp: true,
});

export type FormErrors = Partial<Record<keyof FormState, string>>;

export const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
export const dec = (s: string, fallback = 0) => (isNum(s) ? new Decimal(s.trim()) : new Decimal(fallback));

export function validateForm(f: FormState): FormErrors {
  const e: FormErrors = {};
  if (!f.invoice_number.trim()) e.invoice_number = "Required";
  else if (!/^EXP\d+\/\d{4}-\d{2}$/i.test(f.invoice_number.trim())) e.invoice_number = "Use the format EXP570/2026-27";
  if (!f.invoice_date) e.invoice_date = "Required";
  if (!f.buyer_id) e.buyer_id = "Pick a buyer";
  if (!f.bank_id) e.bank_id = "Pick a bank";
  if (!isNum(f.gold_rate_usd_per_troy_oz)) e.gold_rate_usd_per_troy_oz = "Required";
  else if (Number(f.gold_rate_usd_per_troy_oz) < 500) e.gold_rate_usd_per_troy_oz = "Enter USD per troy ounce (e.g. 4339.8413), not per gram";
  if (!isNum(f.inr_usd_rate)) e.inr_usd_rate = "Required";
  else if (Number(f.inr_usd_rate) <= 0) e.inr_usd_rate = "Must be more than 0";
  if (f.labour_inr_usd_rate.trim() && !(Number(f.labour_inr_usd_rate) > 0)) e.labour_inr_usd_rate = "Must be more than 0";
  if (f.base_gold_rate_usd_per_gm.trim() && !(Number(f.base_gold_rate_usd_per_gm) > 0)) e.base_gold_rate_usd_per_gm = "Must be more than 0";
  if (!f.gold_purchase_invoice_no.trim()) e.gold_purchase_invoice_no = "Required";
  if (!isNum(f.package_gross_wt_kg)) e.package_gross_wt_kg = "Required";
  const purity = Number(f.gold_purity);
  if (!purity || purity <= 0 || purity > 1) e.gold_purity = "Between 0 and 1, e.g. 0.999";
  if (f.wastage_pct_override.trim()) {
    const w = Number(f.wastage_pct_override);
    if (!(w > 0 && w < 0.2)) e.wastage_pct_override = "A decimal, e.g. 0.04 for 4 %";
  }
  for (const k of ["discount_usd", "freight_usd", "insurance_usd", "commission_usd", "gold_opening_stock_gm"] as const) {
    if (f[k].trim() && !(Number(f[k]) >= 0)) e[k] = "Can't be negative";
  }
  return e;
}

/** Fields that live in the collapsed "Advanced" card on the Details step. */
export const ADVANCED_FIELDS: (keyof FormState)[] = ["base_gold_rate_usd_per_gm", "wastage_pct_override"];

/** Market tag used in the manual file names: "(S-JEW)", "(B-JEW)", "(UK-JEW)". */
export function marketSuffix(city: string, country: string): string | null {
  const c = `${city} ${country}`.toUpperCase();
  if (c.includes("SYDNEY")) return "S-JEW";
  if (c.includes("BRISBANE")) return "B-JEW";
  if (c.includes("UNITED KINGDOM") || c.includes("LONDON")) return "UK-JEW";
  return null;
}

/** Studding rows that still need a USD/ct rate (V13 warns on these). */
export function missingRates(p: Piece): number {
  return p.diamonds.filter((d) => d.pcs > 0 && !d.rate_usd_per_ct).length;
}

/** "18" → "18K", "18-PD" → "18K PD". */
export const ktLabel = (kt: string) => kt.replace("-PD", "K PD").replace(/^(\d+)$/, "$1K");

const TYPE_LABEL: Record<string, string> = {
  gold_plain: "Plain gold",
  gold_mounting: "Mounting",
  gold_studded_diamond: "Natural diamond",
  gold_studded_lgd: "Lab-grown",
  gold_studded_colorstone: "Colour stone",
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t;
