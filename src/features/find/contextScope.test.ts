/**
 * contextScope — the find overlays' context-aware default workspace (from a
 * gazelle file or a gazelle terminal, the search should cover gazelle).
 *
 * Pure functions, driven against the REAL store shape (`useAppStore.getState()`
 * after a seeded layout) so a change to how the store names the focused pane or a
 * tab's ref breaks here rather than silently defaulting to the primary root. The
 * terminal-cwd lookup is injected, so no PTY is involved.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { makeLeaf, useAppStore } from "../../app/store";
import {
  asAgentId,
  asPaneId,
  asTabId,
  asTerminalId,
  type Tab,
  type TerminalId,
} from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import {
  contextPaths,
  contextRoot,
  rememberContextTab,
  rootForPath,
  tabContextPath,
  type ContextMemory,
  type TerminalCwdLookup,
} from "./contextScope";

const noCwd: TerminalCwdLookup = () => null;
const cwds =
  (map: Record<string, string>): TerminalCwdLookup =>
  (id: TerminalId) =>
    map[id] ?? null;

const tab = (id: string, ref: Tab["ref"]): Tab => ({
  id: asTabId(id),
  kind: ref.kind,
  title: id,
  ref,
});

/** Put `t` in the focused leaf and make it that leaf's active tab. */
function focusTab(t: Tab): void {
  useAppStore.setState((s) => {
    s.tabs[t.id] = t;
    const leaf = s.layout;
    if (leaf.type !== "leaf") throw new Error("harness expects a single leaf");
    leaf.tabIds.push(t.id);
    leaf.activeTabId = t.id;
  });
}

const state = () => useAppStore.getState();
/** The most specific candidate — what the old single-answer `contextPath` returned. */
const contextPath = (st: ReturnType<typeof state>, lookup: TerminalCwdLookup) =>
  contextPaths(st, lookup)[0] ?? null;

beforeEach(() => {
  resetStore();
  resetFleetStore();
});

describe("rootForPath", () => {
  const ROOTS = ["/w", "/w/gazelle", "/w/gen", "/x/data-warehouse"];

  it("picks the root that contains a file", () => {
    expect(rootForPath(ROOTS, "/x/data-warehouse/src/main.rs")).toBe("/x/data-warehouse");
  });

  it("picks the LONGEST root when roots nest", () => {
    expect(rootForPath(ROOTS, "/w/gazelle/crates/core/lib.rs")).toBe("/w/gazelle");
    expect(rootForPath(ROOTS, "/w/other/file.ts")).toBe("/w");
  });

  it("compares on segment boundaries — /w/gen never owns /w/gazelle", () => {
    expect(rootForPath(["/w/gen"], "/w/gazelle/a.ts")).toBeNull();
    expect(rootForPath(["/w/gen", "/w/gazelle"], "/w/gazelle/a.ts")).toBe("/w/gazelle");
  });

  it("matches a path that IS a root (a terminal opened in it), ignoring a trailing separator", () => {
    expect(rootForPath(ROOTS, "/w/gazelle")).toBe("/w/gazelle");
    expect(rootForPath(ROOTS, "/w/gazelle/")).toBe("/w/gazelle");
    expect(rootForPath(["/w/gazelle/"], "/w/gazelle")).toBe("/w/gazelle/");
  });

  it("treats Windows separators as equivalent and returns the root as listed", () => {
    expect(rootForPath(["C:\\w\\gazelle"], "C:/w/gazelle")).toBe("C:\\w\\gazelle");
    expect(rootForPath(["C:\\w\\gazelle"], "C:\\w\\gazelle\\src\\a.rs")).toBe("C:\\w\\gazelle");
  });

  it("ignores case for Windows paths — a root, or a file inside it", () => {
    expect(rootForPath(["C:\\w\\Gazelle"], "c:\\w\\gazelle")).toBe("C:\\w\\Gazelle");
    expect(rootForPath(["C:\\w\\Gazelle"], "c:\\W\\gazelle\\src\\a.rs")).toBe("C:\\w\\Gazelle");
    // …but a POSIX path keeps its case.
    expect(rootForPath(["/w/Gazelle"], "/w/gazelle")).toBeNull();
  });

  it("is null for no path, no roots, or a path outside every root", () => {
    expect(rootForPath(ROOTS, null)).toBeNull();
    expect(rootForPath(ROOTS, "")).toBeNull();
    expect(rootForPath([], "/w/gazelle/a.ts")).toBeNull();
    expect(rootForPath(ROOTS, "/elsewhere/a.ts")).toBeNull();
  });
});

