/** DbResultSet INPUTS, never expectations: tests write user-visible strings literally. TRUNCATED vs
 * AT_LIMIT pins that truncation is read, never inferred; MESSAGE_RESULT is a syntax error, which
 * arrives as a normal result, not a rejection. */

import type { DbResultSet } from "../types";

export const TRACKS_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT code, secs, note FROM tracks",
  columns: [
    { name: "code", typeName: "varchar(8)", kind: "text" },
    { name: "secs", typeName: "numeric", kind: "number" },
    { name: "note", typeName: "text", kind: "text" },
  ],
  rows: [
    ["AMB", "1240.50000", "demo"],
    // The pair this whole feature is built around: SQL NULL, then the empty string.
    ["BLU", null, ""],
    // Whitespace-only: neither NULL nor empty, and invisible unless marked.
    ["COR", "0", "   "],
  ],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 12,
  notice: null,
};

export const KINDS_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT * FROM kinds",
  columns: [
    { name: "t", typeName: "text", kind: "text" },
    { name: "n", typeName: "int8", kind: "number" },
    { name: "b", typeName: "boolean", kind: "bool" },
    { name: "j", typeName: "jsonb", kind: "json" },
    { name: "bin", typeName: "bytea", kind: "binary" },
    { name: "at", typeName: "timestamptz", kind: "datetime" },
    { name: "u", typeName: "geometry", kind: "unknown" },
  ],
  rows: [
    [
      "hello",
      "42",
      "t",
      '{\n  "a": 1\n}',
      "\\x48656c6c6f",
      "2026-07-30 09:15:00+00",
      "POINT(1 2)",
    ],
  ],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 4,
  notice: null,
};

/** 500 rows AND `truncated: true` — the backend saw the 501st row. */
export const TRUNCATED_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT id FROM events",
  columns: [{ name: "id", typeName: "bigint", kind: "number" }],
  rows: Array.from({ length: 500 }, (_, i) => [String(i + 1)]),
  rowsAffected: null,
  truncated: true,
  rowLimit: 500,
  durationMs: 88,
  notice: null,
};

/** 500 rows and `truncated: false` — a table that really holds exactly 500. */
export const AT_LIMIT_RESULT: DbResultSet = {
  ...TRUNCATED_RESULT,
  truncated: false,
};

export const EMPTY_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT code FROM tracks WHERE code = 'NOPE'",
  columns: [{ name: "code", typeName: "varchar(8)", kind: "text" }],
  rows: [],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 3,
  notice: null,
};

/** 200 columns, one row. A Mongo projection or a wide analytics table. */
export const WIDE_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT * FROM wide",
  columns: Array.from({ length: 200 }, (_, i) => ({
    name: `c${i}`,
    typeName: "text",
    kind: "text" as const,
  })),
  rows: [Array.from({ length: 200 }, (_, i) => `v${i}`)],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 7,
  notice: null,
};

/** One row of very wide values: the case where the horizontal scrollbar covered the only row. */
export const WIDGETS_RESULT: DbResultSet = {
  kind: "rows",
  statement: "SELECT * FROM widgets",
  columns: [
    { name: "id", typeName: "CHAR", kind: "text" },
    { name: "name", typeName: "TEXT", kind: "text" },
    { name: "signing_code", typeName: "TEXT", kind: "text" },
  ],
  rows: [
    [
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012",
      "Ada",
      "codeEXAMPLEkeyNotARealWidgetDoNotUseEXAMPLEkeyNotARealWidgetDoNotUseEXAMPLEkeyNotARealWidgetDoNotUseE",
    ],
  ],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 1,
  notice: null,
};

export const AFFECTED_RESULT: DbResultSet = {
  kind: "affected",
  statement: "UPDATE tracks SET note = 'x' WHERE code = 'AMB'",
  columns: [],
  rows: [],
  rowsAffected: 42,
  truncated: false,
  rowLimit: 500,
  durationMs: 5,
  notice: "1 row was skipped by a trigger.",
};

/** A message result, not a rejection: statements 1 and 2 still show rows when 3 fails. */
export const MESSAGE_RESULT: DbResultSet = {
  kind: "message",
  statement: "SELET 1",
  columns: [],
  rows: [],
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 1,
  notice: 'syntax error at or near "SELET"',
};

/** A message with nothing in it — the server said something and it was empty. */
export const BLANK_MESSAGE_RESULT: DbResultSet = {
  ...MESSAGE_RESULT,
  statement: "DO $$ BEGIN END $$",
  notice: null,
};
