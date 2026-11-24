/** Fill certificates, centre-stone grades and the buyer from the Main File's
 *  "Main WS" tab. Pure functions — the sheet reader is parsers/mainws.ts.
 *
 *  Main WS is typed by hand, so everything here is defensive:
 *  - a piece is found by its packing-list Cust PO = Main WS JobNo (style numbers
 *    repeat across jobs and are sometimes typed differently: R0221-O0200 on the
 *    packing list is R0221-0200 in Main WS);
 *  - a certificate or grade is only written into an EMPTY studding row, and only
 *    when the Main WS centre stone's pcs/carats match that row;
 *  - two different certificate numbers for one stone are shown, never guessed.
 */
import Decimal from "decimal.js";
import type { Buyer, DiamondDetail, MainWsMatch, MainWsRow, Piece } from "../types";

// ── text helpers ─────────────────────────────────────────────────────────────

const LABS = ["IGI", "GIA", "HRD", "GCAL", "IGL", "SGL", "GSI"];
const LAB_TOKEN = new RegExp(`^(${LABS.join("|")})[:#.]?$`);
const CERT_TOKEN = new RegExp(`^(?:(${LABS.join("|")})[-:#]?)?(LG)?[-:#]?(\\d{7,12})$`);

/** True when Main WS / the packing list say the stones are lab-grown. */
export function isLabGrown(piece: Pick<Piece, "jewellery_type">, minedOrLab?: string | null): boolean {
  if (piece.jewellery_type === "gold_studded_lgd") return true;
  return /\b(LGD|LAB)\b/i.test(minedOrLab ?? "") && !/\bMINED\b/i.test(minedOrLab ?? "");
}

/** Certificate numbers in free text, normalised the way EXP615 prints them:
 *  "IGI 828629159" on a lab-grown piece → "IGI-LG828629159"; "LG731518108" →
 *  "IGI-LG731518108"; "GIA 2141438171" → "GIA-2141438171". A bare number is
 *  only trusted inside a Cert No. column. "IGI 7+94661734" (a typo) is skipped. */
export function extractCertificates(text: string, opts: { certColumn: boolean; labGrown: boolean }): string[] {
  const out: string[] = [];
  const tokens = text.toUpperCase().split(/[\s,;/()]+/).filter(Boolean);
  tokens.forEach((tok, i) => {
    const m = CERT_TOKEN.exec(tok.replace(/[.:]$/, ""));
    if (!m) return;
    const prev = i > 0 ? LAB_TOKEN.exec(tokens[i - 1]) : null;
    const lab = m[1] ?? prev?.[1] ?? null;
    const lg = !!m[2];
    if (!lab && !lg && !opts.certColumn) return;
    const digits = m[3];
    let cert: string;
    if (lg || (lab === "IGI" && opts.labGrown) || (!lab && opts.labGrown)) cert = `${lab ?? "IGI"}-LG${digits}`;
    else if (lab) cert = `${lab}-${digits}`;
    else cert = digits;
    out.push(cert);
  });
  return out;
}

const certDigits = (c: string) => c.replace(/\D/g, "");

/** All distinct certificates on a Main WS row (Cert No. columns first). */
export function rowCertificates(row: MainWsRow, labGrown: boolean): string[] {
  const seen = new Map<string, string>();
  const add = (c: string) => { if (!seen.has(certDigits(c))) seen.set(certDigits(c), c); };
  for (const t of row.cert_cells) extractCertificates(t, { certColumn: true, labGrown }).forEach(add);
  for (const t of row.remark_cells) extractCertificates(t, { certColumn: false, labGrown }).forEach(add);
  return [...seen.values()];
}

const CLARITY = "FL|IF|VVS1|VVS2|VVS|VS1|VS2|VS|SI1|SI2|SI3|SI|I1|I2|I3";
const GRADE_RE = new RegExp(`(?:^|\\s)([D-N](?:\\s*[-&]?\\s*[D-N])?)\\s*[/\\s-]\\s*(${CLARITY})\\b`, "i");