describe("tabContextPath", () => {
  const agents = { [asAgentId("a1")]: { cwd: "/w/gazelle" }, [asAgentId("blank")]: { cwd: "" } };

  it("is null with no tab", () => {
    expect(tabContextPath(undefined, agents, noCwd)).toBeNull();
  });

  it("an editor or diff tab is its file path", () => {
    expect(tabContextPath(tab("e", { kind: "editor", path: "/w/gazelle/a.ts" }), agents, noCwd)).toBe(
      "/w/gazelle/a.ts",
    );
    expect(tabContextPath(tab("d", { kind: "diff", path: "/w/gazelle/b.ts" }), agents, noCwd)).toBe(
      "/w/gazelle/b.ts",
    );
  });

  it("a plain terminal is the cwd the registry reports for it", () => {
    const t = tab("t", { kind: "terminal", terminalId: asTerminalId("term-1") });
    expect(tabContextPath(t, agents, cwds({ "term-1": "/w/gazelle" }))).toBe("/w/gazelle");
    expect(tabContextPath(t, agents, noCwd)).toBeNull();
  });

  it("an agent terminal prefers the AGENT's cwd, then the PTY's", () => {
    const lookup = cwds({ a1: "/pty/cwd", gone: "/pty/gone", blank: "/pty/blank" });
    const ref = (agent: string) =>
      tab(agent, { kind: "agent-terminal", terminalId: asTerminalId(agent), agentId: asAgentId(agent) });
    expect(tabContextPath(ref("a1"), agents, lookup)).toBe("/w/gazelle");
    // The agent record is not (yet) in the fleet — the PTY still knows where it runs.
    expect(tabContextPath(ref("gone"), agents, lookup)).toBe("/pty/gone");
    // An empty cwd is not an answer.
    expect(tabContextPath(ref("blank"), agents, lookup)).toBe("/pty/blank");
  });

  it("a sub-agent's activity tab is that agent's cwd, or null when unknown", () => {
    expect(
      tabContextPath(tab("act", { kind: "agent-activity", agentId: asAgentId("a1") }), agents, noCwd),
    ).toBe("/w/gazelle");
    expect(
      tabContextPath(tab("act", { kind: "agent-activity", agentId: asAgentId("nope") }), agents, noCwd),
    ).toBeNull();
    expect(
      tabContextPath(tab("act", { kind: "agent-activity", agentId: asAgentId("blank") }), agents, noCwd),
    ).toBeNull();
  });

  it("a session picker or metrics panel is its folder", () => {
    expect(tabContextPath(tab("sp", { kind: "session-picker", cwd: "/w/gazelle" }), agents, noCwd)).toBe(
      "/w/gazelle",
    );
    expect(tabContextPath(tab("m", { kind: "metrics", cwd: "/w/gazelle" }), agents, noCwd)).toBe(
      "/w/gazelle",
    );
    expect(tabContextPath(tab("m", { kind: "metrics", cwd: null }), agents, noCwd)).toBeNull();
  });

  it("a tab that names no folder (village, API request, logs…) is null", () => {
    expect(tabContextPath(tab("v", { kind: "village" }), agents, noCwd)).toBeNull();
    expect(tabContextPath(tab("r", { kind: "api-request", requestId: "r1" }), agents, noCwd)).toBeNull();
    expect(tabContextPath(tab("l", { kind: "agent-logs" }), agents, noCwd)).toBeNull();
  });
});

