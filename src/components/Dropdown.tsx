/** Overridable dropdown that reads from a Supabase lookup table.
 *
 * Props:
 *   lookupKey: which lookup table to read
 *   value / onChange: the id of the picked row
 *   allowAdd: whether to show the inline "Add new…" row
 *
 * The user can type to filter options. Picking "Add new…" inserts a row and
 * selects it in one go. Reads are cached in-memory for the component's life.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import type { LookupKey, LookupOption } from "../storage/lookups";
import { fetchLookup, insertLookup } from "../storage/lookups";

export interface DropdownProps {
  lookupKey: LookupKey;
  value: string | null;
  onChange: (opt: LookupOption | null) => void;
  allowAdd?: boolean;
  placeholder?: string;
}

export function Dropdown({ lookupKey, value, onChange, allowAdd = true, placeholder }: DropdownProps) {
  const [options, setOptions] = useState<LookupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetchLookup(lookupKey)
      .then((rows) => { if (active) { setOptions(rows); setLoading(false); } })
      .catch((e) => { if (active) { console.error(e); setLoading(false); } });
    return () => { active = false; };
  }, [lookupKey]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = options.find((o) => o.id === value) ?? null;
  const filtered = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;
  const canAddExact = allowAdd && filter.trim() && !options.some((o) => o.label.toLowerCase() === filter.trim().toLowerCase());

  async function addNew(label: string) {
    try {
      const row = await insertLookup(lookupKey, label.trim());
      setOptions((prev) => [...prev, row].sort((a, b) => a.label.localeCompare(b.label)));
      setOpen(false);
      setFilter("");
      onChange(row);
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Could not add: ${(e as Error).message}`);
    }
  }

  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="dropdown-trigger" onClick={() => setOpen((o) => !o)} disabled={loading}>
        {loading ? "loading…" : current?.label ?? <span className="muted">{placeholder ?? "— pick —"}</span>}
      </button>
      {open && (
        <div className="dropdown-menu">
          <input
            className="dropdown-filter"
            placeholder="type to filter or add"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {filtered.map((o) => (
            <div
              key={o.id}
              className={clsx("dropdown-item", { "pill-ok": o.id === value })}
              onClick={() => { onChange(o); setOpen(false); setFilter(""); }}
            >
              {o.label}
            </div>
          ))}
          {canAddExact && (
            <div className="dropdown-item add-new" onClick={() => addNew(filter)}>
              + Add &quot;{filter.trim()}&quot;
            </div>
          )}
          {!filtered.length && !canAddExact && (
            <div className="dropdown-item muted">no matches</div>
          )}
        </div>
      )}
    </div>
  );
}
