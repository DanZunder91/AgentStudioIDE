import { describe, expect, it } from "vitest";
import {
  PREVIEW_ZOOM_DEFAULT,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_STEP,
  anchorScrollDelta,
  clampPreviewZoom,
  fitPreviewZoom,
  formatPreviewZoom,
  stepPreviewZoom,
  wheelPreviewZoom,
} from "./previewZoom";

/* WheelEvent.deltaMode values (this module deliberately avoids the DOM lib). */
const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe("clampPreviewZoom", () => {
  it("passes in-range values through and clamps BOTH bounds", () => {
    expect(clampPreviewZoom(1.5)).toBe(1.5);
    expect(clampPreviewZoom(999)).toBe(PREVIEW_ZOOM_MAX);
    expect(clampPreviewZoom(0.01)).toBe(PREVIEW_ZOOM_MIN);
    expect(clampPreviewZoom(-2)).toBe(PREVIEW_ZOOM_MIN);
  });

  it("absorbs non-finite input to the default instead of propagating it", () => {
    expect(clampPreviewZoom(Number.NaN)).toBe(PREVIEW_ZOOM_DEFAULT);
    expect(clampPreviewZoom(Number.POSITIVE_INFINITY)).toBe(PREVIEW_ZOOM_DEFAULT);
    expect(clampPreviewZoom(Number.NEGATIVE_INFINITY)).toBe(PREVIEW_ZOOM_DEFAULT);
  });
});

describe("stepPreviewZoom", () => {
  it("multiplies in, divides out — a round trip returns to the start", () => {
    expect(stepPreviewZoom(1, 1)).toBeCloseTo(PREVIEW_ZOOM_STEP, 10);
    expect(stepPreviewZoom(1, -1)).toBeCloseTo(1 / PREVIEW_ZOOM_STEP, 10);
    expect(stepPreviewZoom(stepPreviewZoom(1, 1), -1)).toBeCloseTo(1, 10);
  });

  it("clamps at both rails and sanitizes a non-finite current", () => {
    expect(stepPreviewZoom(PREVIEW_ZOOM_MAX, 1)).toBe(PREVIEW_ZOOM_MAX);
    expect(stepPreviewZoom(PREVIEW_ZOOM_MIN, -1)).toBe(PREVIEW_ZOOM_MIN);
    expect(stepPreviewZoom(Number.NaN, 1)).toBeCloseTo(PREVIEW_ZOOM_STEP, 10);
  });
});

describe("wheelPreviewZoom", () => {
  it("zooms IN on negative deltaY and OUT on positive (two-sided)", () => {
    const zoomedIn = wheelPreviewZoom(1, -100, PIXEL);
    const zoomedOut = wheelPreviewZoom(1, 100, PIXEL);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedOut).toBeLessThan(1);
    // Exponential steps are symmetric: in then out lands back on 1.
    expect(wheelPreviewZoom(zoomedIn, 100, PIXEL)).toBeCloseTo(1, 10);
  });

  it("one classic mouse notch (≈100px) ≈ one button step", () => {
    expect(wheelPreviewZoom(1, -100, PIXEL)).toBeCloseTo(Math.exp(0.22), 10);
    expect(Math.exp(0.22)).toBeGreaterThan(1.2); // and that is a real, visible step
  });

  it("normalizes LINE and PAGE delta modes to more than their raw pixels", () => {
    // 3 lines ≈ one 100px notch — the Chromium convention.
    expect(wheelPreviewZoom(1, -3, LINE)).toBeCloseTo(
      wheelPreviewZoom(1, -100, PIXEL),
      10,
    );
    expect(wheelPreviewZoom(1, -1, PAGE)).toBeGreaterThan(
      wheelPreviewZoom(1, -1, PIXEL),
    );
  });

  it("clamps at both rails instead of running away", () => {
    expect(wheelPreviewZoom(PREVIEW_ZOOM_MAX, -1000, PIXEL)).toBe(PREVIEW_ZOOM_MAX);
    expect(wheelPreviewZoom(PREVIEW_ZOOM_MIN, 1000, PIXEL)).toBe(PREVIEW_ZOOM_MIN);
  });
});

describe("anchorScrollDelta", () => {
  it("keeps the anchored point stationary: zero when zoom is unchanged, sign follows direction", () => {
    expect(anchorScrollDelta(300, 1, 1)).toBe(0);
    expect(anchorScrollDelta(300, 1, 2)).toBe(300); // zoom in → scroll further right/down
    expect(anchorScrollDelta(300, 2, 1)).toBe(-300); // zoom out → scroll back
  });

  it("is proportional to the unscaled cursor offset (an origin point never moves)", () => {
    expect(anchorScrollDelta(0, 1, 3)).toBe(0);
    expect(anchorScrollDelta(200, 1, 1.5)).toBe(2 * anchorScrollDelta(100, 1, 1.5));
  });
});

