/** Invoices — past invoices with totals, filters, download and void. */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Ban, Download, FilePlus2, Hash, ReceiptText, Search, Wallet } from "lucide-react";
import { supabase, BUCKET_GENERATED } from "../supabase";
import { useToast } from "./Toast";
import { Empty, SkelRows } from "./Skeleton";
import { Badge, ConfirmDialog, Kpi, fmtDate, fmtInr, fmtUsd, plural } from "./ui";

interface InvoiceRow {
  id: string;
  exp_number: string;
  invoice_date: string;
  status: "draft" | "generated" | "shipped" | "void";
  totals_usd: number | null;
  totals_inr: number | null;
  buyer: { name: string; country: string; city?: string } | null;
  generated_xlsx_path: string | null;
}

const STATUS_TONE = { draft: undefined, generated: "navy", shipped: "ok", void: "bad" } as const;
type StatusFilter = "" | InvoiceRow["status"];

export function Dashboard(props: { onNew: () => void; hasDraft: boolean; canEdit: boolean }) {
  const { onNew, hasDraft, canEdit } = props;
  const toast = useToast();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [filter, setFilter] = useState<{ q: string; status: StatusFilter; country: string }>({ q: "", status: "", country: "" });
  const [voiding, setVoiding] = useState<InvoiceRow | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, exp_number, invoice_date, status, totals_usd, totals_inr, generated_xlsx_path, buyer:buyers(name,country,city)")
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

  const countries = useMemo(() => rows ? [...new Set(rows.map((r) => r.buyer?.country).filter(Boolean) as string[])].sort() : [], [rows]);
  const live = rows?.filter((r) => r.status !== "void") ?? [];
  const totalUsd = live.reduce((a, r) => a + Number(r.totals_usd ?? 0), 0);
  const totalInr = live.reduce((a, r) => a + Number(r.totals_inr ?? 0), 0);

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

  async function confirmVoid() {
    if (!voiding) return;
    setVoidBusy(true);
    const { error } = await supabase.from("invoices").update({ status: "void" }).eq("id", voiding.id);
    setVoidBusy(false);
    if (error) { toast.error("Void failed", error.message); return; }
    toast.success("Marked void", voiding.exp_number);
    const id = voiding.id;
    setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, status: "void" } : r)) ?? null);
    setVoiding(null);
  }

  const newLabel = hasDraft ? "Continue invoice" : "New invoice";
  const head = (
    <div className="page-head">
      <div>
        <h1 className="page-title">Invoices</h1>
        <p className="page-sub">Every export invoice generated here, newest first.</p>
      </div>
      <div className="page-actions">
        <button className="btn primary" onClick={onNew} disabled={!canEdit && !hasDraft}><FilePlus2 size={16} /> {newLabel}</button>
      </div>
    </div>
  );

  if (rows === null) {
    return <div>{head}<div className="card"><SkelRows count={6} /></div></div>;
  }
  if (rows.length === 0) {
    return (
      <div>
        {head}
        <Empty icon={ReceiptText} title="No invoices yet"
               body="Upload a packing list to make the first one. It shows up here with download and void controls."
               action={canEdit ? <button className="btn primary" onClick={onNew}><FilePlus2 size={16} /> {newLabel}</button> : undefined} />
      </div>
    );
  }

  const STATUSES: [StatusFilter, string][] = [["", "All"], ["generated", "Generated"], ["shipped", "Shipped"], ["void", "Void"]];
  return (
    <div>
      {head}
      <div className="kpis">
        <Kpi hero label="C&F value (excl. void)" value={fmtUsd(totalUsd)} sub={fmtInr(totalInr)} />
        <Kpi icon={ReceiptText} label="Invoices" value={live.length} sub={rows.length > live.length ? `${rows.length - live.length} void` : "none void"} />
        <Kpi icon={Hash} label="Latest" value={rows[0].exp_number.split("/")[0]} sub={fmtDate(rows[0].invoice_date)} />
        <Kpi icon={Wallet} label="Average invoice" value={live.length ? fmtUsd(totalUsd / live.length) : "—"} sub="C&F, USD" />
      </div>

      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder="Search EXP no. or buyer" aria-label="Search invoices" />
        </div>
        <div className="segmented" role="tablist" aria-label="Status">
          {STATUSES.map(([k, label]) => (
            <button key={k || "all"} role="tab" aria-selected={filter.status === k} className={clsx({ on: filter.status === k })}
                    onClick={() => setFilter({ ...filter, status: k })}>{label}</button>
          ))}
        </div>
        {countries.length > 1 && (
          <select value={filter.country} onChange={(e) => setFilter({ ...filter, country: e.target.value })} aria-label="Country" style={{ width: "auto", minWidth: 170 }}>
            <option value="">All countries</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      <div className="table-wrap cards">
        <table>
          <thead>
            <tr><th>Invoice</th><th>Date</th><th>Buyer</th><th>Status</th><th className="num">C&amp;F USD</th><th className="num">INR</th><th /></tr>
          </thead>
          <tbody>
            {filtered?.map((r) => (
              <tr key={r.id}>
                <td data-label="Invoice" className="strong">{r.exp_number}</td>
                <td data-label="Date">{fmtDate(r.invoice_date)}</td>
                <td data-label="Buyer" className="wrap">{r.buyer?.name ?? "—"}<span className="sub">{[r.buyer?.city, r.buyer?.country].filter(Boolean).join(", ")}</span></td>
                <td data-label="Status"><Badge tone={STATUS_TONE[r.status]} dot>{r.status[0].toUpperCase() + r.status.slice(1)}</Badge></td>
                <td data-label="C&F USD" className="num strong">{r.totals_usd != null ? fmtUsd(r.totals_usd) : "—"}</td>
                <td data-label="INR" className="num">{r.totals_inr != null ? fmtInr(r.totals_inr) : "—"}</td>
                <td data-label="">
                  <div className="row-actions">
                    <button className="btn small" disabled={!r.generated_xlsx_path} onClick={() => download(r)}
                            title={r.generated_xlsx_path ? "Download the workbook" : "No file stored for this invoice"}>
                      <Download size={14} /> Download
                    </button>
                    {r.status !== "void" && canEdit && (
                      <button className="btn small ghost icon" title="Void invoice" aria-label={`Void ${r.exp_number}`} onClick={() => setVoiding(r)}><Ban size={15} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered?.length === 0 && <tr className="empty-row"><td colSpan={7} data-label="">No invoices match the filter.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="hint-small" style={{ marginTop: 10 }}>{plural(filtered?.length ?? 0, "invoice")} shown</p>

      <ConfirmDialog open={!!voiding} danger icon={Ban} busy={voidBusy}
                     title={`Void ${voiding?.exp_number ?? ""}?`}
                     body="It stays in the list marked Void and no longer counts toward totals. This can't be undone here."
                     confirmLabel="Void invoice" onConfirm={confirmVoid} onCancel={() => setVoiding(null)} />
    </div>
  );
}
