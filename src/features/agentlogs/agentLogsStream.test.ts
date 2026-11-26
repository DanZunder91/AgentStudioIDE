/** Stream model: pairing (and its fallback), blocks, row arithmetic, window, error targets and
 * copy text; every expectation written by hand. */

import { describe, expect, it } from "vitest";

import {
  blockFor,
  blockHeight,
  buildStream,
  errorTargets,
  formatVisualRowForCopy,
  pairToolLines,
  visualRowKey,
  visualRowsIn,
  type Stream,
  type VisualRow,
} from "./agentLogsStream";
import type { LogLine } from "./agentLogsTypes";

const T = new Date(2026, 8, 25, 10, 0, 0, 0).getTime();
const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: T + id * 1000,
  terminalId: null,
  agentId: "a1",
  source: "claude · proj",
  kind: "output",
  level: "info",
  text: `line ${id}`,
  detail: null,
  toolUseId: null,
  ...p,
});
const tool = (id: number, text: string, p: Partial<LogLine> = {}) => L(id, { kind: "tool", text, ...p });
const result = (id: number, text: string, p: Partial<LogLine> = {}) => L(id, { kind: "tool-result", text, ...p });
const sys = (id: number, text: string, p: Partial<LogLine> = {}) => L(id, { kind: "system", text, agentId: null, source: "sh · proj", ...p });

const NONE = { expanded: {}, query: null };
/** `[kind, line id]` for raw/divider, `[block, key, height, expanded]` for a block. */
const brief = (s: Stream) =>
  s.entries.map((e) =>
    e.kind === "block" ? `block ${e.block.key} h${e.height}${e.expanded ? " open" : ""} @${e.offset}` : `${e.kind} ${e.line.id} @${e.offset}`,
  );
const rowsBrief = (rows: VisualRow[]) =>
  rows.map((r) => {
    if (r.kind === "raw" || r.kind === "divider") return `${r.kind} ${r.line.id}`;
    if (r.kind === "head") return `head ${r.block.key}`;
    if (r.kind === "out") return `out ${r.index}${r.hit ? " hit" : ""}: ${r.text}`;
    return `more ${r.hidden}${r.expanded ? " open" : ""}`;
  });

