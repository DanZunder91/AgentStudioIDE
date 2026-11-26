/** The hook's side doors (log stream, external scan) are mocked at their feature-local IPC modules
 * (the `bridge.test.ts` convention); the store is the real one. */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => {
  const state = {
    handler: null as ((lines: unknown[]) => void) | null,
    unlisten: vi.fn(),
    // The next subscription's outcome; reset per test.
    mode: "ok" as "ok" | "reject" | "defer",
    release: null as (() => void) | null,
    // The ring's history (`logstream_snapshot`): its lines, or a failure; "defer" holds it until `settle`.
    snapshot: [] as unknown[],
    snapshotMode: "ok" as "ok" | "reject" | "defer",
    settle: null as ((ok: boolean) => void) | null,
  };
  const logstreamSnapshot = vi.fn(() => {
    if (state.snapshotMode === "reject") return Promise.reject(new Error("no ring"));
    if (state.snapshotMode === "defer")
      return new Promise<unknown[]>((resolve, reject) => {
        state.settle = (ok) => (ok ? resolve(state.snapshot) : reject(new Error("no ring")));
      });
    return Promise.resolve(state.snapshot);
  });
  const onLogstreamLines = vi.fn((h: (lines: unknown[]) => void) => {
    state.handler = h;
    if (state.mode === "reject") return Promise.reject(new Error("no stream"));
    if (state.mode === "defer") {
      return new Promise<() => void>((resolve) => {
        state.release = () => resolve(state.unlisten);
      });
    }
    return Promise.resolve(state.unlisten);
  });
  return { state, onLogstreamLines, logstreamSnapshot };
});

const scan = vi.hoisted(() => ({ listExternalAgents: vi.fn() }));

vi.mock("../agentlogs/logstreamIpc", () => ({
  onLogstreamLines: logs.onLogstreamLines,
  logstreamSnapshot: logs.logstreamSnapshot,
}));
vi.mock("./villageIpc", async (importOriginal) => {
  const real = await importOriginal<typeof import("./villageIpc")>();
  return { ...real, listExternalAgents: scan.listExternalAgents };
});

import { useAppStore } from "../../app/store";
import { detectLanguage } from "../../lib/language";
import type { AgentId, AgentNode, AgentStatus } from "../../app/types";
import type { LogLine } from "../agentlogs/agentLogsTypes";
import projectLanguages from "./projectLanguages.json";
import {
  activityForTool,
  countExternalCalls,
  countLanguages,
  countToolLines,
  folderOf,
  fromExternal,
  fromIdeAgents,
  languageOfLogText,
  languageOfPath,
  mergeAgents,
  toolFromLogText,
  treeLanguages,
  useVillageAgents,
} from "./villageModel";
import type { ExternalAgentWire, ExternalAgentsReport, VillageAgent } from "./villageTypes";

function node(id: string, extra: Partial<AgentNode> = {}): AgentNode {
  return {
    id: id as AgentId,
    parentId: null,
    kind: "orchestrator",
    title: `t-${id}`,
    status: "running",
    branch: "main",
    cwd: "/w/gazelle",
    runtime: "claude-code",
    startedAt: 1,
    finishedAt: null,
    lastActivityAt: 100,
    childIds: [],
    sessionId: null,
    expanded: true,
    unread: 0,
    ...extra,
  };
}

function ext(key: string, extra: Partial<ExternalAgentWire> = {}): ExternalAgentWire {
  return {
    key,
    parentKey: null,
    title: "claude",
    folder: "other",
    activity: "idle",
    tool: null,
    lastActivityMs: 500,
    alive: null,
    host: null,
    language: null,
    ...extra,
  };
}

function va(key: string, parentKey: string | null = null): VillageAgent {
  return {
    key,
    parentKey,
    origin: "external",
    title: key,
    folder: "f",
    activity: "idle",
    tool: null,
    ideAgentId: null,
    lastActivityAt: null,
  };
}

function line(agentId: string | null, text: string, kind: LogLine["kind"] = "tool", id = 1): LogLine {
  return {
    id,
    tsMs: 1,
    terminalId: null,
    agentId,
    source: "claude",
    kind,
    level: "info",
    text,
    detail: null,
    toolUseId: null,
  } as LogLine;
}

describe("activityForTool", () => {
  it("reads for look-up tools, types for everything else, thinks with no tool", () => {
    for (const t of ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]) {
      expect(activityForTool(t)).toBe("reading");
    }
    expect(activityForTool("Edit")).toBe("typing");
    expect(activityForTool("Bash")).toBe("typing");
    expect(activityForTool("Task")).toBe("typing");
    expect(activityForTool(null)).toBe("thinking");
  });
});

