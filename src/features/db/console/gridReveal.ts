/** The horizontal half of revealing a match. Rows are windowed, so gridSearch's scrollToRow does
 * the vertical; columns are not, so the header <th> gives the column's extent. Computed, not
 * th.scrollIntoView, which may also scroll vertically: one writer per axis. */

/** The two DOMRect fields needed, so the maths is testable without layout (jsdom rects are 0). */
export interface Extent {
  left: number;
  right: number;
}

/** null when already visible, so stepping through hits on one screen never jumps sideways. column
 * is null when a malformed row has more cells than columns: a scroll of zero. A column wider than
 * the box aligns to its left edge, where ids start and the mark is drawn. */
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