describe("pairToolLines", () => {
  it("pairs by toolUseId — order and agent do not matter when the id says so", () => {
    const lines = [
      tool(1, "Bash: a", { toolUseId: "tu_a" }),
      tool(2, "Bash: b", { toolUseId: "tu_b" }),
      result(3, "Bash → b out", { toolUseId: "tu_b" }),
      result(4, "Bash → a out", { toolUseId: "tu_a", agentId: "someone-else" }),
    ];
    const p = pairToolLines(lines);
    expect([...p.resultOf.entries()].map(([k, v]) => [k, v.id])).toEqual([
      [2, 3],
      [1, 4],
    ]);
    expect([...p.toolOf.entries()].map(([k, v]) => [k, v.id])).toEqual([
      [3, 2],
      [4, 1],
    ]);
  });

  it("a result whose id matches no call in the ring stays unpaired (an orphan)", () => {
    const p = pairToolLines([result(9, "Bash → late", { toolUseId: "tu_gone" })]);
    expect(p.toolOf.size).toBe(0);
    expect(p.resultOf.size).toBe(0);
  });

  it("a second result for one id is a replay: the first answer stands", () => {
    const p = pairToolLines([
      tool(1, "Bash: a", { toolUseId: "tu_a" }),
      result(2, "Bash → first", { toolUseId: "tu_a" }),
      result(3, "Bash → again", { toolUseId: "tu_a" }),
    ]);
    expect(p.resultOf.get(1)?.id).toBe(2);
    expect(p.toolOf.has(3)).toBe(false);
  });

  describe("the tolerated fallback: a result with no id answers the OLDEST preceding unanswered call of its agent", () => {
    it("two calls issued together (one assistant message), then their results in call order: first answers first", () => {
      const p = pairToolLines([
        tool(1, "Read: /a"),
        tool(2, "Read: /b"),
        result(3, "Read → a's contents"),
        result(4, "Read → b's contents"),
      ]);
      expect(p.toolOf.get(3)?.id).toBe(1);
      expect(p.toolOf.get(4)?.id).toBe(2);
    });

    it("pairs in order, per agent", () => {
      const p = pairToolLines([
        tool(1, "Bash: a"),
        tool(2, "Grep: x", { agentId: "sub" }),
        result(3, "Grep → hit", { agentId: "sub" }),
        result(4, "Bash → a out"),
      ]);
      expect(p.toolOf.get(3)?.id).toBe(2);
      expect(p.toolOf.get(4)?.id).toBe(1);
    });

    it("skips a call already answered by id, and never answers one twice", () => {
      const p = pairToolLines([
        tool(1, "Bash: a", { toolUseId: "tu_a" }),
        tool(2, "Bash: b"),
        result(3, "Bash → a out", { toolUseId: "tu_a" }),
        result(4, "Bash → b out"), // id-less: a is taken, so b
        result(5, "Bash → stray"), // nothing left to answer
      ]);
      expect(p.toolOf.get(4)?.id).toBe(2);
      expect(p.toolOf.has(5)).toBe(false);
    });

    it("with no agent id, the source label is the agent", () => {
      const p = pairToolLines([
        tool(1, "Bash: a", { agentId: null, source: "claude · x" }),
        tool(2, "Bash: b", { agentId: null, source: "claude · y" }),
        result(3, "Bash → a", { agentId: null, source: "claude · x" }),
      ]);
      expect(p.toolOf.get(3)?.id).toBe(1);
    });

    it("a result from a build that never sent the field (undefined, not null) pairs the same way", () => {
      const legacy = { ...result(2, "Bash → a out") } as Partial<LogLine> as LogLine;
      delete (legacy as { toolUseId?: unknown }).toolUseId;
      const call = { ...tool(1, "Bash: a") } as Partial<LogLine> as LogLine;
      delete (call as { toolUseId?: unknown }).toolUseId;
      expect(pairToolLines([call, legacy]).toolOf.get(2)?.id).toBe(1);
    });
  });

  it("non-tool kinds are ignored entirely", () => {
    const p = pairToolLines([L(1), sys(2, "agent started"), L(3, { kind: "task" }), L(4, { kind: "machine" })]);
    expect(p.toolOf.size + p.resultOf.size).toBe(0);
  });
});

