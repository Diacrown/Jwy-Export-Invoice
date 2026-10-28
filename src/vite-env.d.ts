/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_BUCKET_RAW_SJ50: string;
  readonly VITE_BUCKET_VENDOR_SDJJB: string;
  readonly VITE_BUCKET_GENERATED: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
