/**
 * SEAM TEST — the level rule table is ONE table in two languages.
 *
 * Rust levels every stream line (`logstream::level::classify_level`); the UI levels the
 * lines INSIDE a command block's output itself (`classifyLine`, agentLogsLevel.ts). If the
 * two disagreed, one line would read W in a service's stream and I in the block that
 * tailed the same file. So a Rust test writes `goldens/level-cases.json` —
 * `[{ line, level }]`, each level computed by the real Rust function — and this test runs
 * `classifyLine` over EVERY case. A value only one side agrees on turns one side red.
 *
 * Never hand-edit the golden; regenerate it from Rust and read the diff. The file is read
 * from disk rather than imported so that its ABSENCE is a named failure, not a module
 * resolution error that hides which side owes what.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyLine } from "../../features/agentlogs/agentLogsLevel";
import type { LogLevel } from "../../features/agentlogs/agentLogsTypes";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "goldens", "level-cases.json");

interface LevelCase {
  line: string;
  level: LogLevel;
}

function loadCases(): LevelCase[] {
  if (!existsSync(GOLDEN)) {
    throw new Error(
      `level-cases.json missing — ${GOLDEN} must be written by the Rust golden test from logstream::level::classify_level`,
    );
  }
  return JSON.parse(readFileSync(GOLDEN, "utf8")) as LevelCase[];
}

describe("classifyLine agrees with Rust's classify_level on every golden case", () => {
  it("the golden exists, is non-trivial, and every level is one of the four", () => {
    const cases = loadCases();
    // A handful of rows would pass by luck; Rust's two tables alone hold 50.
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const c of cases) expect(["error", "warn", "info", "debug"], JSON.stringify(c)).toContain(c.level);
    // Every level is represented — a golden of all-`info` would agree with a classifier
    // that returns "info" for everything.
    expect(new Set(cases.map((c) => c.level))).toEqual(new Set(["error", "warn", "info", "debug"]));
  });

  it("every case", () => {
    const disagreements = loadCases()
      .filter((c) => classifyLine(c.line) !== c.level)
      .map((c) => `${JSON.stringify(c.line)}: Rust ${c.level}, TS ${classifyLine(c.line)}`);
    expect(disagreements).toEqual([]);
  });
});
