/** Every sentence and label is typed out literally: a loop over the record would stay green if a
 * sentence were rewritten. Fixtures are inputs only. */

import { describe, expect, it } from "vitest";

import {
  clampColumnPx,
  clampSplit,
  COL_RESIZE_STEP_PX,
  columnWidthsCh,
  formatDuration,
  MAX_COL_PX,
  MAX_SPLIT,
  messageBody,
  MIN_COL_PX,
  MIN_SPLIT,
  readOnlyBadge,
  renderCell,
  resultSummary,
  ROW_HEIGHT_PX,
  runHint,
  shikiIdFor,
  shikiIdForText,
  truncationNotice,
  visibleWindow,
  placeholderFor,
} from "./consoleFormat";
import {
  AFFECTED_RESULT,
  AT_LIMIT_RESULT,
  BLANK_MESSAGE_RESULT,
  EMPTY_RESULT,
  MESSAGE_RESULT,
  TRACKS_RESULT,
  TRUNCATED_RESULT,
} from "./consoleFixtures";
import type { DbCellKind, DbColumn, DbResultSet } from "../types";

/* ══════════════════════ NULL vs "" vs whitespace ══════════════════════════ */

describe("renderCell — the three states the text protocol exists to preserve", () => {
  it("renders SQL NULL as its own display state with an empty text payload", () => {
    const cell = renderCell(null, "text");
    expect(cell.display).toBe("null");
    // The chip's glyphs are the renderer's; `text` stays empty so no one can
    // accidentally treat the string "NULL" as data.
    expect(cell.text).toBe("");
    expect(cell.title).toBe("SQL NULL");
    expect(cell.collapsed).toBe(false);
  });

  it("renders the empty string as a DIFFERENT display state from NULL", () => {
    const empty = renderCell("", "text");
    expect(empty.display).toBe("empty");
    expect(empty.text).toBe("");
    expect(empty.title).toBe("Empty string");
    // The assertion that protects the whole backend design: same painted text,
    // different state.
    expect(empty.display).not.toBe(renderCell(null, "text").display);
  });

  it("renders a whitespace-only value as neither NULL nor empty", () => {
    const cell = renderCell("   ", "text");
    expect(cell.display).toBe("whitespace");
    expect(cell.text).toBe("   ");
    expect(cell.title).toBe("Whitespace only (3 characters)");
  });

  it("says 'character' in the singular for a one-space value", () => {
    expect(renderCell(" ", "text").title).toBe("Whitespace only (1 character)");
  });

  it("counts a tab as whitespace, and collapses a newline-only value onto one line", () => {
    expect(renderCell("\t", "text").display).toBe("whitespace");
    const newlines = renderCell("\n\n", "text");
    expect(newlines.display).toBe("whitespace");
    expect(newlines.text).toBe("  ");
    expect(newlines.collapsed).toBe(true);
    expect(newlines.title).toBe("Whitespace only (2 characters)");
  });

  it("marks a row shorter than the column list as MISSING, never as NULL", () => {
    const cell = renderCell(undefined, "text");
    expect(cell.display).toBe("missing");
    expect(cell.title).toBe("No value — this row is shorter than the column list.");
    // A renderer that invented a SQL NULL here would be lying about the data.
    expect(cell.display).not.toBe("null");
  });

  it("passes a `0` through as a value — falsy is not absent", () => {
    const cell = renderCell("0", "number");
    expect(cell.display).toBe("value");
    expect(cell.text).toBe("0");
  });
});

/* ══════════════════════════ every DbCellKind ══════════════════════════════ */

