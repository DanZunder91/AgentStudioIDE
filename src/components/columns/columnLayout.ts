/**
 * Resizable + hideable columns, shared by the Logs and Network tables (columns must be
 * resizable, and hideable too).
 *
 * One store for every table, keyed by a view key (`"network.ide"`, `"logs"`, …), so a tab
 * switch or remount keeps the user's widths and hidden set. Not persisted to disk yet —
 * that needs a `layout-prefs.json` field and its single writer.
 */

import { create } from "zustand";

export interface ColumnDef {
  id: string;
  label: string;
  /** Default width in px. */
  width: number;
  /** Narrowest the user may drag it to. */
  minWidth?: number;
  /** A column the user may not hide (e.g. the row's identity). */
  required?: boolean;
  /** Takes the remaining space instead of a fixed width (at most one per table). */
  flex?: boolean;
}

export interface ColumnLayout {
  widths: Record<string, number>;
  hidden: string[];
  /**
   * Columns the user explicitly ticked on in Columns ▾. A table that hides low-priority columns
   * to fit a narrow pane (Network, `networkColumns.fitColumns`) never auto-hides these.
   */
  shown?: string[];
}

interface ColumnLayoutState {
  layouts: Record<string, ColumnLayout>;
}

export const DEFAULT_MIN_WIDTH = 40;

export const useColumnLayoutStore = create<ColumnLayoutState>()(() => ({ layouts: {} }));

const layoutOf = (viewKey: string): ColumnLayout =>
  useColumnLayoutStore.getState().layouts[viewKey] ?? { widths: {}, hidden: [] };

const put = (viewKey: string, next: ColumnLayout): void =>
  useColumnLayoutStore.setState((s) => ({ layouts: { ...s.layouts, [viewKey]: next } }));

/** The width to render: the user's, clamped to the column's minimum, else the default. */
export function widthOf(def: ColumnDef, layout: ColumnLayout): number {
  const min = def.minWidth ?? DEFAULT_MIN_WIDTH;
  return Math.max(min, layout.widths[def.id] ?? def.width);
}

export function setColumnWidth(viewKey: string, def: ColumnDef, width: number): void {
  const l = layoutOf(viewKey);
  const min = def.minWidth ?? DEFAULT_MIN_WIDTH;
  put(viewKey, { ...l, widths: { ...l.widths, [def.id]: Math.max(min, Math.round(width)) } });
}

export function resetColumnWidth(viewKey: string, id: string): void {
  const l = layoutOf(viewKey);
  const widths = { ...l.widths };
  delete widths[id];
  put(viewKey, { ...l, widths });
}

/** Hide or show a column. A required column, or the last visible one, cannot be hidden. */
export function setColumnHidden(viewKey: string, defs: readonly ColumnDef[], id: string, hidden: boolean): void {
  const l = layoutOf(viewKey);
  const def = defs.find((d) => d.id === id);
  if (!def) return;
  const shown = l.shown ?? [];
  if (!hidden) {
    // Ticking a column on is an explicit choice: remembered, so a fit-to-width never undoes it.
    put(viewKey, { ...l, hidden: l.hidden.filter((h) => h !== id), shown: shown.includes(id) ? shown : [...shown, id] });
    return;
  }
  const visible = defs.filter((d) => !l.hidden.includes(d.id));
  if (def.required || visible.length <= 1 || l.hidden.includes(id)) return;
  put(viewKey, { ...l, hidden: [...l.hidden, id], shown: shown.filter((s) => s !== id) });
}

export function resetColumns(viewKey: string): void {
  put(viewKey, { widths: {}, hidden: [] });
}

/** Visible columns in order, each with its resolved width. */
export function visibleColumns(defs: readonly ColumnDef[], layout: ColumnLayout): Array<ColumnDef & { px: number }> {
  return defs.filter((d) => !layout.hidden.includes(d.id)).map((d) => ({ ...d, px: widthOf(d, layout) }));
}

/** A CSS `grid-template-columns` for div-based rows (the Logs list). */
export function gridTemplate(cols: ReadonlyArray<ColumnDef & { px: number }>): string {
  return cols.map((c) => (c.flex ? `minmax(${c.minWidth ?? DEFAULT_MIN_WIDTH}px, 1fr)` : `${c.px}px`)).join(" ");
}

/** React hook: the layout for one table. */
export function useColumnLayout(viewKey: string): ColumnLayout {
  return useColumnLayoutStore((s) => s.layouts[viewKey]) ?? EMPTY;
}
const EMPTY: ColumnLayout = { widths: {}, hidden: [] };
