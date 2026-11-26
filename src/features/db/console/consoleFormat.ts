/** How the console says things, as pure DOM-free functions. Rules: null, "" and whitespace stay
 * distinct (renderCell returns a display kind); kind drives rendering, never the value; truncation
 * is read from truncated, never inferred; a guard badge states how strong it is. */

import type { DbCellKind, DbColumn,  DbResultSet } from "../types";

/* ────────────────────────────── layout constants ───────────────────────────── */

/** Fixed, so windowing is arithmetic and a cell stays one line. Published as --db-row-h so the
 * CSS and the windowing maths agree. */
export const ROW_HEIGHT_PX = 24;

/** Assumed until measured (jsdom's clientHeight is always 0), so the unit tier renders a
 * screenful rather than an overscan-sized accident. */
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

/** Drag clamp in px (pointer units; ch would need a font measurement jsdom can't check). The 28px
 * floor keeps the handle findable. */
export const MIN_COL_PX = 28;
export const MAX_COL_PX = 1600;
export const COL_RESIZE_STEP_PX = 16;

/** Absorbs non-finite input: a NaN <col> width silently falls back to auto. */
export function clampColumnPx(px: number): number {
  if (!Number.isFinite(px)) return MIN_COL_PX;
  return Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px)));
}

/** A cell can hold a megabyte of JSON: nobody reads that in a tooltip, and it costs DOM memory. */
const MAX_TITLE_CHARS = 500;

/** Absorbs non-finite input: a NaN flex-grow silently collapses a pane. */
export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction));
}

/* ────────────────────────────────── cells ──────────────────────────────────── */

/** missing means the row was shorter than the column list (a contract breach); showing NULL there
 * would invent data. */
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

/** json collapses whitespace runs; other kinds only newlines, so datetime passes through
 * byte-for-byte (the text protocol forbids reformatting). */
function oneLine(value: string, kind: DbCellKind): string {
  return kind === "json"
    ? value.replace(WHITESPACE_RUN, " ").trim()
    : value.replace(NEWLINES, " ");
}

function titleOf(value: string): string {
  return value.length > MAX_TITLE_CHARS ? `${value.slice(0, MAX_TITLE_CHARS)}…` : value;
}

/** The single place the NULL / empty / whitespace distinction is decided. */
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

/** A truncated result never gets a plain count: it reads "first 500 rows of more". */
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

/** Reads the measured truncated flag, never rows.length === rowLimit (exactly at the limit is
 * honest). Engine-neutral wording: "add a LIMIT" means nothing to Redis or Mongo. */
export function truncationNotice(result: DbResultSet): string | null {
  if (!result.truncated) return null;
  return (
    `Showing the first ${result.rows.length} rows of more — the row limit ` +
    `(${result.rowLimit}) cut this result. Raise the limit or narrow the query.`
  );
}

/** notice carries both NOTICEs and statement errors, indistinguishable, so every message gets one
 * neutral tone (no value-sniffing). */
export function messageBody(result: DbResultSet): string {
  const notice = result.notice;
  if (notice === null || notice.trim() === "") return "The server returned a message with no text.";
  return notice;
}

/* ─────────────────────────────── error sentences ───────────────────────────── */

/** Error sentences live only in ../dbErrors.ts: a second table here would drift. */

/* ────────────────────────────── the guard badge ────────────────────────────── */

export interface GuardBadge {
  label: string;
  /** `safe` = a real server boundary; `warn` = our own filter; `danger` = writes on. */
  tone: "safe" | "warn" | "danger";
  /** The hover explanation of what the badge means. */
  title: string;
  /** Non-null exactly when the badge would imply a promise the engine can't keep; a field, so no
   * component can drop it. */
  caveat: string | null;
}

/** Three states: read-only by the server (Postgres, MySQL, ClickHouse), by this app (Mongo, Redis:
 * a command allowlist, so it carries a caveat), or writes enabled. */
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

/** Redis is null: Shiki has no redis grammar, and bash would colour "#" as a comment. */
export function shikiIdFor(queryLanguage: "sql" | "json" | "commandline"): string | null {
  if (queryLanguage === "sql") return "sql";
  if (queryLanguage === "json") return "json";
  return null;
}

/** Statement openers only: a buffer starting with "where" is likely a Mongo filter key. \b, not
 * \s, so "select*from" is SQL and "selection" is not. */
const LEADING_SQL =
  /^(?:select|insert|update|delete|with|show|describe|explain|create|drop|alter|truncate)\b/i;

/** Skips leading whitespace and SQL comments (pastes often open with "--"). An unterminated
 * comment yields "": there is no first token yet. */
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

/** Only the leading token decides: a buffer opening with select is SQL whatever the engine (Mongo
 * takes SQL via sqlmongo.rs), while SQL inside JSON values stays JSON. Empty keeps the engine's
 * default. */
export function shikiIdForText(
  queryLanguage: "sql" | "json" | "commandline",
  text: string,
): string | null {
  if (LEADING_SQL.test(firstMeaningfulText(text))) return "sql";
  return shikiIdFor(queryLanguage);
}

/** An example teaches the expected shape (Mongo wants a command document). A placeholder, never
 * seeded text: ⌘⏎ would run it. */
export function placeholderFor(queryLanguage: "sql" | "json" | "commandline"): string {
  if (queryLanguage === "sql") return "SELECT * FROM table_name LIMIT 100;";
  // The command name is the FIRST key — the one thing a Mongo user has to get right, and the
  // reason this example is a whole document rather than a fragment.
  if (queryLanguage === "json") return '{"find": "collection_name", "limit": 10}';
  return "GET key_name";
}

/** The Run tooltip and empty-state hint, naming the selection first. Must match
 * statements.ts::textToRun; pinned literally in consoleFormat.test.ts. */
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

/** Virtualisation without a dependency. Property-tested invariant, so the scrollbar never lies:
 * padTop + (end - start) * rowHeight + padBottom === totalRows * rowHeight. */
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

/** Sampled rather than measured over every row, so a huge result paints fast; a wide value far
 * down clips instead of widening its column. */
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
