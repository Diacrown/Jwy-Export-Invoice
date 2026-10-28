/** Generic lookup-table helpers for the Dropdown component.
 *
 * Each lookup table has an `id` + a display column (`name` or `code`). The
 * component reads active rows and can insert a new row inline when the user
 * types a value that doesn't exist.
 */
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
    .map((r) => ({ id: String(r.id), label: String(r[spec.display]) }));
}

/** Insert a new row with just the display value; return its id + label. */
export async function insertLookup(key: LookupKey, label: string): Promise<LookupOption> {
  const spec = LOOKUP_TABLES[key];
  const payload: Record<string, unknown> = { [spec.display]: label, ...spec.extraInsertCols };
  const { data, error } = await supabase
    .from(spec.table).insert(payload).select("*").single();
  if (error) throw error;
  const row = data as Record<string, unknown>;
  return { id: String(row.id), label: String(row[spec.display]) };
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