/** "Long Radiant D/VS1" → { shape: "Long Radiant", grade: "D-VS1" }; "D VS1" → grade only. */
export function parseShapeGrade(text: string): { shape: string | null; grade: string | null } {
  const t = (text ?? "").trim();
  const m = GRADE_RE.exec(t);
  if (!m) return { shape: null, grade: null };
  const colour = m[1].toUpperCase().replace(/[\s&-]/g, "");
  const shape = t.slice(0, m.index).trim() || null;
  return { shape, grade: `${colour}-${m[2].toUpperCase()}` };
}

/** "1/2.03 1/2.06" → [{1, 2.03}, {1, 2.06}]. */
export function parseStonePairs(text: string): { pcs: number; cts: number }[] {
  const out: { pcs: number; cts: number }[] = [];
  for (const m of (text ?? "").matchAll(/(\d+)\s*\/\s*(\d*\.\d+|\d+)/g)) out.push({ pcs: Number(m[1]), cts: Number(m[2]) });
  return out;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

// ── matching ─────────────────────────────────────────────────────────────────

export interface MainWsIndex { byJob: Map<string, MainWsRow[]>; byStyle: Map<string, MainWsRow[]>; rows: number }

export function indexMainWs(rows: MainWsRow[]): MainWsIndex {
  const byJob = new Map<string, MainWsRow[]>();
  const byStyle = new Map<string, MainWsRow[]>();
  const push = (m: Map<string, MainWsRow[]>, k: string, r: MainWsRow) => { if (k) m.set(k, [...(m.get(k) ?? []), r]); };
  for (const r of rows) {
    push(byJob, norm(r.job_no), r);
    const styles = new Set([norm(r.item_no), norm(r.style_code)].filter(Boolean));
    for (const s of styles) push(byStyle, s, r);
  }
  return { byJob, byStyle, rows: rows.length };
}

/** The Main WS row for a piece, or why there isn't one. */
export function findRow(piece: Piece, idx: MainWsIndex): { row: MainWsRow; by: "job" | "style" } | { row: null; why: string } {
  const style = norm(piece.cust_style_no);
  const po = norm(piece.cust_po);
  // The packing list tags palladium-alloy jobs "6930-PD"; Main WS has job 6930.
  const job = po && !idx.byJob.has(po) && idx.byJob.has(po.replace(/-?PD$/, "")) ? po.replace(/-?PD$/, "") : po;
  if (job) {
    const hits = idx.byJob.get(job) ?? [];
    if (hits.length === 1) return { row: hits[0], by: "job" };
    if (hits.length > 1) {
      const same = hits.filter((r) => norm(r.item_no) === style || norm(r.style_code) === style);
      if (same.length >= 1) return { row: same[0], by: "job" };
      return { row: null, why: `${hits.length} Main WS rows have job ${piece.cust_po} and none has style ${piece.cust_style_no}.` };
    }
  }
  const hits = style ? idx.byStyle.get(style) ?? [] : [];
  if (hits.length === 1) return { row: hits[0], by: "style" };
  if (hits.length > 1) return { row: null, why: `Style ${piece.cust_style_no} is on ${hits.length} Main WS rows${job ? ` and none has job ${piece.cust_po}` : ""} — fill this piece by hand.` };
  return { row: null, why: job ? `No Main WS row has job ${piece.cust_po} or style ${piece.cust_style_no}.` : `No Main WS row has style ${piece.cust_style_no}.` };
}

/** The studding row that holds the Main WS centre stone: same pcs, carats
 *  within 0.01. When Main WS lists two centre stones ("1/2.03 1/2.06" — a
 *  re-set stone) the one that matches the packing list wins. */
export function centreRowIndex(diamonds: DiamondDetail[], centre: string): number | null {
  const pairs = parseStonePairs(centre);
  for (const pair of [...pairs].reverse()) {
    const hits = diamonds
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.pcs === pair.pcs && Math.abs(d.cts.toNumber() - pair.cts) <= 0.01);
    if (hits.length === 1) return hits[0].i;
  }
  return null;
}