describe("contextPath", () => {
  it("is null with nothing open", () => {
    expect(contextPath(state(), noCwd)).toBeNull();
  });

  it("is the focused pane's active editor's file", () => {
    focusTab(tab("e", { kind: "editor", path: "/w/gazelle/src/a.ts" }));
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle/src/a.ts");
  });

  it("is a focused terminal's cwd", () => {
    focusTab(tab("t", { kind: "terminal", terminalId: asTerminalId("term-1") }));
    expect(contextPath(state(), cwds({ "term-1": "/w/gazelle" }))).toBe("/w/gazelle");
  });

  it("is a focused agent terminal's agent cwd (read from the fleet)", () => {
    useAppStore.setState((s) => {
      s.agents[asAgentId("a1")] = wireAgent({ id: asAgentId("a1"), cwd: "/w/gazelle" });
    });
    focusTab(tab("at", { kind: "agent-terminal", terminalId: asTerminalId("a1"), agentId: asAgentId("a1") }));
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle");
  });

  it("falls back to the last FILE tab activated when the focused tab names no folder", () => {
    // A gazelle file was being read, then the user switched to the village.
    const file = tab("e", { kind: "editor", path: "/w/gazelle/a.ts" });
    useAppStore.setState((s) => {
      s.tabs[file.id] = file;
      s.lastFilePath = "/w/gazelle/a.ts";
    });
    focusTab(tab("v", { kind: "village" }));
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle/a.ts");
  });

  it("falls back the same way from a terminal whose cwd is not known yet", () => {
    const file = tab("e", { kind: "editor", path: "/w/gazelle/a.ts" });
    useAppStore.setState((s) => {
      s.tabs[file.id] = file;
      s.lastFilePath = "/w/gazelle/a.ts";
    });
    focusTab(tab("t", { kind: "terminal", terminalId: asTerminalId("term-1") }));
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle/a.ts");
  });

  it("ignores a remembered file whose tab is gone (no stale scope)", () => {
    useAppStore.setState((s) => {
      s.lastFilePath = "/w/gazelle/closed.ts";
    });
    focusTab(tab("v", { kind: "village" }));
    expect(contextPath(state(), noCwd)).toBeNull();
  });

  it("reads the first leaf when focusedPaneId names no live leaf (defensive)", () => {
    focusTab(tab("e", { kind: "editor", path: "/w/gazelle/a.ts" }));
    useAppStore.setState((s) => {
      s.focusedPaneId = asPaneId("not-a-pane");
    });
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle/a.ts");
  });

  it("follows the FOCUSED pane in a split, not the first one", () => {
    const left = makeLeaf();
    const right = makeLeaf();
    const a = tab("a", { kind: "editor", path: "/w/alpha/a.ts" });
    const g = tab("g", { kind: "editor", path: "/w/gazelle/g.ts" });
    left.tabIds = [a.id];
    left.activeTabId = a.id;
    right.tabIds = [g.id];
    right.activeTabId = g.id;
    useAppStore.setState((s) => {
      s.tabs[a.id] = a;
      s.tabs[g.id] = g;
      s.layout = { id: asPaneId("split"), type: "split", orientation: "row", children: [left, right], sizes: [0.5, 0.5] };
      s.focusedPaneId = right.id;
    });
    expect(contextPath(state(), noCwd)).toBe("/w/gazelle/g.ts");
    useAppStore.setState((s) => {
      s.focusedPaneId = left.id;
    });
    expect(contextPath(state(), noCwd)).toBe("/w/alpha/a.ts");
  });
});

describe("contextPaths — every candidate, most specific first", () => {
  it("is empty with nothing open", () => {
    expect(contextPaths(state(), noCwd)).toEqual([]);
  });

  it("lists the focused tab, then the remembered context tab, then the last file", () => {
    const file = tab("e", { kind: "editor", path: "/w/alpha/a.ts" });
    const term = tab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    useAppStore.setState((s) => {
      s.tabs[file.id] = file;
      s.tabs[term.id] = term;
      s.lastFilePath = "/w/alpha/a.ts";
    });
    focusTab(tab("m", { kind: "metrics", cwd: "/x/data" }));
    const memory: ContextMemory = { tabId: term.id, ref: term.ref };
    expect(contextPaths(state(), cwds({ "term-g": "/w/gazelle" }), memory)).toEqual([
      "/x/data",
      "/w/gazelle",
      "/w/alpha/a.ts",
    ]);
  });
});

