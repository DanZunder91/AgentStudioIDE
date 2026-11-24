/**
 * The center layout across a restart — two bugs.
 *
 *   1. A tab or view that was renamed lost its new name when the app was closed
 *      and reopened.
 *   2. With two views open for the same project and one agent in each, every
 *      agent landed in a single view after the app was closed and reopened.
 *
 * Both are one gap: nothing wrote the center layout down. `ViewSnapshot.name`,
 * `Tab.customTitle` and `AgentNode.customTitle` lived only in the JS heap, and
 * `rebuildTerminalTabs` had no record of which view a terminal came from, so it
 * dumped every restored terminal into the focused leaf of the view on screen.
 *
 * ── What "a restart" means here ──────────────────────────────────────────────
 * `restart()` below is not a metaphor. It does exactly what a real relaunch does,
 * in `bridge.ts`'s order:
 *
 *   persist  → the blob the running app would have written to layout-prefs.json
 *   reset    → a fresh JS heap: no views, no tabs, no agents (the process died)
 *   load     → `applyCenterLayout(prefs)`   — the arrangement, leaves still empty
 *   snapshot → `applyFleetSnapshot(agents)` — the roots Rust re-spawned
 *   rebuild  → `rebuildTerminalTabs(metas)` — the PTYs, placed back into panes
 *
 * The one thing the harness decides is WHICH terminals come back: Rust re-spawns
 * pinned roots under the same id and nothing else, so `restart({ survivors })` is
 * where "this agent was pinned, that shell was not" is expressed.
 *
 * ── Falsification ───────────────────────────────────────────────────────────
 * Reverting step 1 of `rebuildTerminalTabs` (the `pendingRestore` placement loop)
 * so it falls through to the old "focused leaf of the active view" path turns the
 * headline test red with the original symptom. Dropping `views`/`activeViewId` from
 * `layoutPrefsBlob` turns every restore test red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

const fleetIpc = vi.hoisted(() => ({
  pushRecentProject: vi.fn().mockResolvedValue(undefined),
  ensureAgentHooks: vi.fn().mockResolvedValue(undefined),
  pinAgent: vi.fn().mockResolvedValue(undefined),
  unpinAgent: vi.fn().mockResolvedValue(undefined),
  pinnedAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../features/fleet/fleetIpc", () => fleetIpc);

// The persistence EFFECT. Spying on it is how "a rename is written down" and "the
// read side does NOT write back" are both provable without touching Tauri.
const layoutPrefsIpc = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
  EMPTY_LAYOUT_PREFS: {
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
  },
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefsIpc);

import type { LayoutPrefs, PersistedView } from "./layoutPrefsIpc";
import {
  hydrateCenterLayout,
  layoutActions,
  layoutPrefsBlob,
  leavesOf,
  serializeCenterLayout,
  useAppStore,
  viewTabIds,
  type AppStore,
  type ViewId,
  type ViewSnapshot,
} from "./store";
import {
  asAgentId,
  asTabId,
  asTerminalId,
  type AgentId,
  type PaneNode,
  type TabId,
  type TerminalId,
  type TerminalMeta,
} from "./types";
import { resetFleetStore, wireAgent } from "../test/fleet-harness";
import { assertStoreInvariants, resetStore } from "../test/store-harness";

/* ─────────────────────────── helpers ─────────────────────────── */

const state = (): AppStore => useAppStore.getState();
const act = () => layoutActions();
const fleet = () => state().agentActions;

const views = (): ViewSnapshot[] => state().views;
const viewNamed = (name: string): ViewSnapshot => {
  const view = views().find((v) => v.name === name);
  expect(view, `no view named ${name} (have: ${views().map((v) => v.name)})`).toBeTruthy();
  return view as ViewSnapshot;
};

/** The display name the rail row and the center tab both show for an agent. */
const agentName = (agentId: AgentId): string | null =>
  state().agents[agentId]?.customTitle ?? null;