describe("folderOf / toolFromLogText", () => {
  it("takes the basename across separators and trailing slashes", () => {
    expect(folderOf("/w/gazelle")).toBe("gazelle");
    expect(folderOf("/w/gazelle/")).toBe("gazelle");
    expect(folderOf("C:\\code\\proj")).toBe("proj");
    expect(folderOf("/")).toBe("/");
    expect(folderOf("")).toBe("");
  });

  it("keeps only the tool name, never its arguments", () => {
    expect(toolFromLogText("Edit: /a/b.ts")).toBe("Edit");
    expect(toolFromLogText("Bash: cargo test --secret=x")).toBe("Bash");
    expect(toolFromLogText("TodoWrite")).toBe("TodoWrite");
    expect(toolFromLogText("  ")).toBeNull();
    expect(toolFromLogText(": nothing")).toBeNull();
  });
});

describe("fromIdeAgents", () => {
  it("maps every status, in forest order, with sub-agents under their parent", () => {
    const agents: Record<string, AgentNode> = {
      r1: node("r1", { childIds: ["s1" as AgentId, "ghost" as AgentId], customTitle: "Mine" }),
      s1: node("s1", { kind: "subagent", parentId: "r1" as AgentId, childIds: ["s2" as AgentId] }),
      s2: node("s2", { status: "done", cwd: "/w/gazelle/sub" }),
      r2: node("r2", { status: "waiting_input", customTitle: null, cwd: "/x/other/" }),
      r3: node("r3", { status: "idle" }),
      r4: node("r4", { status: "error" }),
    };
    const out = fromIdeAgents(
      agents,
      ["r1", "r2", "r3", "r4", "missing"],
      { r1: "Read", s1: "Edit", s2: "Bash" },
      { r1: 4, s2: 7, ghost: 9 },
    );

    expect(out.map((a) => a.key)).toEqual(["r1", "s1", "s2", "r2", "r3", "r4"]);
    expect(out[0]).toEqual({
      key: "r1",
      parentKey: null,
      origin: "ide",
      title: "Mine",
      folder: "gazelle",
      activity: "reading",
      tool: "Read",
      ideAgentId: "r1",
      lastActivityAt: 100,
      toolCalls: 4,
      language: null,
    });
    expect(out[1]).toMatchObject({ parentKey: "r1", activity: "typing", tool: "Edit" });
    // Tool calls per agent, sub-agents too; one with no counted line has made none SEEN (0, not unknown).
    expect(out.map((a) => [a.key, a.toolCalls])).toEqual([
      ["r1", 4],
      ["s1", 0],
      ["s2", 7],
      ["r2", 0],
      ["r3", 0],
      ["r4", 0],
    ]);
    // Finished: the activity is the status, the last tool is still reported.
    expect(out[2]).toMatchObject({ parentKey: "s1", activity: "done", folder: "sub", tool: "Bash" });
    expect(out[3]).toMatchObject({ activity: "waiting", title: "t-r2", folder: "other", tool: null });
    expect(out[4].activity).toBe("idle");
    expect(out[5].activity).toBe("error");
  });

  it("a running agent with no known tool is thinking; a cycle is visited once", () => {
    const agents: Record<string, AgentNode> = {
      a: node("a", { childIds: ["b" as AgentId] }),
      b: node("b", { childIds: ["a" as AgentId] }),
    };
    const out = fromIdeAgents(agents, ["a", "b"], {}, {});
    expect(out.map((x) => [x.key, x.activity])).toEqual([
      ["a", "thinking"],
      ["b", "thinking"],
    ]);
  });
});

describe("fromExternal", () => {
  it("namespaces keys, maps parents the same way and decides running by tool", () => {
    const report: ExternalAgentsReport = {
      agents: [
        ext("root", { activity: "running", tool: "Grep", alive: true, host: "iTerm2" }),
        ext("kid", { parentKey: "root", activity: "running", tool: null, host: "iTerm2" }),
        ext("w", { activity: "waiting" }),
        ext("gone", { activity: "idle", alive: false }),
        ext("d", { activity: "done" }),
        ext("e", { activity: "error", tool: "Bash" }),
      ],
      scannedAtMs: 9,
    };
    const out = fromExternal(report, {});
    expect(out[0]).toEqual({
      key: "ext:root",
      parentKey: null,
      origin: "external",
      title: "claude",
      folder: "other",
      activity: "reading",
      tool: "Grep",
      ideAgentId: null,
      lastActivityAt: 500,
      host: "iTerm2",
      language: null,
    });
    expect(out[1]).toMatchObject({ key: "ext:kid", parentKey: "ext:root", activity: "thinking", host: "iTerm2" });
    expect(out[2].host).toBeNull();
    expect(out.slice(2).map((a) => a.activity)).toEqual(["waiting", "idle", "done", "error"]);
  });

  it("carries each agent's counted tool calls by wire key; one with no count has none known", () => {
    const report: ExternalAgentsReport = { agents: [ext("a"), ext("b", { parentKey: "a" })], scannedAtMs: 1 };
    const out = fromExternal(report, { a: { lastMs: 500, calls: 3 }, "ext:b": { lastMs: 500, calls: 8 } });
    expect(out[0].toolCalls).toBe(3);
    // Keyed by the WIRE key, never the namespaced one — and absent means unknown, not 0.
    expect(out[1].toolCalls).toBeUndefined();
  });
});

