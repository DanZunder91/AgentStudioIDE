/**
 * DbConsole — layer 5, the real-browser tier.
 *
 * Two claims live here and **cannot** live in the jsdom suite, because jsdom has no
 * layout engine: every `getBoundingClientRect()` there is 0×0, so a height or a
 * scrollWidth assertion under jsdom is not merely weak, it is *vacuously green*.
 *
 *   1. **The internal divider really resizes the two panes.** The unit tier stubs the
 *      container height and therefore proves the fraction arithmetic only.
 *   2. **A 200-column result scrolls inside its own box** rather than widening the
 *      console, the tab, or the window.
 *   3. **The grid fills its pane** — a content-sized scroll box let
 *      the horizontal scrollbar eat the only row of a 1-row result and, less visibly,
 *      disabled row windowing. Both are pixel facts.
 *   4. **A column can be dragged wider or narrower**.
 *
 * ── Falsified before being trusted, and two claims were WEAKER than they looked ──
 * A green assertion that cannot go red is worse than no assertion, so
 * every claim here was mutated and the run observed. The record, verbatim:
 *
 *   ✅ pin the panes to `flexGrow: 0.5`, ignoring the dragged fraction
 *      → "AssertionError: expected 280.5 to be greater than 280.5". Caught.
 *   ✅ drop `box-sizing: border-box` from the grid's cells
 *      → "AssertionError: expected 23 to be 22". Caught — and this is the bug this
 *        tier found in the first place: a cell's border sat OUTSIDE its 22px height,
 *        so every row was 23px while `visibleWindow` did its spacer maths in 22.
 *        One px per row is 500px of drift over 500 rows: a scrollbar that lies, and
 *        completely invisible under jsdom.
 *   ✅ change the grid's `overflow: auto` to `overflow: visible`
 *      → "AssertionError: expected 0 to be greater than 0". Caught ONLY after the
 *        assertion was strengthened: the original `scrollWidth > clientWidth` check
 *        stayed green under that mutation (it is true of an overflowing
 *        `overflow: visible` box too), so the test now actually scrolls the box.
 *   ✅ put `.db-result[data-kind="rows"]` back to `flex: 0 0 auto`
 *      → three reds, and they name the original bug in numbers: "expected 56 to
 *        be greater than 220.5" (the 56px table in a 280px pane), "expected 0 to be
 *        greater than 24" (zero clearance between the last row and the scrollbar), and
 *        "expected 12032 to be less than 12000" (windowing off — the 500-row table's
 *        full height became the viewport it was supposed to window against).
 *   ✅ put the table back to `width: max-content`
 *      → "expected 502.0625 to be less than 502.0625": a 120px drag moving the column
 *        0px, because a content-sized table treats its `<col>` widths as ratios.
 *   ✅ drop `min-height: 0` from `.db-grid`
 *      → "expected 12032 to be less than 12000". A scroll container's min-content height
 *        is its full content height in Chromium, so the minimum climbed the whole chain.
 *   ❌ remove `overflow: hidden` from `.db-console` → all 5 still passed. The
 *      "the console is not widened" assertions do NOT distinguish that mutation,
 *      because the 900px wrapper already constrains the console's width. They are
 *      kept as regression guards, not as proof, and this line says so rather than
 *      letting them look stronger than they are.
 *
 * Also worth recording: the drag test first passed for the wrong reason. A bare
 * `window.dispatchEvent` leaves React's state update unflushed, so the measurement
 * read the PRE-drag layout — hence `fireEvent(window, …)`, which wraps in `act()`.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DbConsole, type DbConsoleProps } from "./DbConsole";
import { AT_LIMIT_RESULT, MESSAGE_RESULT, WIDGETS_RESULT, WIDE_RESULT } from "./consoleFixtures";

afterEach(cleanup);

const base: DbConsoleProps = {
  engineLabel: "PostgreSQL",
  queryLanguage: "sql",
  text: "SELECT code, secs FROM tracks\nWHERE at > now() - interval '1 day'",
  onTextChange: () => {},
  onRun: () => {},
  onCancel: () => {},
  running: false,
  results: [],
  error: null,
  readOnly: true,
  serverEnforcedReadOnly: true,
  rowLimit: 500,
};

/** Render the console inside a definite box — the tab body it will really live in. */
function renderSized(props: Partial<DbConsoleProps> = {}, width = "900px") {
  return render(
    <div style={{ width, height: "600px" }}>
      <DbConsole {...base} {...props} />
    </div>,
  );
}

const heightOf = (testId: string) => screen.getByTestId(testId).getBoundingClientRect().height;