/** The tab ids `viewId` holds, in visual order (live for the active view). */
const tabsIn = (viewId: ViewId): TabId[] => viewTabIds(state(), viewId);

/** The terminal a tab is bound to. */
const terminalOf = (tabId: TabId): TerminalId => {
  const ref = state().tabs[tabId].ref;
  if (ref.kind !== "terminal" && ref.kind !== "agent-terminal")
    throw new Error(`tab ${tabId} is not a terminal tab`);
  return ref.terminalId;
};

/**
 * The AUTHORITATIVE tree of a view: the live `layout` for the ACTIVE one, whose
 * snapshot in `views` is stale by design (`LayoutState.views`). Reading the
 * snapshot instead is the classic way to assert against yesterday's arrangement.
 */
const treeOf = (viewId: ViewId): PaneNode => {
  const s = state();
  if (viewId === s.activeViewId) return s.layout;
  return (s.views.find((v) => v.id === viewId) as ViewSnapshot).layout;
};

/** Which terminals sit in `viewId`, in visual order. */
const terminalsIn = (viewId: ViewId): TerminalId[] => tabsIn(viewId).map(terminalOf);

/** The last blob handed to `saveLayoutPrefs` — the file the app would have written. */
const lastSaved = (): LayoutPrefs => {
  const calls = layoutPrefsIpc.saveLayoutPrefs.mock.calls;
  expect(calls.length, "saveLayoutPrefs should have been called").toBeGreaterThan(0);
  return calls[calls.length - 1][0] as LayoutPrefs;
};

/**
 * Launch an agent into the ACTIVE view, exactly as the ⚡ quick-launch does:
 * a fleet row plus its agent-terminal tab. Its TerminalId IS its AgentId.
 */
function launchAgent(id: string, cwd = `/w/${id}`): AgentId {
  const agentId = asAgentId(id);
  useAppStore.setState((s) => {
    s.agents[agentId] = wireAgent({ id: agentId, cwd, title: id });
    s.agents[agentId].childIds = [];
    s.agents[agentId].expanded = false;
    s.agents[agentId].unread = 0;
    s.agents[agentId].sessionId = null;
    s.rootAgentIds.push(agentId);
  });
  act().openTerminalTab({ cwd, agentId, runtime: "claude-code" });
  return agentId;
}

/** A `TerminalMeta` as `fleet_snapshot` reports it after Rust re-spawned a root. */
const meta = (id: TerminalId, agentId?: AgentId): TerminalMeta => ({
  id,
  kind: agentId ? "agent-terminal" : "terminal",
  title: agentId ?? "shell",
  cwd: "/w/gazelle",
  cols: 80,
  rows: 24,
  status: "live",
  ...(agentId ? { agentId } : {}),
});

/**
 * A REAL restart: persist, drop the whole heap, then replay boot in bridge.ts's
 * order. `survivors` names the terminals Rust brought back — a pinned root comes
 * back under its own id; an unpinned agent and any plain shell do not.
 * Defaults to "every terminal that was open", i.e. everything was pinned.
 */
function restart(options: { survivors?: TerminalId[] } = {}): void {
  const before = state();
  const prefs = layoutPrefsBlob(before);
  const survivors =
    options.survivors ??
    Object.values(before.tabs).flatMap((tab) =>
      tab.ref.kind === "terminal" || tab.ref.kind === "agent-terminal"
        ? [tab.ref.terminalId]
        : [],
    );
  // Rust only knows the agent bound to a terminal, so read that off the old heap
  // before it goes away.
  const agentOf = new Map<TerminalId, AgentId>();
  for (const tab of Object.values(before.tabs)) {
    if (tab.ref.kind === "agent-terminal")
      agentOf.set(tab.ref.terminalId, tab.ref.agentId);
  }
  const rows = survivors.flatMap((id) => {
    const agentId = agentOf.get(id);
    return agentId ? [wireAgent({ id: agentId, title: agentId })] : [];
  });

  // The process died: nothing survives but the file.
  resetStore();
  resetFleetStore();

  act().applyCenterLayout(prefs);
  fleet().applyFleetSnapshot(rows);
  act().rebuildTerminalTabs(survivors.map((id) => meta(id, agentOf.get(id))));
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
  layoutPrefsIpc.saveLayoutPrefs.mockClear();
});

