/** Top-level app shell: auth gate + tabbed workflow + toasts + dashboard + settings. */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import Decimal from "decimal.js";

import { supabase } from "./supabase";
import type {
  AppSettings, DiamondDetail, GoldDrawdown, HsnEntry, JewelleryType, Lot, PerInvoiceInputs, Piece, ValidationReport,
} from "./types";
import { loadAppSettings, loadHsnTable, loadLaborRates } from "./storage/settings";
import { fetchAllBanks, fetchAllBuyers, fetchBank, fetchBuyer, lookupStone } from "./storage/lookups";
import { parsePackingLists } from "./parsers/sj50";
import { groupPiecesIntoLots } from "./lib/grouping";
import {
  baseGoldLockUsd, computeLotTotals, defaultBaseGoldRate, grandTotalCf, grandTotalInr, netWtGm, pureGoldUsedGm,
  touchFor, withGrossRounded, DEFAULT_BASE_GOLD_LOCK_RATIO,
} from "./lib/calculations";
import { isBlocked, runAll } from "./lib/validators";
import { generateXlsx } from "./generators/xlsx";
import { loadGoldLedger, saveInvoice } from "./storage/invoices";
import { Dropdown } from "./components/Dropdown";
import { Dashboard } from "./components/Dashboard";
import { Settings } from "./components/Settings";
import { Empty, SkelRows, Skel } from "./components/Skeleton";
import { ToastProvider, useErrorToast, useToast } from "./components/Toast";
import type { LookupOption } from "./storage/lookups";

type Tab = "dashboard" | "upload" | "pieces" | "form" | "review" | "generate" | "settings";

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
  terms_text: string;
  pre_carriage_text: string;
  flight_mode_text: string;
  port_of_loading_text: string;
  preferential_agreement_text: string;
  buyer_order_no: string;
  buyer_order_date: string;
  gold_rate_usd_per_troy_oz: string;
  gold_purity: string;
  gold_purchase_party: string;
  gold_purchase_invoice_no: string;
  gold_purchase_date: string;
  gold_opening_stock_gm: string;
  inr_usd_rate: string;
  labour_inr_usd_rate: string;
  base_gold_rate_usd_per_gm: string;
  package_gross_wt_kg: string;
  container_number: string;
  wastage_pct_override: string;
  discount_usd: string;
  freight_usd: string;
  insurance_usd: string;
  commission_usd: string;
  /** Print gross weight at 2 dp like EXP535 / EXP615 (EXP570 kept 3 dp). */
  round_gross_2dp: boolean;
  /** Round the derived base lock (AR) to 2 dp like EXP570/615 (EXP535 did not). */
  round_base_lock_2dp: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const INITIAL_FORM: FormState = {
  invoice_number: "", invoice_date: today(),
  buyer_id: null, bank_id: null, terms_id: null, pre_carriage_id: null,
  flight_mode_id: null, port_of_loading_id: null, preferential_agreement_id: null,
  terms_text: "", pre_carriage_text: "", flight_mode_text: "", port_of_loading_text: "", preferential_agreement_text: "",
  buyer_order_no: "", buyer_order_date: "",
  gold_rate_usd_per_troy_oz: "", gold_purity: "0.999",
  gold_purchase_party: "DIAMOND INDIA LIMITED", gold_purchase_invoice_no: "",
  gold_purchase_date: today(), gold_opening_stock_gm: "",
  inr_usd_rate: "", labour_inr_usd_rate: "", base_gold_rate_usd_per_gm: "",
  package_gross_wt_kg: "", container_number: "1",
  wastage_pct_override: "", discount_usd: "0", freight_usd: "0", insurance_usd: "0", commission_usd: "0",
  round_gross_2dp: true,
  round_base_lock_2dp: true,
};

type FormErrors = Partial<Record<keyof FormState, string>>;

const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
const dec = (s: string, fallback = 0) => (isNum(s) ? new Decimal(s.trim()) : new Decimal(fallback));

function validateForm(f: FormState): FormErrors {
  const e: FormErrors = {};
  if (!f.invoice_number.trim()) e.invoice_number = "Required";
  else if (!/^EXP\d+\/\d{4}-\d{2}$/i.test(f.invoice_number.trim())) e.invoice_number = "Format: EXP570/2026-27";
  if (!f.invoice_date) e.invoice_date = "Required";
  if (!f.buyer_id) e.buyer_id = "Pick a buyer";
  if (!f.bank_id) e.bank_id = "Pick a bank";
  if (!isNum(f.gold_rate_usd_per_troy_oz)) e.gold_rate_usd_per_troy_oz = "Required";
  else if (Number(f.gold_rate_usd_per_troy_oz) < 500) e.gold_rate_usd_per_troy_oz = "USD per troy oz (e.g. 4339.8413), not per gram";
  if (!isNum(f.inr_usd_rate)) e.inr_usd_rate = "Required";
  else if (Number(f.inr_usd_rate) <= 0) e.inr_usd_rate = "Must be positive";
  if (f.labour_inr_usd_rate.trim() && !(Number(f.labour_inr_usd_rate) > 0)) e.labour_inr_usd_rate = "Must be positive";
  if (f.base_gold_rate_usd_per_gm.trim() && !(Number(f.base_gold_rate_usd_per_gm) > 0)) e.base_gold_rate_usd_per_gm = "Must be positive";
  if (!f.gold_purchase_invoice_no.trim()) e.gold_purchase_invoice_no = "Required";
  if (!isNum(f.package_gross_wt_kg)) e.package_gross_wt_kg = "Required";
  const purity = Number(f.gold_purity);
  if (!purity || purity <= 0 || purity > 1) e.gold_purity = "0 < purity ≤ 1";
  if (f.wastage_pct_override.trim()) {
    const w = Number(f.wastage_pct_override);
    if (!(w > 0 && w < 0.2)) e.wastage_pct_override = "Decimal, e.g. 0.04 for 4 %";
  }
  for (const k of ["discount_usd", "freight_usd", "insurance_usd", "commission_usd", "gold_opening_stock_gm"] as const) {
    if (f[k].trim() && !(Number(f[k]) >= 0)) e[k] = "Must be ≥ 0";
  }
  return e;
}