describe("DbConsole — the internal split, with a real layout engine", () => {
  it("starts with two panes of comparable height and a divider between them", () => {
    renderSized();
    const editor = heightOf("db-console-editor-pane");
    const output = heightOf("db-console-output-pane");
    expect(editor).toBeGreaterThan(100);
    expect(output).toBeGreaterThan(100);
    // A 50/50 split of the same box: equal to within the 6px divider's rounding.
    expect(Math.abs(editor - output)).toBeLessThan(2);
  });

  it("dragging the divider DOWN really grows the editor and shrinks the output", () => {
    renderSized();
    const before = heightOf("db-console-editor-pane");
    const outputBefore = heightOf("db-console-output-pane");

    const divider = screen.getByTestId("db-console-divider");
    const start = divider.getBoundingClientRect().top;
    fireEvent.pointerDown(divider, { clientY: start });
    // `fireEvent`, not a bare `dispatchEvent`: it wraps the dispatch in `act()`, so
    // React's state update is flushed before the next `getBoundingClientRect()`.
    // Without it the measurement below reads the PRE-drag layout and the test passes
    // for the wrong reason — the first thing this file caught about itself.
    fireEvent(window, new MouseEvent("pointermove", { clientY: start + 120, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    const after = heightOf("db-console-editor-pane");
    const outputAfter = heightOf("db-console-output-pane");
    expect(after).toBeGreaterThan(before);
    expect(outputAfter).toBeLessThan(outputBefore);
    // Pixels, not proportions: a 120px drag moves ~120px of pane.
    expect(after - before).toBeGreaterThan(100);
    // And the total is conserved — the split cannot leak height out of the tab.
    expect(Math.abs(after + outputAfter - (before + outputBefore))).toBeLessThan(2);
  });

  it("keeps both panes on screen when dragged to the clamp", () => {
    renderSized();
    const divider = screen.getByTestId("db-console-divider");
    fireEvent.pointerDown(divider, { clientY: divider.getBoundingClientRect().top });
    fireEvent(window, new MouseEvent("pointermove", { clientY: 5000, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    // 15% of ~594px of pane box — small, but never gone.
    expect(heightOf("db-console-output-pane")).toBeGreaterThan(50);
    expect(heightOf("db-console-editor-pane")).toBeGreaterThan(50);
  });
});

describe("ResultsGrid — a 200-column result scrolls inside its own box", () => {
  it("overflows horizontally in the grid's scroll container, not in the console", () => {
    renderSized({ results: [WIDE_RESULT] });

    const scroll = screen.getByTestId("db-grid-scroll");
    // The table really is wider than its box (200 columns × ≥6ch)…
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    // …and this box is the one that SCROLLS. Asserted by actually scrolling it:
    // `scrollWidth > clientWidth` alone is true of an `overflow: visible` box too,
    // so it does not distinguish "scrolls here" from "spills everywhere".
    scroll.scrollLeft = 500;
    expect(scroll.scrollLeft).toBeGreaterThan(0);

    // …and that width stops there. Regression guards, honestly labelled: they did
    // not catch removing `overflow: hidden` from `.db-console` (the fixed-width
    // wrapper constrains it anyway), so they are a floor, not a proof.
    const console_ = screen.getByTestId("db-console");
    expect(console_.scrollWidth).toBeLessThanOrEqual(console_.clientWidth + 1);
    expect(console_.getBoundingClientRect().width).toBeLessThanOrEqual(900);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(document.body.clientWidth);
  });

  it("keeps rows at the published row height, which is what makes the windowing exact", () => {
    renderSized({ results: [WIDE_RESULT] });
    const row = document.querySelector("tr[data-row='0']") as HTMLElement;
    // `ROW_HEIGHT_PX`, the same constant `visibleWindow` does its arithmetic in. If CSS
    // and the maths ever disagree, the scrollbar starts lying — and only a real layout
    // engine can catch that.
    expect(row.getBoundingClientRect().height).toBe(24);
  });
});

/**
 * 🔴 The original bug: `SELECT * FROM widgets` returned 1 row and the
 * grid drew a 56px table in a ~280px output pane — a void beneath it, and the horizontal
 * scrollbar lying across the only row, slicing it in half.
 *
 * Every assertion here is a pixel claim, so this tier is the only place they can live;
 * under jsdom all four are vacuously green. They are three separate consequences of one
 * cause — a scroll box that was exactly as tall as its content:
 *   1. the scrollbar is subtracted from the CONTENT box, so the last row pays for it;
 *   2. `clientHeight === scrollHeight`, which is the number `visibleWindow` windows on,
 *      so virtualisation silently stopped windowing;
 *   3. and the pane's remaining height went unused.
 */
describe("ResultsGrid — the grid fills its pane instead of shrink-wrapping", () => {
  /** The bottom of the scroll box's *client* area — i.e. above any horizontal bar. */
  const clientBottom = (box: HTMLElement) => box.getBoundingClientRect().top + box.clientHeight;

  it("🔴 keeps the only row of a 1-row result clear of the horizontal scrollbar", () => {
    // A 420px pane, so the three columns cannot fit and a horizontal scrollbar is
    // guaranteed — there has to be a bar for the bug to be about. (At 900px this
    // fixture now fits outright, which is the other half of the same fix: the table is
    // sized by its `<col>` widths instead of by its content.)
    renderSized({ results: [WIDGETS_RESULT] }, "420px");
    const scroll = screen.getByTestId("db-grid-scroll");
    const row = document.querySelector("tr[data-row='0']") as HTMLElement;

    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    // …and the row sits entirely inside the visible client area. Before the fix the row
    // ran to `box.top + 56` while `clientHeight` was ~41: the bottom half was under
    // the bar. A full row of clearance, not a single pixel.
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(clientBottom(scroll));
    expect(clientBottom(scroll) - row.getBoundingClientRect().bottom).toBeGreaterThan(24);
  });

  it("🔴 gives a single result the output pane's height rather than 56px of it", () => {
    renderSized({ results: [WIDGETS_RESULT] });
    const pane = heightOf("db-console-output-pane");
    const grid = heightOf("db-grid");
    // The grid is everything the pane has left after the "Output" strip and the
    // statement's own header — within ~60px of the pane, not a quarter of it.
    expect(pane).toBeGreaterThan(200);
    expect(grid).toBeGreaterThan(pane - 60);
  });

  it("🔴 still windows a 500-row result — the scroll box is shorter than its table", () => {
    renderSized({ results: [AT_LIMIT_RESULT] });
    const scroll = screen.getByTestId("db-grid-scroll");
    // The box scrolls internally instead of growing to 500 × 24px…
    expect(scroll.clientHeight).toBeLessThan(500 * 24);
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    // …and because `clientHeight` is now a real viewport, `visibleWindow` is windowing:
    // a screenful plus overscan, nowhere near 500 rows in the DOM. When the box was
    // content-tall this was 500 — the bug that hid behind the cosmetic one.
    const rendered = document.querySelectorAll("tr[data-row]").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    // The scrollbar still tells the truth about the full result.
    expect(scroll.scrollHeight).toBeGreaterThanOrEqual(500 * 24);
  });

  it("leaves a prose result exactly as tall as its text", () => {
    // The counter-case: `flex: 1 1 auto` belongs to `rows` only. A syntax error must not
    // be stretched to fill a pane, or one failed statement looks like the whole output.
    renderSized({ results: [MESSAGE_RESULT] });
    const block = screen.getByTestId("db-result").getBoundingClientRect().height;
    expect(block).toBeGreaterThan(20);
    expect(block).toBeLessThan(120);
  });
});

describe("ResultsGrid — columns can be resized", () => {
  const colWidth = (index: number) =>
    (document.querySelectorAll("thead th")[index] as HTMLElement).getBoundingClientRect().width;

  it("🔴 dragging a header's handle widens that column and leaves the others alone", () => {
    // The reference case: `id` is a 66-char hash that took the 48ch cap and pushed the
    // other two columns off the right edge. The heuristic cannot be right for every
    // table, so the user gets the last word — and this is the pixel proof it works.
    renderSized({ results: [WIDGETS_RESULT] });
    const before = colWidth(0);
    const otherBefore = colWidth(1);

    const handle = screen.getByTestId("db-grid-resize-0");
    const start = handle.getBoundingClientRect().left;
    fireEvent.pointerDown(handle, { clientX: start });
    fireEvent(window, new MouseEvent("pointermove", { clientX: start - 120, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    const after = colWidth(0);
    expect(after).toBeLessThan(before);
    // Pixels, not proportions: a 120px drag moves ~120px of column.
    expect(before - after).toBeGreaterThan(100);
    // The 120px did not come out of its neighbour — the filler column absorbed it, which
    // is the entire reason the filler exists.
    expect(Math.abs(colWidth(1) - otherBefore)).toBeLessThan(2);
    // …and the drag released the global class.
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("🔴 leaves a single narrow column beside its own header instead of stretching it", () => {
    // `SELECT id FROM events`: one `bigint` column in a 900px pane. Stretched, its values
    // sat ~850px from the header they belong to. The filler takes the slack instead, so
    // the table still fills the pane and the column still fits its data.
    renderSized({ results: [AT_LIMIT_RESULT] });
    const table = (document.querySelector("table") as HTMLElement).getBoundingClientRect();
    const filler = document.querySelector("thead .db-grid__filler") as HTMLElement;

    expect(colWidth(0)).toBeLessThan(160);
    // The table still spans the pane — the leftover is in the filler, not in the column.
    expect(table.width).toBeGreaterThan(850);
    expect(filler.getBoundingClientRect().width).toBeGreaterThan(600);
  });

  it("🔴 shows a short column name in full instead of ellipsising its own header", () => {
    renderSized({ results: [WIDGETS_RESULT] });
    const name = document.querySelectorAll(".db-grid__name")[1] as HTMLElement;
    expect(name.textContent).toBe("name");
    // `scrollWidth > clientWidth` is exactly the condition that draws the ellipsis, and
    // `name` rendered as "na…" until the `<col>` width stopped spending the cell's 18px of
    // padding and borders out of its text.
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  });

  it("nudges a column by keyboard, and double-click puts it back", () => {
    renderSized({ results: [WIDGETS_RESULT] });
    const handle = screen.getByTestId("db-grid-resize-1");
    const sampled = colWidth(1);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(colWidth(1)).toBeGreaterThan(sampled);
    fireEvent.doubleClick(handle);
    // Back to the sampled `ch` fit — which is the auto-fit, being the same measurement
    // the first paint used.
    expect(Math.abs(colWidth(1) - sampled)).toBeLessThan(2);
  });
});
