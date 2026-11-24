/**
 * ResultsGrid tests.
 *
 * Nothing is mocked: the component takes one `DbResultSet` and renders. The fixtures
 * are inputs and every expected string is written out here.
 *
 * ── What jsdom can and cannot be asked here ──────────────────────────────────
 * jsdom has no layout engine, so a width or a scroll *position* assertion in this
 * file would be vacuous. What IS real here is **structure**: how many cells exist,
 * which attributes distinguish a NULL from an empty string, that a 200-column row
 * lives inside exactly one overflow container, and that the windowing arithmetic
 * picks the right rows for a given scrollTop. The two claims that need real pixels —
 * the grid scrolls internally instead of widening its pane, and the divider actually
 * moves — are asserted in `DbConsole.browser.test.tsx`.
 *
 * The viewport-measurement tests stub `clientHeight` deliberately, and that stub is
 * honest about what it proves: it pins that we *feed the measurement into the window
 * maths*, not that jsdom measured anything.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../../app/store";
import type { DbResultSet } from "../types";
import { ResultsGrid } from "./ResultsGrid";
import {
  AT_LIMIT_RESULT,
  EMPTY_RESULT,
  KINDS_RESULT,
  TRACKS_RESULT,
  TRUNCATED_RESULT,
  WIDE_RESULT,
} from "./consoleFixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The find bars live in the module-singleton store (that is the fix under
  // test: they must outlive an unmount). Between TESTS that survival is a
  // leak — a record left by one test would pre-open the bar, or pre-fill the
  // query, in the next test's render.
  useAppStore.setState((s) => {
    s.findBars = {};
    // …and the scroll offsets, for the same reason and with sharper teeth: a
    // test that scrolls to row 992 and unmounts leaves an offset the NEXT
    // test's mount restores, so the window renders rows nobody asked for and
    // the failure lands in an unrelated test.
    s.scrollOffsets = {};
    s.gridViews = {};
  });
});

/**
 * The `<td>`s of one body row, by row index — the result's own cells only.
 *
 * `td[data-kind]` and not `td`: every row also ends in the aria-hidden filler cell that
 * absorbs leftover width (see `ResultsGrid.tsx`), and counting that as a column would
 * make "a ragged row has exactly 3 cells" mean nothing.
 */
function cellsOfRow(index: number): HTMLElement[] {
  const row = document.querySelector(`tr[data-row="${index}"]`) as HTMLElement;
  return Array.from(row.querySelectorAll("td[data-kind]"));
}

/**
 * 100 rows whose ONLY "needle" is in the `note` column of row 90 — the shape every
 * "take me to the match" assertion needs: one unambiguous hit, far below any
 * viewport this tier can produce.
 */
const DEEP_RESULT: DbResultSet = {
  ...TRACKS_RESULT,
  rows: TRACKS_RESULT.rows.concat(
    Array.from({ length: 97 }, (_, i) => [`r${i}`, String(i), i === 87 ? "needle" : "hay"]),
  ),
};

/**
 * Where revealing `DEEP_RESULT`'s needle must land the scroll box, written out
 * rather than imported: a constant read from the code under test cannot disagree
 * with it.
 *
 * Row 90 starts at `90 × ROW_HEIGHT_PX (24) = 2160`. `scrollToRow` then backs off
 * by the sticky header (44) plus one row (24) so the match does not sit half-hidden
 * under the column names: `2160 − 68 = 2092`. A change to the row height, the header
 * allowance or the landing rule reds every test using this, by design.
 */
const NEEDLE_SCROLL_TOP = 2092;

/* ══════════ the assertion that protects the backend's whole design ═════════ */

describe("ResultsGrid — NULL, the empty string and whitespace are distinguishable", () => {
  it("marks a SQL NULL and an empty string with DIFFERENT DOM attributes", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    // Row 1 of the fixture is ["BLU", null, ""] — the pair, side by side.
    const [code, secs, note] = cellsOfRow(1);

    expect(code).toHaveTextContent("BLU");

    // The NULL cell: its own display state, a visible "NULL" chip, and the
    // `data-null` hook the E2E tier reads.
    expect(secs).toHaveAttribute("data-null", "true");
    expect(secs).toHaveAttribute("data-display", "null");
    expect(secs).not.toHaveAttribute("data-empty");
    expect(secs).toHaveTextContent("NULL");
    expect(secs).toHaveAttribute("title", "SQL NULL");
    expect(secs.querySelector(".db-grid__null")).not.toBeNull();

    // The empty-string cell: no NULL chip, no text at all, its own hook.
    expect(note).toHaveAttribute("data-empty", "true");
    expect(note).toHaveAttribute("data-display", "empty");
    expect(note).not.toHaveAttribute("data-null");
    expect(note.textContent).toBe("");
    expect(note).toHaveAttribute("title", "Empty string");
    expect(note.querySelector(".db-grid__null")).toBeNull();

    // And the thing a user must be able to do without clicking: tell them apart.
    expect(secs.getAttribute("data-display")).not.toBe(note.getAttribute("data-display"));
  });

  it("marks a whitespace-only value as a third, distinct state", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const note = cellsOfRow(2)[2]; // ["COR", "0", "   "]
    expect(note).toHaveAttribute("data-display", "whitespace");
    expect(note).not.toHaveAttribute("data-null");
    expect(note).not.toHaveAttribute("data-empty");
    expect(note).toHaveAttribute("title", "Whitespace only (3 characters)");
  });
});

/* ═════════════════════════════ columns ═══════════════════════════════════ */

describe("ResultsGrid — columns", () => {
  it("renders the columns in order, each with the server's own type name", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.querySelector(".db-grid__name")?.textContent)).toEqual([
      "code",
      "secs",
      "note",
    ]);
    // Verbatim, not mapped to a name of ours — `varchar(8)`, not "string".
    expect(headers.map((h) => h.querySelector(".db-grid__type")?.textContent)).toEqual([
      "varchar(8)",
      "numeric",
      "text",
    ]);
  });

  it("carries each column's kind onto its header and its cells, so CSS never guesses", () => {
    render(<ResultsGrid result={KINDS_RESULT} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.getAttribute("data-kind"))).toEqual([
      "text",
      "number",
      "bool",
      "json",
      "binary",
      "datetime",
      "unknown",
    ]);
    expect(cellsOfRow(0).map((c) => c.getAttribute("data-kind"))).toEqual([
      "text",
      "number",
      "bool",
      "json",
      "binary",
      "datetime",
      "unknown",
    ]);
  });

  it("right-aligns numbers, one-lines json, and leaves datetime and binary alone", () => {
    render(<ResultsGrid result={KINDS_RESULT} />);
    const [text, number, bool, json, binary, datetime, unknown] = cellsOfRow(0);
    expect(text).toHaveTextContent("hello");
    expect(number).toHaveStyle({ textAlign: "right" });
    expect(text).toHaveStyle({ textAlign: "left" });
    // The server's `t`, not a client-rendered "true".
    expect(bool.textContent).toBe("t");
    expect(json.textContent).toBe('{ "a": 1 }');
    // …and the cell says it was collapsed, so it cannot pass one line off as all.
    expect(json).toHaveAttribute("data-collapsed", "true");
    expect(json).toHaveAttribute("title", '{\n  "a": 1\n}');
    expect(binary.textContent).toBe("\\x48656c6c6f");
    expect(datetime.textContent).toBe("2026-07-30 09:15:00+00");
    expect(datetime).not.toHaveAttribute("data-collapsed");
    expect(unknown.textContent).toBe("POINT(1 2)");
  });

  it("does not break on a ragged row: the cell says 'missing', never 'NULL'", () => {
    const ragged: DbResultSet = { ...TRACKS_RESULT, rows: [["AMB"]] };
    render(<ResultsGrid result={ragged} />);
    const cells = cellsOfRow(0);
    expect(cells).toHaveLength(3);
    expect(cells[1]).toHaveAttribute("data-display", "missing");
    expect(cells[1]).not.toHaveAttribute("data-null");
  });
});