describe("languages — the City's neon signs", () => {
  it("languageOfPath votes by extension only — the twin of Rust's language_of_path, case for case", () => {
    expect(languageOfPath("/w/gazelle/src/main.rs")).toBe("rust");
    expect(languageOfPath("C:\\code\\App.TSX")).toBe("typescript");
    expect(languageOfPath("src/types.d.ts")).toBe("typescript");
    expect(languageOfPath("main.go")).toBe("go");
    for (const none of [
      "/w/gazelle/README.md", // docs never vote
      "/w/gazelle/Cargo.toml",
      "/w/gazelle/Makefile", // no extension
      "/w/gazelle/src", // a directory
      "/w/gazelle/.rs", // a dotfile, not a Rust file
      "C:\\w\\.rs", // …on Windows too: the basename is after the LAST separator of either kind
      "/w/gazelle/x.rs/", // a trailing separator: nothing after it
      "/w/archive.tar.gz",
      "/w/x.constructor", // never a prototype key
      "",
    ])
      expect(languageOfPath(none), none).toBeNull();
  });

  it("the shared table agrees with the editor's own detection (src/lib/language), families folded", () => {
    const fold: Record<string, string> = { tsx: "typescript", jsx: "javascript", "objective-cpp": "objective-c" };
    const rows = Object.entries(projectLanguages.extensions);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    for (const [ext, lang] of rows) {
      const detected = detectLanguage(`x.${ext}`);
      expect(fold[detected] ?? detected, ext).toBe(lang);
      expect(languageOfPath(`/w/x.${ext}`), ext).toBe(lang);
    }
  });

  it("languageOfLogText reads the file of a file tool's Agent Logs line, and nothing else", () => {
    expect(languageOfLogText("Edit: /w/gazelle/src/lib.rs")).toBe("rust");
    expect(languageOfLogText("Read: C:\\code\\App.tsx")).toBe("typescript");
    expect(languageOfLogText("Write: /w/a: b/c.py")).toBe("python");
    expect(languageOfLogText("MultiEdit: /w/m.go")).toBe("go");
    expect(languageOfLogText("NotebookEdit: /w/n.jl")).toBe("julia");
    expect(languageOfLogText("Bash: cat /w/x.rs")).toBeNull(); // not a file tool
    expect(languageOfLogText("Grep: *.rs")).toBeNull(); // a pattern, not a path
    expect(languageOfLogText("Edit: /w/notes.md")).toBeNull();
    expect(languageOfLogText("Read")).toBeNull();
    // Only the path is judged, never the tool name before it: a bare dotfile is no Rust file.
    expect(languageOfLogText("Edit: .rs")).toBeNull();
    expect(languageOfLogText("  ")).toBeNull();
  });

  it("countLanguages: each known agent's votes, each line once, from tool lines only", () => {
    const known = (id: string) => id !== "ghost";
    const { votes, lastId } = countLanguages(
      [
        line("r", "Edit: /a/1.rs", "tool", 3),
        line("r", "Read: /a/2.rs", "tool", 1),
        line("r", "Read: /a/2.rs", "tool", 1), // a duplicate in the batch
        line("s", "Write: /a/x.ts", "tool", 4),
        line("s", "Read: /a/README.md", "tool", 5), // does not vote
        line("s", "Read: /a/y.ts", "tool-result", 6), // not a call
        line(null, "Read: /a/z.ts", "tool", 7), // no agent
        line("ghost", "Read: /a/z.ts", "tool", 8), // not in the fleet
        line("r", "Read: /a/old.py", "tool", 0), // at or before the cursor
      ],
      0,
      known,
    );
    expect(votes).toEqual({ r: { rust: 2 }, s: { typescript: 1 } });
    expect(lastId).toBe(8);
    // Nothing past the cursor: nothing counted, the cursor stays.
    expect(countLanguages([line("r", "Edit: /a/1.rs", "tool", 8)], 8, known)).toEqual({ votes: {}, lastId: 8 });
  });

  it("treeLanguages: a tree's votes summed, its winner on the root and every agent under it", () => {
    const agents: Record<string, AgentNode> = {
      r1: node("r1", { childIds: ["s1" as AgentId, "gone" as AgentId] }),
      s1: node("s1", { childIds: ["s2" as AgentId] }),
      s2: node("s2"),
      r2: node("r2", { childIds: ["t1" as AgentId] }),
      t1: node("t1"),
      r3: node("r3"),
      a: node("a", { childIds: ["b" as AgentId] }),
      b: node("b", { childIds: ["a" as AgentId] }),
      // A child listed under two roots (never in a healthy forest): it belongs to the first, as in `fromIdeAgents`.
      d1: node("d1", { childIds: ["shared" as AgentId] }),
      d2: node("d2", { childIds: ["shared" as AgentId] }),
      shared: node("shared"),
    };
    const votes = {
      r1: { typescript: 2 },
      s1: { rust: 1 },
      s2: { rust: 2 }, // a nested sub-agent's work counts for the tree: rust 3 beats typescript 2
      r2: { go: 1 },
      t1: { python: 1 }, // a tie goes to the first id in code-unit order
      a: { zig: 1 },
      b: { zig: 1 },
      d1: { rust: 1 },
      d2: { go: 1 },
      nobody: { c: 9 },
    };
    expect(treeLanguages(agents, ["r1", "r2", "r3", "a", "b", "missing", "d1", "d2"], votes)).toEqual({
      r1: "rust",
      s1: "rust",
      s2: "rust",
      r2: "go",
      t1: "go",
      // r3: no vote — absent. A cycle is visited once; "b" was already in "a"'s tree.
      a: "zig",
      b: "zig",
      d1: "rust",
      shared: "rust",
      d2: "go",
    });
  });

  it("fromIdeAgents and fromExternal carry each agent's language (null = unknown)", () => {
    const agents = { r: node("r", { childIds: ["s" as AgentId] }), s: node("s"), q: node("q") };
    const out = fromIdeAgents(agents, ["r", "q"], {}, {}, { r: "rust", s: "rust" });
    expect(out.map((a) => [a.key, a.language])).toEqual([
      ["r", "rust"],
      ["s", "rust"],
      ["q", null],
    ]);
    expect(fromIdeAgents(agents, ["q"], {}, {})[0].language).toBeNull();
    const report: ExternalAgentsReport = { agents: [ext("a", { language: "go" }), ext("b")], scannedAtMs: 1 };
    expect(fromExternal(report, {}).map((a) => a.language)).toEqual(["go", null]);
  });
});

