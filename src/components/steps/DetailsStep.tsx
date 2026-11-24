/** Step 3 — everything the packing list doesn't carry: buyer, bank, gold, exchange rates, package. */
import type { ReactNode } from "react";
import Decimal from "decimal.js";
import { ChevronRight, Coins, FileText, Package, Plane, Repeat, SlidersHorizontal } from "lucide-react";

import type { AppSettings } from "../../types";
import type { LookupOption } from "../../storage/lookups";
import type { BuyerSuggestion } from "../../lib/mainws";
import { Dropdown } from "../Dropdown";
import { Callout, Card, Field } from "../ui";
import { ADVANCED_FIELDS, type FormErrors, type FormState } from "./form";

const LABELS: Partial<Record<keyof FormState, string>> = {
  invoice_number: "Invoice number", invoice_date: "Invoice date", buyer_id: "Buyer", bank_id: "Bank",
  gold_rate_usd_per_troy_oz: "Gold rate", gold_purity: "Gold purity", gold_purchase_invoice_no: "Gold purchase invoice",
  gold_opening_stock_gm: "Opening stock", inr_usd_rate: "Invoice exchange rate", labour_inr_usd_rate: "Labour exchange rate",
  base_gold_rate_usd_per_gm: "Base-lock rate", package_gross_wt_kg: "Package weight", wastage_pct_override: "Wastage override",
  freight_usd: "Freight", insurance_usd: "Insurance", discount_usd: "Discount", commission_usd: "Commission",
};

/** Under the Buyer field: where Main WS says the included pieces ship to. */
function BuyerHint({ hint, buyerId, onUse }: { hint: BuyerSuggestion; buyerId: string | null; onUse: (id: string) => void }) {
  const total = hint.counts.reduce((a, [, n]) => a + n, 0);
  const picked = hint.buyer && buyerId === hint.buyer.id;
  return (
    <span>
      {hint.unanimous
        ? <>Main File: all {total} pieces ship to <strong>{hint.code}</strong>{picked ? " — buyer picked from that." : "."}</>
        : <>Main File ship-to: {hint.counts.map(([c, n]) => `${n} × ${c}`).join(" · ")}. Mixed, so pick the buyer yourself (EXP615 went to Brisbane).</>}
      {hint.unanimous && hint.buyer && !picked && (
        <> <button type="button" className="link-btn" onClick={() => onUse(hint.buyer!.id)}>
          Use {hint.buyer.name} ({hint.buyer.city.toLowerCase()})
        </button></>
      )}
      {hint.unanimous && !hint.buyer && <> No buyer is set up for {hint.code} yet.</>}
    </span>
  );
}