/* ═══════════════════════════ the empty result ════════════════════════════ */

describe("ResultsGrid — a result with no rows", () => {
  it("says the statement ran and matched nothing, rather than looking broken", () => {
    render(<ResultsGrid result={EMPTY_RESULT} />);
    expect(screen.getByTestId("db-grid-empty")).toHaveTextContent(
      "No rows. The statement ran and matched nothing.",
    );
    // The header still renders, so the user can see WHAT matched nothing.
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(document.querySelectorAll("tr[data-row]")).toHaveLength(0);
    // No spacer rows either — an empty result is not a scrolled-off one.
    expect(screen.queryByTestId("db-grid-pad-top")).toBeNull();
    expect(screen.queryByTestId("db-grid-pad-bottom")).toBeNull();
  });

  it("spans the empty message across a result that has no columns at all", () => {
    render(<ResultsGrid result={{ ...EMPTY_RESULT, columns: [] }} />);
    // colSpan must never be 0 — the row would collapse and the message vanish. With no
    // columns there is also no filler to span, so this stays 1.
    expect(screen.getByTestId("db-grid-empty")).toHaveAttribute("colspan", "1");
    expect(screen.queryByTestId("db-grid-col-filler")).toBeNull();
  });

  it("spans the empty message across the filler too, so the strip is not half-width", () => {
    render(<ResultsGrid result={EMPTY_RESULT} />);
    // 1 real column + the filler.
    expect(screen.getByTestId("db-grid-empty")).toHaveAttribute("colspan", "2");
  });
});

/**
 * The filler column.
 *
 * `min-width: 100%` makes a narrow result look like a grid instead of a ragged strip, but
 * the slack it adds is handed to the *data* columns: a one-column result stretched `id`
 * across the whole pane and left its numbers 900px from their own header, and a column
 * dragged narrower gave its space straight back to itself. One trailing auto-width column
 * puts the leftover somewhere harmless. It must stay invisible to a11y and to anything
 * counting columns — that is what these assertions are for.
 */
describe("ResultsGrid — the filler column is geometry, not a column", () => {
  it("adds exactly one filler to the header and to every row", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    expect(document.querySelectorAll("thead .db-grid__filler")).toHaveLength(1);
    // One per rendered row, and no more.
    expect(document.querySelectorAll("tbody tr[data-row] .db-grid__filler")).toHaveLength(3);
    for (const cell of document.querySelectorAll(".db-grid__filler")) {
      expect(cell).toHaveAttribute("aria-hidden", "true");
      expect(cell.textContent).toBe("");
    }
  });

  it("is invisible to the roles that count the result's columns", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    // 3 columns, not 4 — an aria-hidden cell is out of the accessibility tree, which is
    // what keeps the filler from being read out as a fourth, nameless column.
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getAllByRole("cell")).toHaveLength(9);
  });

  it("has no resize handle — there is no boundary past the last column", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    expect(document.querySelectorAll(".db-grid__resize")).toHaveLength(3);
    expect(screen.queryByTestId("db-grid-resize-3")).toBeNull();
  });
});

/* ═════════════════════════ truncation is loud ════════════════════════════ */

describe("ResultsGrid — truncation", () => {
  it("announces a capped result in a persistent strip above the grid", () => {
    render(<ResultsGrid result={TRUNCATED_RESULT} />);
    const strip = screen.getByTestId("db-grid-truncated");
    expect(strip).toHaveTextContent(
      "Showing the first 500 rows of more — the row limit (500) cut this result. " +
        "Raise the limit or narrow the query.",
    );
    // role="status" so it is announced, and it lives OUTSIDE the scroll box —
    // scrolling to the bottom must not scroll the warning away.
    expect(strip).toHaveAttribute("role", "status");
    expect(screen.getByTestId("db-grid-scroll").contains(strip)).toBe(false);
  });

  it("shows no strip for 500 rows that were honestly all of them", () => {
    render(<ResultsGrid result={AT_LIMIT_RESULT} />);
    expect(screen.queryByTestId("db-grid-truncated")).toBeNull();
  });
});

/* ═══════════════════════ a very wide row (200 columns) ═══════════════════ */

describe("ResultsGrid — a 200-column row", () => {
  it("renders every column and every cell without dropping any", () => {
    render(<ResultsGrid result={WIDE_RESULT} />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(200);
    const cells = cellsOfRow(0);
    expect(cells).toHaveLength(200);
    expect(cells[0]).toHaveTextContent("v0");
    expect(cells[199]).toHaveTextContent("v199");
    // A <col> per column, so `table-layout: fixed` has a width for each — plus the one
    // trailing filler that owns the leftover width.
    expect(document.querySelectorAll("colgroup col")).toHaveLength(201);
    expect(screen.getByTestId("db-grid-col-filler")).not.toBeNull();
  });

  it("keeps the whole table inside ONE overflow container", () => {
    // jsdom cannot measure, so the structural claim is what is asserted here: the
    // table has exactly one scroll ancestor inside the grid, and it is the box that
    // owns `overflow: auto`. The pixel claim (scrollWidth > clientWidth, and the
    // pane not widening) is in the browser tier.
    render(<ResultsGrid result={WIDE_RESULT} />);
    const scroll = screen.getByTestId("db-grid-scroll");
    const table = document.querySelector("table") as HTMLElement;
    expect(scroll.contains(table)).toBe(true);
    expect(scroll.className).toBe("db-grid__scroll");
    expect(within(screen.getByTestId("db-grid")).getAllByRole("table")).toHaveLength(1);
  });
});

/* ═══════════════════ windowing: 100 000 rows ══════════════════════════ */

describe("ResultsGrid — large results are windowed", () => {
  const huge: DbResultSet = {
    ...TRUNCATED_RESULT,
    truncated: false,
    rows: Array.from({ length: 100_000 }, (_, i) => [String(i + 1)]),
  };

  it("renders a screenful of a 100 000-row result, not 100 000 rows", () => {
    render(<ResultsGrid result={huge} />);
    const rendered = document.querySelectorAll("tr[data-row]");
    // The fallback viewport (600px) / 24px rows = 25 spans, +1 partial, +8 overscan = 34.
    expect(rendered).toHaveLength(34);
    expect(rendered[0]).toHaveAttribute("data-row", "0");
  });

  it("keeps the scroll height honest with a spacer for every row it did not render", () => {
    render(<ResultsGrid result={huge} />);
    // At the top there is nothing above, and 100000 - 34 rows below.
    expect(screen.queryByTestId("db-grid-pad-top")).toBeNull();
    const padBottom = screen.getByTestId("db-grid-pad-bottom");
    expect(padBottom.querySelector("td")).toHaveStyle({ height: `${(100_000 - 34) * 24}px` });
    // Spacers are aria-hidden: they are scrollbar geometry, not data.
    expect(padBottom).toHaveAttribute("aria-hidden", "true");
  });

  it("moves the window when the container scrolls", () => {
    render(<ResultsGrid result={huge} />);
    const scroll = screen.getByTestId("db-grid-scroll");
    // jsdom will not lay out, so the scroll POSITION is injected rather than
    // produced by a real scroll; what is being pinned is that the handler feeds
    // scrollTop into the window maths.
    Object.defineProperty(scroll, "scrollTop", { value: 24_000, configurable: true });
    fireEvent.scroll(scroll);

    const rendered = document.querySelectorAll("tr[data-row]");
    // Row 1000 is at 24000px (24px rows); start = 1000 - 8 overscan.
    expect(rendered[0]).toHaveAttribute("data-row", "992");
    expect(screen.getByTestId("db-grid-pad-top").querySelector("td")).toHaveStyle({
      height: `${992 * 24}px`,
    });
    // The row's own cell content proves it is the right row, not just the right index.
    expect(cellsOfRow(992)[0]).toHaveTextContent("993");
  });

  it("uses the MEASURED viewport height once there is one", () => {
    // Stubbed, and honest about it: this pins that a measurement reaches the window
    // maths. It does not (and under jsdom cannot) prove a measurement is correct.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(220);
    render(<ResultsGrid result={huge} />);
    // 220 / 24 = 10 spans (ceil), +1 partial, +8 overscan = 19 — a much smaller window
    // than the 34 the 600px fallback produces.
    expect(document.querySelectorAll("tr[data-row]")).toHaveLength(19);
  });

  it("re-measures on a window resize", () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get");
    clientHeight.mockReturnValue(220);
    render(<ResultsGrid result={huge} />);
    expect(document.querySelectorAll("tr[data-row]")).toHaveLength(19);

    clientHeight.mockReturnValue(440);
    fireEvent(window, new Event("resize"));
    // 440 / 24 = 19 spans (ceil), +1, +8 = 28.
    expect(document.querySelectorAll("tr[data-row]")).toHaveLength(28);
  });

  it("publishes the row height as a custom property so CSS and the maths agree", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    // `console.css` writes the scroll box's minimum height in this unit, so the two
    // cannot drift apart — see the note on `.db-result`.
    expect(screen.getByTestId("db-grid").style.getPropertyValue("--db-row-h")).toBe("24px");
  });
});

