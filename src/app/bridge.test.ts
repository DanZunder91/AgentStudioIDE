/** The bridge: `agent://event` to reducers, and its startup race. The event module is mocked (not
 * `invoke`) so a test can play Rust and land each event exactly relative to the snapshot. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

/** Stands in for Rust: captures the listener, lets the test emit on demand. */
const tauriEvent = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  return {
    handlers,
    unlisten: vi.fn(),
    listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return tauriEvent.unlisten;
    }),
    /** Deliver one event as Rust would. */
    emit(name: string, payload: unknown) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`nothing is listening to ${name}`);
      handler({ payload });
    },
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

const fleet = vi.hoisted(() => ({
  fleetSnapshot: vi.fn(),
  defaultWorkspace: vi.fn(),
  recentProjects: vi.fn(),
  ensureAgentHooks: vi.fn(),
  pushRecentProject: vi.fn(),
  pinnedAgents: vi.fn(),
  restoredAgents: vi.fn(),
}));
vi.mock("../features/fleet/fleetIpc", () => fleet);

// The persisted rail prefs the boot seeds (folder order + collapse state). Mocked so `startBridge`
// gets deterministic prefs without touching Tauri; the default is empty prefs.
const layoutPrefs = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefs);

import { AGENT_EVENT, startBridge } from "./bridge";
import { useAppStore, viewTabIds } from "./store";
import type { AgentEvent, AgentId, AgentNode } from "./types";
import { useLogStore } from "../features/logs/logStore";
import { resetFleetStore, wireAgent } from "../test/fleet-harness";
import { resetStore } from "../test/store-harness";

const state = () => useAppStore.getState();
const id = (s: string) => s as AgentId;

const started = (agentId: string, title = agentId): AgentEvent => ({
  t: "agent_started",
  agentId: id(agentId),
  parentId: null,
  title,
  cwd: "/w/gazelle",
  branch: "trunk",
  runtime: "claude-code",
});

