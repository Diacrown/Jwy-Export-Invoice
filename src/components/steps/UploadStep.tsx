/** Step 1 — pick or drop the SDJ-JB packing list (only its "Packing List" sheet is read). */
import { useRef, useState } from "react";
import clsx from "clsx";
import { Check, CircleDot, FileSpreadsheet, Trash2, UploadCloud } from "lucide-react";
import { Callout, Card } from "../ui";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = /\.(xls|xlsx)$/i;

export function UploadStep(props: { files: File[]; setFiles: (f: File[]) => void; parsedCount: number }) {
  const { files, setFiles, parsedCount } = props;
  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

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

      <div className="split-2">
        <Card title="Read from the sheet">
          <ul className="ticks">
            <li><Check size={15} />Style, item, KT, colour, quantity</li>
            <li><Check size={15} />Gross and net weight</li>
            <li><Check size={15} />Stone pieces and carats per shape, incl. colour stones</li>
            <li><Check size={15} />Labour ₹/g, region and product category</li>
          </ul>
        </Card>
        <Card title="You fill in next">
          <ul className="ticks todo">
            <li><CircleDot size={15} />Certificate, grade and USD/ct for each stone row</li>
            <li><CircleDot size={15} />Invoice no., buyer and bank</li>
            <li><CircleDot size={15} />Gold rate, purchase invoice and exchange rates</li>
            <li><CircleDot size={15} />Package weight and any freight or discount</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
