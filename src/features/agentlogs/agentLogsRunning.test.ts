/** Sources derivation over real-shaped lines, expectations by hand. Wire texts are Rust's
 * (`logstream/tasks.rs` prefixes); the contract test runs the derivation over the real golden. */

import { describe, expect, it, vi } from "vitest";

const plat = vi.hoisted(() => ({ mac: true }));
vi.mock("../shortcuts/shortcuts", () => ({ isMac: () => plat.mac }));

import { defaultFilter } from "./agentLogsStore";
import {
  agoText,
  chipTitle,
  countParts,
  deriveRunning,
  GROUP_ORDER,
  groupLabel,
  groupSingular,
  groupSources,
  lifecycleOf,
  matchCountsBySource,
  queryMatcher,
  sourcePickerItems,
  streamHeader,
  visibleRunning,
  type RunningSource,
} from "./agentLogsRunning";
import type { LogLine } from "./agentLogsTypes";

const T = 1_790_000_000_000;
let nextId = 1;
const L = (p: Partial<LogLine>): LogLine => {
  const id = p.id ?? nextId++;
  return {
    id,
    tsMs: T + id * 1000,
    terminalId: null,
    agentId: null,
    source: "zsh",
    kind: "output",
    level: "info",
    text: `line ${id}`,
    detail: null,
    toolUseId: null,
    ...p,
  };
};
const sys = (source: string, text: string, p: Partial<LogLine> = {}) => L({ source, kind: "system", text, ...p });
/** `source · running|stopped · kind · lines/errors · reason` — one readable string per chip. */
const brief = (s: RunningSource) =>
  `${s.source} · ${s.running ? "running" : "stopped"} · ${s.kind} · ${s.lines}/${s.errors}${s.reason === null ? "" : ` · ${s.reason}`}`;

describe("lifecycleOf — the wire texts", () => {
  it.each([
    ["background task started · gazelle (bgen1a2b3)", { kind: "task", start: true, reason: null }],
    ["background task stopped · gazelle (bgen1a2b3) — no output for 10 min", { kind: "task", start: false, reason: "no output for 10 min" }],
    ["background task stopped · gazelle (bgen1a2b3)", { kind: "task", start: false, reason: null }],
    ["terminal opened · zsh in /work/gazelle", { kind: "terminal", start: true, reason: null }],
    ["terminal exited (code 3)", { kind: "terminal", start: false, reason: "exited (code 3)" }],
    ["terminal exited (status unavailable)", { kind: "terminal", start: false, reason: "exited (status unavailable)" }],
    ["terminal closed", { kind: "terminal", start: false, reason: "closed" }],
    ["agent started · claude in /work/gazelle", { kind: "agent", start: true, reason: null }],
    ["sub-agent started", { kind: "agent", start: true, reason: null }],
    ["sub-agent started (Explore)", { kind: "agent", start: true, reason: null }],
    ["agent exited (code 0)", { kind: "agent", start: false, reason: "exited (code 0)" }],
    ["agent exited · auth failed", { kind: "agent", start: false, reason: "exited · auth failed" }],
    ["agent session ended", { kind: "agent", start: false, reason: "session ended" }],
    ["sub-agent finished", { kind: "agent", start: false, reason: "finished" }],
    ["sub-agent failed", { kind: "agent", start: false, reason: "failed" }],
    // A dev app's tail (`logstream/apps.rs` APP_STARTED/STOPPED_PREFIX).
    ["app log started · web · server.log", { kind: "app", start: true, reason: null }],
    ["app log stopped · web · server.log — the process exited", { kind: "app", start: false, reason: "the process exited" }],
    ["app log stopped · pg · docker", { kind: "app", start: false, reason: null }],
  ])("%s", (text, want) => expect(lifecycleOf(text)).toEqual(want));

  it.each([
    "not tailing background task b1: 8 background tasks are already tailed",
    "… 12 log lines dropped (log queue full)",
    "background task b1 started: cargo run", // the older wording is not the contract
    "terminal closed early", // exact match only
  ])("not lifecycle: %s", (text) => expect(lifecycleOf(text)).toBeNull());
});