beforeEach(() => {
  resetFleetStore();
  useAppStore.setState((s) => {
    s.workspaceRoot = null;
    s.recentProjects = [];
  });
  tauriEvent.handlers.clear();
  tauriEvent.listen.mockClear();
  tauriEvent.unlisten.mockClear();
  fleet.fleetSnapshot.mockReset();
  fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [] });
  fleet.defaultWorkspace.mockReset();
  fleet.defaultWorkspace.mockResolvedValue("/Users/me/projects/gazelle");
  fleet.recentProjects.mockReset();
  fleet.recentProjects.mockResolvedValue([]);
  fleet.ensureAgentHooks.mockReset();
  fleet.ensureAgentHooks.mockResolvedValue(undefined);
  fleet.pushRecentProject.mockReset();
  fleet.pushRecentProject.mockResolvedValue(undefined);
  // `pinnedAgents()` is internally best-effort (yields [] on failure); the mock
  // stands in for that resolved value, so a default of [] is the "no pins" boot.
  fleet.pinnedAgents.mockReset();
  fleet.pinnedAgents.mockResolvedValue([]);
  // Same contract for the restore markers (`restoredAgents()` swallows to []): the
  // default is a boot that restored nothing.
  fleet.restoredAgents.mockReset();
  fleet.restoredAgents.mockResolvedValue([]);
  layoutPrefs.loadLayoutPrefs.mockReset();
  layoutPrefs.loadLayoutPrefs.mockResolvedValue({
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
  });
  layoutPrefs.saveLayoutPrefs.mockClear();
  useAppStore.setState((s) => {
    s.folderOrder = [];
    s.collapsedFolders = new Set();
    s.collapsedRoots = new Set();
  });
  // The center layout is boot state too: a view restored by one test must not be
  // the view the next one boots into (store-harness.ts's own reset rationale).
  resetStore();
  terminal.setDefaultTerminalCwd.mockClear();
  // The diagnostics log is a separate store the bridge now emits into — reset it
  // between tests so emission assertions see only this test's entries.
  useLogStore.setState({ entries: [], nextId: 0, visible: false, levelFilter: "all", textFilter: "" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("startBridge — wiring", () => {
  it("subscribes to agent://event and reduces payloads into the store", async () => {
    await startBridge();

    expect(tauriEvent.listen).toHaveBeenCalledWith(AGENT_EVENT, expect.any(Function));

    tauriEvent.emit(AGENT_EVENT, started("a1", "Pull latest changes"));

    expect(state().agents[id("a1")].title).toBe("Pull latest changes");
    expect(state().rootAgentIds).toEqual([id("a1")]);
  });

  it("paints the initial fleet from fleet_snapshot", async () => {
    fleet.fleetSnapshot.mockResolvedValue({
      agents: [wireAgent({ id: id("a1"), title: "restored" })],
      terminals: [],
    });

    await startBridge();

    expect(state().agents[id("a1")].title).toBe("restored");
  });

  it("stop() unsubscribes", async () => {
    const bridge = await startBridge();
    bridge.stop();
    expect(tauriEvent.unlisten).toHaveBeenCalledTimes(1);
  });

  it("seeds the workspace root from default_workspace on startup", async () => {
    fleet.defaultWorkspace.mockResolvedValue("/Users/me/projects/gazelle");

    await startBridge();

    expect(fleet.defaultWorkspace).toHaveBeenCalledTimes(1);
    expect(state().workspaceRoot).toBe("/Users/me/projects/gazelle");
    // And it re-pointed the terminal default (so plain terminals open there too).
    expect(terminal.setDefaultTerminalCwd).toHaveBeenCalledWith("/Users/me/projects/gazelle");
  });

  it("installs the ad-hoc-detection hook for the boot workspace root", async () => {
    fleet.defaultWorkspace.mockResolvedValue("/Users/me/projects/gazelle");

    await startBridge();

    // Terminals opened in this root — or a subdir the user cd's into — need the
    // hook at the repo root, and opening the folder spawns nothing, so the bridge
    // installs it on boot.
    expect(fleet.ensureAgentHooks).toHaveBeenCalledWith("/Users/me/projects/gazelle");
  });

  it("survives ensure_agent_hooks rejecting — startup still completes (best-effort)", async () => {
    fleet.ensureAgentHooks.mockRejectedValue(new Error("no listener"));

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    // The hook install is best-effort; the root is still seeded and telemetry up.
    expect(state().workspaceRoot).toBe("/Users/me/projects/gazelle");
    expect(state().agents[id("a1")]).toBeDefined();
  });

  it("survives default_workspace rejecting — telemetry still connects", async () => {
    fleet.defaultWorkspace.mockRejectedValue(new Error("not implemented"));

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    // Workspace stays null (falls back to app cwd), but the bridge is up.
    expect(state().workspaceRoot).toBeNull();
    expect(state().agents[id("a1")]).toBeDefined();
  });

  it("seeds recent projects from recent_projects on startup", async () => {
    fleet.recentProjects.mockResolvedValue(["/w/gazelle", "/w/api"]);

    await startBridge();

    expect(fleet.recentProjects).toHaveBeenCalledTimes(1);
    expect(state().recentProjects).toEqual(["/w/gazelle", "/w/api"]);
  });

  it("survives recent_projects rejecting — telemetry still connects", async () => {
    fleet.recentProjects.mockRejectedValue(new Error("not implemented"));

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    expect(state().recentProjects).toEqual([]);
    expect(state().agents[id("a1")]).toBeDefined();
  });

  it("seeds the persisted rail prefs (folder order + both collapse sets) on startup", async () => {
    layoutPrefs.loadLayoutPrefs.mockResolvedValue({
      folderOrder: ["/w/api", "/w/gazelle"],
      collapsedFolders: ["/w/gazelle"],
      collapsedRoots: ["/w/api"],
    });

    await startBridge();

    expect(layoutPrefs.loadLayoutPrefs).toHaveBeenCalledTimes(1);
    expect(state().folderOrder).toEqual(["/w/api", "/w/gazelle"]);
    expect([...state().collapsedFolders]).toEqual(["/w/gazelle"]);
    expect([...state().collapsedRoots]).toEqual(["/w/api"]);
  });

  it("restores the persisted center layout BEFORE the terminals are rebuilt", async () => {
    // Order is the fix: views must exist before `rebuildTerminalTabs` places terminals into them,
    // or every restored agent lands in the boot view and the arrangement is lost.
    const leaf = (terminalId: string) => ({
      type: "leaf" as const,
      terminals: [{ terminalId, customTitle: null }],
      activeTerminalId: terminalId,
    });
    layoutPrefs.loadLayoutPrefs.mockResolvedValue({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      views: [
        { id: "v-1", name: "Backend", layout: leaf("a1") },
        { id: "v-2", name: "Frontend", layout: leaf("a2") },
      ],
      activeViewId: "v-2",
    });
    fleet.fleetSnapshot.mockResolvedValue({
      agents: [wireAgent({ id: id("a1") }), wireAgent({ id: id("a2") })],
      terminals: [
        { id: "a1", kind: "agent-terminal", title: "a1", cwd: "/w/gazelle", cols: 80, rows: 24, status: "live", agentId: id("a1") },
        { id: "a2", kind: "agent-terminal", title: "a2", cwd: "/w/gazelle", cols: 80, rows: 24, status: "live", agentId: id("a2") },
      ],
    });

    await startBridge();

    expect(state().views.map((v) => v.name)).toEqual(["Backend", "Frontend"]);
    expect(state().activeViewId).toBe("v-2");
    // One agent per view — not both in whichever one is on screen.
    const terminalsIn = (viewId: string) =>
      viewTabIds(state(), viewId as never).map((tabId) => {
        const ref = state().tabs[tabId].ref;
        return ref.kind === "agent-terminal" ? ref.terminalId : null;
      });
    expect(terminalsIn("v-1")).toEqual(["a1"]);
    expect(terminalsIn("v-2")).toEqual(["a2"]);
    expect(state().pendingRestore).toEqual({});
  });

  it("boots to its own single view when nothing was ever persisted", async () => {
    await startBridge();
    expect(state().views).toHaveLength(1);
    expect(state().views[0].name).toBe("View 1");
  });

  it("keeps folderOrder complete: a discovered agent folder is appended", async () => {
    // No persisted order; an agent boots in /w/gazelle (the `started` default cwd).
    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    expect(state().folderOrder).toContain("/w/gazelle");
  });

  it("survives a snapshot that rejects — live telemetry still lands", async () => {
    // Rust may not implement fleet_snapshot yet; that must not take the
    // telemetry stream down with it.
    fleet.fleetSnapshot.mockRejectedValue(new Error("not implemented"));

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    expect(state().agents[id("a1")]).toBeDefined();
  });
});

describe("startBridge — ad-hoc folders become readable", () => {
  it("registers an agent's folder as a recent project + installs its hook", async () => {
    // Startup seeds [] ; after the folder is pushed, Rust returns it so the store's
    // recents (and thus read_dir's allowed_roots) include it — otherwise the folder
    // shows "Can't read this folder." in the Files tree.
    fleet.recentProjects.mockReset();
    fleet.recentProjects.mockResolvedValueOnce([]);
    fleet.recentProjects.mockResolvedValue(["/w/adhoc-alpha"]);

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, { ...started("z1"), cwd: "/w/adhoc-alpha" });

    // Recorded on the Rust side (that is what widens allowed_roots) + hook (re)installed.
    expect(fleet.pushRecentProject).toHaveBeenCalledWith("/w/adhoc-alpha");
    expect(fleet.ensureAgentHooks).toHaveBeenCalledWith("/w/adhoc-alpha");

    // Once the push settles, the store's recents refresh from Rust — the folder is
    // now inside allowed_roots and reads in the tree.
    await vi.waitFor(() => expect(state().recentProjects).toContain("/w/adhoc-alpha"));
  });

  it("registers each folder once, even under a chatty telemetry stream", async () => {
    await startBridge();
    // Same folder, three events (a rename + a re-emit): still one registration.
    tauriEvent.emit(AGENT_EVENT, { ...started("z2"), cwd: "/w/adhoc-beta" });
    tauriEvent.emit(AGENT_EVENT, { ...started("z2"), cwd: "/w/adhoc-beta" });
    tauriEvent.emit(AGENT_EVENT, { ...started("z3", "renamed"), cwd: "/w/adhoc-beta" });

    const pushes = fleet.pushRecentProject.mock.calls.filter((c) => c[0] === "/w/adhoc-beta");
    expect(pushes).toHaveLength(1);
  });
});

describe("startBridge — the startup race", () => {
  it("listens BEFORE snapshotting, so nothing in the gap is lost", async () => {
    // The naive order (snapshot then listen) drops every event in flight. Prove
    // the listener exists while the snapshot is still pending.
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));

    // Rust emits while the snapshot is still in flight.
    tauriEvent.emit(AGENT_EVENT, started("late", "arrived mid-snapshot"));
    // ...and it is buffered, not applied, not dropped.
    expect(state().agents[id("late")]).toBeUndefined();

    resolveSnapshot({ agents: [], terminals: [] });
    await pending;

    // Flushed once the snapshot landed.
    expect(state().agents[id("late")].title).toBe("arrived mid-snapshot");
  });

  it("does not let a stale snapshot resurrect an agent that already exited", async () => {
    // THE bug this ordering exists to prevent. The snapshot is a floor taken at
    // T0; the exit happened at T1. Applying the buffer after the snapshot is
    // what keeps the newer fact.
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));

    tauriEvent.emit(AGENT_EVENT, started("a1"));
    tauriEvent.emit(AGENT_EVENT, { t: "exited", agentId: id("a1"), code: 0 });

    // The snapshot was taken before the exit and still says "running".
    resolveSnapshot({
      agents: [wireAgent({ id: id("a1"), status: "running" })],
      terminals: [],
    });
    await pending;

    expect(state().agents[id("a1")].status).toBe("done");
  });

  it("replays buffered events in arrival order", async () => {
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));

    tauriEvent.emit(AGENT_EVENT, started("a1"));
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("a1"), status: "waiting_input" });
    tauriEvent.emit(AGENT_EVENT, { t: "title", agentId: id("a1"), title: "final" });

    resolveSnapshot({ agents: [], terminals: [] });
    await pending;

    // Out of order, the title would be "a1" and the status "running".
    expect(state().agents[id("a1")].title).toBe("final");
    expect(state().agents[id("a1")].status).toBe("waiting_input");
  });

  it("flushes the buffer even when the snapshot rejected", async () => {
    // The `finally` — without it a failed snapshot strands the buffer and the
    // rail freezes for the rest of the session.
    let rejectSnapshot!: (e: Error) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((_, reject) => {
        rejectSnapshot = reject;
      }),
    );

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    rejectSnapshot(new Error("boom"));
    await pending;

    expect(state().agents[id("a1")]).toBeDefined();
  });

  it("goes direct after the buffer drains — no double-apply", async () => {
    await startBridge();

    tauriEvent.emit(AGENT_EVENT, started("a1"));
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("a1"), status: "waiting_input" });

    // A buffered event replayed twice would double the bubbled unread count.
    expect(state().agents[id("a1")].unread).toBe(1);
  });
});

