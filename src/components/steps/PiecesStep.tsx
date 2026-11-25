/** Step 2 — choose the pieces for this invoice and price every stone row. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import Decimal from "decimal.js";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Package, Search, Sheet, SlidersHorizontal, Split, X } from "lucide-react";

import type { AppSettings, MainWsMatch, Piece } from "../../types";
import type { MainWsSummary } from "../../lib/mainws";
import { baseGoldLockUsd, netWtGm, touchFor } from "../../lib/calculations";
import { Badge, Callout, Field, Progress, fmtNum, fmtUsd, plural } from "../ui";
import { Empty } from "../Skeleton";
import { ktLabel, missingRates, typeLabel } from "./form";

export type DiamondPatch = Partial<Record<"shape" | "pcs" | "cts" | "certificate_no" | "origin" | "color_clarity" | "rate_usd_per_ct", string>>;
type Filter = "all" | "needs" | "ready" | "off";

interface Props {
  pieces: Piece[];
  excluded: Set<string>;
  settings: AppSettings | null;
  baseRate: Decimal | null;
  roundAr: boolean;
  laborRates: Record<string, number>;
  /** Bumped when state changes under the uncontrolled inputs (stones-register autofill). */
  version: number;
  mainSummary: MainWsSummary | null;
  toggleInclude: (stock: string, on: boolean) => void;
  setAllIncluded: (on: boolean, filter?: (p: Piece) => boolean) => void;
  updateDiamond: (stock: string, idx: number, patch: DiamondPatch) => void;
  splitDiamond: (stock: string, idx: number) => void;
  removeDiamond: (stock: string, idx: number) => void;
  onCertBlur: (stock: string, idx: number, cert: string) => void;
  updatePieceTuning: (stock: string, patch: { base_gold_lock_usd?: string; fixed_addon_usd?: string }) => void;
}

function studdingMismatch(p: Piece): { pcs: number; cts: Decimal } | null {
  if (p.studding_raw_cts === undefined) return null;
  const pcs = p.diamonds.reduce((a, d) => a + d.pcs, 0);
  const cts = p.diamonds.reduce((a, d) => a.add(d.cts), new Decimal(0));
  return pcs !== p.studding_raw_pcs || cts.sub(p.studding_raw_cts).abs().gt(0.02) ? { pcs, cts } : null;
}

export function PiecesStep(props: Props) {
  const { pieces, excluded } = props;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const status = useMemo(() => new Map(pieces.map((p) => {
    const off = excluded.has(p.stock_no);
    const missing = missingRates(p);
    const mismatch = studdingMismatch(p);
    return [p.stock_no, { off, missing, mismatch, ready: !off && missing === 0 && !mismatch }];
  })), [pieces, excluded]);

  const counts = useMemo(() => {
    const c = { all: pieces.length, needs: 0, ready: 0, off: 0 };
    for (const s of status.values()) {
      if (s.off) c.off++;
      else if (s.ready) c.ready++;
      else c.needs++;
    }
    return c;
  }, [pieces, status]);
  const included = counts.all - counts.off;

  const q = query.trim().toLowerCase();
  const visible = pieces.filter((p) => {
    const s = status.get(p.stock_no)!;
    if (filter === "needs" && (s.off || s.ready)) return false;
    if (filter === "ready" && !s.ready) return false;
    if (filter === "off" && !s.off) return false;
    if (!q) return true;
    return [p.cust_style_no, p.stock_no, p.cust_po, p.item, p.product_category, p.main_ws?.customer, p.main_ws?.ship_to]
      .some((v) => v && v.toLowerCase().includes(q));
  });
  const sources = [...new Set(pieces.map((p) => p.source ?? ""))].filter(Boolean);
  const allCollapsed = visible.every((p) => collapsed.has(p.stock_no) || excluded.has(p.stock_no));

  function toggleOpen(stock: string) {
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(stock)) n.delete(stock); else n.add(stock); return n; });
  }

  const FILTERS: [Filter, string, number][] = [
    ["all", "All", counts.all], ["needs", "Needs input", counts.needs], ["ready", "Ready", counts.ready], ["off", "Not on invoice", counts.off],
  ];

  return (
    <div>
      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search style, stock no. or PO" aria-label="Search pieces" />
        </div>
        <div className="segmented" role="tablist" aria-label="Filter pieces">
          {FILTERS.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={clsx({ on: filter === k })} onClick={() => setFilter(k)}>
              {label} <span className="count">{n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn small" onClick={() => props.setAllIncluded(true)}>Include all</button>
        <button className="btn small" onClick={() => props.setAllIncluded(false)}>Exclude all</button>
        {sources.length > 1 && sources.map((s) => (
          <button key={s} className="btn small" title={s} onClick={() => { props.setAllIncluded(false); props.setAllIncluded(true, (p) => p.source === s); }}>
            Only {s.split(" › ")[0].slice(0, 18)}
          </button>
        ))}
        <button className="btn small ghost" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(visible.map((p) => p.stock_no)))}>
          {allCollapsed ? <><ChevronsUpDown size={15} /> Expand</> : <><ChevronsDownUp size={15} /> Collapse</>}
        </button>
      </div>

      <div className="progress-row">
        <Progress value={counts.ready} max={included} />
        <span><strong className="num" style={{ color: "var(--ink)" }}>{counts.ready}</strong> of {plural(included, "piece")} ready</span>
      </div>

      {props.mainSummary && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone={props.mainSummary.unmatched.length ? "warn" : "ok"}
                   title={`Main File: ${props.mainSummary.matched} of ${plural(props.mainSummary.matched + props.mainSummary.unmatched.length, "piece")} found`}>
            Filled {plural(props.mainSummary.certificates, "certificate")} and {plural(props.mainSummary.grades, "centre-stone grade")} (shaded blue below) — check them against the certificate.
            {props.mainSummary.unmatched.length > 0 && <> Not in Main WS: {props.mainSummary.unmatched.join(", ")}.</>}
            {props.mainSummary.toCheck > 0 && <> {plural(props.mainSummary.toCheck, "piece")} {props.mainSummary.toCheck === 1 ? "has" : "have"} a note to read.</>}
          </Callout>
        </div>
      )}

      {visible.length === 0 && (
        <Empty icon={Package} title="No pieces match" body="Clear the search or pick another filter."
               action={<button className="btn small" onClick={() => { setQuery(""); setFilter("all"); }}>Show all pieces</button>} />
      )}

      {visible.map((p) => (
        <PieceCard key={p.stock_no} piece={p} {...props} st={status.get(p.stock_no)!}
                   open={!collapsed.has(p.stock_no) && !excluded.has(p.stock_no)} onToggle={() => toggleOpen(p.stock_no)}
                   showSource={sources.length > 1} />
      ))}

      <datalist id="origin-options">
        <option value="LGD001-CVD" /><option value="LGD002-HPHT" /><option value="MINED" />
        <option value="SEMI-PRECIOUS STONE" /><option value="PRECIOUS STONE" />
      </datalist>
    </div>
  );
}