describe("deriveRunning", () => {
  it("a background task: started → task lines → stopped, with its reason, command and counts", () => {
    const cmd = "cd /work/gazelle && ./target/debug/gazelle serve\n/private/tmp/claude-501/x/tasks/b1.output";
    const lines = [
      sys("gazelle · bg", "background task started · gazelle (b1)", { id: 1, detail: cmd }),
      L({ id: 2, source: "gazelle · bg", kind: "task", text: "INFO listening on :8080", detail: cmd }),
      L({ id: 3, source: "gazelle · bg", kind: "task", level: "error", text: "ERROR upstream closed", detail: cmd }),
    ];
    const [running] = deriveRunning(lines, false);
    expect(running).toEqual({
      source: "gazelle · bg",
      kind: "task",
      running: true,
      lines: 3,
      errors: 1,
      firstMs: T + 1000,
      sinceMs: T + 1000,
      stoppedMs: null,
      reason: null,
      lastId: 3,
      command: "cd /work/gazelle && ./target/debug/gazelle serve",
    });
    const stopped = deriveRunning(
      [...lines, sys("gazelle · bg", "background task stopped · gazelle (b1) — stopped by the agent", { id: 4, detail: cmd })],
      false,
    );
    expect(stopped.map(brief)).toEqual(["gazelle · bg · stopped · task · 4/1 · stopped by the agent"]);
    expect(stopped[0].stoppedMs).toBe(T + 4000);
    expect(stopped[0].lastId).toBe(4);
  });

  it("a task seen only by its output (its start scrolled out or was cleared) is running", () => {
    const out = deriveRunning([L({ source: "gazelle · bg", kind: "task", text: "INFO tick" })], false);
    expect(out.map(brief)).toEqual(["gazelle · bg · running · task · 1/0"]);
    expect(out[0].command).toBeNull();
  });

  it("a task announce without a detail keeps no command", () => {
    const out = deriveRunning([sys("x · bg", "background task started · x (b9)")], false);
    expect(out[0].command).toBeNull();
  });

  it("a terminal: opened → output → exited; reopened → running again; closed → stopped", () => {
    const seq = [
      sys("zsh · gazelle", "terminal opened · zsh in /work/gazelle", { id: 10 }),
      L({ id: 11, source: "zsh · gazelle", text: "ok" }),
      sys("zsh · gazelle", "terminal exited (code 3)", { id: 12, level: "warn" }),
    ];
    expect(deriveRunning(seq, false).map(brief)).toEqual(["zsh · gazelle · stopped · terminal · 3/0 · exited (code 3)"]);
    const again = [...seq, sys("zsh · gazelle", "terminal opened · zsh in /work/gazelle", { id: 13 })];
    const [r] = deriveRunning(again, false);
    expect([r.running, r.sinceMs, r.stoppedMs, r.reason]).toEqual([true, T + 13000, null, null]);
    const closed = [...again, sys("zsh · gazelle", "terminal closed", { id: 14 })];
    expect(deriveRunning(closed, false).map(brief)).toEqual(["zsh · gazelle · stopped · terminal · 5/0 · closed"]);
  });

  it("output after a stop does not resurrect it — only a start does", () => {
    const seq = [
      sys("zsh", "terminal opened · zsh in /", { id: 1 }),
      sys("zsh", "terminal exited (code 0)", { id: 2 }),
      L({ id: 3, source: "zsh", text: "late byte" }),
    ];
    expect(deriveRunning(seq, false).map(brief)).toEqual(["zsh · stopped · terminal · 3/0 · exited (code 0)"]);
  });

  it("any source seen with output and no lifecycle is a running terminal", () => {
    expect(deriveRunning([L({ source: "bash · api" })], false).map(brief)).toEqual(["bash · api · running · terminal · 1/0"]);
  });

  it("an agent: started → tool calls → exited; its terminal shares the label and the chip is the agent", () => {
    const seq = [
      sys("claude · gazelle", "terminal opened · claude in /work/gazelle", { id: 1, terminalId: "t1", agentId: "a1" }),
      sys("claude · gazelle", "agent started · claude in /work/gazelle", { id: 2, terminalId: "t1", agentId: "a1" }),
      L({ id: 3, source: "claude · gazelle", kind: "tool", text: "Bash: cargo run" }),
      L({ id: 4, source: "claude · gazelle", kind: "tool-result", level: "error", text: "Bash → failed" }),
    ];
    expect(deriveRunning(seq, false).map(brief)).toEqual(["claude · gazelle · running · agent · 4/1"]);
    const exited = [...seq, sys("claude · gazelle", "agent exited (code 0)", { id: 5 })];
    expect(deriveRunning(exited, false).map(brief)).toEqual(["claude · gazelle · stopped · agent · 5/1 · exited (code 0)"]);
    // The terminal's own exit, last, still reads as the agent chip stopping.
    const termLast = [...exited, sys("claude · gazelle", "terminal exited (code 0)", { id: 6 })];
    expect(deriveRunning(termLast, false).map(brief)).toEqual([
      "claude · gazelle · stopped · agent · 6/1 · exited (code 0)",
    ]);
  });

  it("a sub-agent seen only through its tool calls is a running agent; finished stops it", () => {
    const seq = [L({ id: 1, source: "Explore parser", kind: "tool", text: "Grep: fn parse" })];
    expect(deriveRunning(seq, false).map(brief)).toEqual(["Explore parser · running · agent · 1/0"]);
    const done = [...seq, sys("Explore parser", "sub-agent finished", { id: 2 })];
    expect(deriveRunning(done, false).map(brief)).toEqual(["Explore parser · stopped · agent · 2/0 · finished"]);
  });

  it("Mac-app sources only while the stream is on", () => {
    const lines = [L({ source: "Safari", kind: "machine", text: "[com.apple.Safari] hi" })];
    expect(deriveRunning(lines, false)).toEqual([]);
    expect(deriveRunning(lines, true).map(brief)).toEqual(["Safari · running · machine · 1/0"]);
  });

  it("a bare hub warning (`logs`) is not a live source; a refused tail's warning alone is not either", () => {
    const lines = [
      sys("logs", "… 3 log lines dropped (log queue full)", { level: "warn" }),
      sys("x · bg", "not tailing background task b1: path outside the Claude temp root", { level: "warn" }),
    ];
    expect(deriveRunning(lines, true)).toEqual([]);
  });

  it("order: running by first appearance (chips do not jump), then stopped, most recently stopped first", () => {
    const lines = [
      sys("a", "terminal opened · a in /", { id: 1 }),
      sys("b", "terminal opened · b in /", { id: 2 }),
      L({ id: 3, source: "c" }),
      sys("a", "terminal closed", { id: 4 }),
      sys("b", "terminal closed", { id: 5 }),
      L({ id: 6, source: "d" }),
      L({ id: 7, source: "c" }), // c logging again must not move it
    ];
    expect(deriveRunning(lines, false).map((s) => s.source)).toEqual(["c", "d", "b", "a"]);
  });
});

