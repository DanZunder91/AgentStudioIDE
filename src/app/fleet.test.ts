/** The fleet slice: agent forest, telemetry reduction, the pivot. Bugs live in transitions, so
 * headline tests drive whole lifecycles (snapshot → spawn → status → exit) step by step. */

import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../features/terminal", () => terminal);

import { rootOf, useAppStore } from "./store";
import type { AgentEvent, AgentId, AgentNode, AgentStatus, TabId } from "./types";
import {
  flattenFleet,
  resetFleetRowsCache,
  type AgentFleetRow,
  type FleetRow,
} from "../features/fleet/flatten";

/** Agent rows only — flattenFleet now interleaves folder-group headers. */
const agentRowsOf = (rows: FleetRow[]): AgentFleetRow[] =>
  rows.filter((r): r is AgentFleetRow => r.kind === "agent");
import {
  assertFleetInvariants,
  assertLiveFleetInvariants,
  resetFleetStore,
  wireAgent,
} from "../test/fleet-harness";
import { assertLiveStoreInvariants, resetStore } from "../test/store-harness";

const state = () => useAppStore.getState();
const act = () => useAppStore.getState().agentActions;
const id = (s: string) => s as AgentId;
const agentOf = (s: string) => state().agents[id(s)];

/** Open every agent — the tree now defaults COLLAPSED, so tests about the
 *  fully-expanded shape expand first. */
function expandAll(): void {
  useAppStore.setState((s) => {
    for (const agent of Object.values(s.agents)) agent.expanded = true;
  });
}

const started = (agentId: string, extra: Partial<{ parentId: AgentId | null; title: string }> = {}) =>
  ({
    t: "agent_started",
    agentId: id(agentId),
    parentId: extra.parentId ?? null,
    title: extra.title ?? agentId,
    cwd: "/w/gazelle",
    branch: "trunk",
    runtime: "claude-code",
  }) satisfies AgentEvent;

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
});

/* ══════════════════════════ createAgent ══════════════════════════ */

describe("createAgent", () => {
  it("registers a root agent and opens its agent-terminal tab", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });

    const agent = state().agents[agentId];
    expect(agent.kind).toBe("orchestrator");
    expect(agent.parentId).toBeNull();
    expect(agent.cwd).toBe("/w/gazelle");
    expect(agent.runtime).toBe("claude-code");
    expect(state().rootAgentIds).toEqual([agentId]);
    assertLiveFleetInvariants();
  });

  it("binds the tab to the agent — an agent-terminal, not a plain one", () => {
    // The ONLY difference between the two: the ref carries an agentId,
    // which is what makes fan-out telemetry attributable at M3.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });

    const tabs = Object.values(state().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("agent-terminal");
    expect(tabs[0].ref).toMatchObject({ kind: "agent-terminal", agentId });
    // Reuses openTerminalTab's path: same registry pre-registration as any tab.
    expect(terminal.configureTerminal).toHaveBeenCalledTimes(1);
  });

  /** `agent_spawn` takes no terminalId: Rust keys the PTY by agentId (`supervisor/mod.rs`), so an
   * agent terminal's TerminalId must be its AgentId (ARCHITECTURE §2.4). Else it fails as a dead
   * keyboard: output streams, but writes address an id Rust never registered. */
  describe("an agent terminal's TerminalId IS its AgentId", () => {
    const terminalIdOfTab = (tabId: TabId) => {
      const ref = state().tabs[tabId].ref;
      if (ref.kind !== "terminal" && ref.kind !== "agent-terminal")
        throw new Error("not a terminal tab");
      return ref.terminalId;
    };

    it("uses the AgentId as the TerminalId", () => {
      const agentId = act().createAgent({ cwd: "/w/gazelle" });
      const tabId = Object.keys(state().tabs)[0] as TabId;

      expect(terminalIdOfTab(tabId)).toBe(agentId as string);
    });

    it("registers the PTY under that same id — the dead-keyboard guard", () => {
      // configureTerminal's key is what every later terminal_write/_resize/
      // _close is addressed to. If it is not the agentId, Rust silently drops
      // them all while output keeps flowing.
      const agentId = act().createAgent({ cwd: "/w/gazelle" });

      const [registeredId, opts] = terminal.configureTerminal.mock.calls[0];
      expect(registeredId).toBe(agentId);
      expect(opts).toMatchObject({ agentId, cwd: "/w/gazelle" });
    });

    it("sends a runtime with the agentId — never a silent shell fallback", () => {
      // The registry throws if agentId arrives without runtime, rather than
      // routing to terminal_open and handing the user bash. Send both.
      act().createAgent({ cwd: "/w/gazelle" });

      const [, opts] = terminal.configureTerminal.mock.calls[0];
      expect(opts).toMatchObject({ runtime: "claude-code" });
      // A runtime id, never a program (the `AgentAdapter` seam).
      expect(opts).not.toHaveProperty("program");
    });

    it("honours an explicit runtime", () => {
      act().createAgent({ cwd: "/w/gazelle", runtime: "aider" });
      expect(terminal.configureTerminal.mock.calls[0][1]).toMatchObject({
        runtime: "aider",
      });
    });

    it("a PLAIN terminal's TerminalId is NOT any AgentId", () => {
      // The other half: only agent terminals share the id space this way. A
      // plain terminal must keep a minted id, or two tabs could collide.
      const agentId = act().createAgent({ cwd: "/w/gazelle" });
      const plainTab = useAppStore.getState().layoutActions.openTerminalTab({
        cwd: "/w/other",
      });

      const plainTerminalId = terminalIdOfTab(plainTab);
      expect(plainTerminalId).not.toBe(agentId as string);
      expect(state().agents[plainTerminalId as unknown as AgentId]).toBeUndefined();
      // ...and it is not announced as an agent terminal to the registry.
      const [, plainOpts] = terminal.configureTerminal.mock.calls[1];
      expect(plainOpts).not.toHaveProperty("agentId");
      expect((plainOpts as { agentId?: string }).agentId).toBeUndefined();
    });

    it("gives two agents two distinct terminals", () => {
      const a = act().createAgent({ cwd: "/w/a" });
      const b = act().createAgent({ cwd: "/w/b" });
      const [tabA, tabB] = Object.keys(state().tabs) as TabId[];

      expect(terminalIdOfTab(tabA)).toBe(a as string);
      expect(terminalIdOfTab(tabB)).toBe(b as string);
      expect(terminalIdOfTab(tabA)).not.toBe(terminalIdOfTab(tabB));
    });

    it("keeps the identity when the agent's tab is dragged to another pane", () => {
      // Moving a tab must not re-mint anything: the PTY is keyed by agentId for
      // the life of the agent.
      const agentId = act().createAgent({ cwd: "/w/gazelle" });
      const tabId = Object.keys(state().tabs)[0] as TabId;
      const layout = useAppStore.getState().layoutActions;
      const origin = state().layout.id;
      layout.openTerminalTab({ cwd: "/w/other" }); // so the pane survives
      const created = layout.splitPane(origin, "row");

      layout.moveTabToEdge(tabId, created, "bottom");

      expect(terminalIdOfTab(tabId)).toBe(agentId as string);
      expect(terminal.dispose).not.toHaveBeenCalled();
    });
  });

  it("selects the new agent — the pivot follows creation", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    expect(state().selection.selectedAgentId).toBe(agentId);
  });

  it("titles from the cwd basename unless told otherwise", () => {
    const a = act().createAgent({ cwd: "/w/gazelle" });
    expect(state().agents[a].title).toBe("gazelle");
    const b = act().createAgent({ cwd: "/w/api", title: "Pull latest changes" });
    expect(state().agents[b].title).toBe("Pull latest changes");
  });

  it("falls back to a generic title when the cwd has no basename", () => {
    // "/" and "" both leave nothing to name the agent after.
    const root = act().createAgent({ cwd: "/" });
    expect(state().agents[root].title).toBe("agent");
    const empty = act().createAgent({ cwd: "" });
    expect(state().agents[empty].title).toBe("agent");
  });

  it("mints a distinct agent + tab each time", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    const b = act().createAgent({ cwd: "/w/b" });
    expect(a).not.toBe(b);
    expect(state().rootAgentIds).toEqual([a, b]);
    expect(Object.keys(state().tabs)).toHaveLength(2);
  });
});

/* ═══════════════════════ collapsed-by-default (ergonomic) ═══════════════════════ */

describe("fan-out defaults collapsed", () => {
  const spawnChildEvent = (parent: string, child: string): AgentEvent => ({
    t: "subagent_spawned",
    parentId: id(parent),
    childAgentId: id(child),
    title: child,
    cwd: "/w/gazelle",
    branch: "trunk",
    runtime: "claude-code",
  });

  it("createAgent starts collapsed", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    expect(state().agents[agentId].expanded).toBe(false);
  });

  it("a spawned child starts collapsed and does NOT pop its parent open", () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent(spawnChildEvent("root", "kid"));

    // The child appearing must not expand the parent (no auto-expand-on-spawn).
    expect(agentOf("root").expanded).toBe(false);
    expect(agentOf("kid").expanded).toBe(false);
  });

  it("hides children behind a collapsed parent, but keeps caret + roll-up, and reveals on toggle", () => {
    act().applyAgentEvent(started("root", { title: "Pull latest changes" }));
    act().applyAgentEvent(spawnChildEvent("root", "kid"));

    // Collapsed: only the parent row, but it still advertises children + rollup
    // so the ▶ caret renders and "1 running" shows WITHOUT expanding.
    let rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: id("root"), expanded: false, hasChildren: true });
    expect(rows[0].rollup).toMatchObject({ total: 1, running: 1 });

    // The caret reveals the child.
    act().toggleAgentExpanded(id("root"));
    rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));
    expect(rows.map((r) => r.agentId)).toEqual([id("root"), id("kid")]);
  });
});

