/** Top-level app shell: auth gate + tabbed workflow. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import Decimal from "decimal.js";

import { supabase } from "./supabase";
import type { AppSettings, HsnEntry, JewelleryType, Lot, Piece, ValidationReport } from "./types";
import { loadAppSettings, loadHsnTable, loadLaborRates } from "./storage/settings";
import { fetchBank, fetchBuyer } from "./storage/lookups";
import { parseSj50 } from "./parsers/sj50";
import { parseSdjjb, type SdjjbData } from "./parsers/sdjjb";
import { groupPiecesIntoLots } from "./lib/grouping";
import { computeLotTotals, grandTotalCf, grandTotalInr } from "./lib/calculations";
import { isBlocked, runAll } from "./lib/validators";
import { generateXlsx } from "./generators/xlsx";
import { saveInvoice } from "./storage/invoices";
import { Dropdown } from "./components/Dropdown";
import type { LookupOption } from "./storage/lookups";

type Tab = "upload" | "pieces" | "form" | "review" | "generate";

interface FormState {
  invoice_number: string;
  invoice_date: string;
  buyer_id: string | null;
  bank_id: string | null;
  terms_id: string | null;
  pre_carriage_id: string | null;
  flight_mode_id: string | null;
  port_of_loading_id: string | null;
  preferential_agreement_id: string | null;
  gold_rate_usd_per_troy_oz: string;
  gold_purity: string;
  gold_purchase_party: string;
  gold_purchase_invoice_no: string;
  gold_purchase_date: string;
  inr_usd_rate: string;
  package_gross_wt_kg: string;
  container_number: string;
  wastage_pct_override: string;
  discount_usd: string;
  freight_usd: string;
  insurance_usd: string;
}

const INITIAL_FORM: FormState = {
  invoice_number: "", invoice_date: new Date().toISOString().slice(0, 10),
  buyer_id: null, bank_id: null, terms_id: null, pre_carriage_id: null,
  flight_mode_id: null, port_of_loading_id: null, preferential_agreement_id: null,
  gold_rate_usd_per_troy_oz: "", gold_purity: "0.999",
  gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "",
  gold_purchase_date: new Date().toISOString().slice(0, 10),
  inr_usd_rate: "", package_gross_wt_kg: "", container_number: "1",
  wastage_pct_override: "", discount_usd: "0", freight_usd: "0", insurance_usd: "0",
};

export function App() {
  // Auth
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) setAuthError(error.message);
  }

  // Config (loaded once per session)
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hsnTable, setHsnTable] = useState<Record<JewelleryType, HsnEntry> | null>(null);
  const [laborRates, setLaborRates] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!user) return;
    Promise.all([loadAppSettings(), loadHsnTable(), loadLaborRates()])
      .then(([s, h, l]) => { setSettings(s); setHsnTable(h); setLaborRates(l); })
      .catch((e) => console.error("Config load failed:", e));
  }, [user]);

  // Flow state
  const [tab, setTab] = useState<Tab>("upload");
  const [sj50File, setSj50File] = useState<File | null>(null);
  const [sdjFile, setSdjFile] = useState<File | null>(null);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [, setSdjData] = useState<SdjjbData | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [lots, setLots] = useState<Lot[]>([]);
  const [totals, setTotals] = useState<{ usd: Decimal; inr: Decimal } | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [log, setLog] = useState<string>("");
  const [result, setResult] = useState<{ invoice_id: string; xlsx_path: string } | null>(null);

  function logLine(s: string) {
    setLog((l) => `${l}[${new Date().toLocaleTimeString()}] ${s}\n`);
  }

  async function onParse() {
    if (!sj50File) return;
    setStatus("parsing");
    try {
      const ps = await parseSj50(sj50File);
      setPieces(ps);
      logLine(`SJ-50: parsed ${ps.length} pieces`);
      if (sdjFile) {
        const sd = await parseSdjjb(sdjFile);
        setSdjData(sd);
        logLine(`SDJ-JB: labor rates = ${JSON.stringify(Object.fromEntries(
          Object.entries(sd.labor_rate_by_kt).map(([k, v]) => [k, v.toString()])))}`);
      }
      setStatus("parsed");
      setTab("pieces");
    } catch (e) {
      logLine(`error: ${(e as Error).message}`);
      setStatus("error");
    }
  }

  function updatePieceDiamond(stock: string, patch: { certificate_no?: string; color_clarity?: string; rate_usd_per_ct?: string }) {
    setPieces((prev) => prev.map((p) => {
      if (p.stock_no !== stock) return p;
      const d0 = p.diamonds[0] ?? { shape: "ROUND", pcs: 0, cts: new Decimal(0) };
      const next = {
        ...d0,
        certificate_no: patch.certificate_no ?? d0.certificate_no,
        color_clarity: patch.color_clarity ?? d0.color_clarity,
        rate_usd_per_ct: patch.rate_usd_per_ct !== undefined ? (patch.rate_usd_per_ct ? new Decimal(patch.rate_usd_per_ct) : null) : d0.rate_usd_per_ct,
      };
      return { ...p, diamonds: [next, ...p.diamonds.slice(1)] };
    }));
  }

  async function doPreview() {
    if (!settings || !hsnTable) return;
    if (!form.buyer_id || !form.bank_id) { alert("Pick buyer + bank first"); return; }
    setStatus("computing");
    try {
      const wastage = new Decimal(form.wastage_pct_override || settings.default_wastage_pct);
      const groupedLots = groupPiecesIntoLots(pieces, hsnTable, wastage);
      for (const lot of groupedLots) {
        const labor = laborRates[lot.kt] ?? 1275;
        computeLotTotals({
          lot, hsn: hsnTable[lot.jewellery_type],
          gold_rate_usd_per_troy_oz: new Decimal(form.gold_rate_usd_per_troy_oz),
          gold_purity_imported: new Decimal(form.gold_purity),
          inr_usd_rate: new Decimal(form.inr_usd_rate),
          wastage_pct: wastage,
          labor_rate_inr_per_gm: new Decimal(labor),
          fixed_addon_usd: new Decimal(settings.mfg_fixed_addon_usd),
        });
      }
      const usd = grandTotalCf({
        lots: groupedLots,
        discount: new Decimal(form.discount_usd || 0),
        freight: new Decimal(form.freight_usd || 0),
        insurance: new Decimal(form.insurance_usd || 0),
      });
      const inr = grandTotalInr(usd, new Decimal(form.inr_usd_rate));
      setLots(groupedLots);
      setTotals({ usd, inr });

      // Validation
      const rep = runAll({
        pieces, lots: groupedLots,
        inputs: inputsFromForm(form),
        hsnTable, defaultWastagePct: new Decimal(settings.default_wastage_pct),
      });
      setReport(rep);
      setStatus(isBlocked(rep) ? "blocked" : "ready");
      setTab("review");
    } catch (e) {
      logLine(`preview error: ${(e as Error).message}`);
      setStatus("error");
    }
  }

  async function doGenerate() {
    if (!settings || !hsnTable || !lots.length || !totals || !form.buyer_id || !form.bank_id) return;
    setStatus("generating");
    try {
      const buyer = await fetchBuyer(form.buyer_id);
      const bank = await fetchBank(form.bank_id);
      const blob = await generateXlsx({
        settings, buyer, bank,
        inputs: inputsFromForm(form),
        lots, totals_usd: totals.usd, totals_inr: totals.inr,
      });
      const safeInv = form.invoice_number.replace(/[^A-Za-z0-9]/g, "-");
      const genName = `${safeInv}-MASTER-DETAILS.xlsx`;

      const saved = await saveInvoice({
        inputs: inputsFromForm(form),
        lots, totals_usd: totals.usd, totals_inr: totals.inr,
        rawSj50File: sj50File, rawSj50FileName: sj50File?.name,
        vendorFile: sdjFile, vendorFileName: sdjFile?.name,
        generatedBlob: blob, generatedFileName: genName,
      });
      setResult({ invoice_id: saved.invoice_id, xlsx_path: saved.generated_xlsx_path });
      setStatus("done");

      // Also offer immediate download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = genName; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      logLine(`generate error: ${(e as Error).message}`);
      setStatus("error");
      alert(`Generation failed: ${(e as Error).message}`);
    }
  }

  if (authLoading) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!user) {
    return (
      <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "var(--font-ui)" }}>
        <h2>Sign in</h2>
        <form onSubmit={signIn} className="grid" style={{ gridTemplateColumns: "1fr", gap: 10 }}>
          <label>Email<input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required /></label>
          <label>Password<input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required /></label>
          <button className="btn primary" type="submit">Sign in</button>
          {authError && <div className="finding hard">{authError}</div>}
          <div className="hint">Create your account in Supabase → Authentication → Users, then set <code>app_metadata.role = "accounts"</code>.</div>
        </form>
      </div>
    );
  }

  return (
    <>
      <header className="titlebar">
        <div className="title">
          <span className="logo">JWY</span>
          <span>jwy-export-invoice <span className="muted">— {user.email}</span></span>
        </div>
        <div>
          <span className={clsx("pill", {
            "pill-ok": status === "done" || status === "ready" || status === "parsed",
            "pill-warn": status === "blocked",
            "pill-error": status === "error",
          })}>{status}</span>
          <button className="btn" style={{ marginLeft: 8 }} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(["upload", "pieces", "form", "review", "generate"] as Tab[]).map((t, i) => (
          <button
            key={t}
            className={clsx("tab", { active: tab === t })}
            onClick={() => setTab(t)}
            disabled={
              (t === "pieces" && pieces.length === 0) ||
              (t === "form" && pieces.length === 0) ||
              (t === "review" && lots.length === 0) ||
              (t === "generate" && (!report || isBlocked(report)))
            }
          >{i + 1} · {t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>

      <main className="pane">
        {tab === "upload" && (
          <UploadPane
            sj50File={sj50File} setSj50File={setSj50File}
            sdjFile={sdjFile} setSdjFile={setSdjFile}
            onParse={onParse} log={log}
          />
        )}
        {tab === "pieces" && (
          <PiecesPane pieces={pieces} updatePieceDiamond={updatePieceDiamond} onContinue={() => setTab("form")} />
        )}
        {tab === "form" && (
          <FormPane form={form} setForm={setForm} onPreview={doPreview} />
        )}
        {tab === "review" && (
          <ReviewPane lots={lots} totals={totals} report={report} onBack={() => setTab("form")} onContinue={() => setTab("generate")} />
        )}
        {tab === "generate" && (
          <GeneratePane status={status} result={result} onGenerate={doGenerate} />
        )}
      </main>
    </>
  );
}

// ───────────────────────── helpers + sub-panes ─────────────────────────

function inputsFromForm(f: FormState) {
  return {
    invoice_number: f.invoice_number,
    invoice_date: f.invoice_date,
    buyer_id: f.buyer_id!, bank_id: f.bank_id!,
    pre_carriage_id: f.pre_carriage_id ?? undefined,
    flight_mode_id: f.flight_mode_id ?? undefined,
    port_of_loading_id: f.port_of_loading_id ?? undefined,
    terms_id: f.terms_id ?? undefined,
    preferential_agreement_id: f.preferential_agreement_id ?? undefined,
    gold_rate_usd_per_troy_oz: new Decimal(f.gold_rate_usd_per_troy_oz),
    gold_purity: new Decimal(f.gold_purity),
    gold_purchase_party: f.gold_purchase_party,
    gold_purchase_invoice_no: f.gold_purchase_invoice_no,
    gold_purchase_date: f.gold_purchase_date,
    inr_usd_rate: new Decimal(f.inr_usd_rate),
    package_gross_wt_kg: new Decimal(f.package_gross_wt_kg || 0),
    container_number: parseInt(f.container_number, 10) || 1,
    wastage_pct_override: f.wastage_pct_override ? new Decimal(f.wastage_pct_override) : null,
    discount_usd: new Decimal(f.discount_usd || 0),
    freight_usd: new Decimal(f.freight_usd || 0),
    insurance_usd: new Decimal(f.insurance_usd || 0),
    commission_usd: new Decimal(0),
  };
}

function UploadPane(props: {
  sj50File: File | null; setSj50File: (f: File | null) => void;
  sdjFile: File | null; setSdjFile: (f: File | null) => void;
  onParse: () => void; log: string;
}) {
  const { sj50File, setSj50File, sdjFile, setSdjFile, onParse, log } = props;
  return (
    <div>
      <h2>Upload the SJ-50 raw file</h2>
      <p className="hint">Jewellery-dept packing list — <code>.xls</code> or <code>.xlsx</code>. Max ~10 MB.</p>
      <div className={clsx("dropzone", { "have-file": !!sj50File })}>
        <input id="sj50" type="file" accept=".xls,.xlsx"
               onChange={(e) => setSj50File(e.target.files?.[0] ?? null)} />
        <label htmlFor="sj50">{sj50File ? sj50File.name : "Pick file or drop here"}</label>
      </div>

      <h3 className="section">Optional: SDJ-JB vendor invoice</h3>
      <div className={clsx("dropzone", { "have-file": !!sdjFile })}>
        <input id="sdj" type="file" accept=".xls,.xlsx"
               onChange={(e) => setSdjFile(e.target.files?.[0] ?? null)} disabled={!sj50File} />
        <label htmlFor="sdj">{sdjFile ? sdjFile.name : "Pick vendor invoice"}</label>
      </div>

      <div className="actions">
        <button className="btn primary" disabled={!sj50File} onClick={onParse}>Parse →</button>
      </div>
      {log && <pre className="log">{log}</pre>}
    </div>
  );
}

function PiecesPane(props: { pieces: Piece[]; updatePieceDiamond: (stock: string, patch: Record<string, string>) => void; onContinue: () => void; }) {
  const { pieces, updatePieceDiamond, onContinue } = props;
  return (
    <div>
      <h2>Pieces (parsed from SJ-50)</h2>
      <p className="hint">Fill diamond cert / grade / rate per piece where the raw file didn&apos;t carry them.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stock</th><th>Style</th><th>Item</th><th>KT</th><th>Color</th><th>Qty</th>
              <th>Gross</th><th>Dia pcs</th><th>Dia cts</th>
              <th>Dia certificate</th><th>Dia grade</th><th>Dia USD/ct</th><th>HSN hint</th>
            </tr>
          </thead>
          <tbody>
            {pieces.map((p) => {
              const d0 = p.diamonds[0];
              const diaPcs = p.diamonds.reduce((a, d) => a + d.pcs, 0);
              const diaCts = p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
              return (
                <tr key={p.stock_no}>
                  <td>{p.stock_no}</td>
                  <td>{p.cust_style_no}</td>
                  <td>{p.item}</td>
                  <td>{p.kt}</td>
                  <td>{p.color}</td>
                  <td>{p.qty}</td>
                  <td>{p.gross_wt.toFixed(3)}</td>
                  <td>{diaPcs}</td>
                  <td>{diaCts.toFixed(2)}</td>
                  <td><input placeholder="IGI-LG…" defaultValue={d0?.certificate_no ?? ""}
                             onBlur={(e) => updatePieceDiamond(p.stock_no, { certificate_no: e.target.value })} /></td>
                  <td><input placeholder="D-VVS1" defaultValue={d0?.color_clarity ?? ""}
                             onBlur={(e) => updatePieceDiamond(p.stock_no, { color_clarity: e.target.value })} /></td>
                  <td><input placeholder="60.00" defaultValue={d0?.rate_usd_per_ct?.toString() ?? ""}
                             onBlur={(e) => updatePieceDiamond(p.stock_no, { rate_usd_per_ct: e.target.value })} /></td>
                  <td title="jewellery type">{p.jewellery_type.replace("gold_", "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={onContinue}>Continue →</button>
      </div>
    </div>
  );
}

function FormPane(props: { form: FormState; setForm: (f: FormState) => void; onPreview: () => void; }) {
  const { form, setForm, onPreview } = props;
  function u<K extends keyof FormState>(k: K, v: FormState[K]) { setForm({ ...form, [k]: v }); }
  function pick(k: keyof FormState) {
    return (o: LookupOption | null) => u(k, (o?.id ?? null) as FormState[typeof k]);
  }
  return (
    <div>
      <h2>Per-invoice inputs</h2>
      <div className="grid">
        <label>Invoice number
          <input value={form.invoice_number} onChange={(e) => u("invoice_number", e.target.value)} placeholder="EXP570/2026-27" />
        </label>
        <label>Invoice date
          <input type="date" value={form.invoice_date} onChange={(e) => u("invoice_date", e.target.value)} />
        </label>
        <label>Buyer
          <Dropdown lookupKey="buyers" value={form.buyer_id} onChange={pick("buyer_id")} />
        </label>
        <label>Bank
          <Dropdown lookupKey="banks" value={form.bank_id} onChange={pick("bank_id")} />
        </label>
        <label>Payment terms (override)
          <Dropdown lookupKey="payment_terms" value={form.terms_id} onChange={pick("terms_id")} />
        </label>
        <label>Pre-carriage
          <Dropdown lookupKey="freight_carriers" value={form.pre_carriage_id} onChange={pick("pre_carriage_id")} />
        </label>
        <label>Vessel / Flight
          <Dropdown lookupKey="freight_modes" value={form.flight_mode_id} onChange={pick("flight_mode_id")} />
        </label>
        <label>Port of Loading
          <Dropdown lookupKey="ports" value={form.port_of_loading_id} onChange={pick("port_of_loading_id")} />
        </label>
        <label>Preferential agreement (override)
          <Dropdown lookupKey="preferential_agreements" value={form.preferential_agreement_id} onChange={pick("preferential_agreement_id")} />
        </label>
        <label>Gold rate (USD / troy oz)
          <input value={form.gold_rate_usd_per_troy_oz} onChange={(e) => u("gold_rate_usd_per_troy_oz", e.target.value)} placeholder="4662.4965" />
        </label>
        <label>Gold purity
          <input value={form.gold_purity} onChange={(e) => u("gold_purity", e.target.value)} />
        </label>
        <label>Gold purchase party
          <input value={form.gold_purchase_party} onChange={(e) => u("gold_purchase_party", e.target.value)} />
        </label>
        <label>Gold purchase invoice #
          <input value={form.gold_purchase_invoice_no} onChange={(e) => u("gold_purchase_invoice_no", e.target.value)} />
        </label>
        <label>Gold purchase date
          <input type="date" value={form.gold_purchase_date} onChange={(e) => u("gold_purchase_date", e.target.value)} />
        </label>
        <label>INR → USD rate
          <input value={form.inr_usd_rate} onChange={(e) => u("inr_usd_rate", e.target.value)} placeholder="95.25" />
        </label>
        <label>Package gross wt (kg)
          <input value={form.package_gross_wt_kg} onChange={(e) => u("package_gross_wt_kg", e.target.value)} />
        </label>
        <label>Container no.
          <input value={form.container_number} onChange={(e) => u("container_number", e.target.value)} />
        </label>
        <label>Wastage % override
          <input value={form.wastage_pct_override} onChange={(e) => u("wastage_pct_override", e.target.value)} placeholder="(leave blank for default)" />
        </label>
        <label>Discount (USD)
          <input value={form.discount_usd} onChange={(e) => u("discount_usd", e.target.value)} />
        </label>
        <label>Freight (USD)
          <input value={form.freight_usd} onChange={(e) => u("freight_usd", e.target.value)} />
        </label>
        <label>Insurance (USD)
          <input value={form.insurance_usd} onChange={(e) => u("insurance_usd", e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={onPreview}>Preview totals →</button>
      </div>
    </div>
  );
}

function ReviewPane(props: {
  lots: Lot[]; totals: { usd: Decimal; inr: Decimal } | null;
  report: ValidationReport | null; onBack: () => void; onContinue: () => void;
}) {
  const { lots, totals, report, onBack, onContinue } = props;
  const blocked = report ? isBlocked(report) : true;
  return (
    <div>
      <h2>Review</h2>
      {totals && (
        <div className="summary">
          <div className="row"><span className="k">Pieces</span><span className="v">{lots.reduce((a, l) => a + l.pieces.reduce((aa, p) => aa + p.qty, 0), 0)}</span></div>
          <div className="row"><span className="k">Lots</span><span className="v">{lots.length}</span></div>
          <div className="row"><span className="k">Total USD</span><span className="v">${totals.usd.toFixed(2)}</span></div>
          <div className="row"><span className="k">Total INR</span><span className="v">₹{totals.inr.toFixed(2)}</span></div>
        </div>
      )}
      <h3 className="section">Lots</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>KT</th><th>Color</th><th>HSN</th><th>Pcs</th>
              <th>Gross</th><th>Net</th><th>Gold USD</th><th>Studd USD</th>
              <th>MFG USD</th><th>Total USD</th><th>V-add %</th></tr>
          </thead>
          <tbody>
            {lots.map((l) => {
              const t = l.totals!;
              const studd = t.diamond_value_usd.add(t.stone_value_usd);
              return (
                <tr key={l.lot_no}>
                  <td>{l.lot_no}</td><td>{l.kt}</td><td>{l.color}</td><td>{l.hsn_code}</td>
                  <td>{l.pieces.reduce((a, p) => a + p.qty, 0)}</td>
                  <td>{t.gross_wt.toFixed(3)}</td><td>{t.net_wt.toFixed(3)}</td>
                  <td>${t.gold_value_usd.toFixed(2)}</td>
                  <td>${studd.toFixed(2)}</td>
                  <td>${t.mfg_cost_usd.toFixed(2)}</td>
                  <td>${t.total_usd.toFixed(2)}</td>
                  <td>{t.value_addition_ratio.mul(100).toFixed(2)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 className="section">Validation</h3>
      {report?.findings.map((f) => (
        <div key={f.code} className={clsx("finding", f.passed ? "passed" : f.severity)}>
          <code>{f.code}</code> · {f.message}
          {f.detail ? <div className="muted">{JSON.stringify(f.detail)}</div> : null}
        </div>
      ))}
      <div className="actions">
        <button className="btn" onClick={onBack}>← Edit inputs</button>
        <button className="btn primary" onClick={onContinue} disabled={blocked}>Looks good →</button>
      </div>
    </div>
  );
}

function GeneratePane(props: {
  status: string;
  result: { invoice_id: string; xlsx_path: string } | null;
  onGenerate: () => void;
}) {
  const { status, result, onGenerate } = props;
  return (
    <div>
      <h2>Generate the invoice</h2>
      <p>Writing the master-details workbook will:</p>
      <ol>
        <li>Build the <code>.xlsx</code> in your browser via ExcelJS.</li>
        <li>Upload the raw SJ-50 (if provided), the vendor invoice (if provided), and the generated file into Supabase Storage, keyed by this new invoice&apos;s id.</li>
        <li>Insert rows into <code>invoices</code>, <code>invoice_lots</code>, <code>invoice_pieces</code>, <code>invoice_diamonds</code>, <code>stones_register</code>, and <code>audit_log</code>.</li>
        <li>Download the <code>.xlsx</code> to your Downloads folder.</li>
      </ol>
      <div className="actions">
        <button className="btn primary big" onClick={onGenerate} disabled={status === "generating" || status === "done"}>
          {status === "generating" ? "Generating…" : status === "done" ? "Done" : "Generate"}
        </button>
      </div>
      {result && (
        <div className="result-box">
          <strong>Generated.</strong> Invoice stored as <code>{result.invoice_id}</code> in Supabase. The <code>.xlsx</code> has already downloaded to your browser; a signed download link is available from the invoice list.
        </div>
      )}
    </div>
  );
}
