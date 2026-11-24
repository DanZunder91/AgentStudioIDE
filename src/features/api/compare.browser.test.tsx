/**
 * ComparePanel — layer 5, the real-browser tier (A/B compare).
 *
 * Every claim here is a pixel claim, so this tier is the only place it can
 * live: jsdom has no layout engine — `getBoundingClientRect()` is 0×0 there —
 * so all of these would be vacuously green in the jsdom suite (the reason
 * `DbConsole.browser.test.tsx` exists too).
 *
 *   1. **Side by side, not stacked** — pane B starts at or right of pane A's
 *      right edge, tops equal, and the halves are equal.
 *   2. **The BUDGET, not the symptom** — the two pane widths
 *      plus the gap fit inside the split's client box. A stacked or
 *      overflowing grid fails this line with the arithmetic in the message.
 *   3. **A long, wide response scrolls INSIDE its own pane body** — both axes,
 *      asserted by actually scrolling it (a `scrollWidth > clientWidth` check
 *      alone is true of an `overflow: visible` box too — the DbConsole tier's
 *      own lesson) — while the outer surface never scrolls horizontally.
 *   4. **The selected-key highlight is visibly distinct in the real engine** —
 *      computed background and box-shadow differ from an unselected key.
 *
 * App.css is imported for real: the highlight is painted entirely from theme
 * variables (`--accent-soft`, `--accent`), and without `:root` defining them
 * the `var()` fallback erases the very styles claim 4 measures.
 *
 * ── Falsified before being trusted — the record, verbatim ──
 *   ✅ `.compare-split` → `grid-template-columns: 1fr` (stacked panes)
 *      → "AssertionError: expected 14 to be greater than or equal to 986" —
 *        pane B's left vs pane A's right; the side-by-side claim names the
 *        stack in numbers.
 *   ✅ remove `overflow: auto` from `.compare-pane__body`
 *      → "AssertionError: expected 0 to be greater than 0" — `scrollTop`
 *        stayed 0 when scrolled. The `scrollHeight > clientHeight` line above
 *        it stayed GREEN under this mutation (true of a clipped box too),
 *        which is exactly why the actually-scroll-it line exists.
 *   ✅ remove the `.compare-pane__body .jsonview { overflow-x: visible }`
 *      override → "AssertionError: expected 480 to be greater than 480" —
 *      `.jsonview`'s own `overflow-x: auto` trapped the wide value's
 *      scrollbar inside the tree (at its very bottom, 400 rows down), so the
 *      pane body never overflowed horizontally at all.
 *   ✅ the highlight claim catches a cascade bug:
 *      "AssertionError: expected 'rgba(0, 0, 0, 0)' not to be
 *      'rgba(0, 0, 0, 0)'" — jsonview.css's `button.jsonview__key`
 *      UA-reset (0-1-1) outguns `.jsonview__key--selected` (0-1-0), so a
 *      selected BUTTON key lost its accent-soft fill. Patched scoped in
 *      compare.css; the root fix belongs in jsonview.css.
 *   ❌ `grid-template-rows: minmax(0, 1fr)` on `.compare-split` was tried as
 *      a row-growth guard and REMOVING it kept all three tests green — Chromium
 *      does not grow the implicit row past the split here (the pane is
 *      `overflow: hidden`). A rule the tests cannot distinguish is a silent
 *      safety net, so it is NOT shipped; this line records
 *      the attempt so it is not re-added on superstition.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts \
 *        src/features/api/compare.browser.test.tsx`
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ComparePanel } from "./ComparePanel";
import type { HttpResponse } from "./httpIpc";
import "../../App.css";

afterEach(cleanup);
beforeEach(() => {
  resetStore();
});

const api = () => useAppStore.getState().apiActions;

const jsonResponse = (value: unknown): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body: JSON.stringify(value),
  durationMs: 42,
  sizeBytes: 128,
  truncated: false,
});

/** Compare on, both sides landed — the panel's home state. */
function seed(a: unknown, b: unknown): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, { url: "https://a.test/x" });
  api().setCompareEnabled(id, true);
  api().patchCompare(id, { method: "POST", url: "https://b.test/y" });
  api().setCompareResponse(id, "a", jsonResponse(a));
  api().setCompareResponse(id, "b", jsonResponse(b));
  return id;
}