/* ══════════════════════════ selectAgent — the pivot ══════════════════════════ */

describe("selectAgent", () => {
  it("re-points by id only", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    const b = act().createAgent({ cwd: "/w/b" });
    const agentsBefore = state().agents;

    act().selectAgent(a);

    expect(state().selection.selectedAgentId).toBe(a);
    // No data moved: the records are untouched (identity, not deep-equal).
    expect(state().agents[a]).toBe(agentsBefore[a]);
    expect(state().agents[b]).toBe(agentsBefore[b]);
  });

  it("derives activeSessionId from the selected agent's ROOT, not the agent", () => {
    // Selecting a sub-agent keeps you in its root's session, because v1
    // sub-agents have no PTY of their own.
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "explore",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    useAppStore.setState((s) => {
      s.agents[id("root")].sessionId = "sess-1" as never;
    });

    act().selectAgent(id("kid"));

    expect(state().selection.selectedAgentId).toBe(id("kid"));
    expect(state().selection.activeSessionId).toBe("sess-1");
  });

  it("clears the unread badge on the row you opened", () => {
    act().applyAgentEvent(started("a1"));
    act().applyAgentEvent({ t: "status", agentId: id("a1"), status: "waiting_input" });
    expect(agentOf("a1").unread).toBe(1);

    act().selectAgent(id("a1"));

    expect(agentOf("a1").unread).toBe(0);
  });

  it("ignores an unknown agent, and re-selecting is a no-op", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    const settled = state();
    act().selectAgent(id("ghost"));
    act().selectAgent(a);
    expect(state()).toBe(settled);
  });

  /* ── the pivot: selecting an agent focuses its terminal tab ── */

  const layout = () => useAppStore.getState().layoutActions;
  /** The active tab in the (single, M2) pane holding this agent's terminal. */
  const activeTabId = () => {
    const walk = (n: ReturnType<typeof state>["layout"]): TabId | null =>
      n.type === "leaf" ? n.activeTabId : n.children.map(walk).find(Boolean) ?? null;
    return walk(state().layout);
  };
  const tabOfAgent = (agentId: AgentId): TabId => {
    const tab = Object.values(state().tabs).find(
      (t) => t.ref.kind === "agent-terminal" && t.ref.agentId === agentId,
    );
    if (!tab) throw new Error(`no agent tab for ${agentId}`);
    return tab.id;
  };

  it("focuses a SPAWNED agent's terminal tab", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    act().createAgent({ cwd: "/w/b" }); // b's tab is now the active one
    expect(activeTabId()).not.toBe(tabOfAgent(a));

    act().selectAgent(a);

    // Clicking a's row brings a's terminal to the front (M2: one pane, so the
    // active tab IS the focused terminal).
    expect(activeTabId()).toBe(tabOfAgent(a));
  });

  it("focuses an AD-HOC agent's promoted tab", () => {
    // The real-world case. Open a plain shell, promote it via agent_started,
    // then move focus away, then select the agent — its tab returns to front.
    const plainTab = layout().openTerminalTab({ cwd: "/w/scratch" });
    const ref = state().tabs[plainTab].ref;
    const agentId = (ref.kind === "terminal" || ref.kind === "agent-terminal"
      ? ref.terminalId
      : "") as unknown as AgentId;
    act().applyAgentEvent(started(agentId as unknown as string)); // promote

    layout().openTerminalTab({ cwd: "/w/other" }); // focus moves to a new tab
    expect(activeTabId()).not.toBe(plainTab);

    act().selectAgent(agentId);

    expect(activeTabId()).toBe(plainTab);
    expect(tabOfAgent(agentId)).toBe(plainTab); // same tab, now the agent's
  });

  it("re-focuses even when the agent is ALREADY selected", () => {
    // Select the agent, navigate the center away by activating another tab,
    // then click the still-selected row again: its terminal must come back.
    const a = act().createAgent({ cwd: "/w/a" });
    const otherTab = layout().openTerminalTab({ cwd: "/w/scratch" }); // same pane
    layout().setActiveTab(state().layout.id as never, otherTab);
    expect(activeTabId()).toBe(otherTab);
    expect(state().selection.selectedAgentId).toBe(a); // still selected

    act().selectAgent(a); // re-click the already-selected row

    expect(activeTabId()).toBe(tabOfAgent(a));
  });

  it("focuses the PANE holding the agent's tab when the layout is split", () => {
    // Multi-pane: the agent's tab lives in the SECOND pane, focus is on the
    // first. Selecting the agent must both activate its tab AND move pane focus
    // there — the scan skips the first (tab-less) leaf on the way.
    const originPane = state().layout.id;
    layout().openTerminalTab({ paneId: originPane, cwd: "/w/first" });
    const otherPane = layout().splitPane(originPane, "row"); // focus → new pane
    const a = act().createAgent({ cwd: "/w/a" }); // a's tab opens in otherPane
    expect(tabOfAgent(a)).toBe(state().tabs[tabOfAgent(a)].id);

    // Move focus back to the first pane so selecting the agent has work to do.
    layout().focusPane(originPane);
    expect(state().focusedPaneId).toBe(originPane);

    act().selectAgent(a);

    // Focus jumped to a's pane (the second leaf), and a's tab is active there.
    expect(state().focusedPaneId).toBe(otherPane);
    const root = state().layout;
    const leaf =
      root.type === "split" ? root.children.find((c) => c.id === otherPane) : root;
    expect(leaf && leaf.type === "leaf" ? leaf.activeTabId : null).toBe(tabOfAgent(a));
  });

  const spawnKid = () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });
  };
  /** The activity tab for `agentId`, if one is open. */
  const activityTabsFor = (agentId: AgentId) =>
    Object.values(state().tabs).filter(
      (t) => t.ref.kind === "agent-activity" && t.ref.agentId === agentId,
    );

  it("a sub-agent (no terminal) opens a read-only ACTIVITY tab, not a terminal", () => {
    spawnKid();

    act().selectAgent(id("kid"));

    expect(state().selection.selectedAgentId).toBe(id("kid"));
    // The center now shows the sub-agent's activity view, NOT a terminal.
    const active = activeTabId();
    const tab = active ? state().tabs[active] : undefined;
    expect(tab?.ref.kind).toBe("agent-activity");
    expect(tab && tab.ref.kind === "agent-activity" ? tab.ref.agentId : null).toBe(id("kid"));
    // No terminal was created for the sub-agent (it runs in-process, no PTY).
    expect(
      Object.values(state().tabs).some(
        (t) => t.ref.kind === "agent-terminal" && t.ref.agentId === id("kid"),
      ),
    ).toBe(false);
    assertLiveFleetInvariants();
  });

  it("titles the activity tab with the sub-agent's custom name when one is set", () => {
    spawnKid();
    act().renameAgent(id("kid"), "Recon");

    act().selectAgent(id("kid"));

    const active = activeTabId();
    const tab = active ? state().tabs[active] : undefined;
    expect(tab?.title).toBe("Recon");
  });

  it("reuses the sub-agent's activity tab on re-selection — never a second", () => {
    spawnKid();

    act().selectAgent(id("kid"));
    const first = activeTabId();
    expect(activityTabsFor(id("kid"))).toHaveLength(1);

    // Navigate the center away, then re-click the still-selected row.
    const other = layout().openTerminalTab({ cwd: "/w/scratch" });
    layout().setActiveTab(state().layout.id as never, other);
    expect(activeTabId()).toBe(other);

    act().selectAgent(id("kid"));

    // Same tab brought back to front; no duplicate opened.
    expect(activityTabsFor(id("kid"))).toHaveLength(1);
    expect(activeTabId()).toBe(first);
    assertLiveFleetInvariants();
  });
});

/* ══════════════════════════ telemetry ══════════════════════════ */