function PieceCard(props: Props & {
  piece: Piece; open: boolean; onToggle: () => void; showSource: boolean;
  st: { off: boolean; missing: number; mismatch: { pcs: number; cts: Decimal } | null; ready: boolean };
}) {
  const { piece: p, open, onToggle, st, settings, baseRate, laborRates, roundAr, version } = props;
  const on = !st.off;
  const K = netWtGm(p);
  const { touch, configured } = touchFor(p.kt, settings?.kt_touch ?? {});
  const auto = baseRate ? baseGoldLockUsd({ net_wt_raw: p.net_wt_raw, computed_net_wt: K, touch, base_rate_usd_per_gm: baseRate }) : null;
  const autoAr = auto ? (roundAr ? auto.value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : auto.value) : null;
  const labour = p.labour_rate_inr_per_gm?.toNumber() ?? laborRates[p.kt] ?? laborRates[p.kt.replace("-PD", "")];
  const stoneValue = p.diamonds.reduce((a, d) => (d.rate_usd_per_ct ? a.add(d.rate_usd_per_ct.mul(d.cts)) : a), new Decimal(0));
  const addon = p.fixed_addon_usd?.toString() ?? String(settings?.mfg_fixed_addon_usd ?? 10);
  const tuned = p.base_gold_lock_usd != null || p.fixed_addon_usd != null;

  return (
    <section className={clsx("piece", { off: !on, needs: on && !st.ready })}>
      <div className="piece-head">
        <label className="piece-check" title={on ? "On this invoice — untick to leave it out" : "Not on this invoice — tick to include"}>
          <input type="checkbox" checked={on} onChange={(e) => props.toggleInclude(p.stock_no, e.target.checked)}
                 aria-label={`Include ${p.cust_style_no || p.stock_no}`} />
        </label>
        <button className="piece-main" onClick={onToggle} disabled={!on} aria-expanded={open}>
          <span className="piece-title">{p.cust_style_no || p.stock_no}</span>
          <span className="piece-meta">
            <span>{p.item}</span>
            <span>{ktLabel(p.kt)} {p.color.toLowerCase()}</span>
            <span className="num">{p.gross_wt.toFixed(3)} g gross · {K.toFixed(3)} g net</span>
            <span>stock {p.stock_no}{p.synthetic_stock ? "*" : ""}</span>
            {p.cust_po && <span>PO {p.cust_po}</span>}
            {props.showSource && p.source && <span>{p.source}</span>}
          </span>
        </button>
        <div className="piece-badges">
          <Badge tone="navy" title={p.product_category ? `Category on the sheet: ${p.product_category.trim()}` : undefined}>{typeLabel(p.jewellery_type)}</Badge>
          {p.semi_mount && <Badge tone="gold">Semi-mount</Badge>}
          {p.region && <Badge tone="plain" title="Region on the packing list (display only)">Region {p.region}</Badge>}
          {p.main_ws && !p.main_ws.found && <Badge tone="plain" title={p.main_ws.notes?.join(" ")}>Not in Main WS</Badge>}
          {p.main_ws?.found && (p.main_ws.notes?.length ?? 0) > 0 && <Badge tone="warn" title={p.main_ws.notes!.join(" ")}>Main WS note</Badge>}
          {!on ? <Badge>Not on invoice</Badge>
            : st.mismatch ? <Badge tone="bad" dot>Totals differ</Badge>
            : st.missing ? <Badge tone="warn" dot>{plural(st.missing, "rate")} missing</Badge>
            : <Badge tone="ok" dot>Ready</Badge>}
        </div>
        {on && <ChevronDown size={18} className={clsx("piece-toggle", { open })} onClick={onToggle} />}
      </div>

      {open && (
        <div className="piece-body">
          {p.main_ws && <MainWsStrip m={p.main_ws} />}
          {p.diamonds.length > 0 ? (
            <div className="table-wrap cards stones">
              <table>
                <thead>
                  <tr><th>Shape</th><th className="num">Pcs</th><th className="num">Carats</th><th>Certificate</th><th>Dia details</th><th>Colour &amp; clarity</th><th className="num">USD / ct</th><th className="num">Value</th><th /></tr>
                </thead>
                <tbody>
                  {p.diamonds.map((d, i) => (
                    <tr key={`${i}-${p.diamonds.length}-${version}`}>
                      <td data-label="Shape"><input defaultValue={d.shape} aria-label="Shape" style={{ minWidth: 84 }}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { shape: e.target.value })} /></td>
                      <td data-label="Pcs" className="num"><input inputMode="numeric" defaultValue={d.pcs} aria-label="Pieces" style={{ width: 58, minWidth: 52, textAlign: "right" }}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { pcs: e.target.value })} /></td>
                      <td data-label="Carats" className="num"><input inputMode="decimal" defaultValue={d.cts.toString()} aria-label="Carats" style={{ width: 72, minWidth: 64, textAlign: "right" }}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { cts: e.target.value })} /></td>
                      <td data-label="Certificate"><input placeholder="IGI-LG…" defaultValue={d.certificate_no ?? ""} aria-label="Certificate" style={{ minWidth: 124 }}
                                                    className={clsx({ "from-main": fromMain(p.main_ws, i, "cert", d.certificate_no) })}
                                                    title={fromMain(p.main_ws, i, "cert", d.certificate_no) ? `From Main WS row ${p.main_ws!.row}` : undefined}
                                                    onBlur={(e) => props.onCertBlur(p.stock_no, i, e.target.value)} /></td>
                      <td data-label="Dia details"><input placeholder="LGD001-CVD" list="origin-options" defaultValue={d.origin ?? ""} aria-label="Dia details" style={{ minWidth: 104 }}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { origin: e.target.value })} /></td>
                      <td data-label="Colour & clarity"><input placeholder="D-VS1" defaultValue={d.color_clarity ?? ""} aria-label="Colour and clarity" style={{ minWidth: 76 }}
                                                    className={clsx({ "from-main": fromMain(p.main_ws, i, "grade", d.color_clarity) })}
                                                    title={fromMain(p.main_ws, i, "grade", d.color_clarity) ? `From Main WS row ${p.main_ws!.row}` : undefined}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { color_clarity: e.target.value })} /></td>
                      <td data-label="USD / ct" className="num"><input placeholder="0.00" inputMode="decimal" aria-label="USD per carat" style={{ width: 84, minWidth: 72, textAlign: "right" }}
                                                    className={clsx({ need: d.pcs > 0 && !d.rate_usd_per_ct })} defaultValue={d.rate_usd_per_ct?.toString() ?? ""}
                                                    onBlur={(e) => props.updateDiamond(p.stock_no, i, { rate_usd_per_ct: e.target.value })} /></td>
                      <td data-label="Value" className="num strong">{d.rate_usd_per_ct ? fmtUsd(d.rate_usd_per_ct.mul(d.cts)) : <span className="faint">—</span>}</td>
                      <td data-label="">
                        <div className="row-actions">
                          <button className="btn small ghost icon" title="Split this row by sieve size" aria-label="Split row" onClick={() => props.splitDiamond(p.stock_no, i)}><Split size={15} /></button>
                          {p.diamonds.length > 1 && (
                            <button className="btn small ghost icon" title="Remove this row" aria-label="Remove row" onClick={() => props.removeDiamond(p.stock_no, i)}><X size={15} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hint">No stones on this piece.</p>
          )}

          <div className="piece-foot">
            {p.studding_raw_cts !== undefined && (
              <span className="num">Packing list: {plural(p.studding_raw_pcs ?? 0, "pc")} · {p.studding_raw_cts.toFixed(3)} ct</span>
            )}
            {stoneValue.gt(0) && <span className="num">Stone value <strong style={{ color: "var(--ink)" }}>{fmtUsd(stoneValue)}</strong></span>}
            {st.mismatch && (
              <Callout tone="bad" title="Stone rows don't add up to the packing list">
                Rows total {plural(st.mismatch.pcs, "pc")} / {st.mismatch.cts.toFixed(3)} ct; the sheet says {p.studding_raw_pcs} pcs / {p.studding_raw_cts!.toFixed(3)} ct.
                After a split, the rows must still add up.
              </Callout>
            )}
          </div>

          <details className="tuning" open={tuned || undefined}>
            <summary>
              <ChevronRight size={15} className="chev" /><SlidersHorizontal size={14} /> Base lock &amp; add-on
              <span className="summary-meta">
                AR {p.base_gold_lock_usd != null ? `${fmtNum(p.base_gold_lock_usd)} (typed)` : autoAr ? `${fmtNum(autoAr, roundAr ? 2 : 4)} auto` : "needs gold rate"}
                {" · "}add-on ${addon}{" · "}labour ₹{labour ?? "?"}/g {p.labour_rate_inr_per_gm ? "(sheet)" : "(Settings)"}
              </span>
            </summary>
            <div className="fields two">
              <Field label="Base lock USD (AR)" optional
                     hint={auto
                       ? <>Auto = {auto.net.toFixed(2)} g × {touch.toString()}{configured ? "" : " (KT ÷ 24 — set the touch in Settings)"} × {baseRate!.toString()}. Type a value to override.</>
                       : <>Enter the gold rate on the Details step to calculate this.</>}>
                <input key={`ar-${version}`} inputMode="decimal" placeholder={autoAr ? `auto ${autoAr.toFixed(roundAr ? 2 : 4)}` : "auto"}
                       defaultValue={p.base_gold_lock_usd?.toString() ?? ""}
                       onBlur={(e) => props.updatePieceTuning(p.stock_no, { base_gold_lock_usd: e.target.value })} />
              </Field>
              <Field label="Add-on USD (AZ)" optional hint={`Leave blank for the default $${settings?.mfg_fixed_addon_usd ?? 10}.`}>
                <input key={`az-${version}`} inputMode="decimal" placeholder={`default ${settings?.mfg_fixed_addon_usd ?? 10}`}
                       defaultValue={p.fixed_addon_usd?.toString() ?? ""}
                       onBlur={(e) => props.updatePieceTuning(p.stock_no, { fixed_addon_usd: e.target.value })} />
              </Field>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

