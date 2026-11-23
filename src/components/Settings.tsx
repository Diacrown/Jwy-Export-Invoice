/** Settings tab — in-UI editor for `app_settings`, `hsn_table` and `labor_rates`.
 *
 * `canEdit` only shapes the UI; RLS enforces the same accounts/admin rule on
 * the server. Every number is validated client-side before it is sent, and
 * each section saves independently.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, HsnEntry, JewelleryType } from "../types";
import {
  loadAppSettings, saveAppSettings,
  loadHsnTable, saveHsnEntry,
  loadLaborRates, saveLaborRate,
} from "../storage/settings";
import { useErrorToast, useToast } from "./Toast";
import { Empty, SkelRows } from "./Skeleton";

// ───────────────────────── parsing + validation helpers ─────────────────────────

const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
/** KT keys as used across the app: '9', '14', '18', '18-PD'. */
const KT_KEY = /^\d{1,2}(-[A-Z0-9]+)*$/;
const KT_KEY_MSG = "Use the KT number, optionally with a suffix, e.g. 18 or 18-PD";

/** Finite number from plain decimal notation; null for blank / garbage. */
function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (!PLAIN_DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function decimalPlaces(raw: string): number {
  const t = raw.trim();
  const i = t.indexOf(".");
  return i < 0 ? 0 : t.length - i - 1;
}

/** A decimal fraction in (0, 1] — wastage, value addition, touch. */
function fractionError(raw: string, dp?: number): string | null {
  const n = parseNum(raw);
  if (n === null) return "Enter a decimal, e.g. 0.04";
  if (!(n > 0 && n <= 1)) return "Must be more than 0 and at most 1 (0.04 = 4%)";
  if (dp !== undefined && decimalPlaces(raw) > dp) return `At most ${dp} decimal places`;
  return null;
}

function positiveError(raw: string, dp: number, example: string): string | null {
  const n = parseNum(raw);
  if (n === null) return `Enter a number, e.g. ${example}`;
  if (!(n > 0)) return "Must be greater than 0";
  if (decimalPlaces(raw) > dp) return `At most ${dp} decimal places`;
  return null;
}

function slashDateError(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return "Use dd/mm/yyyy";
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "Not a real date";
  return null;
}

/** "0.0225" → "2.25%"; blank for anything unparseable. */
function pctLabel(raw: string): string {
  const n = parseNum(raw);
  return n === null ? "" : `${+(n * 100).toFixed(3)}%`;
}

function byKt(a: string, b: string): number {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

/** Supabase errors are plain objects; give the toast a readable message. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const msg = (e as { message?: string } | null)?.message;
  return new Error(msg ?? String(e));
}

function SaveLabel({ busy, text }: { busy: boolean; text: string }) {
  return busy ? <><span className="spinner" /> Saving…</> : <>{text}</>;
}

// ───────────────────────── section 1: app_settings field specs ─────────────────────────

type ListKey = "payment_instructions" | "declarations";
type ScalarKey = Exclude<keyof AppSettings, ListKey | "kt_touch" | "base_gold_lock_ratio">;
type AppKey = ScalarKey | ListKey;
type AppDraft = Record<AppKey, string>;
type FieldKind = "text" | "textarea" | "int" | "money" | "fraction" | "date" | "list";

interface FieldSpec { key: AppKey; label: string; kind: FieldKind; required?: boolean; placeholder?: string }

const APP_FIELDS: FieldSpec[] = [
  { key: "exporter_name", label: "Exporter name", kind: "text", required: true },
  { key: "iec_no", label: "IEC no.", kind: "text", required: true },
  { key: "pan", label: "PAN", kind: "text", required: true },
  { key: "gstin", label: "GSTIN", kind: "text", required: true },
  { key: "exporter_address", label: "Exporter address", kind: "textarea", required: true },
  { key: "state_code", label: "State code", kind: "int", required: true, placeholder: "27" },
  { key: "state_name", label: "State name", kind: "text", required: true },
  { key: "district_code", label: "District code", kind: "int", required: true, placeholder: "483" },
  { key: "district_name", label: "District name", kind: "text", required: true },
  { key: "signatory_block_1", label: "Signatory block 1", kind: "text", required: true },
  { key: "signatory_block_2", label: "Signatory block 2", kind: "text", required: true },
  { key: "signatory_name", label: "Signatory name", kind: "text", required: true },
  { key: "lut_arn_number", label: "LUT ARN number", kind: "text", required: true },
  { key: "lut_arn_date", label: "LUT ARN date", kind: "date", required: true, placeholder: "dd/mm/yyyy" },
  { key: "insurance_wording", label: "Insurance wording", kind: "text", required: true },
  { key: "container_prefix", label: "Container prefix", kind: "text", required: true, placeholder: "CONTAINER N0." },
  { key: "tin_box_text", label: "Tin box text", kind: "text", required: true, placeholder: "THREE INVOICES IN 1 TIN BOX" },
  { key: "handcrafted_text", label: "Handcrafted text", kind: "text", required: true, placeholder: "HANDCRAFTED" },
  { key: "mfg_fixed_addon_usd", label: "MFG fixed add-on USD (AZ)", kind: "money", required: true, placeholder: "10" },
  { key: "default_wastage_pct", label: "Default wastage (decimal)", kind: "fraction", required: true, placeholder: "0.04" },
  { key: "payment_instructions", label: "Payment instructions (one per line)", kind: "list" },
  { key: "declarations", label: "Declarations (one per line)", kind: "list" },
];

function toAppDraft(s: AppSettings): AppDraft {
  const d = {} as AppDraft;
  for (const f of APP_FIELDS) {
    const v = s[f.key];
    d[f.key] = Array.isArray(v) ? v.join("\n") : String(v ?? "");
  }
  return d;
}

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

type Parsed = { value: string | number | string[] } | { error: string };

function parseAppField(f: FieldSpec, raw: string): Parsed {
  const t = raw.trim();
  if (f.kind === "list") return { value: splitLines(raw) };
  if (f.required && t === "") return { error: "Required" };
  switch (f.kind) {
    case "int": {
      const n = parseNum(t);
      if (n === null || !Number.isInteger(n) || n < 0) return { error: "Enter a whole number" };
      return { value: n };
    }
    case "money": {
      const n = parseNum(t);
      if (n === null) return { error: "Enter a number, e.g. 10" };
      if (n < 0) return { error: "Cannot be negative" };
      if (decimalPlaces(t) > 2) return { error: "At most 2 decimal places" };
      return { value: n };
    }
    case "fraction": {
      const err = fractionError(t, 4);
      return err ? { error: err } : { value: parseNum(t)! };
    }
    case "date": {
      const err = slashDateError(t);
      return err ? { error: err } : { value: t };
    }
    default:
      return { value: t };
  }
}

// ───────────────────────── section 2: kt_touch rows ─────────────────────────

interface TouchRow { id: number; kt: string; factor: string }
interface TouchErrors { rate?: string; general?: string; rows: Record<number, { kt?: string; factor?: string }> }

let rowSeq = 0;
function touchRowsFrom(rec: Record<string, number>): TouchRow[] {
  return Object.keys(rec).sort(byKt).map((kt) => ({ id: ++rowSeq, kt, factor: String(rec[kt]) }));
}
function touchSig(rate: string, rows: TouchRow[]): string {
  return JSON.stringify([rate, rows.map((r) => [r.kt, r.factor])]);
}

// ───────────────────────── section 3: HSN ─────────────────────────

const HSN_ORDER: JewelleryType[] = [
  "gold_plain", "gold_mounting", "gold_studded_diamond", "gold_studded_lgd", "gold_studded_colorstone",
];
const HSN_LABEL: Record<JewelleryType, string> = {
  gold_plain: "Gold plain",
  gold_mounting: "Mounting",
  gold_studded_diamond: "Studded — diamond",
  gold_studded_lgd: "Studded — lab-grown",
  gold_studded_colorstone: "Studded — colour stone",
};

type HsnField = "code" | "description_tail" | "max_wastage_handcrafted" | "min_value_addition";
type HsnDraft = Record<HsnField, string>;
type HsnErrors = Partial<Record<HsnField, string>>;

function toHsnDraft(e: HsnEntry): HsnDraft {
  return {
    code: e.code,
    description_tail: e.description_tail,
    max_wastage_handcrafted: String(e.max_wastage_handcrafted),
    min_value_addition: String(e.min_value_addition),
  };
}

// ───────────────────────── component ─────────────────────────

export function Settings(props: { canEdit: boolean; onSaved: () => void }): JSX.Element {
  const { canEdit, onSaved } = props;
  const toast = useToast();
  const errToast = useErrorToast();
  // The toast API object is rebuilt on every provider render; keep the load
  // effect from re-running (and refetching) each time a toast appears.
  const errToastRef = useRef(errToast);
  errToastRef.current = errToast;

  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  // app_settings
  const [appBase, setAppBase] = useState<AppSettings | null>(null);
  const [appDraft, setAppDraft] = useState<AppDraft | null>(null);
  const [appErrors, setAppErrors] = useState<Partial<Record<AppKey, string>>>({});

  // base-gold lock (also app_settings)
  const [rateDraft, setRateDraft] = useState("");
  const [touchRows, setTouchRows] = useState<TouchRow[]>([]);
  const [touchErrors, setTouchErrors] = useState<TouchErrors>({ rows: {} });

  // hsn_table
  const [hsnBase, setHsnBase] = useState<Partial<Record<JewelleryType, HsnEntry>>>({});
  const [hsnDraft, setHsnDraft] = useState<Partial<Record<JewelleryType, HsnDraft>>>({});
  const [hsnErrors, setHsnErrors] = useState<Partial<Record<JewelleryType, HsnErrors>>>({});

  // labor_rates
  const [laborBase, setLaborBase] = useState<Record<string, number>>({});
  const [laborDraft, setLaborDraft] = useState<Record<string, string>>({});
  const [laborErrors, setLaborErrors] = useState<Record<string, string>>({});
  const [newLabor, setNewLabor] = useState({ kt: "", rate: "" });
  const [newLaborErrors, setNewLaborErrors] = useState<{ kt?: string; rate?: string }>({});

  useEffect(() => {
    let active = true;
    setStatus("loading");
    Promise.all([loadAppSettings(), loadHsnTable(), loadLaborRates()])
      .then(([app, hsn, labor]) => {
        if (!active) return;
        setAppBase(app);
        setAppDraft(toAppDraft(app));
        setAppErrors({});
        setRateDraft(String(app.base_gold_lock_ratio));
        setTouchRows(touchRowsFrom(app.kt_touch));
        setTouchErrors({ rows: {} });
        const hsnPartial = hsn as Partial<Record<JewelleryType, HsnEntry>>;
        setHsnBase(hsnPartial);
        const hd: Partial<Record<JewelleryType, HsnDraft>> = {};
        for (const [t, e] of Object.entries(hsnPartial)) if (e) hd[t as JewelleryType] = toHsnDraft(e);
        setHsnDraft(hd);
        setHsnErrors({});
        setLaborBase(labor);
        setLaborDraft(Object.fromEntries(Object.entries(labor).map(([k, v]) => [k, String(v)])));
        setLaborErrors({});
        setStatus("ready");
      })
      .catch((e) => {
        if (!active) return;
        errToastRef.current(asError(e), "Could not load settings");
        setStatus("error");
      });
    return () => { active = false; };
  }, [reloadKey]);

  const appBaseDraft = useMemo(() => (appBase ? toAppDraft(appBase) : null), [appBase]);
  const touchBaseSig = useMemo(
    () => (appBase ? touchSig(String(appBase.base_gold_lock_ratio), touchRowsFrom(appBase.kt_touch)) : ""),
    [appBase],
  );

  if (status === "loading") {
    return (
      <div>
        <h2>Settings</h2>
        <div className="table-wrap"><SkelRows count={6} /></div>
      </div>
    );
  }
  if (status === "error" || !appBase || !appDraft || !appBaseDraft) {
    return (
      <div>
        <h2>Settings</h2>
        <Empty
          title="Could not load settings"
          body="Check your connection, then try again."
          action={<button className="btn" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>}
        />
      </div>
    );
  }

  const locked = !canEdit;
  const anyBusy = busy !== null;

  // ─────────── section 1: exporter & invoice defaults ───────────

  const appChanged = APP_FIELDS.filter((f) => appDraft[f.key] !== appBaseDraft[f.key]);

  function editApp(k: AppKey, v: string) {
    setAppDraft((d) => (d ? { ...d, [k]: v } : d));
    setAppErrors((e) => omit(e, k));
  }

  async function saveApp() {
    if (!appBase || !appDraft || !appBaseDraft) return;
    const errs: Partial<Record<AppKey, string>> = {};
    const patch: Record<string, unknown> = {};
    for (const f of APP_FIELDS) {
      if (appDraft[f.key] === appBaseDraft[f.key]) continue;
      const r = parseAppField(f, appDraft[f.key]);
      if ("error" in r) { errs[f.key] = r.error; continue; }
      if (JSON.stringify(r.value) !== JSON.stringify(appBase[f.key])) patch[f.key] = r.value;
    }
    setAppErrors(errs);
    const nErr = Object.keys(errs).length;
    if (nErr) {
      toast.warn("Fix the highlighted fields", `${nErr} field${nErr === 1 ? "" : "s"} in Exporter & invoice defaults.`);
      return;
    }
    const keys = Object.keys(patch);
    if (!keys.length) {
      setAppDraft(appBaseDraft); // only whitespace changed
      toast.info("Nothing to save", "No values changed.");
      return;
    }
    setBusy("app");
    try {
      await saveAppSettings(patch as Partial<AppSettings>);
      const next = { ...appBase, ...(patch as Partial<AppSettings>) };
      setAppBase(next);
      setAppDraft(toAppDraft(next));
      toast.success("Exporter settings saved", `${keys.length} field${keys.length === 1 ? "" : "s"} updated.`);
      onSaved();
    } catch (e) {
      errToast(asError(e), "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function renderAppField(f: FieldSpec) {
    const raw = appDraft![f.key];
    const err = appErrors[f.key];
    const cls = err ? "invalid" : undefined;
    const wide = f.kind === "textarea" || f.kind === "list";
    let control: JSX.Element;
    if (wide) {
      control = (
        <textarea className={cls} rows={f.kind === "list" ? 5 : 3} value={raw} disabled={locked}
                  onChange={(e) => editApp(f.key, e.target.value)} />
      );
    } else if (f.kind === "fraction") {
      control = (
        <div className="settings-inline">
          <input className={cls} value={raw} inputMode="decimal" placeholder={f.placeholder} disabled={locked}
                 onChange={(e) => editApp(f.key, e.target.value)} />
          <span className="muted">{pctLabel(raw)}</span>
        </div>
      );
    } else {
      control = (
        <input className={cls} value={raw} placeholder={f.placeholder} disabled={locked}
               inputMode={f.kind === "int" ? "numeric" : f.kind === "money" ? "decimal" : undefined}
               onChange={(e) => editApp(f.key, e.target.value)} />
      );
    }
    return (
      <label key={f.key} className={wide ? "settings-wide" : undefined}>
        {f.label}{f.required ? " *" : ""}
        {control}
        {f.kind === "list" && (
          <div className="hint-small">{splitLines(raw).length} line(s) — blank lines are dropped</div>
        )}
        <div className="err">{err ?? ""}</div>
      </label>
    );
  }

  // ─────────── section 2: base-gold lock ───────────

  const touchDirty = touchSig(rateDraft, touchRows) !== touchBaseSig;

  function editTouch(id: number, patch: Partial<Omit<TouchRow, "id">>) {
    setTouchRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setTouchErrors((e) => {
      const row = e.rows[id];
      if (!row) return e;
      const nextRow = { ...row };
      for (const k of Object.keys(patch) as (keyof typeof nextRow)[]) delete nextRow[k];
      return { ...e, general: undefined, rows: { ...e.rows, [id]: nextRow } };
    });
  }

  function discardTouch() {
    if (!appBase) return;
    setRateDraft(String(appBase.base_gold_lock_ratio));
    setTouchRows(touchRowsFrom(appBase.kt_touch));
    setTouchErrors({ rows: {} });
  }

  async function saveTouch() {
    const errs: TouchErrors = { rows: {} };
    const rateErr = positiveError(rateDraft, 8, "0.0321199");
    if (rateErr) errs.rate = rateErr;
    if (!touchRows.length) errs.general = "Add at least one KT.";
    const seen = new Set<string>();
    const kt_touch: Record<string, number> = {};
    for (const r of touchRows) {
      const rowErr: { kt?: string; factor?: string } = {};
      const kt = r.kt.trim().toUpperCase();
      if (!kt) rowErr.kt = "Required";
      else if (!KT_KEY.test(kt)) rowErr.kt = KT_KEY_MSG;
      else if (seen.has(kt)) rowErr.kt = "Duplicate KT";
      seen.add(kt);
      const fErr = fractionError(r.factor, 6);
      if (fErr) rowErr.factor = fErr;
      if (rowErr.kt || rowErr.factor) errs.rows[r.id] = rowErr;
      else kt_touch[kt] = parseNum(r.factor)!;
    }
    setTouchErrors(errs);
    if (errs.rate || errs.general || Object.keys(errs.rows).length) {
      toast.warn("Fix the highlighted fields", "Base-gold lock was not saved.");
      return;
    }
    const base_gold_lock_ratio = parseNum(rateDraft)!;
    setBusy("touch");
    try {
      await saveAppSettings({ kt_touch, base_gold_lock_ratio });
      setAppBase((prev) => (prev ? { ...prev, kt_touch, base_gold_lock_ratio } : prev));
      setRateDraft(String(base_gold_lock_ratio));
      setTouchRows(touchRowsFrom(kt_touch));
      toast.success("Base-gold lock saved", `ratio ${base_gold_lock_ratio} · ${Object.keys(kt_touch).length} KT factors.`);
      onSaved();
    } catch (e) {
      errToast(asError(e), "Save failed");
    } finally {
      setBusy(null);
    }
  }

  // Live worked example so the clerk can sanity-check the numbers.
  const exRow = touchRows.find((r) => r.kt.trim() === "18") ?? touchRows[0];
  const exTouch = exRow ? parseNum(exRow.factor) : null;
  const exRatio = parseNum(rateDraft);
  const exRate = exRatio !== null ? Math.round(4208.4878 * exRatio * 1000) / 1000 : null;
  const example = exRow && exTouch !== null && exRate !== null
    ? `Example at gold 4208.4878 USD/oz: base rate = ${exRate} USD/g; 10.00 g net of ${exRow.kt.trim()}K → 10.00 × ${exTouch} × ${exRate} = ${(10 * exTouch * exRate).toFixed(2)} USD`
    : null;

  // ─────────── section 3: HSN ───────────

  const hsnTypes: JewelleryType[] = [
    ...HSN_ORDER.filter((t) => hsnDraft[t]),
    ...(Object.keys(hsnDraft) as JewelleryType[]).filter((t) => !HSN_ORDER.includes(t)),
  ];

  function editHsn(t: JewelleryType, k: HsnField, v: string) {
    setHsnDraft((d) => {
      const row = d[t];
      return row ? { ...d, [t]: { ...row, [k]: v } } : d;
    });
    setHsnErrors((e) => (e[t] ? { ...e, [t]: omit(e[t]!, k) } : e));
  }

  function hsnDirty(t: JewelleryType): boolean {
    const d = hsnDraft[t], b = hsnBase[t];
    if (!d || !b) return false;
    const bd = toHsnDraft(b);
    return (Object.keys(bd) as HsnField[]).some((k) => bd[k] !== d[k]);
  }

  async function saveHsn(t: JewelleryType) {
    const d = hsnDraft[t];
    if (!d) return;
    const errs: HsnErrors = {};
    const code = d.code.trim();
    if (!/^\d{8}$/.test(code)) errs.code = "HSN code must be 8 digits";
    const description_tail = d.description_tail.trim();
    if (!description_tail) errs.description_tail = "Required";
    const wErr = fractionError(d.max_wastage_handcrafted, 4);
    if (wErr) errs.max_wastage_handcrafted = wErr;
    const vErr = fractionError(d.min_value_addition, 4);
    if (vErr) errs.min_value_addition = vErr;
    setHsnErrors((e) => ({ ...e, [t]: errs }));
    if (Object.keys(errs).length) {
      toast.warn("Fix the highlighted fields", `${HSN_LABEL[t] ?? t} was not saved.`);
      return;
    }
    const entry: HsnEntry = {
      jewellery_type: t,
      code,
      description_tail,
      max_wastage_handcrafted: parseNum(d.max_wastage_handcrafted)!,
      min_value_addition: parseNum(d.min_value_addition)!,
    };
    setBusy(`hsn:${t}`);
    try {
      await saveHsnEntry(entry);
      setHsnBase((b) => ({ ...b, [t]: entry }));
      setHsnDraft((dd) => ({ ...dd, [t]: toHsnDraft(entry) }));
      toast.success("HSN saved", `${HSN_LABEL[t] ?? t} · ${code}`);
      onSaved();
    } catch (e) {
      errToast(asError(e), "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function hsnCell(t: JewelleryType, k: HsnField, label: string, opts: { pct?: boolean; wide?: boolean; numeric?: boolean } = {}) {
    const raw = hsnDraft[t]![k];
    const err = hsnErrors[t]?.[k];
    const input = (
      <input className={[err ? "invalid" : "", opts.wide ? "settings-desc" : ""].join(" ").trim() || undefined}
             value={raw} disabled={locked}
             inputMode={opts.pct ? "decimal" : opts.numeric ? "numeric" : undefined}
             onChange={(e) => editHsn(t, k, e.target.value)} />
    );
    return (
      <td data-label={label}>
        <div>
          {opts.pct ? <div className="settings-inline">{input}<span className="muted">{pctLabel(raw)}</span></div> : input}
          {err && <div className="err">{err}</div>}
        </div>
      </td>
    );
  }

  // ─────────── section 4: labour rates ───────────

  const laborKts = Object.keys(laborDraft).sort(byKt);

  async function saveLabor(kt: string) {
    const raw = laborDraft[kt] ?? "";
    const err = positiveError(raw, 2, "1275");
    setLaborErrors((e) => (err ? { ...e, [kt]: err } : omit(e, kt)));
    if (err) return;
    const rate = parseNum(raw)!;
    setBusy(`labor:${kt}`);
    try {
      await saveLaborRate(kt, rate);
      setLaborBase((b) => ({ ...b, [kt]: rate }));
      setLaborDraft((d) => ({ ...d, [kt]: String(rate) }));
      toast.success("Labour rate saved", `${kt}K → ₹${rate}/g`);
      onSaved();
    } catch (e) {
      errToast(asError(e), "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function addLabor() {
    const kt = newLabor.kt.trim().toUpperCase();
    const errs: { kt?: string; rate?: string } = {};
    if (!kt) errs.kt = "Required";
    else if (!KT_KEY.test(kt)) errs.kt = KT_KEY_MSG;
    else if (Object.keys(laborBase).some((k) => k.toUpperCase() === kt)) errs.kt = "Already listed — edit that row";
    const rErr = positiveError(newLabor.rate, 2, "1275");
    if (rErr) errs.rate = rErr;
    setNewLaborErrors(errs);
    if (errs.kt || errs.rate) return;
    const rate = parseNum(newLabor.rate)!;
    setBusy("labor:new");
    try {
      await saveLaborRate(kt, rate);
      setLaborBase((b) => ({ ...b, [kt]: rate }));
      setLaborDraft((d) => ({ ...d, [kt]: String(rate) }));
      setNewLabor({ kt: "", rate: "" });
      toast.success("Labour rate added", `${kt}K → ₹${rate}/g`);
      onSaved();
    } catch (e) {
      errToast(asError(e), "Save failed");
    } finally {
      setBusy(null);
    }
  }

  // ─────────── render ───────────

  return (
    <div className="settings">
      <h2>Settings</h2>
      <p className="hint">Values here feed every new invoice. Saved invoices keep the values they were generated with.</p>
      {locked && (
        <div className="finding soft" style={{ marginBottom: 12 }}>
          Read-only. Only users with role <code>accounts</code> or <code>admin</code> can edit settings.
        </div>
      )}

      {/* 1 ── exporter & invoice defaults */}
      <h3 className="section">Exporter &amp; invoice defaults</h3>
      <div className="grid">{APP_FIELDS.map(renderAppField)}</div>
      {canEdit && (
        <div className="actions">
          <button className="btn primary" disabled={!appChanged.length || anyBusy} onClick={saveApp}>
            <SaveLabel busy={busy === "app"}
                       text={appChanged.length ? `Save exporter settings (${appChanged.length})` : "Save exporter settings"} />
          </button>
          <button className="btn" disabled={!appChanged.length || anyBusy}
                  onClick={() => { setAppDraft(appBaseDraft); setAppErrors({}); }}>
            Discard changes
          </button>
        </div>
      )}

      {/* 2 ── base-gold lock */}
      <h3 className="section">Base-gold lock (AR)</h3>
      <p className="hint">
        AR = round(SJ-50 net wt, 2) × touch[KT] × base rate (USD per gram of pure gold). The base rate
        defaults to gold rate (USD/oz) × this ratio, rounded to 3 dp — 0.0321199 reproduces EXP535
        (139.395 at 4339.8413) and EXP615 (135.176 at 4208.4878). Each invoice can still override it.
        Touch: 9 → 0.385, 14 → 0.595, 18 → 0.76.
      </p>
      <div className="grid">
        <label>Base-lock ratio (USD/g pure per USD/oz gold) *
          <input className={touchErrors.rate ? "invalid" : undefined} value={rateDraft} inputMode="decimal"
                 placeholder="0.0321199" disabled={locked}
                 onChange={(e) => { setRateDraft(e.target.value); setTouchErrors((x) => ({ ...x, rate: undefined })); }} />
          <div className="err">{touchErrors.rate ?? ""}</div>
        </label>
      </div>
      <div className="table-wrap cards settings-narrow">
        <table>
          <thead>
            <tr><th>KT</th><th>Touch factor</th>{canEdit && <th />}</tr>
          </thead>
          <tbody>
            {touchRows.map((r) => {
              const e = touchErrors.rows[r.id] ?? {};
              return (
                <tr key={r.id}>
                  <td data-label="KT">
                    <div>
                      <input className={e.kt ? "invalid" : undefined} value={r.kt} placeholder="18" disabled={locked}
                             onChange={(ev) => editTouch(r.id, { kt: ev.target.value })} />
                      {e.kt && <div className="err">{e.kt}</div>}
                    </div>
                  </td>
                  <td data-label="Touch">
                    <div>
                      <div className="settings-inline">
                        <input className={e.factor ? "invalid" : undefined} value={r.factor} inputMode="decimal"
                               placeholder="0.76" disabled={locked}
                               onChange={(ev) => editTouch(r.id, { factor: ev.target.value })} />
                        <span className="muted">{pctLabel(r.factor)}</span>
                      </div>
                      {e.factor && <div className="err">{e.factor}</div>}
                    </div>
                  </td>
                  {canEdit && (
                    <td data-label="">
                      <button className="btn small" disabled={anyBusy}
                              onClick={() => setTouchRows((rows) => rows.filter((x) => x.id !== r.id))}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {touchErrors.general && <div className="err">{touchErrors.general}</div>}
      {example && <p className="hint-small">{example}</p>}
      {canEdit && (
        <div className="actions">
          <button className="btn" disabled={anyBusy}
                  onClick={() => {
                    setTouchRows((rows) => [...rows, { id: ++rowSeq, kt: "", factor: "" }]);
                    setTouchErrors((x) => ({ ...x, general: undefined }));
                  }}>
            + Add KT
          </button>
          <button className="btn primary" disabled={!touchDirty || anyBusy} onClick={saveTouch}>
            <SaveLabel busy={busy === "touch"} text="Save base-gold lock" />
          </button>
          <button className="btn" disabled={!touchDirty || anyBusy} onClick={discardTouch}>Discard changes</button>
        </div>
      )}

      {/* 3 ── HSN */}
      <h3 className="section">HSN table</h3>
      <p className="hint">Wastage and value addition are decimals (0.04 = 4%).</p>
      {hsnTypes.length === 0 ? (
        <p className="hint">No HSN rows found — seed <code>hsn_table</code> from <code>supabase/schema.sql</code>.</p>
      ) : (
        <div className="table-wrap cards">
          <table>
            <thead>
              <tr>
                <th>Type</th><th>HSN code</th><th>Description tail</th>
                <th>Max wastage (handcrafted)</th><th>Min value addition</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {hsnTypes.map((t) => (
                <tr key={t}>
                  <td data-label="Type">{HSN_LABEL[t] ?? t}</td>
                  {hsnCell(t, "code", "HSN code", { numeric: true })}
                  {hsnCell(t, "description_tail", "Description", { wide: true })}
                  {hsnCell(t, "max_wastage_handcrafted", "Max wastage", { pct: true })}
                  {hsnCell(t, "min_value_addition", "Min VA", { pct: true })}
                  {canEdit && (
                    <td data-label="">
                      <button className="btn small primary" disabled={!hsnDirty(t) || anyBusy} onClick={() => saveHsn(t)}>
                        <SaveLabel busy={busy === `hsn:${t}`} text="Save" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4 ── labour rates */}
      <h3 className="section">Labour rates</h3>
      <p className="hint">INR per gram, per KT. Saving keeps history: the current rate is retired and a new one becomes current.</p>
      <div className="table-wrap cards settings-narrow">
        <table>
          <thead>
            <tr><th>KT</th><th>Rate (INR / g)</th>{canEdit && <th />}</tr>
          </thead>
          <tbody>
            {laborKts.map((kt) => {
              const err = laborErrors[kt];
              const dirty = (laborDraft[kt] ?? "") !== String(laborBase[kt] ?? "");
              return (
                <tr key={kt}>
                  <td data-label="KT">{kt}</td>
                  <td data-label="Rate (INR/g)">
                    <div>
                      <input className={err ? "invalid" : undefined} value={laborDraft[kt] ?? ""} inputMode="decimal"
                             disabled={locked}
                             onChange={(e) => {
                               const v = e.target.value;
                               setLaborDraft((d) => ({ ...d, [kt]: v }));
                               setLaborErrors((x) => omit(x, kt));
                             }} />
                      {err && <div className="err">{err}</div>}
                    </div>
                  </td>
                  {canEdit && (
                    <td data-label="">
                      <button className="btn small primary" disabled={!dirty || anyBusy} onClick={() => saveLabor(kt)}>
                        <SaveLabel busy={busy === `labor:${kt}`} text="Save" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {laborKts.length === 0 && (
              <tr><td data-label="" colSpan={canEdit ? 3 : 2} className="muted">No current labour rates.</td></tr>
            )}
            {canEdit && (
              <tr>
                <td data-label="New KT">
                  <div>
                    <input className={newLaborErrors.kt ? "invalid" : undefined} value={newLabor.kt} placeholder="e.g. 22"
                           onChange={(e) => { const v = e.target.value; setNewLabor((n) => ({ ...n, kt: v })); setNewLaborErrors((x) => ({ ...x, kt: undefined })); }} />
                    {newLaborErrors.kt && <div className="err">{newLaborErrors.kt}</div>}
                  </div>
                </td>
                <td data-label="Rate (INR/g)">
                  <div>
                    <input className={newLaborErrors.rate ? "invalid" : undefined} value={newLabor.rate} inputMode="decimal"
                           placeholder="1275"
                           onChange={(e) => { const v = e.target.value; setNewLabor((n) => ({ ...n, rate: v })); setNewLaborErrors((x) => ({ ...x, rate: undefined })); }} />
                    {newLaborErrors.rate && <div className="err">{newLaborErrors.rate}</div>}
                  </div>
                </td>
                <td data-label="">
                  <button className="btn small" disabled={anyBusy || (!newLabor.kt.trim() && !newLabor.rate.trim())} onClick={addLabor}>
                    <SaveLabel busy={busy === "labor:new"} text="+ Add KT" />
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
