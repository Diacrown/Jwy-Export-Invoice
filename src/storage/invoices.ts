/** Invoice persistence: save (or re-save) a generated invoice, persist the
 *  files, keep the gold-purchase ledger and stones register up to date. */
import type Decimal from "decimal.js";
import { supabase, BUCKET_GENERATED, BUCKET_RAW_SJ50, BUCKET_VENDOR } from "../supabase";
import type { GoldDrawdown, Lot, PerInvoiceInputs } from "../types";
import { explainDbError } from "./settings";

export interface SaveInvoiceArgs {
  inputs: PerInvoiceInputs;
  lots: Lot[];
  totals_usd: Decimal;
  totals_inr: Decimal;
  /** Packing-list files the pieces came from (SJ-50s, vendor packing lists). */
  rawFiles?: Array<{ file: File | Blob; name: string }>;
  vendorFile?: File | Blob | null;
  vendorFileName?: string;
  generatedBlob: Blob;
  generatedFileName: string;
  /** Pure gold incl. wastage drawn from the purchase by this invoice (g). */
  goldUsedGm?: Decimal | null;
}

export interface SavedInvoice {
  invoice_id: string;
  replaced: boolean;
  raw_sj50_path: string | null;
  vendor_sdjjb_path: string | null;
  generated_xlsx_path: string;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
const n2 = (d: Decimal) => Number(d.toFixed(2));

/** Find the gold purchase row for (party, invoice no); null if not registered. */
export async function findGoldPurchase(party: string, invoiceNo: string) {
  const { data, error } = await supabase
    .from("gold_purchases").select("id, opening_qty_gm")
    .eq("party_name", party.trim()).eq("invoice_no", invoiceNo.trim()).maybeSingle();
  if (error) throw error;
  return data as { id: string; opening_qty_gm: number } | null;
}

/** Earlier invoices that drew on this purchase (excluding `excludeExp`). */
export async function listDrawdowns(purchaseId: string, excludeExp?: string): Promise<GoldDrawdown[]> {
  const { data, error } = await supabase
    .from("gold_drawdowns").select("exp_number, exp_date, quantity_gm")
    .eq("purchase_id", purchaseId).order("exp_date").order("created_at");
  if (error) throw error;
  return (data ?? [])
    .filter((d) => d.exp_number !== excludeExp)
    .map((d) => ({ exp_number: d.exp_number, exp_date: d.exp_date, quantity_gm: Number(d.quantity_gm) }));
}

/** Gold ledger context for the Review tab + workbook PURCHASE DETAILS block. */
export async function loadGoldLedger(inputs: PerInvoiceInputs): Promise<{
  opening_gm: number | null; drawdowns: GoldDrawdown[]; registered: boolean;
}> {
  const p = await findGoldPurchase(inputs.gold_purchase_party, inputs.gold_purchase_invoice_no);
  if (!p) return { opening_gm: inputs.gold_opening_stock_gm?.toNumber() ?? null, drawdowns: [], registered: false };
  return { opening_gm: Number(p.opening_qty_gm), drawdowns: await listDrawdowns(p.id, inputs.invoice_number), registered: true };
}

/** Create the invoice (or replace an earlier save of the same EXP number),
 *  upload files, write lots → pieces → diamonds, ledger, register, audit. */
export async function saveInvoice(args: SaveInvoiceArgs): Promise<SavedInvoice> {
  const { inputs, lots, totals_usd, totals_inr } = args;
  const fy = inputs.invoice_number.split("/")[1] ?? "";

  const header = {
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
    pre_carriage_text: inputs.pre_carriage_text ?? null,
    flight_mode_text: inputs.flight_mode_text ?? null,
    port_of_loading_text: inputs.port_of_loading_text ?? null,
    terms_text: inputs.terms_text ?? null,
    preferential_agreement_text: inputs.preferential_agreement_text ?? null,
    gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz.toNumber(),
    gold_purity: inputs.gold_purity.toNumber(),
    gold_purchase_party: inputs.gold_purchase_party,
    gold_purchase_invoice_no: inputs.gold_purchase_invoice_no,
    gold_purchase_date: inputs.gold_purchase_date,
    inr_usd_rate: inputs.inr_usd_rate.toNumber(),
    labour_inr_usd_rate: inputs.labour_inr_usd_rate.toNumber(),
    base_gold_rate_usd_per_gm: inputs.base_gold_rate_usd_per_gm.toNumber(),
    package_gross_wt_kg: inputs.package_gross_wt_kg.toNumber(),
    container_number: inputs.container_number,
    freight_usd: inputs.freight_usd.toNumber(),
    insurance_usd: inputs.insurance_usd.toNumber(),
    discount_usd: inputs.discount_usd.toNumber(),
    commission_usd: inputs.commission_usd.toNumber(),
    totals_usd: n2(totals_usd),
    totals_inr: n2(totals_inr),
    updated_at: new Date().toISOString(),
  };

  // 1. Insert, or replace an earlier save of the same EXP number (exp_number
  //    is unique — re-generating after a fix used to fail with a duplicate key).
  const { data: existing, error: exErr } = await supabase
    .from("invoices").select("id, status").eq("exp_number", inputs.invoice_number).maybeSingle();
  if (exErr) throw explainDbError(exErr);
  let invoice_id: string;
  const replaced = !!existing;
  if (existing) {
    if (existing.status === "shipped") {
      throw new Error(`${inputs.invoice_number} is already marked shipped; void it on the Dashboard before re-generating.`);
    }
    invoice_id = existing.id as string;
    const { error } = await supabase.from("invoices").update(header).eq("id", invoice_id);
    if (error) throw explainDbError(error);
    // children cascade from invoice_lots / invoice_pieces
    const delLots = await supabase.from("invoice_lots").delete().eq("invoice_id", invoice_id);
    if (delLots.error) throw explainDbError(delLots.error);
    const delPcs = await supabase.from("invoice_pieces").delete().eq("invoice_id", invoice_id);
    if (delPcs.error) throw explainDbError(delPcs.error);
    const delDraw = await supabase.from("gold_drawdowns").delete().eq("invoice_id", invoice_id);
    if (delDraw.error) throw explainDbError(delDraw.error);
  } else {
    const { data, error } = await supabase.from("invoices").insert(header).select("id").single();
    if (error) throw explainDbError(error);
    invoice_id = data.id as string;
  }

  // 2. Files
  const rawFiles = args.rawFiles ?? [];
  const rawPaths: string[] = [];
  for (const f of rawFiles) {
    const p = `${invoice_id}/${safeName(f.name)}`;
    const { error } = await supabase.storage.from(BUCKET_RAW_SJ50).upload(p, f.file, { upsert: true });
    if (error) throw error;
    rawPaths.push(p);
  }
  const vendorPath = args.vendorFile ? `${invoice_id}/${safeName(args.vendorFileName ?? "sdjjb.xls")}` : null;
  if (args.vendorFile && vendorPath) {
    const { error } = await supabase.storage.from(BUCKET_VENDOR).upload(vendorPath, args.vendorFile, { upsert: true });
    if (error) throw error;
  }
  const genPath = `${invoice_id}/${safeName(args.generatedFileName)}`;
  {
    const { error } = await supabase.storage.from(BUCKET_GENERATED)
      .upload(genPath, args.generatedBlob, { upsert: true, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (error) throw error;
  }
  const rawPath = rawPaths[0] ?? null;
  {
    const { error } = await supabase.from("invoices").update({
      raw_sj50_path: rawPath, vendor_sdjjb_path: vendorPath, generated_xlsx_path: genPath,
    }).eq("id", invoice_id);
    if (error) throw explainDbError(error);
  }

  // 3. Lots + pieces + diamonds
  for (const lot of lots) {
    if (!lot.totals) continue;
    const t = lot.totals;
    const { data: lotRow, error: lotErr } = await supabase.from("invoice_lots").insert({
      invoice_id,
      lot_no: lot.lot_no,
      kt: lot.kt, color: lot.color,
      jewellery_type: lot.jewellery_type,
      hsn_code: lot.hsn_code, description: lot.description,
      wastage_pct: lot.wastage_pct.toNumber(),
      gross_wt: t.gross_wt.toNumber(),
      net_wt: t.net_wt.toNumber(),
      wastage_wt: t.wastage_wt.toNumber(),
      gold_value_usd: n2(t.gold_value_usd),
      diamond_value_usd: n2(t.diamond_value_usd),
      stone_value_usd: n2(t.stone_value_usd),
      mfg_cost_usd: n2(t.mfg_cost_usd),
      total_usd: n2(t.total_usd),
      value_addition_ratio: Number(t.value_addition_ratio.toFixed(6)),
    }).select("id").single();
    if (lotErr) throw explainDbError(lotErr);

    for (let i = 0; i < lot.pieces.length; i++) {
      const p = lot.pieces[i];
      const calc = lot.piece_calcs?.[i];
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
        semi_mount: p.semi_mount,
        region: p.region ?? null,
        product_category: p.product_category?.trim() || null,
        labour_rate_inr_per_gm: calc ? calc.labour_rate_inr.toNumber() : p.labour_rate_inr_per_gm?.toNumber() ?? null,
      }).select("id").single();
      if (pcErr) throw explainDbError(pcErr);

      if (p.diamonds.length) {
        const { error } = await supabase.from("invoice_diamonds").insert(p.diamonds.map((d) => ({
          piece_id: pcRow.id, shape: d.shape, pcs: d.pcs, cts: d.cts.toNumber(),
          certificate_no: d.certificate_no || null, origin: d.origin || null,
          color_clarity: d.color_clarity || null,
          rate_usd_per_ct: d.rate_usd_per_ct?.toNumber() ?? null,
        })));
        if (error) throw explainDbError(error);
      }
      if (p.stones.length) {
        const { error } = await supabase.from("invoice_stones").insert(p.stones.map((s) => ({
          piece_id: pcRow.id, stone_type: s.stone_type, shape: s.shape,
          pcs: s.pcs, cts: s.cts.toNumber(),
          rate_usd_per_ct: s.rate_usd_per_ct?.toNumber() ?? null,
        })));
        if (error) throw explainDbError(error);
      }
      // Store the base lock actually used (derived or typed) so a re-open shows the same MFG.
      const { error: tunErr } = await supabase.from("invoice_piece_tuning").insert({
        piece_id: pcRow.id,
        base_gold_lock_usd: calc ? Number(calc.base_lock.toFixed(6)) : p.base_gold_lock_usd?.toNumber() ?? null,
        fixed_addon_usd: calc ? calc.addon.toNumber() : p.fixed_addon_usd?.toNumber() ?? null,
      });
      if (tunErr) throw explainDbError(tunErr);
    }
  }

  // 4. Stones register: every certificate seen, latest values win
  const now = new Date().toISOString();
  const certs = new Map<string, Record<string, unknown>>();
  for (const lot of lots) for (const p of lot.pieces) for (const d of p.diamonds) {
    const cert = d.certificate_no?.trim();
    if (!cert) continue;
    certs.set(cert, {
      certificate_no: cert, lab_origin: d.origin || null, color_clarity: d.color_clarity || null,
      shape: d.shape, cts: d.cts.toNumber(), last_rate_usd_per_ct: d.rate_usd_per_ct?.toNumber() ?? null,
      last_used_at: now,
    });
  }
  if (certs.size) {
    const { data: known } = await supabase.from("stones_register")
      .select("certificate_no, times_seen").in("certificate_no", [...certs.keys()]);
    const seen = new Map((known ?? []).map((k) => [k.certificate_no as string, Number(k.times_seen)]));
    const rows = [...certs.values()].map((r) => ({
      ...r, times_seen: replaced ? (seen.get(r.certificate_no as string) ?? 1) : (seen.get(r.certificate_no as string) ?? 0) + 1,
    }));
    const { error } = await supabase.from("stones_register").upsert(rows, { onConflict: "certificate_no" });
    if (error) throw explainDbError(error);
  }

  // 5. Gold ledger: register the purchase on first use, then draw down
  if (args.goldUsedGm && inputs.gold_purchase_invoice_no.trim()) {
    let purchase = await findGoldPurchase(inputs.gold_purchase_party, inputs.gold_purchase_invoice_no);
    if (!purchase && inputs.gold_opening_stock_gm && inputs.gold_opening_stock_gm.gt(0)) {
      const { data, error } = await supabase.from("gold_purchases").insert({
        party_name: inputs.gold_purchase_party.trim(),
        invoice_no: inputs.gold_purchase_invoice_no.trim(),
        invoice_date: inputs.gold_purchase_date,
        rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz.toNumber(),
        purity: inputs.gold_purity.toNumber(),
        opening_qty_gm: inputs.gold_opening_stock_gm.toNumber(),
      }).select("id, opening_qty_gm").single();
      if (error) throw explainDbError(error);
      purchase = data as { id: string; opening_qty_gm: number };
    }
    if (purchase) {
      const { error } = await supabase.from("gold_drawdowns").insert({
        purchase_id: purchase.id, invoice_id, exp_number: inputs.invoice_number,
        exp_date: inputs.invoice_date, quantity_gm: Number(args.goldUsedGm.toFixed(3)),
      });
      if (error) throw explainDbError(error);
    }
  }

  // 6. Audit
  await supabase.from("audit_log").insert({
    action: replaced ? "regenerate" : "generate", invoice_id, exp_number: inputs.invoice_number,
    details: { totals_usd: n2(totals_usd), totals_inr: n2(totals_inr), raw_files: rawPaths },
  });

  return { invoice_id, replaced, raw_sj50_path: rawPath, vendor_sdjjb_path: vendorPath, generated_xlsx_path: genPath };
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
