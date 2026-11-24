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

/** Free text in the manual workbook's "DIA DETAILS" column (CUSTOMS PL!Y).
 *  Seen values: MINED, LGD001-CVD, LGD002-HPHT, SEMI-PRECIOUS STONE. */
export type DiamondOrigin = string;

/** One studding row on one piece (one shape). A piece can carry many.
 *  Coloured / semi-precious stones are also carried here — the manual
 *  workbook puts them in the same diamond columns (EXP570 lot 3). */
export interface DiamondDetail {
  shape: string;
  pcs: number;
  cts: Decimal;
  certificate_no?: string | null;
  origin?: DiamondOrigin | null;
  color_clarity?: string | null;
  rate_usd_per_ct?: Decimal | null;
}

/** Legacy stone columns (CUSTOMS PL!AE:AJ). Unused by the samples but kept
 *  so the formula chain stays identical to the manual workbook. */
export interface StoneDetail {
  stone_type: string;
  shape?: string | null;
  pcs: number;
  cts: Decimal;
  rate_usd_per_ct?: Decimal | null;
}

/** Row from SJ-50 (or a vendor packing list) → one piece on the invoice. */
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
  /** File + sheet the piece came from, for the Pieces grid. */
  source?: string | null;
  /** Packing-list "Region" / "Loc" (M / B / S). Display only: EXP615 (B-JEW)
   *  carries M, B and S pieces on one invoice. */
  region?: string | null;
  /** The packing list's second "Category" column — "Lab Studded", "Lab Semi",
   *  "Mount", "Mined Studded", "Semi-Mined", "Gemstone Semi"… When present it
   *  decides jewellery type and semi-mount (EXP615: remark "MINED SEMI" under
   *  category "Mined Studded" was NOT treated as semi-mount). */
  product_category?: string | null;
  /** Packing-list "Labour" column ("2000/gm") in ₹/g. Beats the Settings rate. */
  labour_rate_inr_per_gm?: Decimal | null;
  /** true when the file had no Stock No. column and one was made up. */
  synthetic_stock?: boolean;

  // Normalized
  item: string;
  kt: string;              // '9' | '14' | '18' | '18-PD'
  color: string;
  jewellery_type: JewelleryType;
  /** "SEMI" in remarks → printed as "… SEMI-MOUNTING JEWELLERY …", own lot. */
  semi_mount: boolean;

  diamonds: DiamondDetail[];
  stones: StoneDetail[];
  /** Studding totals as read from the packing list. The clerk may split a
   *  row by sieve size (EXP546), but the totals must still match (V4). */
  studding_raw_pcs?: number;
  studding_raw_cts?: Decimal;

  // Per-piece tuning (gap §3.E). null/undefined = derive.
  base_gold_lock_usd?: Decimal | null;
  fixed_addon_usd?: Decimal | null;

  /** What the Main File's "Main WS" row says about this piece. undefined = no
   *  main file loaded; `found: false` = loaded but no row for this piece. */
  main_ws?: MainWsMatch;
}

/** One row of the Main File's "Main WS" production tracker (only the columns
 *  the invoice can use). Hand-typed, so every field is raw text. */
export interface MainWsRow {
  /** 1-based row number in the sheet, for "see row 812". */
  row: number;
  customer: string;
  loc: string;
  ship_to: string;
  job_no: string;
  item_no: string;
  style_code: string;
  status: string;
  vendor: string;
  ship_date: string;
  /** "Center Diam Details" / "Side Diam Details": "1/2.50", "16/0.22". */
  centre: string;
  side: string;
  /** "LGD", "Mined", "Color+Mined", "LGD Semi", "Mount"… */
  mined_or_lab: string;
  /** "Shape Col/Clarity": "Oval D/VS1", "Long Radiant D/VS1", "D VS1". */
  shape_grade: string;
  /** Every "Cert No." cell, then every "Remarks" cell (certificates turn up in both). */
  cert_cells: string[];
  remark_cells: string[];
}

