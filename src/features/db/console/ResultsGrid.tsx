/**
 * ResultsGrid — the table half of the DB console.
 *
 * Props-only: hand it one `DbResultSet` of `kind: "rows"` and it renders. No
 * `invoke`, no IPC — the same seam that let the connection dialog be built
 * against a backend that did not exist yet. The ONE store seam is the find
 * bar (`findBars[findKey]`, see below): `Pane` renders only the active tab and
 * a cross-pane drag re-parents the subtree, so `useState` here dies on every
 * tab switch/move — which is exactly where the bar's open/query/cursor lived
 * until moving a tab made the bar vanish.
 *
 * ── Why this is a new component and not `CsvTable` ───────────────────────────
 * `CsvTable` was read and rejected, and the reason is not "it needs a few
 * extra props": four of its five responsibilities are the wrong ones here. Its input
 * is a CSV *parser*; its cells are plain `string`s with **no NULL concept at all**
 * (the one distinction this feature is built to preserve); it has no column types,
 * so nothing can be right-aligned or one-lined by kind; and it renders **every**
 * row with no windowing, which is fine for a file you opened on purpose and not fine
 * for `SELECT * FROM events` against production.
 *
 * What was worth taking is its **look**: the header/zebra/border treatment in
 * `csvTable.css` is the house table style, and `console.css` deliberately mirrors
 * those tokens so this grid reads as a sibling rather than a stranger.
 *
 * ── Large results: rows are windowed, columns are not ────────────────────────
 * Row windowing is `visibleWindow` (`consoleFormat.ts`) — fixed `ROW_HEIGHT_PX` rows, spacer
 * `<tr>`s of the exact missing height above and below, so the scrollbar stays
 * honest at any row count. No `react-window`: the maths is ~20 lines, it is
 * property-tested, and a real virtualiser is not testable under jsdom.
 *
 * ── Widths: a sampled guess the user can override ────────────────────────────
 * `columnWidthsCh` is a heuristic (header + first 100 rows, clamped to 6–48ch), and a
 * heuristic is wrong the moment a table opens with a 66-character hash id: a
 * `SELECT * FROM widgets` spent half the pane on `id` and pushed `name` and
 * `signing_code` off the right edge. So every header carries a drag handle — drag to
 * resize, double-click to drop back to the sampled fit, ←/→ to nudge it by keyboard.
 * Overrides are per-result and in **px** (see `clampColumnPx` for why not `ch`), and
 * they are dropped when a new result arrives, because column 0 of the next query is a
 * different column.
 *
 * **Columns are rendered in full, and that is the honest limit of this grid.** The
 * grid is a real `<table>`, so column windowing would mean either faking the table
 * (absolute-positioned divs) or `colgroup` gymnastics, and it buys nothing until a
 * result is wider than a few hundred columns — the backend already caps Mongo's
 * projected column union at 64. Measured cost at the stress fixture (200
 * columns): ~200 header cells plus 200 per visible row, so ~6 000 cells for a
 * screenful. That is fine; ~2 000 columns would not be, and would need column
 * windowing rather than a bigger machine.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAppStore } from "../../../app/store";
import { domSelectionSeed } from "../../editor/find/selectionSeed";
import type { DbResultSet } from "../types";
import {
  clampColumnPx,
  COL_RESIZE_STEP_PX,
  columnWidthsCh,
  FALLBACK_VIEWPORT_PX,
  renderCell,
  ROW_HEIGHT_PX,
  truncationNotice,
  visibleWindow,
} from "./consoleFormat";
import "./console.css";
import { nextSort, sortRows, type SortState } from "./sortRows";
import { type CellHit, findCells, matchRange, scrollToRow } from "./gridSearch";
import { scrollToColumn } from "./gridReveal";

/**
 * A cell's text with the search match wrapped in a `<mark>`.
 *
 * Marks the DISPLAYED text, which `renderCell` may have collapsed to one line —
 * so a match inside a collapsed newline run simply is not highlighted, and the
 * cell still counts as a hit. Highlighting text the user cannot see would be
 * worse than not highlighting it; the row is still scrolled to, and the full
 * value is in the cell's `title`.
 *
 * React children, never `innerHTML` — the `FindInFiles` idiom, so nothing here
 * can be erased by a re-render (React re-assigns `innerHTML` on a new prop object) or
 * corrupt the grid's structure.
 */
