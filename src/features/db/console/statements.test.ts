/**
 * `statements.ts` tests — the frontend mirror of `guard.rs`'s splitter.
 *
 * ── Where these cases come from ──────────────────────────────────────────────
 * The lexical cases are **`guard.rs`'s own tests, ported**, deliberately and one for one:
 * `a_semicolon_inside_a_string_literal_is_not_a_terminator`,
 * `a_semicolon_inside_a_quoted_identifier_or_dollar_quote_is_not_a_terminator`, and the
 * trailing-comment case. Two implementations of one grammar in two languages will drift, and
 * the only defence available is that they answer the same questions with the same answers. If a
 * case here is changed, change it in `src-tauri/src/db/guard.rs` too — and vice versa.
 *
 * Every expectation is a literal: nothing here computes an expected value from
 * the code under test, so a wrong answer is a red test rather than a matching pair of wrongs.
 */

import { describe, expect, it } from "vitest";

import {
  lineAtOffset,
  splitStatements,
  statementAtOffset,
  textToRun,
  type SqlStatement,
} from "./statements";

/** Just the texts — for the many cases where the ranges are not the claim. */
const texts = (input: string): string[] => splitStatements(input).map((s) => s.text);

/**
 * A sample buffer with mixed keyword case.
 * Line 2's `FRom` is part of it. Lines 3 and 4 are commented out, each ending in a `;` that a
 * naive splitter counts as a terminator.
 */
const SAMPLE_BUFFER = [
  "SELECT * FROM widgets;",
  "SELECT * FRom booking;",
  "--SELECT * from op_history;",
  "--select * from staff_accounts;",
].join("\n");

/* ══════════════════════════ splitting ══════════════════════════════════════ */

describe("splitStatements — the shape of the answer", () => {
  it("returns each statement trimmed, with a range that slices back to itself", () => {
    const input = "  SELECT 1 ;\n\n  SELECT 2  ";
    expect(splitStatements(input)).toEqual<SqlStatement[]>([
      { text: "SELECT 1", from: 2, to: 10 },
      { text: "SELECT 2", from: 16, to: 24 },
    ]);
    // The invariant every caller depends on: the range names the text.
    for (const s of splitStatements(input)) expect(input.slice(s.from, s.to)).toBe(s.text);
  });

  it("treats a trailing semicolon as optional", () => {
    expect(texts("SELECT 1")).toEqual(["SELECT 1"]);
    expect(texts("SELECT 1;")).toEqual(["SELECT 1"]);
    expect(texts("  SELECT 1 ;  \n")).toEqual(["SELECT 1"]);
  });

  it("finds no statements at all in an empty, blank or semicolon-only buffer", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n\t ")).toEqual([]);
    expect(splitStatements(";;;")).toEqual([]);
  });

  it("drops a comment-only fragment, so a script ending in `-- done` is not multi-statement", () => {
    expect(texts("SELECT 1;\n-- done")).toEqual(["SELECT 1"]);
    expect(texts("SELECT 1;\n/* done */")).toEqual(["SELECT 1"]);
    // Nested, and spread over the whitespace between two comments — both arms of
    // `is_only_comments` at once.
    expect(texts("SELECT 1;\n/* a /* b */ c */\n-- and\n")).toEqual(["SELECT 1"]);
    // A comment-only buffer holds nothing to run.
    expect(splitStatements("-- just a note\n")).toEqual([]);
  });

  it("keeps comments that are INSIDE a statement, verbatim", () => {
    // The statement is echoed next to its result; rewriting the user's SQL would be a lie.
    expect(texts("SELECT 1 -- why\n + 2;")).toEqual(["SELECT 1 -- why\n + 2"]);
    expect(texts("SELECT /* a */ 1;")).toEqual(["SELECT /* a */ 1"]);
  });
});

