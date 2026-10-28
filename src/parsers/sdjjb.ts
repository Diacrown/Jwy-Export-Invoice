/** SDJ-JB vendor-invoice parser. Pulls out labor rates per KT. */
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

export interface SdjjbData {
  vendor_invoice_no: string | null;
  vendor_invoice_date: string | null;
  lines: Array<{
    kt: string | null;
    description: string;
    qty: number;
    gross_wt: Decimal;
    net_wt: Decimal;
    diamond_cts: Decimal;
    labor_rate_inr_per_gm: Decimal;
    total_inr: Decimal;
  }>;
  labor_rate_by_kt: Record<string, Decimal>;
  grand_total_inr: Decimal;
}

const KT_PATTERNS: Array<[string, string[]]> = [
  ["18-PD", ["18 KT PALLADIUM", "18KT PALLADIUM", "18 KT PD", "PALLADIUM"]],
  ["18", ["18 KT", "18KT"]],
  ["14", ["14 KT", "14KT"]],
  ["9", ["9 KT", "9KT"]],
];

function ktFromDesc(desc: string): string | null {
  const d = (desc ?? "").toUpperCase();
  for (const [kt, pats] of KT_PATTERNS) if (pats.some((p) => d.includes(p))) return kt;
  return null;
}
const dec = (v: unknown) => { if (v === null || v === undefined || v === "") return new Decimal(0); try { return new Decimal(String(v)); } catch { return new Decimal(0); } };

export async function parseSdjjb(file: Blob): Promise<SdjjbData> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const ref = ws["!ref"];
  if (!ref) throw new Error("SDJ-JB: empty sheet");
  const range = XLSX.utils.decode_range(ref);

  const data: SdjjbData = {
    vendor_invoice_no: null,
    vendor_invoice_date: null,
    lines: [],
    labor_rate_by_kt: {},
    grand_total_inr: new Decimal(0),
  };

  // Header-area scrape for invoice no / date
  for (let r = 0; r < Math.min(20, range.e.r + 1); r++) {
    for (let c = 0; c < Math.min(20, range.e.c + 1); c++) {
      const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
      if (typeof v === "string") {
        if (v.toUpperCase().includes("INVOICE NO")) {
          const next = ws[XLSX.utils.encode_cell({ r, c: c + 1 })]?.v;
          data.vendor_invoice_no = next ? String(next).trim() : null;
        } else if (v.toUpperCase().includes("INVOICE DATE")) {
          const next = ws[XLSX.utils.encode_cell({ r, c: c + 1 })]?.v;
          data.vendor_invoice_date = next ? String(next).trim() : null;
        }
      }
    }
  }

  for (let r = 0; r <= range.e.r; r++) {
    // Column C (index 2) = description, E (4) = qty, F (5) = gross, G (6) = net,
    // H (7) = dia cts, J (9) = labor rate, K (10) = total
    const desc = ws[XLSX.utils.encode_cell({ r, c: 2 })]?.v;
    if (typeof desc === "string" && desc.toUpperCase().includes("MAKING CHARGES")) {
      const kt = ktFromDesc(desc);
      const line = {
        kt,
        description: desc,
        qty: Number(ws[XLSX.utils.encode_cell({ r, c: 4 })]?.v ?? 0) | 0,
        gross_wt: dec(ws[XLSX.utils.encode_cell({ r, c: 5 })]?.v),
        net_wt: dec(ws[XLSX.utils.encode_cell({ r, c: 6 })]?.v),
        diamond_cts: dec(ws[XLSX.utils.encode_cell({ r, c: 7 })]?.v),
        labor_rate_inr_per_gm: dec(ws[XLSX.utils.encode_cell({ r, c: 9 })]?.v),
        total_inr: dec(ws[XLSX.utils.encode_cell({ r, c: 10 })]?.v),
      };
      data.lines.push(line);
      if (kt && line.labor_rate_inr_per_gm.gt(0)) data.labor_rate_by_kt[kt] = line.labor_rate_inr_per_gm;
    }
    if (typeof desc === "string" && desc.toUpperCase().includes("GRAND TOTAL")) {
      data.grand_total_inr = dec(ws[XLSX.utils.encode_cell({ r, c: 10 })]?.v);
    }
  }

  return data;
}
