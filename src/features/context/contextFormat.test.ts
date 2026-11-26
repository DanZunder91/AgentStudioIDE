/** Every expectation is a hand-written literal: one read from the tested code proves nothing. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUFFER_KEY,
  EXTRA_COLOURS,
  FREE_KEY,
  GRID_CELLS,
  UNKNOWN,
  barLayout,
  CONTEXT_HEX,
  contextColour,
  contextHex,
  contextTone,
  describeContextError,
  formatContextPct,
  formatContextSummary,
  formatContextTokens,
  formatMeasuredAt,
  gridCells,
  isCalmError,
} from "./contextFormat";
import type { ContextError } from "./contextIpc";
import type { ContextCategory, ContextUsage } from "./contextTypes";

/** The reference reading: 290.7k of 1m. */
const READING: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 290_700,
  windowTokens: 1_000_000,
  usedPercent: 29,
  categories: [
    { key: "system-prompt", label: "System prompt", tokens: 2_300, percent: 0.2 },
    { key: "system-tools", label: "System tools", tokens: 20_400, percent: 2 },
    { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
    { key: "memory-files", label: "Memory files", tokens: 4_800, percent: 0.5 },
    { key: "skills", label: "Skills", tokens: 4_600, percent: 0.5 },
    { key: "messages", label: "Messages", tokens: 257_900, percent: 25.8 },
    { key: "free-space", label: "Free space", tokens: 676_300, percent: 67.6 },
    { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
  ],
  measuredAtMs: 1_785_200_000_000,
};

const cat = (key: string, tokens: number): ContextCategory => ({ key, label: key, tokens, percent: 0 });
const reading = (windowTokens: number, categories: ContextCategory[]): ContextUsage => ({
  ...READING,
  windowTokens,
  categories,
});

describe("formatContextTokens", () => {
  it.each([
    [0, "0"],
    [717, "717"],
    [999.4, "999"],
    [1_000, "1k"],
    [2_300, "2.3k"],
    [33_000, "33k"],
    [290_700, "290.7k"],
    [676_349, "676.3k"],
    [999_949, "999.9k"],
    // Rounds into the next unit rather than printing "1000k".
    [999_950, "1m"],
    [1_000_000, "1m"],
    [1_240_000, "1.2m"],
    [200_000_000, "200m"],
  ])("%d → %s (the CLI's own short form)", (n, out) => {
    expect(formatContextTokens(n)).toBe(out);
  });

  it.each([NaN, Infinity, -1])("an unreadable %d renders the em dash, never a number", (n) => {
    expect(formatContextTokens(n)).toBe(UNKNOWN);
  });
});

describe("formatContextPct", () => {
  it.each([
    [0, "0%"],
    [0.2, "0.2%"],
    [0.07, "0.1%"],
    [25.8, "25.8%"],
    [29, "29%"],
    [67.65, "67.7%"],
    [100, "100%"],
    // Clamped across the seam: a negative, an overflow and a NaN never reach the screen.
    [-3, "0%"],
    [137, "100%"],
    [NaN, "0%"],
  ])("%d → %s", (p, out) => {
    expect(formatContextPct(p)).toBe(out);
  });
});

describe("contextTone", () => {
  it.each([
    [0, "ok"],
    [49.9, "ok"],
    [50, "warn"],
    [80, "warn"],
    [80.1, "danger"],
    [100, "danger"],
    [NaN, "ok"],
    [-5, "ok"],
    [250, "danger"],
  ] as const)("%d%% is %s (green <50, amber 50–80, red >80)", (p, tone) => {
    expect(contextTone(p)).toBe(tone);
  });
});

describe("formatMeasuredAt", () => {
  const NOW = 1_785_200_000_000;
  it.each([
    [0, "measured just now"],
    [59_999, "measured just now"],
    [60_000, "measured 1 min ago"],
    [59 * 60_000, "measured 59 min ago"],
    [3_600_000, "measured 1 h ago"],
    [23 * 3_600_000 + 59 * 60_000, "measured 23 h ago"],
    [86_400_000, "measured 1 d ago"],
    [3 * 86_400_000, "measured 3 d ago"],
    // A reading newer than the panel's last clock tick: the clock is stale, not the reading.
    [-20_000, "measured just now"],
  ])("%d ms old → %s", (age, out) => {
    expect(formatMeasuredAt(NOW - age, NOW)).toBe(out);
  });

  it("a NaN clock reads 'just now' rather than 'NaN min ago'", () => {
    expect(formatMeasuredAt(NOW, NaN)).toBe("measured just now");
  });
});

describe("formatContextSummary", () => {
  it("names used, window and the compaction point (window − buffer)", () => {
    expect(formatContextSummary(READING)).toBe("290.7k of 1m · compacts at 967k");
  });

  it("drops the compaction clause when the CLI printed no buffer (autocompact off)", () => {
    const noBuffer = { ...READING, categories: READING.categories.filter((c) => c.key !== BUFFER_KEY) };
    expect(formatContextSummary(noBuffer)).toBe("290.7k of 1m");
  });
});

describe("contextColour", () => {
  it.each([
    ["system-prompt", "var(--context-system-prompt)"],
    ["system-tools", "var(--context-system-tools)"],
    ["system-tools-deferred", "var(--context-system-tools-deferred)"],
    ["mcp-tools", "var(--context-mcp-tools)"],
    ["mcp-server-instructions", "var(--context-mcp-server-instructions)"],
    ["memory-files", "var(--context-memory-files)"],
    ["skills", "var(--context-skills)"],
    ["messages", "var(--context-messages)"],
    ["free-space", "var(--context-free-space)"],
    ["autocompact-buffer", "var(--context-autocompact-buffer)"],
  ])("%s has its own fixed colour", (key, colour) => {
    expect(contextColour(key)).toBe(colour);
  });

  it("agents and custom-agents are ONE colour, so a CLI relabel cannot repaint the row", () => {
    expect(contextColour("agents")).toBe("var(--context-agents)");
    expect(contextColour("custom-agents")).toBe("var(--context-agents)");
  });

  it("an unknown key hashes into a fallback slot — deterministically, and by key not position", () => {
    // Literal slots, computed by hand from djb2 so a hash change is a visible diff.
    expect(contextColour("plugins")).toBe("var(--context-extra-5)");
    expect(contextColour("hooks")).toBe("var(--context-extra-3)");
    expect(contextColour("plugins")).toBe(contextColour("plugins"));
    for (const key of ["a", "zz", "slash-commands", "x".repeat(200)]) {
      expect(contextColour(key)).toMatch(new RegExp(`^var\\(--context-extra-[0-${EXTRA_COLOURS - 1}]\\)$`));
    }
  });

  it("a key named like an Object prototype member is still 'unknown', not a crash", () => {
    expect(contextColour("toString")).toMatch(/^var\(--context-extra-\d\)$/);
  });
});

describe("contextHex — the canvas's copy of context.css", () => {
  const css = readFileSync(resolve(__dirname, "context.css"), "utf8");
  const declared = new Map([...css.matchAll(/(--context-[a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));

  it("every hex is the very value context.css declares for that variable — and every category variable has one", () => {
    expect(Object.keys(CONTEXT_HEX).length).toBe(17);
    for (const [name, hex] of Object.entries(CONTEXT_HEX)) expect([name, declared.get(name)]).toEqual([name, hex]);
    const categoryVars = [...declared.keys()].filter((n) => !/^--context-(ok|warn|danger|marker|track)/.test(n));
    expect(categoryVars.sort()).toEqual(Object.keys(CONTEXT_HEX).sort());
  });

  it("names the same colour contextColour does: known keys, the shared agents colour, and hashed unknown keys", () => {
    expect(contextHex("messages")).toBe("#a371f7");
    expect(contextHex("system-prompt")).toBe("#a1a1aa");
    expect(contextHex("mcp-server-instructions")).toBe("#138a9c");
    expect(contextHex("custom-agents")).toBe("#4cae6b");
    expect(contextHex("autocompact-buffer")).toBe("#5b6472");
    // "plugins" hashes to slot 5 (contextColour's own test above).
    expect(contextHex("plugins")).toBe("#e3b341");
    expect(contextHex("toString")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("barLayout", () => {
  it("lays segments out in printed order with widths ∝ tokens / window", () => {
    const { segments } = barLayout(READING);
    expect(segments.map((s) => s.category.key)).toEqual([
      "system-prompt",
      "system-tools",
      "mcp-server-instructions",
      "memory-files",
      "skills",
      "messages",
      "free-space",
      "autocompact-buffer",
    ]);
    const widths = segments.map((s) => s.widthPct);
    [0.23, 2.04, 0.0717, 0.48, 0.46, 25.79, 67.63, 3.3].forEach((w, i) => expect(widths[i]).toBeCloseTo(w, 6));
    // Starts are the running sum: each segment begins where the previous one ended.
    expect(segments[0].startPct).toBe(0);
    expect(segments[5].startPct).toBeCloseTo(3.2817, 6);
  });

  it("puts the compaction marker at the buffer segment's own left edge (= window − buffer)", () => {
    const { compactAtPct, segments } = barLayout(READING);
    expect(compactAtPct).toBeCloseTo(96.7017, 6);
    expect(compactAtPct).toBe(segments[7].startPct);
  });

  it("has no marker when there is no buffer row", () => {
    expect(barLayout(reading(1_000, [cat("messages", 500), cat(FREE_KEY, 500)])).compactAtPct).toBeNull();
  });

  it("a zero or unreadable window gives zero widths, never NaN%", () => {
    for (const w of [0, -1, NaN]) {
      const { segments } = barLayout(reading(w, [cat("messages", 10), cat(BUFFER_KEY, 5)]));
      expect(segments.map((s) => s.widthPct)).toEqual([0, 0]);
    }
  });

  it("a negative token count draws as zero width rather than pulling later segments left", () => {
    const { segments } = barLayout(reading(100, [cat("weird", -40), cat("messages", 50)]));
    expect(segments.map((s) => [s.startPct, s.widthPct])).toEqual([
      [0, 0],
      [0, 50],
    ]);
  });
});

describe("gridCells", () => {
  const counts = (cells: string[]): Record<string, number> =>
    cells.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});

  it("is always exactly 200 cells — each one 0.5% of the window", () => {
    expect(GRID_CELLS).toBe(200);
    expect(gridCells(READING)).toHaveLength(200);
  });

  it("paints the reference reading cell-for-cell: tiny rows get one cell, free space is the remainder", () => {
    // 2.3k → 0.46 cells → 1 (minimum); 20.4k → 4.08 → 4; 717 → 1 (minimum); 4.8k → 1;
    // 4.6k → 1; 257.9k → 51.58 → 52; buffer 33k → 6.6 → 7; free = 200 − 67 = 133.
    expect(counts(gridCells(READING))).toEqual({
      "system-prompt": 1,
      "system-tools": 4,
      "mcp-server-instructions": 1,
      "memory-files": 1,
      skills: 1,
      messages: 52,
      "free-space": 133,
      "autocompact-buffer": 7,
    });
  });

  it("keeps printed order: used rows first, then free, then the buffer at the end", () => {
    const cells = gridCells(READING);
    expect(cells[0]).toBe("system-prompt");
    expect(cells.slice(1, 5)).toEqual(Array(4).fill("system-tools"));
    expect(cells[59]).toBe("messages");
    expect(cells[60]).toBe(FREE_KEY);
    expect(cells[192]).toBe(FREE_KEY);
    expect(cells.slice(193)).toEqual(Array(7).fill(BUFFER_KEY));
  });

  it("draws the remainder before the buffer even when the CLI printed no free-space row", () => {
    const cells = gridCells(reading(1_000, [cat("messages", 100), cat(BUFFER_KEY, 50)]));
    expect(counts(cells)).toEqual({ messages: 20, [FREE_KEY]: 170, [BUFFER_KEY]: 10 });
    expect(cells[20]).toBe(FREE_KEY);
    expect(cells[199]).toBe(BUFFER_KEY);
  });

  it("draws the remainder at the end when there is neither a free row nor a buffer", () => {
    const cells = gridCells(reading(1_000, [cat("messages", 250)]));
    expect(counts(cells)).toEqual({ messages: 50, [FREE_KEY]: 150 });
    expect(cells[199]).toBe(FREE_KEY);
  });

  it("zero-token rows get no cells, and an overfull reading is cut at the window", () => {
    expect(counts(gridCells(reading(100, [cat("skills", 0), cat("messages", 150), cat(FREE_KEY, 0)])))).toEqual({
      messages: 200,
    });
  });

  it("a zero window is all free cells — nothing can be scaled", () => {
    expect(counts(gridCells(reading(0, [cat("messages", 10), cat(FREE_KEY, 0)])))).toEqual({ [FREE_KEY]: 200 });
  });
});

describe("describeContextError", () => {
  it.each([
    ["no-session", "This agent hasn't had a conversation yet — its context appears after the first prompt."],
    ["cli-missing", "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry."],
    ["bad-session", "This agent isn't a live root session the app can read — its context can't be measured."],
    [
      "cli-failed",
      "The claude CLI ran but exited with an error — retry, or run /context in the agent's terminal to see what it reports.",
    ],
    ["timeout", "The claude CLI did not answer in time — retry in a moment."],
    [
      "parse",
      "The claude CLI answered, but not with a table this card can read — its wording has probably changed, so retrying will not help.",
    ],
    ["unknown", "The context read failed for an unrecognized reason — retrying may help."],
  ] as const)("%s → its one true sentence", (code, sentence) => {
    expect(describeContextError(code)).toBe(sentence);
  });

  it("only no-session is calm — every other code is something going wrong", () => {
    const codes: ContextError[] = ["no-session", "cli-missing", "bad-session", "cli-failed", "timeout", "parse", "unknown"];
    expect(codes.filter(isCalmError)).toEqual(["no-session"]);
  });
});
