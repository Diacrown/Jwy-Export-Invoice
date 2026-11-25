/** Reads the Main File's "Main WS" tab — downloaded from Google Sheets as CSV
 *  (File → Download → Comma-separated values, which saves just that tab) or
 *  the whole Main File as .xlsx. Columns are found by their header text. */
import * as XLSX from "xlsx";
import type { MainWsRow } from "../types";

export const MAIN_WS_SHEET = "Main WS";

const h = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[.:]+$/, "").trim();

function findHeader(grid: string[][]): number {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const cells = grid[r].map(h);
    if (cells.includes("jobno") && cells.includes("itemno")) return r;
  }
  return -1;
}

function rowsFromGrid(grid: string[][]): MainWsRow[] | null {
  const hr = findHeader(grid);
  if (hr < 0) return null;
  const head = grid[hr].map(h);
  const first = (...names: string[]) => {
    for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const all = (name: string) => head.flatMap((x, i) => (x === name ? [i] : []));
  const col = {
    customer: first("customer", "customer name"),
    loc: first("loc", "location"),
    ship_to: first("shipto", "ship to"),
    job_no: first("jobno", "job no"),
    item_no: first("itemno", "item no"),
    style_code: first("style code"),
    status: first("status"),
    vendor: first("vendor"),
    ship_date: first("ship date"),
    centre: first("center diam details", "centre diam details", "center dia details"),
    side: first("side diam details", "side dia details"),
    mined_or_lab: first("mined or lab"),
    shape_grade: first("shape col/clarity", "shape col / clarity"),
    shape: first("shape"),
    grade: first("col/clarity", "col / clarity"),
  };
  const certs = all("cert no");
  const remarks = all("remarks");
  const get = (cells: string[], i: number) => (i >= 0 ? String(cells[i] ?? "").trim() : "");

  const out: MainWsRow[] = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const c = grid[r];
    if (!c) continue;
    const job = get(c, col.job_no);
    const item = get(c, col.item_no);
    if (!job && !item) continue;
    const shapeGrade = col.shape_grade >= 0 ? get(c, col.shape_grade) : [get(c, col.shape), get(c, col.grade)].filter(Boolean).join(" ");
    out.push({
      row: r + 1,
      customer: get(c, col.customer), loc: get(c, col.loc), ship_to: get(c, col.ship_to),
      job_no: job, item_no: item, style_code: get(c, col.style_code),
      status: get(c, col.status), vendor: get(c, col.vendor), ship_date: get(c, col.ship_date),
      centre: get(c, col.centre), side: get(c, col.side), mined_or_lab: get(c, col.mined_or_lab),
      shape_grade: shapeGrade,
      cert_cells: certs.map((i) => get(c, i)).filter(Boolean),
      remark_cells: remarks.map((i) => get(c, i)).filter(Boolean),
    });
  }
  return out;
}

const toGrid = (ws: XLSX.WorkSheet) =>
  XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: true });

/** Parse a Main WS export. Throws a plain-language error for the wrong file. */
export async function parseMainWs(file: Blob, fileName = (file as File).name ?? "main file"): Promise<MainWsRow[]> {
  let grids: string[][][];
  if (/\.(csv|tsv|txt)$/i.test(fileName)) {
    // raw: keep "7763-04", "1/2.50" and "D/VS1" as typed — never as dates or numbers.
    const wb = XLSX.read(await file.text(), { type: "string", raw: true });
    grids = wb.SheetNames.map((n) => toGrid(wb.Sheets[n]));
  } else {
    const buf = await file.arrayBuffer();
    const names = XLSX.read(buf, { type: "array", bookSheets: true }).SheetNames;
    // The whole Main File is large; parse only Main WS when it's there.
    const wanted = names.filter((n) => n.trim().toLowerCase() === MAIN_WS_SHEET.toLowerCase());
    const wb = XLSX.read(buf, { type: "array", ...(wanted.length ? { sheets: wanted } : {}) });
    grids = (wanted.length ? wanted : wb.SheetNames).map((n) => toGrid(wb.Sheets[n]));
  }
  for (const g of grids) {
    const rows = rowsFromGrid(g);
    if (rows) {
      if (!rows.length) throw new Error(`${fileName} has the Main WS headings but no rows.`);
      return rows;
    }
  }
  throw new Error(
    `${fileName} doesn't look like the Main WS tab — expecting JobNo, ItemNo and Cert No. columns. ` +
    "In Google Sheets open the Main File, go to the Main WS tab, then File → Download → Comma-separated values (.csv).",
  );
}