describe("renderCell — kind drives rendering, never the value", () => {
  it("right-aligns number and left-aligns every other kind", () => {
    expect(renderCell("42", "number").align).toBe("right");
    expect(renderCell("42", "text").align).toBe("left");
    expect(renderCell("42", "bool").align).toBe("left");
    expect(renderCell("42", "json").align).toBe("left");
    expect(renderCell("42", "binary").align).toBe("left");
    expect(renderCell("42", "datetime").align).toBe("left");
    expect(renderCell("42", "unknown").align).toBe("left");
  });

  it("leaves text, bool, binary, datetime and unknown values byte-for-byte alone", () => {
    // No client reformatting, ever. A `t` stays `t`, not "true"; a timestamp
    // keeps the server's exact text; bytea keeps its `\x…` escape form.
    expect(renderCell("t", "bool").text).toBe("t");
    expect(renderCell("\\x48656c6c6f", "binary").text).toBe("\\x48656c6c6f");
    expect(renderCell("2026-07-30 09:15:00+00", "datetime").text).toBe("2026-07-30 09:15:00+00");
    expect(renderCell("POINT(1 2)", "unknown").text).toBe("POINT(1 2)");
    expect(renderCell("hello", "text").text).toBe("hello");
    for (const kind of ["bool", "binary", "datetime", "unknown", "text"] as DbCellKind[]) {
      expect(renderCell("plain", kind).collapsed).toBe(false);
    }
  });

  it("compacts a json cell's whitespace runs onto one line", () => {
    const cell = renderCell('{\n  "a": 1,\n  "b": [2, 3]\n}', "json");
    expect(cell.text).toBe('{ "a": 1, "b": [2, 3] }');
    expect(cell.collapsed).toBe(true);
    // The tooltip keeps the value as it arrived.
    expect(cell.title).toBe('{\n  "a": 1,\n  "b": [2, 3]\n}');
  });

  it("collapses only NEWLINES for a text cell, keeping its internal spacing", () => {
    // A text value's double space is data; a json value's is indentation. Squeezing
    // both the same way would change what text looks like for no benefit.
    const cell = renderCell("first  line\nsecond", "text");
    expect(cell.text).toBe("first  line second");
    expect(cell.collapsed).toBe(true);
  });

  it("does not sniff: a text value that LOOKS like hex or json is still text", () => {
    // The canonical example. Nothing about the value may change the treatment.
    expect(renderCell("\\x4142", "text").text).toBe("\\x4142");
    expect(renderCell('{\n "a": 1\n}', "text").text).toBe('{  "a": 1 }');
    expect(renderCell("12345", "text").align).toBe("left");
  });

  it("caps the tooltip at 500 characters rather than putting a megabyte in an attribute", () => {
    expect(renderCell("x".repeat(500), "text").title).toBe("x".repeat(500));
    expect(renderCell("x".repeat(501), "text").title).toBe(`${"x".repeat(500)}…`);
  });
});

/* ═══════════════════════════════ truncation ═══════════════════════════════ */

describe("truncationNotice — measured, never inferred", () => {
  it("is silent for a result that was not cut", () => {
    expect(truncationNotice(TRACKS_RESULT)).toBeNull();
    expect(truncationNotice(EMPTY_RESULT)).toBeNull();
  });

  it("stays silent at the boundary: exactly rowLimit rows and truncated=false", () => {
    // The case a `rows.length === rowLimit` heuristic would get wrong. A table
    // holding exactly 500 rows is the honest case, and crying truncation here is
    // how a warning gets trained away.
    expect(AT_LIMIT_RESULT.rows).toHaveLength(500);
    expect(AT_LIMIT_RESULT.rowLimit).toBe(500);
    expect(truncationNotice(AT_LIMIT_RESULT)).toBeNull();
  });

  it("announces the cut loudly when the backend saw the extra row", () => {
    expect(truncationNotice(TRUNCATED_RESULT)).toBe(
      "Showing the first 500 rows of more — the row limit (500) cut this result. " +
        "Raise the limit or narrow the query.",
    );
  });

  it("reports what is actually on screen, not what the limit was", () => {
    // A backend that returned fewer rows than the cap and still flagged truncation
    // must not be described as "the first 500" when 3 are visible.
    const odd: DbResultSet = { ...TRACKS_RESULT, truncated: true, rowLimit: 500 };
    expect(truncationNotice(odd)).toBe(
      "Showing the first 3 rows of more — the row limit (500) cut this result. " +
        "Raise the limit or narrow the query.",
    );
  });
});

