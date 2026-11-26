/** Real-browser proof that a match far down, or far right, ends up inside the visible box: jsdom
 * rects are 0x0, so those claims are vacuous there. Each reveal rule was reverted and seen red. */

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

/** The MIDDLE column: revealing the last parks the box at max scroll, where the already-visible
 * test could not nudge it further right. */
const NEEDLE_COLUMN = 100;
const WIDE_NEEDLE: DbResultSet = {
  ...WIDE_RESULT,
  rows: [WIDE_RESULT.rows[0].map((v, i) => (i === NEEDLE_COLUMN ? "needle" : v))],
};

/** Column flex + overflow: hidden, as .db-result gives it: in a ROW flex container min-width:
 * auto grows the box to its 13 000px content, and nothing ever scrolls. */
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
    // Nudge the box 10px off the reveal's position: only then do "already visible" and
    // "align to an edge" differ (at offset 0 a deleted visibility check still passes).
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
