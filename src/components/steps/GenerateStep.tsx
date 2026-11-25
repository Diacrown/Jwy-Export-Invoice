/** Step 5 — build the workbook, save everything, download. */
import { CloudUpload, Database, Download, FileSpreadsheet, ReceiptText } from "lucide-react";
import { Callout, Card } from "../ui";

export interface GenerateResult { invoice_id: string; replaced: boolean; fileName: string; blob: Blob }

export function GenerateStep(props: {
  result: GenerateResult | null; canEdit: boolean; invoiceNumber: string;
  onNewInvoice: () => void; onViewInvoices: () => void;
}) {
  const { result, canEdit, invoiceNumber, onNewInvoice, onViewInvoices } = props;

  function downloadAgain() {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a"); a.href = url; a.download = result.fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  if (result) {
    return (
      <Card>
        <div className="done-panel">
          <div className="done-ico"><ReceiptText size={28} /></div>
          <h2>{result.replaced ? "Invoice re-generated" : "Invoice generated"}</h2>
          <p>The workbook has downloaded and is saved{result.replaced ? ", replacing the earlier save of this invoice number" : ""}.
            You can download it again from Invoices at any time.</p>
          <div className="file-chip"><FileSpreadsheet size={15} /> {result.fileName}</div>
          <div className="actions">
            <button className="btn" onClick={downloadAgain}><Download size={16} /> Download again</button>
            <button className="btn" onClick={onViewInvoices}>View invoices</button>
            <button className="btn primary" onClick={onNewInvoice}>Start a new invoice</button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="stack">
      {!canEdit && <Callout tone="warn" title="Read-only account">Saving needs the accounts or admin role, so the save will be refused.</Callout>}
      <Card icon={FileSpreadsheet} title={`Generate ${invoiceNumber || "the invoice"}`}
            desc="Builds the MASTER DETAILS workbook and saves this invoice. Generating the same invoice number again replaces the earlier save.">
        <ol className="plan">
          <li><span className="plan-ico"><FileSpreadsheet size={17} /></span>
            <div><div className="plan-title">Build the workbook</div><div className="plan-desc">INVOICE and CUSTOMS PL sheets with live formulas, made in your browser.</div></div></li>
          <li><span className="plan-ico"><CloudUpload size={17} /></span>
            <div><div className="plan-title">Store the files</div><div className="plan-desc">The packing list and the generated workbook go to secure storage.</div></div></li>
          <li><span className="plan-ico"><Database size={17} /></span>
            <div><div className="plan-title">Save the records</div><div className="plan-desc">Invoice, lots, pieces, stone rows, base lock per piece, gold drawdown and the stones register.</div></div></li>
          <li><span className="plan-ico"><Download size={17} /></span>
            <div><div className="plan-title">Download the .xlsx</div><div className="plan-desc">Ready to print and ship with the parcel.</div></div></li>
        </ol>
      </Card>
    </div>
  );
}