/* ═════════════════════════════ summaries ═════════════════════════════════ */

describe("resultSummary", () => {
  it("counts rows, with the singular where it belongs", () => {
    expect(resultSummary(TRACKS_RESULT)).toBe("3 rows · 12 ms");
    expect(resultSummary({ ...TRACKS_RESULT, rows: [["AMB", "1", "x"]] })).toBe("1 row · 12 ms");
    expect(resultSummary(EMPTY_RESULT)).toBe("0 rows · 3 ms");
  });

  it("never lets a truncated result read as a complete count", () => {
    expect(resultSummary(TRUNCATED_RESULT)).toBe("first 500 rows of more · 88 ms");
    // The same 500 rows, honestly complete, read completely differently.
    expect(resultSummary(AT_LIMIT_RESULT)).toBe("500 rows · 88 ms");
  });

  it("reports an affected-count, and says Done when the engine gave none", () => {
    expect(resultSummary(AFFECTED_RESULT)).toBe("42 rows affected · 5 ms");
    expect(resultSummary({ ...AFFECTED_RESULT, rowsAffected: 1 })).toBe("1 row affected · 5 ms");
    expect(resultSummary({ ...AFFECTED_RESULT, rowsAffected: 0 })).toBe("0 rows affected · 5 ms");
    expect(resultSummary({ ...AFFECTED_RESULT, rowsAffected: null })).toBe("Done · 5 ms");
  });

  it("labels a message result as a message", () => {
    expect(resultSummary(MESSAGE_RESULT)).toBe("Message · 1 ms");
  });
});

describe("formatDuration", () => {
  it("stays in milliseconds below a second", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("switches to seconds at exactly 1000 ms", () => {
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(95_000)).toBe("95.00 s");
  });
});

describe("messageBody", () => {
  it("shows the server's own text for a message result", () => {
    expect(messageBody(MESSAGE_RESULT)).toBe('syntax error at or near "SELET"');
  });

  it("says so rather than rendering a blank when there is no text", () => {
    expect(messageBody(BLANK_MESSAGE_RESULT)).toBe("The server returned a message with no text.");
    expect(messageBody({ ...MESSAGE_RESULT, notice: "   " })).toBe(
      "The server returned a message with no text.",
    );
  });
});

/* ══════════════════════════ error sentences ══════════════════════════════ */

// describeDbError is covered by ../dbErrors.test.ts.

describe("readOnlyBadge — a control never claims to be stronger than it is", () => {
  it("is a plain, unqualified badge when the SERVER enforces read-only", () => {
    const badge = readOnlyBadge(true, true);
    expect(badge.label).toBe("read-only");
    expect(badge.tone).toBe("safe");
    expect(badge.title).toBe(
      "Enforced by the server: a write or DDL fails at the engine, not in this app. Statements that would switch this session back to read-write are refused before they are sent.",
    );
    // Nothing to qualify: Postgres really will refuse the write.
    expect(badge.caveat).toBeNull();
  });

  it("says WHO enforces it, and adds the caveat, when only this app does", () => {
    const badge = readOnlyBadge(true, false);
    expect(badge.label).toBe("read-only (enforced by this app)");
    expect(badge.tone).toBe("warn");
    expect(badge.title).toBe("This engine has no server-side read-only mode.");
    expect(badge.caveat).toBe(
      "Read-only is a client-side speed bump on this engine, not a guarantee — " +
        "connect with a read-only database user for a real boundary.",
    );
  });

  it("makes writes-enabled visible, whatever the engine could have enforced", () => {
    const enforceable = readOnlyBadge(false, true);
    const not = readOnlyBadge(false, false);
    expect(enforceable.label).toBe("writes enabled");
    expect(enforceable.tone).toBe("danger");
    expect(enforceable.title).toBe("This connection can modify data and schema.");
    expect(enforceable.caveat).toBe("Writes and DDL will run against this database.");
    // With read-only off there is no guard either way, so the engine's capability
    // must not soften the warning.
    expect(not).toEqual(enforceable);
  });
});

