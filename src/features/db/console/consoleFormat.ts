/**
 * consoleFormat — every decision the DB query console makes about *how to say
 * something*, as pure functions.
 *
 * Split out from the components on purpose: the honesty rules of this feature are
 * all string- and number-shaped ("NULL is not the empty string", "a capped result
 * must not look complete", "a badge must not promise what the engine cannot
 * enforce"), and a rule you can unit-test without a DOM is a rule that stays true.
 * The components below are then thin enough to be about layout only.
 *
 * ── The four rules this file exists to enforce ───────────────────────────────
 * 1. **`null` is SQL NULL, `""` is the empty string, and `"  "` is neither.** The
 *    entire text protocol (every value read as text, NULL kept distinct) exists to preserve that distinction, so
 *    `renderCell` returns a `display` discriminator rather than a string — the
 *    renderer cannot accidentally collapse the three cases into one blank cell.
 * 2. **`kind` drives rendering, never the value.** Nothing here inspects a
 *    value to decide *how* to present it: alignment and compaction are chosen from
 *    `DbCellKind` alone. A `text` column whose value happens to read `\x4142` is
 *    still text.
 * 3. **Truncation is measured, not inferred.** `truncationNotice` reads
 *    `DbResultSet.truncated` — the backend saw the cap+1'th row — and never
 *    compares `rows.length` with `rowLimit`, because those being equal is the
 *    common *honest* case (a table with exactly 500 rows).
 * 4. **A guardrail says how strong it is.** `readOnlyBadge` carries a `caveat` that
 *    is non-null exactly when read-only is our own filter rather than the server's
 *    — so the UI cannot render the strong-sounding badge without the
 *    sentence that qualifies it.
 */

import type { DbCellKind, DbColumn,  DbResultSet } from "../types";

/* ────────────────────────────── layout constants ───────────────────────────── */

/**
 * Fixed row height, in px. Fixed (not measured) is what makes windowing ~30 lines
 * of arithmetic instead of a measurement cache — and it is why a cell is
 * one line with the full value on hover rather than a growing box.
 *
 * Exported so the grid can publish it as the `--db-row-h` custom property: the CSS
 * and the windowing maths must agree, and one constant cannot disagree with itself.
 *
 * 24, not 22: at 22px the table was hard to read and looked too small, because a 12px
 * monospace row has 5px of air in total. Two extra pixels is the whole change — the row
 * stays one line, which is what keeps the windowing exact.
 */
export const ROW_HEIGHT_PX = 24;

/**
 * The viewport height assumed while the real one is unknown — before the first
 * layout, and under jsdom, where `clientHeight` is 0 forever.
 *
 * Without it a 0-height viewport windows down to the overscan and the grid renders
 * a handful of rows in the unit tier, which would make every "the rows are there"
 * assertion an accident of the overscan constant. With it, an unmeasured grid
 * renders a plausible screenful and corrects itself on the first scroll or resize.
 */
export const FALLBACK_VIEWPORT_PX = 600;

/** Rows rendered above and below the viewport, so a fast scroll shows content. */
export const ROW_OVERSCAN = 8;

/** The editor's share of the split, clamped. */
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.85;
/** One arrow-key press of the divider. */
export const SPLIT_STEP = 0.02;

/** How many rows the column-width heuristic samples. */
export const WIDTH_SAMPLE_ROWS = 100;

const MIN_COL_CH = 6;
const MAX_COL_CH = 48;

/**
 * The clamp on a **user-dragged** column width, in px, and one arrow-key step of it.
 *
 * A separate unit from {@link columnWidthsCh} on purpose: the heuristic reasons in
 * characters because it is counting glyphs, and a drag reasons in pixels because that
 * is what a pointer produces. Converting the drag back into `ch` would need the
 * rendered advance width of the monospace font — a measurement, in a component whose
 * measurements are already the one thing jsdom cannot check.
 *
 * The floor is 28px rather than 0: a column dragged to nothing is a column the user
 * then cannot find the handle of again, which is a state with no way out.
 */
export const MIN_COL_PX = 28;
export const MAX_COL_PX = 1600;
export const COL_RESIZE_STEP_PX = 16;

