/** Logs list columns, rendered through the shared `src/components/columns/` store (survives tab
 * switches). Rows are grids on the header's template: widths are the user's, not the content's. */

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

/** Narrowest header/row width: fixed columns, the flex column's floor, gaps and padding. Below
 * it the list scrolls sideways instead of squeezing a column. */
export function rowsMinWidth(cols: ReadonlyArray<ColumnDef & { px: number }>): number {
  const tracks = cols.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? DEFAULT_MIN_WIDTH) : c.px), 0);
  return tracks + COL_GAP * Math.max(cols.length - 1, 0) + ROW_PAD_X * 2;
}