describe("applyAgentEvent", () => {
  it("agent_started registers an IDLE root", () => {
    // A root is born idle: it is parked at its prompt, not processing a turn. The
    // turn/activity hooks (status events) drive it to running and back. Defaulting
    // to running latched an idle welcome screen as "Running" forever.
    act().applyAgentEvent(started("a1", { title: "Pull latest changes" }));

    expect(agentOf("a1")).toMatchObject({
      title: "Pull latest changes",
      status: "idle",
      branch: "trunk",
      cwd: "/w/gazelle",
      kind: "orchestrator",
    });
    expect(state().rootAgentIds).toEqual([id("a1")]);
    assertLiveFleetInvariants();
  });

  it("status updates one agent and nothing else", () => {
    act().applyAgentEvent(started("a1"));
    act().applyAgentEvent(started("a2"));
    const before = agentOf("a2");

    act().applyAgentEvent({ t: "status", agentId: id("a1"), status: "waiting_input" });

    expect(agentOf("a1").status).toBe("waiting_input");
    // Identity: a2's record is untouched, which is what lets its row skip a
    // re-render (see AgentRow).
    expect(agentOf("a2")).toBe(before);
  });

  it("exited(0) is done; exited(non-zero) is error and records the code", () => {
    act().applyAgentEvent(started("ok"));
    act().applyAgentEvent(started("bad"));

    act().applyAgentEvent({ t: "exited", agentId: id("ok"), code: 0 });
    act().applyAgentEvent({ t: "exited", agentId: id("bad"), code: 143 });

    expect(agentOf("ok").status).toBe("done");
    expect(agentOf("ok").error).toBeUndefined();
    expect(agentOf("bad").status).toBe("error");
    expect(agentOf("bad").error).toContain("143");
    // Finished agents stay for inspection — never auto-removed (ARCHITECTURE §4).
    expect(state().rootAgentIds).toEqual([id("ok"), id("bad")]);
    expect(agentOf("ok").finishedAt).not.toBeNull();
  });

  it("activity only moves the clock — no visible field changes", () => {
    // Precisely why <AgentRow> subscribes per-field: this must not re-render it.
    act().applyAgentEvent(started("a1"));
    const before = agentOf("a1");

    act().applyAgentEvent({ t: "activity", agentId: id("a1"), at: 12345 });

    expect(agentOf("a1").lastActivityAt).toBe(12345);
    expect(agentOf("a1").title).toBe(before.title);
    expect(agentOf("a1").status).toBe(before.status);
  });

  it("title renames in place", () => {
    act().applyAgentEvent(started("a1"));
    act().applyAgentEvent({ t: "title", agentId: id("a1"), title: "Refactor API layer" });
    expect(agentOf("a1").title).toBe("Refactor API layer");
  });

  it("ignores telemetry for an agent it has never seen", () => {
    // Rust may emit for an agent whose `agent_started` we missed; dropping the
    // event is right, crashing or inventing a half-record is not.
    const settled = state();
    act().applyAgentEvent({ t: "status", agentId: id("ghost"), status: "done" });
    act().applyAgentEvent({ t: "exited", agentId: id("ghost"), code: 0 });
    act().applyAgentEvent({ t: "title", agentId: id("ghost"), title: "x" });
    act().applyAgentEvent({ t: "activity", agentId: id("ghost"), at: 1 });
    expect(state()).toBe(settled);
  });

  it("agent_started with a parentId registers a SUB-agent, nested", () => {
    // The adapter may announce a sub-agent via agent_started rather than
    // subagent_spawned; kind must follow parentId, not the event name, or the
    // row renders as a top-level orchestrator.
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({ ...started("kid"), parentId: id("root") });

    expect(agentOf("kid").kind).toBe("subagent");
    // A sub-agent announced via agent_started is born RUNNING (it exists only
    // because it is already working) — unlike a root, which is born idle.
    expect(agentOf("kid").status).toBe("running");
    expect(agentOf("root").childIds).toEqual([id("kid")]);
    expect(state().rootAgentIds).toEqual([id("root")]);
    assertLiveFleetInvariants();
  });

  it("agent_started twice does not duplicate the row", () => {
    act().applyAgentEvent(started("a1"));
    act().applyAgentEvent(started("a1", { title: "renamed" }));
    expect(state().rootAgentIds).toEqual([id("a1")]);
    expect(agentOf("a1").title).toBe("renamed");
    assertLiveFleetInvariants();
  });
});

/* ══════════════════════════ spawnChild (M3, inert) ══════════════════════════ */

describe("subagent_spawned — wired, inert until M3", () => {
  it("is unreachable from the UI: no action exposes it", () => {
    // Enforced by construction, not convention: `spawnChild` is module-private,
    // so "only the telemetry reducer may spawn a child" cannot be violated by a
    // future component author.
    expect(Object.keys(act())).not.toContain("spawnChild");
    expect(Object.keys(act()).sort()).toEqual([
      "applyAgentEvent",
      "applyFleetSnapshot",
      "applyPinnedAgents",
      // The "Resumed after restart" markers (open_agents.rs) — boot-only, like pins.
      "applyRestoredAgents",
      "createAgent",
      "dismissAgent",
      "moveRootAgent",
      "pinAgent",
      "removeAgent",
      "renameAgent",
      // The gated wrapper over `dismissAgent`: the rail's ✕ asks first when
      // the agent's terminal is still working. Both are exposed on purpose —
      // `dismissAgent` stays the primitive the confirm replays.
      "requestDismissAgent",
      "selectAgent",
      "toggleAgentExpanded",
      "toggleFolderCollapsed",
      "unpinAgent",
    ]);
  });

  it("hangs a child off its parent when telemetry says so", () => {
    act().applyAgentEvent(started("root"));

    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "explore-codebase",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

    expect(agentOf("root").childIds).toEqual([id("kid")]);
    expect(agentOf("kid")).toMatchObject({
      parentId: id("root"),
      kind: "subagent",
      title: "explore-codebase",
      status: "running",
      sessionId: null, // v1 sub-agents own no PTY
    });
    // A child is NOT a root — it renders under its parent.
    expect(state().rootAgentIds).toEqual([id("root")]);
    assertLiveFleetInvariants();
  });

  it("a child first seen ALREADY ENDED reads ended — the status Rust sends right after the spawn", () => {
    // After a restart Rust emits `subagent_spawned` (no status) then `status` for long-ended
    // sub-agents; the row must end `done`/`error` and the parent's status must not move.
    act().applyAgentEvent(started("root"));
    for (const [kid, status] of [
      ["old-done", "done"],
      ["old-failed", "error"],
    ] as const) {
      act().applyAgentEvent({
        t: "subagent_spawned",
        parentId: id("root"),
        childAgentId: id(kid),
        title: kid,
        cwd: "/w/gazelle",
        branch: "trunk",
        runtime: "claude-code",
      });
      act().applyAgentEvent({ t: "status", agentId: id(kid), status });
    }

    expect(agentOf("old-done").status).toBe("done");
    expect(agentOf("old-failed").status).toBe("error");
    expect(agentOf("root").status).toBe("idle");
    expect(agentOf("root").childIds).toEqual([id("old-done"), id("old-failed")]);
    assertLiveFleetInvariants();
  });

  it("surfaces an orphan as a root rather than dropping it", () => {
    // A child whose parent we have not seen. Visible-in-the-wrong-place beats
    // invisible.
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("unseen"),
      childAgentId: id("kid"),
      title: "explore",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

    expect(agentOf("kid")).toBeDefined();
    expect(state().rootAgentIds).toEqual([id("kid")]);
    assertLiveFleetInvariants();
  });
});

/* ══════════ the live fan-out tree — M3 headline, mirroring the Rust fixture ══════════ */

describe("live fan-out: a depth-2 tree from SubagentSpawned events", () => {
  const spawn = (parent: string, child: string, status: AgentStatus = "running") => {
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id(parent),
      childAgentId: id(child),
      title: child,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    if (status !== "running") {
      act().applyAgentEvent(
        status === "error"
          ? { t: "exited", agentId: id(child), code: 1 }
          : status === "done"
            ? { t: "exited", agentId: id(child), code: 0 }
            : { t: "status", agentId: id(child), status },
      );
    }
  };

  /** The Rust fixture's shape: a root, 19 depth-1 sub-agents, 5 at depth 2 under the first. */
  function buildFixture() {
    act().applyAgentEvent(started("root", { title: "Pull latest changes" }));
    const depth1 = Array.from({ length: 19 }, (_, i) => `c${i}`);
    for (const c of depth1) spawn("root", c);
    const depth2 = Array.from({ length: 5 }, (_, i) => `g${i}`);
    for (const g of depth2) spawn("c0", g);
    // Agents default COLLAPSED now; these tests are about the OPEN tree's shape,
    // so open every node. The collapse tests below then toggle specific nodes
    // shut, which is the behaviour they mean to exercise.
    expandAll();
    return { depth1, depth2 };
  }

  beforeEach(() => resetFleetRowsCache());

  it("builds the forest: 19 at depth 1, 5 at depth 2, all under the root", () => {
    const { depth1, depth2 } = buildFixture();

    expect(state().rootAgentIds).toEqual([id("root")]);
    expect(agentOf("root").childIds).toEqual(depth1.map(id));
    expect(agentOf("c0").childIds).toEqual(depth2.map(id));
    // 1 root + 19 + 5 = 25 nodes, every sub-agent kind 'subagent'.
    expect(Object.keys(state().agents)).toHaveLength(25);
    for (const c of depth1) expect(agentOf(c).kind).toBe("subagent");
    for (const g of depth2) expect(agentOf(g).kind).toBe("subagent");
    assertLiveFleetInvariants();
  });

  it("renders the nesting: root(0) → 19 children(1) → 5 grandchildren(2)", () => {
    buildFixture();
    const rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));

    // Fully expanded: 25 rows. Depths: root=0, c0=1 then its 5 g's=2, then the
    // remaining 18 c's=1.
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatchObject({ agentId: id("root"), depth: 0 });
    expect(rows[1]).toMatchObject({ agentId: id("c0"), depth: 1 });
    // c0's grandchildren come immediately after it, at depth 2.
    expect(rows.slice(2, 7).map((r) => r.depth)).toEqual([2, 2, 2, 2, 2]);
    expect(rows.slice(2, 7).map((r) => r.agentId)).toEqual(
      ["g0", "g1", "g2", "g3", "g4"].map(id),
    );
    // Then the rest of the depth-1 children.
    expect(rows[7]).toMatchObject({ agentId: id("c1"), depth: 1 });
  });

  it("rolls the whole subtree up onto the root", () => {
    buildFixture();
    // Mark two grandchildren done and one errored.
    act().applyAgentEvent({ t: "exited", agentId: id("g1"), code: 0 });
    act().applyAgentEvent({ t: "exited", agentId: id("g2"), code: 0 });
    act().applyAgentEvent({ t: "exited", agentId: id("g3"), code: 1 });

    const rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));
    const root = rows.find((r) => r.agentId === id("root"))!;

    // 24 descendants: 19 c's (all running) + 5 g's (2 done, 1 error, 2 running).
    expect(root.rollup).toMatchObject({
      total: 24,
      done: 2,
      error: 1,
      running: 21, // 19 c's + g0 + g4
    });
    // And the error bubbled to the top.
    expect(root.attention).toBe(true);
  });

  it("collapsing the root hides all 24 descendants but keeps the roll-up", () => {
    buildFixture();
    act().applyAgentEvent({ t: "exited", agentId: id("g3"), code: 1 });
    act().toggleAgentExpanded(id("root"));

    const rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));
    expect(rows).toHaveLength(1); // just the root
    expect(rows[0].expanded).toBe(false);
    expect(rows[0].rollup?.total).toBe(24); // still summarized
    expect(rows[0].attention).toBe(true); // the deep error still surfaces
  });

  it("collapsing a mid-node hides only its subtree", () => {
    buildFixture();
    act().toggleAgentExpanded(id("c0")); // hide the 5 grandchildren

    const rows = agentRowsOf(flattenFleet(state().agents, state().rootAgentIds));
    // 25 − 5 hidden = 20 rows. c0 present (collapsed), its g's gone.
    expect(rows).toHaveLength(20);
    expect(rows.some((r) => r.agentId === id("c0"))).toBe(true);
    expect(rows.some((r) => r.agentId === id("g0"))).toBe(false);
    // The 18 other depth-1 children are still shown.
    expect(rows.filter((r) => r.depth === 1)).toHaveLength(19);
  });

  it("closing the root cascades — every descendant is removed and tombstoned", () => {
    const { depth1, depth2 } = buildFixture();

    act().removeAgent(id("root"));

    // No ghost sub-agents anywhere.
    expect(state().agents).toEqual({});
    expect(state().rootAgentIds).toEqual([]);
    for (const anyId of ["root", ...depth1, ...depth2]) {
      expect(state().dismissedAgentIds).toContain(id(anyId));
    }
    assertLiveFleetInvariants();
  });

  it("a late SubagentSpawned for a dismissed subtree is a no-op (tombstone wins)", () => {
    buildFixture();
    act().removeAgent(id("root")); // dismiss the whole tree

    // Rust's tailer, mid-flight, emits one more child under a now-dead parent.
    spawn("c0", "g-late");

    expect(agentOf("g-late")).toBeUndefined();
    expect(agentOf("c0")).toBeUndefined();
    expect(state().rootAgentIds).toEqual([]);
  });

  it("selecting a sub-agent mints its read-only activity tab (never a terminal)", () => {
    buildFixture();
    act().selectAgent(id("g2"));
    expect(state().selection.selectedAgentId).toBe(id("g2"));
    // A telemetry-only sub-agent has no PTY, so it gets exactly one
    // agent-activity tab — and never an agent-terminal.
    const refs = Object.values(state().tabs).map((t) => t.ref);
    expect(refs).toEqual([{ kind: "agent-activity", agentId: id("g2") }]);
  });
});