describe("visibleRunning — dismissing a stopped chip", () => {
  const s = (source: string, running: boolean, lastId: number) =>
    ({ source, running, lastId }) as unknown as RunningSource;

  it("hides a dismissed stopped source until a newer line of it arrives; a running one is never hidden", () => {
    const all = [s("live", true, 9), s("old", false, 5), s("back", false, 8)];
    expect(visibleRunning(all, {}).map((x) => x.source)).toEqual(["live", "old", "back"]);
    expect(visibleRunning(all, { old: 5, back: 7, live: 9 }).map((x) => x.source)).toEqual(["live", "back"]);
  });
});

describe("agoText + chipTitle", () => {
  it.each([
    [0, "just now"],
    [9_999, "just now"],
    [10_000, "10s ago"],
    [59_000, "59s ago"],
    [60_000, "1 min ago"],
    [59 * 60_000, "59 min ago"],
    [3_600_000, "1 h ago"],
    [23 * 3_600_000, "23 h ago"],
    [48 * 3_600_000, "2 d ago"],
    [-5_000, "just now"], // a clock skew never reads as the future
  ])("%d ms → %s", (dt, want) => expect(agoText(T, T + dt)).toBe(want));

  const base: RunningSource = {
    source: "gazelle · bg", kind: "task", running: false, lines: 6, errors: 1, firstMs: T, sinceMs: T,
    stoppedMs: T + 60_000, reason: "stopped by the agent", lastId: 6, command: "./gazelle serve",
  };

  it("a stopped task: the DISPLAY name (no ` · bg`), `Service`, how long ago, the reason, counts, its command, the click hint", () => {
    expect(chipTitle(base, T + 180_000, "Mac apps")).toBe(
      "gazelle · Service, stopped 2 min ago — stopped by the agent\n6 lines, 1 error\n./gazelle serve\nClick to show only this source",
    );
  });

  it("a running terminal with one line and no errors; a stopped one with no reason; a Mac app", () => {
    const term = { ...base, source: "gazelle", kind: "terminal" as const, running: true, lines: 1, errors: 0, command: null, stoppedMs: null };
    expect(chipTitle(term, T + 30_000, "Mac apps")).toBe(
      "gazelle · Terminal, running — started 30s ago\n1 line\nClick to show only this source",
    );
    const noReason = { ...base, source: "claude · gazelle", kind: "agent" as const, reason: null, errors: 2, command: null };
    expect(chipTitle(noReason, T + 60_000, "Mac apps")).toBe(
      "claude · gazelle · Agent, stopped just now\n6 lines, 2 errors\nClick to show only this source",
    );
    const app = { ...base, source: "Safari", kind: "machine" as const, running: true, command: null };
    expect(chipTitle(app, T, "System apps").split("\n")[0]).toBe("Safari · System apps source, running — started just now");
  });
});

