/** Supabase client singleton + typed table helpers.
 *
 * All env vars that reach the browser are PUBLIC. The anon key is designed to
 * be shipped; RLS policies in the DB are what keep writes safe. NEVER put the
 * service-role key here.
 */
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Soft-fail: let the UI render a configuration-missing banner.
  console.warn("Supabase env vars missing. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.");
}

export const supabase = createClient(url ?? "", anonKey ?? "", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const BUCKET_RAW_SJ50 = import.meta.env.VITE_BUCKET_RAW_SJ50 ?? "raw-sj50";
export const BUCKET_VENDOR = import.meta.env.VITE_BUCKET_VENDOR_SDJJB ?? "vendor-sdjjb";
export const BUCKET_GENERATED = import.meta.env.VITE_BUCKET_GENERATED ?? "generated-invoices";
