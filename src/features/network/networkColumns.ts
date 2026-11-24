/**
 * The two Network tables' columns, for the shared resizable/hideable layout
 * (`components/columns`).
 *
 * Widths are px for a 12px monospace cell (≈7.2px per glyph) plus the cell's 6px + 6px
 * padding — a `ch` width counts glyphs, not padding. The one `flex` column
 * per table takes what the others leave; the table's `min-width` is the sum of the visible
 * fixed widths plus the flex column's floor, so the flex column never collapses to 0px in
 * a narrow pane (`table-layout: fixed` gives an `auto` column only the leftovers, which can be
 * zero) — the scroller scrolls sideways instead.
 */

import { DEFAULT_MIN_WIDTH, visibleColumns, type ColumnDef, type ColumnLayout } from "../../components/columns";

export const IDE_VIEW_KEY = "network.ide";
export const MACHINE_VIEW_KEY = "network.machine";

export type IdeColumnId =
  | "time" | "proto" | "method" | "host" | "path" | "status" | "type" | "size" | "dur" | "source" | "process";

export interface IdeColumn extends ColumnDef {
  id: IdeColumnId;
  /**
   * The width it may be squeezed to when the pane is too narrow for the defaults
   * ({@link fitColumns}): its common values still fit (glyphs × 7.2 + 12), a rare wide one
   * ellipsizes and keeps its full text in the cell's `title`. Default: its width.
   */
  compactWidth?: number;
  /**
   * Hidden by itself when the pane cannot hold every column ({@link fitColumns}) — lower goes
   * first. Absent = never auto-hidden. A column the user ticked on is never auto-hidden.
   */
  autoHide?: number;
}

/*
 * At the 1280 px window with both rails and the Apps sidebar, the table is ~440 px — without a
 * fit only Time / Proto / Method / Host were on screen, Status, Path and Source off
 * the right edge. DECIDED: Time, Proto, Method, Host, Path, Status and Source always fit (squeezed
 * toward `compactWidth`, with the TIGHT 3 px + 3 px cell padding — `Fit.tight`); Process, Size,
 * Duration and Type give way, in that order, until the user ticks one on in Columns ▾.
 * Compact widths are glyphs × 7.2 + 6 (tight padding): their common values still fit.
 */
export const IDE_COLUMNS: readonly IdeColumn[] = [
  // `20:58:58` is 8 glyphs = 58 px + 6.
  { id: "time", label: "Time", width: 74, minWidth: 74, required: true, compactWidth: 64 },
  // `TUNNEL` / `BYPASS`: 6 glyphs.
  { id: "proto", label: "Proto", width: 64, minWidth: 48, compactWidth: 50 },
  // `CONNECT`: 7 glyphs.
  { id: "method", label: "Method", width: 72, minWidth: 48, compactWidth: 58 },
  { id: "host", label: "Host", width: 220, minWidth: 80, compactWidth: 56 },
  { id: "path", label: "Path", width: 300, minWidth: 160, flex: true, compactWidth: 56 },
  // `not captured` (a bypassed command) is the widest status: 12 glyphs; `closed` is 6.
  { id: "status", label: "Status", width: 100, minWidth: 48, compactWidth: 50 },
  { id: "type", label: "Type", width: 150, minWidth: 60, autoHide: 3 },
  // A tunnel's `↑1023K ↓1023K` (formatSizeShort, 13 glyphs) is the widest size.
  { id: "size", label: "Size", width: 108, minWidth: 48, autoHide: 1 },
  { id: "dur", label: "Duration", width: 70, minWidth: 48, autoHide: 2 },
  // An agent's name (`claude`: 6 glyphs; a longer one ellipsizes, its title keeps it).
  { id: "source", label: "Source", width: 130, minWidth: 60, compactWidth: 60 },
  { id: "process", label: "Process", width: 110, minWidth: 60, autoHide: 0 },
];

export type MachineColumnId = "app" | "pid" | "conns" | "rateIn" | "rateOut" | "bytesIn" | "bytesOut";

export interface MachineColumn extends ColumnDef {
  id: MachineColumnId;
}