/**
 * Resizable columns.
 *
 * 🔴 The motivating case, `SELECT * FROM widgets`: `id` is a 66-character hash, so the sampled
 * heuristic gave it the full 48ch cap and pushed `name` and `signing_code` off the right
 * edge. A heuristic cannot be right for every table, so the user gets the last word.
 *
 * jsdom has no layout engine, so a *drag* here would start from a 0px header and prove
 * nothing — `startWidthOf` bails on that on purpose. What is real in this tier is the
 * affordance and the state: the handles exist, they are reachable and named, and the
 * `<col>` a width lands on is the right one. The pixel claims (a drag really widens the
 * column, ←/→ really steps it) are in `DbConsole.browser.test.tsx`.
 */
describe("ResultsGrid — resizable columns", () => {
  it("gives every column a named, focusable resize handle", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const handles = ["code", "secs", "note"].map((_, i) => screen.getByTestId(`db-grid-resize-${i}`));
    expect(handles).toHaveLength(3);
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize column code",
      "Resize column secs",
      "Resize column note",
    ]);
    for (const handle of handles) {
      // Keyboard-reachable, and a separator rather than a button: it does not perform
      // an action, it moves a boundary (the same role the console's own divider takes).
      expect(handle).toHaveAttribute("role", "separator");
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("tabindex", "0");
      expect(handle).toHaveAttribute(
        "title",
        "Drag to resize. Double-click to fit the sampled values.",
      );
      // It must live INSIDE its own header cell: `position: absolute` is contained by
      // the sticky `th`, so a handle parented anywhere else lands at the table's edge.
      expect((handle.parentElement as HTMLElement).tagName).toBe("TH");
    }
  });

  it("starts every column at the sampled ch width, with no px override", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    // The heuristic's own numbers: max(name, typeName, sampled cells) + 2, clamped.
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
    expect(screen.getByTestId("db-grid-resize-0")).not.toHaveAttribute("data-resized");
  });

  it("does not write a width when there is nothing to measure", () => {
    // jsdom reports a 0px header. Starting a drag from 0 would snap the column to the
    // 28px minimum on the first pointermove — a resize the user never asked for.
    render(<ResultsGrid result={TRACKS_RESULT} />);
    fireEvent.pointerDown(screen.getByTestId("db-grid-resize-0"), { clientX: 100 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 400, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("ignores keys that are not a horizontal nudge", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const handle = screen.getByTestId("db-grid-resize-1");
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(screen.getByTestId("db-grid-col-1")).toHaveStyle({ width: "calc(12ch + 18px)" });
  });

  it("steps a column by one keyboard nudge in each direction", () => {
    // Same stub, same honesty as the drag tests: the STEP is what is being pinned here
    // (16px either way from a 200px column), not that jsdom measured anything.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 24,
    } as DOMRect);
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const handle = screen.getByTestId("db-grid-resize-0");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "216px" });
    // The second press starts from the OVERRIDE, not from the (stubbed) measurement —
    // otherwise every press after the first would land on the same width.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "232px" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "216px" });
  });

  it("does not nudge a column it cannot measure", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    fireEvent.keyDown(screen.getByTestId("db-grid-resize-0"), { key: "ArrowRight" });
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
  });

  it("keeps a dragged width per column, and drops it when a new result arrives", () => {
    // The drag itself needs pixels, so the override is injected the only honest way
    // jsdom allows: by stubbing the measurement the drag reads.
    const width = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 200, height: 24 } as DOMRect);

    const { rerender } = render(<ResultsGrid result={TRACKS_RESULT} />);
    fireEvent.pointerDown(screen.getByTestId("db-grid-resize-1"), { clientX: 100 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 260, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    // 200px header + 160px of drag, and ONLY that column moved.
    expect(screen.getByTestId("db-grid-col-1")).toHaveStyle({ width: "360px" });
    expect(screen.getByTestId("db-grid-resize-1")).toHaveAttribute("data-resized", "true");
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
    // The body class is released on pointerup — a stuck `is-resizing` would leave the
    // whole app un-selectable and showing a resize cursor.
    expect(document.body.classList.contains("is-resizing")).toBe(false);

    // A new result has different columns, so a px width for "column 1" is meaningless.
    rerender(<ResultsGrid result={KINDS_RESULT} />);
    expect(screen.getByTestId("db-grid-resize-1")).not.toHaveAttribute("data-resized");
    expect(screen.getByTestId("db-grid-col-1")).not.toHaveStyle({ width: "360px" });
    width.mockRestore();
  });

  it("double-clicking a handle returns that column to the sampled fit", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 24,
    } as DOMRect);
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const handle = screen.getByTestId("db-grid-resize-0");

    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 100, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "300px" });

    fireEvent.doubleClick(handle);
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
    expect(handle).not.toHaveAttribute("data-resized");
  });

  it("does nothing when a column with no override is double-clicked", () => {
    // Already at the sampled fit, so "fit it" is a no-op — and it must not write an
    // entry, or the table would switch off its stretch-to-fill for a gesture that
    // changed nothing.
    render(<ResultsGrid result={TRACKS_RESULT} />);
    fireEvent.doubleClick(screen.getByTestId("db-grid-resize-0"));
    expect(screen.getByTestId("db-grid-col-0")).toHaveStyle({ width: "calc(12ch + 18px)" });
    expect(document.querySelector("table")).not.toHaveAttribute("data-resized");
  });

  it("clamps a drag that would collapse the column to nothing", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 24,
    } as DOMRect);
    render(<ResultsGrid result={TRACKS_RESULT} />);
    fireEvent.pointerDown(screen.getByTestId("db-grid-resize-2"), { clientX: 500 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: -5000, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    // MIN_COL_PX, not 0: a column with no width has no handle left to grab.
    expect(screen.getByTestId("db-grid-col-2")).toHaveStyle({ width: "28px" });
  });
});