describe("countToolLines", () => {
  const all = () => true;
  const seq = (agentId: string | null, id: number, kind: LogLine["kind"] = "tool") => line(agentId, "Edit: /x", kind, id);

  it("counts every tool line per (sub-)agent, and nothing else", () => {
    const { counts, lastId } = countToolLines(
      [
        seq("r", 1),
        seq("s", 2),
        seq("r", 3),
        seq("r", 4, "tool-result"), // a result is not a new call
        seq("r", 5, "output"),
        seq(null, 6), // no agent
        line("s", "  ", "tool", 7), // a tool line with no name is still a call
      ],
      0,
      all,
    );
    expect(counts).toEqual({ r: 2, s: 2 });
    expect(lastId).toBe(7);
  });

  it("never counts a line twice: a replayed one, a duplicate in the batch — and orders the batch first", () => {
    // Past the high-water mark only; the mark moves on every line, tool or not.
    const a = countToolLines([seq("r", 3), seq("r", 5, "output")], 4, all);
    expect(a).toEqual({ counts: {}, lastId: 5 });
    // A duplicate inside one batch counts once.
    expect(countToolLines([seq("r", 6), seq("r", 6)], 5, all).counts).toEqual({ r: 1 });
    // Out of order inside a batch: both count (a plain walk would drop the 8 after the 9).
    expect(countToolLines([seq("r", 9), seq("r", 8)], 5, all)).toEqual({ counts: { r: 2 }, lastId: 9 });
    // The first line of a run with id 0 counts from the initial mark.
    expect(countToolLines([seq("r", 0)], -Infinity, all).counts).toEqual({ r: 1 });
  });

  it("ignores lines of agents the fleet does not know — but still moves the mark past them", () => {
    const out = countToolLines([seq("ghost", 1), seq("r", 2)], 0, (id) => id === "r");
    expect(out).toEqual({ counts: { r: 1 }, lastId: 2 });
  });
});

describe("countExternalCalls", () => {
  const scanOf = (...agents: ExternalAgentWire[]): ExternalAgentsReport => ({ agents, scannedAtMs: 1 });

  it("starts every agent at 0, and counts ONE call per scan where its transcript moved with a tool pending", () => {
    const first = countExternalCalls({}, scanOf(ext("a", { tool: "Edit", lastActivityMs: 100 })));
    expect(first).toEqual({ a: { lastMs: 100, calls: 0 } });
    // Moved, with a tool pending: one call — however far it moved (several calls between polls are one).
    const second = countExternalCalls(first, scanOf(ext("a", { tool: "Bash", lastActivityMs: 9000 })));
    expect(second).toEqual({ a: { lastMs: 9000, calls: 1 } });
    // Same tool, moved again: another call (consecutive Reads look alike).
    const third = countExternalCalls(second, scanOf(ext("a", { tool: "Bash", lastActivityMs: 9001 })));
    expect(third.a.calls).toBe(2);
  });

  it("counts nothing when the transcript did not move, or moved with no tool pending", () => {
    const base = { a: { lastMs: 100, calls: 5 }, b: { lastMs: 100, calls: 2 } };
    const out = countExternalCalls(
      base,
      scanOf(
        ext("a", { tool: "Edit", lastActivityMs: 100 }), // a tool, but nothing new written
        ext("b", { tool: null, activity: "running", lastActivityMs: 200 }), // thinking: no call visible
      ),
    );
    expect(out).toEqual({ a: { lastMs: 100, calls: 5 }, b: { lastMs: 200, calls: 2 } });
  });

  it("never counts a pending sub-agent launch: the parent's clock moves with its sub-agents' writes", () => {
    const base = { r: { lastMs: 100, calls: 1 } };
    for (const tool of ["Agent", "Task", "Workflow"]) {
      const out = countExternalCalls(base, scanOf(ext("r", { tool, activity: "running", lastActivityMs: 500 })));
      expect(out.r).toEqual({ lastMs: 500, calls: 1 });
    }
  });

  it("forgets an agent missing from a scan; one coming back starts at 0", () => {
    const base = { a: { lastMs: 100, calls: 4 }, gone: { lastMs: 100, calls: 9 } };
    const out = countExternalCalls(base, scanOf(ext("a", { lastActivityMs: 100 })));
    expect(Object.keys(out)).toEqual(["a"]);
    const back = countExternalCalls(out, scanOf(ext("gone", { tool: "Edit", lastActivityMs: 900 })));
    expect(back).toEqual({ gone: { lastMs: 900, calls: 0 } });
  });
});

