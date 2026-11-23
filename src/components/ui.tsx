/** Small presentational primitives for the finance-console design. DOM only, no data access. */
import { useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";
import type Decimal from "decimal.js";
import { CircleAlert, CircleCheck, Gem, Info, TriangleAlert, type LucideIcon } from "lucide-react";

// ───────── number + date formatting (display only; money stays Decimal until here) ─────────

const toNum = (d: Decimal | number) => (typeof d === "number" ? d : Number(d.toString()));
export function fmtNum(d: Decimal | number, dp = 2): string {
  return toNum(d).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export const fmtUsd = (d: Decimal | number, dp = 2) => `$${fmtNum(d, dp)}`;
export function fmtInr(d: Decimal | number): string {
  return `₹${toNum(d).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ───────── brand ─────────

export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <Gem size={Math.round(size * 0.52)} strokeWidth={2.1} />
    </span>
  );
}

// ───────── layout ─────────

export function Card(props: {
  icon?: LucideIcon; title?: ReactNode; desc?: ReactNode; actions?: ReactNode;
  foot?: ReactNode; className?: string; flush?: boolean; children?: ReactNode; id?: string;
}) {
  const { icon: Icon, title, desc, actions, foot, className, flush, children, id } = props;
  return (
    <section className={clsx("card", className)} id={id}>
      {(title || desc) && (
        <header className="card-head">
          {Icon && <span className="card-icon"><Icon size={17} /></span>}
          <div className="card-head-text">
            {title && <h3 className="card-title">{title}</h3>}
            {desc && <p className="card-desc">{desc}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={clsx("card-body", { flush })}>{children}</div>}
      {foot && <footer className="card-foot">{foot}</footer>}
    </section>
  );
}

/** Label + control + hint/error. Renders a <label> so clicking the text focuses
 *  the input — pass `asDiv` for composite controls (the Dropdown), where a
 *  wrapping label would re-click the trigger after an option is picked. */
export function Field(props: {
  label: ReactNode; required?: boolean; optional?: boolean; hint?: ReactNode; error?: string;
  className?: string; asDiv?: boolean; children: ReactNode;
}) {
  const { label, required, optional, hint, error, className, asDiv, children } = props;
  const Tag = asDiv ? "div" : "label";
  return (
    <Tag className={clsx("field", className)}>
      <span className="field-label">
        {label}
        {required && <span className="req" aria-hidden>*</span>}
        {optional && <span className="opt">optional</span>}
      </span>
      {children}
      {error
        ? <span className="field-error" role="alert"><CircleAlert size={13} />{error}</span>
        : hint ? <span className="field-hint">{hint}</span> : null}
    </Tag>
  );
}

export function Badge({ tone, dot, title, children }: {
  tone?: "ok" | "warn" | "bad" | "info" | "navy" | "gold" | "plain"; dot?: boolean; title?: string; children: ReactNode;
}) {
  return <span className={clsx("badge", tone)} title={title}>{dot && <span className="dot" />}{children}</span>;
}

const CALLOUT_ICON = { info: Info, ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert } as const;
export function Callout({ tone = "info", title, children }: { tone?: keyof typeof CALLOUT_ICON; title?: ReactNode; children?: ReactNode }) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={clsx("callout", tone !== "info" && tone)} role={tone === "bad" ? "alert" : undefined}>
      <Icon size={16} />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Kpi({ label, value, sub, hero, icon: Icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; hero?: boolean; icon?: LucideIcon }) {
  return (
    <div className={clsx("kpi", { hero })}>
      <div className="kpi-label">{Icon && <Icon size={14} />}{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className={clsx("progress", { done: max > 0 && value >= max })} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

/** "Ctrl ↵" hint shown inside primary buttons on desktop. */
export function Kbd() {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return <span className="kbd" aria-hidden>{mac ? "⌘" : "Ctrl"} ↵</span>;
}

/** Sticky bar at the bottom of the wizard: running stats on the left, actions on the right. */
export function ActionBar({ stats, children }: { stats?: ReactNode; children: ReactNode }) {
  return (
    <div className="actionbar">
      <div className="actionbar-stats">{stats}</div>
      <div className="actionbar-actions">{children}</div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "warn" | "ok" }) {
  return <span className={clsx("stat", tone)}><strong>{value}</strong> {label}</span>;
}

// ───────── confirm dialog (replaces window.confirm) ─────────

export function ConfirmDialog(props: {
  open: boolean; title: string; body?: ReactNode; confirmLabel: string; danger?: boolean;
  icon?: LucideIcon; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const { open, title, body, confirmLabel, danger, icon: Icon = danger ? TriangleAlert : Info, busy, onConfirm, onCancel } = props;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={clsx("dialog", { danger })} role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
        <div className="dialog-icon"><Icon size={20} /></div>
        <h3 id="dlg-title">{title}</h3>
        {body && <p>{body}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button ref={confirmRef} className={clsx("btn", danger ? "danger solid" : "primary")} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