/**
 * Clamp a dragged column width. Absorbs a non-finite input for the same reason
 * {@link clampSplit} does — a `NaN` `<col>` width silently drops back to `auto`,
 * which re-lays out every other column instead of erroring.
 */
export function clampColumnPx(px: number): number {
  if (!Number.isFinite(px)) return MIN_COL_PX;
  return Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px)));
}

/**
 * Cap on a `title` tooltip. A cell can hold a megabyte of JSON; putting that in an
 * attribute costs the DOM real memory for something no one can read in a tooltip.
 * The full value belongs in a value inspector (not built yet).
 */
const MAX_TITLE_CHARS = 500;

/**
 * Clamp the divider fraction. Also absorbs a non-finite input, which is reachable
 * the moment anything divides by a container height — and a `NaN` flex-grow
 * silently collapses a pane rather than erroring, so it must be caught here.
 */
export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction));
}

/* ────────────────────────────────── cells ──────────────────────────────────── */

/**
 * Which of the four "there is nothing to show" cases a cell is in, or `"value"`.
 *
 * `missing` is not a database state: it means the row was shorter than the column
 * list, which the contract forbids. It exists anyway because the alternative —
 * treating a short row's tail as `null` — would print `NULL` for data that was
 * never NULL, and a renderer that invents a SQL NULL is worse than one that says
 * the row was malformed.
 */
export type CellDisplay = "null" | "empty" | "whitespace" | "missing" | "value";

export interface CellView {
  /** The text to paint. `""` for `null`, `empty` and `missing` (the chip/marker is
   *  the renderer's job — see `console.css`). */
  text: string;
  display: CellDisplay;
  /** Numbers right-align; everything else reads left. */
  align: "left" | "right";
  /** The `title` tooltip: the full value, or a description of the absent one. */
  title: string;
  /** True when `text` is a one-line reduction of a multi-line value, so the cell can
   *  mark itself rather than silently showing only the first line. */
  collapsed: boolean;
}

const WHITESPACE_ONLY = /^\s+$/;
const NEWLINES = /\r\n|\r|\n/g;
const WHITESPACE_RUN = /\s+/g;

/** Numbers right-align. Chosen from the column kind, never from the value. */
function alignFor(kind: DbCellKind): "left" | "right" {
  return kind === "number" ? "right" : "left";
}

/**
 * Fold a value onto one line for a fixed-height cell.
 *
 * `json` collapses every whitespace *run* (pretty-printed JSON is mostly
 * indentation, and one-line-compact is the cell's contract); every other kind
 * collapses newlines only, because squeezing the runs inside a `text` value would
 * change what the data looks like for no benefit. `datetime` therefore passes
 * through byte-for-byte, as the text protocol requires ("no client reformatting, ever").
 */
function oneLine(value: string, kind: DbCellKind): string {
  return kind === "json"
    ? value.replace(WHITESPACE_RUN, " ").trim()
    : value.replace(NEWLINES, " ");
}

function titleOf(value: string): string {
  return value.length > MAX_TITLE_CHARS ? `${value.slice(0, MAX_TITLE_CHARS)}…` : value;
}

/**
 * How one cell renders. The single place the NULL / empty / whitespace distinction
 * is decided, so it can be asserted once and trusted everywhere.
 */
export function renderCell(value: string | null | undefined, kind: DbCellKind): CellView {
  const align = alignFor(kind);
  if (value === undefined) {
    return {
      text: "",
      display: "missing",
      align,
      title: "No value — this row is shorter than the column list.",
      collapsed: false,
    };
  }
  if (value === null) {
    return { text: "", display: "null", align, title: "SQL NULL", collapsed: false };
  }
  if (value === "") {
    return { text: "", display: "empty", align, title: "Empty string", collapsed: false };
  }
  const text = oneLine(value, kind);
  const collapsed = text !== value;
  if (WHITESPACE_ONLY.test(value)) {
    const n = value.length;
    return {
      text,
      display: "whitespace",
      align,
      title: `Whitespace only (${n} ${n === 1 ? "character" : "characters"})`,
      collapsed,
    };
  }
  return { text, display: "value", align, title: titleOf(value), collapsed };
}

/* ───────────────────────────── result summaries ────────────────────────────── */

