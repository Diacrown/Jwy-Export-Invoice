/** App chrome: navy sidebar (top bar under 960px) and the wizard stepper. */
import clsx from "clsx";
import { Check, FilePlus2, LogOut, ReceiptText, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import { BrandMark, Spinner } from "./ui";
import type { Step } from "./steps/form";

export type View = "invoices" | "wizard" | "settings";

export function Sidebar(props: {
  view: View; onNavigate: (v: View) => void; draftMeta?: string | null;
  email?: string; canEdit: boolean; configLoading: boolean; onSignOut: () => void;
}) {
  const { view, onNavigate, draftMeta, email, canEdit, configLoading, onSignOut } = props;
  const items: [View, string, LucideIcon, string | null | undefined][] = [
    ["invoices", "Invoices", ReceiptText, null],
    ["wizard", draftMeta ? "Current invoice" : "New invoice", FilePlus2, draftMeta],
    ["settings", "Settings", SettingsIcon, null],
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark />
        <div className="brand-text">
          <div className="brand-name">DIACROWN</div>
          <div className="brand-sub">Export invoices</div>
        </div>
      </div>
      <nav className="nav" aria-label="Main">
        <div className="nav-label">Workspace</div>
        {items.map(([v, label, Icon, meta]) => (
          <button key={v} className={clsx("nav-item", { active: view === v })} aria-current={view === v ? "page" : undefined}
                  title={label} onClick={() => onNavigate(v)}>
            <Icon size={17} /><span className="nav-text">{label}</span>{meta && <span className="nav-meta">{meta}</span>}
          </button>
        ))}
      </nav>
      {configLoading && <div className="config-chip"><Spinner /><span>Loading settings…</span></div>}
      <div className="sidebar-foot">
        <span className="avatar" aria-hidden>{(email ?? "?").slice(0, 1)}</span>
        <div className="user-text">
          <div className="user-email" title={email}>{email}</div>
          <div className="user-role">{canEdit ? "Accounts" : "Read-only"}</div>
        </div>
        <button className="icon-btn-dark" onClick={onSignOut} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
      </div>
    </aside>
  );
}

export interface StepView { key: Step; label: string; meta?: string; warn?: boolean; done: boolean; enabled: boolean }

export function Stepper({ steps, current, onPick }: { steps: StepView[]; current: Step; onPick: (s: Step) => void }) {
  return (
    <nav className="stepper" aria-label="Invoice steps">
      {steps.map((s, i) => (
        <span key={s.key} style={{ display: "contents" }}>
          {i > 0 && <span className={clsx("step-line", { done: steps[i - 1].done })} aria-hidden />}
          <button className={clsx("step", { done: s.done, current: s.key === current })} disabled={!s.enabled}
                  aria-current={s.key === current ? "step" : undefined} onClick={() => onPick(s.key)}>
            <span className="step-dot">{s.done && s.key !== current ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            <span className="step-text">
              <span className="step-name">{s.label}</span>
              {s.meta && <span className={clsx("step-meta", { warn: s.warn })}>{s.meta}</span>}
            </span>
          </button>
        </span>
      ))}
    </nav>
  );
}