/* ═════════════════ bug 2 — two views, two agents, one window ═════════════════ */

describe("🔴 the bug: two views collapse into one on restart", () => {
  it("gives each agent back its OWN view, with the right one on screen", () => {
    // Two views for one project, one agent in each — the exact scenario.
    act().renameView(state().activeViewId, "Backend");
    const api = launchAgent("agent-api");
    const web = act().createView("Frontend");
    const ui = launchAgent("agent-ui");

    expect(terminalsIn(viewNamed("Backend").id)).toEqual([asTerminalId(api)]);
    expect(terminalsIn(web)).toEqual([asTerminalId(ui)]);

    restart();

    // THE assertion. Before the fix both terminals landed in one view.
    expect(views()).toHaveLength(2);
    expect(terminalsIn(viewNamed("Backend").id)).toEqual([asTerminalId(api)]);
    expect(terminalsIn(viewNamed("Frontend").id)).toEqual([asTerminalId(ui)]);
    // …and the view the user was looking at is still the one on screen.
    expect(viewNamed("Frontend").id).toBe(state().activeViewId);
    assertStoreInvariants(state(), "after restart");
  });

  it("restores the pane SPLIT inside a view, not just which view", () => {
    // "4 terminals inside 1 view" is the whole point of a view (ViewBar's docblock).
    const left = launchAgent("agent-left");
    const rightPane = act().splitPane(state().focusedPaneId, "row");
    const right = launchAgent("agent-right");
    expect(leavesOf(state().layout)).toHaveLength(2);
    expect(state().tabs[tabsIn(state().activeViewId)[1]].ref.kind).toBe("agent-terminal");

    restart();

    const leaves = leavesOf(state().layout);
    expect(leaves, "the split survives").toHaveLength(2);
    expect(leaves.map((leaf) => leaf.tabIds.map(terminalOf))).toEqual([
      [asTerminalId(left)],
      [asTerminalId(right)],
    ]);
    expect(rightPane).toBeTruthy(); // pane ids are minted fresh; only the shape returns
    assertStoreInvariants(state(), "after a split restart");
  });

  it("keeps each view's tab ORDER and which tab was selected", () => {
    const a = launchAgent("agent-a");
    const b = launchAgent("agent-b");
    const c = launchAgent("agent-c");
    act().setActiveTab(state().focusedPaneId, tabsIn(state().activeViewId)[1]);

    restart();

    expect(terminalsIn(state().activeViewId)).toEqual(
      [a, b, c].map((id) => asTerminalId(id)),
    );
    const leaf = leavesOf(state().layout)[0];
    expect(terminalOf(leaf.activeTabId as TabId)).toBe(asTerminalId(b));
  });

  it("survives a tab moved across views before the restart", () => {
    const stay = launchAgent("agent-stay");
    const other = act().createView("Other");
    act().activateView(state().views[0].id);
    const moved = launchAgent("agent-moved");
    act().moveTabToView(tabsIn(state().activeViewId)[1], other);
    expect(terminalsIn(other)).toEqual([asTerminalId(moved)]);

    restart();

    expect(terminalsIn(state().views[0].id)).toEqual([asTerminalId(stay)]);
    expect(terminalsIn(other)).toEqual([asTerminalId(moved)]);
  });
});

/* ═══════════════════════ bug 1 — the names ═══════════════════════ */