describe("startBridge — pin restore", () => {
  const pin = (agentId: string, over: Partial<{ cwd: string; title: string }> = {}) => ({
    agentId: id(agentId),
    cwd: over.cwd ?? "/w/gazelle",
    title: over.title ?? agentId,
  });

  it("flags snapshot roots that are pinned, on boot", async () => {
    // Rust auto-spawned the pinned root, so it arrives through the snapshot; the
    // reconcile step flags it pinned so it shows its persistent signal.
    fleet.fleetSnapshot.mockResolvedValue({
      agents: [wireAgent({ id: id("root") })],
      terminals: [],
    });
    fleet.pinnedAgents.mockResolvedValue([pin("root")]);

    await startBridge();

    expect(state().agents[id("root")].pinned).toBe(true);
  });

  it("leaves a non-pinned snapshot root unflagged", async () => {
    fleet.fleetSnapshot.mockResolvedValue({
      agents: [wireAgent({ id: id("root") })],
      terminals: [],
    });
    fleet.pinnedAgents.mockResolvedValue([]); // nothing pinned

    await startBridge();

    expect(state().agents[id("root")].pinned).toBeFalsy();
  });

  it("skips a pin whose row is absent from the snapshot (Rust could not respawn)", async () => {
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [] });
    fleet.pinnedAgents.mockResolvedValue([pin("gone", { title: "yesterday" })]);

    await startBridge();

    // No row was materialized — the FE only flags rows the snapshot brought back.
    expect(state().agents[id("gone")]).toBeUndefined();
  });

  it("survives pinned_agents yielding [] — boot still completes (best-effort)", async () => {
    fleet.pinnedAgents.mockResolvedValue([]); // the wrapper swallows to []

    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));

    expect(state().agents[id("a1")]).toBeDefined();
  });

  it("a pinned agent that exits mid-boot ends greyed, not stuck running", async () => {
    // Pins are reconciled inside the try (after the snapshot); the buffered exit
    // is flushed in the finally AFTER, so the newer fact (exit) wins — and the
    // pin flag survives the exit (hydrate preserves it).
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    fleet.pinnedAgents.mockResolvedValue([pin("root")]);

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));

    tauriEvent.emit(AGENT_EVENT, { t: "exited", agentId: id("root"), code: 0 });
    resolveSnapshot({
      agents: [wireAgent({ id: id("root"), status: "running" })],
      terminals: [],
    });
    await pending;

    expect(state().agents[id("root")].status).toBe("done"); // buffered exit won
    expect(state().agents[id("root")].pinned).toBe(true); // still pinned
  });
});

