/** Pure ⌘F half; positions and counts are hand-written, never computed by the code under test. */

import { describe, expect, it } from "vitest";

import {
  clampCursor,
  compileFind,
  findExpansions,
  findInDetail,
  findInStream,
  markSegments,
  marksByPart,
  matchRow,
  partKey,
  rangesIn,
  revealScrollTop,
  stepCursor,
  type FindSpec,
} from "./agentLogsFind";
import { buildStream, pairToolLines } from "./agentLogsStream";
import type { LogLine } from "./agentLogsTypes";

const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id, tsMs: 0, terminalId: null, agentId: null, source: "zsh", kind: "output", level: "info",
  text: `line ${id}`, detail: null, toolUseId: null, ...p,
});
const call = (id: number, text: string, p: Partial<LogLine> = {}) =>
  L(id, { kind: "tool", source: "claude", agentId: "a", toolUseId: `tu${id}`, text, ...p });
const answer = (id: number, ofId: number, detail: string) =>
  L(id, { kind: "tool-result", source: "claude", agentId: "a", toolUseId: `tu${ofId}`, text: "Bash → x", detail });

const spec = (query: string, p: Partial<FindSpec> = {}): FindSpec => ({ query, caseSensitive: false, regex: false, ...p });
const re = (query: string, p: Partial<FindSpec> = {}): RegExp => {
  const c = compileFind(spec(query, p));
  if (!c.ok || c.re === null) throw new Error("expected a regex");
  return c.re;
};
const streamOf = (lines: LogLine[], expanded: Record<string, boolean> = {}) =>
  buildStream(lines, pairToolLines(lines), { expanded, query: null });

describe("compileFind", () => {
  it("an empty query finds nothing (and is not an error)", () => {
    expect(compileFind(spec(""))).toEqual({ ok: true, re: null });
    expect(compileFind(spec("", { regex: true }))).toEqual({ ok: true, re: null });
  });

  it("literal by default: regex metacharacters are searched for as themselves", () => {
    expect(rangesIn("a.b axb (x) [y] $^ \\", re("."))).toEqual([{ from: 1, to: 2 }]);
    expect(rangesIn("(x) (x)", re("(x)"))).toEqual([{ from: 0, to: 3 }, { from: 4, to: 7 }]);
    expect(rangesIn("a\\b", re("\\"))).toEqual([{ from: 1, to: 2 }]);
  });

  it("case-insensitive by default; Aa makes it exact", () => {
    expect(rangesIn("Error error ERROR", re("error"))).toHaveLength(3);
    expect(rangesIn("Error error ERROR", re("error", { caseSensitive: true }))).toEqual([{ from: 6, to: 11 }]);
  });

  it(".* makes it a regex, with the case toggle still applying", () => {
    expect(rangesIn("port 8080 and 3000", re("\\d+", { regex: true }))).toEqual([{ from: 5, to: 9 }, { from: 14, to: 18 }]);
    expect(rangesIn("Warn warn", re("^w", { regex: true }))).toEqual([{ from: 0, to: 1 }]);
    expect(rangesIn("Warn warn", re("^w", { regex: true, caseSensitive: true }))).toEqual([]);
  });

  it("an invalid regex is an error message, never a throw — and the same text is fine as a literal", () => {
    const bad = compileFind(spec("(unclosed", { regex: true }));
    expect(bad.ok).toBe(false);
    expect(bad.ok ? null : bad.error).toMatch(/Invalid regular expression/);
    expect(compileFind(spec("(unclosed")).ok).toBe(true);
  });
});

describe("rangesIn", () => {
  it("non-overlapping, left to right", () => {
    expect(rangesIn("aaaa", re("aa"))).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }]);
  });

  it("skips zero-width matches instead of counting (or looping on) them", () => {
    expect(rangesIn("bbb", re("a*", { regex: true }))).toEqual([]);
    expect(rangesIn("baab", re("a*", { regex: true }))).toEqual([{ from: 1, to: 3 }]);
  });

  it("resets the shared RegExp between texts", () => {
    const r = re("x");
    expect(rangesIn("x x", r)).toHaveLength(2);
    expect(rangesIn("x", r)).toEqual([{ from: 0, to: 1 }]);
  });
});

describe("findInStream / partKey / marksByPart", () => {
  const lines = [
    L(1, { text: "gazelle started\non two lines" }),
    call(2, "Bash: tail gazelle.log", { detail: "Tail the gazelle log" }),
    answer(3, 2, "l0\nl1 gazelle\nl2\nl3\nl4 gazelle gazelle"),
    L(4, { kind: "system", text: "gazelle exited" }),
    call(5, "Read: /x/gazelle.rs"),
  ];
  const s = streamOf(lines);

  it("searches raw text (one-lined), a header's description and label, EVERY output line (folded too), and dividers", () => {
    const ms = findInStream(s, re("gazelle"));
    expect(ms.map((m) => [m.entry, m.part, m.from])).toEqual([
      [0, { kind: "text" }, 0],
      [1, { kind: "desc" }, 9],
      [1, { kind: "label" }, 7],
      [1, { kind: "out", index: 1 }, 3],
      [1, { kind: "out", index: 4 }, 3],
      [1, { kind: "out", index: 4 }, 11],
      [2, { kind: "text" }, 0],
      [3, { kind: "label" }, 8],
    ]);
  });

  it("marks group by the drawn text each match is in, carrying the global ordinal", () => {
    const marks = marksByPart(s, findInStream(s, re("gazelle")));
    expect([...marks.keys()]).toEqual(["l:1", "d:tu2", "h:tu2", "o:tu2:1", "o:tu2:4", "l:4", "h:tu5"]);
    expect(marks.get("o:tu2:4")).toEqual([{ from: 3, to: 10, ord: 4 }, { from: 11, to: 18, ord: 5 }]);
    expect(partKey(s.entries[0], { kind: "label" })).toBe("l:1");
  });

  it("findExpansions: a block with a hit behind its fold expands — unless the user folded it by hand while the bar was open", () => {
    const ms = findInStream(s, re("gazelle"));
    expect(findExpansions(s, ms, {})).toEqual({ tu2: true });
    expect(findExpansions(s, ms, { tu2: true })).toEqual({});
    // A hit only in the first 3 lines does not need the fold opened.
    expect(findExpansions(s, findInStream(s, re("l1")), {})).toEqual({});
  });

  it("matchRow: a header / raw / divider hit is its entry's row; an output hit is below the header; a folded-away hit lands on the more row", () => {
    const ms = findInStream(s, re("gazelle"));
    // Entry offsets: raw 0, block 1 (head + 3 shown + more = 5 rows), divider 6, pending block 7.
    expect(ms.map((m) => matchRow(s, m))).toEqual([0, 1, 1, 3, 5, 5, 6, 7]);
    const open = streamOf(lines, { tu2: true });
    // Expanded: head 1, l0..l4 at 2..6, "show less" 7, divider 8, pending 9.
    expect(ms.map((m) => matchRow(open, m))).toEqual([0, 1, 1, 3, 6, 6, 8, 9]);
  });
});

