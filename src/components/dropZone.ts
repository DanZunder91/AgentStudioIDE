/**
 * Drag-a-tab-to-a-pane: which zone is the cursor in?
 *
 * Five zones — `center` plus the four edges. Center moves the tab into the
 * pane (`moveTab`); an edge splits the pane and lands the tab on that side
 * (`moveTabToEdge`). This module is the pure geometry half, kept out of the
 * component so it can be tested without a DOM (jsdom has no layout engine, so
 * every rect there is 0×0 — see the degenerate guard below).
 */

import type { SplitEdge } from "../app/store";

export type DropZone = SplitEdge | "center";

/**
 * Outer fraction of each side that reads as an edge drop; the middle 50% is
 * center. Proportional rather than a fixed pixel band so it scales with the
 * pane: a 25% target is comfortable to hit at any size, and never eats a small
 * pane whole the way a fixed 80px band would.
 */
export const EDGE_RATIO = 0.25;

/** The subset of DOMRect we need — a plain literal works, so tests need no DOM. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The zone `(x, y)` falls in, relative to a pane's **body** rect.
 *
 * Measured against the body, not the whole pane, so the tab strip above it is
 * never an edge: dropping onto a tab bar means "join this group" (center), the
 * way it does in VS Code. Anything outside the rect reads as center for the
 * same reason.
 *
 * Corners resolve to whichever edge is nearest — ties break in `left, right,
 * top, bottom` order, so the result is always deterministic.
 *
 * Takes the rect as nullish-tolerant so the caller can hand over
 * `ref.current?.getBoundingClientRect()` directly: "no rect" and "an
 * unmeasurable rect" are the same question with the same answer, and keeping
 * both here means the component has no untestable branch of its own.
 */
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