/** Market tag used in the manual file names: "(S-JEW)", "(B-JEW)", "(UK-JEW)". */
function marketSuffix(city: string, country: string): string | null {
  const c = `${city} ${country}`.toUpperCase();
  if (c.includes("SYDNEY")) return "S-JEW";
  if (c.includes("BRISBANE")) return "B-JEW";
  if (c.includes("UNITED KINGDOM") || c.includes("LONDON")) return "UK-JEW";
  return null;
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

interface SessionUser { email?: string; app_metadata?: { role?: string } }

function AppInner() {
  const toast = useToast();
  const errToast = useErrorToast();

  // Auth
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const envMissing = !import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY
    || /your-project|your-anon/i.test(`${import.meta.env.VITE_SUPABASE_URL}${import.meta.env.VITE_SUPABASE_ANON_KEY}`);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser((data.session?.user as SessionUser | undefined) ?? null);
      setAuthLoading(false);
    }).catch(() => setAuthLoading(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser((session?.user as SessionUser | undefined) ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setSignInBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    setSignInBusy(false);
    if (error) toast.error("Sign-in failed", error.message);
  }
  const role = user?.app_metadata?.role ?? "viewer";
  const canEdit = role === "accounts" || role === "admin";

  // Config
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hsnTable, setHsnTable] = useState<Record<JewelleryType, HsnEntry> | null>(null);
  const [laborRates, setLaborRates] = useState<Record<string, number>>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [configVersion, setConfigVersion] = useState(0);

  useEffect(() => {
    if (!user) return;
    setConfigLoading(true);
    Promise.all([loadAppSettings(), loadHsnTable(), loadLaborRates()])
      .then(([s, h, l]) => { setSettings(s); setHsnTable(h); setLaborRates(l); })
      .catch((e) => errToast(e, "Config load failed"))
      .finally(() => setConfigLoading(false));
  }, [user, errToast, configVersion]);

  // Flow state
  const [tab, setTab] = useState<Tab>("dashboard");
  const [packFiles, setPackFiles] = useState<File[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [lots, setLots] = useState<Lot[]>([]);
  const [totals, setTotals] = useState<{ usd: Decimal; inr: Decimal } | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [ledger, setLedger] = useState<{ opening_gm: number | null; drawdowns: GoldDrawdown[]; registered: boolean; used: Decimal } | null>(null);
  const [parseBusy, setParseBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [result, setResult] = useState<{ invoice_id: string; replaced: boolean; fileName: string } | null>(null);
  const [pieceVersion, setPieceVersion] = useState(0);   // bump to re-seed uncontrolled inputs

  const included = useMemo(() => pieces.filter((p) => !excluded.has(p.stock_no)), [pieces, excluded]);
  // Labour comes from each piece's "Labour" column; Settings only fills gaps.
  const effectiveLabor = laborRates;
  // Base-lock rate: typed value, else gold rate × ratio (EXP535 139.395, EXP615 135.176).
  const lockRatio = settings?.base_gold_lock_ratio ?? DEFAULT_BASE_GOLD_LOCK_RATIO;
  const autoBaseRate = isNum(form.gold_rate_usd_per_troy_oz) ? defaultBaseGoldRate(new Decimal(form.gold_rate_usd_per_troy_oz), lockRatio) : null;
  const baseRate: Decimal | null = isNum(form.base_gold_rate_usd_per_gm) ? new Decimal(form.base_gold_rate_usd_per_gm) : autoBaseRate;

  // Any edit after a preview invalidates it
  const invalidate = useCallback(() => { setReport(null); setLots([]); setTotals(null); setResult(null); }, []);

  async function onParse() {
    if (!packFiles.length) return;
    setParseBusy(true);
    try {
      const { pieces: ps, duplicates } = await parsePackingLists(packFiles.map((f) => ({ file: f, name: f.name })));
      setPieces(ps); setExcluded(new Set()); invalidate();
      toast.success("Packing list parsed", `${ps.length} pieces from ${packFiles.length} file(s).`);
      if (duplicates.length) toast.info("Duplicates skipped", `${duplicates.length} stock no(s) appeared twice: ${duplicates.slice(0, 5).join(", ")}${duplicates.length > 5 ? "…" : ""}`);
      const noLabour = ps.filter((p) => !p.labour_rate_inr_per_gm).length;
      if (noLabour) toast.info("Labour from Settings", `${noLabour} piece(s) have no Labour column value — the Settings rate per KT is used.`);
      setTab("pieces");
    } catch (e) {
      errToast(e, "Parse failed");
    } finally {
      setParseBusy(false);
    }
  }

  // ── piece edits ──
  function patchPiece(stock: string, f: (p: Piece) => Piece) {
    setPieces((prev) => prev.map((p) => (p.stock_no === stock ? f(p) : p)));
    invalidate();
  }
  function updateDiamond(stock: string, idx: number, patch: Partial<Record<"shape" | "pcs" | "cts" | "certificate_no" | "origin" | "color_clarity" | "rate_usd_per_ct", string>>) {
    patchPiece(stock, (p) => {
      const ds = p.diamonds.map((d, i) => {
        if (i !== idx) return d;
        const n: DiamondDetail = { ...d };
        if (patch.shape !== undefined) n.shape = patch.shape.trim().toUpperCase() || d.shape;
        if (patch.pcs !== undefined) n.pcs = Math.max(0, Math.trunc(Number(patch.pcs) || 0));
        if (patch.cts !== undefined) n.cts = isNum(patch.cts) ? new Decimal(patch.cts) : new Decimal(0);
        if (patch.certificate_no !== undefined) n.certificate_no = patch.certificate_no.trim() || null;
        if (patch.origin !== undefined) n.origin = patch.origin.trim() || null;
        if (patch.color_clarity !== undefined) n.color_clarity = patch.color_clarity.trim() || null;
        if (patch.rate_usd_per_ct !== undefined) n.rate_usd_per_ct = isNum(patch.rate_usd_per_ct) ? new Decimal(patch.rate_usd_per_ct) : null;
        return n;
      });
      return { ...p, diamonds: ds };
    });
  }
  function splitDiamond(stock: string, idx: number) {
    patchPiece(stock, (p) => {
      const d = p.diamonds[idx];
      const copy: DiamondDetail = { shape: d.shape, pcs: 0, cts: new Decimal(0), origin: d.origin, color_clarity: d.color_clarity, rate_usd_per_ct: null, certificate_no: null };
      return { ...p, diamonds: [...p.diamonds.slice(0, idx + 1), copy, ...p.diamonds.slice(idx + 1)] };
    });
  }
  function removeDiamond(stock: string, idx: number) {
    patchPiece(stock, (p) => ({ ...p, diamonds: p.diamonds.filter((_, i) => i !== idx) }));
  }
  async function onCertBlur(stock: string, idx: number, cert: string) {
    updateDiamond(stock, idx, { certificate_no: cert });
    if (!cert.trim()) return;
    try {
      const hit = await lookupStone(cert);
      if (!hit) return;
      patchPiece(stock, (p) => ({
        ...p,
        diamonds: p.diamonds.map((d, i) => i !== idx ? d : {
          ...d,
          origin: d.origin || hit.lab_origin,
          color_clarity: d.color_clarity || hit.color_clarity,
          rate_usd_per_ct: d.rate_usd_per_ct ?? hit.last_rate_usd_per_ct,
        }),
      }));
      setPieceVersion((v) => v + 1);
      toast.info("Filled from stones register", `${hit.certificate_no}: ${[hit.lab_origin, hit.color_clarity, hit.last_rate_usd_per_ct ? `$${hit.last_rate_usd_per_ct}/ct` : null].filter(Boolean).join(" · ")}`);
    } catch (e) {
      console.warn("stones_register lookup failed", e);
    }
  }
  function updatePieceTuning(stock: string, patch: { base_gold_lock_usd?: string; fixed_addon_usd?: string }) {
    patchPiece(stock, (p) => {
      const d = (v?: string) => (v === undefined ? undefined : isNum(v) ? new Decimal(v) : null);
      const base = d(patch.base_gold_lock_usd);
      const addon = d(patch.fixed_addon_usd);
      return {
        ...p,
        base_gold_lock_usd: base === undefined ? p.base_gold_lock_usd : base,
        fixed_addon_usd: addon === undefined ? p.fixed_addon_usd : addon,
      };
    });
  }
  function toggleInclude(stock: string, on: boolean) {
    setExcluded((prev) => { const n = new Set(prev); if (on) n.delete(stock); else n.add(stock); return n; });
    invalidate();
  }
  function setAllIncluded(on: boolean, filter?: (p: Piece) => boolean) {
    setExcluded((prev) => {
      const n = new Set(prev);
      for (const p of pieces) if (!filter || filter(p)) { if (on) n.delete(p.stock_no); else n.add(p.stock_no); }
      return n;
    });
    invalidate();
  }
  function inputsFromForm(f: FormState): PerInvoiceInputs {
    const fx = dec(f.inr_usd_rate);
    return {
      invoice_number: f.invoice_number.trim().toUpperCase(),
      invoice_date: f.invoice_date,
      buyer_id: f.buyer_id!, bank_id: f.bank_id!,
      pre_carriage_id: f.pre_carriage_id ?? undefined,
      flight_mode_id: f.flight_mode_id ?? undefined,
      port_of_loading_id: f.port_of_loading_id ?? undefined,
      terms_id: f.terms_id ?? undefined,
      preferential_agreement_id: f.preferential_agreement_id ?? undefined,
      pre_carriage_text: f.pre_carriage_text || undefined,
      flight_mode_text: f.flight_mode_text || undefined,
      port_of_loading_text: f.port_of_loading_text || undefined,
      terms_text: f.terms_text || undefined,
      preferential_agreement_text: f.preferential_agreement_text || undefined,
      buyer_order_no: f.buyer_order_no.trim() || null,
      buyer_order_date: f.buyer_order_date || null,
      gold_rate_usd_per_troy_oz: dec(f.gold_rate_usd_per_troy_oz),
      gold_purity: dec(f.gold_purity, 0.999),
      gold_purchase_party: f.gold_purchase_party.trim(),
      gold_purchase_invoice_no: f.gold_purchase_invoice_no.trim(),
      gold_purchase_date: f.gold_purchase_date,
      gold_opening_stock_gm: isNum(f.gold_opening_stock_gm) ? new Decimal(f.gold_opening_stock_gm) : null,
      inr_usd_rate: fx,
      labour_inr_usd_rate: isNum(f.labour_inr_usd_rate) ? new Decimal(f.labour_inr_usd_rate) : fx,
      round_base_lock_2dp: f.round_base_lock_2dp,
      base_gold_rate_usd_per_gm: baseRate ?? new Decimal(0),
      package_gross_wt_kg: dec(f.package_gross_wt_kg),
      container_number: parseInt(f.container_number, 10) || 1,
      wastage_pct_override: isNum(f.wastage_pct_override) ? new Decimal(f.wastage_pct_override) : null,
      discount_usd: dec(f.discount_usd),
      freight_usd: dec(f.freight_usd),
      insurance_usd: dec(f.insurance_usd),
      commission_usd: dec(f.commission_usd),
    };
  }

  async function doPreview() {
    if (!settings || !hsnTable) { toast.warn("Config not loaded yet", "Try again in a moment."); return; }
    if (!included.length) { toast.warn("No pieces selected", "Tick at least one piece on the Pieces tab."); return; }
    const errs = validateForm(form);
    setFormErrors(errs);
    if (Object.keys(errs).length) { toast.warn("Fix form errors", `${Object.keys(errs).length} field(s) need attention.`); return; }
    setPreviewBusy(true);
    setResult(null);   // a fresh preview re-arms Generate (re-generating replaces the earlier save)
    try {
      const inputs = inputsFromForm(form);
      // Unselected terms / agreement print the buyer's defaults — validate what will print.
      const buyer = await fetchBuyer(inputs.buyer_id).catch(() => null);
      if (buyer && !inputs.preferential_agreement_text && buyer.default_preferential_agreement) {
        inputs.preferential_agreement_text = buyer.default_preferential_agreement;
      }
      const prepared = withGrossRounded(included, form.round_gross_2dp);
      const grouped = groupPiecesIntoLots(prepared, hsnTable, new Decimal(settings.default_wastage_pct), inputs.wastage_pct_override);
      for (const lot of grouped) {
        computeLotTotals({
          lot,
          gold_rate_usd_per_troy_oz: inputs.gold_rate_usd_per_troy_oz,
          gold_purity: inputs.gold_purity,
          labour_inr_usd_rate: inputs.labour_inr_usd_rate,
          base_gold_rate_usd_per_gm: inputs.base_gold_rate_usd_per_gm,
          kt_touch: settings.kt_touch,
          labor_rates: effectiveLabor,
          fixed_addon_usd: new Decimal(settings.mfg_fixed_addon_usd),
          round_base_lock_2dp: form.round_base_lock_2dp,
        });
      }
      const usd = grandTotalCf({
        lots: grouped, discount: inputs.discount_usd, freight: inputs.freight_usd,
        insurance: inputs.insurance_usd, commission: inputs.commission_usd,
      });
      const inr = grandTotalInr(usd, inputs.inr_usd_rate);
      const used = grouped.reduce((a, l) => a.add(pureGoldUsedGm(l, inputs.gold_purity)), new Decimal(0));

      let led: { opening_gm: number | null; drawdowns: GoldDrawdown[]; registered: boolean } | null = null;
      try { led = await loadGoldLedger(inputs); } catch (e) { console.warn("gold ledger load failed", e); }
      setLedger(led ? { ...led, used } : null);
      const before = led?.opening_gm != null
        ? new Decimal(led.opening_gm).sub(led.drawdowns.reduce((a, d) => a + d.quantity_gm, 0)) : null;

      setLots(grouped);
      setTotals({ usd, inr });
      const rep = runAll({
        pieces: prepared, lots: grouped, inputs, hsnTable,
        defaultWastagePct: new Decimal(settings.default_wastage_pct), settings,
        goldBalanceBeforeGm: before, goldUsedGm: used,
      });
      setReport(rep);
      if (isBlocked(rep)) {
        toast.error("Validation blocks generation", `${rep.findings.filter((f) => f.severity === "hard" && !f.passed).length} hard failure(s).`);
      } else {
        toast.success("Preview ready", `Total USD $${usd.toFixed(2)} · INR ₹${inr.toFixed(2)}`);
      }
      setTab("review");
    } catch (e) {
      errToast(e, "Preview failed");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function doGenerate() {
    if (!settings || !hsnTable || !lots.length || !totals || !form.buyer_id || !form.bank_id) return;
    setGenerateBusy(true);
    try {
      const inputs = inputsFromForm(form);
      const [buyer, bank, buyers, banks] = await Promise.all([
        fetchBuyer(form.buyer_id), fetchBank(form.bank_id),
        fetchAllBuyers().catch(() => []), fetchAllBanks().catch(() => []),
      ]);
      if (ledger?.opening_gm != null && !inputs.gold_opening_stock_gm) inputs.gold_opening_stock_gm = new Decimal(ledger.opening_gm);
      const blob = await generateXlsx({
        settings, buyer, bank, buyers, banks, inputs,
        lots, totals_usd: totals.usd, totals_inr: totals.inr,
        drawdowns: ledger?.drawdowns ?? [],
      });
      const safeInv = inputs.invoice_number.replace(/[^A-Za-z0-9]+/g, "-");
      const market = marketSuffix(buyer.city, buyer.country);
      const genName = `INVOICE NO. ${safeInv}${market ? ` (${market})` : ""} MASTER DETAILS.xlsx`;

      const saved = await saveInvoice({
        inputs, lots, totals_usd: totals.usd, totals_inr: totals.inr,
        rawFiles: packFiles.map((f) => ({ file: f, name: f.name })),
        generatedBlob: blob, generatedFileName: genName,
        goldUsedGm: ledger?.used ?? null,
      });
      setResult({ invoice_id: saved.invoice_id, replaced: saved.replaced, fileName: genName });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = genName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      toast.success(saved.replaced ? "Invoice re-generated" : "Invoice generated", `Saved as ${genName}.`);
    } catch (e) {
      errToast(e, "Generation failed");
    } finally {
      setGenerateBusy(false);
    }
  }

  function startNew() {
    setPieces([]); setExcluded(new Set()); setPackFiles([]);
    setForm(INITIAL_FORM);
    setFormErrors({}); setLedger(null);
    setLots([]); setTotals(null); setReport(null); setResult(null);
    setTab("upload");
  }

  // Keyboard shortcuts (Ctrl+Enter advances)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (tab === "upload" && packFiles.length && !parseBusy) { e.preventDefault(); onParse(); }
        else if (tab === "pieces") { e.preventDefault(); setTab("form"); }
        else if (tab === "form" && !previewBusy) { e.preventDefault(); doPreview(); }
        else if (tab === "review" && report && !isBlocked(report)) { e.preventDefault(); setTab("generate"); }
        else if (tab === "generate" && !generateBusy && !result) { e.preventDefault(); doGenerate(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ────────── Render ──────────

  if (envMissing) {
    return (
      <div style={{ maxWidth: 560, margin: "80px auto", padding: 20 }}>
        <h2>Supabase is not configured</h2>
        <p className="hint">This build has no Supabase project URL / anon key. For local dev, open <code>.env</code> and set
          {" "}<code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (Supabase → Project Settings → API), then restart <code>npm run dev</code>.
          On Netlify, set the same two variables under Site settings → Environment variables and redeploy.</p>
        <p className="hint-small">Never use the <code>service_role</code> key here.</p>
      </div>
    );
  }
  if (authLoading) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!user) {
    return (
      <div style={{ maxWidth: 380, margin: "80px auto", padding: 20 }}>
        <h2>Sign in</h2>
        <form onSubmit={signIn} className="grid" style={{ gridTemplateColumns: "1fr", gap: 12 }}>
          <label>Email<input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required autoComplete="username" /></label>
          <label>Password<input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required autoComplete="current-password" /></label>
          <button className="btn primary" type="submit" disabled={signInBusy}>{signInBusy ? <><span className="spinner" /> Signing in…</> : "Sign in"}</button>
          <div className="hint-small">Create your account in Supabase → Authentication → Users, then set <code>app_metadata.role = "accounts"</code>.</div>
        </form>
      </div>
    );
  }

  return (
    <>
      <header className="titlebar">
        <div className="title">
          <span className="logo">JWY</span>
          <span>jwy-export-invoice <span className="muted">— {user.email}{canEdit ? "" : " (read-only)"}</span></span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {configLoading && <span className="pill"><span className="spinner" /> loading config</span>}
          <button className="btn small" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {([
          ["dashboard", "📊 Dashboard"],
          ["upload", "1 · Upload"],
          ["pieces", "2 · Pieces"],
          ["form", "3 · Per-invoice"],
          ["review", "4 · Review"],
          ["generate", "5 · Generate"],
          ["settings", "⚙ Settings"],
        ] as [Tab, string][]).map(([t, label]) => (
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
          >{label}</button>
        ))}
      </nav>

      <main className="pane">
        {tab === "dashboard" && (
          <>
            <Dashboard />
            <div style={{ marginTop: 20 }}>
              <button className="btn primary" onClick={startNew} disabled={!canEdit}>+ New invoice</button>
            </div>
          </>
        )}
        {tab === "upload" && (
          <UploadPane
            packFiles={packFiles} setPackFiles={setPackFiles}
            onParse={onParse} busy={parseBusy}
          />
        )}
        {tab === "pieces" && (
          pieces.length === 0 ? (
            <Empty icon="📦" title="No pieces loaded" body="Upload an SJ-50 file first." />
          ) : (
            <PiecesPane
              key={pieceVersion}
              pieces={pieces} excluded={excluded}
              settings={settings} baseRate={baseRate} laborRates={effectiveLabor} roundAr={form.round_base_lock_2dp}
              toggleInclude={toggleInclude} setAllIncluded={setAllIncluded}
              updateDiamond={updateDiamond} splitDiamond={splitDiamond} removeDiamond={removeDiamond}
              onCertBlur={onCertBlur} updatePieceTuning={updatePieceTuning}
              onContinue={() => setTab("form")}
            />
          )
        )}
        {tab === "form" && (
          <FormPane form={form} setForm={(f) => { setForm(f); invalidate(); }} errors={formErrors} onPreview={doPreview} busy={previewBusy} settings={settings} />
        )}
        {tab === "review" && (
          <ReviewPane lots={lots} totals={totals} report={report} ledger={ledger} onBack={() => setTab("form")} onContinue={() => setTab("generate")} />
        )}
        {tab === "generate" && (
          <GeneratePane busy={generateBusy} result={result} onGenerate={doGenerate} onNewInvoice={startNew} canEdit={canEdit} />
        )}
        {tab === "settings" && (
          <Settings canEdit={canEdit} onSaved={() => { setConfigVersion((v) => v + 1); invalidate(); }} />
        )}
      </main>

      <footer className="statusbar">
        <span>{configLoading ? "Loading config…" : settings ? `Ready · ${settings.exporter_name}` : "Config missing"}</span>
        <span>Ctrl + Enter to advance · Esc to cancel</span>
      </footer>
    </>
  );
}

// ────────── Sub-panes ──────────

function UploadPane(props: {
  packFiles: File[]; setPackFiles: (f: File[]) => void;
  onParse: () => void; busy: boolean;
}) {
  const { packFiles, setPackFiles, onParse, busy } = props;
  const tooBig = packFiles.find((f) => f.size > 10 * 1024 * 1024);
  return (
    <div>
      <h2>Upload the packing list</h2>
      <p className="hint">Drop the <code>SDJ-JB-&lt;nnn&gt; … .xls</code> file from Swan. Only its <strong>Packing List</strong> sheet
        (sheet 2) is read — the tax-invoice sheet is ignored. Older <code>SJ-50 DCJ … pcs.xls</code> files work too, and you can
        add several files at once; the same stock no. is kept once.</p>
      <div className={clsx("dropzone", { "have-file": packFiles.length > 0 })}>
        <input id="sj50" type="file" accept=".xls,.xlsx" multiple
               onChange={(e) => setPackFiles(Array.from(e.target.files ?? []))} />
        <label htmlFor="sj50">{packFiles.length ? packFiles.map((f) => f.name).join(" · ") : "Pick file(s) or drop here"}</label>
        {packFiles.length > 0 && <div className="hint-small">{packFiles.length} file(s) · {(packFiles.reduce((a, f) => a + f.size, 0) / 1024).toFixed(1)} KB</div>}
        {tooBig && <div className="err">{tooBig.name} is over 10 MB — is it the right file?</div>}
      </div>
      <p className="hint-small">From the sheet: style, item, KT, colour, qty, gross / net wt, studding pcs &amp; carats per shape,
        colour stones, labour ₹/g, region and category. You fill in on the next steps: certificate, grade and USD/ct per studding
        row, and the invoice details (buyer, bank, gold rate, exchange rates, package weight).</p>

      <div className="actions">
        <button className="btn primary big" disabled={!packFiles.length || busy || !!tooBig} onClick={onParse}>
          {busy ? <><span className="spinner" /> Parsing…</> : "Parse →"}
        </button>
      </div>
    </div>
  );
}

type DiamondPatch = Partial<Record<"shape" | "pcs" | "cts" | "certificate_no" | "origin" | "color_clarity" | "rate_usd_per_ct", string>>;

function PiecesPane(props: {
  pieces: Piece[];
  excluded: Set<string>;
  settings: AppSettings | null;
  baseRate: Decimal | null;
  roundAr: boolean;
  laborRates: Record<string, number>;
  toggleInclude: (stock: string, on: boolean) => void;
  setAllIncluded: (on: boolean, filter?: (p: Piece) => boolean) => void;
  updateDiamond: (stock: string, idx: number, patch: DiamondPatch) => void;
  splitDiamond: (stock: string, idx: number) => void;
  removeDiamond: (stock: string, idx: number) => void;
  onCertBlur: (stock: string, idx: number, cert: string) => void;
  updatePieceTuning: (stock: string, patch: { base_gold_lock_usd?: string; fixed_addon_usd?: string }) => void;
  onContinue: () => void;
}) {
  const { pieces, excluded, settings, baseRate, laborRates, roundAr } = props;
  const nIncl = pieces.filter((p) => !excluded.has(p.stock_no)).length;
  const sources = [...new Set(pieces.map((p) => p.source ?? ""))].filter(Boolean);
  return (
    <div>
      <h2>Pieces ({nIncl} of {pieces.length} on this invoice)</h2>
      <p className="hint">Untick pieces that go on a different invoice (one SJ-50 can feed two buyers — the 05.10 file became EXP546 UK + EXP553 Sydney).
        Fill certificate / grade / rate per studding row; use <strong>Split</strong> when Accounts prices one shape row in several sieve sizes
        (row totals must still match the packing list). Fields save when you leave them.</p>
      <div className="actions" style={{ marginTop: 0 }}>
        <button className="btn small" onClick={() => props.setAllIncluded(true)}>Select all</button>
        <button className="btn small" onClick={() => props.setAllIncluded(false)}>Select none</button>
        {sources.length > 1 && sources.map((s) => (
          <button key={s} className="btn small" onClick={() => { props.setAllIncluded(false); props.setAllIncluded(true, (p) => p.source === s); }}>Only {s}</button>
        ))}
      </div>

      {pieces.map((p) => {
        const on = !excluded.has(p.stock_no);
        const K = netWtGm(p);
        const { touch, configured } = touchFor(p.kt, settings?.kt_touch ?? {});
        const auto = baseRate ? baseGoldLockUsd({ net_wt_raw: p.net_wt_raw, computed_net_wt: K, touch, base_rate_usd_per_gm: baseRate }) : null;
        const pcs = p.diamonds.reduce((a, d) => a + d.pcs, 0);
        const cts = p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
        const mismatch = p.studding_raw_cts !== undefined && (pcs !== p.studding_raw_pcs || cts.sub(p.studding_raw_cts).abs().gt(0.02));
        const labour = p.labour_rate_inr_per_gm?.toNumber() ?? laborRates[p.kt] ?? laborRates[p.kt.replace("-PD", "")];
        return (
          <section key={p.stock_no} className={clsx("piece-card", { off: !on })}>
            <div className="piece-head">
              <label className="piece-include">
                <input type="checkbox" checked={on} onChange={(e) => props.toggleInclude(p.stock_no, e.target.checked)} />
                <strong>{p.cust_style_no || p.stock_no}</strong>
              </label>
              <span className="muted">stock {p.stock_no}{p.cust_po ? ` · PO ${p.cust_po}` : ""}</span>
              <span>{p.item} · {p.kt.replace("-PD", "K PD").replace(/^(\d+)$/, "$1K")} · {p.color}</span>
              <span>gross {p.gross_wt.toFixed(3)} g · net {K.toFixed(3)} g</span>
              <span className="pill">{p.jewellery_type.replace("gold_", "").replace("studded_", "")}{p.semi_mount ? " · semi-mount" : ""}</span>
              {p.product_category && <span className="muted">“{p.product_category.trim()}”</span>}
              {p.region && <span className="pill">region {p.region}</span>}
              {p.source && <span className="muted hint-small">{p.source}</span>}
            </div>
            {on && (
              <>
                {p.diamonds.length > 0 && (
                  <div className="table-wrap cards">
                    <table>
                      <thead>
                        <tr><th>Shape</th><th>Pcs</th><th>Cts</th><th>Certificate</th><th>Dia details</th><th>Colour &amp; qlty</th><th>USD/ct</th><th>Value</th><th /></tr>
                      </thead>
                      <tbody>
                        {p.diamonds.map((d, i) => (
                          <tr key={`${i}-${p.diamonds.length}`}>
                            <td data-label="Shape"><input defaultValue={d.shape} onBlur={(e) => props.updateDiamond(p.stock_no, i, { shape: e.target.value })} /></td>
                            <td data-label="Pcs"><input inputMode="numeric" defaultValue={d.pcs} onBlur={(e) => props.updateDiamond(p.stock_no, i, { pcs: e.target.value })} /></td>
                            <td data-label="Cts"><input inputMode="decimal" defaultValue={d.cts.toString()} onBlur={(e) => props.updateDiamond(p.stock_no, i, { cts: e.target.value })} /></td>
                            <td data-label="Certificate"><input placeholder="IGI-LG…" defaultValue={d.certificate_no ?? ""} onBlur={(e) => props.onCertBlur(p.stock_no, i, e.target.value)} /></td>
                            <td data-label="Dia details"><input placeholder="e.g. LGD001-CVD" list="origin-options" defaultValue={d.origin ?? ""} onBlur={(e) => props.updateDiamond(p.stock_no, i, { origin: e.target.value })} /></td>
                            <td data-label="Colour & qlty"><input placeholder="e.g. D-VS1" defaultValue={d.color_clarity ?? ""} onBlur={(e) => props.updateDiamond(p.stock_no, i, { color_clarity: e.target.value })} /></td>
                            <td data-label="USD/ct"><input placeholder="0.00" inputMode="decimal" className={clsx({ invalid: d.pcs > 0 && !d.rate_usd_per_ct })} defaultValue={d.rate_usd_per_ct?.toString() ?? ""} onBlur={(e) => props.updateDiamond(p.stock_no, i, { rate_usd_per_ct: e.target.value })} /></td>
                            <td data-label="Value">{d.rate_usd_per_ct ? `$${d.rate_usd_per_ct.mul(d.cts).toFixed(2)}` : "—"}</td>
                            <td data-label="">
                              <button className="btn small" title="Split this row by sieve size" onClick={() => props.splitDiamond(p.stock_no, i)}>Split</button>
                              {p.diamonds.length > 1 && <button className="btn small" onClick={() => props.removeDiamond(p.stock_no, i)} title="Remove row">✕</button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {mismatch && <div className="err">Studding rows total {pcs} pcs / {cts.toFixed(3)} ct but the packing list says {p.studding_raw_pcs} pcs / {p.studding_raw_cts!.toFixed(3)} ct.</div>}
                <div className="grid piece-tuning">
                  <label>Base lock USD (AR)
                    <input inputMode="decimal" placeholder={auto ? `auto ${(roundAr ? auto.value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : auto.value).toFixed(roundAr ? 2 : 4)}` : "auto (needs gold rate)"} defaultValue={p.base_gold_lock_usd?.toString() ?? ""}
                           onBlur={(e) => props.updatePieceTuning(p.stock_no, { base_gold_lock_usd: e.target.value })} />
                    <div className="hint-small">{auto
                      ? <>auto = {auto.net.toFixed(2)} g × {touch.toString()}{configured ? "" : " (KT/24 — set touch in Settings)"} × {baseRate!.toString()}</>
                      : <>enter the gold rate on Per-invoice; AR = net × {touch.toString()} × (gold rate × ratio)</>}</div>
                  </label>
                  <label>Add-on USD (AZ)
                    <input inputMode="decimal" placeholder={`default ${settings?.mfg_fixed_addon_usd ?? 10}`} defaultValue={p.fixed_addon_usd?.toString() ?? ""}
                           onBlur={(e) => props.updatePieceTuning(p.stock_no, { fixed_addon_usd: e.target.value })} />
                    <div className="hint-small">labour ₹{labour ?? "?"}/g {p.labour_rate_inr_per_gm ? "(from sheet)" : "(from Settings)"}</div>
                  </label>
                </div>
              </>
            )}
          </section>
        );
      })}
      <datalist id="origin-options">
        <option value="LGD001-CVD" /><option value="LGD002-HPHT" /><option value="MINED" /><option value="SEMI-PRECIOUS STONE" />
      </datalist>
      <div className="actions">
        <button className="btn primary" onClick={props.onContinue} disabled={nIncl === 0}>Continue →</button>
      </div>
    </div>
  );
}

function FormPane(props: {
  form: FormState; setForm: (f: FormState) => void; errors: FormErrors;
  onPreview: () => void; busy: boolean; settings: AppSettings | null;
}) {
  const { form, setForm, errors, onPreview, busy, settings } = props;
  function u<K extends keyof FormState>(k: K, v: FormState[K]) { setForm({ ...form, [k]: v }); }
  function pick(idKey: keyof FormState, textKey?: keyof FormState) {
    return (o: LookupOption | null) => setForm({ ...form, [idKey]: o?.id ?? null, ...(textKey ? { [textKey]: o?.label ?? "" } : {}) });
  }
  function fieldCls(k: keyof FormState) { return errors[k] ? "invalid" : ""; }
  function err(k: keyof FormState) { return <div className="err">{errors[k] ?? ""}</div>; }
  return (
    <div>
      <h2>Per-invoice inputs</h2>
      <p className="hint">Required fields are marked *. Dropdowns remember new values — type and pick &quot;+ Add&quot;.</p>
      <h3 className="section">Invoice</h3>
      <div className="grid">
        <label>Invoice number *
          <input className={fieldCls("invoice_number")} value={form.invoice_number} onChange={(e) => u("invoice_number", e.target.value)} placeholder="EXP570/2026-27" />
          {err("invoice_number")}
        </label>
        <label>Invoice date *
          <input className={fieldCls("invoice_date")} type="date" value={form.invoice_date} onChange={(e) => u("invoice_date", e.target.value)} />
          {err("invoice_date")}
        </label>
        <label>Buyer *
          <Dropdown lookupKey="buyers" value={form.buyer_id} onChange={pick("buyer_id")} invalid={!!errors.buyer_id} allowAdd={false} />
          {err("buyer_id")}
        </label>
        <label>Bank *
          <Dropdown lookupKey="banks" value={form.bank_id} onChange={pick("bank_id")} invalid={!!errors.bank_id} allowAdd={false} />
          {err("bank_id")}
        </label>
        <label>Payment terms
          <Dropdown lookupKey="payment_terms" value={form.terms_id} onChange={pick("terms_id", "terms_text")} placeholder="(buyer default)" />
        </label>
        <label>Preferential agreement
          <Dropdown lookupKey="preferential_agreements" value={form.preferential_agreement_id} onChange={pick("preferential_agreement_id", "preferential_agreement_text")} placeholder="(buyer default)" />
        </label>
        <label>Pre-carriage
          <Dropdown lookupKey="freight_carriers" value={form.pre_carriage_id} onChange={pick("pre_carriage_id", "pre_carriage_text")} placeholder="SEQUEL" />
        </label>
        <label>Vessel / Flight
          <Dropdown lookupKey="freight_modes" value={form.flight_mode_id} onChange={pick("flight_mode_id", "flight_mode_text")} placeholder="BY AIR FREIGHT" />
        </label>
        <label>Port of Loading
          <Dropdown lookupKey="ports" value={form.port_of_loading_id} onChange={pick("port_of_loading_id", "port_of_loading_text")} placeholder="MUMBAI / INDIA" />
        </label>
        <label>Buyer&apos;s order no.
          <input value={form.buyer_order_no} onChange={(e) => u("buyer_order_no", e.target.value)} />
        </label>
        <label>Buyer&apos;s order date
          <input type="date" value={form.buyer_order_date} onChange={(e) => u("buyer_order_date", e.target.value)} />
        </label>
      </div>

      <h3 className="section">Gold &amp; exchange</h3>
      <div className="grid">
        <label>Gold rate (USD / troy oz) *
          <input className={fieldCls("gold_rate_usd_per_troy_oz")} value={form.gold_rate_usd_per_troy_oz} onChange={(e) => u("gold_rate_usd_per_troy_oz", e.target.value)} placeholder="4339.8413" inputMode="decimal" />
          {err("gold_rate_usd_per_troy_oz")}
        </label>
        <label>Gold purity *
          <input className={fieldCls("gold_purity")} value={form.gold_purity} onChange={(e) => u("gold_purity", e.target.value)} inputMode="decimal" />
          {err("gold_purity")}
        </label>
        <label>Gold purchase party
          <input value={form.gold_purchase_party} onChange={(e) => u("gold_purchase_party", e.target.value)} />
        </label>
        <label>Gold purchase invoice # *
          <input className={fieldCls("gold_purchase_invoice_no")} value={form.gold_purchase_invoice_no} onChange={(e) => u("gold_purchase_invoice_no", e.target.value)} placeholder="OX26100MUM1059" />
          {err("gold_purchase_invoice_no")}
        </label>
        <label>Gold purchase date
          <input type="date" value={form.gold_purchase_date} onChange={(e) => u("gold_purchase_date", e.target.value)} />
        </label>
        <label>Opening stock of this purchase (g)
          <input className={fieldCls("gold_opening_stock_gm")} value={form.gold_opening_stock_gm} onChange={(e) => u("gold_opening_stock_gm", e.target.value)} placeholder="first use only, e.g. 200" inputMode="decimal" />
          {err("gold_opening_stock_gm")}
          <div className="hint-small">Only needed the first time a purchase is used; later invoices read it from the ledger.</div>
        </label>
        <label>Invoice INR / USD rate *
          <input className={fieldCls("inr_usd_rate")} value={form.inr_usd_rate} onChange={(e) => u("inr_usd_rate", e.target.value)} placeholder="95.35" inputMode="decimal" />
          {err("inr_usd_rate")}
        </label>
        <label>Labour INR / USD rate
          <input className={fieldCls("labour_inr_usd_rate")} value={form.labour_inr_usd_rate} onChange={(e) => u("labour_inr_usd_rate", e.target.value)} placeholder={form.inr_usd_rate || "same as invoice"} inputMode="decimal" />
          {err("labour_inr_usd_rate")}
          <div className="hint-small">CUSTOMS PL!AU. EXP535 used 95.10 here and 95.35 on the invoice.</div>
        </label>
        <label>Base-gold lock rate (USD / g pure)
          <input className={fieldCls("base_gold_rate_usd_per_gm")} value={form.base_gold_rate_usd_per_gm} onChange={(e) => u("base_gold_rate_usd_per_gm", e.target.value)}
                 placeholder={isNum(form.gold_rate_usd_per_troy_oz) ? `auto ${defaultBaseGoldRate(new Decimal(form.gold_rate_usd_per_troy_oz), settings?.base_gold_lock_ratio ?? DEFAULT_BASE_GOLD_LOCK_RATIO).toString()}` : "auto from gold rate"} inputMode="decimal" />
          {err("base_gold_rate_usd_per_gm")}
          <div className="hint-small">Blank = gold rate × {settings?.base_gold_lock_ratio ?? DEFAULT_BASE_GOLD_LOCK_RATIO} (EXP535: 139.395, EXP615: 135.176). Type to override.</div>
        </label>
      </div>

      <h3 className="section">Packaging &amp; adjustments</h3>
      <div className="grid">
        <label>Package gross wt (kg) *
          <input className={fieldCls("package_gross_wt_kg")} value={form.package_gross_wt_kg} onChange={(e) => u("package_gross_wt_kg", e.target.value)} inputMode="decimal" />
          {err("package_gross_wt_kg")}
        </label>
        <label>Container no.
          <input value={form.container_number} onChange={(e) => u("container_number", e.target.value)} inputMode="numeric" />
        </label>
        <label className="checkbox-row">
          <span><input type="checkbox" checked={form.round_gross_2dp} onChange={(e) => u("round_gross_2dp", e.target.checked)} />
            {" "}Round gross weight to 2 decimals</span>
          <div className="hint-small">As on EXP535 / EXP615 (5.808 → 5.81). Untick to keep the sheet&apos;s 3 decimals (EXP570).</div>
        </label>
        <label className="checkbox-row">
          <span><input type="checkbox" checked={form.round_base_lock_2dp} onChange={(e) => u("round_base_lock_2dp", e.target.checked)} />
            {" "}Round base lock (AR) to 2 decimals</span>
          <div className="hint-small">As on EXP570 / EXP615. Untick for full precision (EXP535). Moves MFG by at most a cent.</div>
        </label>
        <label>Wastage override (all lots)
          <input className={fieldCls("wastage_pct_override")} value={form.wastage_pct_override} onChange={(e) => u("wastage_pct_override", e.target.value)} placeholder="blank = per HSN (4 % studded, 2 % mount)" inputMode="decimal" />
          {err("wastage_pct_override")}
        </label>
        <label>Freight (USD)
          <input className={fieldCls("freight_usd")} value={form.freight_usd} onChange={(e) => u("freight_usd", e.target.value)} inputMode="decimal" />
          {err("freight_usd")}
        </label>
        <label>Insurance (USD)
          <input className={fieldCls("insurance_usd")} value={form.insurance_usd} onChange={(e) => u("insurance_usd", e.target.value)} inputMode="decimal" />
          {err("insurance_usd")}
        </label>
        <label>Discount (USD)
          <input className={fieldCls("discount_usd")} value={form.discount_usd} onChange={(e) => u("discount_usd", e.target.value)} inputMode="decimal" />
          {err("discount_usd")}
        </label>
        <label>Commission (USD)
          <input className={fieldCls("commission_usd")} value={form.commission_usd} onChange={(e) => u("commission_usd", e.target.value)} inputMode="decimal" />
          {err("commission_usd")}
        </label>
      </div>
      <div className="actions">
        <button className="btn primary big" onClick={onPreview} disabled={busy}>
          {busy ? <><span className="spinner" /> Computing…</> : "Preview totals →"}
        </button>
      </div>
    </div>
  );
}

function ReviewPane(props: {
  lots: Lot[]; totals: { usd: Decimal; inr: Decimal } | null;
  report: ValidationReport | null;
  ledger: { opening_gm: number | null; drawdowns: GoldDrawdown[]; registered: boolean; used: Decimal } | null;
  onBack: () => void; onContinue: () => void;
}) {
  const { lots, totals, report, ledger, onBack, onContinue } = props;
  const blocked = report ? isBlocked(report) : true;
  if (!totals) return <SkelRows count={4} />;
  const sorted = report ? [...report.findings].sort((a, b) => Number(a.passed) - Number(b.passed) || (a.severity === "hard" ? -1 : 1)) : [];
  return (
    <div>
      <h2>Review</h2>
      <div className="summary">
        <div className="row"><span className="k">Pieces</span><span className="v">{lots.reduce((a, l) => a + l.pieces.reduce((aa, p) => aa + p.qty, 0), 0)}</span></div>
        <div className="row"><span className="k">Lots</span><span className="v">{lots.length}</span></div>
        <div className="row"><span className="k">C&amp;F USD</span><span className="v">${totals.usd.toFixed(2)}</span></div>
        <div className="row"><span className="k">INR</span><span className="v">₹{totals.inr.toFixed(2)}</span></div>
        {ledger && (
          <div className="row"><span className="k">Gold used</span><span className="v">{ledger.used.toFixed(3)} g{ledger.opening_gm != null ? ` of ${ledger.opening_gm} g purchase` : ""}</span></div>
        )}
      </div>
      <h3 className="section">Lots</h3>
      <div className="table-wrap cards">
        <table>
          <thead>
            <tr><th>#</th><th>Description</th><th>HSN</th><th>Pcs</th>
              <th>Gross</th><th>Net</th><th>Wastage</th><th>Gold USD</th><th>Studd USD</th>
              <th>MFG USD</th><th>Total USD</th><th>V-add %</th></tr>
          </thead>
          <tbody>
            {lots.map((l) => {
              const t = l.totals!;
              const studd = t.diamond_value_usd.add(t.stone_value_usd);
              return (
                <tr key={l.lot_no}>
                  <td data-label="#">{l.lot_no}</td><td data-label="Description">{l.description}</td><td data-label="HSN">{l.hsn_code}</td>
                  <td data-label="Pcs">{l.pieces.reduce((a, p) => a + p.qty, 0)}</td>
                  <td data-label="Gross">{t.gross_wt.toFixed(3)}</td><td data-label="Net">{t.net_wt.toFixed(3)}</td>
                  <td data-label="Wastage">{l.wastage_pct.mul(100).toFixed(2)}%</td>
                  <td data-label="Gold USD">${t.gold_value_usd.toFixed(2)}</td>
                  <td data-label="Studd USD">${studd.toFixed(2)}</td>
                  <td data-label="MFG USD">${t.mfg_cost_usd.toFixed(2)}</td>
                  <td data-label="Total USD">${t.total_usd.toFixed(2)}</td>
                  <td data-label="V-add %">{t.value_addition_ratio.mul(100).toFixed(2)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary>Per-piece MFG breakdown (CUSTOMS PL AR → BA)</summary>
        <div className="table-wrap cards">
          <table>
            <thead><tr><th>Lot</th><th>Style</th><th>Net</th><th>Gold P</th><th>Lock AR</th><th>P − AR</th><th>Labour ₹/g</th><th>Labour $</th><th>Add-on</th><th>MFG AK</th><th>Total AL</th></tr></thead>
            <tbody>
              {lots.flatMap((l) => l.pieces.map((p, i) => {
                const c = l.piece_calcs![i];
                return (
                  <tr key={p.stock_no}>
                    <td data-label="Lot">{l.lot_no}</td><td data-label="Style">{p.cust_style_no || p.stock_no}</td>
                    <td data-label="Net">{c.net_wt.toFixed(3)}</td><td data-label="Gold P">{c.gold_value.toFixed(2)}</td>
                    <td data-label="Lock AR">{c.base_lock.toFixed(2)}{c.base_lock_auto ? "" : " ✎"}</td>
                    <td data-label="P − AR">{c.residual.toFixed(2)}</td><td data-label="Labour ₹/g">{c.labour_rate_inr.toString()}</td>
                    <td data-label="Labour $">{c.labour_cost.toFixed(2)}</td><td data-label="Add-on">{c.addon.toString()}</td>
                    <td data-label="MFG AK">{c.mfg.toFixed(2)}</td><td data-label="Total AL">{c.total.toFixed(2)}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      </details>
      <h3 className="section">Validation</h3>
      {sorted.map((f) => (
        <div key={f.code} className={clsx("finding", f.passed ? "passed" : f.severity)}>
          <strong><code>{f.code}</code></strong> · {f.message}
          {f.detail ? <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{JSON.stringify(f.detail).slice(0, 300)}</div> : null}
        </div>
      ))}
      <div className="actions">
        <button className="btn" onClick={onBack}>← Edit inputs</button>
        <button className="btn primary" onClick={onContinue} disabled={blocked}>
          {blocked ? "Fix hard failures first" : "Looks good →"}
        </button>
      </div>
    </div>
  );
}

function GeneratePane(props: {
  busy: boolean;
  result: { invoice_id: string; replaced: boolean; fileName: string } | null;
  onGenerate: () => void;
  onNewInvoice: () => void;
  canEdit: boolean;
}) {
  const { busy, result, onGenerate, onNewInvoice, canEdit } = props;
  return (
    <div>
      <h2>Generate the invoice</h2>
      <p>Clicking Generate will:</p>
      <ol>
        <li>Build the <code>MASTER DETAILS .xlsx</code> (INVOICE + CUSTOMS PL, live formulas) in your browser.</li>
        <li>Upload the packing list(s), the vendor invoice (if any) and the generated file to Supabase Storage.</li>
        <li>Save the invoice, lots, pieces, studding rows, the base lock used per piece, the gold drawdown and the stones register.
          Re-generating the same EXP number replaces the earlier save.</li>
        <li>Download the <code>.xlsx</code>.</li>
      </ol>
      {!canEdit && <div className="finding soft">Your account is read-only (role ≠ accounts/admin), so saving will be refused.</div>}
      {!result && (
        <div className="actions">
          <button className="btn primary big" onClick={onGenerate} disabled={busy}>
            {busy ? <><span className="spinner" /> Generating…</> : "Generate"}
          </button>
        </div>
      )}
      {busy && (
        <div style={{ marginTop: 16 }}>
          <Skel w="60%" />
          <div style={{ height: 8 }} />
          <Skel w="40%" />
        </div>
      )}
      {result && (
        <div className="result-box">
          <strong>✓ {result.replaced ? "Re-generated" : "Generated"}.</strong> <code>{result.fileName}</code> has downloaded and is stored under invoice <code>{result.invoice_id}</code>; the Dashboard can re-download it.
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={onNewInvoice}>+ New invoice</button>
          </div>
        </div>
      )}
    </div>
  );
}