/** A cell shows the value Main WS put there (and the clerk hasn't changed it). */
function fromMain(m: MainWsMatch | undefined, row: number, what: "cert" | "grade", value: string | null | undefined): boolean {
  if (!m?.found || m.centre_row !== row || !value) return false;
  return what === "cert" ? !!m.filled_certificate && value === m.certificates?.[0] : !!m.filled_grade && value === m.grade;
}

/** One line of what Main WS says about the piece, plus any notes. */
function MainWsStrip({ m }: { m: MainWsMatch }) {
  if (!m.found) {
    return (
      <div className="mainws miss">
        <span className="src"><Sheet size={14} /> Not in Main WS</span>
        <span>{m.notes?.[0]}</span>
      </div>
    );
  }
  const shapeGrade = [m.shape, m.grade].filter(Boolean).join(" ");
  return (
    <>
      <div className="mainws">
        <span className="src" title={m.by === "job" ? "Matched on the packing list's Cust PO = Main WS JobNo" : "Matched on the style no."}>
          <Sheet size={14} /> Main WS row {m.row}
        </span>
        <span>{m.by === "job" ? `job ${m.job_no}` : `style ${m.item_no}`}</span>
        {m.customer && <span>{m.customer}</span>}
        {m.ship_to && <span>ships to {m.ship_to}</span>}
        {m.mined_or_lab && <span>{m.mined_or_lab}</span>}
        {m.centre && <span className="num">centre {m.centre}</span>}
        {shapeGrade && <span>{shapeGrade}</span>}
        {(m.certificates?.length ?? 0) > 0 && <span>{m.certificates!.join(", ")}</span>}
      </div>
      {(m.notes?.length ?? 0) > 0 && (
        <Callout tone="warn">
          {m.notes!.length === 1 ? m.notes![0] : <ul className="notes">{m.notes!.map((n) => <li key={n}>{n}</li>)}</ul>}
        </Callout>
      )}
    </>
  );
}