function markMatch(text: string, query: string, isCurrent: boolean): React.ReactNode {
  const range = matchRange(text, query);
  if (range === null) return text;
  return (
    <>
      {text.slice(0, range.from)}
      <mark
        className={`db-grid__hit${isCurrent ? " is-current" : ""}`}
        data-testid={isCurrent ? "db-grid-hit-current" : "db-grid-hit"}
      >
        {text.slice(range.from, range.to)}
      </mark>
      {text.slice(range.to)}
    </>
  );
}

/**
 * Roughly how much of the scroll box the sticky header covers.
 *
 * An approximation on purpose: it only decides whether a matched row needs
 * scrolling to and where it lands, and being a few pixels out moves the row a
 * few pixels. Measuring it would put a second layout read into a hot render for
 * no visible gain — the same reasoning the windowing comment above already makes
 * about its own off-by-two rows.
 */
const HEADER_PX = 44;

export function ResultsGrid({
  result,
  findKey = "grid:local",
}: {
  result: DbResultSet;
  /**
   * Which `findBars` record this grid's Cmd/Ctrl+F bar lives under —
   * `DbConsole` derives it from its `findScope` as `grid:<connectionId>:<i>`,
   * so two connections (or two grids of one script) never share a bar.
   * Defaulted for direct renders that have no console identity (tests).
   */
  findKey?: string;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Seeded from the store, non-reactively: `Pane` unmounts an inactive tab, so
  // a scroll offset dies with the DOM node (scrolling a result, moving the tab,
  // and coming back used to land at the top). Lazy initializer, not
  // a subscription — this must not re-render when another surface scrolls.
  const [scrollTop, setScrollTop] = useState(
    () => useAppStore.getState().scrollOffsets[findKey] ?? 0,
  );
  /** Column index → dragged width in px. Absent means "use the sampled `ch` width". */
  // The remembered view is only valid for the SAME columns — see `GridView`.
  const columnSig = result.columns.map((c) => c.name);
  const remembered = (): { sort: SortState | null; widthPx: Record<number, number> } | null => {
    const view = useAppStore.getState().gridViews[findKey];
    if (view === undefined) return null;
    const same =
      view.columns.length === columnSig.length &&
      view.columns.every((name, i) => name === columnSig[i]);
    return same ? view : null;
  };
  const [widthPx, setWidthPx] = useState<Record<number, number>>(
    () => remembered()?.widthPx ?? {},
  );
  /**
   * Which column orders the grid, or `null` for the server's own order.
   *
   * Seeded from the store for the same reason as the scroll offset: a sort is a
   * question the user asked, and `Pane` unmounting an inactive tab must not
   * discard it. Lazy initializer, never a subscription.
   */
  const [sort, setSort] = useState<SortState | null>(() => remembered()?.sort ?? null);
  /**
   * Cmd/Ctrl+F: the find bar. Open state and query live in the STORE
   * (`findBars[findKey]`) so they survive the unmount a tab switch or a
   * cross-pane drag is (see the header). An absent record IS the closed
   * state — Esc/✕ `dropFindBar` rather than zeroing.
   */
  const bar = useAppStore((s) => s.findBars[findKey]);
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);
  const setScrollOffset = useAppStore((s) => s.uiActions.setScrollOffset);
  const setGridView = useAppStore((s) => s.uiActions.setGridView);
  const findOpen = bar?.open ?? false;
  const query = bar?.query ?? "";
  /**
   * The hit cursor: store-backed ACROSS mounts, local WITHIN one. The in-mount
   * resets below (new result / new query / new sort) are render-safe "adjust
   * state when a prop changes" blocks, and a render may not write to the
   * store — so gestures mirror the cursor into the record (`stepHit`, the
   * query input, the sort buttons) and this initializer reads it back on
   * remount. It is clamped where `hitIndex` is derived, never trusted raw:
   * the results can have been re-run while the tab was away.
   */
  const [storedHit, setHitIndex] = useState(() => bar?.cursor ?? 0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * The header row — the only place a COLUMN's horizontal geometry can be read.
   *
   * The hit's own `<td>` is not usable for it: rows are windowed, so the cell may
   * not be in the DOM at all. The `<th>` always is, and under `table-layout: fixed`
   * it has exactly that column's extent (`gridReveal.ts`).
   */
  const headRowRef = useRef<HTMLTableRowElement>(null);
  // 0 until measured. jsdom never measures (no layout engine), so 0 is also the
  // permanent value in the unit tier — hence FALLBACK_VIEWPORT_PX below.
  const [viewport, setViewport] = useState(0);

  // The state above drives the windowing; the DOM box needs the same offset put
  // back on it, before paint, or the rows render at the restored index while
  // the box sits at zero. Persisted on unmount — one write per tab move rather
  // than one per scroll event.
  useLayoutEffect(() => {
    // Non-null: the scroll box renders unconditionally, so a null check here
    // would be a branch no test could ever take. Same cast the
    // measure effect and `stepHit` already use for this element.
    const box = scrollRef.current as HTMLDivElement;
    const saved = useAppStore.getState().scrollOffsets[findKey];
    if (saved !== undefined) box.scrollTop = saved;
    return () => setScrollOffset(findKey, box.scrollTop);
  }, [findKey, setScrollOffset]);

  useLayoutEffect(() => {
    setViewport((scrollRef.current as HTMLDivElement).clientHeight);
  }, []);

  // A window resize changes how many rows fit. `ResizeObserver` would be the
  // precise tool, but `src/test/setup.ts` stubs it to a no-op under jsdom, so a
  // component that depended on it would be untestable in the tier that gates —
  // and the resize event is the 95% case for a desktop window.
  useEffect(() => {
    const onResize = () => setViewport((scrollRef.current as HTMLDivElement).clientHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A new result set means new columns, so the old pixel widths would be applied to
  // columns that no longer exist. React's documented "adjust state when a prop changes"
  // pattern rather than an effect: an effect would paint one frame of the new result
  // wearing the previous one's widths. The previous result is held in *state* and not in
  // a ref because a ref may not be read or written during render — `react-hooks/refs`
  // fails the build on it, and it is right to: a ref write does not schedule the render
  // that would act on it.
  // Mirror the view into the store on every change — including the reset below,
  // so a new result CLEARS the remembered sort rather than leaving a stale one
  // for the next mount to restore. One writer beats patching six call sites.
  useEffect(() => {
    setGridView(findKey, { sort, widthPx, columns: columnSig });
    // columnSig is a fresh array each render; its VALUE is covered by `result`.
    // (The directive must sit on the line right above the deps array — a
    // two-line `-- reason` put it above the comment, where it suppressed nothing.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findKey, sort, widthPx, setGridView, result]);

  const [shown, setShown] = useState(result);
  if (shown !== result) {
    setShown(result);
    setWidthPx({});
    // A new result means new columns, so a column INDEX no longer names the same
    // thing. Keeping the sort would silently order by whatever now sits at that
    // position — worse than not sorting.
    setSort(null);
    // The hits addressed rows in the OLD result; keeping the cursor would point
    // "match 3 of 12" at a row that no longer exists.
    setHitIndex(0);
  }

  // The cursor belongs to a query and an order; both change what "hit 3" means.
  const [hitsBelongTo, setHitsBelongTo] = useState({ query, sort });
  if (hitsBelongTo.query !== query || hitsBelongTo.sort !== sort) {
    setHitsBelongTo({ query, sort });
    setHitIndex(0);
  }

  // Honest caveat on the windowing: `scrollTop` is measured from the top of the
  // scroll box, which includes the sticky header, while `visibleWindow` reasons in
  // whole rows. So the chosen window can sit up to `ceil(headerHeight / 24)` ≈ 2 rows
  // late — comfortably inside the 8-row overscan, which is why it is a comment and
  // not a subtraction. Subtracting a measured header height would put a second
  // measurement into the maths for no visible gain.
  const { columns, rows: serverRows } = result;
  // Reordering the rows already fetched — never a re-run with an ORDER BY. See
  // `sortRows`'s header for why, and for the truncation caveat the notice states.
  const rows =
    sort === null || columns[sort.columnIndex] === undefined
      ? serverRows
      : sortRows(serverRows, sort, columns[sort.columnIndex].kind);
  const widths = columnWidthsCh(columns, rows);
  // Over the DISPLAYED rows, so a sorted grid searches what is on screen.
  const hits = findCells(rows, query);
  // Clamped, never raw: a remount restores a cursor that may address a match
  // list a re-run has since shrunk — "3 of 2" is a claim about nothing.
  const hitIndex = hits.length === 0 ? 0 : Math.min(storedHit, hits.length - 1);
  const currentHit = hits[hitIndex] ?? null;
  const notice = truncationNotice(result);
  // 🔴 Sorting a TRUNCATED result orders the page we have, not the table. Saying
  // "sorted by amount" over 1,000 of 40,000 rows, and letting the user read the top
  // row as the largest amount, is exactly the quiet lie this codebase refuses.
  const sortCaveat =
    sort !== null && result.truncated
      ? `Sorted within the ${rows.length.toLocaleString()} rows fetched — the query returned more.`
      : null;
  const window_ = visibleWindow(
    scrollTop,
    viewport > 0 ? viewport : FALLBACK_VIEWPORT_PX,
    ROW_HEIGHT_PX,
    rows.length,
  );
  /**
   * A trailing column that owns whatever width is left over — the reason every real
   * column can keep the width it was given.
   *
   * Without it, `min-width: 100%` hands the slack to the *data* columns: a single-column
   * result stretched `id` across the whole pane and parked its numbers 900px from their
   * header, and a column dragged narrower inside a table that already fits took its own
   * space straight back. With it, the leftover space is somewhere harmless.
   *
   * `aria-hidden` because it is geometry, not a cell: `getAllByRole("cell")` and
   * `getAllByRole("columnheader")` must keep counting the result's real columns. And it
   * is only rendered when there ARE columns — a result with none has nothing to line up
   * against, and the empty-state row's `colSpan` may never be 0.
   */
  /**
   * Take me to a match: scroll its ROW into view and its COLUMN into view, and
   * touch nothing else.
   *
   * Two different mechanisms, because the two axes are two different problems —
   * see `gridReveal.ts` for the full argument. Vertically the rows are windowed,
   * so the position comes from the row INDEX (`scrollToRow`, which also allows for
   * the sticky header the row would otherwise land under); horizontally the
   * columns are all rendered, so the header cell's measured box is the truth.
   *
   * Both are `nearest`-shaped: a hit already on screen moves nothing on that axis,
   * so walking a run of adjacent matches does not jitter the viewport.
   *
   * 🔴 It writes `scrollTop`/`scrollLeft` on the CONTAINER and never calls
   * `.focus()` on a cell. Focusing the hit would reveal it too — and would rip the
   * caret out of the find input mid-word, which is the one thing that makes a find
   * bar unusable.
   */
  const revealHit = (hit: CellHit): void => {
    // Non-null: the scroll box and the header row render unconditionally, and this
    // only runs from the find bar, which lives beside them. The file already uses
    // this cast for the same element in the resize effect.
    const box = scrollRef.current as HTMLDivElement;
    const top = scrollToRow(
      hit.row,
      box.scrollTop,
      box.clientHeight > 0 ? box.clientHeight : FALLBACK_VIEWPORT_PX,
      ROW_HEIGHT_PX,
      HEADER_PX,
    );
    if (top !== null) box.scrollTop = top;
    // A hit beyond the last column is a cell the grid does not draw (a row with
    // more values than the result has columns — `markMatch` never marks it either),
    // so there is no column to reveal. Guarded here rather than trusting the
    // `<th>` at that index: index `columns.length` is the aria-hidden filler.
    const header =
      hit.col < columns.length
        ? (headRowRef.current as HTMLTableRowElement).children[hit.col].getBoundingClientRect()
        : null;
    const left = scrollToColumn(header, box.getBoundingClientRect(), box.scrollLeft);
    if (left !== null) box.scrollLeft = left;
  };

  /**
   * Take me to hit 1 of a query the user just CHANGED — typed, or seeded from the
   * selection by Cmd/Ctrl+F (the seed is the same query-change path).
   *
   * The hits are recomputed here rather than read from the render the patch
   * schedules, because a reveal is the answer to a gesture and must happen on the
   * gesture. The alternative — an effect keyed on the current hit, which is the
   * shape `ResponseBody` uses — would also fire on MOUNT, where it would fight the
   * scroll offset this grid restores on purpose (scroll a result, move the tab,
   * come back where you were). A remount must not yank you
   * to a match you walked away from.
   *
   * The cost is one extra `findCells` pass per keystroke over rows the render is
   * about to scan anyway — bounded by `rowLimit`, and the same order as the render.
   */
  const revealFirst = (nextQuery: string): void => {
    const first = findCells(rows, nextQuery)[0];
    if (first !== undefined) revealHit(first);
  };

  /** Move the cursor and reveal the hit it lands on. */
  const stepHit = (delta: number): void => {
    if (hits.length === 0) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(next);
    // Mirror the gesture into the record, so the cursor survives the unmount a
    // tab switch/move is (the local copy above is what the render resets).
    patchFindBar(findKey, { cursor: next });
    revealHit(hits[next]);
  };

  /**
   * Close the bar and hand focus BACK to the grid.
   *
   * Without the refocus the input unmounts, focus falls to `<body>`, and the
   * next Cmd/Ctrl+F never reaches this handler — so closing the bar would
   * silently disable the shortcut that opens it.
   */
  const closeFind = (): void => {
    // Deleting the record IS the closed state (and forgets the query) — while
    // a mere unmount leaves it alone, which is the entire difference between
    // pressing Esc and dragging the tab to another pane.
    dropFindBar(findKey);
    gridRef.current?.focus?.();
  };

  /** Cmd/Ctrl+F opens the bar; Escape closes it. Scoped to this grid. */
  const onGridKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
      // preventDefault so the key never reaches WebKit's own find, which would
      // search the window — including the rows this grid has not rendered.
      e.preventDefault();
      // Selected cell text seeds the bar. Read NOW,
      // synchronously: the focus below is deferred a tick precisely because the
      // input does not exist yet, and focusing it collapses the selection. The
      // patch is byte-for-byte the one the input's onChange makes, so a seeded
      // search and a typed one are the same code path — new hits, cursor back
      // to the first. The grid always renders, so the ref is live here.
      const seed = domSelectionSeed(gridRef.current as HTMLDivElement);
      // An UNCHANGED query is left alone entirely, as the editor's bar does
      // — and here it is load-bearing twice over: the hit cursor has a
      // LOCAL copy (`storedHit`) that only the render-time `hitsBelongTo` reset
      // touches, so zeroing the record for a query that did not change would
      // leave the two disagreeing until the next remount moved the user's place.
      const seeded = seed === null || seed === query ? null : seed;
      patchFindBar(
        findKey,
        seeded === null ? { open: true } : { open: true, query: seeded, cursor: 0 },
      );
      // Same query-change path as typing, so the same reveal: a seeded search
      // that reports "1 of 57" and leaves the 1 off-screen has not answered.
      if (seeded !== null) revealFirst(seeded);
      // Select, not just focus: the seeded text is typed over, exactly as in
      // every other find bar in this app and in VS Code, Chrome and Firefox.
      window.setTimeout(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }, 0);
      return;
    }
    if (e.key === "Escape" && findOpen) {
      e.preventDefault();
      closeFind();
    }
  };

  const filler = columns.length > 0;
  const span = filler ? columns.length + 1 : 1;

  /* ── column resize ───────────────────────────────────────────────────────────
     The `RailResizer` / `DbConsole` divider pattern, one axis over: window-level
     listeners (so the drag keeps tracking when the pointer leaves the 6px strip) plus
     the `is-resizing` body class that kills text selection app-wide. */

  /** Where a drag starts from: the override if there is one, else what is on screen. */
  const startWidthOf = (handle: HTMLElement, index: number): number => {
    const override = widthPx[index];
    if (override !== undefined) return override;
    return (handle.parentElement as HTMLElement).getBoundingClientRect().width;
  };

  const setWidth = (index: number, px: number) =>
    setWidthPx((prev) => ({ ...prev, [index]: clampColumnPx(px) }));

  const onHandleDown = (e: React.PointerEvent<HTMLSpanElement>, index: number) => {
    e.preventDefault();
    const start = startWidthOf(e.currentTarget, index);
    // No layout engine (jsdom) or not laid out yet: a pixel drag has no meaning, and
    // starting from 0 would snap the column to the minimum on the first pointermove.
    if (start <= 0) return;
    const startX = e.clientX;
    document.body.classList.add("is-resizing");
    const onMove = (ev: PointerEvent | MouseEvent) => setWidth(index, start + (ev.clientX - startX));
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>, index: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const start = startWidthOf(e.currentTarget, index);
    if (start <= 0) return;
    setWidth(index, start + (e.key === "ArrowRight" ? COL_RESIZE_STEP_PX : -COL_RESIZE_STEP_PX));
  };

  /**
   * Double-click: back to the sampled fit. That IS the auto-fit — it is the same
   * measurement the first paint used — rather than a "widest value in the whole
   * result" pass, which would have to read every row of a 500-row result to answer.
   */
  const resetWidth = (index: number) =>
    setWidthPx((prev) => {
      if (prev[index] === undefined) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });

  return (
    <div
      className="db-grid"
      data-testid="db-grid"
      style={{ ["--db-row-h" as string]: `${ROW_HEIGHT_PX}px` }}
      onKeyDown={onGridKeyDown}
      tabIndex={-1}
      ref={gridRef}
    >
      {notice !== null && (
        <p className="db-grid__truncated" data-testid="db-grid-truncated" role="status">
          {notice}
        </p>
      )}
      {sortCaveat !== null && (
        <p className="db-grid__truncated" data-testid="db-grid-sort-caveat" role="status">
          {sortCaveat}
        </p>
      )}
      {findOpen && (
        <div className="db-grid__find" data-testid="db-grid-find">
          <input
            ref={findInputRef}
            className="db-grid__find-input"
            data-testid="db-grid-find-input"
            aria-label="Search the results"
            placeholder="Find in results…"
            value={query}
            // Cursor 0 in the SAME patch: a new query means new hits, and the
            // stored cursor addressed the old ones (the local copy is zeroed
            // by the render-safe `hitsBelongTo` block above). Then reveal the
            // hit the cursor now names — "1 of 57" is not an answer if the user
            // has to go hunting for the 1.
            onChange={(e) => {
              patchFindBar(findKey, { query: e.target.value, cursor: 0 });
              revealFirst(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="db-grid__find-count" data-testid="db-grid-find-count">
            {query.trim() === ""
              ? ""
              : hits.length === 0
                ? "No matches"
                : `${hitIndex + 1} of ${hits.length}`}
          </span>
          <button
            type="button"
            className="db-grid__find-btn"
            data-testid="db-grid-find-prev"
            aria-label="Previous match"
            disabled={hits.length === 0}
            onClick={() => stepHit(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="db-grid__find-btn"
            data-testid="db-grid-find-next"
            aria-label="Next match"
            disabled={hits.length === 0}
            onClick={() => stepHit(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="db-grid__find-btn"
            data-testid="db-grid-find-close"
            aria-label="Close search"
            onClick={closeFind}
          >
            ✕
          </button>
        </div>
      )}
      <div
        className="db-grid__scroll"
        data-testid="db-grid-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table>
          <colgroup>
            {widths.map((ch, i) => (
              <col
                key={i}
                data-testid={`db-grid-col-${i}`}
                /* `+ 18px` is the cell's own chrome — 8px of padding either side and the
                   1px borders. `columnWidthsCh` counts GLYPHS, and a `<col>` width under
                   `table-layout: fixed` is a border-box width, so handing it the bare
                   `ch` count spends the padding out of the text: a 4-character column
                   named `name` rendered as `na…` in its own header. */
                style={{
                  width: widthPx[i] !== undefined ? `${widthPx[i]}px` : `calc(${ch}ch + 18px)`,
                }}
              />
            ))}
            {/* No width: under `table-layout: fixed` the single auto column takes the
                whole remainder, and nothing when the real columns already overflow. */}
            {filler && <col data-testid="db-grid-col-filler" />}
          </colgroup>
          <thead>
            <tr ref={headRowRef}>
              {columns.map((column, i) => (
                <th
                  key={i}
                  scope="col"
                  data-kind={column.kind}
                  aria-sort={
                    sort?.columnIndex === i
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    className="db-grid__sort"
                    data-testid={`db-grid-sort-${i}`}
                    aria-label={`Sort by ${column.name}`}
                    onClick={() => {
                      setSort((cur) => nextSort(cur, i));
                      // The stored cursor belonged to the old order. The
                      // render-safe block above zeroes the local copy; this
                      // keeps the copy that survives a remount in step.
                      if (bar !== undefined) patchFindBar(findKey, { cursor: 0 });
                    }}
                  >
                    <span className="db-grid__name">{column.name}</span>
                    <span className="db-grid__arrow" aria-hidden="true">
                      {sort?.columnIndex === i ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                    </span>
                  </button>
                  {/* The server's own type name, verbatim (`varchar(64)`,
                      `Nullable(UInt8)`) — never a mapped-to-ours name. */}
                  <span className="db-grid__type">{column.typeName}</span>
                  <span
                    className="db-grid__resize"
                    data-testid={`db-grid-resize-${i}`}
                    data-resized={widthPx[i] !== undefined ? "true" : undefined}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize column ${column.name}`}
                    title="Drag to resize. Double-click to fit the sampled values."
                    tabIndex={0}
                    onPointerDown={(e) => onHandleDown(e, i)}
                    onKeyDown={(e) => onHandleKeyDown(e, i)}
                    onDoubleClick={() => resetWidth(i)}
                  />
                </th>
              ))}
              {filler && <th className="db-grid__filler" aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="db-grid__empty" colSpan={span} data-testid="db-grid-empty">
                  No rows. The statement ran and matched nothing.
                </td>
              </tr>
            ) : (
              <>
                {window_.padTop > 0 && (
                  <tr aria-hidden="true" data-testid="db-grid-pad-top">
                    <td style={{ height: `${window_.padTop}px` }} colSpan={span} />
                  </tr>
                )}
                {rows.slice(window_.start, window_.end).map((row, i) => {
                  const index = window_.start + i;
                  return (
                    <tr key={index} data-row={index}>
                      {columns.map((column, c) => {
                        // 🔴 A masked cell becomes `undefined`, which `renderCell` paints as
                        // `missing` — visibly different from a NULL chip. Two engines can omit a
                        // field entirely, and reading that as SQL NULL would be the
                        // grid stating a fact the document never contained.
                        const masked = result.absent?.[index]?.[c] === true;
                        const cell = renderCell(masked ? undefined : row[c], column.kind);
                        return (
                          <td
                            key={c}
                            data-kind={column.kind}
                            data-display={cell.display}
                            /* These two are the documented test/E2E hooks, so they
                               stay even though `data-display` carries the same
                               fact — "NULL is distinguishable from empty" is an
                               assertion in this repo, not a claim. */
                            data-null={cell.display === "null" ? "true" : undefined}
                            data-empty={cell.display === "empty" ? "true" : undefined}
                            data-collapsed={cell.collapsed ? "true" : undefined}
                            title={cell.title}
                            style={{ textAlign: cell.align }}
                          >
                            {cell.display === "null" ? (
                              <span className="db-grid__null">NULL</span>
                            ) : (
                              markMatch(
                                cell.text,
                                query,
                                currentHit?.row === index && currentHit.col === c,
                              )
                            )}
                          </td>
                        );
                      })}
                      {filler && <td className="db-grid__filler" aria-hidden="true" />}
                    </tr>
                  );
                })}
                {window_.padBottom > 0 && (
                  <tr aria-hidden="true" data-testid="db-grid-pad-bottom">
                    <td style={{ height: `${window_.padBottom}px` }} colSpan={span} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