/** Swan's packing list puts a fancy centre stone in the same row as its
 *  same-shape side stones ("MARQUISE 5 pcs 5.03 ct"); the manual workbook splits
 *  it into the certified centre stone + the rest (EXP615 B00797: 4.56 ct +
 *  4 pcs 0.47 ct). Do that split when exactly one untouched row of the centre
 *  stone's shape is big enough to hold it. Returns the new rows and the centre
 *  row's index, or null. */
export function splitCentre(diamonds: DiamondDetail[], centre: string, shape: string | null): { rows: DiamondDetail[]; index: number } | null {
  const pairs = parseStonePairs(centre);
  if (pairs.length !== 1 || pairs[0].pcs !== 1 || !shape) return null;
  const c = pairs[0].cts;
  const want = shape.toUpperCase();
  const hits = diamonds
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.pcs > 1 && d.cts.toNumber() > c + 0.001 && want.includes(d.shape.toUpperCase())
      && !d.certificate_no && !d.color_clarity && !d.rate_usd_per_ct);
  if (hits.length !== 1) return null;
  const { d, i } = hits[0];
  const cts = new Decimal(String(c));
  const centreRow: DiamondDetail = { ...d, pcs: 1, cts };
  const rest: DiamondDetail = { ...d, pcs: d.pcs - 1, cts: d.cts.minus(cts) };
  return { rows: [...diamonds.slice(0, i), centreRow, rest, ...diamonds.slice(i + 1)], index: i };
}

/** Main WS says lab-grown but the packing list says natural, or the other way round. */
function typeConflict(piece: Piece, minedOrLab: string): string | null {
  const t = minedOrLab.toUpperCase();
  const lab = /\bLGD\b|\bLAB\b/.test(t);
  const mined = /\bMINED\b/.test(t);
  if (lab && !mined && piece.jewellery_type === "gold_studded_diamond") return `Main WS says ${minedOrLab}, the packing list says natural diamonds.`;
  if (mined && !lab && piece.jewellery_type === "gold_studded_lgd") return `Main WS says ${minedOrLab}, the packing list says lab-grown.`;
  return null;
}

export interface MainWsSummary {
  rows: number;
  matched: number;
  unmatched: string[];
  certificates: number;
  grades: number;
  /** Pieces where a certificate or grade was found but not written in. */
  toCheck: number;
}

/** Look every piece up in Main WS and fill EMPTY certificate / grade cells on
 *  the centre-stone row. Returns new piece objects; never overwrites typing. */