export function DetailsStep(props: {
  form: FormState; setForm: (f: FormState) => void; errors: FormErrors;
  settings: AppSettings | null; autoBaseRate: Decimal | null; lockRatio: number;
  buyerHint: BuyerSuggestion | null;
}) {
  const { form, setForm, errors, autoBaseRate, lockRatio, buyerHint } = props;
  function u<K extends keyof FormState>(k: K, v: FormState[K]) { setForm({ ...form, [k]: v }); }
  function pick(idKey: keyof FormState, textKey?: keyof FormState) {
    return (o: LookupOption | null) => setForm({ ...form, [idKey]: o?.id ?? null, ...(textKey ? { [textKey]: o?.label ?? "" } : {}) });
  }
  const cls = (k: keyof FormState) => (errors[k] ? "invalid" : undefined);

  /** Text input bound to a form key, with optional $ / unit affixes. */
  function input(k: keyof FormState, opts: { placeholder?: string; pre?: string; suf?: string; type?: string; mode?: "decimal" | "numeric" } = {}) {
    const el = (
      <input className={cls(k)} value={form[k] as string} type={opts.type}
             inputMode={opts.mode} placeholder={opts.placeholder} aria-invalid={!!errors[k] || undefined}
             onChange={(e) => u(k, e.target.value as FormState[typeof k])} />
    );
    if (!opts.pre && !opts.suf) return el;
    return (
      <div className={`affix${opts.pre ? " has-pre" : ""}${opts.suf ? " has-suf" : ""}`}>
        {opts.pre && <span className="pre">{opts.pre}</span>}{el}{opts.suf && <span className="suf">{opts.suf}</span>}
      </div>
    );
  }

  const errorKeys = Object.keys(errors) as (keyof FormState)[];
  const advancedOpen = form.base_gold_rate_usd_per_gm.trim() !== "" || form.wastage_pct_override.trim() !== ""
    || !form.round_gross_2dp || !form.round_base_lock_2dp || ADVANCED_FIELDS.some((k) => errors[k]);

  return (
    <div className="stack">
      {errorKeys.length > 0 && (
        <Callout tone="bad" title={`${errorKeys.length} field${errorKeys.length === 1 ? " needs" : "s need"} attention`}>
          {errorKeys.map((k) => LABELS[k] ?? k).join(", ")}
        </Callout>
      )}

      <Card icon={FileText} title="Invoice & buyer" desc="Printed in the header of the INVOICE sheet.">
        <div className="fields">
          <Field label="Invoice number" required error={errors.invoice_number}>
            {input("invoice_number", { placeholder: "EXP616/2026-27" })}
          </Field>
          <Field label="Invoice date" required error={errors.invoice_date}>{input("invoice_date", { type: "date" })}</Field>
          <Field label="Buyer" required error={errors.buyer_id} asDiv
                 hint={buyerHint && <BuyerHint hint={buyerHint} buyerId={form.buyer_id} onUse={(id) => u("buyer_id", id)} />}>
            <Dropdown lookupKey="buyers" value={form.buyer_id} onChange={pick("buyer_id")} invalid={!!errors.buyer_id} allowAdd={false} placeholder="Select buyer" />
          </Field>
          <Field label="Bank" required error={errors.bank_id} asDiv>
            <Dropdown lookupKey="banks" value={form.bank_id} onChange={pick("bank_id")} invalid={!!errors.bank_id} allowAdd={false} placeholder="Select bank" />
          </Field>
          <Field label="Buyer's order no." optional>{input("buyer_order_no")}</Field>
          <Field label="Buyer's order date" optional>{input("buyer_order_date", { type: "date" })}</Field>
        </div>
      </Card>

      <Card icon={Plane} title="Shipping & terms" desc="Blank payment terms and agreement print the buyer's defaults.">
        <div className="fields">
          <Field label="Pre-carriage" asDiv>
            <Dropdown lookupKey="freight_carriers" value={form.pre_carriage_id} onChange={pick("pre_carriage_id", "pre_carriage_text")} placeholder="SEQUEL" />
          </Field>
          <Field label="Vessel / flight" asDiv>
            <Dropdown lookupKey="freight_modes" value={form.flight_mode_id} onChange={pick("flight_mode_id", "flight_mode_text")} placeholder="BY AIR FREIGHT" />
          </Field>
          <Field label="Port of loading" asDiv>
            <Dropdown lookupKey="ports" value={form.port_of_loading_id} onChange={pick("port_of_loading_id", "port_of_loading_text")} placeholder="MUMBAI / INDIA" />
          </Field>
          <Field label="Payment terms" asDiv>
            <Dropdown lookupKey="payment_terms" value={form.terms_id} onChange={pick("terms_id", "terms_text")} placeholder="Buyer default" />
          </Field>
          <Field label="Preferential agreement" asDiv>
            <Dropdown lookupKey="preferential_agreements" value={form.preferential_agreement_id} onChange={pick("preferential_agreement_id", "preferential_agreement_text")} placeholder="Buyer default" />
          </Field>
        </div>
      </Card>

      <Card icon={Coins} title="Gold" desc="From the Diamond India purchase invoice.">
        <div className="fields">
          <Field label="Gold rate" required error={errors.gold_rate_usd_per_troy_oz} hint="USD per troy ounce">
            {input("gold_rate_usd_per_troy_oz", { placeholder: "4339.8413", pre: "$", suf: "/ oz", mode: "decimal" })}
          </Field>
          <Field label="Purity" required error={errors.gold_purity}>{input("gold_purity", { mode: "decimal" })}</Field>
          <Field label="Base-lock rate" hint={form.base_gold_rate_usd_per_gm.trim() ? "Typed under Advanced" : `Gold rate × ${lockRatio}`}>
            <div className="computed">
              {form.base_gold_rate_usd_per_gm.trim() || (autoBaseRate ? autoBaseRate.toString() : "—")}
              <span className="faint" style={{ fontWeight: 500 }}>USD / g pure</span>
            </div>
          </Field>
          <Field label="Purchase invoice no." required error={errors.gold_purchase_invoice_no}>
            {input("gold_purchase_invoice_no", { placeholder: "OX26100MUM1059" })}
          </Field>
          <Field label="Purchase date">{input("gold_purchase_date", { type: "date" })}</Field>
          <Field label="Supplier">{input("gold_purchase_party")}</Field>
          <Field label="Opening stock of this purchase" optional error={errors.gold_opening_stock_gm}
                 hint="Only the first time a purchase is used. Later invoices read it from the ledger.">
            {input("gold_opening_stock_gm", { placeholder: "e.g. 200", suf: "g", mode: "decimal" })}
          </Field>
        </div>
      </Card>

      <Card icon={Repeat} title="Exchange rates">
        <div className="fields">
          <Field label="Invoice rate" required error={errors.inr_usd_rate} hint="INR per USD for the invoice total">
            {input("inr_usd_rate", { placeholder: "95.35", pre: "₹", mode: "decimal" })}
          </Field>
          <Field label="Labour rate" optional error={errors.labour_inr_usd_rate}
                 hint="Converts labour ₹ to USD on the customs packing list. Blank = same as the invoice rate.">
            {input("labour_inr_usd_rate", { placeholder: form.inr_usd_rate || "same as invoice", pre: "₹", mode: "decimal" })}
          </Field>
        </div>
      </Card>

      <Card icon={Package} title="Package & charges">
        <div className="fields">
          <Field label="Package gross weight" required error={errors.package_gross_wt_kg}>
            {input("package_gross_wt_kg", { suf: "kg", mode: "decimal" })}
          </Field>
          <Field label="Container no.">{input("container_number", { mode: "numeric" })}</Field>
          <Field label="Freight" error={errors.freight_usd}>{input("freight_usd", { pre: "$", mode: "decimal" })}</Field>
          <Field label="Insurance" error={errors.insurance_usd}>{input("insurance_usd", { pre: "$", mode: "decimal" })}</Field>
          <Field label="Discount" error={errors.discount_usd}>{input("discount_usd", { pre: "$", mode: "decimal" })}</Field>
          <Field label="Commission" error={errors.commission_usd}>{input("commission_usd", { pre: "$", mode: "decimal" })}</Field>
        </div>
      </Card>

      <section className="card">
        <details className="more" open={advancedOpen || undefined} style={{ borderTop: 0 }}>
          <summary>
            <ChevronRight size={16} className="chev" /><SlidersHorizontal size={15} /> Advanced
            <span className="summary-meta">Rounding, base-lock rate and wastage overrides</span>
          </summary>
          <div className="more-body">
            <div className="fields two">
              <Field label="Base-lock rate override" optional error={errors.base_gold_rate_usd_per_gm}
                     hint={<>Blank = gold rate × {lockRatio}{autoBaseRate ? ` = ${autoBaseRate.toString()}` : ""}.</>}>
                {input("base_gold_rate_usd_per_gm", { placeholder: autoBaseRate ? `auto ${autoBaseRate.toString()}` : "auto from gold rate", suf: "USD/g", mode: "decimal" })}
              </Field>
              <Field label="Wastage override (all lots)" optional error={errors.wastage_pct_override}
                     hint="Blank = per HSN: 4 % studded, 2 % mounting. Enter a decimal, e.g. 0.04.">
                {input("wastage_pct_override", { placeholder: "per HSN", mode: "decimal" })}
              </Field>
              <Check checked={form.round_gross_2dp} onChange={(v) => u("round_gross_2dp", v)}
                     title="Round gross weight to 2 decimals" hint="Matches recent invoices (5.808 → 5.81). Untick to keep the sheet's 3 decimals." />
              <Check checked={form.round_base_lock_2dp} onChange={(v) => u("round_base_lock_2dp", v)}
                     title="Round base lock (AR) to 2 decimals" hint="Matches recent invoices. Changes the MFG cost by at most a cent." />
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

function Check({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="check-title">{title}</span>
        {hint && <span className="check-hint" style={{ display: "block" }}>{hint}</span>}
      </span>
    </label>
  );
}