/* ════════════ forest consistency (regressions, all property-found) ════════════ */

describe("forest consistency under out-of-order telemetry", () => {
  const spawn = (parent: string, child: string) =>
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id(parent),
      childAgentId: id(child),
      title: child,
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

  it("adopts an orphan when its parent finally arrives", () => {
    // Events are unordered across agents, so `subagent_spawned` can beat the parent's
    // `agent_started`; without adoption the child stays a top-level root forever, silently.
    spawn("root", "kid");
    expect(state().rootAgentIds).toEqual([id("kid")]); // visible, if misplaced

    act().applyAgentEvent(started("root"));

    expect(state().rootAgentIds).toEqual([id("root")]);
    expect(agentOf("root").childIds).toEqual([id("kid")]);
    expect(agentOf("kid").parentId).toBe(id("root"));
    assertLiveFleetInvariants();
  });

  it("adopts orphans from an out-of-order snapshot in one pass", () => {
    act().applyFleetSnapshot([
      wireAgent({ id: id("kid"), parentId: id("root"), kind: "subagent" }),
      wireAgent({ id: id("root") }),
    ]);
    expect(agentOf("root").childIds).toEqual([id("kid")]);
    expect(state().rootAgentIds).toEqual([id("root")]);
  });

  it("adopts several orphans waiting on the same parent", () => {
    spawn("root", "kid1");
    spawn("root", "kid2");
    expect(state().rootAgentIds).toEqual([id("kid1"), id("kid2")]);

    act().applyAgentEvent(started("root"));

    expect(agentOf("root").childIds).toEqual([id("kid1"), id("kid2")]);
    expect(state().rootAgentIds).toEqual([id("root")]);
    assertLiveFleetInvariants();
  });

  it("re-parenting removes the agent from its OLD parent", () => {
    // A stale childIds entry means the forest disagrees with itself: two
    // parents both claiming the same child.
    act().applyAgentEvent(started("p1"));
    act().applyAgentEvent(started("p2"));
    spawn("p1", "kid");
    expect(agentOf("p1").childIds).toEqual([id("kid")]);

    spawn("p2", "kid"); // re-spawned under a different parent

    expect(agentOf("p1").childIds).toEqual([]);
    expect(agentOf("p2").childIds).toEqual([id("kid")]);
    assertLiveFleetInvariants();
  });

  it("promoting a child to a root removes it from its old parent", () => {
    act().applyAgentEvent(started("root"));
    spawn("root", "kid");

    act().applyAgentEvent(started("kid")); // now claims parentId null

    expect(agentOf("root").childIds).toEqual([]);
    expect(state().rootAgentIds).toEqual([id("root"), id("kid")]);
    assertLiveFleetInvariants();
  });

  it("normalizes a self-parented agent to a root instead of hiding it", () => {
    // Malformed telemetry. Left alone, the agent sits only in its own childIds:
    // reachable from no root, so the rail cannot draw it and the user cannot
    // dismiss it. An invisible un-killable agent is the worst outcome.
    spawn("solo", "solo");

    expect(agentOf("solo").parentId).toBeNull();
    expect(state().rootAgentIds).toEqual([id("solo")]);
    expect(agentOf("solo").childIds).toEqual([]);
    assertLiveFleetInvariants();
  });
});

/* ══════════════════════════ unread bubbling ══════════════════════════ */

describe("waiting_input bubbles up the ancestor chain", () => {
  const spawn = (parent: string, child: string) =>
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id(parent),
      childAgentId: id(child),
      title: child,
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

  it("makes a blocked descendant visible from a collapsed trunk", () => {
    // The whole point of the fan-out tree is that you can find
    // the one agent that needs you without expanding everything.
    act().applyAgentEvent(started("root"));
    spawn("root", "mid");
    spawn("mid", "deep");

    act().applyAgentEvent({ t: "status", agentId: id("deep"), status: "waiting_input" });

    expect(agentOf("deep").unread).toBe(1);
    expect(agentOf("mid").unread).toBe(1);
    expect(agentOf("root").unread).toBe(1);
  });

  it("does not bubble for ordinary status changes", () => {
    act().applyAgentEvent(started("root"));
    spawn("root", "kid");

    act().applyAgentEvent({ t: "status", agentId: id("kid"), status: "running" });
    act().applyAgentEvent({ t: "status", agentId: id("kid"), status: "done" });

    expect(agentOf("root").unread).toBe(0);
  });

  it("clears the badge on an agent that is ALREADY selected", () => {
    // The selected agent can raise a badge while watched; an "already selected, bail out" guard
    // before the clear would leave the badge stuck.
    const a = act().createAgent({ cwd: "/w/gazelle" });
    expect(state().selection.selectedAgentId).toBe(a); // createAgent selected it

    act().applyAgentEvent({ t: "status", agentId: a, status: "waiting_input" });
    expect(state().agents[a].unread).toBe(1);

    act().selectAgent(a); // clicking the row you are already on

    expect(state().agents[a].unread).toBe(0);
  });

  it("unwinds the roll-up: reading a descendant clears its ancestors too", () => {
    // The badge bubbles up to collapsed trunks, so reading it must clear the whole chain, or the
    // trunk advertises a "needs input" that was already answered.
    act().applyAgentEvent(started("root"));
    spawn("root", "mid");
    spawn("mid", "deep");
    act().applyAgentEvent({ t: "status", agentId: id("deep"), status: "waiting_input" });
    expect([agentOf("deep").unread, agentOf("mid").unread, agentOf("root").unread]).toEqual([1, 1, 1]);

    act().selectAgent(id("deep"));

    expect([agentOf("deep").unread, agentOf("mid").unread, agentOf("root").unread]).toEqual([0, 0, 0]);
  });

  it("keeps an ancestor's badge for a sibling that is still blocked", () => {
    act().applyAgentEvent(started("root"));
    spawn("root", "kid1");
    spawn("root", "kid2");
    act().applyAgentEvent({ t: "status", agentId: id("kid1"), status: "waiting_input" });
    act().applyAgentEvent({ t: "status", agentId: id("kid2"), status: "waiting_input" });
    expect(agentOf("root").unread).toBe(2);

    act().selectAgent(id("kid1"));

    expect(agentOf("kid1").unread).toBe(0);
    // kid2 is still waiting — the trunk must still say so.
    expect(agentOf("root").unread).toBe(1);
    expect(agentOf("kid2").unread).toBe(1);
  });

  it("never lets a badge go negative", () => {
    act().applyAgentEvent(started("root"));
    spawn("root", "kid");
    act().applyAgentEvent({ t: "status", agentId: id("kid"), status: "waiting_input" });
    act().selectAgent(id("root")); // clears the root's bubbled count first
    act().selectAgent(id("kid")); // then the leaf's — the root is already at 0

    expect(agentOf("root").unread).toBe(0);
    expect(agentOf("kid").unread).toBe(0);
  });

  it("terminates on a parent cycle instead of spinning", () => {
    act().applyAgentEvent(started("a"));
    act().applyAgentEvent(started("b"));
    useAppStore.setState((s) => {
      s.agents[id("a")].parentId = id("b");
      s.agents[id("b")].parentId = id("a");
    });

    act().applyAgentEvent({ t: "status", agentId: id("a"), status: "waiting_input" });

    expect(agentOf("a").unread).toBe(1);
    expect(agentOf("b").unread).toBe(1);
  });
});