export function applyMainWs(pieces: Piece[], rows: MainWsRow[]): { pieces: Piece[]; summary: MainWsSummary } {
  const idx = indexMainWs(rows);
  const summary: MainWsSummary = { rows: rows.length, matched: 0, unmatched: [], certificates: 0, grades: 0, toCheck: 0 };

  const out = pieces.map((p) => {
    const hit = findRow(p, idx);
    if (!hit.row) {
      summary.unmatched.push(p.cust_style_no || p.stock_no);
      return { ...p, main_ws: { found: false, notes: ["why" in hit ? hit.why : "Not found."] } };
    }
    summary.matched++;
    const r = hit.row;
    const lab = isLabGrown(p, r.mined_or_lab);
    const { shape, grade } = parseShapeGrade(r.shape_grade);
    const certs = rowCertificates(r, lab);
    const notes: string[] = [];
    const conflict = typeConflict(p, r.mined_or_lab);
    if (conflict) notes.push(conflict);

    let rows = p.diamonds;
    let ci = (certs.length || grade) ? centreRowIndex(rows, r.centre) : null;
    if (ci === null && (certs.length || grade)) {
      const split = splitCentre(rows, r.centre, shape);
      if (split) {
        const d = rows[split.index];
        notes.push(`Split ${d.shape} ${d.pcs} pcs / ${d.cts.toFixed(2)} ct into the ${r.centre.split("/")[1]} ct centre stone`
          + ` + ${d.pcs - 1} pcs / ${d.cts.minus(split.rows[split.index].cts).toFixed(2)} ct, as Main WS lists it. Price both rows.`);
        rows = split.rows;
        ci = split.index;
      }
    }
    let filledCert = false;
    let filledGrade = false;
    const diamonds = rows.map((d, i) => {
      if (i !== ci) return d;
      const n = { ...d };
      if (certs.length === 1 && d.pcs === 1 && !d.certificate_no) { n.certificate_no = certs[0]; filledCert = true; }
      if (grade && !d.color_clarity) { n.color_clarity = grade; filledGrade = true; }
      return n;
    });

    if (certs.length > 1) notes.push(`Main WS lists ${certs.length} certificates (${certs.join(", ")}) — type the one for this stone.`);
    if ((certs.length || grade) && ci === null) {
      const c = r.centre.trim() || "no centre stone";
      notes.push(`Main WS centre stone (${c}) doesn't match a single stone row here, so nothing was filled.`);
    }
    if (filledCert) summary.certificates++;
    if (filledGrade) summary.grades++;
    if (notes.length) summary.toCheck++;

    const match: MainWsMatch = {
      found: true, by: hit.by, row: r.row,
      customer: r.customer, ship_to: r.ship_to, job_no: r.job_no, item_no: r.item_no, status: r.status,
      mined_or_lab: r.mined_or_lab, centre: r.centre, side: r.side,
      shape, grade, certificates: certs, centre_row: ci,
      filled_certificate: filledCert, filled_grade: filledGrade, notes,
    };
    return { ...p, diamonds, main_ws: match };
  });
  return { pieces: out, summary };
}

// ── buyer ────────────────────────────────────────────────────────────────────

/** Main WS "ShipTo" account → the buyer it invoices to (matched on the seeded
 *  buyers' city / country, so renaming a buyer doesn't break it). */
const SHIP_TO: Record<string, { city?: string; country?: string }> = {
  "WS-SYD": { city: "SYDNEY" },
  "WS-MEL": { city: "MELBOURNE" },
  "WS-BNE": { city: "BRISBANE" },
  "WS-NZ": { country: "NEW ZEALAND" },
  "WS-UK": { country: "UNITED KINGDOM" },
  "ITALY": { country: "ITALY" },
  "DM-USA": { country: "USA" },
};

export function buyerForShipTo(code: string, buyers: Buyer[]): Buyer | null {
  const want = SHIP_TO[norm(code)];
  if (!want) return null;
  const hits = buyers.filter((b) =>
    (!want.city || norm(b.city) === norm(want.city)) && (!want.country || norm(b.country) === norm(want.country)));
  return hits.length === 1 ? hits[0] : null;
}

export interface BuyerSuggestion {
  /** ShipTo code → piece count, largest first. */
  counts: [string, number][];
  /** Every matched piece ships to the same account. */
  unanimous: boolean;
  /** Buyer for the largest ShipTo, when one is set up. */
  buyer: Buyer | null;
  code: string;
}

/** Which buyer Main WS points at for the given pieces. Main WS ShipTo follows
 *  the piece's region, and EXP615 / EXP616 (Brisbane) carried M, B and S
 *  pieces — so a mixed answer is a hint for the clerk, not a decision. */
export function suggestBuyer(pieces: Piece[], buyers: Buyer[]): BuyerSuggestion | null {
  const counts = new Map<string, number>();
  for (const p of pieces) {
    const c = p.main_ws?.found ? (p.main_ws.ship_to ?? "").trim().toUpperCase() : "";
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [code] = sorted[0];
  return { counts: sorted, unanimous: sorted.length === 1, buyer: buyerForShipTo(code, buyers), code };
}
