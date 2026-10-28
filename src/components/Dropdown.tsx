/** Overridable dropdown that reads from a Supabase lookup table.
 *
 * Keyboard support: Enter opens, Esc closes, Arrow Up/Down navigates,
 * Enter picks. Touch-friendly (44px min targets). Filter box auto-focuses.
 */
import { useEffect, useRef, useState } from "react";

import type { LookupKey, LookupOption } from "../storage/lookups";
import { fetchLookup, insertLookup } from "../storage/lookups";
import { useToast } from "./Toast";

export interface DropdownProps {
  lookupKey: LookupKey;
  value: string | null;
  onChange: (opt: LookupOption | null) => void;
  allowAdd?: boolean;
  placeholder?: string;
  invalid?: boolean;
}

export function Dropdown({ lookupKey, value, onChange, allowAdd = true, placeholder, invalid }: DropdownProps) {
  const toast = useToast();
  const [options, setOptions] = useState<LookupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetchLookup(lookupKey)
      .then((rows) => { if (active) { setOptions(rows); setLoading(false); } })
      .catch((e) => { if (active) { toast.error("Could not load options", (e as Error).message); setLoading(false); } });
    return () => { active = false; };
  }, [lookupKey, toast]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const current = options.find((o) => o.id === value) ?? null;
  const filtered = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;
  const canAddExact = allowAdd && filter.trim() && !options.some((o) => o.label.toLowerCase() === filter.trim().toLowerCase());
  const totalRows = filtered.length + (canAddExact ? 1 : 0);

  async function addNew(label: string) {
    try {
      const row = await insertLookup(lookupKey, label.trim());
      setOptions((prev) => [...prev, row].sort((a, b) => a.label.localeCompare(b.label)));
      setOpen(false);
      setFilter("");
      onChange(row);
      toast.success("Added", `${lookupKey.replace("_", " ")}: ${row.label}`);
    } catch (e) {
      toast.error("Could not add", (e as Error).message);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusedIdx((i) => Math.min(i + 1, totalRows - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setFocusedIdx((i) => Math.max(0, i - 1)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIdx < filtered.length) {
        const o = filtered[focusedIdx];
        onChange(o); setOpen(false); setFilter("");
      } else if (canAddExact) {
        addNew(filter);
      }
    }
  }

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`dropdown-trigger ${invalid ? "invalid" : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={loading}
        aria-haspopup="listbox" aria-expanded={open}
      >
        {loading ? "loading…" : current?.label ?? <span className="muted">{placeholder ?? "— pick —"}</span>}
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          <input
            ref={inputRef}
            className="dropdown-filter"
            placeholder="type to filter or add"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setFocusedIdx(0); }}
            onKeyDown={onKey}
          />
          {filtered.map((o, i) => (
            <div
              key={o.id}
              className={`dropdown-item ${i === focusedIdx ? "focused" : ""} ${o.id === value ? "selected" : ""}`}
              onClick={() => { onChange(o); setOpen(false); setFilter(""); }}
              onMouseEnter={() => setFocusedIdx(i)}
              role="option" aria-selected={o.id === value}
            >
              {o.label}
            </div>
          ))}
          {canAddExact && (
            <div
              className={`dropdown-item add-new ${focusedIdx === filtered.length ? "focused" : ""}`}
              onClick={() => addNew(filter)}
              onMouseEnter={() => setFocusedIdx(filtered.length)}
            >
              + Add &quot;{filter.trim()}&quot;
            </div>
          )}
          {!filtered.length && !canAddExact && (
            <div className="dropdown-item muted" style={{ cursor: "default" }}>no matches</div>
          )}
        </div>
      )}
    </div>
  );
}
