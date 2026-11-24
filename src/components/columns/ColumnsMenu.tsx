/**
 * "Columns ▾": a checklist to show/hide a table's columns, plus "Reset columns". A required
 * column is shown checked and disabled; the last visible column cannot be unticked.
 */

import { useEffect, useRef, useState } from "react";

import { resetColumns, setColumnHidden, useColumnLayout, type ColumnDef } from "./columnLayout";
import "./columns.css";
import { usePopoverFlip } from "../usePopoverFlip";

const NONE: readonly string[] = [];
export const AUTO_HIDDEN_TITLE = "Hidden to fit this pane — tick to show it anyway";

export function ColumnsMenu({
  viewKey,
  defs,
  autoHidden = NONE,
}: {
  viewKey: string;
  defs: readonly ColumnDef[];
  /**
   * Columns the table hid by itself to fit a narrow pane (Network's `fitColumns`): listed
   * unticked, with why; ticking one shows it for good (`setColumnHidden` records it as shown).
   */
  autoHidden?: readonly string[];
}): React.JSX.Element {
  const layout = useColumnLayout(viewKey);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  usePopoverFlip(open, popRef, "cols-menu__pop--flip");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (!(root.current as HTMLDivElement).contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const visibleCount = defs.filter((d) => !layout.hidden.includes(d.id)).length;
  return (
    <div className="cols-menu" ref={root}>
      <button
        type="button"
        className="cols-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`columns-menu-${viewKey}`}
        onClick={() => setOpen(!open)}
      >
        Columns ▾
      </button>
      {open && (
        <div ref={popRef} className="cols-menu__pop" role="menu" aria-label="Columns">
          {defs.map((d) => {
            const auto = autoHidden.includes(d.id);
            const shown = !layout.hidden.includes(d.id) && !auto;
            const locked = d.required === true || (shown && visibleCount <= 1);
            const title = locked ? "This column can't be hidden" : auto ? AUTO_HIDDEN_TITLE : undefined;
            return (
              <label key={d.id} className="cols-menu__row" title={title}>
                <input
                  type="checkbox"
                  role="menuitemcheckbox"
                  aria-checked={shown}
                  checked={shown}
                  disabled={locked}
                  onChange={() => setColumnHidden(viewKey, defs, d.id, shown)}
                />
                <span>{d.label}</span>
              </label>
            );
          })}
          <button type="button" className="cols-menu__reset" onClick={() => resetColumns(viewKey)}>
            Reset columns
          </button>
        </div>
      )}
    </div>
  );
}