/** `12 ms` / `1.20 s`. Sub-second stays in ms because that is the interesting range. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The one-line header for a statement's outcome.
 *
 * A truncated result never gets a plain count: "500 rows" beside a result that was
 * cut is the specific lie this feature is built to avoid, so the count is phrased
 * "first 500 rows of more" and the loud strip above the grid says it again.
 */
export function resultSummary(result: DbResultSet): string {
  const duration = formatDuration(result.durationMs);
  if (result.kind === "rows") {
    const n = result.rows.length;
    if (result.truncated) return `first ${n} rows of more · ${duration}`;
    return `${n} ${n === 1 ? "row" : "rows"} · ${duration}`;
  }
  if (result.kind === "affected") {
    const n = result.rowsAffected;
    if (n === null) return `Done · ${duration}`;
    return `${n} ${n === 1 ? "row" : "rows"} affected · ${duration}`;
  }
  return `Message · ${duration}`;
}

/**
 * The persistent truncation strip, or null.
 *
 * Reads `truncated` — the *measured* signal (the backend read cap+1 and saw
 * the extra row). It deliberately does not compare `rows.length` with `rowLimit`,
 * because a table holding exactly `rowLimit` rows is the honest case and warning
 * about it would teach the user to ignore the warning.
 *
 * The wording is engine-neutral on purpose: an earlier draft ended "…or add a LIMIT
 * to the query", which means nothing to the Redis or MongoDB console.
 */
export function truncationNotice(result: DbResultSet): string | null {
  if (!result.truncated) return null;
  return (
    `Showing the first ${result.rows.length} rows of more — the row limit ` +
    `(${result.rowLimit}) cut this result. Raise the limit or narrow the query.`
  );
}

/**
 * The text of a `kind: "message"` result.
 *
 * ⚠️ `DbResultSet` has no field for this other than `notice`, so `notice` is doing
 * double duty: a Postgres NOTICE and a statement's *error* text arrive in the same
 * slot with nothing to tell them apart. The console
 * therefore presents every message in one neutral tone — inferring "this one is an
 * error" from its wording would be exactly the value-sniffing rule 2 forbids.
 */
export function messageBody(result: DbResultSet): string {
  const notice = result.notice;
  if (notice === null || notice.trim() === "") return "The server returned a message with no text.";
  return notice;
}

/* ─────────────────────────────── error sentences ───────────────────────────── */

/**
 * Deliberately NOT here. `../dbErrors.ts` is the one place a database failure becomes a
 * sentence a person can read, and it is what the store already calls.
 *
 * This module carried a second copy — written in parallel, before that module existed — with
 * its own `ERROR_SENTENCES` table. Two sentence tables for one error union is exactly the
 * kind of duplication that drifts invisibly: each half keeps its own tests green while the
 * two disagree about what an `auth` failure says. `DbConsole` imports `describeDbError` from
 * `../dbErrors`; the copy that used to live here is gone rather than deprecated.
 */

/* ────────────────────────────── the guard badge ────────────────────────────── */

export interface GuardBadge {
  label: string;
  /** `safe` = a real server boundary; `warn` = our own filter; `danger` = writes on. */
  tone: "safe" | "warn" | "danger";
  /** The hover explanation of what the badge means. */
  title: string;
  /**
   * The sentence the toolbar must print beside the badge, or null when the badge
   * needs no qualification. Non-null exactly when the badge would otherwise imply a
   * promise the engine cannot keep — that is the whole reason it is a field
   * here and not a `readOnly && !serverEnforced &&` in a component.
   */
  caveat: string | null;
}

/**
 * What to show for this connection's read-only state.
 *
 * Three states, not two: read-only *enforced by the server* (Postgres, MySQL,
 * ClickHouse), read-only *enforced by this app* (Mongo, Redis — a command-name
 * allowlist), and writes enabled. The middle one is the reason this function
 * exists: the rule is that "a control which pretends to be stronger than it is,
 * is worse than no control".
 */
export function readOnlyBadge(readOnly: boolean, serverEnforcedReadOnly: boolean): GuardBadge {
  if (!readOnly) {
    return {
      label: "writes enabled",
      tone: "danger",
      title: "This connection can modify data and schema.",
      caveat: "Writes and DDL will run against this database.",
    };
  }
  if (serverEnforcedReadOnly) {
    return {
      label: "read-only",
      tone: "safe",
      title:
        "Enforced by the server: a write or DDL fails at the engine, not in this app. " +
        "Statements that would switch this session back to read-write are refused before " +
        "they are sent.",
      caveat: null,
    };
  }
  return {
    label: "read-only (enforced by this app)",
    tone: "warn",
    title: "This engine has no server-side read-only mode.",
    caveat:
      "Read-only is a client-side speed bump on this engine, not a guarantee — " +
      "connect with a read-only database user for a real boundary.",
  };
}

