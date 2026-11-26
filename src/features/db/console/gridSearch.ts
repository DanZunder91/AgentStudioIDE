/** Searches the STORED text, not the displayed one (renderCell collapses whitespace); NULL is not
 * matchable as "null". Case-insensitive and literal, so a pasted "." or "(" is no pattern. */

/** One matching cell, addressed in the grid's CURRENT (possibly sorted) order. */
export interface CellHit {
  row: number;
  col: number;
}

/** Row-major, the order Next walks. A blank query matches nothing (the user is still typing). */
export function findCells(rows: (string | null)[][], query: string): CellHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: CellHit[] = [];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell !== null && cell.toLowerCase().includes(needle)) hits.push({ row: r, col: c });
    });
  });
  return hits;
}

/** First occurrence per cell only: the bar counts cells, so more marks would disagree with it. */
export function matchRange(text: string, query: string): { from: number; to: number } | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const at = text.toLowerCase().indexOf(needle);
  return at === -1 ? null : { from: at, to: at + needle.length };
}

/** null when the row is already on screen, so Next never jumps without need. */
export function scrollToRow(
  row: number,
  scrollTop: number,
  viewportPx: number,
  rowHeightPx: number,
  headerPx: number,
): number | null {
  const top = row * rowHeightPx;
  const bottom = top + rowHeightPx;
  // The sticky header covers the first `headerPx` of the scroll box, so a row is
  // only genuinely visible below it.
  const seenFrom = scrollTop + headerPx;
  const seenTo = scrollTop + viewportPx;
  if (top >= seenFrom && bottom <= seenTo) return null;
  // Land the row a little below the header rather than flush against it, so the
  // match does not sit half-hidden under the column names.
  return Math.max(0, top - headerPx - rowHeightPx);
}