describe("splitStatements — a `;` that is not a terminator", () => {
  it("🔴 does not split inside a single-quoted string literal", () => {
    // THE case a naive `split(';')` gets wrong — and it does not merely miscount, it sends
    // `SELECT '` to the server. Two statements here, never three.
    expect(texts("SELECT ';' FROM t; SELECT 2;")).toEqual(["SELECT ';' FROM t", "SELECT 2"]);
    expect(texts("SELECT 'a;b' AS x")).toEqual(["SELECT 'a;b' AS x"]);
    // `''` doubling: the quote is escaped, so the literal continues past it.
    expect(texts("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"]);
  });

  it("honours backslash escapes only in an E'…' literal", () => {
    expect(texts(String.raw`SELECT E'a\';b'`)).toEqual([String.raw`SELECT E'a\';b'`]);
    // Lower-case `e` is the same escape string; Postgres accepts both spellings.
    expect(texts(String.raw`SELECT e'a\';b'`)).toEqual([String.raw`SELECT e'a\';b'`]);
    // Without the E prefix a backslash is an ordinary character, so `\'` CLOSES the literal
    // and the `;` after it really is a terminator.
    expect(texts(String.raw`SELECT 'a\'; SELECT 2`)).toEqual([
      String.raw`SELECT 'a\'`,
      "SELECT 2",
    ]);
  });

  it("does not split inside a `--` line comment", () => {
    expect(texts("SELECT 1 -- a; b\n;SELECT 2")).toEqual(["SELECT 1 -- a; b", "SELECT 2"]);
    // The sample buffer's lines 3–4 are exactly this: a `;` inside a `--` comment.
    expect(texts("--SELECT * from op_history;")).toEqual([]);
  });

  it("does not split inside a block comment, and counts NESTING", () => {
    expect(texts("SELECT 1 /* a; b */ + 2;")).toEqual(["SELECT 1 /* a; b */ + 2"]);
    // The nesting claim: the inner `*/` closes only the inner level, so the `;` between the
    // two closers is still commented out. A non-nesting lexer splits here and is wrong.
    expect(texts("SELECT 1 /* a /* b */ ; c */ + 2;")).toEqual([
      "SELECT 1 /* a /* b */ ; c */ + 2",
    ]);
  });

  it("does not split inside a quoted identifier", () => {
    expect(texts('SELECT 1 AS "a;b"')).toEqual(['SELECT 1 AS "a;b"']);
    // `""` doubling, the identifier equivalent of `''`.
    expect(texts('SELECT 1 AS "a""b;c"')).toEqual(['SELECT 1 AS "a""b;c"']);
  });

  it("does not split inside a dollar-quoted body", () => {
    expect(texts("SELECT $$a;b$$")).toEqual(["SELECT $$a;b$$"]);
    expect(texts("SELECT $tag$a;b$tag$")).toEqual(["SELECT $tag$a;b$tag$"]);
    // A function body — the realistic reason dollar quoting matters at all. Every `;` in it
    // is part of one statement.
    const body = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
    expect(texts(body)).toEqual([body]);
  });

  it("treats `$1` as a placeholder and a bare `$` as itself, not as a quote opener", () => {
    // If `$1` opened a quote, everything after it would be swallowed and the `;` lost.
    expect(texts("SELECT $1; SELECT $2")).toEqual(["SELECT $1", "SELECT $2"]);
    expect(texts("SELECT 1 $; SELECT 2")).toEqual(["SELECT 1 $", "SELECT 2"]);
  });

  it("survives every unterminated form rather than looping or throwing", () => {
    // A half-typed buffer is the NORMAL state of a console. Each of these ends mid-token.
    expect(texts("SELECT 'a;b")).toEqual(["SELECT 'a;b"]);
    expect(texts('SELECT "a;b')).toEqual(['SELECT "a;b']);
    expect(texts("SELECT $$a;b")).toEqual(["SELECT $$a;b"]);
    expect(texts("SELECT 1 /* a;b")).toEqual(["SELECT 1 /* a;b"]);
    expect(texts("SELECT 1 -- a;b")).toEqual(["SELECT 1 -- a;b"]);
  });

  it("does not mistake ordinary arithmetic for a comment", () => {
    // A lone `-` and a lone `/` must fall through to the default arm, or `a - b` would
    // comment out the rest of the line.
    expect(texts("SELECT a - b; SELECT c / d")).toEqual(["SELECT a - b", "SELECT c / d"]);
  });

  it("🔴 splits the sample buffer into exactly TWO statements", () => {
    expect(texts(SAMPLE_BUFFER)).toEqual(["SELECT * FROM widgets", "SELECT * FRom booking"]);
  });
});

/* ══════════════════════════ the caret ══════════════════════════════════════ */

describe("statementAtOffset", () => {
  it("🔴 answers line 1 for a caret on line 1, and line 2 for a caret on line 2", () => {
    expect(statementAtOffset(SAMPLE_BUFFER, 5)?.text).toBe("SELECT * FROM widgets");
    expect(statementAtOffset(SAMPLE_BUFFER, SAMPLE_BUFFER.indexOf("FRom"))?.text).toBe(
      "SELECT * FRom booking",
    );
  });

  it("counts the caret at either END of a statement as inside it", () => {
    const input = "SELECT 1;SELECT 2";
    // 8 is the `;` — the end of statement 1, where the caret sits after typing it.
    expect(statementAtOffset(input, 8)?.text).toBe("SELECT 1");
    expect(statementAtOffset(input, 9)?.text).toBe("SELECT 2");
    expect(statementAtOffset(input, 0)?.text).toBe("SELECT 1");
  });

  it("falls back to the PRECEDING statement when the caret is in trailing space", () => {
    const input = "SELECT 1;\n\nSELECT 2;\n\n";
    // The blank line after statement 1 belongs to statement 1: a caret at the end of a line
    // is where a user leaves it far more often than mid-token.
    expect(statementAtOffset(input, 10)?.text).toBe("SELECT 1");
    // Past everything — the trailing blank lines.
    expect(statementAtOffset(input, input.length)?.text).toBe("SELECT 2");
    // And a caret parked in the commented-out tail gets the last real statement,
    // never the whole buffer.
    expect(statementAtOffset(SAMPLE_BUFFER, SAMPLE_BUFFER.length)?.text).toBe(
      "SELECT * FRom booking",
    );
  });

  it("gives the FIRST statement to a caret that sits before all of them", () => {
    // Only whitespace can precede the first statement: a leading COMMENT is part of it,
    // because `pushTrimmed` trims whitespace and drops comment-only fragments — it never
    // strips a comment off the front of real SQL. Mirrors `guard.rs` exactly.
    expect(statementAtOffset("-- a note\nSELECT 1;", 3)?.text).toBe("-- a note\nSELECT 1");
    expect(statementAtOffset("\n\n  SELECT 1;", 1)?.text).toBe("SELECT 1");
  });

  it("is null when the buffer holds no statement at all", () => {
    expect(statementAtOffset("", 0)).toBeNull();
    expect(statementAtOffset("-- nothing here\n", 4)).toBeNull();
  });

  it("clamps an offset outside the buffer instead of failing", () => {
    expect(statementAtOffset("SELECT 1;SELECT 2", -50)?.text).toBe("SELECT 1");
    expect(statementAtOffset("SELECT 1;SELECT 2", 9_000)?.text).toBe("SELECT 2");
  });
});