/**
 * The presence mask: when the data has more states than the contract, say so in the output.
 *
 * Two engines — MongoDB and DynamoDB — can omit a field from a document entirely, which is a third
 * state a `string | null` cell cannot hold. Before this, both an explicit null and a missing field
 * rendered as the NULL chip, so the grid asserted something the data never said. The engines now
 * send `absent[row][col]`, and this is the half that has to read it.
 */
describe("the absent mask — a missing field is not a NULL", () => {
  const THREE_STATES: DbResultSet = {
    kind: "rows",
    statement: '{"find": "tracks"}',
    columns: [
      { name: "title", typeName: "string", kind: "text" },
      { name: "tag", typeName: "string", kind: "text" },
    ],
    // 🔴 Rows 2 and 3 are IDENTICAL in `rows` — both `null` in the `tag` column. Only the mask
    // distinguishes them, which is exactly why the mask exists.
    rows: [
      ["Amberline", "first"],
      ["Bluewater", null],
      ["Driftwood", null],
    ],
    rowsAffected: null,
    truncated: false,
    rowLimit: 500,
    durationMs: 1,
    notice: null,
    absent: [
      [false, false],
      [false, false],
      [false, true],
    ],
  };

  it("🔴 paints a masked cell as `missing` and an unmasked null as `null`", () => {
    render(<ResultsGrid result={THREE_STATES} />);
    const cells = screen.getAllByRole("cell");
    // 2 columns × 3 rows, in document order.
    const tagOf = (row: number) => cells[row * 2 + 1];
    expect(tagOf(0)).toHaveTextContent("first");
    // The document HAS the field and it is null.
    expect(tagOf(1)).toHaveAttribute("data-display", "null");
    // The document does NOT have the field. Same `null` in `rows`, different cell.
    expect(tagOf(2)).toHaveAttribute("data-display", "missing");
    expect(tagOf(1).getAttribute("data-display")).not.toBe(
      tagOf(2).getAttribute("data-display"),
    );
  });

  it("changes nothing for a result with no mask — the six engines that cannot produce one", () => {
    // The field is absent from the wire for every SQL engine and for Redis, so `undefined` indexing
    // must be inert rather than throwing or marking everything missing.
    const noMask: DbResultSet = { ...THREE_STATES, absent: undefined };
    render(<ResultsGrid result={noMask} />);
    const cells = screen.getAllByRole("cell");
    expect(cells[3]).toHaveAttribute("data-display", "null");
    expect(cells[5]).toHaveAttribute("data-display", "null");
  });

  it("is indexed by ABSOLUTE row, not by position in the rendered window", () => {
    // The grid virtualises: it renders a slice, and `map`'s index restarts at 0 inside it. Indexing
    // the mask by that would mis-attribute every mask entry as soon as the window scrolls — an
    // earlier version of this code did exactly that (`absent[r]` instead of `absent[index]`).
    const rows = Array.from({ length: 400 }, (_, i) => [`s${i}`, null]);
    const absent = rows.map((_, i) => [false, i === 399]);
    render(<ResultsGrid result={{ ...THREE_STATES, rows, absent }} />);
    // Row 0 is in the first window and is NOT masked; if the mask were read positionally the first
    // rendered row would inherit row 399's entry.
    const cells = screen.getAllByRole("cell");
    expect(cells[1]).toHaveAttribute("data-display", "null");
  });
});

/* ═══════════════════════════════ sorting ═════════════════════════════════ */

describe("ResultsGrid — sorting", () => {
  /** The `code` column's values, top to bottom, as rendered. */
  const codes = () =>
    screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);

  it("starts in the SERVER's order, with no column claiming a sort", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    expect(codes()).toEqual(["AMB", "BLU", "COR"]);
    for (const th of screen.getAllByRole("columnheader")) {
      expect(th).toHaveAttribute("aria-sort", "none");
    }
  });

  it("sorts ascending, then descending, then back to the server's order", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);

    await user.click(screen.getByTestId("db-grid-sort-0"));
    expect(codes()).toEqual(["AMB", "BLU", "COR"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByTestId("db-grid-sort-0"));
    expect(codes()).toEqual(["COR", "BLU", "AMB"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "descending");

    // The third click restores what the query itself asked for — a grid you
    // cannot un-sort has taken something away.
    await user.click(screen.getByTestId("db-grid-sort-0"));
    expect(codes()).toEqual(["AMB", "BLU", "COR"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "none");
  });

  it("sorts a NUMBER column by value and keeps NULL out of the way", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    // secs: 1240.50000, null, 0 → 0 then 1240.5, with the NULL row last.
    await user.click(screen.getByTestId("db-grid-sort-1"));
    expect(codes()).toEqual(["COR", "AMB", "BLU"]);

    await user.click(screen.getByTestId("db-grid-sort-1"));
    // Two-sided: the order flips, and the NULL row stays at the bottom.
    expect(codes()).toEqual(["AMB", "COR", "BLU"]);
  });

  it("moving to another column starts it ascending", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid-sort-0"));
    await user.click(screen.getByTestId("db-grid-sort-0")); // desc on code
    await user.click(screen.getByTestId("db-grid-sort-1")); // secs
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).toHaveAttribute("aria-sort", "none");
    expect(headers[1]).toHaveAttribute("aria-sort", "ascending");
  });

  it("says so when it is sorting a TRUNCATED result", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRUNCATED_RESULT} />);
    expect(screen.queryByTestId("db-grid-sort-caveat")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("db-grid-sort-0"));

    // Sorting a page of a bigger table and letting the top row read as "the
    // largest" is the quiet lie this notice exists to prevent.
    const caveat = screen.getByTestId("db-grid-sort-caveat");
    expect(caveat).toHaveTextContent(/returned more/i);
  });

  it("stays quiet on a COMPLETE result — two-sided against the caveat", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={AT_LIMIT_RESULT} />);
    await user.click(screen.getByTestId("db-grid-sort-0"));
    // Exactly at the row limit but NOT truncated: nothing is missing, so there
    // is nothing to warn about.
    expect(screen.queryByTestId("db-grid-sort-caveat")).not.toBeInTheDocument();
  });

  it("drops the sort when a NEW result arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid-sort-0"));
    await user.click(screen.getByTestId("db-grid-sort-0"));
    expect(codes()).toEqual(["COR", "BLU", "AMB"]);

    // A column INDEX no longer names the same column, so keeping the sort would
    // silently order by whatever now sits in that position.
    rerender(<ResultsGrid result={{ ...TRACKS_RESULT, statement: "other" }} />);
    expect(codes()).toEqual(["AMB", "BLU", "COR"]);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "none");
  });

  it("is reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "ascending");
  });
});

/* ══════════════════════════ search (Cmd/Ctrl+F) ══════════════════════════ */