describe("🔴 the bug: a rename does not survive a restart", () => {
  it("brings a renamed VIEW back by name", () => {
    act().renameView(state().activeViewId, "Gazelle");
    act().createView("Scratch");

    restart();

    expect(views().map((v) => v.name)).toEqual(["Gazelle", "Scratch"]);
  });

  it("brings a renamed AGENT back by name — the rail row and its tab", () => {
    const agentId = launchAgent("agent-1");
    fleet().renameAgent(agentId, "  Payments API  ");
    expect(agentName(agentId)).toBe("Payments API"); // trimmed, as before

    restart();

    // The agent came back with the adapter's default title; the NAME is ours.
    expect(agentName(agentId)).toBe("Payments API");
  });

  it("brings a renamed plain TERMINAL tab back (a reload, where its PTY lives)", () => {
    // A plain shell's PTY dies with the app, so a cold restart has nothing to
    // rename. Across a webview reload it survives — and so, now, does its name.
    const tabId = act().openTerminalTab({ cwd: "/w/gazelle" });
    const terminalId = terminalOf(tabId);
    act().renameTab(tabId, "logs");

    restart({ survivors: [terminalId] });

    const restored = tabsIn(state().activeViewId)[0];
    expect(state().tabs[restored].customTitle).toBe("logs");
  });

  it("does not resurrect a name the user cleared", () => {
    const agentId = launchAgent("agent-1");
    fleet().renameAgent(agentId, "temporary");
    fleet().renameAgent(agentId, "   "); // whitespace clears it
    expect(agentName(agentId)).toBeNull();

    restart();

    expect(agentName(agentId)).toBeNull();
  });

  it("leaves an unnamed tab unnamed rather than writing null over a live title", () => {
    // `customTitle: null` means "never renamed" — the restore must skip it, not
    // assign it, or a name telemetry supplied in the same tick would be erased.
    const agentId = launchAgent("agent-1");
    restart();
    useAppStore.setState((s) => {
      s.agents[agentId].customTitle = "set after the snapshot";
    });
    act().rebuildTerminalTabs([meta(asTerminalId(agentId), agentId)]); // idempotent re-run
    expect(agentName(agentId)).toBe("set after the snapshot");
  });

  it("names a terminal whose agent row never came back without inventing one", () => {
    // A terminal bound to an agent Rust did not re-materialize: there is no row
    // to carry the name, and `restoreCustomName` must not conjure one.
    const agentId = launchAgent("agent-1");
    fleet().renameAgent(agentId, "Payments");
    const prefs = layoutPrefsBlob(state());
    resetStore();
    resetFleetStore();
    act().applyCenterLayout(prefs);
    // NOTE: no applyFleetSnapshot — the agent row is missing on purpose.
    act().rebuildTerminalTabs([meta(asTerminalId(agentId), agentId)]);
    expect(state().agents[agentId]).toBeUndefined();
    expect(tabsIn(state().activeViewId)).toHaveLength(1);
  });
});

/* ═══════════════ what does NOT come back, and what happens then ═══════════════ */

