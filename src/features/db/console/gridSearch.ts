/**
 * gridSearch — Cmd/Ctrl+F inside a query result: a string search over the
 * database response, like Control+F (Command+F on a Mac).
 *
 * Pure: which cells match, in the order the user sees them. The grid does the
 * scrolling and the highlighting.
 *
 * ## Searching the DISPLAYED text, not the stored value
 *
 * A cell can be shown differently from how it is stored — `renderCell` collapses
 * newlines and tabs into one line, and NULL is drawn as the word `NULL` while its
 * value is `null`. Search runs on the **stored text**, because that is what the
 * user typed a fragment of when they went looking for an id like `9a5317…`; and NULL is
 * deliberately NOT matchable by typing "null", since that would find every empty
 * cell in the table whenever someone searched for the word in a text column. A
 * fact the grid shows and a fact the grid holds are different things, and this
 * searches the second one.
 *
 * ## Case-insensitive, literal, no regex
 *
 * The same shape as the response-body search: a hex hash or an id is what people
 * paste in, and a stray `.` or `(` in a pasted value must not become a pattern.
 */

/** One matching cell, addressed in the grid's CURRENT (possibly sorted) order. */
export interface CellHit {
  row: number;
  col: number;
}

/**
 * Every cell containing `query`, row-major — left to right, top to bottom, which
 * is the order the eye reads and therefore the order Next should walk.
 *
 * A blank or whitespace-only query matches nothing rather than everything: the
 * bar is open while the user is still typing, and lighting up every cell in a
 * 1,000-row grid on the way to the first character is noise, not a feature.
 */
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

/**
 * The `[start, end)` slice of `text` matching `query`, or null.
 *
 * Only the FIRST occurrence within a cell is marked. A cell is one value the user
 * is scanning, not a document — marking a hash three times because the query is
 * `00` adds noise without adding information, and the count in the bar is a count
 * of cells so a second mark would make the two disagree.
 */
export function matchRange(text: string, query: string): { from: number; to: number } | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const at = text.toLowerCase().indexOf(needle);
  return at === -1 ? null : { from: at, to: at + needle.length };
}

/**
 * The scrollTop that brings `row` into view, or `null` when it already is.
 *
 * Returning null for a row that is on screen is what stops Next from yanking the
 * grid on every step through matches that share a screen — the jump should only
 * happen when it has to.
 */
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
