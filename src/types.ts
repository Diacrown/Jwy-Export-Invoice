/** Domain types — mirror the Python module, in TypeScript.
 *
 * We use `decimal.js` for anything that must stay exact (money, weights).
 * Pydantic models from the Python side map to the interfaces here one-for-one.
 */
import type Decimal from "decimal.js";

export type JewelleryType =
  | "gold_plain"
  | "gold_mounting"
  | "gold_studded_diamond"
  | "gold_studded_lgd"
  | "gold_studded_colorstone";

export type InvoiceStatus = "draft" | "generated" | "shipped" | "void";

export type DiamondOrigin = "MINED" | "LGD001-CVD" | "LGD002-HPHT";

/** One diamond stud on one piece. A piece can carry many. */
export interface DiamondDetail {
  shape: string;
  pcs: number;
  cts: Decimal;
  certificate_no?: string | null;
  origin?: DiamondOrigin | null;
  color_clarity?: string | null;
  rate_usd_per_ct?: Decimal | null;
}

export interface StoneDetail {
  stone_type: string;
  shape?: string | null;
  pcs: number;
  cts: Decimal;
  rate_usd_per_ct?: Decimal | null;
}

/** Row from SJ-50 → one piece on the invoice. */
export interface Piece {
  stock_no: string;
  cust_po?: string | null;
  cust_style_no: string;
  internal_style_no?: string | null;
  bag_no?: string | null;
  kt_raw: string;
  color_raw: string;
  size?: string | null;
  qty: number;
  gross_wt: Decimal;
  net_wt_raw?: Decimal | null;
  diamond_quality_code?: string | null;
  remarks?: string | null;
  item_category_raw: string;

  // Normalized
  item: string;
  kt: string;              // '9' | '14' | '18' | '18-PD'
  color: string;
  jewellery_type: JewelleryType;

  diamonds: DiamondDetail[];
  stones: StoneDetail[];

  // Per-piece tuning (gap §3.E)
  base_gold_lock_usd?: Decimal | null;
  fixed_addon_usd?: Decimal | null;
}

export interface LotTotals {
  gross_wt: Decimal;
  net_wt: Decimal;
  wastage_wt: Decimal;
  gold_value_usd: Decimal;
  diamond_value_usd: Decimal;
  stone_value_usd: Decimal;
  mfg_cost_usd: Decimal;
  total_usd: Decimal;
  value_addition_ratio: Decimal;
}

export interface Lot {
  lot_no: number;
  kt: string;
  color: string;
  jewellery_type: JewelleryType;
  hsn_code: string;
  description: string;
  pieces: Piece[];
  wastage_pct: Decimal;
  totals?: LotTotals;
}

/** Everything the clerk fills on the per-invoice form. */
export interface PerInvoiceInputs {
  invoice_number: string;        // 'EXP570/2026-27'
  invoice_date: string;          // ISO yyyy-mm-dd
  buyer_id: string;              // uuid from buyers
  bank_id: string;               // uuid from banks
  pre_carriage_id?: string;
  flight_mode_id?: string;
  port_of_loading_id?: string;
  terms_id?: string;
  preferential_agreement_id?: string;

  // overrides (free-text that beats the lookup choice)
  terms_override?: string;
  preferential_agreement_override?: string;
  flight_mode_override?: string;

  // rates
  gold_rate_usd_per_troy_oz: Decimal;
  gold_purity: Decimal;
  gold_purchase_party: string;
  gold_purchase_invoice_no: string;
  gold_purchase_date: string;
  inr_usd_rate: Decimal;

  // packaging
  package_gross_wt_kg: Decimal;
  container_number: number;
  buyer_order_no?: string | null;
  buyer_order_date?: string | null;

  // optional overrides
  wastage_pct_override?: Decimal | null;
  discount_usd: Decimal;
  freight_usd: Decimal;
  insurance_usd: Decimal;
  commission_usd: Decimal;
}

export interface ValidationFinding {
  code: string;
  severity: "hard" | "soft";
  passed: boolean;
  message: string;
  detail?: unknown;
}

export interface ValidationReport {
  findings: ValidationFinding[];
}

/** Shape of a buyer / bank / etc. loaded from Supabase for dropdowns. */
export interface LookupRow {
  id: string;
  name: string;
}

export interface Buyer {
  id: string;
  display_index: number;
  name: string;
  address: string;
  city: string;
  country: string;
  default_terms: string;
  default_preferential_agreement: string | null;
}

export interface Bank {
  id: string;
  display_index: number;
  name: string;
  ad_code: string;
  account_no: string;
  swift: string;
  ifsc: string;
}

export interface HsnEntry {
  jewellery_type: JewelleryType;
  code: string;
  description_tail: string;
  max_wastage_handcrafted: number;
  min_value_addition: number;
}

export interface AppSettings {
  exporter_name: string;
  exporter_address: string;
  iec_no: string;
  pan: string;
  gstin: string;
  state_code: number;
  state_name: string;
  district_code: number;
  district_name: string;
  signatory_block_1: string;
  signatory_block_2: string;
  signatory_name: string;
  lut_arn_number: string;
  lut_arn_date: string;
  insurance_wording: string;
  container_prefix: string;
  tin_box_text: string;
  handcrafted_text: string;
  mfg_fixed_addon_usd: number;
  default_wastage_pct: number;
  payment_instructions: string[];
  declarations: string[];
}
