/** Top-level app: auth gate, sidebar shell, the five-step invoice wizard, invoices list and settings. */
import { useCallback, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, ArrowRight, Calculator, Database, FileSearch, FileSpreadsheet, History, RotateCcw, ShieldCheck } from "lucide-react";

import { supabase } from "./supabase";
import type { AppSettings, Buyer, DiamondDetail, GoldDrawdown, HsnEntry, JewelleryType, Lot, MainWsRow, PerInvoiceInputs, Piece, ValidationReport } from "./types";
import { loadAppSettings, loadHsnTable, loadLaborRates } from "./storage/settings";
import { fetchAllBanks, fetchAllBuyers, fetchBank, fetchBuyer, lookupStone } from "./storage/lookups";
import { parsePackingLists } from "./parsers/sj50";
import { parseMainWs } from "./parsers/mainws";
import { applyMainWs, suggestBuyer, type MainWsSummary } from "./lib/mainws";
import { groupPiecesIntoLots } from "./lib/grouping";
import { computeLotTotals, defaultBaseGoldRate, grandTotalCf, grandTotalInr, pureGoldUsedGm, withGrossRounded, DEFAULT_BASE_GOLD_LOCK_RATIO } from "./lib/calculations";
import { isBlocked, runAll } from "./lib/validators";
import { generateXlsx } from "./generators/xlsx";
import { loadGoldLedger, saveInvoice } from "./storage/invoices";
import { Dashboard } from "./components/Dashboard";
import { Settings } from "./components/Settings";
import { Sidebar, Stepper, type StepView, type View } from "./components/Shell";
import { ToastProvider, useErrorToast, useToast } from "./components/Toast";
import { ActionBar, BrandMark, Card, ConfirmDialog, Field, Kbd, Spinner, Stat, fmtUsd, plural } from "./components/ui";
import { UploadStep, MAX_FILE_BYTES, MAX_MAIN_BYTES } from "./components/steps/UploadStep";
import { PiecesStep, type DiamondPatch } from "./components/steps/PiecesStep";
import { DetailsStep } from "./components/steps/DetailsStep";
import { ReviewStep, type Ledger } from "./components/steps/ReviewStep";
import { GenerateStep, type GenerateResult } from "./components/steps/GenerateStep";
import {
  STEPS, dec, initialForm, isNum, marketSuffix, missingRates, validateForm,
  type FormErrors, type FormState, type Step,
} from "./components/steps/form";

const NO_ERRORS: FormErrors = {};

