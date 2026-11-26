/** Source label → focus through the REAL app store (Tauri seam and terminal module mocked),
 * asserting the store change: which view, and which tab in which leaf, is active. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("../terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { leafOfTab, useAppStore } from "../../app/store";
import type { AgentId, AgentNode, TabId, TerminalId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { configureTerminal } from "../terminal";
import { receiveSample, resetMachineStore, useMachineStore } from "../network/machineStore";
import { resetNetworkStore, useNetworkStore } from "../network/networkStore";
import {
  focusLogSource,
  focusTargetFor,
  focusTerminalTab,
  showConnectionsOf,
  showRequestsOf,
  terminalTitleOf,
  unavailableReason,
} from "./agentLogsFocus";

const S = () => useAppStore.getState();
const layout = () => S().layoutActions;

function agent(id: string, p: Partial<AgentNode> = {}): AgentNode {
  return {
    id: id as AgentId,
    parentId: null,
    kind: "orchestrator",
    title: id,
    status: "running",
    branch: "",
    cwd: "/repo",
    runtime: "claude-code",
    startedAt: 1,
    finishedAt: null,
    lastActivityAt: 1,
    childIds: [],
    sessionId: null,
    expanded: true,
    unread: 0,
    ...p,
  };
}
function putAgents(...nodes: AgentNode[]) {
  useAppStore.setState((s) => {
    for (const n of nodes) s.agents[n.id] = n;
  });
}
const terminalOf = (tabId: TabId): TerminalId => {
  const ref = S().tabs[tabId].ref;
  if (ref.kind !== "terminal" && ref.kind !== "agent-terminal") throw new Error("not a terminal tab");
  return ref.terminalId;
};
const activeTabOfFocusedLeaf = () => {
  const s = S();
  const leaf = leafOfTab(s.layout, Object.keys(s.tabs)[0] as TabId);
  return leaf?.activeTabId;
};

beforeEach(() => {
  resetStore();
  useAppStore.setState((s) => {
    s.agents = {};
    s.selection.selectedAgentId = null;
  });
});

describe("focusLogSource", () => {
  it("focuses a plain terminal's tab in the live view", () => {
    const term = layout().openTerminalTab({ title: "zsh" });
    const other = layout().openMetricsTab(null);
    expect(activeTabOfFocusedLeaf()).toBe(other);

    expect(focusLogSource({ terminalId: terminalOf(term), agentId: null })).toBe(true);
    expect(activeTabOfFocusedLeaf()).toBe(term);
    expect(S().focusedPaneId).toBe(leafOfTab(S().layout, term)?.id);
  });

  it("switches to the view holding the terminal first", () => {
    const term = layout().openTerminalTab({ title: "zsh" });
    const bootView = S().activeViewId;
    layout().createView("Other");
    layout().activateView(S().views[1].id);
    expect(S().activeViewId).not.toBe(bootView);
    expect(leafOfTab(S().layout, term)).toBeNull();

    expect(focusLogSource({ terminalId: terminalOf(term), agentId: null })).toBe(true);
    expect(S().activeViewId).toBe(bootView);
    expect(leafOfTab(S().layout, term)?.activeTabId).toBe(term);
  });

  it("a root agent's line (agentId only) focuses its agent-terminal tab", () => {
    putAgents(agent("root1"));
    const term = layout().openTerminalTab({ agentId: "root1" as AgentId, runtime: "claude-code" });
    const other = layout().openMetricsTab(null);
    expect(activeTabOfFocusedLeaf()).toBe(other);

    expect(focusLogSource({ terminalId: null, agentId: "root1" })).toBe(true);
    expect(activeTabOfFocusedLeaf()).toBe(term);
    expect(S().selection.selectedAgentId).toBe("root1");
  });

  it("a sub-agent's line opens (or reveals) its activity tab via selectAgent", () => {
    putAgents(agent("root1", { childIds: ["sub1" as AgentId] }), agent("sub1", { kind: "subagent", parentId: "root1" as AgentId }));
    expect(Object.values(S().tabs).some((t) => t.ref.kind === "agent-activity")).toBe(false);

    expect(focusLogSource({ terminalId: null, agentId: "sub1" })).toBe(true);
    const act = Object.values(S().tabs).find((t) => t.ref.kind === "agent-activity");
    expect(act?.ref).toEqual({ kind: "agent-activity", agentId: "sub1" });
    expect(leafOfTab(S().layout, act!.id)?.activeTabId).toBe(act!.id);
  });

  it("prefers the terminal tab over the agent when both are known", () => {
    putAgents(agent("root1"), agent("sub1", { kind: "subagent", parentId: "root1" as AgentId }));
    const term = layout().openTerminalTab({ title: "zsh" });
    const target = focusTargetFor({ terminalId: terminalOf(term), agentId: "sub1" }, S());
    expect(target).toEqual({ kind: "tab", tabId: term });
  });

  it("a closed terminal falls back to its agent when that agent is a live sub-agent", () => {
    putAgents(agent("sub1", { kind: "subagent", parentId: "root1" as AgentId }));
    expect(focusTargetFor({ terminalId: "gone", agentId: "sub1" }, S())).toEqual({ kind: "agent", agentId: "sub1" });
  });

  it.each([
    ["a terminal with no tab", { terminalId: "gone", agentId: null }],
    ["an unknown agent", { terminalId: null, agentId: "ghost" }],
    ["a root agent whose terminal tab is closed", { terminalId: null, agentId: "root1" }],
    ["a line tied to nothing", { terminalId: null, agentId: null }],
  ])("%s has no target and focusing is a no-op", (_n, line) => {
    putAgents(agent("root1"));
    const other = layout().openMetricsTab(null);
    expect(focusTargetFor(line, S())).toBeNull();
    expect(focusLogSource(line)).toBe(false);
    expect(activeTabOfFocusedLeaf()).toBe(other);
    expect(S().selection.selectedAgentId).toBeNull();
  });

  it("an orphaned tab record (in `tabs`, in no view) is not a target", () => {
    const term = layout().openTerminalTab({ title: "zsh" });
    const tid = terminalOf(term);
    useAppStore.setState((s) => {
      const leaf = leafOfTab(s.layout, term);
      leaf!.tabIds = leaf!.tabIds.filter((t) => t !== term);
      leaf!.activeTabId = null;
    });
    expect(S().tabs[term]).toBeDefined();
    expect(focusTargetFor({ terminalId: tid, agentId: null }, S())).toBeNull();
  });
});

describe("unavailableReason", () => {
  it.each([
    [{ terminalId: "t", agentId: "a" }, "That terminal is closed — there is no tab to focus"],
    [{ terminalId: null, agentId: "a" }, "That agent is no longer open — there is no tab to focus"],
    [{ terminalId: null, agentId: null }, "Not tied to a terminal or agent"],
  ])("%j", (line, want) => expect(unavailableReason(line)).toBe(want));
});

describe("focusTerminalTab — a dev app's Restart in the IDE landed in a Rust-opened PTY", () => {
  const terminalTabsOf = (tid: string) =>
    Object.values(S().tabs).filter((t) => t.ref.kind === "terminal" && t.ref.terminalId === tid);

  it("focuses the tab that already holds the terminal", () => {
    const term = layout().openTerminalTab({ title: "zsh" });
    const other = layout().openMetricsTab(null);
    expect(activeTabOfFocusedLeaf()).toBe(other);
    expect(focusTerminalTab(terminalOf(term), "web", "/w/web")).toBe(true);
    expect(activeTabOfFocusedLeaf()).toBe(term);
    expect(terminalTabsOf(terminalOf(term))).toHaveLength(1);
  });

  it("no tab yet: adopts the live PTY in a REATTACH tab named after the app, focused — and never a second one", () => {
    layout().openMetricsTab(null);
    vi.mocked(configureTerminal).mockClear();
    expect(focusTerminalTab("01JRESTARTED0000000000000A", "web", "/w/web")).toBe(true);
    const [tab] = terminalTabsOf("01JRESTARTED0000000000000A");
    expect(tab.title).toBe("web");
    expect(activeTabOfFocusedLeaf()).toBe(tab.id);
    expect(configureTerminal).toHaveBeenCalledWith("01JRESTARTED0000000000000A", { reattach: true, cwd: "/w/web" });
    expect(focusTerminalTab("01JRESTARTED0000000000000A", "web", "/w/web")).toBe(true);
    expect(terminalTabsOf("01JRESTARTED0000000000000A")).toHaveLength(1);
  });

  it("an app without a cwd: the tab still opens (no cwd passed)", () => {
    vi.mocked(configureTerminal).mockClear();
    expect(focusTerminalTab("01JRESTARTED0000000000000B", "ml", null)).toBe(true);
    expect(configureTerminal).toHaveBeenCalledWith("01JRESTARTED0000000000000B", { reattach: true });
  });
});

describe("showConnectionsOf — a dev app card's “connections →”", () => {
  beforeEach(() => {
    resetNetworkStore();
    resetMachineStore();
  });

  it("opens the Network tab in Whole Mac mode with that pid's row selected and expanded", () => {
    receiveSample({ tsMs: 1, apps: [{ key: "node:42", name: "node", pid: 42 } as never] });
    layout().openMetricsTab(null);
    expect(useNetworkStore.getState().mode).toBe("ide");
    showConnectionsOf(42);
    expect(useNetworkStore.getState().mode).toBe("machine");
    const net = Object.values(S().tabs).find((t) => t.ref.kind === "network");
    expect(net).toBeDefined();
    expect(activeTabOfFocusedLeaf()).toBe(net!.id);
    expect(useMachineStore.getState().selectedKey).toBe("node:42");
    expect(useMachineStore.getState().expanded).toEqual(["node:42"]);
  });
});

describe("an IDE app card's links", () => {
  it("showRequestsOf: Network in IDE traffic, every narrowing undone, the Process picker on exactly that name, the tab focused", () => {
    resetNetworkStore();
    useNetworkStore.setState({ mode: "machine", processSelection: ["curl"], hostSelection: ["x"], filter: "old" });
    showRequestsOf("gazelle");
    const n = useNetworkStore.getState();
    expect([n.mode, n.processSelection, n.hostSelection, n.filter]).toEqual(["ide", ["gazelle"], null, ""]);
    const net = Object.values(S().tabs).find((t) => t.ref.kind === "network");
    expect(leafOfTab(S().layout, net!.id)?.activeTabId).toBe(net!.id);
  });

  it("terminalTitleOf: an agent terminal is named by its agent (custom name first), a plain one by its tab; no tab → null", () => {
    const tab = (id: string, ref: unknown, p: Record<string, unknown> = {}) => ({ id, kind: "terminal", title: `tab ${id}`, ref, ...p });
    const s = {
      tabs: {
        a: tab("a", { kind: "agent-terminal", terminalId: "t-a", agentId: "ag1" }),
        b: tab("b", { kind: "agent-terminal", terminalId: "t-b", agentId: "ag2" }),
        c: tab("c", { kind: "agent-terminal", terminalId: "t-c", agentId: "gone" }),
        d: tab("d", { kind: "terminal", terminalId: "t-d" }, { customTitle: "my shell" }),
        e: tab("e", { kind: "terminal", terminalId: "t-e" }),
        f: tab("f", { kind: "editor", path: "/x" }),
      },
      agents: { ag1: agent("ag1", { title: "claude · gazelle", customTitle: "Gazelle bot" }), ag2: agent("ag2", { title: "claude · web" }) },
    } as unknown as Parameters<typeof terminalTitleOf>[1];
    expect(terminalTitleOf("t-a", s)).toBe("Gazelle bot");
    expect(terminalTitleOf("t-b", s)).toBe("claude · web");
    expect(terminalTitleOf("t-c", s)).toBe("tab c");
    expect(terminalTitleOf("t-d", s)).toBe("my shell");
    expect(terminalTitleOf("t-e", s)).toBe("tab e");
    expect(terminalTitleOf("t-zz", s)).toBeNull();
  });
});