/* ──────────────────────────── the editor's language ───────────────────────── */

/**
 * The Shiki grammar id for a console's language, or null for no highlighting.
 *
 * Colour comes from the Shiki → CM6 decoration path the file editor already uses
 * (Shiki, not a second highlighter), so the console's SQL is *the same colours* as a `.sql` file and
 * no new dependency is involved. Redis is null: Shiki ships no `redis` grammar
 * (checked — `'redis' in bundledLanguages` is false), and borrowing `bash` would
 * colour `#` as a comment in a protocol that has no comments. Plaintext that is
 * honest beats colour that is wrong.
 */
export function shikiIdFor(queryLanguage: "sql" | "json" | "commandline"): string | null {
  if (queryLanguage === "sql") return "sql";
  if (queryLanguage === "json") return "json";
  return null;
}

/**
 * The keywords that can *open* a SQL statement, and the reason this is a leading-token
 * test rather than a search.
 *
 * Restricted to statement openers on purpose: `from`, `where` and `limit` appear in SQL
 * too, but a buffer that *begins* with `where` is not a statement anyone is writing, and
 * `{"where": …}` is a perfectly ordinary Mongo filter key. Only a word that can legally
 * start a statement is evidence about the buffer as a whole.
 *
 * `\b` and not `\s`: `select*from t` has no space after the keyword and is still SQL,
 * while `selection` must not be — a bare `startsWith` would call the second one SQL.
 */
const LEADING_SQL =
  /^(?:select|insert|update|delete|with|show|describe|explain|create|drop|alter|truncate)\b/i;

/**
 * Skip leading whitespace and leading SQL comments, and return what is left.
 *
 * Comments matter because a pasted query very often arrives with a `-- what this does`
 * header, and a buffer whose first two characters are `--` would otherwise never be
 * recognised. An *unterminated* comment consumes the rest of the buffer and yields `""`,
 * which is the honest answer: there is no first token yet.
 */
function firstMeaningfulText(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      if (newline === -1) return "";
      rest = trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close === -1) return "";
      rest = trimmed.slice(close + 2);
      continue;
    }
    return trimmed;
  }
}

/**
 * The Shiki grammar id for what is **actually in the buffer**, falling back to the
 * engine's own language.
 *
 * 🔴 Reserved words used to go unhighlighted when
 * `select * from ARCHIVEDB.temp_playlists LIMIT 10;` was typed into a MongoDB
 * console, whose {@link shikiIdFor} language is `json` — so the SQL keywords got no
 * keyword colour at all. Picking the grammar from the engine alone is wrong the moment
 * SQL is a real input to a non-SQL engine, which is exactly what the Mongo console accepts
 * (SQL→command translation in `sqlmongo.rs`).
 *
 * **Only the leading token decides**, and that is the whole design. A command document
 * whose *values* mention SQL — `{"find": "t", "filter": {"note": "select * from x"}}` —
 * is JSON, and colouring it as SQL because the word appears somewhere inside would be
 * the value-sniffing rule 2 forbids. Conversely a buffer that *opens* with `select` is SQL
 * whatever the engine thinks: colouring it as SQL is honest even when the engine will go
 * on to refuse it, because the grammar describes the text, not the outcome.
 *
 * An empty (or comment-only) buffer keeps the engine's default, so a fresh console still
 * looks like the console for its engine.
 */
export function shikiIdForText(
  queryLanguage: "sql" | "json" | "commandline",
  text: string,
): string | null {
  if (LEADING_SQL.test(firstMeaningfulText(text))) return "sql";
  return shikiIdFor(queryLanguage);
}