const STEP_SUB: Record<Step, string> = {
  upload: "Start with the packing list from Swan.",
  pieces: "Choose the pieces for this invoice and price each stone row. Fields save when you leave them.",
  details: "Everything the packing list doesn't carry. Fields marked * are required.",
  review: "Check the totals and the validation before generating.",
  generate: "Create the workbook and save the invoice.",
};

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

  // ── auth ──
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

  // ── config ──
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
      .catch((e) => errToast(e, "Settings failed to load"))
      .finally(() => setConfigLoading(false));
  }, [user, errToast, configVersion]);

  // ── navigation + flow state ──
  const [view, setView] = useState<View>("invoices");
  const [step, setStep] = useState<Step>("upload");
  const [packFiles, setPackFiles] = useState<File[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState>(initialForm);
  const [showErrors, setShowErrors] = useState(false);   // after a failed preview, errors update live
  const [lots, setLots] = useState<Lot[]>([]);
  const [totals, setTotals] = useState<{ usd: Decimal; inr: Decimal } | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [parseBusy, setParseBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [pieceVersion, setPieceVersion] = useState(0);   // bump to re-seed uncontrolled inputs
  const [confirmReset, setConfirmReset] = useState(false);
  // Main File "Main WS" tab (optional): certificates, centre-stone grades, ship-to.
  const [mainFile, setMainFileState] = useState<File | null>(null);
  const [mainRows, setMainRows] = useState<{ file: File; rows: MainWsRow[] } | null>(null);
  const [mainSummary, setMainSummary] = useState<MainWsSummary | null>(null);
  const [mainBusy, setMainBusy] = useState(false);
  const [buyers, setBuyers] = useState<Buyer[]>([]);

  const included = useMemo(() => pieces.filter((p) => !excluded.has(p.stock_no)), [pieces, excluded]);
  const buyerHint = useMemo(() => (buyers.length ? suggestBuyer(included, buyers) : null), [included, buyers]);
  const ratesMissing = useMemo(() => included.reduce((a, p) => a + missingRates(p), 0), [included]);
  // Base-lock rate: typed value, else gold rate × ratio (EXP535 139.395, EXP615 135.176).
  const lockRatio = settings?.base_gold_lock_ratio ?? DEFAULT_BASE_GOLD_LOCK_RATIO;
  const autoBaseRate = isNum(form.gold_rate_usd_per_troy_oz) ? defaultBaseGoldRate(new Decimal(form.gold_rate_usd_per_troy_oz), lockRatio) : null;
  const baseRate: Decimal | null = isNum(form.base_gold_rate_usd_per_gm) ? new Decimal(form.base_gold_rate_usd_per_gm) : autoBaseRate;
  const liveFormErrors = useMemo(() => validateForm(form), [form]);
  const tooBig = packFiles.some((f) => f.size > MAX_FILE_BYTES);

  const go = useCallback((s: Step) => { setView("wizard"); setStep(s); }, []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, step]);

  // Any edit after a preview invalidates it
  const invalidate = useCallback(() => { setReport(null); setLots([]); setTotals(null); setResult(null); }, []);

  function setMainFile(f: File | null) {
    setMainFileState(f);
    setMainSummary(null);
  }

  /** Main WS rows for the chosen file (parsed once per file). */
  async function loadMainRows(file: File): Promise<MainWsRow[]> {
    if (mainRows?.file === file) return mainRows.rows;
    if (file.size > MAX_MAIN_BYTES) throw new Error(`${file.name} is over 60 MB. Download just the Main WS tab as .csv instead.`);
    const rows = await parseMainWs(file, file.name);
    setMainRows({ file, rows });
    return rows;
  }

  /** Fill empty certificate / grade cells from Main WS; pick the buyer when every piece ships to one account. */
  async function fillFromMain(ps: Piece[], file: File): Promise<Piece[]> {
    const rows = await loadMainRows(file);
    const { pieces: filled, summary } = applyMainWs(ps, rows);
    setMainSummary(summary);
    const bs = buyers.length ? buyers : await fetchAllBuyers().catch(() => [] as Buyer[]);
    if (!buyers.length) setBuyers(bs);
    const hint = suggestBuyer(filled, bs);
    if (hint?.unanimous && hint.buyer) {
      const id = hint.buyer.id;
      setForm((f) => (f.buyer_id ? f : { ...f, buyer_id: id }));
    }
    toast.success("Main File matched",
      `${summary.matched} of ${plural(ps.length, "piece")} found · ${plural(summary.certificates, "certificate")} and ${plural(summary.grades, "grade")} filled.`);
    return filled;
  }

  async function onParse() {
    if (!packFiles.length || tooBig) return;
    setParseBusy(true);
    try {
      const { pieces: parsed, duplicates } = await parsePackingLists(packFiles.map((f) => ({ file: f, name: f.name })));
      toast.success("Packing list read", `${plural(parsed.length, "piece")} from ${plural(packFiles.length, "file")}.`);
      if (duplicates.length) toast.info("Duplicates skipped", `${plural(duplicates.length, "stock no.", "stock nos.")} appeared twice: ${duplicates.slice(0, 5).join(", ")}${duplicates.length > 5 ? "…" : ""}`);
      let ps = parsed;
      if (mainFile) {
        try { ps = await fillFromMain(parsed, mainFile); }
        catch (e) { setMainSummary(null); errToast(e, "Couldn't read the Main File — carrying on without it"); }
      }
      setPieces(ps); setExcluded(new Set()); invalidate(); setPieceVersion((v) => v + 1);
      const noLabour = ps.filter((p) => !p.labour_rate_inr_per_gm).length;
      if (noLabour) toast.info("Labour from Settings", `${plural(noLabour, "piece")} had no Labour value on the sheet — the Settings rate for its KT is used.`);
      go("pieces");
    } catch (e) {
      errToast(e, "Couldn't read the file");
    } finally {
      setParseBusy(false);
    }
  }

  /** Main File added after the packing list was read: fill without re-reading (keeps typed rates). */
  async function onApplyMain() {
    if (!mainFile || !pieces.length) return;
    setMainBusy(true);
    try {
      const filled = await fillFromMain(pieces, mainFile);
      setPieces(filled); invalidate(); setPieceVersion((v) => v + 1);
      go("pieces");
    } catch (e) {
      errToast(e, "Couldn't read the Main File");
    } finally {
      setMainBusy(false);
    }
  }

  // ── piece edits ──
  function patchPiece(stock: string, f: (p: Piece) => Piece) {
    setPieces((prev) => prev.map((p) => (p.stock_no === stock ? f(p) : p)));
    invalidate();
  }
  function updateDiamond(stock: string, idx: number, patch: DiamondPatch) {
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
      toast.info("Filled from the stones register", `${hit.certificate_no}: ${[hit.lab_origin, hit.color_clarity, hit.last_rate_usd_per_ct ? `$${hit.last_rate_usd_per_ct}/ct` : null].filter(Boolean).join(" · ")}`);
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
    if (!settings || !hsnTable) { toast.warn("Settings are still loading", "Try again in a moment."); return; }
    if (!included.length) { toast.warn("No pieces selected", "Include at least one piece on the Pieces step."); return; }
    const errs = validateForm(form);
    setShowErrors(Object.keys(errs).length > 0);
    if (Object.keys(errs).length) {
      toast.warn("Some details are missing", `${plural(Object.keys(errs).length, "field")} need attention.`);
      go("details"); window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
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
          labor_rates: laborRates,
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
        toast.error("Generation is blocked", `${plural(rep.findings.filter((f) => f.severity === "hard" && !f.passed).length, "check")} failed — see Review.`);
      } else {
        toast.success("Totals ready", `C&F ${fmtUsd(usd)}`);
      }
      go("review");
    } catch (e) {
      errToast(e, "Couldn't calculate the totals");
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
      setResult({ invoice_id: saved.invoice_id, replaced: saved.replaced, fileName: genName, blob });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = genName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      toast.success(saved.replaced ? "Invoice re-generated" : "Invoice generated", genName);
    } catch (e) {
      errToast(e, "Generation failed");
    } finally {
      setGenerateBusy(false);
    }
  }

  function startNew() {
    setPieces([]); setExcluded(new Set()); setPackFiles([]);
    setMainSummary(null);   // the Main File stays picked — it serves the next shipment too
    setForm(initialForm());
    setShowErrors(false); setLedger(null);
    setLots([]); setTotals(null); setReport(null); setResult(null);
    setConfirmReset(false);
    go("upload");
  }

  // ── step availability + labels ──
  const blocked = report ? isBlocked(report) : true;
  const stepViews: StepView[] = STEPS.map(({ key, label }) => {
    switch (key) {
      case "upload": return { key, label, done: pieces.length > 0, enabled: true,
        meta: pieces.length ? plural(packFiles.length || 1, "file") : "Packing list" };
      case "pieces": return { key, label, done: included.length > 0 && ratesMissing === 0, enabled: pieces.length > 0,
        meta: pieces.length ? (ratesMissing ? `${plural(ratesMissing, "rate")} missing` : `${included.length} of ${pieces.length}`) : "Rates & certs",
        warn: pieces.length > 0 && ratesMissing > 0 };
      case "details": {
        const n = Object.keys(liveFormErrors).length;
        return { key, label, done: n === 0, enabled: pieces.length > 0, meta: n ? `${n} to fill` : "Complete" };
      }
      case "review": return { key, label, done: !!report && !blocked, enabled: lots.length > 0,
        meta: totals ? fmtUsd(totals.usd) : "Totals & checks", warn: !!report && blocked };
      case "generate": return { key, label, done: !!result, enabled: !!report && !blocked,
        meta: result ? "Saved" : "Excel + save" };
    }
  });
  const stepIdx = STEPS.findIndex((s) => s.key === step);
  const prevStep = stepIdx > 0 ? STEPS[stepIdx - 1].key : null;

  // ── keyboard: Ctrl/Cmd + Enter advances ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.ctrlKey || e.metaKey) && e.key === "Enter") || view !== "wizard") return;
      if (step === "upload" && packFiles.length && !parseBusy) { e.preventDefault(); onParse(); }
      else if (step === "pieces" && included.length) { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); go("details"); }
      else if (step === "details" && !previewBusy) { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); doPreview(); }
      else if (step === "review" && report && !blocked) { e.preventDefault(); go("generate"); }
      else if (step === "generate" && !generateBusy && !result) { e.preventDefault(); doGenerate(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ────────── blocking screens ──────────

  if (envMissing) {
    return (
      <div className="blocking">
        <Card icon={Database} title="Supabase is not configured" desc="This build has no Supabase project URL or anon key.">
          <div className="stack">
            <p>For local development, open <code>.env</code>, set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>
              {" "}(Supabase → Project Settings → API), then restart <code>npm run dev</code>.</p>
            <p>On Netlify, set the same two variables under Site settings → Environment variables and redeploy.</p>
            <p className="hint-small">Never use the <code>service_role</code> key here.</p>
          </div>
        </Card>
      </div>
    );
  }
  if (authLoading) return <div className="center-load"><Spinner /></div>;
  if (!user) {
    return (
      <div className="auth">
        <section className="auth-brand">
          <div className="brand">
            <BrandMark />
            <div><div className="brand-name">DIACROWN</div><div className="brand-sub">Export invoices</div></div>
          </div>
          <div>
            <h1>Export invoices, <em>without the retyping.</em></h1>
            <p className="lede">Turn Swan&apos;s packing list into the MASTER DETAILS workbook — invoice and customs packing list — ready for the shipping bill.</p>
          </div>
          <ul className="auth-points">
            <li><FileSpreadsheet size={18} />Reads the Packing List sheet; you add the stone rates, buyer and gold.</li>
            <li><ShieldCheck size={18} />Checks weights, wastage, value addition and HSN before anything is saved.</li>
            <li><History size={18} />Keeps every invoice, gold drawdown and certified stone for the next shipment.</li>
          </ul>
          <svg className="auth-facets" viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <path d="M30 72 66 32h68l36 40-70 104Z" /><path d="M30 72h140" /><path d="m66 32 18 40 16-40 16 40 18-40" />
            <path d="m84 72 16 104 16-104" />
          </svg>
        </section>
        <div className="auth-side">
          <div className="auth-card">
            <div className="brand auth-mark"><BrandMark size={30} /><div className="brand-name">DIACROWN</div></div>
            <h2>Sign in</h2>
            <p className="page-sub">Use your DIACROWN accounts login.</p>
            <form onSubmit={signIn}>
              <Field label="Email"><input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required autoComplete="username" autoFocus /></Field>
              <Field label="Password"><input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required autoComplete="current-password" /></Field>
              <button className="btn primary big" type="submit" disabled={signInBusy}>{signInBusy ? <><Spinner /> Signing in…</> : "Sign in"}</button>
            </form>
            <p className="hint-small" style={{ marginTop: 16 }}>No account yet? An admin adds you in Supabase with the <code>accounts</code> role.</p>
          </div>
        </div>
      </div>
    );
  }

  // ────────── wizard action bar ──────────

  const back = prevStep && (
    <button className="btn" onClick={() => go(prevStep)}><ArrowLeft size={16} /> Back</button>
  );
  const piecesStat = pieces.length > 0 && <Stat label={`of ${pieces.length} pieces on invoice`} value={included.length} />;
  const ratesStat = pieces.length > 0 && (ratesMissing
    ? <Stat tone="warn" label={ratesMissing === 1 ? "rate missing" : "rates missing"} value={ratesMissing} />
    : <Stat tone="ok" label="all rates in" value="✓" />);

  let actionBar: React.ReactNode = null;
  if (step === "upload") {
    actionBar = (
      <ActionBar stats={packFiles.length ? <Stat label={packFiles.length === 1 ? "file selected" : "files selected"} value={packFiles.length} /> : <span>Pick the SDJ-JB file to start</span>}>
        <button className="btn primary" disabled={!packFiles.length || parseBusy || tooBig} onClick={onParse}>
          {parseBusy ? <><Spinner /> Reading…</> : <><FileSearch size={16} /> Read packing list <Kbd /></>}
        </button>
      </ActionBar>
    );
  } else if (step === "pieces") {
    actionBar = (
      <ActionBar stats={<>{piecesStat}{ratesStat}</>}>
        {back}
        <button className="btn primary" onClick={() => go("details")} disabled={!included.length}>Continue <ArrowRight size={16} /> <Kbd /></button>
      </ActionBar>
    );
  } else if (step === "details") {
    actionBar = (
      <ActionBar stats={<>{piecesStat}{ratesStat}</>}>
        {back}
        <button className="btn primary" onClick={doPreview} disabled={previewBusy}>
          {previewBusy ? <><Spinner /> Calculating…</> : <><Calculator size={16} /> Preview totals <Kbd /></>}
        </button>
      </ActionBar>
    );
  } else if (step === "review") {
    actionBar = (
      <ActionBar stats={totals && <><Stat label="C&F" value={fmtUsd(totals.usd)} /><Stat label={lots.length === 1 ? "lot" : "lots"} value={lots.length} /></>}>
        {back}
        <button className="btn primary" onClick={() => go("generate")} disabled={blocked}>
          {blocked ? "Fix the problems first" : <>Continue <ArrowRight size={16} /> <Kbd /></>}
        </button>
      </ActionBar>
    );
  } else if (step === "generate" && !result) {
    actionBar = (
      <ActionBar stats={totals && <><Stat label="C&F" value={fmtUsd(totals.usd)} /><Stat label={included.length === 1 ? "piece" : "pieces"} value={included.length} /></>}>
        {back}
        <button className="btn primary" onClick={doGenerate} disabled={generateBusy}>
          {generateBusy ? <><Spinner /> Generating…</> : <><FileSpreadsheet size={16} /> Generate invoice <Kbd /></>}
        </button>
      </ActionBar>
    );
  }

  const invoiceTitle = form.invoice_number.trim().toUpperCase() || (pieces.length ? "Untitled invoice" : "New invoice");

  return (
    <div className="app">
      <Sidebar
        view={view} onNavigate={setView}
        draftMeta={pieces.length ? `${stepIdx + 1}/${STEPS.length}` : null}
        email={user.email} canEdit={canEdit} configLoading={configLoading}
        onSignOut={() => supabase.auth.signOut()}
      />
      <main className="main">
        <div className="page">
          {view === "invoices" && (
            <Dashboard canEdit={canEdit} hasDraft={pieces.length > 0} onNew={() => (pieces.length ? setView("wizard") : startNew())} />
          )}

          {view === "settings" && (
            <Settings canEdit={canEdit} onSaved={() => { setConfigVersion((v) => v + 1); invalidate(); }} />
          )}

          {view === "wizard" && (
            <>
              <div className="page-head">
                <div>
                  <h1 className="page-title">{invoiceTitle}<span className="tag">Step {stepIdx + 1} of {STEPS.length}</span></h1>
                  <p className="page-sub">{STEP_SUB[step]}</p>
                </div>
                {pieces.length > 0 && (
                  <div className="page-actions">
                    <button className="btn ghost small" onClick={() => setConfirmReset(true)}><RotateCcw size={15} /> Start over</button>
                  </div>
                )}
              </div>
              <Stepper steps={stepViews} current={step} onPick={go} />

              {step === "upload" && (
                <UploadStep files={packFiles} setFiles={setPackFiles} parsedCount={pieces.length}
                            mainFile={mainFile} setMainFile={setMainFile} mainSummary={mainSummary}
                            mainBusy={mainBusy} onApplyMain={onApplyMain} />
              )}
              {step === "pieces" && (
                <PiecesStep
                  pieces={pieces} excluded={excluded} version={pieceVersion} mainSummary={mainSummary}
                  settings={settings} baseRate={baseRate} laborRates={laborRates} roundAr={form.round_base_lock_2dp}
                  toggleInclude={toggleInclude} setAllIncluded={setAllIncluded}
                  updateDiamond={updateDiamond} splitDiamond={splitDiamond} removeDiamond={removeDiamond}
                  onCertBlur={onCertBlur} updatePieceTuning={updatePieceTuning}
                />
              )}
              {step === "details" && (
                <DetailsStep form={form} setForm={(f) => { setForm(f); invalidate(); }} errors={showErrors ? liveFormErrors : NO_ERRORS}
                             settings={settings} autoBaseRate={autoBaseRate} lockRatio={lockRatio} buyerHint={buyerHint} />
              )}
              {step === "review" && <ReviewStep lots={lots} totals={totals} report={report} ledger={ledger} inrRate={form.inr_usd_rate} />}
              {step === "generate" && (
                <GenerateStep result={result} canEdit={canEdit} invoiceNumber={form.invoice_number.trim().toUpperCase()}
                              onNewInvoice={startNew} onViewInvoices={() => setView("invoices")} />
              )}

              <div className="page-spacer" />
              {actionBar}
            </>
          )}
        </div>
      </main>

      <ConfirmDialog open={confirmReset} icon={RotateCcw} title="Start a new invoice?"
                     body="This clears the loaded pieces, the rates you typed and the details form. Saved invoices are not affected."
                     confirmLabel="Start over" danger onConfirm={startNew} onCancel={() => setConfirmReset(false)} />
    </div>
  );
}
