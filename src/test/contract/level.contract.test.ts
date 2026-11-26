/** SEAM TEST: one level table in two languages. Rust writes `goldens/level-cases.json` from
 * `classify_level`; `classifyLine` must agree on every case. Never hand-edit it; regenerate. Read
 * from disk, not imported, so its absence is a named failure. */

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
