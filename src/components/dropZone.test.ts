/** Drop-zone geometry, the pure half of drag-to-edge: `zoneFor` takes a plain rect, since jsdom
 * measures 0×0 and only a mocked rect would reach it through a component. */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EDGE_RATIO, zoneFor, type DropZone, type Rect } from "./dropZone";

/** A 400×300 pane at the origin — round numbers keep the fractions readable. */
const rect: Rect = { left: 0, top: 0, width: 400, height: 300 };

/** Same pane, pushed off the origin: catches "forgot to subtract left/top". */
const offset: Rect = { left: 1000, top: 500, width: 400, height: 300 };

describe("zoneFor — the five zones", () => {
  it("centre of the pane is the center zone", () => {
    expect(zoneFor(rect, 200, 150)).toBe("center");
  });

  it.each([
    ["left", 10, 150],
    ["right", 390, 150],
    ["top", 200, 10],
    ["bottom", 200, 290],
  ] as const)("the %s edge", (zone, x, y) => {
    expect(zoneFor(rect, x, y)).toBe(zone);
  });

  it("resolves zones against the rect's own origin, not the viewport's", () => {
    // Same relative points as above, on a pane that starts at (1000, 500).
    expect(zoneFor(offset, 1010, 650)).toBe("left");
    expect(zoneFor(offset, 1390, 650)).toBe("right");
    expect(zoneFor(offset, 1200, 510)).toBe("top");
    expect(zoneFor(offset, 1200, 790)).toBe("bottom");
    expect(zoneFor(offset, 1200, 650)).toBe("center");
  });
});

describe("zoneFor — the edge/center boundary", () => {
  it(`the band is exactly the outer ${EDGE_RATIO * 100}%`, () => {
    // x = 100 is exactly 25% across a 400px pane: still the edge (inclusive).
    expect(zoneFor(rect, EDGE_RATIO * 400, 150)).toBe("left");
    // A hair past it is center.
    expect(zoneFor(rect, EDGE_RATIO * 400 + 1, 150)).toBe("center");
    // Mirrored on the right.
    expect(zoneFor(rect, 400 - EDGE_RATIO * 400, 150)).toBe("right");
    expect(zoneFor(rect, 400 - EDGE_RATIO * 400 - 1, 150)).toBe("center");
  });

  it("the middle 50% of each axis is center", () => {
    expect(zoneFor(rect, 101, 150)).toBe("center");
    expect(zoneFor(rect, 299, 150)).toBe("center");
    expect(zoneFor(rect, 200, 76)).toBe("center");
    expect(zoneFor(rect, 200, 224)).toBe("center");
  });
});

describe("zoneFor — corners resolve to the nearest edge", () => {
  it("picks the nearer edge in a corner", () => {
    // Top-left corner of a 400×300 pane. (5,60): dx=0.0125, dy=0.2 → left wins.
    expect(zoneFor(rect, 5, 60)).toBe("left");
    // (60,5): dx=0.15, dy=0.0167 → top wins.
    expect(zoneFor(rect, 60, 5)).toBe("top");
    // Bottom-right.
    expect(zoneFor(rect, 398, 240)).toBe("right");
    expect(zoneFor(rect, 340, 298)).toBe("bottom");
  });

  it("breaks exact ties deterministically (left, right, top, bottom order)", () => {
    // On a square, the exact diagonal is equidistant from left and top.
    const square: Rect = { left: 0, top: 0, width: 200, height: 200 };
    expect(zoneFor(square, 10, 10)).toBe("left");
    expect(zoneFor(square, 190, 190)).toBe("right");
  });
});