/**
 * Mount inside a stand-in for `.api-view`'s box (api.css): a definite-size
 * flex column with `overflow-y: auto` and the same padding — the environment
 * whose floor/shrink chain compare.css is written against.
 */
function renderSized(id: string) {
  return render(
    <div
      data-testid="api-view-stand-in"
      style={{
        width: "1000px",
        height: "600px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "12px 14px",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      <ComparePanel requestId={id} />
    </div>,
  );
}

const rect = (testId: string) =>
  screen.getByTestId(testId).getBoundingClientRect();

/** 400 rows deep and one 500-char value wide — must scroll INSIDE its pane. */
const LONG_AND_WIDE: Record<string, unknown> = {};
for (let i = 0; i < 400; i++) {
  LONG_AND_WIDE[`key_${String(i).padStart(3, "0")}`] = i;
}
LONG_AND_WIDE.wide = "w".repeat(500);

describe("ComparePanel — the split, with a real layout engine", () => {
  it("lays the panes side by side in equal halves, within the split's budget", () => {
    const id = seed({ name: "alpha", n: 1 }, { name: "beta" });
    renderSized(id);

    const a = rect("compare-pane-a");
    const b = rect("compare-pane-b");

    // Side by side, not stacked: B starts at or right of A's edge, tops equal.
    expect(b.left).toBeGreaterThanOrEqual(a.right);
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);

    // Equal halves.
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(2);

    // The BUDGET, not the symptom: widths + gap fit the split's
    // client box. This line fails with the arithmetic that names the fix.
    const split = screen.getByTestId("compare-split");
    const gap = parseFloat(getComputedStyle(split).columnGap);
    expect(a.width + gap + b.width).toBeLessThanOrEqual(split.clientWidth + 1);
  });

  it("scrolls a long, wide response INSIDE its pane body — the surface never scrolls", () => {
    const id = seed(LONG_AND_WIDE, { name: "beta" });
    renderSized(id);

    const body = screen.getByTestId("compare-body-a");

    // The content really overflows the body both ways…
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(body.scrollWidth).toBeGreaterThan(body.clientWidth);
    // …and the body is the box that SCROLLS — asserted by scrolling it, since
    // `scrollWidth > clientWidth` alone is also true of a visible/clipped box.
    body.scrollTop = 500;
    expect(body.scrollTop).toBeGreaterThan(0);
    body.scrollLeft = 200;
    expect(body.scrollLeft).toBeGreaterThan(0);

    // The outer surface pays nothing for it: no horizontal overflow, and the
    // panel's height stayed inside the 600px stand-in (the row-growth
    // failure would show up here as thousands of px of scrollHeight).
    const container = screen.getByTestId("api-view-stand-in");
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    expect(container.scrollHeight).toBeLessThanOrEqual(
      container.clientHeight + 1,
    );
  });

  it("paints a selected key visibly distinct from an unselected one", () => {
    const id = seed({ name: "alpha", other: 1 }, { name: "beta" });
    renderSized(id);

    const bodyA = screen.getByTestId("compare-body-a");
    const keyOf = (name: string) =>
      within(bodyA)
        .getAllByTestId("json-key")
        .find((k) => k.getAttribute("data-key") === name) as HTMLElement;

    fireEvent.click(keyOf("name"));

    const selected = bodyA.querySelector(
      '[data-selected="true"]',
    ) as HTMLElement;
    expect(selected).not.toBeNull();
    const unselected = keyOf("other");

    // Real computed styles from the real engine: the accent-soft chip and its
    // 1px accent ring, vs. the plain transparent key button.
    const s = getComputedStyle(selected);
    const u = getComputedStyle(unselected);
    expect(s.backgroundColor).not.toBe(u.backgroundColor);
    expect(s.boxShadow).not.toBe(u.boxShadow);
  });
});