describe("startBridge — every open agent comes back (agents survive a restart, phase 1)", () => {
  const agentTerminal = (agentId: string) => ({
    id: agentId,
    kind: "agent-terminal" as const,
    title: "Claude Code",
    cwd: "/w/gazelle",
    cols: 80,
    rows: 24,
    status: "live" as const,
    agentId: id(agentId),
  });
  const leaf = (terminalId: string, customTitle: string | null = null) => ({
    type: "leaf" as const,
    terminals: [{ terminalId, customTitle }],
    activeTerminalId: terminalId,
  });

  it("puts UNPINNED restored agents back in their own views, with their names, marked", async () => {
    // The requirement end to end at the boot seam: two agents never
    // pinned, one per view, one renamed. Rust re-spawned both under their ids before
    // the snapshot; the layout blob says where each lived.
    layoutPrefs.loadLayoutPrefs.mockResolvedValue({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      views: [
        { id: "v-1", name: "Backend", layout: leaf("a1", "API agent") },
        { id: "v-2", name: "Frontend", layout: leaf("a2") },
      ],
      activeViewId: "v-1",
    });
    fleet.fleetSnapshot.mockResolvedValue({
      agents: [wireAgent({ id: id("a1"), status: "idle" }), wireAgent({ id: id("a2"), status: "idle" })],
      terminals: [agentTerminal("a1"), agentTerminal("a2")],
    });
    fleet.restoredAgents.mockResolvedValue([
      { agentId: id("a1"), outcome: "resumed", wasWorking: true },
      { agentId: id("a2"), outcome: "fresh", wasWorking: false },
    ]);

    await startBridge();

    const terminalsIn = (viewId: string) =>
      viewTabIds(state(), viewId as never).map((tabId) => {
        const ref = state().tabs[tabId].ref;
        return ref.kind === "agent-terminal" ? ref.terminalId : null;
      });
    expect(terminalsIn("v-1")).toEqual(["a1"]);
    expect(terminalsIn("v-2")).toEqual(["a2"]);
    expect(state().agents[id("a1")].customTitle).toBe("API agent");
    expect(state().agents[id("a1")].restored).toEqual({ outcome: "resumed", wasWorking: true });
    expect(state().agents[id("a2")].restored).toEqual({ outcome: "fresh", wasWorking: false });
    // Neither was pinned, and nothing on the way pinned them.
    expect(state().agents[id("a1")].pinned).toBe(false);
    expect(fleet.restoredAgents).toHaveBeenCalledTimes(1);
  });

  it("a restored agent that starts a turn during boot ends unmarked — the newer fact wins", async () => {
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    fleet.restoredAgents.mockResolvedValue([
      { agentId: id("root"), outcome: "resumed", wasWorking: true },
    ]);

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));
    // Buffered: the user already told it to continue while the snapshot was in flight.
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("root"), status: "running" });
    resolveSnapshot({ agents: [wireAgent({ id: id("root"), status: "idle" })], terminals: [] });
    await pending;

    expect(state().agents[id("root")].status).toBe("running");
    expect(state().agents[id("root")].restored).toBeNull();
  });

  it("boots normally when restored_agents yields nothing", async () => {
    fleet.fleetSnapshot.mockResolvedValue({ agents: [wireAgent({ id: id("root") })], terminals: [] });
    fleet.restoredAgents.mockResolvedValue([]); // the wrapper swallows a failure to []

    await startBridge();

    expect(state().agents[id("root")].restored).toBeNull();
  });
});