/* ══════════════════════════ fleet_snapshot ══════════════════════════ */

describe("applyFleetSnapshot", () => {
  it("hydrates the UI-only fields the wire never sends", () => {
    // ARCHITECTURE §2.2: childIds/sessionId/expanded/unread are store-maintained. A snapshot
    // without them must not leave `childIds` undefined for the rail to walk.
    act().applyFleetSnapshot([wireAgent({ id: id("a1") })]);

    expect(agentOf("a1").childIds).toEqual([]);
    expect(agentOf("a1").expanded).toBe(false); // collapsed by default (ergonomic)
    expect(agentOf("a1").unread).toBe(0);
    expect(agentOf("a1").sessionId).toBeNull();
    assertLiveFleetInvariants();
  });

  it("rebuilds the forest from parentId edges, in any order", () => {
    // Rust sends a flat array; a child may precede its parent in it.
    act().applyFleetSnapshot([
      wireAgent({ id: id("kid"), parentId: id("root"), kind: "subagent" }),
      wireAgent({ id: id("root") }),
    ]);

    expect(agentOf("root").childIds).toEqual([id("kid")]);
    expect(state().rootAgentIds).toEqual([id("root")]);
    assertLiveFleetInvariants();
  });

  it("preserves view state across a re-snapshot", () => {
    // Re-attach must not collapse a tree the user opened (agents default
    // collapsed, so "opened" is the manual state a snapshot must preserve).
    act().applyFleetSnapshot([wireAgent({ id: id("a1") })]);
    act().toggleAgentExpanded(id("a1")); // user opens it: false -> true
    expect(agentOf("a1").expanded).toBe(true);

    act().applyFleetSnapshot([wireAgent({ id: id("a1"), title: "updated" })]);

    expect(agentOf("a1").expanded).toBe(true); // still expanded — not clobbered
    expect(agentOf("a1").title).toBe("updated"); // but wire state refreshed
  });

  it("does not duplicate rows when applied twice", () => {
    const snapshot = [wireAgent({ id: id("a1") }), wireAgent({ id: id("a2") })];
    act().applyFleetSnapshot(snapshot);
    act().applyFleetSnapshot(snapshot);

    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
    assertLiveFleetInvariants();
  });

  it("an empty snapshot changes nothing", () => {
    act().applyAgentEvent(started("a1"));
    act().applyFleetSnapshot([]);
    expect(agentOf("a1")).toBeDefined();
  });
});

/* ══════════════════════ toggleFolderCollapsed ══════════════════════ */

describe("toggleFolderCollapsed", () => {
  it("defaults expanded (absent), and toggles a path in/out of collapsedFolders", () => {
    expect(state().collapsedFolders.has("/w/gazelle")).toBe(false); // default expanded
    act().toggleFolderCollapsed("/w/gazelle");
    expect(state().collapsedFolders.has("/w/gazelle")).toBe(true);
    act().toggleFolderCollapsed("/w/gazelle");
    expect(state().collapsedFolders.has("/w/gazelle")).toBe(false);
  });

  it("tracks folders independently", () => {
    act().toggleFolderCollapsed("/w/a");
    expect(state().collapsedFolders.has("/w/a")).toBe(true);
    expect(state().collapsedFolders.has("/w/b")).toBe(false);
  });
});

/* ══════════════════════════ renameAgent ══════════════════════════ */

describe("renameAgent (custom name)", () => {
  it("sets a custom name", () => {
    act().applyAgentEvent(started("a1", { title: "Pull latest changes" }));
    act().renameAgent(id("a1"), "Deploy pipeline");
    expect(agentOf("a1").customTitle).toBe("Deploy pipeline");
  });

  it("trims surrounding whitespace", () => {
    act().applyAgentEvent(started("a1"));
    act().renameAgent(id("a1"), "  My Agent  ");
    expect(agentOf("a1").customTitle).toBe("My Agent");
  });

  it("clears the custom name on empty or whitespace (reverts to derived title)", () => {
    act().applyAgentEvent(started("a1"));
    act().renameAgent(id("a1"), "Custom");
    act().renameAgent(id("a1"), "   ");
    expect(agentOf("a1").customTitle).toBeNull();
  });

  it("clears the custom name on null", () => {
    act().applyAgentEvent(started("a1"));
    act().renameAgent(id("a1"), "Custom");
    act().renameAgent(id("a1"), null);
    expect(agentOf("a1").customTitle).toBeNull();
  });

  it("survives a status AND a title update from Rust (the load-bearing case)", () => {
    act().applyAgentEvent(started("a1", { title: "orig" }));
    act().renameAgent(id("a1"), "Keep me");

    act().applyAgentEvent({ t: "status", agentId: id("a1"), status: "waiting_input" });
    act().applyAgentEvent({ t: "title", agentId: id("a1"), title: "Rust-renamed" });

    expect(agentOf("a1").customTitle).toBe("Keep me"); // user's name is untouched
    expect(agentOf("a1").title).toBe("Rust-renamed"); // the derived title still tracks Rust
  });

  it("survives a re-fired fleet_snapshot", () => {
    act().applyFleetSnapshot([wireAgent({ id: id("a1"), title: "orig" })]);
    act().renameAgent(id("a1"), "Keep me");

    act().applyFleetSnapshot([wireAgent({ id: id("a1"), title: "updated" })]);

    expect(agentOf("a1").customTitle).toBe("Keep me");
    expect(agentOf("a1").title).toBe("updated");
  });

  it("renames a SUBAGENT too (same node type)", () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "explore",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    act().renameAgent(id("kid"), "The explorer");
    expect(agentOf("kid").customTitle).toBe("The explorer");
  });

  it("is a no-op for an unknown agent", () => {
    expect(() => act().renameAgent(id("ghost"), "x")).not.toThrow();
  });
});

/* ══════════════════════════ removeAgent ══════════════════════════ */

describe("removeAgent", () => {
  it("takes the whole subtree with it", () => {
    act().applyAgentEvent(started("root"));
    for (const [parent, child] of [["root", "mid"], ["mid", "deep"]]) {
      act().applyAgentEvent({
        t: "subagent_spawned",
        parentId: id(parent),
        childAgentId: id(child),
        title: child,
        cwd: "/w",
        branch: "trunk",
        runtime: "claude-code",
      });
    }

    act().removeAgent(id("root"));

    // Orphans would otherwise resurface as roots.
    expect(state().agents).toEqual({});
    expect(state().rootAgentIds).toEqual([]);
    assertLiveFleetInvariants();
  });

  it("detaches a child from its parent's childIds", () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

    act().removeAgent(id("kid"));

    expect(agentOf("root").childIds).toEqual([]);
    assertLiveFleetInvariants();
  });

  it("moves the selection off a removed agent", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    const b = act().createAgent({ cwd: "/w/b" });
    act().selectAgent(b);

    act().removeAgent(b);

    expect(state().selection.selectedAgentId).toBe(a);
    assertLiveFleetInvariants();
  });

  it("leaves the forest untouched for an unknown agent, but still tombstones it", () => {
    // Removing an unknown id changes no agent but tombstones it: a dismiss can race ahead of the
    // create it cancels, and "dismissed" must win regardless of arrival order.
    act().applyAgentEvent(started("a1"));
    const agentsBefore = state().agents;

    act().removeAgent(id("ghost"));

    expect(state().agents).toBe(agentsBefore); // forest untouched (identity)
    expect(state().dismissedAgentIds).toContain(id("ghost"));
    // And the tombstone bites: a later start for it is a no-op.
    act().applyAgentEvent(started("ghost"));
    expect(agentOf("ghost")).toBeUndefined();
  });

  it("clears the selection when the last agent goes", () => {
    const a = act().createAgent({ cwd: "/w/a" });
    act().removeAgent(a);
    expect(state().selection.selectedAgentId).toBeNull();
    expect(state().rootAgentIds).toEqual([]);
    assertLiveFleetInvariants();
  });

  it("terminates when the subtree is cyclic", () => {
    // The collect walk must not recurse forever on malformed childIds — same
    // class of hazard as the rail's flatten, and the same consequence: a frozen
    // window instead of a removed agent.
    act().applyAgentEvent(started("a"));
    act().applyAgentEvent(started("b"));
    useAppStore.setState((s) => {
      s.agents[id("a")].childIds = [id("b")];
      s.agents[id("b")].childIds = [id("a")];
      s.agents[id("b")].parentId = id("a");
      s.rootAgentIds = [id("a")];
    });

    act().removeAgent(id("a"));

    expect(state().agents).toEqual({});
    expect(state().rootAgentIds).toEqual([]);
  });
});

/* ════════════════ dismissAgent + the resurrection race ════════════════ */