describe("ResultsGrid — searching the result", () => {
  it("opens on Cmd+F and on Ctrl+F, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    expect(screen.queryByTestId("db-grid-find")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByTestId("db-grid-find")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-grid-find")).not.toBeInTheDocument();

    // Both spellings are required.
    await user.keyboard("{Control>}f{/Control}");
    expect(screen.getByTestId("db-grid-find")).toBeInTheDocument();
  });

  it("highlights matching cells and counts them", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "AM");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    expect(screen.getByTestId("db-grid-hit-current")).toHaveTextContent("AM");
  });

  it("matches case-insensitively and on a fragment", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    // "demo" is in row 0's note column; upper-cased query, lower-case data.
    await user.type(screen.getByTestId("db-grid-find-input"), "DEM");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
  });

  it("says so when nothing matches, and highlights nothing", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "zzzz");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("No matches");
    expect(screen.queryAllByTestId("db-grid-hit")).toHaveLength(0);
    expect(screen.queryByTestId("db-grid-hit-current")).not.toBeInTheDocument();
    // Two-sided: the grid still shows its rows, it is just not marking any.
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  it("never matches a NULL cell by typing 'null'", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    // BLU's secs is SQL NULL and is DRAWN as the word NULL. Matching the drawing
    // would find every empty cell whenever someone searched that word.
    await user.type(screen.getByTestId("db-grid-find-input"), "null");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("No matches");
  });

  it("steps between matches and wraps", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    // "o" is in `demo` and `COR` — two cells, and not in 1240.50000.
    await user.type(screen.getByTestId("db-grid-find-input"), "o");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");

    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
    await user.click(screen.getByTestId("db-grid-find-prev"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
  });

  it("searches what is DISPLAYED — a re-sort re-addresses the hits", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "o");
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");

    // Sorting moves the rows, so "hit 2" would name a different cell. The cursor
    // resets rather than pointing somewhere the user did not put it.
    await user.click(screen.getByTestId("db-grid-sort-0"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
  });

  it("drops the cursor when a NEW result arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "o");
    await user.click(screen.getByTestId("db-grid-find-next"));

    rerender(<ResultsGrid result={{ ...TRACKS_RESULT, statement: "other" }} />);
    // "2 of 2" would be a claim about rows that are gone.
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
  });

  it("Enter and Shift+Enter walk the matches", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    const input = screen.getByTestId("db-grid-find-input");
    await user.type(input, "o");
    await user.type(input, "{Enter}");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
    await user.type(input, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
  });

  it("the ✕ closes the bar and clears the highlighting", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "AM");
    expect(screen.getByTestId("db-grid-hit-current")).toBeInTheDocument();

    await user.click(screen.getByTestId("db-grid-find-close"));
    expect(screen.queryByTestId("db-grid-find")).not.toBeInTheDocument();
    expect(screen.queryByTestId("db-grid-hit-current")).not.toBeInTheDocument();
  });

  it("stepping with no matches does nothing rather than throwing", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    const input = screen.getByTestId("db-grid-find-input");
    await user.type(input, "zzzz");
    // ↑/↓ are disabled here, so Enter is the only way to ask.
    await user.type(input, "{Enter}");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("No matches");
  });
});

/* ═══════ the find bar survives a tab move ═══════════════════════════════ */

/**
 * `Pane` renders only the active tab and a cross-pane drag re-parents the
 * subtree — both are an unmount of this component. The bar's open/query/cursor
 * live in `findBars[findKey]` precisely so they come back on the remount;
 * these tests drive that unmount/remount cycle directly, the way `Pane` does.
 */
describe("ResultsGrid — the find bar survives unmount/remount", () => {
  const KEY = "grid:conn-a:0";

  /** Open the bar, search "o" (2 hits: `demo` row 0, `COR` row 2), walk to hit 2. */
  async function openAndWalk(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "o");
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
  }

  it("reopens with the query and the walked-to cursor intact", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    await openAndWalk(user);

    // A tab switch/move IS this unmount — and it must NOT drop the record.
    unmount();
    expect(useAppStore.getState().findBars[KEY]).toEqual({ open: true, query: "o", cursor: 1 });

    render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    expect(screen.getByTestId("db-grid-find")).toBeInTheDocument();
    expect(screen.getByTestId("db-grid-find-input")).toHaveValue("o");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
    // Hit 2 is still the CURRENT one: `COR`'s "O", not `demo`'s "o".
    expect(screen.getByTestId("db-grid-hit-current")).toHaveTextContent("O");
  });

  it("clamps a restored cursor against results re-run while the tab was away", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    await openAndWalk(user); // stored cursor: 1
    unmount();

    // The re-run kept only one matching row, so "hit 2" addresses nothing now.
    const rerun: DbResultSet = { ...TRACKS_RESULT, rows: [["AMB", "1240.50000", "demo"]] };
    render(<ResultsGrid result={rerun} findKey={KEY} />);
    expect(screen.getByTestId("db-grid-find-input")).toHaveValue("o");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    expect(screen.getByTestId("db-grid-hit-current")).toHaveTextContent("o");
    // And stepping from the clamped cursor still works (wraps on one hit).
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
  });

  it("still scrolls an off-screen match into view after the remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ResultsGrid result={DEEP_RESULT} findKey={KEY} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(screen.getByTestId("db-grid-find-input"), "needle");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    // Scroll back to the top before leaving — typing the query has ALREADY
    // revealed row 90 (that is the fix in `revealFirst`), and the offset is
    // persisted on unmount, so without this the match would still be on screen
    // after the remount and stepping to it would correctly move nothing. This
    // is the user who found their match, scrolled away, and moved the tab.
    screen.getByTestId("db-grid-scroll").scrollTop = 0;
    unmount();

    render(<ResultsGrid result={DEEP_RESULT} findKey={KEY} />);
    const box = screen.getByTestId("db-grid-scroll");
    expect(box.scrollTop).toBe(0);
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);
  });

  it("two-sided: a DIFFERENT connection's grid starts closed", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    await openAndWalk(user);
    unmount();

    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-b:0" />);
    expect(screen.queryByTestId("db-grid-find")).not.toBeInTheDocument();
  });

  it("Escape DROPS the record — closing is forgetting, unmounting is not", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    await openAndWalk(user);

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-grid-find")).not.toBeInTheDocument();
    expect(useAppStore.getState().findBars[KEY]).toBeUndefined();
  });

  it("the ✕ drops the record too", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} findKey={KEY} />);
    await openAndWalk(user);

    await user.click(screen.getByTestId("db-grid-find-close"));
    expect(useAppStore.getState().findBars[KEY]).toBeUndefined();
  });
});



describe("stepping with a MEASURED viewport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the real clientHeight when the layout engine reports one", async () => {
    // jsdom reports 0 for every clientHeight, so the FALLBACK arm runs in every
    // other test — this is the one place the real-measurement arm is pinned
    // (the running app always takes it; a suite that never does is how a wrong
    // fallback ships unnoticed).
    //
    // 🔴 The numbers are chosen so the two arms DISAGREE, which is the only way
    // this test can see which one ran. Row 90 spans 2160–2184; from scrollTop
    // 1500 the measured 800px viewport reaches 2300 and the row is visible, so
    // the box must not move — while the 600px fallback would reach only 2100 and
    // would scroll to 2092. Previously this asserted "0 stayed 0" on the OUTER
    // `db-grid` div, which nothing ever scrolls: it was green under both arms,
    // under a deleted reveal, and under an unconditional one.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const user = userEvent.setup();
    render(<ResultsGrid result={DEEP_RESULT} />);
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    const box = screen.getByTestId("db-grid-scroll");
    await user.type(screen.getByTestId("db-grid-find-input"), "needle");
    box.scrollTop = 1500;
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(box.scrollTop).toBe(1500);
  });
});

/* ═══ find REVEALS the hit, on both axes ════════════════════════════════════ */