describe("findInDetail", () => {
  it("every match in the drawer's texts, top to bottom, tagged by text", () => {
    expect(
      findInDetail(
        [
          { id: "text", text: "Bash: x" },
          { id: "detail", text: "no" },
          { id: "result", text: "x\nx" },
        ],
        re("x"),
      ),
    ).toEqual([
      { part: "text", from: 6, to: 7 },
      { part: "result", from: 0, to: 1 },
      { part: "result", from: 2, to: 3 },
    ]);
  });
});

describe("cursor", () => {
  it("clampCursor keeps a stored ordinal inside the live list", () => {
    expect(clampCursor(5, 0)).toBe(0);
    expect(clampCursor(5, 3)).toBe(2);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(1, 3)).toBe(1);
  });

  it("stepCursor wraps at both ends, and steps from the CLAMPED position", () => {
    expect(stepCursor(0, 1, 0)).toBe(0);
    expect(stepCursor(2, 1, 3)).toBe(0);
    expect(stepCursor(0, -1, 3)).toBe(2);
    expect(stepCursor(1, 1, 3)).toBe(2);
    expect(stepCursor(9, 1, 3)).toBe(0); // 9 → clamped to 2 → wraps to 0
    expect(stepCursor(0, 1, 1)).toBe(0);
  });
});

describe("revealScrollTop (index arithmetic under a one-row sticky header)", () => {
  // rowH 10, viewport 100: header 0..10, then rows. Row i's top is (i + 1) · 10.
  it("null when the row is already fully visible below the header", () => {
    expect(revealScrollTop(0, 0, 100, 10)).toBeNull(); // 10..20 in 10..100
    expect(revealScrollTop(8, 0, 100, 10)).toBeNull(); // 90..100 — the last full row
    expect(revealScrollTop(5, 30, 100, 10)).toBeNull(); // 60..70 in 40..130
  });

  it("a row below the viewport is centred", () => {
    // Row 9 (100..110) is past 0..100. Centre: 9 rows of room under the header → 4 above it.
    expect(revealScrollTop(9, 0, 100, 10)).toBe(50);
    expect(revealScrollTop(100, 0, 100, 10)).toBe(960);
  });

  it("a row hidden under the sticky header or above is centred too, never above 0", () => {
    expect(revealScrollTop(2, 30, 100, 10)).toBe(0); // 30..40 is under the header at 30..40
    expect(revealScrollTop(20, 500, 100, 10)).toBe(160);
  });
});

describe("markSegments", () => {
  const segs = [
    { kind: "plain" as const, text: "at " },
    { kind: "process" as const, text: "gazelle[12]" },
    { kind: "plain" as const, text: " done" },
  ];

  it("no marks: the segments unchanged", () => {
    expect(markSegments(segs, [])).toEqual(segs.map((s) => ({ ...s, ord: null })));
  });

  it("a mark inside one segment splits it in three", () => {
    expect(markSegments(segs, [{ from: 6, to: 9, ord: 0 }])).toEqual([
      { kind: "plain", text: "at ", ord: null },
      { kind: "process", text: "gaz", ord: null },
      { kind: "process", text: "ell", ord: 0 },
      { kind: "process", text: "e[12]", ord: null },
      { kind: "plain", text: " done", ord: null },
    ]);
  });

  it("a mark spanning a segment boundary is split between them, same ordinal; two marks in a row", () => {
    expect(markSegments(segs, [{ from: 1, to: 5, ord: 3 }, { from: 14, to: 16, ord: 4 }, { from: 16, to: 19, ord: 5 }])).toEqual([
      { kind: "plain", text: "a", ord: null },
      { kind: "plain", text: "t ", ord: 3 },
      { kind: "process", text: "ga", ord: 3 },
      { kind: "process", text: "zelle[12]", ord: null },
      { kind: "plain", text: " d", ord: 4 },
      { kind: "plain", text: "one", ord: 5 },
    ]);
  });

  it("a mark at the very start and one at the very end; an empty segment is skipped", () => {
    expect(markSegments([{ kind: "plain", text: "" }, { kind: "plain", text: "abc" }], [{ from: 0, to: 1, ord: 0 }, { from: 2, to: 3, ord: 1 }])).toEqual([
      { kind: "plain", text: "a", ord: 0 },
      { kind: "plain", text: "b", ord: null },
      { kind: "plain", text: "c", ord: 1 },
    ]);
  });
});