describe("blockFor / blockHeight", () => {
  it("a call with its result: header from the call, output from the result, error from the result's level", () => {
    const call = tool(1, "Bash: cargo test --lib", { toolUseId: "tu", detail: "Run the unit tests" });
    const res = result(2, "Bash → running 3 tests", { toolUseId: "tu", level: "error", detail: "running 3 tests\ntest a ... FAILED" });
    const b = blockFor(call, pairToolLines([call, res]));
    expect(b).toMatchObject({
      key: "tu",
      anchor: call,
      header: { name: "Bash", label: "$ cargo test --lib", description: "Run the unit tests", full: null },
      output: ["running 3 tests", "test a ... FAILED"],
      error: true,
    });
    expect(b.tool).toBe(call);
    expect(b.result).toBe(res);
  });

  it("a pending call: no output, not an error, keyed by its id when it has no toolUseId", () => {
    const call = tool(7, "Read: /x");
    const b = blockFor(call, pairToolLines([call]));
    expect(b).toMatchObject({ key: "t7", result: null, output: [], error: false });
    expect(b.header.label).toBe("Read /x");
  });

  it("an orphan result: headed by its tool name, keyed by its own id, marked as having no call", () => {
    const res = result(5, "WebFetch → Request failed with status 404", { level: "error" });
    const b = blockFor(res, pairToolLines([res]));
    expect(b).toMatchObject({
      key: "r5",
      tool: null,
      anchor: res,
      header: { name: "WebFetch", label: "WebFetch", description: null, full: null },
      output: ["Request failed with status 404"],
      error: true,
    });
    // …and with an id but no call in the ring, keyed by the id.
    const idd = result(6, "bare text", { toolUseId: "tu_x" });
    expect(blockFor(idd, pairToolLines([idd]))).toMatchObject({ key: "tu_x", header: { name: null, label: "bare text" } });
  });

  it("splits a result's output once per line object (cached)", () => {
    const res = result(2, "Bash → a", { toolUseId: "tu", detail: "a\nb" });
    const call = tool(1, "Bash: x", { toolUseId: "tu" });
    const p = pairToolLines([call, res]);
    expect(blockFor(call, p).output).toBe(blockFor(call, p).output);
  });

  it.each([
    [0, false, 1], // header only
    [1, false, 2],
    [3, false, 4], // three lines fit: no "more" row
    [4, false, 1 + 3 + 1], // folded: header + 3 + "show 1 more"
    [4, true, 1 + 4 + 1], // open: header + 4 + "show less"
    [40, false, 5],
    [40, true, 42],
  ])("blockHeight(%d lines, expanded %s) = %d rows", (n, open, want) => {
    expect(blockHeight(n, open)).toBe(want);
  });
});

describe("buildStream", () => {
  const CALL = tool(10, "Bash: cargo test", { toolUseId: "tu1", detail: "Run tests" });
  const RES = result(11, "Bash → running", { toolUseId: "tu1", detail: "l1\nl2\nl3\nl4\nl5" });
  const lines = [sys(1, "terminal opened · sh in /w"), L(2, { agentId: null, source: "sh · proj" }), CALL, RES, L(12, { kind: "task", source: "gazelle · bg" })];
  const pairing = pairToolLines(lines);

  it("raw rows, a divider, and one block at the call's position with cumulative offsets", () => {
    const s = buildStream(lines, pairing, NONE);
    expect(brief(s)).toEqual(["divider 1 @0", "raw 2 @1", "block tu1 h5 @2", "raw 12 @7"]);
    expect(s.total).toBe(8);
    // Every shown line, both halves of the block included.
    expect([...s.shown.keys()]).toEqual([1, 2, 10, 11, 12]);
  });

  it("a result is never a row of its own: when its call is in the rows, the result adds nothing", () => {
    const s = buildStream([CALL, RES], pairing, NONE);
    expect(brief(s)).toEqual(["block tu1 h5 @0"]);
  });

  it("when the filter kept only the RESULT, the block appears there, headed by the pulled-in call", () => {
    const s = buildStream([RES], pairing, NONE);
    expect(brief(s)).toEqual(["block tu1 h5 @0"]);
    const e = s.entries[0];
    if (e.kind !== "block") throw new Error("expected a block");
    expect(e.block.tool).toBe(CALL);
    expect(e.block.header.label).toBe("$ cargo test");
    expect(e.line).toBe(CALL);
    expect(s.shown.get(10)).toBe(CALL);
  });

  it("an orphan result (no call anywhere) is its own block, anchored on itself", () => {
    const orphan = result(20, "Read → contents");
    const s = buildStream([orphan], pairToolLines([orphan]), NONE);
    expect(brief(s)).toEqual(["block r20 h2 @0"]);
  });

  it("a call answered twice in the rows still yields one block", () => {
    // A rows array that (through a replay) holds the call, then two results for it.
    const dup = result(13, "Bash → again", { toolUseId: "tu1" });
    const s = buildStream([CALL, RES, dup], pairToolLines([CALL, RES, dup]), NONE);
    expect(brief(s)).toEqual(["block tu1 h5 @0", "block tu1 h2 @5"]);
    // (The unpaired replay stands alone as an orphan — visible, never silently dropped.)
  });

  it("explicit expand / collapse per key changes the height", () => {
    expect(brief(buildStream([CALL], pairing, { expanded: { tu1: true }, query: null }))).toEqual(["block tu1 h7 open @0"]);
    expect(brief(buildStream([CALL], pairing, { expanded: { tu1: false }, query: null }))).toEqual(["block tu1 h5 @0"]);
  });

  it("a query that hits output BEYOND the folded lines auto-expands the block; a hit within them does not", () => {
    const deep = buildStream([CALL], pairing, { expanded: {}, query: (s) => s === "l5" });
    expect(brief(deep)).toEqual(["block tu1 h7 open @0"]);
    const e = deep.entries[0];
    if (e.kind !== "block") throw new Error("expected a block");
    expect(e.hits).toEqual([4]);
    const shallow = buildStream([CALL], pairing, { expanded: {}, query: (s) => s === "l2" });
    expect(brief(shallow)).toEqual(["block tu1 h5 @0"]);
    // An explicit collapse wins over the automatic expansion.
    expect(brief(buildStream([CALL], pairing, { expanded: { tu1: false }, query: (s) => s === "l5" }))).toEqual(["block tu1 h5 @0"]);
  });

  it("empty rows: an empty stream", () => {
    expect(buildStream([], pairing, NONE)).toEqual({ entries: [], total: 0, shown: new Map() });
  });
});