/* ───────────────────────── the sidebar's groups ───────────────────────── */

describe("groupSources / groupLabel — which sidebar group a source lands in", () => {
  // Real-shaped evidence per source; the expected group is written by hand, never read
  // off the derivation.
  it.each<[string, LogLine[], string]>([
    ["a background task's output line → Services", [L({ source: "gazelle · bg", kind: "task", text: "INFO up" })], "Services"],
    ["a task announce alone → Services", [sys("gazelle · bg", "background task started · gazelle (b1)")], "Services"],
    ["a terminal opened line → Terminals", [sys("zsh · repo", "terminal opened · zsh in /repo")], "Terminals"],
    ["plain output with no lifecycle → Terminals", [L({ source: "bash · api", kind: "output" })], "Terminals"],
    ["an agent started line → Agents", [sys("claude · proj", "agent started · claude in /proj")], "Agents"],
    ["a sub-agent started line → Agents", [sys("Explore parser", "sub-agent started (Explore)")], "Agents"],
    ["a tool call alone → Agents", [L({ source: "claude · proj", kind: "tool", text: "Bash: ls" })], "Agents"],
    ["a tool result alone → Agents", [L({ source: "claude · proj", kind: "tool-result", text: "Bash → ok" })], "Agents"],
    [
      "a root agent's terminal shares its label: the agent wins → Agents",
      [sys("claude · proj", "terminal opened · claude in /proj"), L({ source: "claude · proj", kind: "output", text: "redraw" }), sys("claude · proj", "agent started · claude in /proj")],
      "Agents",
    ],
    ["a Mac app line (while streaming) → the machine group", [L({ source: "Safari", kind: "machine", text: "[com.apple.Safari] hi" })], "Mac apps"],
  ])("%s", (_n, lines, want) => {
    const groups = groupSources(deriveRunning(lines, true));
    expect(groups).toHaveLength(1);
    expect(groupLabel(groups[0].kind, "Mac apps")).toBe(want);
  });

  it("orders the groups Services · Terminals · Agents · machine, drops empty ones, keeps each group's running-first order", () => {
    const lines = [
      L({ id: 1, source: "Safari", kind: "machine", text: "x" }),
      sys("claude · proj", "agent started · claude in /proj", { id: 2 }),
      sys("zsh · repo", "terminal opened · zsh in /repo", { id: 3 }),
      sys("gazelle · bg", "background task started · gazelle (b1)", { id: 4 }),
      sys("tail · bg", "background task started · tail (b2)", { id: 5 }),
      sys("gazelle · bg", "background task stopped · gazelle (b1) — stopped by the agent", { id: 6 }),
      L({ id: 7, source: "sublog01", kind: "tool", text: "Grep: x" }),
    ];
    const groups = groupSources(deriveRunning(lines, true));
    expect(groups.map((g) => [groupLabel(g.kind, "System apps"), g.sources.map((s) => `${s.running ? "●" : "○"} ${s.source}`)])).toEqual([
      ["Services", ["● tail · bg", "○ gazelle · bg"]],
      ["Terminals", ["● zsh · repo"]],
      ["Agents", ["● claude · proj", "● sublog01"]],
      ["System apps", ["● Safari"]],
    ]);
    // Machine sources left out (stream off) → no machine group at all.
    expect(groupSources(deriveRunning(lines, false)).map((g) => g.kind)).toEqual(["task", "terminal", "agent"]);
    expect(groupSources([])).toEqual([]);
  });

  it("GROUP_ORDER is the contract's order — Apps FIRST, then Services — and covers every kind exactly once", () => {
    expect(GROUP_ORDER).toEqual(["app", "task", "terminal", "agent", "machine"]);
    expect(groupLabel("task", "Mac apps")).toBe("Services");
    expect(groupLabel("terminal", "Mac apps")).toBe("Terminals");
    expect(groupLabel("agent", "Mac apps")).toBe("Agents");
    expect(groupLabel("machine", "Mac apps")).toBe("Mac apps");
    expect(groupLabel("machine", "System apps")).toBe("System apps");
    // The dev-app group reads like the procs section's own heading — "Apps" on every platform.
    plat.mac = true;
    expect(groupLabel("app", "Mac apps")).toBe("Apps");
    plat.mac = false;
    expect(groupLabel("app", "System apps")).toBe("Apps");
    plat.mac = true;
  });

  it.each<[Parameters<typeof groupSingular>[0], string, string]>([
    ["task", "Mac apps", "service"],
    ["terminal", "Mac apps", "terminal"],
    ["agent", "Mac apps", "agent"],
    ["machine", "Mac apps", "Mac app"],
    ["machine", "System apps", "System app"],
    ["app", "Mac apps", "app log"],
  ])("groupSingular(%s, %s) → %s", (kind, label, want) => expect(groupSingular(kind, label)).toBe(want));
});