describe("startBridge — a resumed session's ended sub-agents", () => {
  it("a sub-agent the snapshot has as done, whose spawn was buffered, still ends done", async () => {
    // Rust emitted `subagent_spawned` + `status` (child already `done`) while the snapshot was in
    // flight; replaying the spawn alone would turn `done` back into running, the status fixes it.
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));
    tauriEvent.emit(AGENT_EVENT, {
      t: "subagent_spawned",
      parentId: id("root"),
      childAgentId: id("kid"),
      title: "explore",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("kid"), status: "done" });
    resolveSnapshot({
      agents: [
        wireAgent({ id: id("root"), status: "idle" }),
        wireAgent({ id: id("kid"), parentId: id("root"), kind: "subagent", status: "done" }),
      ],
      terminals: [],
    });
    await pending;

    expect(state().agents[id("kid")].status).toBe("done");
    expect(state().agents[id("root")].childIds).toEqual([id("kid")]);
  });
});

describe("startBridge — diagnostics-log emission", () => {
  const logs = () => useLogStore.getState().entries;

  it("appends a log line for a status transition, without altering dispatch", async () => {
    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("a1"));
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("a1"), status: "waiting_input" });

    // The status transition is captured as a level:"event" line (source "agent").
    const status = logs().find((e) => e.message === "a1 → waiting_input");
    expect(status).toMatchObject({ level: "event", source: "agent" });

    // Emission is additive: the store still reduced the event as before.
    expect(state().agents[id("a1")].status).toBe("waiting_input");
  });

  it("logs a status line keyed by the agent's id (the ULID)", async () => {
    await startBridge();
    tauriEvent.emit(AGENT_EVENT, started("01H-ULID-XYZ", "gazelle"));
    tauriEvent.emit(AGENT_EVENT, { t: "status", agentId: id("01H-ULID-XYZ"), status: "running" });

    expect(logs().some((e) => e.message === "01H-ULID-XYZ → running")).toBe(true);
  });

  it("also emits for buffered events flushed after the snapshot", async () => {
    let resolveSnapshot!: (v: { agents: AgentNode[]; terminals: [] }) => void;
    fleet.fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = startBridge();
    await vi.waitFor(() => expect(tauriEvent.handlers.has(AGENT_EVENT)).toBe(true));
    tauriEvent.emit(AGENT_EVENT, started("buffered"));
    // Buffered — not yet applied, so not yet logged.
    expect(logs().some((e) => e.message.startsWith("buffered"))).toBe(false);

    resolveSnapshot({ agents: [], terminals: [] });
    await pending;

    // Flushed on ready → logged.
    expect(logs().some((e) => e.message === "buffered started")).toBe(true);
  });

  it("logs a warning when fleet_snapshot fails (the 'keep listening' path)", async () => {
    fleet.fleetSnapshot.mockRejectedValue(new Error("not implemented"));

    await startBridge();

    const warn = logs().find((e) => e.source === "bridge" && e.message.startsWith("fleet_snapshot failed"));
    expect(warn).toMatchObject({ level: "warn" });
  });
});