export interface MainWsMatch {
  found: boolean;
  /** How the row was found: the packing list's Cust PO = JobNo, or the style no. */
  by?: "job" | "style";
  row?: number;
  customer?: string;
  ship_to?: string;
  job_no?: string;
  item_no?: string;
  status?: string;
  mined_or_lab?: string;
  centre?: string;
  side?: string;
  shape?: string | null;
  /** Normalised to the manual workbook's "D-VS1". */
  grade?: string | null;
  /** Normalised to the manual workbook's "IGI-LG830606356". */
  certificates?: string[];
  /** Index of the studding row the centre stone was matched to. */
  centre_row?: number | null;
  filled_certificate?: boolean;
  filled_grade?: boolean;
  /** Plain-language reason something was not filled, or a disagreement worth a look. */
  notes?: string[];
}

/** Every intermediate the manual CUSTOMS PL row shows, column letters noted. */
export interface PieceCalc {
  net_wt: Decimal;            // K
  wastage_pct: Decimal;       // L
  wastage_wt: Decimal;        // M
  net_plus_wastage: Decimal;  // N
  gold_rate_per_gm: Decimal;  // O
  gold_value: Decimal;        // P
  diamond_value: Decimal;     // Σ AD
  stone_value: Decimal;       // Σ AJ
  base_lock: Decimal;         // AR
  base_lock_auto: boolean;    // true = derived from net × touch × rate
  base_lock_rounded: boolean; // derived value rounded to 2 dp (EXP570/615) vs full precision (EXP535)
  base_lock_net_wt: Decimal;  // round(SJ-50 net, 2) used in the derivation
  base_lock_touch: Decimal;
  residual: Decimal;          // AS = P − AR
  labour_rate_inr: Decimal;   // AT
  labour_fx: Decimal;         // AU
  labour_usd_per_gm: Decimal; // AV
  labour_cost: Decimal;       // AW
  addon: Decimal;             // AZ
  mfg_unrounded: Decimal;     // BA
  mfg: Decimal;               // AK = ROUND(BA, 2)
  total: Decimal;             // AL
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
  /** KT number only ('9' | '14' | '18') — 18K and 18K-PD share a lot. */
  kt: string;
  color: string;
  jewellery_type: JewelleryType;
  semi_mount: boolean;
  hsn_code: string;
  description: string;
  pieces: Piece[];
  wastage_pct: Decimal;
  totals?: LotTotals;
  /** Aligned with `pieces`. Filled by computeLotTotals. */
  piece_calcs?: PieceCalc[];
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

  // Resolved display text for the lookups above (what prints on the invoice)
  pre_carriage_text?: string;
  flight_mode_text?: string;
  port_of_loading_text?: string;
  terms_text?: string;
  preferential_agreement_text?: string;

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
  gold_opening_stock_gm?: Decimal | null;
  inr_usd_rate: Decimal;
  /** CUSTOMS PL!AU — the FX used to convert labour INR → USD. The manual
   *  workbooks often carry a different value from the invoice FX. */
  labour_inr_usd_rate: Decimal;
  /** Round the derived AR to 2 dp. EXP570/573/602/615 typed AR at 2 dp;
   *  EXP535/546/553 kept full precision. Changes MFG by at most a cent. */
  round_base_lock_2dp?: boolean;
  /** USD per gram of pure gold used for the AR base-gold lock. */
  base_gold_rate_usd_per_gm: Decimal;

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
  address?: string | null;
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
  /** AR base-gold lock rate (USD/g pure) = invoice gold rate (USD/oz) × this
   *  ratio, rounded to 3 dp. 0.0321199 reproduces EXP535 (139.395) and EXP615 (135.176). */
  base_gold_lock_ratio: number;
  /** AR base-gold lock: purity factor per KT number (manual: 9→.385, 14→.595, 18→.76). */
  kt_touch: Record<string, number>;
  payment_instructions: string[];
  declarations: string[];
}

/** One prior use of a gold purchase, for the PURCHASE DETAILS block. */
export interface GoldDrawdown {
  exp_number: string;
  exp_date: string;
  quantity_gm: number;
}