describe("restore — terminals that did not survive", () => {
  it("prunes the pane of an agent that was not pinned, collapsing the split", () => {
    const kept = launchAgent("agent-kept");
    act().splitPane(state().focusedPaneId, "row");
    const lost = launchAgent("agent-lost");
    expect(leavesOf(state().layout)).toHaveLength(2);

    restart({ survivors: [asTerminalId(kept)] });

    // One pane, not "a terminal next to a blank half of the window".
    expect(leavesOf(state().layout)).toHaveLength(1);
    expect(terminalsIn(state().activeViewId)).toEqual([asTerminalId(kept)]);
    expect(state().agents[lost]).toBeUndefined();
    assertStoreInvariants(state(), "after a partial restore");
  });

  it("keeps a view that restored nothing, as one empty pane", () => {
    // The arrangement is the user's; an emptied view is still theirs. It comes
    // back named and clickable rather than silently disappearing.
    const kept = launchAgent("agent-kept");
    const scratch = act().createView("Scratch");
    act().splitPane(state().focusedPaneId, "column");
    launchAgent("agent-gone");

    restart({ survivors: [asTerminalId(kept)] });

    expect(views().map((v) => v.name)).toEqual(["View 1", "Scratch"]);
    expect(tabsIn(scratch)).toEqual([]);
    expect(leavesOf(treeOf(scratch)), "an emptied split collapses to one pane").toHaveLength(1);
    assertStoreInvariants(state(), "after an emptied view restored");
  });

  it("lands a terminal the blob never saw in the focused pane, as it always did", () => {
    launchAgent("agent-known");
    const prefs = layoutPrefsBlob(state());
    resetStore();
    resetFleetStore();
    act().applyCenterLayout(prefs);
    // A terminal Rust reports that the persisted layout has no slot for.
    const stranger = asTerminalId("terminal-stranger");
    act().rebuildTerminalTabs([meta(stranger)]);
    expect(terminalsIn(state().activeViewId)).toEqual([stranger]);
    assertStoreInvariants(state(), "after an unknown terminal");
  });

  it("writes the corrected layout back after a restore", () => {
    // 🔴 SEAM. `bridge.ts` boots as
    // applyCenterLayout → fleet_snapshot → registerFleetRoots → rebuildTerminalTabs,
    // and that third step persists (via `syncFolderOrder`) while the restored views
    // are still EMPTY. `layout-prefs.json` then holds two views, both
    // `"terminals": []`, after a relaunch that had restored them correctly on screen.
    // Quit before touching anything and that becomes the truth — a restore that
    // erases what it restored. The placement pass must write the corrected blob.
    const agentId = launchAgent("agent-1");
    const prefs = layoutPrefsBlob(state());
    resetStore();
    resetFleetStore();
    act().applyCenterLayout(prefs);
    fleet().applyFleetSnapshot([wireAgent({ id: agentId })]);
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    act().rebuildTerminalTabs([meta(asTerminalId(agentId), agentId)]);

    const written = lastSaved();
    const leaf = written.views?.[0].layout;
    expect(
      leaf?.type === "leaf" && leaf.terminals.map((t) => t.terminalId),
      "the blob on disk must describe what is on screen",
    ).toEqual([agentId]);
  });

  it("consumes `pendingRestore` exactly once", () => {
    launchAgent("agent-1");
    restart();
    expect(state().pendingRestore, "single-use by contract").toEqual({});
    // A second snapshot (a re-fired `fleet_snapshot`) must not re-place anything.
    const before = state().layout;
    act().rebuildTerminalTabs([meta(asTerminalId("agent-1"), asAgentId("agent-1"))]);
    expect(state().layout).toBe(before);
  });
});

/* ══════════════════════ the blob itself ══════════════════════ */

describe("serializeCenterLayout — what goes to disk", () => {
  it("reads the ACTIVE view's LIVE tree, never its stale snapshot", () => {
    // The one real subtlety: `views[activeViewId]` is stale by design, so a
    // serializer that read it would persist the user's PREVIOUS arrangement.
    const second = act().createView("Second");
    const agentId = launchAgent("agent-late"); // opened AFTER the snapshot was taken
    const blob = serializeCenterLayout(state());
    const view = blob.views.find((v) => v.id === second);
    expect(view?.layout).toEqual({
      type: "leaf",
      terminals: [{ terminalId: agentId, customTitle: null }],
      activeTerminalId: agentId,
    });
  });

  it("persists only terminals — an editor tab has no durable id to key on", () => {
    launchAgent("agent-1");
    act().openEditorTab("/w/gazelle/Cargo.toml");
    const leaf = serializeCenterLayout(state()).views[0].layout;
    expect(leaf.type === "leaf" && leaf.terminals.map((t) => t.terminalId)).toEqual([
      "agent-1",
    ]);
    // The editor tab was active; `activeTerminalId` refuses to name it.
    expect(leaf.type === "leaf" && leaf.activeTerminalId).toBeNull();
  });

  it("takes an agent terminal's name from the AGENT and a shell's from the tab", () => {
    const agentId = launchAgent("agent-1");
    fleet().renameAgent(agentId, "From the agent");
    const shell = act().openTerminalTab({ cwd: "/w/gazelle" });
    act().renameTab(shell, "From the tab");
    const leaf = serializeCenterLayout(state()).views[0].layout;
    expect(leaf.type === "leaf" && leaf.terminals).toEqual([
      { terminalId: agentId, customTitle: "From the agent" },
      { terminalId: terminalOf(shell), customTitle: "From the tab" },
    ]);
  });

  it("survives a tab whose agent record is gone", () => {
    const agentId = launchAgent("agent-1");
    useAppStore.setState((s) => {
      delete s.agents[agentId]; // a forest removal that raced the serializer
    });
    const leaf = serializeCenterLayout(state()).views[0].layout;
    expect(leaf.type === "leaf" && leaf.terminals[0].customTitle).toBeNull();
  });

  it("round-trips: serialize → hydrate → serialize is a fixed point", () => {
    act().renameView(state().activeViewId, "One");
    const a = launchAgent("agent-a");
    act().splitPane(state().focusedPaneId, "column");
    launchAgent("agent-b");
    act().createView("Two");
    launchAgent("agent-c");
    act().activateView(viewNamed("One").id);
    fleet().renameAgent(a, "named");

    const first = layoutPrefsBlob(state());
    restart();
    const second = layoutPrefsBlob(state());
    expect(second.views).toEqual(first.views);
    expect(second.activeViewId).toBe(first.activeViewId);
  });
});

