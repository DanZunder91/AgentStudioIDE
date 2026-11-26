/** Props-only results table; the one store seam is find/scroll/sort state, as Pane unmounts
 * inactive tabs. Not CsvTable (no NULL, no kinds, no windowing). Rows are windowed (visibleWindow);
 * columns render in full (Mongo's union is capped at 64). Width overrides are px, per result. */

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

/** Marks the DISPLAYED text: a match inside collapsed whitespace still counts but is unmarked.
 * React children, never innerHTML (the FindInFiles idiom). */
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

/** Approximate on purpose: a few px off moves a row a few px, and measuring would add a layout
 * read to a hot render. */
const HEADER_PX = 44;

export function ResultsGrid({
  result,
  findKey = "grid:local",
}: {
  result: DbResultSet;
  /** findBars key: DbConsole passes grid:<connectionId>:<i>, so bars never collide. */
  findKey?: string;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Seeded lazily from the store (Pane unmounts inactive tabs), never subscribed: another
  // surface's scroll must not re-render this.
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
  /** null is the server's order. Seeded lazily from the store, so an unmount keeps the sort. */
  const [sort, setSort] = useState<SortState | null>(() => remembered()?.sort ?? null);
  /** Open state and query live in the store to survive unmounts; an absent record is closed. */
  const bar = useAppStore((s) => s.findBars[findKey]);
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);
  const setScrollOffset = useAppStore((s) => s.uiActions.setScrollOffset);
  const setGridView = useAppStore((s) => s.uiActions.setGridView);
  const findOpen = bar?.open ?? false;
  const query = bar?.query ?? "";
  /** Store-backed across mounts, local within one: render-time resets can't write the store, so
   * gestures mirror the cursor into it. Clamped where hitIndex is derived: results may re-run. */
  const [storedHit, setHitIndex] = useState(() => bar?.cursor ?? 0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** The hit's <td> may not exist (rows are windowed), but the <th> always does, with the column's
   * exact extent under fixed layout (gridReveal.ts). */
  const headRowRef = useRef<HTMLTableRowElement>(null);
  // 0 until measured. jsdom never measures (no layout engine), so 0 is also the
  // permanent value in the unit tier — hence FALLBACK_VIEWPORT_PX below.
  const [viewport, setViewport] = useState(0);

  // Put the restored offset back on the box before paint; persist on unmount (one write per
  // tab move, not one per scroll).
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

  // Window resize, not ResizeObserver: src/test/setup.ts stubs that to a no-op, which would make
  // this untestable in the gating tier.
  useEffect(() => {
    const onResize = () => setViewport((scrollRef.current as HTMLDivElement).clientHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Mirror the view into the store on every change, the reset below included, so a new result
  // clears the remembered sort.
  useEffect(() => {
    setGridView(findKey, { sort, widthPx, columns: columnSig });
    // columnSig is a fresh array each render; its VALUE is covered by result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findKey, sort, widthPx, setGridView, result]);

  // Reset during render, not in an effect, which would paint the new result with the old widths.
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

  // scrollTop includes the sticky header, so the window may run ~2 rows late: inside the
  // 8-row overscan, hence no subtraction.
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
  /** Reveals the row (by index: rows are windowed) and the column (by header box), nearest-style so
   * visible hits stay put. Writes the container's scroll, never focuses a cell: that would steal
   * the find input's caret. */
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
    // A hit past the last column is undrawn; index columns.length is the aria-hidden filler.
    const header =
      hit.col < columns.length
        ? (headRowRef.current as HTMLTableRowElement).children[hit.col].getBoundingClientRect()
        : null;
    const left = scrollToColumn(header, box.getBoundingClientRect(), box.scrollLeft);
    if (left !== null) box.scrollLeft = left;
  };

  /** Reveal hit 1 on the gesture, not in an effect keyed on the hit: that would also fire on mount
   * and fight the restored scroll offset. Costs one extra findCells pass per keystroke. */
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

  /** Refocus the grid, or focus falls to body and the next Cmd/Ctrl+F never arrives. */
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
      // Read the selection now: the deferred focus below collapses it. Same patch as
      // onChange, so seeding and typing are one path.
      const seed = domSelectionSeed(gridRef.current as HTMLDivElement);
      // An unchanged query is left alone: zeroing the record would desync it from the
      // local storedHit until the next remount.
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

  // A trailing aria-hidden filler column takes the leftover width, so data columns keep theirs.
  // Only with columns: the empty-state row's colSpan must never be 0.
  const filler = columns.length > 0;
  const span = filler ? columns.length + 1 : 1;

  /* Column resize: window-level listeners keep tracking off the 6px strip, and
     is-resizing on body kills text selection. */

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

  /** Back to the sampled fit (the first paint's measurement), not a full-result scan. */
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
            // Cursor 0 in the same patch (new query, new hits), then reveal hit 1.
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
                /* + 18px is the cell's padding and borders: a fixed-layout <col>
                   width is border-box, and columnWidthsCh counts glyphs only. */
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
                        // A masked cell is undefined, painted as missing, never NULL:
                        // the document never contained that field.
                        const masked = result.absent?.[index]?.[c] === true;
                        const cell = renderCell(masked ? undefined : row[c], column.kind);
                        return (
                          <td
                            key={c}
                            data-kind={column.kind}
                            data-display={cell.display}
                            /* Documented test/E2E hooks, kept beside data-display. */
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