describe("dismissAgent — the row's ✕", () => {
  const layout = () => useAppStore.getState().layoutActions;
  const tabsOf = () => Object.values(state().tabs);

  it("closing an agent's TAB removes the agent (not a greyed done)", () => {
    // Closing the tab must close the agent too, because it is
    // not going to be opened again. Closing the tab is dismissal.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    const tabId = tabsOf()[0].id;
    expect(agentOf(agentId)).toBeDefined();

    layout().closeTab(tabId);

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
    // The child was killed: closeTab → dispose → terminal_close.
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
  });

  it("the row ✕ (dismissAgent) removes the agent the SAME way", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });

    act().dismissAgent(agentId);

    expect(state().agents[agentId]).toBeUndefined();
    // Same path: dismissAgent found the tab and closed it, so the tab is gone
    // and the terminal was disposed — identical to closing the tab directly.
    expect(tabsOf()).toHaveLength(0);
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
  });

  it("finds the RIGHT agent's tab when several are open", () => {
    // `findAgentTab` scans every tab; it must skip other agents' terminals
    // (agent-terminals with a different id) and dismiss only the one asked for.
    const a = act().createAgent({ cwd: "/w/a" });
    const b = act().createAgent({ cwd: "/w/b" });
    expect(tabsOf()).toHaveLength(2);

    act().dismissAgent(b); // b's tab is second — a's must be skipped, not closed

    expect(state().agents[a]).toBeDefined();
    expect(state().agents[b]).toBeUndefined();
    expect(tabsOf()).toHaveLength(1);
    expect(terminal.dispose).toHaveBeenCalledWith(b);
    expect(terminal.dispose).not.toHaveBeenCalledWith(a);
  });

  it("tab ✕ and row ✕ leave identical state", () => {
    // Prove "same dismissal path" by outcome, not by inspection.
    const viaTab = (() => {
      resetStore();
      resetFleetStore();
      const a = act().createAgent({ cwd: "/w/gazelle" });
      layout().closeTab(Object.values(state().tabs)[0].id);
      return { agents: state().agents, roots: state().rootAgentIds, tabs: state().tabs, a };
    })();
    const viaRow = (() => {
      resetStore();
      resetFleetStore();
      const a = act().createAgent({ cwd: "/w/gazelle" });
      act().dismissAgent(a);
      return { agents: state().agents, roots: state().rootAgentIds, tabs: state().tabs };
    })();

    expect(viaRow.agents).toEqual(viaTab.agents); // both empty
    expect(viaRow.roots).toEqual(viaTab.roots);
    expect(Object.keys(viaRow.tabs)).toEqual(Object.keys(viaTab.tabs));
  });

  it("closing a PLAIN terminal removes NO agent", () => {
    // A shell tab has no agent behind it — dismissal must not invent one, nor
    // touch the fleet.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    const plainTab = layout().openTerminalTab({ cwd: "/w/scratch" });
    expect(tabsOf()).toHaveLength(2);

    layout().closeTab(plainTab);

    // The agent and its tab are untouched; only the shell closed.
    expect(state().agents[agentId]).toBeDefined();
    expect(state().dismissedAgentIds).toHaveLength(0);
    expect(tabsOf()).toHaveLength(1);
  });

  it("dismisses a sub-agent that has no tab of its own (M3-ready)", () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

    act().dismissAgent(id("kid"));

    expect(agentOf("kid")).toBeUndefined();
    expect(agentOf("root").childIds).toEqual([]);
    // No tab existed, so the direct branch ran and still tried to kill a child
    // keyed by the agentId (idempotent if already dead).
    expect(terminal.dispose).toHaveBeenCalledWith(id("kid"));
    assertLiveFleetInvariants();
  });

  it("dismissing a sub-agent CLOSES its open activity tab (no zombie poller)", () => {
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });
    act().selectAgent(id("kid")); // opens the read-only activity tab
    const activityTab = tabsOf().find((t) => t.ref.kind === "agent-activity");
    expect(activityTab).toBeDefined();

    act().dismissAgent(id("kid"));

    expect(agentOf("kid")).toBeUndefined();
    // Tab is gone from the record map AND its leaf — <ActivityView> unmounts, so
    // its 1.5 s poller's clearInterval finally runs instead of hammering Rust for
    // a dropped agent forever.
    expect(state().tabs[activityTab!.id]).toBeUndefined();
    expect(tabsOf().some((t) => t.ref.kind === "agent-activity")).toBe(false);
    assertLiveStoreInvariants();
    assertLiveFleetInvariants();
  });

  it("cascades: dismissing a root drops its whole subtree", () => {
    act().applyAgentEvent(started("root"));
    for (const [parent, child] of [["root", "mid"], ["mid", "deep"]]) {
      act().applyAgentEvent({
        t: "subagent_spawned",
        parentId: id(parent),
        childAgentId: id(child),
        title: child,
        cwd: "/w",
        branch: "trunk",
        runtime: "claude-code",
      });
    }

    act().dismissAgent(id("root"));

    expect(state().agents).toEqual({});
    // Every id in the subtree is tombstoned, so none can come back.
    expect(state().dismissedAgentIds).toEqual(
      expect.arrayContaining([id("root"), id("mid"), id("deep")]),
    );
    assertLiveFleetInvariants();
  });

  it("cascading dismiss of a root closes EVERY descendant's activity tab", () => {
    act().applyAgentEvent(started("root"));
    for (const [parent, child] of [["root", "mid"], ["mid", "deep"]]) {
      act().applyAgentEvent({
        t: "subagent_spawned",
        parentId: id(parent),
        childAgentId: id(child),
        title: child,
        cwd: "/w",
        branch: "trunk",
        runtime: "claude-code",
      });
    }
    act().selectAgent(id("mid")); // activity tab for mid
    act().selectAgent(id("deep")); // activity tab for deep
    expect(tabsOf().filter((t) => t.ref.kind === "agent-activity")).toHaveLength(2);

    act().dismissAgent(id("root")); // no terminal tab → direct removeAgentFromForest cascade

    expect(state().agents).toEqual({});
    // Both descendants' activity tabs were swept by the cascade — no orphans.
    expect(tabsOf().filter((t) => t.ref.kind === "agent-activity")).toHaveLength(0);
    assertLiveStoreInvariants();
    assertLiveFleetInvariants();
  });

  it("closes an activity tab living in a non-focused split pane", () => {
    // The tab to sweep sits in the second pane; the sweep must scan past the
    // first (which does not hold it) to find and close it.
    const origin = state().layout.id;
    layout().splitPane(origin, "row"); // focus → the new second pane
    act().applyAgentEvent(started("root"));
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });
    act().selectAgent(id("kid")); // activity tab opens in the focused (second) pane
    expect(tabsOf().filter((t) => t.ref.kind === "agent-activity")).toHaveLength(1);

    act().dismissAgent(id("kid"));

    expect(tabsOf().some((t) => t.ref.kind === "agent-activity")).toBe(false);
    assertLiveStoreInvariants();
    assertLiveFleetInvariants();
  });

  it("dismissing a root with a live terminal also sweeps its sub-agent's activity tab", () => {
    // The plain-layout path: `closeTab` canonicalizes the root's terminal tab
    // first, THEN the cascade sweeps the sub-agent's activity tab against an
    // already-reassigned (non-draft) layout.
    const root = act().createAgent({ cwd: "/w/gazelle" }); // owns a terminal tab
    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: root,
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });
    act().selectAgent(id("kid")); // kid's activity tab
    expect(tabsOf().filter((t) => t.ref.kind === "agent-activity")).toHaveLength(1);

    act().dismissAgent(root);

    expect(state().agents).toEqual({});
    expect(tabsOf()).toHaveLength(0); // both the terminal tab AND the activity tab
    expect(terminal.dispose).toHaveBeenCalledWith(root);
    assertLiveStoreInvariants();
    assertLiveFleetInvariants();
  });

  it("a NATURAL exit is NOT a dismissal — the node stays for inspection", () => {
    // The other half of the model: an agent that finishes on its own
    // stays greyed until the user acts.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });

    act().applyAgentEvent({ t: "exited", agentId, code: 0 });

    expect(state().agents[agentId]).toBeDefined();
    expect(state().agents[agentId].status).toBe("done");
    expect(state().dismissedAgentIds).toHaveLength(0);
  });
});