/**
 * *"3 of 57"* is not an answer if the 3 is nine screens away. Every other find
 * surface in this app reveals its hit; this grid counted them and left the user to
 * go looking. Stepping already scrolled vertically — a **new query never did**, on
 * either the typed or the seeded path, and **neither did anything horizontally**,
 * so a match in an off-screen column stayed off-screen with the row perfectly
 * placed.
 *
 * ── What is honest to assert here, and what is not ───────────────────────────
 * jsdom has no layout engine, so nothing below is allowed to *depend* on one. Two
 * facts make these assertions real anyway, and they are different facts:
 *
 *  1. **`scrollTop` is genuine state in jsdom** — its setter stores what you write
 *     and the getter returns it. ("the scroll position survives a tab move" used
 *     to call the setter a no-op; this block is what proved otherwise, and that
 *     comment is corrected in place.) So a vertical reveal can be asserted at its exact
 *     arithmetic value — `NEEDLE_SCROLL_TOP`, spelled out above — rather than as
 *     "greater than zero", which would also pass for a reveal that scrolled to the
 *     wrong row.
 *
 *  2. **Nothing measures itself**, so the horizontal half has no geometry at all:
 *     every `getBoundingClientRect()` is zeros, both extents are zero-wide, and
 *     `scrollToColumn` correctly answers "already visible" to everything. That
 *     would make a horizontal test vacuously green, so `stubHorizontalLayout`
 *     INJECTS a layout — the scroll box 400px wide, each column 200px — and what
 *     is then pinned is that the component reads the right boxes and applies the
 *     answer. That the boxes are the right ones **in a real engine** is pinned
 *     in `ResultsGrid.browser.test.tsx`, where Chromium supplies them.
 *
 * Focus is real in jsdom, so "revealing must not steal the caret" is asserted
 * directly rather than modelled.
 *
 * ── Falsified before being trusted ───────────────────────────────────────────
 * Each rule was reverted in `ResultsGrid.tsx` / `gridReveal.ts`, the run observed,
 * and the source restored byte-identically (sha256). The mutants, and what caught
 * them here:
 *
 *   ✅ drop `box.scrollTop = top` from `revealHit`       → 6 reds, "expected +0 to
 *      be 2092" (and the seeded test's "expected 1920 to be +0").
 *   ✅ drop `box.scrollLeft = left`                      → "scrolls SIDEWAYS…":
 *      "expected +0 to be 200".
 *   ✅ drop `revealFirst(e.target.value)` from onChange  → 4 reds; the typed,
 *      caret, already-visible and sideways tests.
 *   ✅ drop `if (seeded !== null) revealFirst(seeded)`   → 1 red, and ONLY the
 *      seeded test: the seed path is genuinely separate from the typed one.
 *   ✅ drop `revealHit(hits[next])` from `stepHit`       → 2 reds, the stepping
 *      test and the pre-existing remount one.
 *   ✅ drop the `hit.col < columns.length` guard         → "reveals neither way…":
 *      "expected 400 to be +0" — it scrolls to the aria-hidden filler column.
 *   ✅ add `gridRef.current?.focus()` to `revealHit`     → "keeps the caret…":
 *      "expected <div class="db-grid" …> to be <input …>". The one mutation that is
 *      an ADDITION, because stealing focus is a thing done, not a thing omitted.
 *   ✅ drop `if (fitsLeft && fitsRight) return null`     → `gridReveal.test.ts`
 *      reds twice; the browser tier's `nearest` test catches it with real geometry.
 */
describe("ResultsGrid — find reveals the hit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `DEEP_RESULT` with a SECOND needle at row 3 — one on screen, one far below. */
  const TWO_NEEDLES: DbResultSet = {
    ...TRACKS_RESULT,
    rows: TRACKS_RESULT.rows.concat(
      Array.from({ length: 97 }, (_, i) => [
        `r${i}`,
        String(i),
        i === 0 || i === 87 ? "needle" : "hay",
      ]),
    ),
  };

  /** Open the bar on a freshly rendered grid and return the input + the scroll box. */
  async function openFind(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<{ input: HTMLElement; box: HTMLElement }> {
    await user.click(screen.getByTestId("db-grid"));
    await user.keyboard("{Meta>}f{/Meta}");
    return {
      input: screen.getByTestId("db-grid-find-input"),
      box: screen.getByTestId("db-grid-scroll"),
    };
  }

  it("scrolls a typed query's FIRST hit into view", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={DEEP_RESULT} />);
    const { input, box } = await openFind(user);
    expect(box.scrollTop).toBe(0);

    await user.type(input, "needle");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    // The exact landing, not "somewhere below": a reveal that scrolled to the
    // wrong row would satisfy `toBeGreaterThan(0)` just as well.
    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);
  });

  it("keeps the caret in the find input while the grid moves under it", async () => {
    // 🔴 The trap that makes a find bar unusable: revealing by focusing the hit
    // would scroll the grid AND rip the caret out mid-word. Two-sided on purpose —
    // the box really moved, and the focus really did not.
    const user = userEvent.setup();
    render(<ResultsGrid result={DEEP_RESULT} />);
    const { input, box } = await openFind(user);

    await user.type(input, "needle");

    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);
    expect(document.activeElement).toBe(input);
  });

  it("reveals the hit each step LANDS on, forwards and back", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={TWO_NEEDLES} />);
    const { input, box } = await openFind(user);

    // Hit 1 is row 3 (spans 72–96), already inside the 600px fallback viewport,
    // so the query itself must move nothing — `nearest`, not "always jump".
    await user.type(input, "needle");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
    expect(box.scrollTop).toBe(0);

    await user.type(input, "{Enter}");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("2 of 2");
    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);

    // And back: row 3 is now far ABOVE the viewport, so Shift+Enter scrolls up to
    // it — 72 less the header allowance and one row of clearance, floored at 4.
    await user.type(input, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 2");
    expect(box.scrollTop).toBe(4);
  });

  it("moves nothing when the query matches nothing", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={DEEP_RESULT} />);
    const { input, box } = await openFind(user);
    // A deliberate offset, so "did not move" is distinguishable from "was reset
    // to the top" — the two are the same assertion at scrollTop 0.
    box.scrollTop = 777;

    await user.type(input, "zzz");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("No matches");
    expect(box.scrollTop).toBe(777);
  });

  it("does not re-scroll a hit that is already on screen", async () => {
    const user = userEvent.setup();
    render(<ResultsGrid result={DEEP_RESULT} />);
    const { input, box } = await openFind(user);
    await user.type(input, "needle");
    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);

    // One hit, so Next wraps onto itself — the row is exactly where the reveal
    // just put it. `scrollToRow` returning null is what stops a walk through a
    // run of adjacent matches from jittering the viewport on every press.
    await user.click(screen.getByTestId("db-grid-find-next"));
    expect(box.scrollTop).toBe(NEEDLE_SCROLL_TOP);
  });

  /* ── the horizontal axis ─────────────────────────────────────────────────── */

  const hRect = (left: number, right: number): DOMRect =>
    ({
      left,
      right,
      width: right - left,
      x: left,
      top: 0,
      bottom: 0,
      height: 0,
      y: 0,
      toJSON: () => "",
    }) as DOMRect;

  /**
   * Inject the layout jsdom will not compute: a 400px-wide scroll box at x=0, and
   * header cells 200px each, so column *c* spans `[c*200, c*200+200]`.
   *
   * Column 2 therefore sits at 400–600 — entirely past the box's right edge — which
   * is the whole point: with real zeros every extent is identical and
   * `scrollToColumn` answers "already visible" to every input, so an unstubbed
   * horizontal test cannot fail. The `<th>` is indexed through its own parent
   * rather than a testid because the component finds it exactly that way.
   *
   * 🔴 The header rects are offset by the live `scrollLeft`, because that is the
   * one property of `getBoundingClientRect` this arithmetic depends on: it is
   * VIEWPORT-relative, so a column walks left as the box scrolls right. A static
   * stub models a browser that does not exist — and it showed: `user.type` fires
   * one reveal per keystroke, so four characters of "demo" accumulated 4 × 200px
   * of scroll against rects that never moved. The component is right (a real
   * engine re-measures); the first version of this stub was not.
   */
  function stubHorizontalLayout(): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ): DOMRect {
      if (this.getAttribute("data-testid") === "db-grid-scroll") return hRect(0, 400);
      if (this.tagName === "TH") {
        const scrolled = (screen.getByTestId("db-grid-scroll") as HTMLElement).scrollLeft;
        const i = Array.prototype.indexOf.call(
          (this.parentElement as HTMLElement).children,
          this,
        );
        return hRect(i * 200 - scrolled, i * 200 + 200 - scrolled);
      }
      return hRect(0, 0);
    });
  }

  it("scrolls SIDEWAYS to a hit in an off-screen column", async () => {
    stubHorizontalLayout();
    const user = userEvent.setup();
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const { input, box } = await openFind(user);

    // "demo" is row 0 of the `note` column — column index 2, at 400–600 against a
    // box that ends at 400.
    await user.type(input, "demo");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    // 200px of overhang, revealed with exactly 200px of scroll (`inline: nearest`).
    expect(box.scrollLeft).toBe(200);
    // And the row was already on screen, so the OTHER axis stayed put. The two
    // axes are independent; a reveal that moved both would be the jitter this
    // whole `nearest` shape exists to avoid.
    expect(box.scrollTop).toBe(0);
  });

  it("reveals neither way for a hit in a cell the grid does not draw", async () => {
    // A row carrying a fourth value against three columns. `findCells` walks the
    // whole row, so the hit is counted; `markMatch` only ever renders the three
    // real columns, so there is nothing on screen to reveal. Without the guard the
    // `<th>` at index 3 is the aria-hidden FILLER cell (600–800 under the stub),
    // and the grid would scroll 400px sideways to show empty space.
    stubHorizontalLayout();
    const user = userEvent.setup();
    const overlong: DbResultSet = {
      ...TRACKS_RESULT,
      rows: [["AMB", "1240.50000", "demo", "needle"]],
    };
    render(<ResultsGrid result={overlong} />);
    const { input, box } = await openFind(user);

    await user.type(input, "needle");

    expect(screen.getByTestId("db-grid-find-count")).toHaveTextContent("1 of 1");
    expect(screen.queryByTestId("db-grid-hit-current")).not.toBeInTheDocument();
    expect(box.scrollLeft).toBe(0);
    expect(box.scrollTop).toBe(0);
  });
});


