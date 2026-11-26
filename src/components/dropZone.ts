/** Which drop zone is the cursor in: `center` (`moveTab`) or an edge (`moveTabToEdge`). Pure
 * geometry so it's testable without layout (jsdom rects are 0×0; see the degenerate guard). */

import type { SplitEdge } from "../app/store";

export type DropZone = SplitEdge | "center";

/** Outer fraction per side that reads as an edge; proportional so it scales with the pane (a
 * fixed band would eat a small pane whole). */
export const EDGE_RATIO = 0.25;

/** The subset of DOMRect we need — a plain literal works, so tests need no DOM. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Zone of `(x, y)` against the pane BODY rect (the tab strip, or outside, reads as center).
 * Corners take the nearest edge, ties in left, right, top, bottom order. A nullish rect is
 * accepted so callers pass `ref.current?.getBoundingClientRect()` directly. */
export function zoneFor(rect: Rect | null | undefined, x: number, y: number): DropZone {
  // No element, or one that has not been laid out yet (and every rect under
  // jsdom) is 0×0: no geometry to divide by, so treat the whole thing as
  // center — a plain move is always the safe reading of an unmeasurable drop.
  if (!rect) return "center";
  if (!(rect.width > 0) || !(rect.height > 0)) return "center";

  if (x < rect.left || x > rect.left + rect.width) return "center";
  if (y < rect.top || y > rect.top + rect.height) return "center";

  const dx = (x - rect.left) / rect.width;
  const dy = (y - rect.top) / rect.height;

  const edges: ReadonlyArray<readonly [SplitEdge, number]> = [
    ["left", dx],
    ["right", 1 - dx],
    ["top", dy],
    ["bottom", 1 - dy],
  ];

  let nearest = edges[0];
  for (const edge of edges) {
    if (edge[1] < nearest[1]) nearest = edge;
  }

  return nearest[1] <= EDGE_RATIO ? nearest[0] : "center";
}
