/** Step 1 — pick or drop the SDJ-JB packing list (only its "Packing List" sheet
 *  is read), plus, optionally, the Main WS tab of the Main File. */
import { useRef, useState } from "react";
import clsx from "clsx";
import { Check, CircleDot, FileSpreadsheet, Sheet, Trash2, UploadCloud, WandSparkles } from "lucide-react";
import type { MainWsSummary } from "../../lib/mainws";
import { Callout, Card, Spinner, plural } from "../ui";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The whole Main File as .xlsx is big; the Main WS CSV is a few MB. */
export const MAX_MAIN_BYTES = 60 * 1024 * 1024;
const ACCEPT = /\.(xls|xlsx)$/i;
const ACCEPT_MAIN = /\.(csv|xlsx|xls)$/i;

export function UploadStep(props: {
  files: File[]; setFiles: (f: File[]) => void; parsedCount: number;
  mainFile: File | null; setMainFile: (f: File | null) => void;
  mainSummary: MainWsSummary | null; mainBusy: boolean; onApplyMain: () => void;
}) {
  const { files, setFiles, parsedCount, mainFile, setMainFile, mainSummary, mainBusy, onApplyMain } = props;
  const [drag, setDrag] = useState(false);
  const [dragMain, setDragMain] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [rejectedMain, setRejectedMain] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLInputElement>(null);

  function add(list: FileList | null) {
    if (!list) return;
    const incoming = Array.from(list);
    const ok = incoming.filter((f) => ACCEPT.test(f.name));
    setRejected(incoming.filter((f) => !ACCEPT.test(f.name)).map((f) => f.name));
    // Same name twice = the same file picked again; keep the newest copy.
    const byName = new Map(files.map((f) => [f.name, f]));
    for (const f of ok) byName.set(f.name, f);
    setFiles([...byName.values()]);
  }
  function addMain(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    if (!ACCEPT_MAIN.test(f.name)) { setRejectedMain(f.name); return; }
    setRejectedMain(null);
    setMainFile(f);
  }

  return (
    <div className="stack">
      <Card icon={FileSpreadsheet} title="Packing list"
            desc={<>The <code>SDJ-JB-&lt;nnn&gt; … .xls</code> file from Swan. Only its <strong>Packing List</strong> sheet is read — the tax-invoice sheet is ignored.</>}>
        <div
          className={clsx("dropzone", { drag })}
          role="button" tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        >
          <div className="dropzone-icon"><UploadCloud size={24} /></div>
          <div className="dropzone-title">Drop the file here, or <u>browse</u></div>
          <div className="hint-small">.xls or .xlsx · add several files to merge them (a stock no. that repeats is kept once)</div>
          <input ref={inputRef} type="file" accept=".xls,.xlsx" multiple
                 onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        </div>

        {files.length > 0 && (
          <div className="file-list">
            {files.map((f) => (
              <div className="file-row" key={f.name}>
                <span className="file-icon"><FileSpreadsheet size={18} /></span>
                <div className="grow">
                  <div className="file-name" title={f.name}>{f.name}</div>
                  <div className={clsx("file-meta", { err: f.size > MAX_FILE_BYTES })}>
                    {(f.size / 1024).toFixed(1)} KB{f.size > MAX_FILE_BYTES ? " — over 10 MB, is this the right file?" : ""}
                  </div>
                </div>
                <button className="btn ghost small icon" title="Remove file" aria-label={`Remove ${f.name}`}
                        onClick={() => setFiles(files.filter((x) => x !== f))}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}
        {rejected.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="warn" title="Skipped — not an Excel file">{rejected.join(", ")}</Callout>
          </div>
        )}
        {parsedCount > 0 && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="ok">{parsedCount} pieces are already loaded. Reading the file again replaces them and clears any rates you typed.</Callout>
          </div>
        )}
      </Card>

      <Card icon={Sheet} title="Main File" desc="Optional. Fills certificate numbers, centre-stone colour & clarity, and suggests the buyer.">
        {!mainFile ? (
          <div
            className={clsx("dropzone compact", { drag: dragMain })}
            role="button" tabIndex={0}
            onClick={() => mainRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); mainRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setDragMain(true); }}
            onDragLeave={() => setDragMain(false)}
            onDrop={(e) => { e.preventDefault(); setDragMain(false); addMain(e.dataTransfer.files); }}
          >
            <div className="dropzone-icon"><UploadCloud size={20} /></div>
            <div>
              <div className="dropzone-title">Drop the Main WS download, or <u>browse</u></div>
              <div className="hint-small">.csv of the Main WS tab (quickest), or the whole Main File as .xlsx</div>
            </div>
            <input ref={mainRef} type="file" accept=".csv,.xlsx,.xls"
                   onChange={(e) => { addMain(e.target.files); e.target.value = ""; }} />
          </div>
        ) : (
          <div className="file-row">
            <span className="file-icon"><Sheet size={18} /></span>
            <div className="grow">
              <div className="file-name" title={mainFile.name}>{mainFile.name}</div>
              <div className={clsx("file-meta", { err: mainFile.size > MAX_MAIN_BYTES })}>
                {mainFile.size < 1024 * 1024 ? `${(mainFile.size / 1024).toFixed(1)} KB` : `${(mainFile.size / 1024 / 1024).toFixed(1)} MB`}
                {mainFile.size > MAX_MAIN_BYTES ? " — too big; download just the Main WS tab as .csv" : ""}
              </div>
            </div>
            <button className="btn ghost small icon" title="Remove file" aria-label={`Remove ${mainFile.name}`}
                    onClick={() => setMainFile(null)}><Trash2 size={15} /></button>
          </div>
        )}
        {rejectedMain && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="warn" title="Skipped — not a .csv or Excel file">{rejectedMain}</Callout>
          </div>
        )}
        {!mainFile && (
          <ol className="howto">
            <li>Open the <strong>Main File</strong> in Google Sheets and click the <strong>Main WS</strong> tab.</li>
            <li><strong>File → Download → Comma-separated values (.csv)</strong>. This saves just that tab.</li>
            <li>Drop the downloaded file here. Download it again for each shipment, so new certificates are in it.</li>
          </ol>
        )}
        {mainSummary && (
          <div style={{ marginTop: 12 }}>
            <Callout tone={mainSummary.matched ? "ok" : "warn"} title={`Found ${mainSummary.matched} of ${plural(mainSummary.matched + mainSummary.unmatched.length, "piece")} in Main WS`}>
              Filled {plural(mainSummary.certificates, "certificate")} and {plural(mainSummary.grades, "grade")}.
              {mainSummary.toCheck > 0 && <> {plural(mainSummary.toCheck, "piece")} {mainSummary.toCheck === 1 ? "has" : "have"} a note on the Pieces step.</>}
            </Callout>
          </div>
        )}
        {mainFile && parsedCount > 0 && (
          <div className="card-actions">
            <button className="btn" onClick={onApplyMain} disabled={mainBusy || mainFile.size > MAX_MAIN_BYTES}>
              {mainBusy ? <><Spinner /> Reading…</> : <><WandSparkles size={16} /> Fill the loaded pieces</>}
            </button>
            <span className="hint-small">Only empty cells are filled — rates and anything you typed stay.</span>
          </div>
        )}
      </Card>

      <div className="split-2">
        <Card title="Read from the files">
          <ul className="ticks">
            <li><Check size={15} />Style, item, KT, colour, quantity</li>
            <li><Check size={15} />Gross and net weight</li>
            <li><Check size={15} />Stone pieces and carats per shape, incl. colour stones</li>
            <li><Check size={15} />Labour ₹/g, region and product category</li>
            <li><Check size={15} />From the Main File: certificate, centre-stone grade, ship-to account</li>
          </ul>
        </Card>
        <Card title="You fill in next">
          <ul className="ticks todo">
            <li><CircleDot size={15} />USD/ct for each stone row, plus any certificate or grade the Main File lacks</li>
            <li><CircleDot size={15} />Invoice no., buyer and bank</li>
            <li><CircleDot size={15} />Gold rate, purchase invoice and exchange rates</li>
            <li><CircleDot size={15} />Package weight and any freight or discount</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
