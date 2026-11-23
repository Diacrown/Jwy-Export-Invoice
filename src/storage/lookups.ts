/** Generic lookup-table helpers for the Dropdown component.
 *
 * Each lookup table has an `id` + a display column (`name` or `code`). The
 * component reads active rows and can insert a new row inline when the user
 * types a value that doesn't exist.
 */
import Decimal from "decimal.js";
import { supabase } from "../supabase";
import type { Buyer, Bank } from "../types";

export interface LookupTable {
  table: string;
  display: string;         // column name shown to user
  extraInsertCols?: Record<string, unknown>;  // defaults for other columns on insert
}

export const LOOKUP_TABLES: Record<string, LookupTable> = {
  buyers: { table: "buyers", display: "name" },
  banks: { table: "banks", display: "name" },
  freight_carriers: { table: "freight_carriers", display: "name" },
  freight_modes: { table: "freight_modes", display: "name" },
  ports: { table: "ports", display: "name", extraInsertCols: { country: "INDIA" } },
  payment_terms: { table: "payment_terms", display: "name" },
  preferential_agreements: { table: "preferential_agreements", display: "code" },
};

export type LookupKey =
  | "buyers" | "banks" | "freight_carriers" | "freight_modes"
  | "ports" | "payment_terms" | "preferential_agreements";

export interface LookupOption {
  id: string;
  label: string;
}

/** Buyers share a name across branches (two "WORLD SHINER PTY LTD"), so their
 *  label carries the city. */
function labelFor(key: LookupKey, r: Record<string, unknown>): string {
  const spec = LOOKUP_TABLES[key];
  const base = String(r[spec.display] ?? "");
  if (key === "buyers" && r.city) return `${base} — ${String(r.city)}`;
  return base;
}

export async function fetchLookup(key: LookupKey): Promise<LookupOption[]> {
  const spec = LOOKUP_TABLES[key];
  const { data, error } = await supabase
    .from(spec.table)
    .select("*")
    .order(spec.display, { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => (r as { active?: boolean }).active !== false)
    .map((r) => ({ id: String(r.id), label: labelFor(key, r) }));
}

/** Insert a new row with just the display value; return its id + label. */
export async function insertLookup(key: LookupKey, label: string): Promise<LookupOption> {
  if (key === "buyers" || key === "banks") {
    throw new Error("Add buyers and banks with their full address / account details in the Supabase Table Editor.");
  }
  const spec = LOOKUP_TABLES[key];
  const payload: Record<string, unknown> = { [spec.display]: label, ...spec.extraInsertCols };
  const { data, error } = await supabase
    .from(spec.table).insert(payload).select("*").single();
  if (error) throw error;
  const row = data as Record<string, unknown>;
  return { id: String(row.id), label: labelFor(key, row) };
}

/** Full buyer / bank records (used after a dropdown selection to write into the invoice). */
export async function fetchBuyer(id: string): Promise<Buyer> {
  const { data, error } = await supabase.from("buyers").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Buyer;
}
export async function fetchBank(id: string): Promise<Bank> {
  const { data, error } = await supabase.from("banks").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Bank;
}

/** Every active buyer / bank — written into the workbook's staging area so the
 *  Q11 / Q24 index switch keeps working when Accounts edits the file by hand. */
export async function fetchAllBuyers(): Promise<Buyer[]> {
  const { data, error } = await supabase.from("buyers").select("*").eq("active", true).order("display_index");
  if (error) throw error;
  return (data ?? []) as Buyer[];
}
export async function fetchAllBanks(): Promise<Bank[]> {
  const { data, error } = await supabase.from("banks").select("*").eq("active", true).order("display_index");
  if (error) throw error;
  return (data ?? []) as Bank[];
}

export interface StoneRegisterHit {
  certificate_no: string;
  lab_origin: string | null;
  color_clarity: string | null;
  last_rate_usd_per_ct: Decimal | null;
}

/** Stones register lookup by certificate number (case-insensitive). */
export async function lookupStone(certificate: string): Promise<StoneRegisterHit | null> {
  const cert = certificate.trim();
  if (!cert) return null;
  const { data, error } = await supabase
    .from("stones_register")
    .select("certificate_no, lab_origin, color_clarity, last_rate_usd_per_ct")
    .ilike("certificate_no", cert)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    certificate_no: data.certificate_no,
    lab_origin: data.lab_origin,
    color_clarity: data.color_clarity,
    last_rate_usd_per_ct: data.last_rate_usd_per_ct != null ? new Decimal(String(data.last_rate_usd_per_ct)) : null,
  };
}
