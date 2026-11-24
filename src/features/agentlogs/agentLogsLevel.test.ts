/**
 * `classifyLine` — the level table. Every expectation is written out by
 * hand, never derived from the regexes under test. The rows are Rust's own
 * tables in `logstream/level.rs` (`the_level_table`, `the_structured_level_column_table`),
 * copied line for line so the two cannot quietly drift, plus the cases where the regex
 * DIALECTS differ (Unicode `\b` / `\d` / `\s`) — the ones a naive port gets wrong. The
 * golden agreement over Rust's generated case list is `src/test/contract/level.contract.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { classifyLine } from "./agentLogsLevel";
import type { LogLevel } from "./agentLogsTypes";

const check = (table: ReadonlyArray<readonly [string, LogLevel]>) => {
  for (const [line, want] of table) expect(classifyLine(line), JSON.stringify(line)).toBe(want);
};

describe("classifyLine — Rust's `the_level_table`", () => {
  it("os_log compact: the type column wins over a keyword, in both directions", () => {
    check([
      ["2026-01-01 12:00:00.250 E  Demo[1234:5678] [com.app:net] request failed", "error"],
      ["2026-01-01 12:00:00.250 Df Demo[1234:5678] [com.app:ui] layout pass", "debug"],
      ["2026-01-01 12:00:00.250 Df Demo[1234:5678] retrying after error", "debug"],
      ["2026-01-01 12:00:00.250 I  Demo[1234:5678] all good", "info"],
      ["2026-01-01 12:00:00.250 F  Demo[1234:5678] fault", "error"],
      ["2026-01-01 12:00:00.250 Db Demo[1234:5678] noise", "debug"],
      ["2026-01-01 12:00:00.250-0700 E  Demo[1:2] tz offset form", "error"],
      ["2026-01-01 12:00:00.250 Fa Demo[1:2] fault, two letters", "error"],
      ["2026-01-01 12:00:00.250 D  Demo[1:2] debug, one letter", "debug"],
      ["2026-01-01 12:00:00.250 A  Demo[1:2] activity, with an error word", "info"],
    ]);
  });

  it("keywords, whole words only", () => {
    check([
      ["error[E0308]: mismatched types", "error"],
      ["Error: ENOENT: no such file", "error"],
      ["thread 'main' panicked at src/lib.rs:1:1", "error"],
      ["Traceback (most recent call last):", "error"],
      ["test result: FAILED. 1 passed; 2 failed", "error"],
      ["✗ 3 tests failed", "error"],
      ["FATAL: role does not exist", "error"],
      ["warning: unused variable `x`", "warn"],
      ["npm WARN deprecated left-pad@1.0.0", "warn"],
      ["DeprecationWarning is not a whole word", "info"],
      ["[DEBUG] connecting", "debug"],
      ["TRACE hyper::proto", "debug"],
      // Mid-line, so no level COLUMN claims them first — only the keyword rule can.
      ["now with DEBUG logging on", "debug"],
      ["set RUST_LOG to TRACE please", "debug"],
      ["errorless run, terrors none", "info"],
      ["forewarned", "info"],
      ["Compiling agentstudio v0.1.0", "info"],
      ["", "info"],
      ["2026-01-01 12:00:00 E no millis so not compact", "info"],
    ]);
  });
});

describe("classifyLine — Rust's `the_structured_level_column_table`", () => {
  it("a structured logger's level column wins over a keyword in its message", () => {
    check([
      ["2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080", "info"],
      ["2026-01-01T12:00:05.152Z  INFO gazelle::retry: recovered from error after 2 attempts", "info"],
      ["2026-01-01T12:00:05.152345Z  WARN gazelle::db: pool at 90%", "warn"],
      ["2026-01-01T12:00:05.152Z ERROR gazelle: upstream closed the connection", "error"],
      ["2026-01-01T12:00:05.152Z DEBUG hyper::proto::h1: flushed 212 bytes", "debug"],
      ["2026-01-01T12:00:05.152Z TRACE gazelle: tick, no error", "debug"],
      ["[2026-01-01 12:00:05 WARN foo] disk slow", "warn"],
      ["[2026-01-01T12:00:05Z INFO  gazelle] fatal flag is off", "info"],
      ["[2026-01-01T12:00:05Z ERROR gazelle::api] 500 on /health", "error"],
      ["2026-01-01 12:00:05,152 WARNING root: low memory", "warn"],
      ["2026-01-01T12:00:05-05:00 INFO svc: tick 1", "info"],
      ["INFO gazelle: started, error budget 0", "info"],
      ["WARN gazelle: slow query", "warn"],
      ['ERROR: relation "users" does not exist', "error"],
      ["INF server started port=8080", "info"],
      ["WRN retrying", "warn"],
      ['time=2026-01-01T12:00:05Z level=error msg="db down"', "error"],
      ['ts=1 level=info msg="error count reset"', "info"],
      ["level=WARN msg=x", "warn"],
      ['{"level":"debug","msg":"panic handler installed"}', "debug"],
      ['{"ts":1,"level": "error","msg":"boom"}', "error"],
      ["INFORMATION about the build", "info"],
      ["ERRORS: 0", "info"],
      ["the INFO panel shows an error", "error"],
      ["releveled=error", "error"],
    ]);
  });

  it("every token maps to its level (one row per token, so a swapped arm is caught)", () => {
    check([
      ["ERRO x", "error"],
      ["ERR x", "error"],
      ["CRITICAL x", "error"],
      ["CRIT x", "error"],
      ["PANIC x", "error"],
      ["NOTICE x with an error", "info"],
      ["DBG x", "debug"],
      ["TRC x", "debug"],
      ["level=fatal", "error"],
      ["level=panic", "error"],
      ["level=warning", "warn"],
      ["level=notice error", "info"],
      ["level=trace", "debug"],
      ["level=Err", "error"],
    ]);
  });
});

describe("classifyLine — where the regex dialects differ (Rust is Unicode-aware)", () => {
  it("`\\b` is a UNICODE word boundary: a letter like é glued to a keyword makes it no word", () => {
    check([
      ["éerror in a word", "info"],
      ["errorñ", "info"],
      ["ошибка error", "error"],
      ["日本error", "info"],
      ["a·error", "error"], // · (U+00B7) is not Alphabetic in Rust's \w — a boundary
      ["niveaulevel=error", "error"], // no key; the keyword still hits
      ["ölevel=info but error", "error"], // `level=` glued to a letter is not a key
    ]);
  });

  it("`\\d` is any Nd digit and `\\s` is White_Space — both halves of a compact prefix", () => {
    check([
      ["٢٠٢٦-٠١-٠١ ١٢:٠٠:٠٠.٢٥٠ E  proc[1:2] Arabic-Indic digits", "error"],
      ["2026-01-01 12:00:00.250\u00a0E\u00a0 proc[1:2] no-break spaces", "error"],
      ["2026-01-01 12:00:00.250\u0085E proc next-line (NEL) is White_Space", "error"],
      ["2026-01-01 12:00:00.250\ufeffE proc BOM is not White_Space", "info"],
      ["\u2003INFO gazelle: an em-space leads, error", "info"],
    ]);
  });
});