describe("dismissAgent — late telemetry cannot resurrect a ghost", () => {
  // THE race the whole tombstone exists for. Rust drops the agent from its
  // forest on close, but events already in flight still land. A dismissed agent
  // must STAY dismissed — restoring the resurrect bug must fail these.

  it("a late `exited` after dismissal does not bring the agent back", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(agentId);
    expect(state().agents[agentId]).toBeUndefined();

    act().applyAgentEvent({ t: "exited", agentId, code: 0 });

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
  });

  it("a late `status` does not bring it back", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(agentId);

    act().applyAgentEvent({ t: "status", agentId, status: "running" });

    expect(state().agents[agentId]).toBeUndefined();
  });

  it("a late `activity` does not bring it back", () => {
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(agentId);

    act().applyAgentEvent({ t: "activity", agentId, at: 999 });

    expect(state().agents[agentId]).toBeUndefined();
  });

  it("a stray `agent_started` for a dismissed id is a no-op", () => {
    // The nastiest one: `agent_started` CREATES. Without the tombstone guard in
    // `upsertAgent`, this re-adds the ghost as a live root.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(agentId);

    act().applyAgentEvent({ ...started(agentId), title: "zombie" });

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
  });

  it("a `fleet_snapshot` still listing a dismissed agent does not resurrect it", () => {
    // A snapshot taken a beat before the close is the same hazard as a stray
    // event, via a different door — and `upsertAgent` guards them both.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(agentId);

    act().applyFleetSnapshot([wireAgent({ id: agentId, status: "running" })]);

    expect(state().agents[agentId]).toBeUndefined();
  });

  it("adoption cannot smuggle a dismissed parent back as a ghost root", () => {
    // A late `subagent_spawned` naming the dismissed parent could re-create it via orphan/adopt;
    // the child may surface (a new id), but the parent must stay gone.
    act().applyAgentEvent(started("root"));
    act().dismissAgent(id("root"));
    expect(agentOf("root")).toBeUndefined();

    act().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id("root"), // the dead parent
      childAgentId: id("kid"),
      title: "kid",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    });

    // root stays dismissed; it was never re-created to adopt anyone.
    expect(agentOf("root")).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(id("root"));
    assertLiveFleetInvariants();
  });

  it("re-creating a fresh agent still works — the tombstone blocks only the dead id", () => {
    const first = act().createAgent({ cwd: "/w/gazelle" });
    act().dismissAgent(first);

    // A new agent gets a fresh UUID, so it is unaffected.
    const second = act().createAgent({ cwd: "/w/gazelle" });

    expect(second).not.toBe(first);
    expect(state().agents[second]).toBeDefined();
    expect(state().rootAgentIds).toEqual([second]);
  });

  it("the tombstone is bounded — old dismissals evict, and the guard still holds recent ones", () => {
    // Dismiss well past the cap, then prove: the set never exceeds the cap, the
    // most-recent dismissal is still blocked, and the very first has evicted.
    const ids: AgentId[] = [];
    for (let i = 0; i < 600; i++) {
      const a = id(`ghost-${i}`);
      ids.push(a);
      act().removeAgent(a); // absent → tombstone-only, cheap
    }

    expect(state().dismissedAgentIds.length).toBeLessThanOrEqual(512);
    // Recent id still bites.
    act().applyAgentEvent(started(ids[599]));
    expect(agentOf("ghost-599")).toBeUndefined();
    // The oldest has fallen off the memory.
    expect(state().dismissedAgentIds).not.toContain(ids[0]);
  });
});

/* ════════════ ad-hoc agent: promote the plain terminal's tab ════════════ */

describe("ad-hoc agent — `claude` typed in a plain terminal", () => {
  const layout = () => useAppStore.getState().layoutActions;

  /** Open a plain shell tab and return {tabId, its terminalId as an agent id}. */
  function openPlainTerminal(cwd = "/w/scratch") {
    const tabId = layout().openTerminalTab({ cwd });
    const ref = state().tabs[tabId].ref;
    if (ref.kind !== "terminal" && ref.kind !== "agent-terminal")
      throw new Error("not a terminal");
    // Ad-hoc: Rust keys the agent by this terminal, so AgentId === TerminalId.
    return { tabId, agentId: ref.terminalId as unknown as AgentId };
  }

  it("promotes the tab when agent_started arrives for its terminal id", () => {
    // The exact real-world flow. The tab is born plain; agent_started binds it.
    const { tabId, agentId } = openPlainTerminal();
    expect(state().tabs[tabId].kind).toBe("terminal");
    expect(state().tabs[tabId].ref.kind).toBe("terminal");

    act().applyAgentEvent(started(agentId as unknown as string));

    const tab = state().tabs[tabId];
    expect(tab.kind).toBe("agent-terminal");
    expect(tab.ref).toEqual({
      kind: "agent-terminal",
      terminalId: agentId as unknown as TabId, // same id, now carrying the agent
      agentId,
    });
    // The agent is in the rail too.
    expect(state().agents[agentId]).toBeDefined();
    assertLiveFleetInvariants();
  });

  it("keeps the SAME terminalId — promotion is metadata only, no new PTY", () => {
    const { tabId, agentId } = openPlainTerminal();
    const before = state().tabs[tabId].ref;
    const terminalBefore =
      before.kind === "terminal" || before.kind === "agent-terminal" ? before.terminalId : null;

    act().applyAgentEvent(started(agentId as unknown as string));

    const after = state().tabs[tabId].ref;
    const terminalAfter =
      after.kind === "terminal" || after.kind === "agent-terminal" ? after.terminalId : null;
    expect(terminalAfter).toBe(terminalBefore);
  });

  it("→ closing the promoted tab removes the agent (THE bug)", () => {
    // Before the fix this was the whole bug: close the tab, agent lingers.
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    expect(state().agents[agentId]).toBeDefined();

    layout().closeTab(tabId);

    // Symmetric with a spawned agent: the tab carries the agentId now, so the
    // existing closeTab → removeAgentFromForest path fires. No parallel wiring.
    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
  });

  it("→ the row ✕ also dismisses an ad-hoc agent", () => {
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));

    act().dismissAgent(agentId);

    // dismissAgent → findAgentTab finds the promoted tab → closeTab.
    expect(state().agents[agentId]).toBeUndefined();
    expect(state().tabs[tabId]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
  });

  it("a re-run in the SAME terminal revives a done agent (back to a live idle root)", () => {
    // Sequential `claude`s in one terminal reuse the AgentId: a fresh agent_started must revive a
    // greyed `done` agent (hydrateAgent's `...wire` spread does it).
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    act().applyAgentEvent({ t: "exited", agentId, code: 0 });
    expect(state().agents[agentId].status).toBe("done");
    expect(state().agents[agentId].finishedAt).not.toBeNull();

    act().applyAgentEvent(started(agentId as unknown as string)); // re-run

    const agent = state().agents[agentId];
    expect(agent.status).toBe("idle"); // revived, born idle (no longer greyed done)
    expect(agent.finishedAt).toBeNull(); // a live run has not finished
    // One node, no duplicate, and the tab is still the same agent-terminal.
    expect(state().rootAgentIds.filter((r) => r === agentId)).toHaveLength(1);
    expect(state().tabs[tabId].kind).toBe("agent-terminal");
    expect(state().tabs[tabId].ref).toMatchObject({ kind: "agent-terminal", agentId });
    assertLiveFleetInvariants();
  });

  it("a re-run clears a previous error status", () => {
    // A crashed run (non-zero exit) greys to `error`; re-running must clear it,
    // not carry the stale error into the new session.
    const { agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    act().applyAgentEvent({ t: "exited", agentId, code: 143 });
    expect(state().agents[agentId].status).toBe("error");
    expect(state().agents[agentId].error).toBeDefined();

    act().applyAgentEvent(started(agentId as unknown as string));

    expect(state().agents[agentId].status).toBe("idle"); // revived idle, error cleared
    expect(state().agents[agentId].error).toBeUndefined();
  });

  it("a re-run for a DISMISSED id stays dismissed — tombstone still wins", () => {
    // Guardrail: a genuinely-dismissed id must not revive even via the re-run
    // path. (Can't happen through a closed terminal — new terminals get fresh
    // UUIDs — but the tombstone must win regardless of how agent_started lands.)
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    layout().closeTab(tabId); // dismiss
    expect(state().agents[agentId]).toBeUndefined();

    act().applyAgentEvent(started(agentId as unknown as string)); // late re-run

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
  });

  it("is idempotent — a re-fired agent_started does not re-promote", () => {
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    const promoted = state().tabs[tabId];

    act().applyAgentEvent({ ...started(agentId as unknown as string), title: "again" });

    // Still exactly one tab, still agent-terminal, ref unchanged.
    expect(Object.keys(state().tabs)).toEqual([tabId]);
    expect(state().tabs[tabId].kind).toBe("agent-terminal");
    expect(state().tabs[tabId].ref).toEqual(promoted.ref);
  });

  it("leaves a spawned agent's tab alone (it is already agent-terminal)", () => {
    // The promotion filter only matches plain `terminal` tabs, so a spawned
    // agent — whose tab is born agent-terminal — is untouched by its own
    // confirming agent_started.
    const agentId = act().createAgent({ cwd: "/w/gazelle" });
    const tabId = Object.keys(state().tabs)[0] as TabId;
    const refBefore = state().tabs[tabId].ref;

    act().applyAgentEvent(started(agentId as unknown as string));

    expect(state().tabs[tabId].ref).toEqual(refBefore);
    expect(Object.keys(state().tabs)).toHaveLength(1);
  });

  it("promotes the tab whose id MATCHES, not just the first plain terminal", () => {
    // The decoy opens first, so "promote the first terminal tab" would grab it; promotion must key
    // on terminalId === agentId.
    const decoyTab = layout().openTerminalTab({ cwd: "/w/other-shell" });
    const { tabId: agentTab, agentId } = openPlainTerminal("/w/agent-shell");

    act().applyAgentEvent(started(agentId as unknown as string));

    expect(state().tabs[decoyTab].kind).toBe("terminal"); // untouched
    expect(state().tabs[decoyTab].ref.kind).toBe("terminal");
    expect(state().tabs[agentTab].kind).toBe("agent-terminal"); // the right one
  });

  it("adds the agent but invents no tab when none matches (race / headless)", () => {
    // agent_started for a terminal we hold no tab for — a race, or a future
    // headless agent. Add the node, don't crash, don't fabricate a tab.
    const before = Object.keys(state().tabs).length;

    act().applyAgentEvent(started("no-tab-agent"));

    expect(agentOf("no-tab-agent")).toBeDefined();
    expect(Object.keys(state().tabs)).toHaveLength(before);
    assertLiveFleetInvariants();
  });

  it("tombstone holds: dismiss, then a late dup agent_started leaves no ghost", () => {
    // The resurrection guardrail, on the ad-hoc path. Also: the late event must
    // not promote a tab (there is none — it was closed) nor re-add the agent.
    const { tabId, agentId } = openPlainTerminal();
    act().applyAgentEvent(started(agentId as unknown as string));
    layout().closeTab(tabId); // dismiss
    expect(state().agents[agentId]).toBeUndefined();

    act().applyAgentEvent(started(agentId as unknown as string)); // late duplicate

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
    expect(state().tabs[tabId]).toBeUndefined();
  });
});