describe("visualRowsIn — the window, materialised", () => {
  const CALL = tool(10, "Bash: cargo test", { toolUseId: "tu1" });
  const RES = result(11, "Bash → l1", { toolUseId: "tu1", detail: "l1\nl2\nl3\nl4\nl5" });
  const lines = [L(1, { agentId: null, source: "sh" }), CALL, RES, sys(20, "agent session ended"), L(21, { agentId: null, source: "sh" })];
  const stream = buildStream(lines, pairToolLines(lines), NONE);

  it("the whole stream, in order: raw, head, 3 outputs, a fold row, a divider, raw", () => {
    expect(stream.total).toBe(8);
    expect(rowsBrief(visualRowsIn(stream, 0, stream.total))).toEqual([
      "raw 1",
      "head tu1",
      "out 0: l1",
      "out 1: l2",
      "out 2: l3",
      "more 2",
      "divider 20",
      "raw 21",
    ]);
  });

  it("a window that starts inside a block yields only the rows in range", () => {
    expect(rowsBrief(visualRowsIn(stream, 3, 6))).toEqual(["out 1: l2", "out 2: l3", "more 2"]);
    expect(rowsBrief(visualRowsIn(stream, 5, 7))).toEqual(["more 2", "divider 20"]);
    expect(rowsBrief(visualRowsIn(stream, 6, 99))).toEqual(["divider 20", "raw 21"]);
  });

  it("an expanded block shows every line and a `show less` row; hits are marked", () => {
    const open = buildStream(lines, pairToolLines(lines), { expanded: { tu1: true }, query: (s) => s === "l4" });
    expect(rowsBrief(visualRowsIn(open, 1, open.total))).toEqual([
      "head tu1",
      "out 0: l1",
      "out 1: l2",
      "out 2: l3",
      "out 3 hit: l4",
      "out 4: l5",
      "more 2 open",
      "divider 20",
      "raw 21",
    ]);
  });

  it("an empty or inverted window is no rows; keys are stable and distinct", () => {
    expect(visualRowsIn(stream, 3, 3)).toEqual([]);
    expect(visualRowsIn(stream, 5, 2)).toEqual([]);
    expect(visualRowsIn({ entries: [], total: 0, shown: new Map() }, 0, 5)).toEqual([]);
    const keys = visualRowsIn(stream, 0, stream.total).map(visualRowKey);
    expect(keys).toEqual(["1", "b:tu1", "b:tu1:0", "b:tu1:1", "b:tu1:2", "b:tu1:more", "20", "21"]);
  });
});