describe("the scroll position survives a tab move", () => {
  /**
   * Previously, after scrolling a database response, switching to another tab
   * and coming back put the grid back at the top. `Pane` unmounts
   * an inactive tab, so the offset — which lives in the DOM node, not in React —
   * died with it.
   */
  /**
   * ⚠️ Asserted through the WINDOW rather than through `box.scrollTop`.
   *
   * 🔴 An earlier version of this note said jsdom's `scrollTop` setter is a
   * no-op. It is not — jsdom stores what you write and reads it straight back,
   * which is why the reveal tests further up can assert an exact pixel landing.
   * The real reason these tests inject the position with `defineProperty` is the
   * one below: what they are pinning is that the restored offset **seeds the
   * virtualiser**, so the rows rendered are the rows around the reader's place.
   * Reading `scrollTop` back would only prove the assignment, not the effect.
   */
  const tall = {
    ...TRUNCATED_RESULT,
    truncated: false,
    rows: Array.from({ length: 100_000 }, (_, i) => [String(i + 1)]),
  };

  it("restores where the reader was, and does not disturb another grid", () => {
    const { unmount } = render(<ResultsGrid result={tall} findKey="grid:conn-a:0" />);
    const scroll = screen.getByTestId("db-grid-scroll");
    // The position is INJECTED rather than scrolled to: jsdom will not lay out,
    // so there is nothing to scroll. The assertion is through the window below,
    // because the window is the consequence being pinned (see the note above).
    Object.defineProperty(scroll, "scrollTop", { value: 24_000, configurable: true });
    fireEvent.scroll(scroll);
    unmount();

    // Back to the tab: row 1000 (24000/24), minus the 8-row overscan.
    render(<ResultsGrid result={tall} findKey="grid:conn-a:0" />);
    expect(document.querySelectorAll("tr[data-row]")[0]).toHaveAttribute("data-row", "992");
    cleanup();

    // Two-sided: a DIFFERENT grid starts at the top rather than inheriting it.
    render(<ResultsGrid result={tall} findKey="grid:conn-b:0" />);
    expect(document.querySelectorAll("tr[data-row]")[0]).toHaveAttribute("data-row", "0");
  });

  it("remembers a deliberate scroll back to the TOP", () => {
    const { unmount } = render(<ResultsGrid result={tall} findKey="grid:conn-a:0" />);
    const scroll = screen.getByTestId("db-grid-scroll");
    Object.defineProperty(scroll, "scrollTop", { value: 24_000, configurable: true });
    fireEvent.scroll(scroll);
    Object.defineProperty(scroll, "scrollTop", { value: 0, configurable: true });
    fireEvent.scroll(scroll);
    unmount();

    // 0 is a position the user chose, not "nothing stored" — dropping it would
    // send them back to row 992 on their next visit.
    expect(useAppStore.getState().scrollOffsets["grid:conn-a:0"]).toBe(0);
    render(<ResultsGrid result={tall} findKey="grid:conn-a:0" />);
    expect(document.querySelectorAll("tr[data-row]")[0]).toHaveAttribute("data-row", "0");
  });
});

describe("the sort survives a tab move", () => {
  /**
   * The bug: after sorting a result and moving the tab, the rows
   * went back to their original order. The sort lived in component state, so `Pane`
   * unmounting the inactive tab threw the user's question away.
   */
  it("restores the sorted order, and a NEW result still clears it", () => {
    const { unmount } = render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-a:0" />);
    const header = () => screen.getAllByRole("columnheader")[0];
    expect(header()).toHaveAttribute("aria-sort", "none");
    fireEvent.click(screen.getByTestId("db-grid-sort-0"));
    expect(header()).toHaveAttribute("aria-sort", "ascending");
    unmount();

    // Back to the tab: still sorted the way the user asked.
    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-a:0" />);
    expect(header()).toHaveAttribute("aria-sort", "ascending");
    cleanup();

    // Two-sided #1: another grid is untouched.
    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-b:0" />);
    expect(header()).toHaveAttribute("aria-sort", "none");
    cleanup();

    // Two-sided #2: a NEW result clears it — a column index no longer names the
    // same thing, so restoring the sort would order by whatever now sits there.
    render(<ResultsGrid result={KINDS_RESULT} findKey="grid:conn-a:0" />);
    cleanup();
    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-a:0" />);
    expect(header()).toHaveAttribute("aria-sort", "none");
  });
});

/* ═══ Cmd/Ctrl+F seeds from the selection ══════════════════════════════════ */

/**
 * Pressing Command+F with something selected searches for that selection.
 *
 * The rule is `features/editor/find/selectionSeed`, shared with the editor's own
 * bar and every other find surface, and the seed is written through the SAME
 * `patchFindBar({ query, cursor: 0 })` the input's onChange uses — so what is
 * asserted here is that the grid SEARCHED (the count, the marked cell), not that
 * the box has text in it.
 *
 * 🔴 Two jsdom facts shape every test below, and both would otherwise let a test
 * pass against nothing:
 *   1. `HTMLElement.focus()` ends with `getSelection().collapse(this, 0)` — no
 *      real browser does that for a non-editable element. So the selection is
 *      made AFTER the grid is focused, which is also the order the real gesture
 *      happens in (mousedown focuses, the drag selects).
 *   2. `Selection.toString()` is `Range.toString()`: it concatenates character
 *      data and does NOT insert the line breaks a real browser puts between
 *      block elements. The multi-line case is therefore a cell whose VALUE
 *      contains a newline — realistic for a text column, and it means the same
 *      thing in jsdom and in Chromium.
 */