describe("mergeAgents", () => {
  it("keeps IDE order, then external parents before children, siblings by key", () => {
    const ide = [va("z"), va("a")];
    const extern = [
      va("ext:c2", "ext:b"),
      va("ext:b"),
      va("ext:c1", "ext:b"),
      va("ext:a"),
      va("ext:orphan", "ext:missing"),
      va("ext:self", "ext:self"),
    ];
    expect(mergeAgents(ide, extern).map((a) => a.key)).toEqual([
      "z",
      "a",
      "ext:a",
      "ext:b",
      "ext:c1",
      "ext:c2",
      "ext:orphan",
      "ext:self",
    ]);
  });

  it("drops duplicate keys, keeping the first", () => {
    const first = { ...va("ext:a"), title: "first" };
    const out = mergeAgents([va("x"), va("x")], [first, va("ext:a"), va("ext:k", "ext:a")]);
    expect(out.map((a) => a.key)).toEqual(["x", "ext:a", "ext:k"]);
    expect(out[1].title).toBe("first");
  });

  it("is deterministic regardless of the scan's order", () => {
    const one = mergeAgents([], [va("ext:b"), va("ext:a")]).map((a) => a.key);
    const two = mergeAgents([], [va("ext:a"), va("ext:b")]).map((a) => a.key);
    expect(one).toEqual(two);
  });
});

// ─────────────────────────── the hook ───────────────────────────

function setFleet(agents: Record<string, AgentNode>, roots: string[]): void {
  useAppStore.setState((s) => {
    s.agents = agents as Record<AgentId, AgentNode>;
    s.rootAgentIds = roots as AgentId[];
  });
}

function setStatus(id: string, status: AgentStatus): void {
  useAppStore.setState((s) => {
    s.agents[id as AgentId].status = status;
  });
}