/** `1023.0KB/s` is 10 glyphs, `1023.0KB` 8, a pid 7 (networkColumns.browser.test.tsx). */
export const MACHINE_COLUMNS: readonly MachineColumn[] = [
  { id: "app", label: "App", width: 240, minWidth: 140, flex: true, required: true },
  { id: "pid", label: "PID", width: 68, minWidth: 48 },
  { id: "conns", label: "Conns", width: 68, minWidth: 48 },
  { id: "rateIn", label: "↓/s", width: 88, minWidth: 56 },
  { id: "rateOut", label: "↑/s", width: 88, minWidth: 56 },
  { id: "bytesIn", label: "↓ total", width: 80, minWidth: 56 },
  { id: "bytesOut", label: "↑ total", width: 80, minWidth: 56 },
];

/**
 * The table's floor: every visible fixed column at its width, the flex column at its minimum.
 * Below this the pane scrolls sideways rather than squeezing a column to nothing.
 */
export function tableMinWidth(cols: ReadonlyArray<ColumnDef & { px: number }>): number {
  return cols.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? DEFAULT_MIN_WIDTH) : c.px), 0);
}

/** A column as the table renders it: its width, and (flex) the floor the table's min-width counts. */
export type FittedColumn<C extends ColumnDef> = C & { px: number };

export interface Fit<C extends ColumnDef> {
  cols: FittedColumn<C>[];
  /** Columns hidden to fit (not by the user) — Columns ▾ lists them unticked. */
  autoHidden: string[];
  /** Step 4 squeezed the columns: the table uses the tight cell padding the compact widths assume. */
  tight: boolean;
}

/**
 * The columns to render in a table `available` px wide (the scroll box's client width; 0 =
 * unmeasured, e.g. jsdom → the plain layout). In order, stopping as soon as the table fits:
 *
 * 1. the defaults (the user's widths, hidden set);
 * 2. Host gives up to its `compactWidth` — the long one, ellipsized with its title;
 * 3. `autoHide` columns drop, lowest first, never one the user ticked on (`layout.shown`),
 *    Host re-growing into what each frees;
 * 4. every column the user did not size shrinks toward its `compactWidth` (Path below its
 *    160 px floor too) by one shared fraction — ONLY when that is enough to fit: squeezing
 *    columns and still scrolling sideways would lose on both counts, so then the table keeps
 *    its default widths (Host too) minus the dropped columns, and scrolls (Path never
 *    collapses).
 */
export function fitColumns<C extends IdeColumn>(
  defs: readonly C[],
  layout: ColumnLayout,
  available: number,
): Fit<C> {
  const base = visibleColumns(defs, layout) as FittedColumn<C>[];
  if (available <= 0) return { cols: base, autoHidden: [], tight: false };
  const userSized = (c: C): boolean => layout.widths[c.id] !== undefined;
  const shown = layout.shown ?? [];
  const droppable = base
    .filter((c) => c.autoHide !== undefined && !shown.includes(c.id))
    .sort((a, b) => (a.autoHide as number) - (b.autoHide as number));

  let cols: FittedColumn<C>[];
  const autoHidden: string[] = [];
  for (let drops = 0; ; drops++) {
    cols = base.filter((c) => !autoHidden.includes(c.id)).map((c) => ({ ...c }));
    const deficit = tableMinWidth(cols) - available;
    if (deficit <= 0) return { cols, autoHidden, tight: false };
    const host = cols.find((c) => c.id === "host" && !userSized(c));
    if (host) {
      const give = Math.min(deficit, host.px - (host.compactWidth ?? host.px));
      host.px -= give;
      if (give === deficit) return { cols, autoHidden, tight: false };
    }
    if (drops === droppable.length) break;
    autoHidden.push(droppable[drops].id);
  }

  // Step 4: one shared fraction of every unsized column's room above its compact width.
  const floorOf = (c: FittedColumn<C>): number => (c.flex ? (c.minWidth ?? DEFAULT_MIN_WIDTH) : c.px);
  const room = (c: FittedColumn<C>): number => (userSized(c) ? 0 : Math.max(0, floorOf(c) - (c.compactWidth ?? floorOf(c))));
  const deficit = tableMinWidth(cols) - available;
  const total = cols.reduce((n, c) => n + room(c), 0);
  // Not enough even squeezed: the table scrolls, so Host gets its width back too (a squeezed
  // Host in a table that scrolls anyway would only lose).
  if (total < deficit) return { cols: base.filter((c) => !autoHidden.includes(c.id)), autoHidden, tight: false };
  const k = deficit / total;
  const squeezed = cols.map((c) => {
    const w = Math.floor(floorOf(c) - room(c) * k);
    return c.flex ? { ...c, minWidth: w } : { ...c, px: w };
  });
  return { cols: squeezed, autoHidden, tight: true };
}
