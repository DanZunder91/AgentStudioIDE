/**
 * ResultsGrid's find reveal — layer 5, the real-browser tier.
 *
 * The jsdom suite can prove the *arithmetic* of "take me to the match" (it asserts
 * exact scrollTop values, because jsdom's `scrollTop` is genuine state), and it can
 * prove the component **passes the right boxes** to that arithmetic. What it cannot
 * prove is that those boxes are the right boxes, because jsdom has no layout engine:
 * every `getBoundingClientRect()` there is 0×0, so the horizontal half is stubbed and
 * the vertical half is checked against a row height the test asserts rather than
 * measures. Both would be vacuously green against a grid whose real geometry
 * disagreed.
 *
 * Two claims therefore live here, and only here:
 *
 *   1. **A match nine screens down really ends up inside the visible box** — real
 *      row heights, the real sticky header, the real windowing that has to render
 *      the row before it can be seen at all.
 *   2. **A match in a column off the right edge really ends up inside it too** —
 *      the axis that had no reveal at all until this change, and the one whose
 *      geometry is entirely a product of `table-layout: fixed` + `<colgroup>`.
 *
 * ── Falsified before being trusted ───────────────────────────────────────────
 * Each rule was reverted in the source, the run observed, and the source restored
 * byte-identically. The failures, verbatim:
 *
 *   ✅ delete `if (top !== null) box.scrollTop = top` from `revealHit`
 *      → "expect(received).toBeInTheDocument() … Received has value: null" — row 90
 *        is never even RENDERED, which is the windowing point this tier exists to
 *        make: with no scroll there is no element, so no DOM-call reveal could have
 *        worked either.
 *   ✅ delete `if (left !== null) box.scrollLeft = left`
 *      → "expected 7645.484375 to be less than or equal to 600". The matched cell
 *        sits 7 000px off the right edge with its row perfectly placed — exactly the
 *        half-fix that shipping only the vertical axis would have been.
 *   ✅ delete `if (fitsLeft && fitsRight) return null` from `scrollToColumn`
 *      → "expected 7075 to be 7085" in the `nearest` test. Worth recording that this
 *        mutant SURVIVED the first version of that test, which searched column 0 at
 *        offset 0 — see the comment on it.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../../app/store";
import type { DbResultSet } from "../types";
import { ResultsGrid } from "./ResultsGrid";
import { TRACKS_RESULT, WIDE_RESULT } from "./consoleFixtures";

afterEach(() => {
  cleanup();
  // The find bar and the scroll offset live in the module-singleton store, which
  // is the point of them (they outlive a tab move). Between TESTS that is a leak:
  // a record left here pre-opens the next test's bar or restores its scroll.
  useAppStore.setState((s) => {
    s.findBars = {};
    s.scrollOffsets = {};
    s.gridViews = {};
  });
});

/** 100 rows whose only `needle` is in the `note` column of row 90. */
const DEEP_RESULT: DbResultSet = {
  ...TRACKS_RESULT,
  rows: TRACKS_RESULT.rows.concat(
    Array.from({ length: 97 }, (_, i) => [`r${i}`, String(i), i === 87 ? "needle" : "hay"]),
  ),
};

/**
 * 200 columns, one row — with a findable value parked in column 100.
 *
 * The MIDDLE, not the last column: revealing the last one parks the box at its
 * maximum scroll, where the "already visible" test below cannot nudge the view
 * any further right and its assertion becomes unreachable. Column 100 is still
 * thousands of pixels off the right edge of a 600px box.
 */
const NEEDLE_COLUMN = 100;
const WIDE_NEEDLE: DbResultSet = {
  ...WIDE_RESULT,
  rows: [WIDE_RESULT.rows[0].map((v, i) => (i === NEEDLE_COLUMN ? "needle" : v))],
};

/**
 * Render the grid in a definite box — 600 × 400, a plausible output pane.
 *
 * 🔴 `flex-direction: column` and `overflow: hidden`, which is what `.db-result`
 * gives it in the real console, and not an incidental detail. In a ROW flex
 * container `.db-grid` inherits `min-width: auto` — the table's min-content width,
 * 13 000px for a 200-column result — so the scroll box grows to fit its content,
 * nothing ever overflows, and every horizontal assertion below passes without the
 * grid scrolling at all. The first version of this file did exactly that and read
 * as green.
 */
function renderSized(result: DbResultSet) {
  return render(
    <div
      style={{
        width: "600px",
        height: "400px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ResultsGrid result={result} />
    </div>,
  );
}

/** Open the bar and type `query` into it, the way the user does. */
async function search(query: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("db-grid"));
  await user.keyboard("{Control>}f{/Control}");
  await user.type(screen.getByTestId("db-grid-find-input"), query);
  return screen.getByTestId("db-grid-scroll");
}

describe("ResultsGrid — the find reveal, with a real layout engine", () => {
  it("really brings a row 90 down onto the screen", async () => {
    renderSized(DEEP_RESULT);
    const box = await search("needle");

    // The row has to be RENDERED first: rows are windowed, so revealing it is a
    // scroll that changes which rows exist. That is why the mechanism is index
    // arithmetic and not `scrollIntoView` — there is no element to call it on.
    await waitFor(() => {
      expect(document.querySelector('tr[data-row="90"]')).toBeInTheDocument();
    });

    const viewport = box.getBoundingClientRect();
    const row = (document.querySelector('tr[data-row="90"]') as HTMLElement).getBoundingClientRect();
    // Fully inside the box, and below the sticky header rather than under it.
    const header = (
      document.querySelector(".db-grid thead tr") as HTMLElement
    ).getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(header.bottom);
    expect(row.bottom).toBeLessThanOrEqual(viewport.bottom);
    // Two-sided: it took a real scroll to get there, not a lucky short result.
    expect(box.scrollTop).toBeGreaterThan(0);
  });

  it("really brings a match in column 100 onto the screen", async () => {
    renderSized(WIDE_NEEDLE);
    const box = await search("needle");

    const viewport = box.getBoundingClientRect();
    const mark = screen.getByTestId("db-grid-hit-current").getBoundingClientRect();
    expect(mark.left).toBeGreaterThanOrEqual(viewport.left);
    expect(mark.right).toBeLessThanOrEqual(viewport.right);
    expect(box.scrollLeft).toBeGreaterThan(0);
  });

  it("leaves a match that is already on screen exactly where it is", async () => {
    // 🔴 This has to be measured, not guessed. The obvious version — search a
    // value in column 0 and assert `scrollLeft === 0` — is green under a
    // `scrollToColumn` with its already-visible check DELETED, because at offset 0
    // both alignments compute a delta of 0 (or a negative one the clamp eats). So
    // the box is nudged 10px off the position the reveal chose: the column is
    // still fully visible, but no longer flush with either edge, which is the only
    // state in which "already visible" and "align to an edge" give different
    // answers. Stepping onto that same (only) match must then move nothing.
    renderSized(WIDE_NEEDLE);
    const box = await search("needle");
    const revealed = box.scrollLeft;
    expect(revealed).toBeGreaterThan(0);

    box.scrollLeft = revealed + 10;
    const user = userEvent.setup();
    await user.click(screen.getByTestId("db-grid-find-next"));

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    expect(box.scrollLeft).toBe(revealed + 10);
    expect(box.scrollTop).toBe(0);
  });
});
