/** Invoice persistence: save a draft, persist generated artifacts, list past invoices. */
import type Decimal from "decimal.js";
import { supabase, BUCKET_GENERATED, BUCKET_RAW_SJ50, BUCKET_VENDOR } from "../supabase";
import type { Lot, PerInvoiceInputs } from "../types";

export interface SaveInvoiceArgs {
  inputs: PerInvoiceInputs;
  lots: Lot[];
  totals_usd: Decimal;
  totals_inr: Decimal;
  rawSj50File?: File | Blob | null;
  rawSj50FileName?: string;
  vendorFile?: File | Blob | null;
  vendorFileName?: string;
  generatedBlob: Blob;
  generatedFileName: string;
}

export interface SavedInvoice {
  invoice_id: string;
  raw_sj50_path: string | null;
  vendor_sdjjb_path: string | null;
  generated_xlsx_path: string;
}

/** Create an invoice row, persist files to Storage, write lots + pieces + diamonds. */
export async function saveInvoice(args: SaveInvoiceArgs): Promise<SavedInvoice> {
  const { inputs, lots, totals_usd, totals_inr } = args;
  const fy = inputs.invoice_number.split("/")[1] ?? "";

  // 1. Insert invoice header
  const { data: invRow, error: invErr } = await supabase
    .from("invoices")
    .insert({
      exp_number: inputs.invoice_number,
      fiscal_year: fy,
      invoice_date: inputs.invoice_date,
      status: "generated",
      buyer_id: inputs.buyer_id,
      bank_id: inputs.bank_id,
      pre_carriage_id: inputs.pre_carriage_id ?? null,
      flight_mode_id: inputs.flight_mode_id ?? null,
      port_of_loading_id: inputs.port_of_loading_id ?? null,
      terms_id: inputs.terms_id ?? null,
      preferential_agreement_id: inputs.preferential_agreement_id ?? null,
      terms_override: inputs.terms_override ?? null,
      preferential_agreement_override: inputs.preferential_agreement_override ?? null,
      flight_mode_override: inputs.flight_mode_override ?? null,
      gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz.toNumber(),
      gold_purity: inputs.gold_purity.toNumber(),
      gold_purchase_party: inputs.gold_purchase_party,
      gold_purchase_invoice_no: inputs.gold_purchase_invoice_no,
      gold_purchase_date: inputs.gold_purchase_date,
      inr_usd_rate: inputs.inr_usd_rate.toNumber(),
      package_gross_wt_kg: inputs.package_gross_wt_kg.toNumber(),
      container_number: inputs.container_number,
      totals_usd: totals_usd.toNumber(),
      totals_inr: totals_inr.toNumber(),
    })
    .select("id")
    .single();
  if (invErr) throw invErr;
  const invoice_id = invRow.id as string;

  // 2. Upload the three files to Storage
  const safeInv = inputs.invoice_number.replace(/[^A-Za-z0-9]/g, "-");
  const rawPath = args.rawSj50File
    ? `${invoice_id}/${args.rawSj50FileName ?? "sj50.xlsx"}`
    : null;
  const vendorPath = args.vendorFile
    ? `${invoice_id}/${args.vendorFileName ?? "sdjjb.xlsx"}`
    : null;
  const genPath = `${invoice_id}/${args.generatedFileName ?? `${safeInv}.xlsx`}`;

  if (args.rawSj50File && rawPath) {
    const { error } = await supabase.storage.from(BUCKET_RAW_SJ50)
      .upload(rawPath, args.rawSj50File, { upsert: true });
    if (error) throw error;
  }
  if (args.vendorFile && vendorPath) {
    const { error } = await supabase.storage.from(BUCKET_VENDOR)
      .upload(vendorPath, args.vendorFile, { upsert: true });
    if (error) throw error;
  }
  {
    const { error } = await supabase.storage.from(BUCKET_GENERATED)
      .upload(genPath, args.generatedBlob, { upsert: true, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (error) throw error;
  }

  // Update invoice with file paths
  await supabase.from("invoices").update({
    raw_sj50_path: rawPath, vendor_sdjjb_path: vendorPath, generated_xlsx_path: genPath,
  }).eq("id", invoice_id);

  // 3. Lots + pieces + diamonds
  for (const lot of lots) {
    if (!lot.totals) continue;
    const { data: lotRow, error: lotErr } = await supabase.from("invoice_lots").insert({
      invoice_id,
      lot_no: lot.lot_no,
      kt: lot.kt, color: lot.color,
      jewellery_type: lot.jewellery_type,
      hsn_code: lot.hsn_code, description: lot.description,
      wastage_pct: lot.wastage_pct.toNumber(),
      gross_wt: lot.totals.gross_wt.toNumber(),
      net_wt: lot.totals.net_wt.toNumber(),
      wastage_wt: lot.totals.wastage_wt.toNumber(),
      gold_value_usd: lot.totals.gold_value_usd.toNumber(),
      diamond_value_usd: lot.totals.diamond_value_usd.toNumber(),
      stone_value_usd: lot.totals.stone_value_usd.toNumber(),
      mfg_cost_usd: lot.totals.mfg_cost_usd.toNumber(),
      total_usd: lot.totals.total_usd.toNumber(),
      value_addition_ratio: lot.totals.value_addition_ratio.toNumber(),
    }).select("id").single();
    if (lotErr) throw lotErr;

    for (const p of lot.pieces) {
      const { data: pcRow, error: pcErr } = await supabase.from("invoice_pieces").insert({
        invoice_id, lot_id: lotRow.id,
        stock_no: p.stock_no, cust_po: p.cust_po, cust_style_no: p.cust_style_no,
        internal_style_no: p.internal_style_no, bag_no: p.bag_no,
        kt_raw: p.kt_raw, color_raw: p.color_raw, size: p.size,
        qty: p.qty, gross_wt: p.gross_wt.toNumber(),
        net_wt_raw: p.net_wt_raw?.toNumber() ?? null,
        diamond_quality_code: p.diamond_quality_code, remarks: p.remarks,
        item_category_raw: p.item_category_raw,
        item: p.item, kt: p.kt, color: p.color, jewellery_type: p.jewellery_type,
      }).select("id").single();
      if (pcErr) throw pcErr;

      for (const d of p.diamonds) {
        await supabase.from("invoice_diamonds").insert({
          piece_id: pcRow.id, shape: d.shape, pcs: d.pcs, cts: d.cts.toNumber(),
          certificate_no: d.certificate_no, origin: d.origin,
          color_clarity: d.color_clarity,
          rate_usd_per_ct: d.rate_usd_per_ct?.toNumber() ?? null,
        });
        if (d.certificate_no) {
          await supabase.from("stones_register").upsert({
            certificate_no: d.certificate_no,
            lab_origin: d.origin ?? null,
            color_clarity: d.color_clarity ?? null,
            shape: d.shape, cts: d.cts.toNumber(),
            last_rate_usd_per_ct: d.rate_usd_per_ct?.toNumber() ?? null,
            last_used_at: new Date().toISOString(),
          });
        }
      }
      for (const s of p.stones) {
        await supabase.from("invoice_stones").insert({
          piece_id: pcRow.id, stone_type: s.stone_type, shape: s.shape,
          pcs: s.pcs, cts: s.cts.toNumber(),
          rate_usd_per_ct: s.rate_usd_per_ct?.toNumber() ?? null,
        });
      }
      if (p.base_gold_lock_usd || p.fixed_addon_usd) {
        await supabase.from("invoice_piece_tuning").insert({
          piece_id: pcRow.id,
          base_gold_lock_usd: p.base_gold_lock_usd?.toNumber() ?? null,
          fixed_addon_usd: p.fixed_addon_usd?.toNumber() ?? null,
        });
      }
    }
  }

  // 4. Audit
  await supabase.from("audit_log").insert({
    action: "generate", invoice_id, exp_number: inputs.invoice_number,
    details: { totals_usd: totals_usd.toNumber(), totals_inr: totals_inr.toNumber() },
  });

  return { invoice_id, raw_sj50_path: rawPath, vendor_sdjjb_path: vendorPath, generated_xlsx_path: genPath };
}

export async function listRecentInvoices(limit = 50) {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, exp_number, invoice_date, status, totals_usd, totals_inr, buyer:buyers(name, country)")
    .order("invoice_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getGeneratedFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET_GENERATED).createSignedUrl(path, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}
