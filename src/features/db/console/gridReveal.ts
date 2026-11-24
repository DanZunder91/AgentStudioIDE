/**
 * gridReveal — the HORIZONTAL half of "take me to the match" in the results grid.
 *
 * `gridSearch.ts` owns the vertical half (`scrollToRow`), and it has to: **rows are
 * windowed**. A row 900 down is not in the DOM at all, so the house idiom for
 * revealing a hit — `el.scrollIntoView({ block: "nearest" })`, as `ResponseBody`,
 * `MarkdownPreview`, `previewFind` and `WorkspaceTree` all do — would find nothing
 * and silently do nothing. The vertical position is therefore computed from the row
 * INDEX, which also knows about the sticky header the row would otherwise land under.
 *
 * **Columns are a different problem, because they are NOT windowed** (see
 * `ResultsGrid.tsx`'s header: the grid renders every column in full). So a real,
 * measurable box exists for the hit's column even when the hit's own `<td>` does
 * not — the header cell. Under `table-layout: fixed` + `<colgroup>` every row's
 * column *c* has exactly the `<th>`'s horizontal extent, so the header is both
 * available and correct, and this file is the `inline: "nearest"` arithmetic applied
 * to it.
 *
 * Why compute it instead of calling `scrollIntoView({ inline: "nearest" })` on the
 * `<th>`: that would also scroll the header VERTICALLY (it is sticky, so the browser
 * sees it at the top of the box, but the call is still free to scroll ancestors), and
 * it would fight the row arithmetic that just ran. One writer per axis, or the two
 * take turns undoing each other.
 */

/**
 * A horizontal extent in viewport pixels — the two fields of a `DOMRect` this
 * needs, so the maths can be unit-tested without a layout engine (jsdom has none;
 * every `getBoundingClientRect` there is zeros).
 */
export interface Extent {
  left: number;
  right: number;
}

/**
 * The `scrollLeft` that brings `column` fully into `box`, or `null` when it already
 * is — the same "return null for something already on screen" contract `scrollToRow`
 * states, and for the same reason: stepping through matches that share a screen must
 * not yank the grid sideways on every press.
 *
 * `column` is nullable because a hit can address a cell the grid does not draw: a row
 * carrying more values than the result has columns is only ever a malformed result
 * (every engine builds its rows to `columns.len()`), but `findCells` walks the whole
 * row, so the hit can exist while the column does not. Nothing to reveal is not an
 * error — it is a scroll of zero.
 *
 * A column WIDER than the viewport is aligned to its left edge rather than its right:
 * the start of a 66-character hash id is the part that identifies it, and the match
 * mark is drawn from the left of the cell.
 */
export function scrollToColumn(
  column: Extent | null,
  box: Extent,
  scrollLeft: number,
): number | null {
  if (column === null) return null;
  const fitsLeft = column.left >= box.left;
  const fitsRight = column.right <= box.right;
  if (fitsLeft && fitsRight) return null;
  const alignLeft = !fitsLeft || column.right - column.left > box.right - box.left;
  const delta = alignLeft ? column.left - box.left : column.right - box.right;
  // Clamped at 0: a column left of a box already at scrollLeft 0 would otherwise
  // ask for a negative offset, which the DOM silently coerces — better to say it.
  return Math.max(0, scrollLeft + delta);
}