function setVisibility(v: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

const REPORT: ExternalAgentsReport = {
  agents: [ext("k1", { activity: "running", tool: "Edit" })],
  scannedAtMs: 4242,
};

/** Let resolved promises run their callbacks. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useVillageAgents", () => {
  beforeEach(() => {
    logs.state.mode = "ok";
    logs.state.handler = null;
    logs.state.release = null;
    logs.state.snapshot = [];
    logs.state.snapshotMode = "ok";
    logs.state.settle = null;
    logs.logstreamSnapshot.mockClear();
    logs.state.unlisten.mockClear();
    logs.onLogstreamLines.mockClear();
    scan.listExternalAgents.mockReset();
    setVisibility("visible");
    setFleet({}, []);
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("lists IDE agents from the store, follows tools from the log stream, and unsubscribes", async () => {
    setFleet({ r: node("r", { childIds: ["s" as AgentId] }), s: node("s") }, ["r"]);
    const { result, unmount } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();

    expect(result.current.agents.map((a) => [a.key, a.activity])).toEqual([
      ["r", "thinking"],
      ["s", "thinking"],
    ]);
    expect(result.current.externalError).toBeNull();
    expect(result.current.lastScanAt).toBeNull();
    expect(scan.listExternalAgents).not.toHaveBeenCalled();

    act(() => {
      logs.state.handler!([
        line("r", "Bash: ls"),
        line("r", "Read: /a"), // later line wins
        line("s", "Edit: /b"),
        line(null, "Grep: x"), // no agent: ignored
        line("s", "Read: /c", "tool-result"), // not a tool call: ignored
        line("r", "  "), // no tool name: ignored
      ]);
    });
    expect(result.current.agents.map((a) => [a.key, a.activity, a.tool])).toEqual([
      ["r", "reading", "Read"],
      ["s", "typing", "Edit"],
    ]);

    // A batch with nothing usable does not re-render into a new state.
    const before = result.current.agents;
    act(() => logs.state.handler!([line(null, "Bash: x")]));
    expect(result.current.agents).toBe(before);

    unmount();
    expect(logs.state.unlisten).toHaveBeenCalledTimes(1);
  });

  it("forgets a tool when the turn ends, and ignores late tool lines for a finished agent", async () => {
    setFleet({ r: node("r"), q: node("q") }, ["r", "q"]);
    const { result } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    act(() => logs.state.handler!([line("r", "Edit: /a"), line("q", "Read: /b")]));
    expect(result.current.agents[0].tool).toBe("Edit");

    // Waiting for permission keeps the tool (the turn is not over).
    act(() => setStatus("r", "waiting_input"));
    expect(result.current.agents[0]).toMatchObject({ activity: "waiting", tool: "Edit" });

    act(() => setStatus("r", "idle"));
    expect(result.current.agents[0]).toMatchObject({ activity: "idle", tool: null });
    expect(result.current.agents[1].tool).toBe("Read");

    // The transcript tail lags the hook: a tool line that arrives after the turn ended
    // must not stick to the agent's next turn.
    act(() => logs.state.handler!([line("r", "Bash: late"), line("ghost", "Edit: /x")]));
    act(() => setStatus("r", "running"));
    expect(result.current.agents[0]).toMatchObject({ activity: "thinking", tool: null });
  });

  it("counts each agent's tool calls across batches — sub-agents too, each line once, a finished turn's too", async () => {
    setFleet({ r: node("r", { childIds: ["s" as AgentId] }), s: node("s") }, ["r"]);
    const { result } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    const calls = () => result.current.agents.map((a) => [a.key, a.toolCalls]);
    expect(calls()).toEqual([
      ["r", 0],
      ["s", 0],
    ]);

    act(() => logs.state.handler!([line("r", "Bash: ls", "tool", 1), line("s", "Edit: /a", "tool", 2), line("r", "Read: /b", "tool", 3)]));
    expect(calls()).toEqual([
      ["r", 2],
      ["s", 1],
    ]);

    // A replayed line (an id already seen) is not a new call; the new one in the same batch is.
    act(() => logs.state.handler!([line("r", "Read: /b", "tool", 3), line("s", "Grep: x", "tool", 4)]));
    expect(calls()).toEqual([
      ["r", 2],
      ["s", 2],
    ]);

    // The turn is over, but the line trailing it is a call that happened: it counts (its tool does not stick).
    act(() => setStatus("s", "done"));
    act(() => logs.state.handler!([line("s", "Bash: late", "tool", 5), line("ghost", "Edit: /x", "tool", 6)]));
    expect(result.current.agents[1]).toMatchObject({ activity: "done", tool: null, toolCalls: 3 });
    expect(result.current.agents.map((a) => a.key)).toEqual(["r", "s"]);

    // An unknown agent's lines were never counted: when it joins the fleet it starts at 0.
    act(() => setFleet({ ...useAppStore.getState().agents, ghost: node("ghost") } as Record<string, AgentNode>, ["r", "ghost"]));
    expect(result.current.agents.find((a) => a.key === "ghost")?.toolCalls).toBe(0);
  });

  it("survives a log stream that cannot be subscribed to", async () => {
    logs.state.mode = "reject";
    setFleet({ r: node("r") }, ["r"]);
    const { result, unmount } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    expect(result.current.agents[0].activity).toBe("thinking");
    unmount();
    expect(logs.state.unlisten).not.toHaveBeenCalled();
  });

  it("releases a subscription that resolves only after unmount", async () => {
    logs.state.mode = "defer";
    const { unmount } = renderHook(() => useVillageAgents({ includeExternal: false }));
    unmount();
    expect(logs.state.unlisten).not.toHaveBeenCalled();
    logs.state.release!();
    await flush();
    expect(logs.state.unlisten).toHaveBeenCalledTimes(1);
  });

  it("polls the external scan every pollMs while visible, merging it after the IDE agents", async () => {
    vi.useFakeTimers();
    scan.listExternalAgents.mockResolvedValue(REPORT);
    setFleet({ r: node("r") }, ["r"]);
    const { result, unmount } = renderHook(() =>
      useVillageAgents({ includeExternal: true, pollMs: 1000 }),
    );
    await flush();

    expect(scan.listExternalAgents).toHaveBeenCalledTimes(1);
    expect(scan.listExternalAgents).toHaveBeenCalledWith();
    expect(result.current.agents.map((a) => [a.key, a.activity])).toEqual([
      ["r", "thinking"],
      ["ext:k1", "typing"],
    ]);
    expect(result.current.lastScanAt).toBe(4242);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(2);

    // Hidden: the timer keeps ticking but no scan is made.
    setVisibility("hidden");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(2);

    // Becoming visible scans at once, without waiting for the next tick.
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(3);
  });

  it("uses a 3 s default interval and never overlaps scans", async () => {
    vi.useFakeTimers();
    let resolve: ((r: ExternalAgentsReport) => void) | null = null;
    scan.listExternalAgents.mockImplementation(
      () => new Promise<ExternalAgentsReport>((r) => (resolve = r)),
    );
    const { result } = renderHook(() => useVillageAgents({ includeExternal: true }));
    await act(async () => {
      vi.advanceTimersByTime(2999);
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(1);
    // The 3 s tick finds the first scan still in flight and skips.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(1);

    await act(async () => resolve!(REPORT));
    expect(result.current.lastScanAt).toBe(4242);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(scan.listExternalAgents).toHaveBeenCalledTimes(2);
  });

  it("turns a failed scan into a code, keeps the last good one, and clears it on success", async () => {
    vi.useFakeTimers();
    scan.listExternalAgents
      .mockResolvedValueOnce(REPORT)
      .mockRejectedValueOnce("io: /Users/someone/.claude unreadable")
      .mockResolvedValueOnce({ agents: [], scannedAtMs: 5000 });
    const { result } = renderHook(() =>
      useVillageAgents({ includeExternal: true, pollMs: 1000 }),
    );
    await flush();
    expect(result.current.agents.map((a) => a.key)).toEqual(["ext:k1"]);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.externalError).toBe("io");
    expect(result.current.agents.map((a) => a.key)).toEqual(["ext:k1"]);
    expect(result.current.lastScanAt).toBe(4242);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.externalError).toBeNull();
    expect(result.current.agents).toEqual([]);
    expect(result.current.lastScanAt).toBe(5000);
  });

  it("drops a scan that settles after unmount", async () => {
    let settle: { ok: (r: ExternalAgentsReport) => void; fail: (e: unknown) => void } | null =
      null;
    scan.listExternalAgents.mockImplementation(
      () =>
        new Promise<ExternalAgentsReport>((ok, fail) => {
          settle = { ok, fail };
        }),
    );
    const a = renderHook(() => useVillageAgents({ includeExternal: true }));
    a.unmount();
    settle!.ok(REPORT);
    await flush();

    const b = renderHook(() => useVillageAgents({ includeExternal: true }));
    b.unmount();
    settle!.fail("io");
    await flush();
    // Nothing to assert on an unmounted hook beyond "no update was attempted": React
    // would warn, and the last values stay the pre-scan ones.
    expect(a.result.current.lastScanAt).toBeNull();
    expect(b.result.current.externalError).toBeNull();
  });

  it("hides external agents and their error when includeExternal is switched off", async () => {
    scan.listExternalAgents.mockRejectedValueOnce("timeout");
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useVillageAgents({ includeExternal: on }),
      { initialProps: { on: true } },
    );
    await flush();
    expect(result.current.externalError).toBe("timeout");

    rerender({ on: false });
    expect(result.current.externalError).toBeNull();
    expect(result.current.agents).toEqual([]);
  });

  it("starts from a fresh scan when switched back on — no stale report or error", async () => {
    scan.listExternalAgents.mockResolvedValueOnce(REPORT);
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useVillageAgents({ includeExternal: on }),
      { initialProps: { on: true } },
    );
    await flush();
    expect(result.current.agents.map((a) => a.key)).toEqual(["ext:k1"]);

    rerender({ on: false });
    // Back on with the next scan still in flight: the old report must not resurface.
    let resolve: ((r: ExternalAgentsReport) => void) | null = null;
    scan.listExternalAgents.mockImplementationOnce(
      () => new Promise<ExternalAgentsReport>((r) => (resolve = r)),
    );
    rerender({ on: true });
    expect(result.current.agents).toEqual([]);
    expect(result.current.lastScanAt).toBeNull();
    await act(async () => resolve!({ agents: [], scannedAtMs: 9000 }));
    expect(result.current.lastScanAt).toBe(9000);
  });

  it("counts external agents' calls across polls (best effort), and starts over when switched back on", async () => {
    vi.useFakeTimers();
    const at = (ms: number, tool: string | null): ExternalAgentsReport => ({
      agents: [ext("k1", { activity: "running", tool, lastActivityMs: ms })],
      scannedAtMs: ms,
    });
    scan.listExternalAgents
      .mockResolvedValueOnce(at(100, "Edit"))
      .mockResolvedValueOnce(at(200, "Edit")) // moved with a tool pending: a call
      .mockResolvedValueOnce(at(200, "Edit")) // did not move: none
      .mockResolvedValueOnce(at(300, "Bash")); // moved again: another
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useVillageAgents({ includeExternal: on, pollMs: 1000 }),
      { initialProps: { on: true } },
    );
    await flush();
    expect(result.current.agents[0]).toMatchObject({ key: "ext:k1", toolCalls: 0 });
    const tick = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    };
    await tick();
    expect(result.current.agents[0].toolCalls).toBe(1);
    await tick();
    expect(result.current.agents[0].toolCalls).toBe(1);
    await tick();
    expect(result.current.agents[0].toolCalls).toBe(2);

    // Off and on again: the first fresh scan is a new baseline, not a continuation of the old count.
    rerender({ on: false });
    scan.listExternalAgents.mockResolvedValueOnce(at(900, "Edit"));
    rerender({ on: true });
    await flush();
    expect(result.current.agents[0].toolCalls).toBe(0);
  });

  it("does not bring back an old error when switched back on", async () => {
    scan.listExternalAgents.mockRejectedValueOnce("timeout");
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useVillageAgents({ includeExternal: on }),
      { initialProps: { on: true } },
    );
    await flush();
    expect(result.current.externalError).toBe("timeout");
    rerender({ on: false });
    scan.listExternalAgents.mockImplementationOnce(() => new Promise<ExternalAgentsReport>(() => {}));
    rerender({ on: true });
    expect(result.current.externalError).toBeNull();
  });

  it("an IDE tree's language: seeded from the ring's history at once, then followed on the stream", async () => {
    setFleet({ r: node("r", { status: "idle", childIds: ["s" as AgentId] }), s: node("s", { status: "done" }), q: node("q") }, ["r", "q"]);
    // History from before the Village opened: the idle root and its finished sub-agent worked on Rust.
    logs.state.snapshot = [line("r", "Edit: /w/gazelle/src/a.rs", "tool", 1), line("s", "Read: /w/gazelle/src/b.rs", "tool", 2), line("ghost", "Edit: /x.py", "tool", 3)];
    const { result } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    const langs = () => result.current.agents.map((a) => [a.key, a.language]);
    expect(logs.logstreamSnapshot).toHaveBeenCalledTimes(1);
    expect(langs()).toEqual([
      ["r", "rust"],
      ["s", "rust"],
      ["q", null],
    ]);
    // The history does not count as tool CALLS (the LAN only moves on calls it sees happen).
    expect(result.current.agents[0].toolCalls).toBe(0);
    // The stream adds votes: three TypeScript files outvote two Rust ones; a replayed line counts once.
    act(() => logs.state.handler!([line("q", "Edit: /w/web/a.ts", "tool", 4), line("s", "Edit: /w/gazelle/x.ts", "tool", 5)]));
    act(() => logs.state.handler!([line("s", "Edit: /w/gazelle/x.ts", "tool", 5), line("r", "Write: /w/gazelle/y.ts", "tool", 6)]));
    expect(langs()).toEqual([
      ["r", "rust"],
      ["s", "rust"],
      ["q", "typescript"],
    ]);
    act(() => logs.state.handler!([line("r", "Write: /w/gazelle/z.tsx", "tool", 7)]));
    expect(langs()[0]).toEqual(["r", "typescript"]);
    // A batch with no vote in it (a file line of no agent) does not re-render into a new state.
    const before = result.current.agents;
    act(() => logs.state.handler!([line(null, "Edit: /w/gazelle/q.rs", "tool", 8)]));
    expect(result.current.agents).toBe(before);
  });

  it("holds the batches that arrive before the history, then counts each line once", async () => {
    logs.state.snapshotMode = "defer";
    setFleet({ r: node("r") }, ["r"]);
    const { result } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    // A batch overlapping the history (id 2) and two new lines, before the snapshot lands: held.
    act(() =>
      logs.state.handler!([line("r", "Edit: /a/b.go", "tool", 2), line("r", "Edit: /a/c.py", "tool", 3), line("r", "Edit: /a/d.py", "tool", 4)]),
    );
    expect(result.current.agents[0].language).toBeNull();
    logs.state.snapshot = [line("r", "Edit: /a/a.go", "tool", 1), line("r", "Edit: /a/b.go", "tool", 2)];
    await act(async () => {
      logs.state.settle!(true);
      await flush();
    });
    // History first, then the held batch: go 2 (a.go, b.go once), python 2 — a tie, so go. Counted
    // the other way round, the history (ids 1–2) would have been behind the cursor: python alone.
    expect(result.current.agents[0].language).toBe("go");
    act(() => logs.state.handler!([line("r", "Edit: /a/e.py", "tool", 5)]));
    expect(result.current.agents[0].language).toBe("python");
  });

  it("without a history (a failed snapshot) the held batches still count", async () => {
    logs.state.snapshotMode = "defer";
    setFleet({ r: node("r") }, ["r"]);
    const { result } = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    act(() => logs.state.handler!([line("r", "Read: /a/b.swift", "tool", 9)]));
    await act(async () => {
      logs.state.settle!(false);
      await flush();
    });
    expect(result.current.agents[0].language).toBe("swift");
    act(() => logs.state.handler!([line("r", "Read: /a/c.kt", "tool", 10), line("r", "Read: /a/d.kt", "tool", 11)]));
    expect(result.current.agents[0].language).toBe("kotlin");
  });

  it("takes no history when the stream itself cannot be subscribed to, or resolves after unmount", async () => {
    logs.state.mode = "reject";
    const first = renderHook(() => useVillageAgents({ includeExternal: false }));
    await flush();
    first.unmount();
    logs.state.mode = "defer";
    const second = renderHook(() => useVillageAgents({ includeExternal: false }));
    second.unmount();
    logs.state.release!();
    await flush();
    expect(logs.logstreamSnapshot).not.toHaveBeenCalled();
  });
});
