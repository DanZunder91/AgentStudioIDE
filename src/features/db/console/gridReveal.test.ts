/**
 * gridReveal tests — the horizontal half of "take me to the match".
 *
 * Pure arithmetic over two extents and a scroll offset, so this file needs no DOM
 * and makes no claim about one. It is the counterpart to `gridSearch.test.ts`'s
 * `scrollToRow` block, and the two share a contract worth stating once: **`null`
 * means "already on screen, do not touch the box"**, never "I could not work it
 * out". Every caller treats null as "no write", so a function that returned a
 * position for a visible hit would make the grid jitter on every step.
 *
 * The numbers here are viewport pixels, the units `getBoundingClientRect` speaks,
 * because that is what `ResultsGrid` reads off the header cell. The component tier
 * proves the component passes the right ones; this tier proves the answer.
 */

import { describe, expect, it } from "vitest";

import { scrollToColumn } from "./gridReveal";

/** The scroll box: 400px wide, its left edge 100px into the viewport. */
const BOX = { left: 100, right: 500 };

describe("scrollToColumn", () => {
  it("leaves a column that is already fully visible alone", () => {
    // Inside the box on both edges — the case that stops a walk through adjacent
    // matches in one column from yanking the grid sideways on every press.
    expect(scrollToColumn({ left: 150, right: 300 }, BOX, 0)).toBeNull();
  });

  it("treats a column touching both edges exactly as visible", () => {
    // Flush left and flush right: `>=` / `<=`, not `>` / `<`. A column that fills
    // the viewport precisely is on screen, and scrolling it would move nothing
    // while still costing a scroll event and a re-render.
    expect(scrollToColumn({ left: 100, right: 500 }, BOX, 40)).toBeNull();
  });

  it("scrolls RIGHT by exactly the overhang when the column runs off the right edge", () => {
    // The column ends 120px past the box's right edge, so 120px of scroll brings
    // its trailing edge flush — the `inline: "nearest"` rule, which reveals the
    // hit with the least movement rather than centring it.
    expect(scrollToColumn({ left: 420, right: 620 }, BOX, 300)).toBe(420);
  });

  it("scrolls LEFT by exactly the overhang when the column sits off the left edge", () => {
    // 60px short of the box's left edge: scroll back 60px, no further.
    expect(scrollToColumn({ left: 40, right: 220 }, BOX, 500)).toBe(440);
  });

  it("aligns a column WIDER than the viewport to its left edge", () => {
    // 900px of column in a 400px box. Aligning the right edge would park the view
    // on the tail of the value; the mark is drawn from the left of the cell and
    // the identifying part of a long id is its start, so the left edge wins.
    expect(scrollToColumn({ left: 260, right: 1160 }, BOX, 200)).toBe(360);
  });

  it("never asks for a negative offset", () => {
    // A column 300px left of a box already at scrollLeft 150 would arithmetically
    // want -150. The DOM would silently clamp it; saying so here means the clamp
    // is a decision with a test rather than a behaviour of someone else's code.
    expect(scrollToColumn({ left: -200, right: -50 }, BOX, 150)).toBe(0);
  });

  it("reveals nothing for a hit whose column the grid does not draw", () => {
    // A row carrying more values than the result has columns: `findCells` walks
    // the whole row, so the hit exists while the `<th>` does not. Nothing to
    // reveal is a scroll of zero, not a crash.
    expect(scrollToColumn(null, BOX, 700)).toBeNull();
  });
});
