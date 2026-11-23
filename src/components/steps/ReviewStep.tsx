/** Step 4 — totals, lots, per-piece MFG breakdown and the V1–V16 checks. */
import { useState } from "react";
import type Decimal from "decimal.js";
import {
  ChevronRight, CircleAlert, CircleCheck, Coins, Layers, ListChecks, Package, Scale, ShieldAlert, ShieldCheck, TriangleAlert,
} from "lucide-react";

import type { GoldDrawdown, Lot, ValidationFinding, ValidationReport } from "../../types";
import { isBlocked } from "../../lib/validators";
import { Card, Kpi, fmtInr, fmtNum, fmtUsd, plural } from "../ui";
import { SkelRows } from "../Skeleton";

export interface Ledger { opening_gm: number | null; drawdowns: GoldDrawdown[]; registered: boolean; used: Decimal }

/** Validator `detail` is free-form ({ mismatches: [{ stock_no, diff }] } …) — show it as short readable lines. */
function detailLines(detail: unknown): string[] {
  if (detail == null) return [];
  const fmtObj = (o: unknown) => (o && typeof o === "object"
    ? Object.entries(o as Record<string, unknown>).filter(([, v]) => typeof v !== "boolean").map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v)}`).join(" · ")
    : String(o));
  if (Array.isArray(detail)) return detail.slice(0, 8).map(fmtObj);
  if (typeof detail === "object") {
    const vals = Object.values(detail as Record<string, unknown>);
    if (vals.length === 1 && Array.isArray(vals[0])) return (vals[0] as unknown[]).slice(0, 8).map(fmtObj);
    return [fmtObj(detail)];
  }
  return [String(detail)];
}

function CheckRow({ f }: { f: ValidationFinding }) {
  const kind = f.passed ? "ok" : f.severity;
  const Icon = f.passed ? CircleCheck : f.severity === "hard" ? CircleAlert : TriangleAlert;
  const lines = f.passed ? [] : detailLines(f.detail);
  return (
    <div className={`check-row ${kind}`}>
      <Icon size={17} />
      <div>
        <span className="check-msg">{f.message}</span><span className="check-code">{f.code}</span>
        {lines.length > 0 && <ul className="check-detail">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </div>
    </div>
  );
}

export function ReviewStep(props: {
  lots: Lot[]; totals: { usd: Decimal; inr: Decimal } | null;
  report: ValidationReport | null; ledger: Ledger | null; inrRate: string;
}) {
  const { lots, totals, report, ledger, inrRate } = props;
  const [showPassed, setShowPassed] = useState(false);
  if (!totals || !report) return <div className="card"><SkelRows count={4} /></div>;

  const blocked = isBlocked(report);
  const hard = report.findings.filter((f) => !f.passed && f.severity === "hard");
  const soft = report.findings.filter((f) => !f.passed && f.severity === "soft");
  const passed = report.findings.filter((f) => f.passed);
  const pcs = lots.reduce((a, l) => a + l.pieces.reduce((aa, p) => aa + p.qty, 0), 0);
  const sum = (f: (l: Lot) => Decimal) => lots.reduce((a, l) => a + Number(f(l).toString()), 0);

  return (
    <div>
      <div className={`status-banner ${blocked ? "bad" : soft.length ? "warn" : ""}`}>
        <span className="sb-icon">{blocked ? <ShieldAlert size={20} /> : soft.length ? <TriangleAlert size={20} /> : <ShieldCheck size={20} />}</span>
        <div>
          <h3>{blocked ? `${plural(hard.length, "problem")} must be fixed before generating`
            : soft.length ? `Ready to generate — ${plural(soft.length, "warning")} to look at`
            : "All checks passed — ready to generate"}</h3>
          <p>{blocked ? "Go back, correct the pieces or details below, then preview again."
            : soft.length ? "Warnings don't block the invoice, but check them before it ships."
            : `${plural(passed.length, "check")} on piece counts, weights, wastage, value addition and HSN.`}</p>
        </div>
      </div>

      <div className="kpis">
        <Kpi hero label="C&F value" value={fmtUsd(totals.usd)} sub={`${fmtInr(totals.inr)} @ ₹${inrRate}`} />
        <Kpi icon={Package} label="Pieces" value={pcs} sub={plural(lots.length, "lot")} />
        <Kpi icon={Scale} label="Gross weight" value={`${fmtNum(sum((l) => l.totals!.gross_wt), 3)} g`} sub={`${fmtNum(sum((l) => l.totals!.net_wt), 3)} g net gold`} />
        <Kpi icon={Coins} label="Pure gold used" value={ledger ? `${fmtNum(ledger.used, 3)} g` : "—"}
             sub={ledger?.opening_gm != null ? `of ${fmtNum(ledger.opening_gm, 3)} g purchase` : "incl. wastage"} />
      </div>

      {(hard.length > 0 || soft.length > 0) && (
        <Card icon={ListChecks} title="Checks to look at" flush>
          <div className="checks">{[...hard, ...soft].map((f) => <CheckRow key={f.code} f={f} />)}</div>
        </Card>
      )}

      <div className="subhead"><h3>Lots</h3><span className="hint">{plural(lots.length, "lot")} · grouped by KT, type and semi-mount</span></div>
      <div className="table-wrap cards">
        <table>
          <thead>
            <tr><th>#</th><th>Description</th><th>HSN</th><th className="num">Pcs</th>
              <th className="num">Gross g</th><th className="num">Net g</th><th className="num">Wastage</th><th className="num">Gold</th>
              <th className="num">Stones</th><th className="num">MFG</th><th className="num">Total USD</th><th className="num">Value add.</th></tr>
          </thead>
          <tbody>
            {lots.map((l) => {
              const t = l.totals!;
              return (
                <tr key={l.lot_no}>
                  <td data-label="Lot" className="strong">{l.lot_no}</td>
                  <td data-label="Description" className="wrap">{l.description}</td>
                  <td data-label="HSN" className="num">{l.hsn_code}</td>
                  <td data-label="Pcs" className="num">{l.pieces.reduce((a, p) => a + p.qty, 0)}</td>
                  <td data-label="Gross g" className="num">{fmtNum(t.gross_wt, 3)}</td>
                  <td data-label="Net g" className="num">{fmtNum(t.net_wt, 3)}</td>
                  <td data-label="Wastage" className="num">{fmtNum(l.wastage_pct.mul(100), 2)}%</td>
                  <td data-label="Gold" className="num">{fmtNum(t.gold_value_usd)}</td>
                  <td data-label="Stones" className="num">{fmtNum(t.diamond_value_usd.add(t.stone_value_usd))}</td>
                  <td data-label="MFG" className="num">{fmtNum(t.mfg_cost_usd)}</td>
                  <td data-label="Total USD" className="num strong">{fmtNum(t.total_usd)}</td>
                  <td data-label="Value add." className="num">{fmtNum(t.value_addition_ratio.mul(100), 2)}%</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td data-label="" colSpan={3}>Total</td>
              <td data-label="Pcs" className="num">{pcs}</td>
              <td data-label="Gross g" className="num">{fmtNum(sum((l) => l.totals!.gross_wt), 3)}</td>
              <td data-label="Net g" className="num">{fmtNum(sum((l) => l.totals!.net_wt), 3)}</td>
              <td data-label="" />
              <td data-label="Gold" className="num">{fmtNum(sum((l) => l.totals!.gold_value_usd))}</td>
              <td data-label="Stones" className="num">{fmtNum(sum((l) => l.totals!.diamond_value_usd.add(l.totals!.stone_value_usd)))}</td>
              <td data-label="MFG" className="num">{fmtNum(sum((l) => l.totals!.mfg_cost_usd))}</td>
              <td data-label="Total USD" className="num">{fmtNum(sum((l) => l.totals!.total_usd))}</td>
              <td data-label="" />
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <section className="card">
          <details className="more" style={{ borderTop: 0 }}>
            <summary><ChevronRight size={16} className="chev" /><Layers size={15} /> Manufacturing cost per piece
              <span className="summary-meta">Customs packing list, columns AR → BA</span></summary>
            <div className="more-body">
              <div className="table-wrap cards">
                <table>
                  <thead><tr><th>Lot</th><th>Style</th><th className="num">Net g</th><th className="num">Gold (P)</th><th className="num">Base lock (AR)</th>
                    <th className="num">P − AR</th><th className="num">Labour ₹/g</th><th className="num">Labour $</th><th className="num">Add-on</th>
                    <th className="num">MFG (AK)</th><th className="num">Total (AL)</th></tr></thead>
                  <tbody>
                    {lots.flatMap((l) => l.pieces.map((p, i) => {
                      const c = l.piece_calcs![i];
                      return (
                        <tr key={p.stock_no}>
                          <td data-label="Lot">{l.lot_no}</td>
                          <td data-label="Style" className="strong">{p.cust_style_no || p.stock_no}</td>
                          <td data-label="Net g" className="num">{fmtNum(c.net_wt, 3)}</td>
                          <td data-label="Gold (P)" className="num">{fmtNum(c.gold_value)}</td>
                          <td data-label="Base lock (AR)" className="num" title={c.base_lock_auto ? "Calculated" : "Typed on the Pieces step"}>
                            {fmtNum(c.base_lock)}{c.base_lock_auto ? "" : " ✎"}</td>
                          <td data-label="P − AR" className="num">{fmtNum(c.residual)}</td>
                          <td data-label="Labour ₹/g" className="num">{c.labour_rate_inr.toString()}</td>
                          <td data-label="Labour $" className="num">{fmtNum(c.labour_cost)}</td>
                          <td data-label="Add-on" className="num">{c.addon.toString()}</td>
                          <td data-label="MFG (AK)" className="num strong">{fmtNum(c.mfg)}</td>
                          <td data-label="Total (AL)" className="num">{fmtNum(c.total)}</td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </section>

        <section className="card">
          <details className="more" style={{ borderTop: 0 }} open={showPassed} onToggle={(e) => setShowPassed((e.target as HTMLDetailsElement).open)}>
            <summary><ChevronRight size={16} className="chev" /><ShieldCheck size={15} /> {plural(passed.length, "check")} passed
              <span className="summary-meta">V1–V16</span></summary>
            {showPassed && <div className="checks" style={{ paddingBottom: 6 }}>{passed.map((f) => <CheckRow key={f.code} f={f} />)}</div>}
          </details>
        </section>
      </div>
    </div>
  );
}