describe("lineAtOffset", () => {
  const doc = "GET user:1\nHGETALL session:9\nTTL user:1";

  it("returns the line the offset is on, without its break", () => {
    expect(lineAtOffset(doc, 0)).toBe("GET user:1");
    expect(lineAtOffset(doc, 10)).toBe("GET user:1"); // the newline itself: still line 1
    expect(lineAtOffset(doc, 11)).toBe("HGETALL session:9");
    expect(lineAtOffset(doc, doc.length)).toBe("TTL user:1"); // last line, no trailing break
  });

  it("handles a blank line and a one-line buffer", () => {
    expect(lineAtOffset("A\n\nB", 2)).toBe("");
    expect(lineAtOffset("HGETALL user:1", 4)).toBe("HGETALL user:1");
    expect(lineAtOffset("", 0)).toBe("");
  });

  it("clamps an offset outside the buffer", () => {
    expect(lineAtOffset(doc, -3)).toBe("GET user:1");
    expect(lineAtOffset(doc, 9_000)).toBe("TTL user:1");
  });
});

/* ══════════════════════════ what Run sends ═════════════════════════════════ */

describe("textToRun — the decision ⌘⏎ makes", () => {
  it("🔴 sends a selection verbatim, whatever it contains", () => {
    const from = SAMPLE_BUFFER.indexOf("--SELECT");
    expect(textToRun("sql", SAMPLE_BUFFER, from, SAMPLE_BUFFER.length)).toBe(
      "--SELECT * from op_history;\n--select * from staff_accounts;",
    );
    // Two whole statements selected: passed through as-is. Rust then refuses them as
    // multi-statement, which is CORRECT — that refusal is a permission, and this is a payload.
    expect(textToRun("sql", SAMPLE_BUFFER, 0, 45)).toBe(
      "SELECT * FROM widgets;\nSELECT * FRom booking;",
    );
    // Even a fragment. The user highlighted it; the editor does not second-guess it.
    expect(textToRun("sql", "SELECT * FROM widgets;", 9, 13)).toBe("FROM");
  });

  it("sends the selection on every engine family, not just sql", () => {
    expect(textToRun("json", '{"find": "t"}', 1, 7)).toBe('"find"');
    expect(textToRun("commandline", "GET a\nGET b", 6, 11)).toBe("GET b");
  });

  it("ignores a selection of nothing but whitespace", () => {
    // Honouring it would make Run a silent no-op (the store refuses a blank buffer) — a
    // button that does nothing and says nothing.
    const input = "SELECT 1;\n\n\nSELECT 2;";
    expect(textToRun("sql", input, 9, 11)).toBe("SELECT 1");
  });

  it("🔴 sends the statement under the cursor for sql, with nothing selected", () => {
    expect(textToRun("sql", SAMPLE_BUFFER, 5, 5)).toBe("SELECT * FROM widgets");
    const online2 = SAMPLE_BUFFER.indexOf("FRom");
    expect(textToRun("sql", SAMPLE_BUFFER, online2, online2)).toBe("SELECT * FRom booking");
  });

  it("sends the whole buffer for sql when there is no statement to find", () => {
    // A comment-only buffer. Handing the whole thing over lets Rust answer "There is nothing
    // to run.", which is both true and its sentence to say — better than a silent no-op.
    expect(textToRun("sql", "-- nothing\n", 4, 4)).toBe("-- nothing\n");
  });

  it("sends the caret's LINE for commandline, and the WHOLE buffer for json", () => {
    const redis = "GET user:1\nHGETALL session:9";
    expect(textToRun("commandline", redis, 13, 13)).toBe("HGETALL session:9");
    // Mongo: one command document, and there is no `;` in it to split on. The caret is deep
    // inside the object and the answer is still the whole thing.
    const mongo = '{"find": "tracks",\n "filter": {"note": "a;b"},\n "limit": 10}';
    expect(textToRun("json", mongo, 25, 25)).toBe(mongo);
    expect(textToRun("json", mongo, 0, 0)).toBe(mongo);
  });
});