/* ════════════════════════ the editor's language ══════════════════════════ */

describe("shikiIdFor / runHint", () => {
  it("colours SQL and JSON with the file editor's own grammars, and Redis with none", () => {
    expect(shikiIdFor("sql")).toBe("sql");
    expect(shikiIdFor("json")).toBe("json");
    // Shiki ships no `redis` grammar; borrowing `bash` would colour `#` as a
    // comment in a protocol that has none. Plaintext beats wrong colour.
    expect(shikiIdFor("commandline")).toBeNull();
  });

  it("says what Run means for each engine family", () => {
    // The only place the user learns what ⌘⏎ does (statements.ts::textToRun); each
    // names the selection first, as a selection wins on every engine.
    expect(runHint("sql")).toBe("Runs the selection, or the statement under the cursor.");
    expect(runHint("json")).toBe("Runs the selection, or the whole command document.");
    expect(runHint("commandline")).toBe("Runs the selection, or the line under the cursor.");
  });
});

describe("shikiIdForText — the grammar follows the BUFFER, not only the engine", () => {
  // Openers are written out, not looped from the regex: "truncat" would keep a loop green.
  it("recognises every statement opener as SQL, on a JSON engine", () => {
    expect(shikiIdForText("json", "select * from t")).toBe("sql");
    expect(shikiIdForText("json", "insert into t values (1)")).toBe("sql");
    expect(shikiIdForText("json", "update t set a = 1")).toBe("sql");
    expect(shikiIdForText("json", "delete from t")).toBe("sql");
    expect(shikiIdForText("json", "with x as (select 1) select * from x")).toBe("sql");
    expect(shikiIdForText("json", "show collections")).toBe("sql");
    expect(shikiIdForText("json", "describe t")).toBe("sql");
    expect(shikiIdForText("json", "explain select 1")).toBe("sql");
    expect(shikiIdForText("json", "create table t (a int)")).toBe("sql");
    expect(shikiIdForText("json", "drop table t")).toBe("sql");
    expect(shikiIdForText("json", "alter table t add b int")).toBe("sql");
    expect(shikiIdForText("json", "truncate table t")).toBe("sql");
  });

  it("does not care about case, and takes the original statement verbatim", () => {
    expect(shikiIdForText("json", "SELECT 1")).toBe("sql");
    expect(shikiIdForText("json", "SeLeCt 1")).toBe("sql");
    expect(shikiIdForText("json", "select * from ARCHIVEDB.temp_playlists LIMIT 10;")).toBe("sql");
    // No whitespace after the keyword: `\b`, not `\s`, is what makes this SQL.
    expect(shikiIdForText("json", "select*from t")).toBe("sql");
  });

  it("keeps a Mongo command document as JSON even when a VALUE contains SQL", () => {
    // The assertion a naive `text.includes("select")` fails. Only the leading token
    // decides; a filter that quotes a SQL sentence is still a JSON document.
    expect(shikiIdForText("json", '{"find": "t", "filter": {"note": "select * from x"}}')).toBe(
      "json",
    );
    expect(shikiIdForText("json", '{"aggregate": "t", "pipeline": [{"$match": {"q": "DROP TABLE t"}}]}')).toBe(
      "json",
    );
    // A top-level JSON *string* whose content is SQL is still JSON — the buffer opens
    // with a quote, not with a keyword.
    expect(shikiIdForText("json", '"select 1"')).toBe("json");
  });

  it("is not fooled by a word that merely STARTS with a keyword", () => {
    // `selection` is an identifier, not a statement. A `startsWith` check would call
    // both of these SQL.
    expect(shikiIdForText("json", "selection_criteria")).toBe("json");
    expect(shikiIdForText("json", "updates: 3")).toBe("json");
  });

  it("sees past leading whitespace and a leading SQL comment", () => {
    expect(shikiIdForText("json", "   \n\t select 1")).toBe("sql");
    expect(shikiIdForText("json", "-- daily widget count\nselect count(*) from widgets")).toBe(
      "sql",
    );
    expect(shikiIdForText("json", "-- one\n-- two\n  select 1")).toBe("sql");
    expect(shikiIdForText("json", "/* header */ select 1")).toBe("sql");
    expect(shikiIdForText("json", "/* a */\n/* b */\nselect 1")).toBe("sql");
  });

  it("treats a buffer with no first token yet as the engine's own language", () => {
    // Empty, blank, and comment-only — including UNTERMINATED comments, which swallow
    // the rest of the buffer. Nothing has been typed that could be SQL.
    expect(shikiIdForText("json", "")).toBe("json");
    expect(shikiIdForText("json", "   \n  ")).toBe("json");
    expect(shikiIdForText("json", "-- still thinking")).toBe("json");
    expect(shikiIdForText("json", "/* still thinking")).toBe("json");
    expect(shikiIdForText("sql", "")).toBe("sql");
    expect(shikiIdForText("commandline", "")).toBeNull();
  });

  it("leaves a non-SQL buffer on the engine's default, whatever the engine is", () => {
    expect(shikiIdForText("json", '{"find": "tracks", "limit": 10}')).toBe("json");
    expect(shikiIdForText("commandline", "GET widget:42")).toBeNull();
    // Redis has no grammar, so a Redis console showing SQL now gets colour it never had.
    expect(shikiIdForText("commandline", "select 1")).toBe("sql");
    // And a SQL engine is unaffected by a buffer that does not open with a keyword.
    expect(shikiIdForText("sql", "vacuum analyze")).toBe("sql");
  });
});