describe("zoneFor — degenerate input", () => {
  it("a 0×0 rect reads as center, never a split", () => {
    // This is not hypothetical: it is EVERY rect under jsdom, and a real pane
    // before first layout. Splitting on unmeasurable geometry would be a
    // coin-flip; a plain move is the safe reading.
    expect(zoneFor({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe("center");
    expect(zoneFor({ left: 0, top: 0, width: 400, height: 0 }, 200, 0)).toBe("center");
    expect(zoneFor({ left: 0, top: 0, width: 0, height: 300 }, 0, 150)).toBe("center");
  });

  /** Off-centre probes: at the midpoint the zero-size guard is unobservable. Without it a 0-height
   * rect gets dy = NaN and an off-centre x lands in a band (a spurious split on an unlaid pane). */
  it("a zero-height rect reads as center OFF-centre too — no spurious edge split", () => {
    const flat: Rect = { left: 0, top: 0, width: 400, height: 0 };
    // x = 10 is 2.5% across: deep inside the left band if the guard is skipped.
    expect(zoneFor(flat, 10, 0)).toBe("center");
    // …and mirrored, deep inside the right band.
    expect(zoneFor(flat, 390, 0)).toBe("center");
    // A 1px-wide flat rect: the minimal witness the mutation probe found.
    expect(zoneFor({ left: 0, top: 0, width: 1, height: 0 }, 0, 0)).toBe("center");
    // Off the origin, so the guard cannot be confused with the origin check.
    expect(zoneFor({ left: 1000, top: 500, width: 400, height: 0 }, 1010, 500)).toBe("center");
  });

  /** Contract only: with or without the width guard a 0-width rect reads "center" (a NaN `dx`
   * seeds the nearest-edge scan and nothing beats it), so those mutants are equivalent. */
  it("a zero-width rect reads as center off-centre (contract; guard-equivalent)", () => {
    const thin: Rect = { left: 0, top: 0, width: 0, height: 300 };
    expect(zoneFor(thin, 0, 10)).toBe("center");
    expect(zoneFor(thin, 0, 290)).toBe("center");
  });

  it("a negative rect reads as center — an inverted rect has no inside", () => {
    // width < 0 makes the x-interval empty (`x >= left && x <= left + width` is
    // unsatisfiable), so the outside-the-body check already answers center.
    expect(zoneFor({ left: 0, top: 0, width: -400, height: 300 }, 10, 150)).toBe("center");
    expect(zoneFor({ left: 0, top: 0, width: 400, height: -300 }, 10, 150)).toBe("center");
  });

  it("a missing rect reads as center", () => {
    // The caller passes `ref.current?.getBoundingClientRect()`, nullish before layout; handled
    // here so the component has no untested branch.
    expect(zoneFor(null, 200, 150)).toBe("center");
    expect(zoneFor(undefined, 200, 150)).toBe("center");
  });

  it("points outside the body read as center — dropping on a tab bar joins the group", () => {
    // Above the body = over the pane's tab strip. VS Code semantics: that means
    // "add to this group", never "split above it".
    expect(zoneFor(rect, 200, -30)).toBe("center");
    expect(zoneFor(rect, 200, 330)).toBe("center");
    expect(zoneFor(rect, -20, 150)).toBe("center");
    expect(zoneFor(rect, 420, 150)).toBe("center");
  });

  it("survives NaN coordinates without inventing a split", () => {
    expect(zoneFor(rect, NaN, NaN)).toBe("center");
  });
});

describe("zoneFor — properties", () => {
  const coord = fc.double({ min: -2000, max: 4000, noNaN: true });
  const rectArb = fc.record({
    left: fc.double({ min: -500, max: 500, noNaN: true }),
    top: fc.double({ min: -500, max: 500, noNaN: true }),
    width: fc.double({ min: 1, max: 3000, noNaN: true }),
    height: fc.double({ min: 1, max: 3000, noNaN: true }),
  });

  it("always returns one of exactly five zones", () => {
    const zones: DropZone[] = ["center", "left", "right", "top", "bottom"];
    fc.assert(
      fc.property(rectArb, coord, coord, (r, x, y) => {
        expect(zones).toContain(zoneFor(r, x, y));
      }),
    );
  });

  it("is deterministic — the same point always lands in the same zone", () => {
    fc.assert(
      fc.property(rectArb, coord, coord, (r, x, y) => {
        expect(zoneFor(r, x, y)).toBe(zoneFor(r, x, y));
      }),
    );
  });

  it("the exact center point is always the center zone, at any pane size", () => {
    fc.assert(
      fc.property(rectArb, (r) => {
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        expect(zoneFor(r, x, y)).toBe("center");
      }),
    );
  });

  /** Sample fractions along the mid-line, so mirrored points stay inside the rect and no cross-axis
   * tie flips. Points within 1e-6 of a band boundary are skipped (float reflection isn't exact). */
  const fractionArb = fc
    .double({ min: 0, max: 1, noNaN: true })
    .filter(
      (f) =>
        Math.abs(f - EDGE_RATIO) > 1e-6 && Math.abs(f - (1 - EDGE_RATIO)) > 1e-6,
    );

  it("the left and right bands are the same size — neither edge is easier to hit", () => {
    fc.assert(
      fc.property(rectArb, fractionArb, (r, f) => {
        const y = r.top + r.height / 2; // mid-height: vertical edges cannot win
        const mirrorX: Record<DropZone, DropZone> = {
          left: "right",
          right: "left",
          top: "top",
          bottom: "bottom",
          center: "center",
        };
        const near = zoneFor(r, r.left + f * r.width, y);
        const far = zoneFor(r, r.left + (1 - f) * r.width, y);
        expect(far).toBe(mirrorX[near]);
      }),
    );
  });

  it("the top and bottom bands are the same size", () => {
    fc.assert(
      fc.property(rectArb, fractionArb, (r, f) => {
        const x = r.left + r.width / 2; // mid-width: horizontal edges cannot win
        const mirrorY: Record<DropZone, DropZone> = {
          top: "bottom",
          bottom: "top",
          left: "left",
          right: "right",
          center: "center",
        };
        const near = zoneFor(r, x, r.top + f * r.height);
        const far = zoneFor(r, x, r.top + (1 - f) * r.height);
        expect(far).toBe(mirrorY[near]);
      }),
    );
  });

  it("every zone stays reachable no matter the aspect ratio", () => {
    // A proportional band cannot be squeezed out of existence by a long, thin
    // pane the way a fixed-pixel band could.
    fc.assert(
      fc.property(rectArb, (r) => {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        expect(zoneFor(r, r.left + r.width * 0.01, cy)).toBe("left");
        expect(zoneFor(r, r.left + r.width * 0.99, cy)).toBe("right");
        expect(zoneFor(r, cx, r.top + r.height * 0.01)).toBe("top");
        expect(zoneFor(r, cx, r.top + r.height * 0.99)).toBe("bottom");
      }),
    );
  });
});
