/**
 * The Logs list's columns — declared once, rendered through the
 * shared `src/components/columns/` store so widths and the hidden set survive tab switches.
 *
 * The bug: rows read `cl…`, `claude · ge…`, `c.` — the old flex row let a long
 * text squeeze the source label. Every row is now a CSS grid on the SAME template as the
 * header, so a column's width is the user's, never the content's.
 */

import { DEFAULT_MIN_WIDTH, type ColumnDef } from "../../components/columns";

/** The store key for this table's layout. */
export const LOGS_VIEW = "logs";

/** Horizontal gap between cells and the row's side padding — must match `.alog-row` / `.alog-head`. */
export const COL_GAP = 8;
export const ROW_PAD_X = 10;

export const LOG_COLUMNS: readonly ColumnDef[] = [
  // `19:59:24.371` is 12 glyphs ≈ 87 px at 12 px mono.
  { id: "time", label: "Time", width: 92, minWidth: 40 },
  { id: "level", label: "Level", width: 40, minWidth: 16 },
  // Wide enough for `claude · gazelle` (16 glyphs) with room to spare; beyond it, an ellipsis + title.
  { id: "source", label: "Source", width: 140, minWidth: 40 },
  { id: "text", label: "Text", width: 400, minWidth: 160, flex: true, required: true },
];

/**
 * The narrowest the header and rows may get: every fixed column at its width, the flex
 * column at its floor, plus the gaps and padding. Below it the list scrolls sideways
 * rather than squeezing a column to nothing.
 */
export function rowsMinWidth(cols: ReadonlyArray<ColumnDef & { px: number }>): number {
  const tracks = cols.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? DEFAULT_MIN_WIDTH) : c.px), 0);
  return tracks + COL_GAP * Math.max(cols.length - 1, 0) + ROW_PAD_X * 2;
}