/**
 * The ghost text an empty console shows: **what this engine expects, by example**.
 *
 * 🔴 The failure this prevents: `select * from temp_playlists limit 10;` typed into a MongoDB
 * console. The engine's own error message explains *that* run (see `dbErrors.ts`), but the
 * deeper problem is upstream: without an example nothing tells the user the console wants a
 * JSON command document, and an empty editor in a tab named after a database invites SQL.
 *
 * An example rather than a description, because `{"find": …}` teaches the shape in a way that "a
 * MongoDB command document" does not. And a *placeholder* rather than seeded buffer text: seeded
 * text is real text, and ⌘⏎ would then run a statement the user never wrote.
 */
export function placeholderFor(queryLanguage: "sql" | "json" | "commandline"): string {
  if (queryLanguage === "sql") return "SELECT * FROM table_name LIMIT 100;";
  // The command name is the FIRST key — the one thing a Mongo user has to get right, and the
  // reason this example is a whole document rather than a fragment.
  if (queryLanguage === "json") return '{"find": "collection_name", "limit": 10}';
  return "GET key_name";
}

/**
 * What ⌘⏎ means in this console — the Run button's tooltip and the empty-state hint.
 *
 * 🔴 The `sql` line used to read *"Runs the statement under the cursor."*
 * and **nothing computed that** — the store sent the whole buffer, and a buffer with two
 * statements came back refused. The sentence was a promise the product had never kept, which is
 * worse than a missing hint: the user reads it, believes it, and blames the database.
 *
 * Every line now names the selection first, because that is the gesture people reach for
 * (select one statement and run it) and it behaves identically on every engine.
 * These strings are pinned literally in `consoleFormat.test.ts` — if the behaviour in
 * `statements.ts::textToRun` changes, this text has to change with it.
 */
export function runHint(queryLanguage: "sql" | "json" | "commandline"): string {
  if (queryLanguage === "sql") return "Runs the selection, or the statement under the cursor.";
  if (queryLanguage === "json") return "Runs the selection, or the whole command document.";
  return "Runs the selection, or the line under the cursor.";
}

/* ──────────────────────────────── windowing ────────────────────────────────── */

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Spacer height above the rendered rows, px. */
  padTop: number;
  /** Spacer height below the rendered rows, px. */
  padBottom: number;
}

/**
 * Which rows to render for a scroll position — the whole of our virtualisation,
 * with no new dependency.
 *
 * The invariant that makes the scrollbar honest:
 *   `padTop + (end - start) * rowHeight + padBottom === totalRows * rowHeight`
 * so the scroll container is always exactly as tall as the full result, whatever
 * slice of it is in the DOM. Property-tested, because an off-by-one here shows up
 * as a scrollbar that lies rather than as an exception.
 */
export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalRows: number,
  overscan: number = ROW_OVERSCAN,
): RowWindow {
  if (totalRows <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const viewport = Math.max(viewportHeight, 0);
  const maxScroll = Math.max(totalRows * rowHeight - viewport, 0);
  const top = Math.min(Math.max(scrollTop, 0), maxScroll);
  const first = Math.floor(top / rowHeight);
  // +1 so a viewport that straddles two rows still paints the partial one.
  const spans = Math.ceil(viewport / rowHeight) + 1;
  const start = Math.max(first - overscan, 0);
  const end = Math.min(first + spans + overscan, totalRows);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (totalRows - end) * rowHeight,
  };
}

/**
 * Column widths in `ch`, from the header plus the first `sample` rows.
 *
 * Sampling rather than measuring every row is what keeps a 100 000-row result from
 * costing a full pass before the first paint; the cost is that a very wide value
 * far down the result clips instead of widening its column, which is the right
 * track for a grid whose cells are one line by design.
 */
export function columnWidthsCh(
  columns: DbColumn[],
  rows: Array<Array<string | null>>,
  sample: number = WIDTH_SAMPLE_ROWS,
): number[] {
  const seen = Math.min(rows.length, sample);
  return columns.map((column, c) => {
    // The header stacks name over typeName, so both must fit.
    let longest = Math.max(column.name.length, column.typeName.length);
    for (let r = 0; r < seen; r += 1) {
      const cell = renderCell(rows[r][c], column.kind);
      // A NULL chip is four glyphs wide even though `text` is empty.
      const length = cell.display === "null" ? 4 : cell.text.length;
      if (length > longest) longest = length;
    }
    return Math.min(MAX_COL_CH, Math.max(MIN_COL_CH, longest + 2));
  });
}