describe("fitPreviewZoom", () => {
  /*
   * `diagram` and `pane` are device pixels measured AT `current`, so every case
   * below states the zoom the measurement was taken at. The requirement is
   * one button that lands on 50% in some cases and 200% in others — the first two cases
   * are literally those two numbers, coming out of the same rule.
   */

  it("zooms IN on a diagram smaller than the pane, filling it (the 200% case)", () => {
    const fit = fitPreviewZoom(1, { width: 400, height: 300 }, { width: 800, height: 600 });
    expect(fit).toBe(2);
    // The ratio is not the deliverable — the on-screen RESULT is. On-screen size
    // is linear in zoom (the CSS ceiling does not depend on it), so at
    // `fit` the diagram must actually span the pane on the constraining axis.
    expect(400 * fit).toBe(800);
    expect(300 * fit).toBe(600);
  });

  it("zooms OUT on a diagram taller than the pane so it is seen whole (the 50% case)", () => {
    // The everyday mermaid case: a tall flowchart in a short preview pane.
    const fit = fitPreviewZoom(1, { width: 400, height: 1200 }, { width: 800, height: 600 });
    expect(fit).toBe(0.5);
    expect(1200 * fit).toBe(600); // the binding axis lands exactly on the pane edge
    expect(400 * fit).toBeLessThan(800); // …and the loose axis is comfortably inside
  });

  it("picks the CONSTRAINING axis — the smaller ratio, never the larger", () => {
    const pane = { width: 800, height: 1000 };
    // Off by 2× on width, 5× on height. Taking the larger ratio would push the
    // diagram straight off the right edge, so "fit" would not fit.
    const widthBound = fitPreviewZoom(1, { width: 400, height: 200 }, pane);
    expect(widthBound).toBe(2);
    expect(200 * widthBound).toBeLessThan(1000);

    // Same pane, a diagram whose HEIGHT is now the tighter axis. The answer has
    // to differ from the width-bound one, or the function is not reading both.
    const heightBound = fitPreviewZoom(1, { width: 200, height: 800 }, pane);
    expect(heightBound).toBe(1.25); // 1000/800 — NOT the width's 800/200 = 4
    expect(heightBound).not.toBe(widthBound);
    expect(200 * heightBound).toBeLessThan(800);
  });

  it("is a no-op — `current` itself — when the diagram already fits exactly", () => {
    // Pressing Fit on an already-fitted diagram must not nudge the zoom by a
    // rounding error, or repeated presses would drift the preview off 100%.
    const current = 1.7;
    expect(
      fitPreviewZoom(current, { width: 800, height: 600 }, { width: 800, height: 600 }),
    ).toBe(current);
  });

  it("is idempotent: re-measure after a fit, press Fit again, nothing moves", () => {
    const pane = { width: 800, height: 600 };
    const diagram = { width: 300, height: 900 };
    const first = fitPreviewZoom(1, diagram, pane);
    // What the DOM would report after the first press — the same physical
    // diagram, measured at the new zoom.
    const remeasured = { width: diagram.width * first, height: diagram.height * first };
    expect(fitPreviewZoom(first, remeasured, pane)).toBeCloseTo(first, 12);
  });

  it("composes with the current zoom: the same absolute answer from 2.0 as from 0.5", () => {
    // THE property that makes this correct. One physical diagram measures 800×600
    // at zoom 2 and 200×150 at zoom 0.5; the fit it needs is a property of the
    // diagram, not of where the zoom happened to be when the button was pressed.
    const pane = { width: 400, height: 1200 };
    const fromTwo = fitPreviewZoom(2, { width: 800, height: 600 }, pane);
    const fromHalf = fitPreviewZoom(0.5, { width: 200, height: 150 }, pane);
    expect(fromTwo).toBeCloseTo(1, 12);
    expect(fromHalf).toBeCloseTo(fromTwo, 12);
    // And the answer is the composed zoom, not the bare ratio: returning the
    // ratio would give 0.5 here — the amount to shrink BY, not the zoom to land ON.
    expect(fromTwo).not.toBe(0.5);
  });

  it("clamps at both rails — an enormous diagram stops at 25%, a tiny one at 400%", () => {
    // A 20 000px generated flowchart wants ~3%. The rails are why Fit can never
    // leave the preview at an unreadable zoom, however pathological the diagram.
    expect(
      fitPreviewZoom(1, { width: 100, height: 20000 }, { width: 800, height: 600 }),
    ).toBe(PREVIEW_ZOOM_MIN);
    // Mirror: a 4×4 sequence-diagram stub wants 150×, capped at 400%.
    expect(fitPreviewZoom(1, { width: 4, height: 4 }, { width: 800, height: 600 })).toBe(
      PREVIEW_ZOOM_MAX,
    );
  });

  it("clamps the CURRENT zoom before scaling it, so an out-of-range current cannot leak", () => {
    // 10 is not a zoom the UI can reach, but the persisted store value is
    // untrusted input. 4 (clamped) × 0.5 = 2 — not 10 × 0.5 = 5 clamped back to 4.
    expect(
      fitPreviewZoom(10, { width: 400, height: 1200 }, { width: 800, height: 600 }),
    ).toBe(2);
  });

  it("returns the current zoom for a zero (or negative) dimension in EITHER box", () => {
    // A pane collapsed to 0 while its split is dragged shut, and a diagram that
    // mermaid has not laid out yet, both report zeros; dividing by them yields
    // Infinity or 0 and a garbage zoom. Each of the four dimensions is listed
    // separately because a guard covering only the diagram, or only the widths,
    // is a real bug — and the sizes are chosen so that dropping the guard changes
    // the answer in every line (a 0 paired with an equal-ratio partner would pass
    // vacuously, proving nothing).
    const pane = { width: 800, height: 600 };
    const laidOut = { width: 1600, height: 1200 }; // would otherwise fit at 0.5
    expect(fitPreviewZoom(1.5, { width: 0, height: 1200 }, pane)).toBe(1.5);
    expect(fitPreviewZoom(1.5, { width: 1600, height: 0 }, pane)).toBe(1.5);
    expect(fitPreviewZoom(1.5, laidOut, { width: 0, height: 600 })).toBe(1.5);
    expect(fitPreviewZoom(1.5, laidOut, { width: 800, height: 0 })).toBe(1.5);
    // Negative is the same class of nonsense, and would flip the zoom's sign.
    expect(fitPreviewZoom(1.5, { width: -1600, height: 1200 }, pane)).toBe(1.5);
    expect(fitPreviewZoom(1.5, laidOut, { width: 800, height: -600 })).toBe(1.5);
    // The bail-out returns the CLAMPED current, not the raw one: a persisted 999
    // must not survive a collapsed pane.
    expect(fitPreviewZoom(999, { width: 0, height: 1200 }, pane)).toBe(PREVIEW_ZOOM_MAX);
  });

  it("returns the current zoom for a non-finite dimension anywhere — NaN and Infinity alike", () => {
    // NaN reaches here from an unmounted node's `getBoundingClientRect`
    // arithmetic; Infinity from a division upstream. Both are load-bearing: NaN
    // would propagate through Math.min and be laundered into 100% by the clamp
    // (silently resetting the user's zoom), and Infinity would drive the
    // ratio to 0 or ∞ and slam into a rail. Again, one line per dimension.
    const pane = { width: 800, height: 600 };
    const laidOut = { width: 1600, height: 1200 };
    expect(fitPreviewZoom(1.5, { width: Number.NaN, height: 1200 }, pane)).toBe(1.5);
    expect(fitPreviewZoom(1.5, { width: 1600, height: Number.NaN }, pane)).toBe(1.5);
    expect(fitPreviewZoom(1.5, laidOut, { width: Number.NaN, height: 600 })).toBe(1.5);
    expect(fitPreviewZoom(1.5, laidOut, { width: 800, height: Number.NaN })).toBe(1.5);
    expect(
      fitPreviewZoom(1.5, { width: Number.POSITIVE_INFINITY, height: 1200 }, pane),
    ).toBe(1.5);
    expect(
      fitPreviewZoom(1.5, laidOut, { width: 800, height: Number.POSITIVE_INFINITY }),
    ).toBe(1.5);
  });

  it("sanitizes a non-finite current the way every other control does", () => {
    // Same contract as clampPreviewZoom/stepPreviewZoom: NaN in never means NaN
    // out — on the guard path AND on the arithmetic path.
    expect(
      fitPreviewZoom(Number.NaN, { width: 0, height: 0 }, { width: 800, height: 600 }),
    ).toBe(PREVIEW_ZOOM_DEFAULT);
    expect(
      fitPreviewZoom(Number.NaN, { width: 400, height: 300 }, { width: 800, height: 600 }),
    ).toBe(2);
  });
});

describe("formatPreviewZoom", () => {
  it("renders a rounded percentage, through the same clamp as everything else", () => {
    expect(formatPreviewZoom(1)).toBe("100%");
    expect(formatPreviewZoom(1.254)).toBe("125%");
    expect(formatPreviewZoom(999)).toBe(`${PREVIEW_ZOOM_MAX * 100}%`);
    expect(formatPreviewZoom(Number.NaN)).toBe("100%");
  });
});