/* ══════════════════════ hydrate — a file, not a value ══════════════════════ */

describe("applyCenterLayout — reading a file that may be wrong", () => {
  const prefsWith = (list: PersistedView[], activeViewId?: string): LayoutPrefs => ({
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    views: list,
    ...(activeViewId === undefined ? {} : { activeViewId }),
  });
  const leaf = (ids: string[]) => ({
    type: "leaf" as const,
    terminals: ids.map((terminalId) => ({ terminalId, customTitle: null })),
    activeTerminalId: ids[0] ?? null,
  });

  it("is a no-op when nothing was persisted (first ever launch)", () => {
    const before = state();
    act().applyCenterLayout(prefsWith([]));
    expect(state()).toBe(before);
    expect(state().views).toHaveLength(1);
  });

  it("is a no-op for a prefs blob from a build that predates views", () => {
    const before = state();
    act().applyCenterLayout({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    expect(state()).toBe(before);
  });

  it("falls back to the first view when activeViewId names none", () => {
    act().applyCenterLayout(prefsWith(
      [
        { id: "v-1", name: "One", layout: leaf(["t-1"]) },
        { id: "v-2", name: "Two", layout: leaf(["t-2"]) },
      ],
      "v-deleted",
    ));
    expect(state().activeViewId).toBe("v-1");
    expect(state().focusedPaneId).toBe(leavesOf(state().layout)[0].id);
  });

  it("falls back to the first view when activeViewId is absent entirely", () => {
    act().applyCenterLayout(prefsWith([{ id: "v-1", name: "One", layout: leaf([]) }]));
    expect(state().activeViewId).toBe("v-1");
  });

  it("repairs a split with fewer than two children rather than throwing", () => {
    // A hand-edited file, or a future shape. The store contract is that a bad
    // file degrades — it must never be able to break boot.
    act().applyCenterLayout(prefsWith([
      {
        id: "v-1",
        name: "One",
        layout: {
          type: "split",
          orientation: "row",
          sizes: [1],
          children: [leaf(["t-1"])],
        },
      },
      {
        id: "v-2",
        name: "Two",
        layout: { type: "split", orientation: "column", sizes: [], children: [] },
      },
    ]));
    expect(leavesOf(state().views[0].layout)).toHaveLength(1);
    expect(leavesOf(state().views[1].layout)).toHaveLength(1);
    assertStoreInvariants(state(), "after a malformed split");
  });

  it("re-derives split sizes that do not match the children", () => {
    const { views: hydrated } = hydrateCenterLayout([
      {
        id: "v-1",
        name: "One",
        layout: {
          type: "split",
          orientation: "row",
          sizes: [0.9], // one size, two children
          children: [leaf(["t-1"]), leaf(["t-2"])],
        },
      },
    ]);
    const root = hydrated[0].layout;
    expect(root.type === "split" && root.sizes).toEqual([0.5, 0.5]);
  });

  it("normalizes sizes that do match, so they sum to 1", () => {
    const { views: hydrated } = hydrateCenterLayout([
      {
        id: "v-1",
        name: "One",
        layout: {
          type: "split",
          orientation: "row",
          sizes: [300, 100], // allotment pixels, straight off the last save
          children: [leaf(["t-1"]), leaf(["t-2"])],
        },
      },
    ]);
    const root = hydrated[0].layout;
    expect(root.type === "split" && root.sizes).toEqual([0.75, 0.25]);
  });

  it("mints fresh pane ids — a persisted one must not collide with the boot tree", () => {
    const bootPane = state().focusedPaneId;
    act().applyCenterLayout(prefsWith([{ id: "v-1", name: "One", layout: leaf([]) }]));
    expect(state().focusedPaneId).not.toBe(bootPane);
  });

  it("does NOT persist — it is the read side (this IS what was just read)", () => {
    act().applyCenterLayout(prefsWith([{ id: "v-1", name: "One", layout: leaf([]) }]));
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ every change is written down ══════════════════════ */

describe("persistence triggers — an unwritten change is a lost change", () => {
  /**
   * Every action that changes what the blob holds must persist in its WRAPPER
   * (never inside the producer). The table is the guardrail: a future action that reshapes the
   * layout and forgets this is exactly how bug 1 and bug 2 happened.
   */
  const cases: Array<[string, () => void]> = [
    ["openTerminalTab", () => void act().openTerminalTab({ cwd: "/w/a" })],
    ["closeTab", () => act().closeTab(act().openTerminalTab({ cwd: "/w/a" }))],
    ["renameTab", () => act().renameTab(act().openTerminalTab({}), "named")],
    [
      "setActiveTab",
      () => {
        const first = act().openTerminalTab({});
        act().openTerminalTab({});
        act().setActiveTab(state().focusedPaneId, first);
      },
    ],
    ["splitPane", () => void act().splitPane(state().focusedPaneId, "row")],
    [
      "moveTab",
      () => {
        const tabId = act().openTerminalTab({});
        const other = act().splitPane(state().focusedPaneId, "row");
        act().moveTab(tabId, other);
      },
    ],
    [
      "moveTabToEdge",
      () => {
        const tabId = act().openTerminalTab({});
        act().moveTabToEdge(tabId, state().focusedPaneId, "right");
      },
    ],
    [
      "closePane",
      () => {
        const pane = act().splitPane(state().focusedPaneId, "row");
        act().closePane(pane);
      },
    ],
    ["createView", () => void act().createView("New")],
    [
      "activateView",
      () => {
        const first = state().activeViewId;
        act().createView("Second");
        act().activateView(first);
      },
    ],
    ["renameView", () => act().renameView(state().activeViewId, "Renamed")],
    [
      "closeView",
      () => {
        const second = act().createView("Second");
        act().closeView(second);
      },
    ],
    [
      "moveTabToView",
      () => {
        const tabId = act().openTerminalTab({});
        const second = act().createView("Second");
        act().moveTabToView(tabId, second);
      },
    ],
    [
      "reorderViews",
      () => {
        const first = state().activeViewId;
        const second = act().createView("Second");
        act().reorderViews(second, first);
      },
    ],
    ["renameAgent", () => fleet().renameAgent(launchAgent("agent-1"), "named")],
    ["dismissAgent", () => fleet().dismissAgent(launchAgent("agent-1"))],
    [
      "removeAgent",
      () => {
        const agentId = launchAgent("agent-1");
        act().closeTab(Object.keys(state().tabs)[0] as TabId);
        fleet().removeAgent(agentId);
      },
    ],
  ];

  it.each(cases)("%s persists the layout", (_name, run) => {
    run();
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    run();
    expect(layoutPrefsIpc.saveLayoutPrefs).toHaveBeenCalled();
  });

  it("writes the views, their names and their contents into the blob", () => {
    const agentId = launchAgent("agent-1");
    fleet().renameAgent(agentId, "Payments");
    act().renameView(state().activeViewId, "Backend");
    const blob = lastSaved();
    expect(blob.views).toEqual([
      {
        id: state().activeViewId,
        name: "Backend",
        layout: {
          type: "leaf",
          terminals: [{ terminalId: agentId, customTitle: "Payments" }],
          activeTerminalId: agentId,
        },
      },
    ]);
    expect(blob.activeViewId).toBe(state().activeViewId);
    // The rail prefs still ride in the same blob — one writer, one file.
    expect(blob.folderOrder).toEqual([]);
  });

  it("does NOT persist on a resize — allotment emits one per drag frame", () => {
    // The single documented exception. Sizes ride along on the next mutation
    // that does persist; a file write per animation frame is not a track worth
    // making for the one layout change nobody notices losing.
    act().openTerminalTab({});
    const split = act().splitPane(state().focusedPaneId, "row");
    const parent = state().layout;
    expect(parent.type).toBe("split");
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    act().resizePane(parent.id, [0.7, 0.3]);
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
    expect(split).toBeTruthy();
  });

  it("does NOT persist when a view action is refused", () => {
    // A no-op must not churn the file: the last view cannot close, an unknown id
    // renames nothing, and a blank name is refused outright.
    act().closeView(state().activeViewId);
    act().renameView(state().activeViewId, "   ");
    act().renameView("no-such-view" as ViewId, "x");
    expect(state().views).toHaveLength(1);
    expect(state().views[0].name).toBe("View 1");
    // The wrapper still fires (it cannot know the producer bailed) — what matters
    // is that the blob it writes is unchanged from the one on disk.
    const blob = lastSaved();
    expect(blob.views?.map((v) => v.name)).toEqual(["View 1"]);
  });
});

/* ══════════════════════ the invariant, end to end ══════════════════════ */

describe("restore keeps the store's own invariants", () => {
  it("leaves no orphan tabs and no dangling ids after any partial restore", () => {
    act().renameView(state().activeViewId, "One");
    const a = launchAgent("agent-a");
    act().splitPane(state().focusedPaneId, "row");
    launchAgent("agent-b");
    const two = act().createView("Two");
    const c = launchAgent("agent-c");
    act().openEditorTab("/w/gazelle/README.md");
    act().activateView(viewNamed("One").id);

    // Only two of the three agents were pinned.
    restart({ survivors: [asTerminalId(a), asTerminalId(c)] });

    assertStoreInvariants(state(), "partial restore");
    expect(Object.keys(state().tabs)).toHaveLength(2);
    expect(terminalsIn(viewNamed("One").id)).toEqual([asTerminalId(a)]);
    expect(terminalsIn(viewNamed("Two").id)).toEqual([asTerminalId(c)]);
    expect(two).toBeTruthy();
    // The editor tab is gone: it was never persisted, and re-opening it is a click.
    expect(
      Object.values(state().tabs).every((tab) => tab.ref.kind === "agent-terminal"),
    ).toBe(true);
  });

  it("re-attaches every restored terminal instead of spawning a new one", () => {
    // Re-attach: the PTY is alive (Rust re-spawned it); a second spawn would leave
    // the user typing into a process nothing is reading.
    launchAgent("agent-1");
    terminal.configureTerminal.mockClear();
    restart();
    expect(terminal.configureTerminal).toHaveBeenCalledWith(
      asTerminalId("agent-1"),
      expect.objectContaining({ reattach: true, agentId: asAgentId("agent-1") }),
    );
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("does not touch a tab id that is already open (idempotent snapshots)", () => {
    launchAgent("agent-1");
    restart();
    const tabId = tabsIn(state().activeViewId)[0];
    act().rebuildTerminalTabs([meta(asTerminalId("agent-1"), asAgentId("agent-1"))]);
    expect(tabsIn(state().activeViewId)).toEqual([tabId]);
    expect(asTabId(tabId)).toBe(tabId);
  });
});