describe("errorTargets — the rows an error badge jumps between", () => {
  it("raw error lines, a failed block (by its result), an error divider; only for the asked source", () => {
    const failed = tool(3, "Bash: x", { toolUseId: "t", source: "claude · a" });
    const failure = result(4, "Bash → boom", { toolUseId: "t", level: "error", source: "claude · a" });
    const lines = [
      L(1, { level: "error", source: "gazelle · bg" }),
      L(2, { level: "info", source: "gazelle · bg" }),
      failed,
      failure,
      L(5, { level: "error", source: "claude · a" }),
      sys(6, "agent exited (code 1)", { level: "error", source: "claude · a" }),
      tool(7, "Bash: ok", { toolUseId: "u", source: "claude · a" }),
      result(8, "Bash → fine", { toolUseId: "u", source: "claude · a" }),
    ];
    const s = buildStream(lines, pairToolLines(lines), NONE);
    expect(errorTargets(s, "gazelle · bg")).toEqual([{ lineId: 1, offset: 0 }]);
    expect(errorTargets(s, "claude · a")).toEqual([
      { lineId: 3, offset: 2 }, // the block, at its header row
      { lineId: 5, offset: 4 },
      { lineId: 6, offset: 5 },
    ]);
    expect(errorTargets(s, "nobody")).toEqual([]);
  });
});

describe("formatVisualRowForCopy", () => {
  const call = tool(1, "Bash: cargo test", { toolUseId: "t", detail: "Run tests", tsMs: new Date(2026, 8, 25, 9, 8, 7, 6).getTime() });
  const res = result(2, "Bash → l1", { toolUseId: "t", level: "error", detail: "l1\nl2\nl3\nl4" });
  const lines = [L(0, { text: "plain", source: "sh", agentId: null, tsMs: new Date(2026, 8, 25, 9, 8, 7, 6).getTime() }), sys(3, "terminal closed", { tsMs: new Date(2026, 8, 25, 9, 8, 7, 6).getTime() }), call, res];

  it("raw as before; a divider with rules; a block's header, its output indented, then the fold", () => {
    const s = buildStream(lines, pairToolLines(lines), NONE);
    expect(visualRowsIn(s, 0, s.total).map(formatVisualRowForCopy)).toEqual([
      "09:08:07.006 I sh  plain",
      "09:08:07.006 I sh · proj  ── terminal closed ──",
      "09:08:07.006 E claude · proj  $ cargo test  # Run tests",
      "    l1",
      "    l2",
      "    l3",
      "    … 1 more line",
    ]);
  });

  it("an expanded block copies every line and no control row (null, for the caller to skip)", () => {
    const s = buildStream([call], pairToolLines(lines), { expanded: { t: true }, query: null });
    expect(visualRowsIn(s, 0, s.total).map(formatVisualRowForCopy)).toEqual([
      "09:08:07.006 E claude · proj  $ cargo test  # Run tests",
      "    l1",
      "    l2",
      "    l3",
      "    l4",
      null,
    ]);
  });

  it("a fold of several lines is plural", () => {
    const five = result(2, "Bash → l1", { toolUseId: "t", detail: "l1\nl2\nl3\nl4\nl5" });
    const s = buildStream([call], pairToolLines([call, five]), NONE);
    const all = visualRowsIn(s, 0, s.total);
    expect(formatVisualRowForCopy(all[all.length - 1])).toBe("    … 2 more lines");
  });

  it("a header without a description has no `#`; a healthy block keeps the call's level", () => {
    const ok = tool(5, "Read: /x", { toolUseId: "r" });
    const s = buildStream([ok], pairToolLines([ok]), NONE);
    expect(formatVisualRowForCopy(visualRowsIn(s, 0, 1)[0])).toMatch(/ I claude · proj {2}Read \/x$/);
  });
});