/* ───────────────────────── the stream header ───────────────────────── */

describe("streamHeader — what a solo selection says above the list", () => {
  const lines = [
    sys("gazelle · bg", "background task started · gazelle (b1)", { id: 1 }),
    L({ id: 2, source: "gazelle · bg", kind: "task", text: "INFO up" }),
    L({ id: 3, source: "gazelle · bg", kind: "task", level: "error", text: "ERROR one" }),
    sys("tail · bg", "background task started · tail (b2)", { id: 4 }),
    sys("tail · bg", "background task stopped · tail (b2) — no output for 10 min", { id: 5 }),
    sys("zsh · repo", "terminal opened · zsh in /repo", { id: 6 }),
    L({ id: 7, source: "zsh · repo", text: "$ ls" }),
    L({ id: 8, source: "claude · repo", kind: "tool", text: "Bash: ls" }),
    L({ id: 9, source: "claude · repo", kind: "tool-result", level: "error", text: "Bash → boom" }),
    L({ id: 10, source: "claude · repo", kind: "tool-result", level: "error", text: "Bash → boom again" }),
    L({ id: 11, source: "Safari", kind: "machine", text: "[com.apple.Safari] hi" }),
    L({ id: 12, source: "logs", kind: "system", level: "warn", text: "could not tail /x" }),
  ];

  // Expected text written by hand per group and state.
  it.each<[string, string, string]>([
    ["gazelle · bg", "Mac apps", "gazelle · service · ● running · 3 lines · 1 error"],
    ["tail · bg", "Mac apps", "tail · service · ○ stopped · 2 lines"],
    ["zsh · repo", "Mac apps", "zsh · repo · terminal · ● running · 2 lines"],
    ["claude · repo", "Mac apps", "claude · repo · agent · ● running · 3 lines · 2 errors"],
    // A Mac app is listed whether or not the stream is on — a toolbar pick can name it.
    ["Safari", "Mac apps", "Safari · Mac app · ● running · 1 line"],
    ["Safari", "System apps", "Safari · System app · ● running · 1 line"],
    // A source with no live evidence (a hub warning): no group, no state — its counts only.
    ["logs", "Mac apps", "logs · 1 line"],
    // A source with no lines at all (a pick that outlived a Clear).
    ["gone · bg", "Mac apps", "gone · 0 lines"],
  ])("%s under %s → %j", (source, machine, text) => {
    expect(streamHeader(source, lines, machine).text).toBe(text);
  });

  it("carries the parts the header renders from: the wire key, the display name, kind, state, counts", () => {
    expect(streamHeader("gazelle · bg", lines, "Mac apps")).toEqual({
      source: "gazelle · bg",
      name: "gazelle",
      kind: "service",
      running: true,
      lines: 3,
      errors: 1,
      text: "gazelle · service · ● running · 3 lines · 1 error",
    });
    expect(streamHeader("logs", lines, "Mac apps")).toMatchObject({ kind: null, running: null, lines: 1, errors: 0 });
  });

  it.each<[number, number, string[]]>([
    [0, 0, ["0 lines"]],
    [1, 0, ["1 line"]],
    [2, 0, ["2 lines"]],
    [2, 1, ["2 lines", "1 error"]],
    [5, 3, ["5 lines", "3 errors"]],
  ])("countParts(%d, %d) → %j", (l, e, want) => expect(countParts(l, e)).toEqual(want));
});

