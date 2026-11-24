/**
 * railTabsLayout — the strip's width budget, verified by ARITHMETIC (assert the
 * numbers, not the appearance; the appearance is the browser tier's job).
 *
 * Every expectation below is a literal computed by hand in the comment beside it —
 * NOT re-derived from the exported constants (an expectation computed
 * from the code under test can only catch plumbing, never a wrong value). The
 * constants themselves are also pinned literally for the same reason: they mirror
 * App.css pixels, and a "refactor" that changed one would otherwise self-certify.
 */

import { describe, expect, it } from "vitest";

import { STRIP_CHROME, TAB_GAP, TAB_W, TRIGGER_W, visibleTabCount } from "./railTabsLayout";

describe("railTabsLayout — constants mirror the App.css pixels", () => {
  it("pins the four constants literally", () => {
    // 13px glyph + 2×2px .rail__tab horizontal padding.
    expect(TAB_W).toBe(17);
    // .rail__tabs column-gap (10px since the sixth tab's shave).
    expect(TAB_GAP).toBe(10);
    // 1px .rail--right border-left + 2×10px .rail__tabs horizontal padding.
    expect(STRIP_CHROME).toBe(21);
    // The ⋯ trigger is styled exactly like a tab.
    expect(TRIGGER_W).toBe(17);
  });
});

describe("visibleTabCount — the seven-tab strip", () => {
  it("shows all seven at the 300px default: 7×17 + 6×10 = 179 ≤ 300 − 21 = 279", () => {
    expect(visibleTabCount(300, 7)).toBe(7);
  });

  it("cuts to five at the 180px drag-min: 5×17 + 4×10 + 10 + 17 = 152 ≤ 159; six-plus-trigger would be 179", () => {
    expect(visibleTabCount(180, 7)).toBe(5);
  });

  it("shows everything at the 560px drag-max", () => {
    expect(visibleTabCount(560, 7)).toBe(7);
  });

  it("pins the exact boundary: 199 → 5, 200 → 7 (all seven need 179 = 200 − 21, to the pixel)", () => {
    // At 200 the available run is exactly the 179px all seven cost — the ≤ is
    // inclusive, so they fit. One pixel less and the strip is over budget.
    expect(visibleTabCount(200, 7)).toBe(7);
    expect(visibleTabCount(199, 7)).toBe(5);
  });

  it("NEVER shows six of seven: TRIGGER_W = TAB_W makes six-plus-trigger cost exactly what seven cost", () => {
    // 6×17 + 5×10 + 10 + 17 = 179 = 7×17 + 6×10. Any width that affords six visible
    // plus the trigger affords all seven without it, so the answer 6 cannot occur.
    // (This is the quirk a future "why does it jump 5 → 7?" reader is looking for.)
    for (let w = 1; w <= 600; w++) {
      expect(visibleTabCount(w, 7)).not.toBe(6);
    }
  });

  it("steps down tab by tab below the drag-min: 173 → 5, 172 → 4 (n·27 + 38 ≤ w)", () => {
    // Sub-RAIL_MIN_W widths cannot come from the clamped store action, but the
    // function must still be total: n fits while n·(17+10) + 17 ≤ w − 21, i.e.
    // n·27 + 38 ≤ w. n=5 needs w ≥ 173; n=4 needs w ≥ 146.
    expect(visibleTabCount(173, 7)).toBe(5);
    expect(visibleTabCount(172, 7)).toBe(4);
    expect(visibleTabCount(146, 7)).toBe(4);
    expect(visibleTabCount(145, 7)).toBe(3);
  });

  it("clamps to a MINIMUM of one visible tab at absurd widths — never 0, never negative", () => {
    // At 40px the available run is 19px: not even one tab plus the trigger (44px)
    // fits, but hiding every tab would strand the user, so the floor is 1.
    expect(visibleTabCount(40, 7)).toBe(1);
    expect(visibleTabCount(22, 7)).toBe(1);
    expect(visibleTabCount(1, 7)).toBe(1);
  });

  it("treats a non-finite or non-positive width as 'unmeasured' and hides nothing", () => {
    // A collapsed/unmeasured rail must not hide tabs (the fitPreviewZoom guard's
    // spirit): the store's width can never be these, but a future caller's could.
    expect(visibleTabCount(0, 7)).toBe(7);
    expect(visibleTabCount(-50, 7)).toBe(7);
    expect(visibleTabCount(Number.NaN, 7)).toBe(7);
    expect(visibleTabCount(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(visibleTabCount(Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });

  it("a single tab is always simply visible — no trigger arithmetic can hide it", () => {
    // Wide: fits outright. Absurdly narrow: the overflow branch floors negative and
    // the clamp returns 1 — which equals tabCount, so the caller renders no trigger.
    expect(visibleTabCount(300, 1)).toBe(1);
    expect(visibleTabCount(180, 1)).toBe(1);
    expect(visibleTabCount(30, 1)).toBe(1);
  });

  it("is monotone: a wider rail never shows FEWER tabs", () => {
    // The one property that makes a drag feel sane — tabs may only appear as the
    // rail grows. Swept across the whole plausible range plus the clamp floor.
    let prev = visibleTabCount(1, 7);
    for (let w = 2; w <= 600; w++) {
      const cur = visibleTabCount(w, 7);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});
