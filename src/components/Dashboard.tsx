/** Dashboard tab — list of past invoices with filters and actions. */
import { useEffect, useMemo, useState } from "react";
import { supabase, BUCKET_GENERATED } from "../supabase";
import { useToast } from "./Toast";
import { Empty, SkelRows } from "./Skeleton";

interface InvoiceRow {
  id: string;
  exp_number: string;
  invoice_date: string;
  status: "draft" | "generated" | "shipped" | "void";
  totals_usd: number | null;
  totals_inr: number | null;
  buyer: { name: string; country: string } | null;
  generated_xlsx_path: string | null;
}

export function Dashboard() {
  const toast = useToast();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [filter, setFilter] = useState({ q: "", status: "", country: "" });

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, exp_number, invoice_date, status, totals_usd, totals_inr, generated_xlsx_path, buyer:buyers(name,country)")
        .order("invoice_date", { ascending: false })
        .limit(200);
      if (!active) return;
      if (error) { toast.error("Could not load invoices", error.message); setRows([]); return; }
      setRows((data as unknown as InvoiceRow[]) ?? []);
    })();
    return () => { active = false; };
  }, [toast]);

  const filtered = useMemo(() => {
    if (!rows) return rows;
    const q = filter.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.exp_number.toLowerCase().includes(q) && !(r.buyer?.name.toLowerCase().includes(q) ?? false)) return false;
      if (filter.status && r.status !== filter.status) return false;
      if (filter.country && r.buyer?.country !== filter.country) return false;
      return true;
    });
  }, [rows, filter]);

  async function download(row: InvoiceRow) {
    if (!row.generated_xlsx_path) return;
    try {
      const { data, error } = await supabase.storage.from(BUCKET_GENERATED).createSignedUrl(row.generated_xlsx_path, 60 * 60);
      if (error) throw error;
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error("Download failed", (e as Error).message);
    }
  }

  async function voidInvoice(row: InvoiceRow) {
    if (!confirm(`Void invoice ${row.exp_number}? This can't be undone.`)) return;
    const { error } = await supabase.from("invoices").update({ status: "void" }).eq("id", row.id);
    if (error) { toast.error("Void failed", error.message); return; }
    toast.success("Marked void", row.exp_number);
    setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, status: "void" } : r)) ?? null);
  }

  const countries = useMemo(() => rows ? [...new Set(rows.map(r => r.buyer?.country).filter(Boolean) as string[])] : [], [rows]);

  if (rows === null) {
    return (
      <div>
        <h2>Past invoices</h2>
        <div className="table-wrap"><SkelRows count={6} /></div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div>
        <h2>Past invoices</h2>
        <Empty icon="📑" title="No invoices yet" body="Generate your first one from the Upload tab. It'll show up here with download and void controls." />
      </div>
    );
  }

  return (
    <div>
      <h2>Past invoices</h2>
      <div className="grid" style={{ marginBottom: 12 }}>
        <label>Search EXP # or buyer
          <input value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder="EXP570 or World Shiner" />
        </label>
        <label>Status
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="generated">Generated</option>
            <option value="shipped">Shipped</option>
            <option value="void">Void</option>
          </select>
        </label>
        <label>Country
          <select value={filter.country} onChange={(e) => setFilter({ ...filter, country: e.target.value })}>
            <option value="">All</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <div className="table-wrap cards">
        <table>
          <thead>
            <tr><th>EXP #</th><th>Date</th><th>Buyer</th><th>Country</th><th>Status</th><th>USD</th><th>INR</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {filtered?.map((r) => (
              <tr key={r.id}>
                <td data-label="EXP #">{r.exp_number}</td>
                <td data-label="Date">{r.invoice_date}</td>
                <td data-label="Buyer">{r.buyer?.name ?? "—"}</td>
                <td data-label="Country">{r.buyer?.country ?? "—"}</td>
                <td data-label="Status">
                  <span className={`pill ${r.status === "void" ? "pill-error" : r.status === "shipped" ? "pill-ok" : ""}`}>
                    {r.status}
                  </span>
                </td>
                <td data-label="USD">{r.totals_usd ? `$${Number(r.totals_usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</td>
                <td data-label="INR">{r.totals_inr ? `₹${Number(r.totals_inr).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</td>
                <td data-label="Actions">
                  <button className="btn small" disabled={!r.generated_xlsx_path} onClick={() => download(r)}>Download</button>
                  {r.status !== "void" && (
                    <button className="btn small danger" style={{ marginLeft: 6 }} onClick={() => voidInvoice(r)}>Void</button>
                  )}
                </td>
              </tr>
            ))}
            {filtered?.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", padding: 20, color: "var(--fg-mute)" }}>No invoices match the filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