/* ───────────────────────── the toolbar's source picker ───────────────────────── */

describe("sourcePickerItems — grouped like the sidebar, Services first", () => {
  const lines = [
    L({ id: 1, source: "Safari", kind: "machine", text: "x" }),
    sys("claude · proj", "agent started · claude in /proj", { id: 2 }),
    sys("zsh · repo", "terminal opened · zsh in /repo", { id: 3 }),
    sys("gazelle · bg", "background task started · gazelle (b1)", { id: 4 }),
    sys("tail · bg", "background task started · tail (b2)", { id: 5 }),
    sys("gazelle · bg", "background task stopped · gazelle (b1) — stopped by the agent", { id: 6 }),
    L({ id: 7, source: "sublog01", kind: "tool", text: "Grep: x" }),
    L({ id: 8, source: "logs", kind: "system", level: "warn", text: "could not tail /x" }),
  ];
  const sources = ["claude · proj", "gazelle · bg", "logs", "Safari", "sublog01", "tail · bg", "zsh · repo"];

  it("Services → Terminals → Agents → Mac apps, each row's sublabel its group; ids are the wire labels, labels the display names", () => {
    expect(sourcePickerItems(sources, deriveRunning(lines, true), "Mac apps")).toEqual([
      { id: "tail · bg", label: "tail", sublabel: "Services" },
      { id: "gazelle · bg", label: "gazelle", sublabel: "Services" },
      { id: "zsh · repo", label: "zsh · repo", sublabel: "Terminals" },
      { id: "claude · proj", label: "claude · proj", sublabel: "Agents" },
      { id: "sublog01", label: "sublog01", sublabel: "Agents" },
      { id: "Safari", label: "Safari", sublabel: "Mac apps" },
      // Not a live source (a hub warning only): last, ungrouped, still pickable.
      { id: "logs", label: "logs" },
    ]);
  });

  it("the machine group's sublabel follows the backend; a source list with nothing derived is just labels", () => {
    const items = sourcePickerItems(sources, deriveRunning(lines, true), "System apps");
    expect(items.find((i) => i.id === "Safari")?.sublabel).toBe("System apps");
    expect(sourcePickerItems(["b · bg", "a"], [], "Mac apps")).toEqual([
      { id: "b · bg", label: "b" },
      { id: "a", label: "a" },
    ]);
  });
});