describe("ResultsGrid — Cmd/Ctrl+F seeds from the selection", () => {
  afterEach(() => {
    // Restore FIRST: `selectAcrossRows` stubs `window.getSelection`, and a
    // nested afterEach runs before the file-level one that calls
    // `vi.restoreAllMocks()` — clearing ranges on the stub would throw and take
    // the file's `cleanup()` with it.
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  const grid = (): HTMLElement => screen.getByTestId("db-grid");
  const findInput = (): HTMLInputElement => screen.getByTestId<HTMLInputElement>("db-grid-find-input");
  const findCount = (): string => screen.getByTestId("db-grid-find-count").textContent ?? "";

  /** Select the first occurrence of `text` in one of the grid's text nodes. */
  function selectInGrid(text: string): void {
    const walker = document.createTreeWalker(grid(), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    // Loud, not silent: a fixture that stopped containing the text would make
    // every assertion in the calling test vacuous.
    throw new Error(`no text node in the grid contains ${JSON.stringify(text)}`);
  }

  /**
   * A selection spanning two ROWS, as a real browser reports it.
   *
   * jsdom cannot produce one, and neither can this grid's DOM: `Selection.
   * toString()` is `Range.toString()`, which concatenates character data and
   * never inserts the line breaks a browser puts between block elements — and
   * `renderCell` collapses every value to ONE line, so no text node here carries
   * a `\n` either. The RANGE is real, so the containment check is genuinely
   * exercised; only the stringification is replaced with what Chromium returns
   * for a drag across two rows.
   */
  function selectAcrossRows(anchorText: string, asTheBrowserSeesIt: string): void {
    selectInGrid(anchorText);
    const range = (window.getSelection() as Selection).getRangeAt(0);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => asTheBrowserSeesIt,
    } as unknown as Selection);
  }

  /** Focus the grid, select `text` in it, then press Cmd+F — the real order. */
  function pressFindAfterSelecting(text: string): void {
    grid().focus();
    selectInGrid(text);
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });
  }

  /** The find input is focused on a `setTimeout(…, 0)`; let it land. */
  async function settleFocus(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("seeds a single-line selection AND searches it", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);

    pressFindAfterSelecting("AMB");

    expect(findInput()).toHaveValue("AMB");
    // It searched: the cell is marked as the current hit and the counter agrees.
    expect(findCount()).toBe("1 of 1");
    expect(screen.getByTestId("db-grid-hit-current")).toHaveTextContent("AMB");
  });

  it("selects the seeded text, so the next keystroke replaces it", async () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);

    pressFindAfterSelecting("AMB");
    await settleFocus();

    const input = findInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("AMB".length);
  });

  it("OVERWRITES the query of an already-open bar, re-searches, and restarts at the first hit", () => {
    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-a:0" />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "o" } });
    fireEvent.click(screen.getByTestId("db-grid-find-next")); // walk to hit 2
    expect(findCount()).toBe("2 of 2");

    // "0" also hits two cells (1240.50000 and 0), so a cursor left at 1 would
    // read "2 of 2" here too — 1 of 2 is the discriminator. Typing a new query
    // zeroes the cursor; seeding one must do the same.
    pressFindAfterSelecting("0");

    expect(findInput()).toHaveValue("0");
    expect(findCount()).toBe("1 of 2");
    // …and in the RECORD too, not only in the local mirror the render-time
    // `hitsBelongTo` block zeroes. The record is what a tab move restores from,
    // so a stale 1 there would move the user's place on the way back.
    expect(useAppStore.getState().findBars["grid:conn-a:0"]).toMatchObject({
      query: "0",
      cursor: 0,
    });
  });

  it("re-seeding the SAME query keeps the user's place — a refocus, not a new search", () => {
    // The local hit cursor is only reset by the render-time `hitsBelongTo` block,
    // which an unchanged query never trips. Zeroing the RECORD here would leave
    // the two disagreeing until a remount moved the user's place under them.
    render(<ResultsGrid result={TRACKS_RESULT} findKey="grid:conn-a:0" />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "o" } });
    fireEvent.click(screen.getByTestId("db-grid-find-next"));
    expect(findCount()).toBe("2 of 2");

    pressFindAfterSelecting("o");

    expect(findInput()).toHaveValue("o");
    expect(findCount()).toBe("2 of 2");
    expect(useAppStore.getState().findBars["grid:conn-a:0"]).toMatchObject({
      query: "o",
      cursor: 1,
    });
  });

  it("leaves the query UNTOUCHED for a MULTI-LINE selection — it does not clear it", () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "o" } });
    expect(findCount()).toBe("1 of 2");

    grid().focus();
    selectAcrossRows("AMB", "AMB\n1240.50000");
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });

    expect(findInput()).toHaveValue("o");
    expect(findCount()).toBe("1 of 2");
  });

  it("ignores a selection that lives OUTSIDE this grid", () => {
    // A script run renders several grids in one console, each with its own bar
    // (`grid:<connectionId>:<i>`). A selection in one must not seed another.
    render(<ResultsGrid result={TRACKS_RESULT} />);
    const stranger = document.createElement("div");
    stranger.append(document.createTextNode("somebody else's text"));
    document.body.append(stranger);
    grid().focus();
    const range = document.createRange();
    range.selectNodeContents(stranger);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.keyDown(grid(), { key: "f", metaKey: true });

    expect(findInput()).toHaveValue("");
    stranger.remove();
  });

  it("with NOTHING selected the bar opens empty and focused, exactly as it always has", async () => {
    render(<ResultsGrid result={TRACKS_RESULT} />);

    grid().focus();
    fireEvent.keyDown(grid(), { key: "f", metaKey: true });
    await settleFocus();

    expect(findInput()).toHaveValue("");
    expect(document.activeElement).toBe(findInput());
    expect(screen.queryByTestId("db-grid-hit-current")).not.toBeInTheDocument();
  });

  it("SCROLLS to the seeded query's first hit — and still hands the input the caret", async () => {
    // The seed is the same query-change path as typing, so it owes the same
    // reveal. This is the gesture that makes it visible: 100 rows with a `needle`
    // at row 0 and another at row 90, scrolled to the bottom. You select the one
    // you can see, press Cmd+F, and the FIRST hit — the one at the top, nine
    // screens above — is what the bar now points at.
    const rows = TRACKS_RESULT.rows
      .map((row, i) => (i === 0 ? [row[0], row[1], "needle"] : row))
      .concat(Array.from({ length: 97 }, (_, i) => [`r${i}`, String(i), i === 87 ? "needle" : "hay"]));
    render(<ResultsGrid result={{ ...TRACKS_RESULT, rows }} />);
    const box = screen.getByTestId("db-grid-scroll");
    // Scroll to the end so row 90 is inside the window and therefore selectable.
    // `visibleWindow` clamps 1920 to the 1800 maximum and renders rows 67–99;
    // row 0 is NOT in the DOM, which is also why `scrollIntoView` could never
    // have been the mechanism here.
    box.scrollTop = 1920;
    fireEvent.scroll(box);
    expect(document.querySelector('tr[data-row="90"]')).toBeInTheDocument();
    expect(document.querySelector('tr[data-row="0"]')).not.toBeInTheDocument();

    pressFindAfterSelecting("needle");
    await settleFocus();

    expect(findInput()).toHaveValue("needle");
    expect(findCount()).toBe("1 of 2");
    // Row 0 sits above everything, so the reveal floors at the top of the box.
    expect(box.scrollTop).toBe(0);
    // And the caret landed in the bar, not on the cell that was revealed.
    expect(document.activeElement).toBe(findInput());
  });
});