/* ════════════════════════════ the split ratio ════════════════════════════ */

describe("clampSplit", () => {
  it("passes a sane fraction through", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.2)).toBe(0.2);
  });

  it("clamps to [0.15, 0.85] so neither pane can be dragged away", () => {
    expect(MIN_SPLIT).toBe(0.15);
    expect(MAX_SPLIT).toBe(0.85);
    expect(clampSplit(0)).toBe(0.15);
    expect(clampSplit(-3)).toBe(0.15);
    expect(clampSplit(1)).toBe(0.85);
    expect(clampSplit(99)).toBe(0.85);
  });

  it("absorbs a non-finite fraction instead of handing NaN to flex-grow", () => {
    // Reachable the moment anything divides by a container height of 0 — and a NaN
    // grow silently collapses a pane rather than throwing.
    expect(clampSplit(NaN)).toBe(0.5);
    expect(clampSplit(Infinity)).toBe(0.5);
  });
});

/* ════════════════════════════════ windowing ════════════════════════════════ */

describe("visibleWindow", () => {
  it("renders from the top with overscan below when unscrolled", () => {
    // 440px viewport / 22px rows = 20 spans, +1 partial, +8 overscan = 29.
    const w = visibleWindow(0, 440, 22, 1000);
    expect(w).toEqual({ start: 0, end: 29, padTop: 0, padBottom: (1000 - 29) * 22 });
  });

  it("windows around the scroll position", () => {
    // scrollTop 2200 = row 100. start = 100 - 8; end = 100 + 21 + 8.
    const w = visibleWindow(2200, 440, 22, 1000);
    expect(w).toEqual({ start: 92, end: 129, padTop: 92 * 22, padBottom: (1000 - 129) * 22 });
  });

  it("keeps the scrollbar honest: padTop + rendered + padBottom is always the full height", () => {
    // The one property that matters. Checked across the whole scroll range rather
    // than at a hand-picked point, with the expectation computed from the INPUTS
    // (total rows × row height), not from the function's own output.
    for (const total of [1, 7, 500, 100_000]) {
      for (const scrollTop of [0, 1, 21, 22, 5_000, 500_000, 9_999_999]) {
        const w = visibleWindow(scrollTop, 440, 22, total);
        expect(w.padTop + (w.end - w.start) * 22 + w.padBottom).toBe(total * 22);
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.end).toBeLessThanOrEqual(total);
        expect(w.start).toBeLessThanOrEqual(w.end);
      }
    }
  });

  it("is monotone in scrollTop — scrolling down never moves the window up", () => {
    let previousStart = -1;
    for (let scrollTop = 0; scrollTop <= 22_000; scrollTop += 137) {
      const w = visibleWindow(scrollTop, 440, 22, 1000);
      expect(w.start).toBeGreaterThanOrEqual(previousStart);
      previousStart = w.start;
    }
  });

  it("clamps an over-scroll to the last screenful instead of running off the end", () => {
    const w = visibleWindow(9_999_999, 440, 22, 50);
    expect(w.end).toBe(50);
    expect(w.padBottom).toBe(0);
  });

  it("clamps a negative scrollTop (elastic/rubber-band scrolling) to the top", () => {
    expect(visibleWindow(-500, 440, 22, 50)).toEqual(visibleWindow(0, 440, 22, 50));
  });

  it("returns an empty window for an empty result", () => {
    expect(visibleWindow(0, 440, 22, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("returns an empty window for a zero row height rather than dividing by zero", () => {
    expect(visibleWindow(0, 440, 0, 100)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("still renders the overscan when the viewport has not been measured", () => {
    // jsdom (and the first paint) report 0. The grid supplies a fallback height, but
    // the maths itself must not return nothing.
    const w = visibleWindow(0, 0, 22, 100);
    expect(w).toEqual({ start: 0, end: 9, padTop: 0, padBottom: (100 - 9) * 22 });
  });

  it("honours a custom overscan", () => {
    expect(visibleWindow(0, 440, 22, 1000, 0)).toEqual({
      start: 0,
      end: 21,
      padTop: 0,
      padBottom: (1000 - 21) * 22,
    });
  });

  it("publishes a row height the CSS and the maths both use", () => {
    // Raised 22 → 24 because the rows were too small to read. Pinned as a
    // literal because `console.css`'s scroll-box floor is written in this unit and
    // `DbConsole.browser.test.tsx` measures a real row against it.
    expect(ROW_HEIGHT_PX).toBe(24);
  });
});

/* ═══════════════════════════ a dragged column width ═══════════════════════════ */

describe("clampColumnPx", () => {
  it("keeps a dragged width inside the usable range", () => {
    expect(clampColumnPx(240)).toBe(240);
    expect(clampColumnPx(MIN_COL_PX)).toBe(MIN_COL_PX);
    expect(clampColumnPx(MAX_COL_PX)).toBe(MAX_COL_PX);
  });

  it("never lets a column be dragged to nothing — a handle you cannot find again", () => {
    expect(clampColumnPx(0)).toBe(MIN_COL_PX);
    expect(clampColumnPx(-900)).toBe(MIN_COL_PX);
    expect(clampColumnPx(MIN_COL_PX - 1)).toBe(MIN_COL_PX);
  });

  it("caps a runaway drag", () => {
    expect(clampColumnPx(99_999)).toBe(MAX_COL_PX);
  });

  it("rounds, so a sub-pixel pointer never writes 240.00000000003px into a style", () => {
    expect(clampColumnPx(240.4)).toBe(240);
    expect(clampColumnPx(240.6)).toBe(241);
  });

  it("absorbs a non-finite width instead of emitting a NaN <col> width", () => {
    // A `NaN` width silently falls back to `auto`, which re-lays out every OTHER
    // column too — the same class of failure `clampSplit` guards flex-grow against.
    expect(clampColumnPx(Number.NaN)).toBe(MIN_COL_PX);
    expect(clampColumnPx(Number.POSITIVE_INFINITY)).toBe(MIN_COL_PX);
  });

  it("steps by a visible amount for keyboard resizing", () => {
    expect(COL_RESIZE_STEP_PX).toBeGreaterThan(4);
    expect(COL_RESIZE_STEP_PX).toBeLessThan(MIN_COL_PX);
  });
});

/* ═════════════════════════════ column widths ══════════════════════════════ */

describe("columnWidthsCh", () => {
  const cols: DbColumn[] = [
    { name: "code", typeName: "varchar(8)", kind: "text" },
    { name: "secs", typeName: "numeric", kind: "number" },
  ];

  it("fits the widest of the column name, its type name, and the sampled cells", () => {
    // "varchar(8)" is 10 chars, +2 padding = 12. "1240.50000" is 10, +2 = 12.
    expect(columnWidthsCh(cols, [["AMB", "1240.50000"]])).toEqual([12, 12]);
  });

  it("gives a NULL cell the width of its chip, not of the empty string", () => {
    // A column of nothing but NULLs still needs room for "NULL" (4) + 2.
    expect(columnWidthsCh([{ name: "n", typeName: "int", kind: "number" }], [[null]])).toEqual([6]);
  });

  it("never goes below 6ch or above 48ch", () => {
    expect(columnWidthsCh([{ name: "a", typeName: "b", kind: "text" }], [["c"]])).toEqual([6]);
    expect(
      columnWidthsCh([{ name: "a", typeName: "b", kind: "text" }], [["x".repeat(400)]]),
    ).toEqual([48]);
  });

  it("samples only the first N rows, so a 100k result costs a bounded pass", () => {
    const rows = [["short"], ["x".repeat(40)]];
    // With a sample of 1 the long second row is not seen: 5 + 2 = 7.
    expect(columnWidthsCh([{ name: "a", typeName: "b", kind: "text" }], rows, 1)).toEqual([7]);
    // With the default sample it is: 40 + 2 = 42.
    expect(columnWidthsCh([{ name: "a", typeName: "b", kind: "text" }], rows)).toEqual([42]);
  });

  it("measures the ONE-LINE width of a multi-line value, not its raw length", () => {
    // A pretty-printed json cell renders compact, so sizing it by its raw length
    // would reserve a column nobody can see the point of.
    const json: DbColumn[] = [{ name: "j", typeName: "jsonb", kind: "json" }];
    expect(columnWidthsCh(json, [['{\n  "a": 1\n}']])).toEqual([12]); // '{ "a": 1 }' = 10, +2
  });

  it("copes with a ragged row rather than throwing", () => {
    expect(columnWidthsCh(cols, [["AMB"]])).toEqual([12, 9]); // "numeric" (7) + 2
  });

  it("returns an empty list for a result with no columns", () => {
    expect(columnWidthsCh([], [])).toEqual([]);
  });
});

/** Asserted literally: a placeholder with the wrong JSON shape would teach it. */
describe("placeholderFor — what an empty console says it expects", () => {
  it("shows Mongo a real command document whose FIRST key is the command", () => {
    const example = placeholderFor("json");
    expect(example).toBe('{"find": "collection_name", "limit": 10}');
    // It must be valid JSON, or the ghost text is a lie a user would paste.
    const parsed = JSON.parse(example) as Record<string, unknown>;
    // The command name is the first key — the one thing a Mongo user has to get right.
    expect(Object.keys(parsed)[0]).toBe("find");
  });

  it("shows SQL engines SQL, and a command-line engine a command line", () => {
    expect(placeholderFor("sql")).toBe("SELECT * FROM table_name LIMIT 100;");
    // Uppercase keywords, because this doubles as the answer to "does this console highlight SQL?"
    expect(placeholderFor("sql")).toContain("SELECT");
    expect(placeholderFor("commandline")).toBe("GET key_name");
  });

  it("never hands the same example to two different languages", () => {
    // The whole point is that the shape differs per engine. Two identical placeholders would mean
    // one of them is wrong.
    const all = (["sql", "json", "commandline"] as const).map(placeholderFor);
    expect(new Set(all).size).toBe(3);
  });
});