describe("matchCountsBySource — per-source counts while a content filter is active", () => {
  const lines = [
    L({ id: 1, source: "gazelle · bg", kind: "task", text: "INFO listening on :8080" }),
    L({ id: 2, source: "gazelle · bg", kind: "task", level: "error", text: "ERROR upstream closed" }),
    L({ id: 3, source: "zsh", text: "curl localhost:8080/health" }),
    L({ id: 4, source: "zsh", level: "debug", text: "trace" }),
    L({ id: 5, source: "claude · proj", kind: "tool", text: "Bash: ls", detail: "list the health dir" }),
  ];

  it("null with no content filter — even under a source pick", () => {
    expect(matchCountsBySource(lines, defaultFilter())).toBeNull();
    expect(matchCountsBySource(lines, { ...defaultFilter(), onlySources: ["zsh"] })).toBeNull();
  });

  it("a query counts each source's hits (detail included), IGNORING the source pick; a source with none is absent", () => {
    const f = { ...defaultFilter(), query: "health", onlySources: ["gazelle · bg"] };
    expect([...(matchCountsBySource(lines, f) as Map<string, number>)]).toEqual([
      ["zsh", 1],
      ["claude · proj", 1],
    ]);
  });

  it("a level off counts what remains", () => {
    const f = { ...defaultFilter(), levels: { error: true, warn: false, info: false, debug: false } };
    expect([...(matchCountsBySource(lines, f) as Map<string, number>)]).toEqual([["gazelle · bg", 1]]);
  });

  it("IDE off still applies (it is not a content filter, but it is part of the view)", () => {
    const f = { ...defaultFilter(), query: "/./", ide: false };
    expect((matchCountsBySource(lines, f) as Map<string, number>).size).toBe(0);
  });
});

describe("queryMatcher", () => {
  it("null for an empty or invalid query; a matcher otherwise", () => {
    expect(queryMatcher("")).toBeNull();
    expect(queryMatcher("/(/")).toBeNull();
    const m = queryMatcher("Health") as (s: string) => boolean;
    expect([m("curl /health"), m("nope")]).toEqual([true, false]);
  });
});

/* ───────────────────────── dev apps' streams ───────────────────────── */

describe("deriveRunning — a dev app's log stream (`app` lines)", () => {
  const lines = [
    sys("web · server.log", "app log started · web · server.log", { id: 1 }),
    L({ id: 2, source: "web · server.log", kind: "app", text: "GET / 200" }),
    L({ id: 3, source: "web · server.log", kind: "app", level: "error", text: "ERROR boom" }),
    sys("pg · docker", "app log started · pg · docker", { id: 4 }),
    sys("pg · docker", "app log stopped · pg · docker — the container stopped", { id: 5 }),
    // A tail whose start scrolled out of the ring: its lines alone say it is running.
    L({ id: 6, source: "api · out.log", kind: "app", text: "INFO up" }),
  ];

  it("is an `app` source: started → running with its counts; stopped → stopped with the reason — listed with the system-apps stream OFF", () => {
    expect(deriveRunning(lines, false).map(brief)).toEqual([
      "web · server.log · running · app · 3/1",
      "api · out.log · running · app · 1/0",
      "pg · docker · stopped · app · 2/0 · the container stopped",
    ]);
  });

  it("groups last, under the dev-app heading; the stream header and the tooltip name it", () => {
    const all = deriveRunning(lines, false);
    expect(groupSources(all).map((g) => g.kind)).toEqual(["app"]);
    expect(streamHeader("web · server.log", lines, "Mac apps").text).toBe("web · server.log · app log · ● running · 3 lines · 1 error");
    expect(chipTitle(all[0], T + 1000, "Mac apps").split("\n")[0]).toBe("web · server.log · Dev app log, running — started just now");
  });

  it("the picker lists it under the same heading", () => {
    plat.mac = true;
    const items = sourcePickerItems(["web · server.log"], deriveRunning(lines, false), "Mac apps");
    expect(items.find((i) => i.id === "web · server.log")?.sublabel).toBe("Apps");
  });
});

describe("a renamed terminal in the stream header and the source picker", () => {
  const src = "bash · workspace";
  const renamed = new Map([[src, "gazelle"]]);
  const one = [L({ source: src, terminalId: "t1", kind: "output" })];

  it("the header is named by the live title; the key stays the spawn label", () => {
    const h = streamHeader(src, one, "Mac apps", renamed);
    expect([h.source, h.name]).toEqual([src, "gazelle"]);
    expect(h.text.startsWith("gazelle · ")).toBe(true);
  });

  it("the picker's rows are labelled by it, grouped or not", () => {
    const items = sourcePickerItems([src, "stray"], deriveRunning(one, true), "Mac apps", new Map([...renamed, ["stray", "Stray"]]));
    expect(items.map((i) => [i.id, i.label])).toEqual([
      [src, "gazelle"],
      ["stray", "Stray"],
    ]);
  });
});