/* ══════════════════════════ rootOf ══════════════════════════ */

describe("rootOf", () => {
  it("walks to the root orchestrator", () => {
    act().applyAgentEvent(started("root"));
    for (const [parent, child] of [["root", "mid"], ["mid", "deep"]]) {
      act().applyAgentEvent({
        t: "subagent_spawned",
        parentId: id(parent),
        childAgentId: id(child),
        title: child,
        cwd: "/w",
        branch: "trunk",
        runtime: "claude-code",
      });
    }
    expect(rootOf(state().agents, id("deep"))?.id).toBe(id("root"));
    expect(rootOf(state().agents, id("root"))?.id).toBe(id("root"));
  });

  it("returns null for an unknown agent", () => {
    expect(rootOf({}, id("ghost"))).toBeNull();
  });

  it("terminates on a cycle", () => {
    const agents: Record<AgentId, AgentNode> = {
      [id("a")]: wireAgent({ id: id("a"), parentId: id("b") }),
      [id("b")]: wireAgent({ id: id("b"), parentId: id("a") }),
    };
    expect(rootOf(agents, id("a"))).toBeDefined();
  });

  it("stops at a missing parent rather than returning null", () => {
    const agents: Record<AgentId, AgentNode> = {
      [id("kid")]: wireAgent({ id: id("kid"), parentId: id("gone") }),
    };
    expect(rootOf(agents, id("kid"))?.id).toBe(id("kid"));
  });
});

/* ══════════════════ THE JOURNEY: a full agent lifecycle ══════════════════ */

describe("journey: snapshot → spawn → status → exit", () => {
  it("survives the whole lifecycle with invariants intact at every step", () => {
    // Not a settled-state test. Every bug this project shipped lived in a
    // transition, so assert after each one.

    // 1. Startup: Rust already had an agent running.
    act().applyFleetSnapshot([wireAgent({ id: id("restored"), title: "from before" })]);
    expect(state().rootAgentIds).toEqual([id("restored")]);
    assertLiveFleetInvariants("after snapshot");

    // 2. The user starts a second agent from the rail.
    const mine = act().createAgent({ cwd: "/w/gazelle", title: "Pull latest changes" });
    expect(state().selection.selectedAgentId).toBe(mine);
    expect(Object.values(state().tabs)[0].kind).toBe("agent-terminal");
    assertLiveFleetInvariants("after createAgent");

    // 3. Rust confirms it started — born idle, parked at its prompt (a turn/activity
    //    hook is what will drive it to running).
    act().applyAgentEvent(started(mine, { title: "Pull latest changes" }));
    expect(state().agents[mine].status).toBe("idle");
    expect(state().rootAgentIds).toEqual([id("restored"), mine]);
    assertLiveFleetInvariants("after agent_started");

    // 4. It blocks on a prompt — and says so loudly.
    act().applyAgentEvent({ t: "status", agentId: mine, status: "waiting_input" });
    expect(state().agents[mine].status).toBe("waiting_input");
    expect(state().agents[mine].unread).toBe(1);
    assertLiveFleetInvariants("after waiting_input");

    // 5. The user opens it; the badge clears.
    act().selectAgent(mine);
    expect(state().agents[mine].unread).toBe(0);
    assertLiveFleetInvariants("after selectAgent");

    // 6. Work resumes, ticks, and finishes cleanly.
    act().applyAgentEvent({ t: "status", agentId: mine, status: "running" });
    act().applyAgentEvent({ t: "activity", agentId: mine, at: 999 });
    act().applyAgentEvent({ t: "exited", agentId: mine, code: 0 });

    expect(state().agents[mine].status).toBe("done");
    expect(state().agents[mine].lastActivityAt).toBe(state().agents[mine].finishedAt);
    // Still on screen, still selected — done rows are for inspection.
    expect(state().rootAgentIds).toContain(mine);
    expect(state().selection.selectedAgentId).toBe(mine);
    assertLiveFleetInvariants("after exit");

    // 7. Dismissed explicitly.
    act().removeAgent(mine);
    expect(state().agents[mine]).toBeUndefined();
    expect(state().selection.selectedAgentId).toBe(id("restored"));
    assertLiveFleetInvariants("after removeAgent");
  });
});

/* ══════════════════════ property: arbitrary telemetry ══════════════════════ */

describe("property: arbitrary telemetry sequences", () => {
  type Cmd =
    | { t: "start"; agent: number }
    | { t: "spawn"; parent: number; child: number }
    | { t: "status"; agent: number; status: AgentStatus }
    | { t: "exit"; agent: number; code: number }
    | { t: "title"; agent: number }
    | { t: "activity"; agent: number }
    | { t: "select"; agent: number }
    | { t: "toggle"; agent: number }
    | { t: "remove"; agent: number }
    | { t: "dismiss"; agent: number }
    | { t: "snapshot"; agents: number[] };

  const nat = fc.nat({ max: 5 });
  const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
    { arbitrary: fc.record({ t: fc.constant("start" as const), agent: nat }), weight: 4 },
    {
      arbitrary: fc.record({ t: fc.constant("spawn" as const), parent: nat, child: nat }),
      weight: 4,
    },
    {
      arbitrary: fc.record({
        t: fc.constant("status" as const),
        agent: nat,
        status: fc.constantFrom<AgentStatus>("idle", "running", "waiting_input", "done", "error"),
      }),
      weight: 3,
    },
    {
      arbitrary: fc.record({
        t: fc.constant("exit" as const),
        agent: nat,
        code: fc.integer({ min: 0, max: 200 }),
      }),
      weight: 2,
    },
    { arbitrary: fc.record({ t: fc.constant("title" as const), agent: nat }), weight: 1 },
    { arbitrary: fc.record({ t: fc.constant("activity" as const), agent: nat }), weight: 1 },
    { arbitrary: fc.record({ t: fc.constant("select" as const), agent: nat }), weight: 2 },
    { arbitrary: fc.record({ t: fc.constant("toggle" as const), agent: nat }), weight: 1 },
    { arbitrary: fc.record({ t: fc.constant("remove" as const), agent: nat }), weight: 1 },
    // Weighted up: dismiss-then-late-telemetry for the same id is THE
    // resurrection race, so sequences should hit it often.
    { arbitrary: fc.record({ t: fc.constant("dismiss" as const), agent: nat }), weight: 2 },
    {
      arbitrary: fc.record({
        t: fc.constant("snapshot" as const),
        agents: fc.array(nat, { maxLength: 4 }),
      }),
      weight: 1,
    },
  );

  const name = (n: number) => id(`a${n}`);

  function runCmd(cmd: Cmd): void {
    const a = act();
    switch (cmd.t) {
      case "start":
        return a.applyAgentEvent(started(`a${cmd.agent}`));
      case "spawn":
        return a.applyAgentEvent({
          t: "subagent_spawned",
          parentId: name(cmd.parent),
          childAgentId: name(cmd.child),
          title: `a${cmd.child}`,
          cwd: "/w",
          branch: "trunk",
          runtime: "claude-code",
        });
      case "status":
        return a.applyAgentEvent({ t: "status", agentId: name(cmd.agent), status: cmd.status });
      case "exit":
        return a.applyAgentEvent({ t: "exited", agentId: name(cmd.agent), code: cmd.code });
      case "title":
        return a.applyAgentEvent({ t: "title", agentId: name(cmd.agent), title: "renamed" });
      case "activity":
        return a.applyAgentEvent({ t: "activity", agentId: name(cmd.agent), at: 42 });
      case "select":
        return a.selectAgent(name(cmd.agent));
      case "toggle":
        return a.toggleAgentExpanded(name(cmd.agent));
      case "remove":
        return a.removeAgent(name(cmd.agent));
      case "dismiss":
        return a.dismissAgent(name(cmd.agent));
      case "snapshot":
        return a.applyFleetSnapshot(cmd.agents.map((n) => wireAgent({ id: name(n) })));
    }
  }

  const cmdsArb = fc.array(cmdArb, { minLength: 1, maxLength: 30 });
  const describeCmd = (cmd: Cmd, i: number) => `after cmd #${i} ${JSON.stringify(cmd)}`;

  it("holds every fleet invariant after every single event", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetFleetStore();
        cmds.forEach((cmd, i) => {
          runCmd(cmd);
          assertLiveFleetInvariants(describeCmd(cmd, i));
        });
      }),
    );
  });

  it("never mutates a state object it already handed out", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetFleetStore();
        cmds.forEach((cmd, i) => {
          const before = state();
          const clone = JSON.parse(JSON.stringify({ agents: before.agents, roots: before.rootAgentIds }));
          runCmd(cmd);
          expect(
            JSON.parse(JSON.stringify({ agents: before.agents, roots: before.rootAgentIds })),
            describeCmd(cmd, i),
          ).toEqual(clone);
        });
      }),
    );
  });

  it("keeps the slice valid as a standalone FleetState (M2 session-nesting readiness)", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetFleetStore();
        cmds.forEach(runCmd);
        const { agents, rootAgentIds, selection, dismissedAgentIds, collapsedFolders } = state();
        assertFleetInvariants({ agents, rootAgentIds, selection, dismissedAgentIds, collapsedFolders });
      }),
    );
  });
});