describe("rememberContextTab", () => {
  it("remembers the focused tab when its kind can name a folder", () => {
    const term = tab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    focusTab(term);
    expect(rememberContextTab(null, state())).toEqual({ tabId: term.id, ref: term.ref });
  });

  it("keeps the previous memory when the focused tab names no folder, or nothing is focused", () => {
    const prev: ContextMemory = {
      tabId: asTabId("t"),
      ref: { kind: "terminal", terminalId: asTerminalId("term-g") },
    };
    expect(rememberContextTab(prev, state())).toBe(prev); // empty leaf
    focusTab(tab("v", { kind: "village" }));
    expect(rememberContextTab(prev, state())).toBe(prev);
    expect(rememberContextTab(null, state())).toBeNull();
  });

  it("returns the same object while the same tab stays focused (no churn per update)", () => {
    focusTab(tab("e", { kind: "editor", path: "/w/gazelle/a.ts" }));
    const first = rememberContextTab(null, state());
    expect(rememberContextTab(first, state())).toBe(first);
  });
});

describe("contextRoot", () => {
  const ROOTS = ["/w/alpha", "/w/gazelle"];

  it("is null with nothing open, or with no roots", () => {
    expect(contextRoot(ROOTS, state(), noCwd)).toBeNull();
    focusTab(tab("e", { kind: "editor", path: "/w/gazelle/a.ts" }));
    expect(contextRoot([], state(), noCwd)).toBeNull();
  });

  it("is the root of the focused tab", () => {
    focusTab(tab("e", { kind: "editor", path: "/w/gazelle/a.ts" }));
    expect(contextRoot(ROOTS, state(), noCwd)).toBe("/w/gazelle");
  });

  it("gazelle console → village: the remembered terminal still means gazelle, over an older file elsewhere", () => {
    // The last FILE tab was in alpha; the console the user was just in runs in gazelle.
    const file = tab("e", { kind: "editor", path: "/w/alpha/a.ts" });
    useAppStore.setState((s) => {
      s.tabs[file.id] = file;
      s.lastFilePath = "/w/alpha/a.ts";
    });
    const term = tab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    focusTab(term);
    const memory = rememberContextTab(null, state());
    focusTab(tab("v", { kind: "village" }));
    const lookup = cwds({ "term-g": "/w/gazelle" });
    expect(contextRoot(ROOTS, state(), lookup, rememberContextTab(memory, state()))).toBe("/w/gazelle");
    // Without the memory it would be the stale file's repo — the bug the memory exists to prevent.
    expect(contextRoot(ROOTS, state(), lookup, null)).toBe("/w/alpha");
  });

  it("ignores a remembered tab that was closed, or whose id now names a different tab", () => {
    const memory: ContextMemory = {
      tabId: asTabId("t"),
      ref: { kind: "terminal", terminalId: asTerminalId("term-g") },
    };
    const lookup = cwds({ "term-g": "/w/gazelle", "term-other": "/w/gazelle" });
    focusTab(tab("v", { kind: "village" }));
    expect(contextRoot(ROOTS, state(), lookup, memory)).toBeNull(); // closed
    // Same id, a different record (a reset store reusing ids): inert, not "gazelle".
    useAppStore.setState((s) => {
      s.tabs[asTabId("t")] = tab("t", { kind: "terminal", terminalId: asTerminalId("term-other") });
    });
    expect(contextRoot(ROOTS, state(), lookup, memory)).toBeNull();
  });

  it("skips a focused path outside every root and falls through to the next candidate", () => {
    // A terminal spawned in the home folder, while the last file was in gazelle.
    const file = tab("e", { kind: "editor", path: "/w/gazelle/a.ts" });
    useAppStore.setState((s) => {
      s.tabs[file.id] = file;
      s.lastFilePath = "/w/gazelle/a.ts";
    });
    focusTab(tab("t", { kind: "terminal", terminalId: asTerminalId("term-home") }));
    expect(contextRoot(ROOTS, state(), cwds({ "term-home": "/home/u" }))).toBe("/w/gazelle");
  });

  it("is null when no candidate is inside an open root", () => {
    focusTab(tab("t", { kind: "terminal", terminalId: asTerminalId("term-home") }));
    expect(contextRoot(ROOTS, state(), cwds({ "term-home": "/home/u" }))).toBeNull();
  });
});
