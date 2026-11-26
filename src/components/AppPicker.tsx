/** "All apps, or pick some", shared by Logs and Network. `selected === null` means ALL, distinct
 * from `[]`, so a later app is included under All and excluded under a pick. Searchable checklist
 * with an All row and per-row **Only**; Esc and outside click close it. */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import "./appPicker.css";
import { usePopoverFlip } from "./usePopoverFlip";

export interface AppPickerItem {
  id: string;
  label: string;
  sublabel?: string;
  count?: number;
}

export interface AppPickerProps {
  items: AppPickerItem[];
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  /** Noun for the trigger, plural: "apps", "sources". */
  noun?: string;
  /** Accessible name for the trigger. */
  label: string;
  disabled?: boolean;
  /** Shown as the trigger's title when disabled (a disabled control must say why). */
  disabledReason?: string;
  /** Called when the popover opens — e.g. to re-read a live list (running apps). */
  onOpen?: () => void;
}

export function summarize(selected: string[] | null, items: AppPickerItem[], noun: string): string {
  if (selected === null) return `All ${noun}`;
  if (selected.length === 0) return `No ${noun}`;
  if (selected.length === 1) return items.find((i) => i.id === selected[0])?.label ?? selected[0];
  return `${selected.length} ${noun}`;
}

export function AppPicker({
  items, selected, onChange, noun = "apps", label, disabled = false, disabledReason, onOpen,
}: AppPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  usePopoverFlip(open, popRef, "app-picker__pop--flip");
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      // The ref is attached whenever the popover is open, so it is never null here.
      if (!(root.current as HTMLDivElement).contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.sublabel ?? ""}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const isOn = (id: string) => selected === null || selected.includes(id);
  const toggle = (id: string) => {
    const base = selected ?? items.map((i) => i.id);
    onChange(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  return (
    <div className="app-picker" ref={root}>
      <button
        type="button"
        className="app-picker__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {summarize(selected, items, noun)} ▾
      </button>
      {open && (
        <div ref={popRef} className="app-picker__pop">
          <input
            className="app-picker__search"
            aria-label={`Search ${noun}`}
            placeholder={`Search ${noun}…`}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul id={listId} role="listbox" aria-multiselectable="true" className="app-picker__list">
            <li role="option" aria-selected={selected === null} className="app-picker__row app-picker__row--all">
              <label>
                <input type="checkbox" checked={selected === null} onChange={() => onChange(selected === null ? [] : null)} />
                <span>All {noun}</span>
              </label>
            </li>
            {visible.map((i) => (
              <li key={i.id} role="option" aria-selected={isOn(i.id)} className="app-picker__row">
                <label>
                  <input
                    type="checkbox"
                    aria-label={i.sublabel ? `${i.label} — ${i.sublabel}` : i.label}
                    checked={isOn(i.id)}
                    onChange={() => toggle(i.id)}
                  />
                  <span className="app-picker__label">{i.label}</span>
                  {i.sublabel && <span className="app-picker__sub">{i.sublabel}</span>}
                  {i.count !== undefined && <span className="app-picker__count">{i.count}</span>}
                </label>
                <button type="button" className="app-picker__only" onClick={() => onChange([i.id])}>
                  Only
                </button>
              </li>
            ))}
            {visible.length === 0 && <li className="app-picker__empty">No {noun} match “{query}”</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
