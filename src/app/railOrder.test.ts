/** Rail folder ordering and per-rail collapse persistence: the store contract both rails consume.
 * The persistence effect is asserted through a mocked `layoutPrefsIpc`. */

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

// The layout-prefs persistence EFFECT the reorder/collapse wrappers run. Spy on it
// to prove a mutation persists (and, just as important, that a no-op does NOT).
const layoutPrefsIpc = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn().mockResolvedValue({
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
  }),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
  EMPTY_LAYOUT_PREFS: { folderOrder: [], collapsedFolders: [], collapsedRoots: [] },
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefsIpc);

import { useAppStore, workspaceRoots, type AppStore } from "./store";
import { asAgentId, type AgentId } from "./types";
import { resetStore } from "../test/store-harness";
import { resetFleetStore } from "../test/fleet-harness";

const state = (): AppStore => useAppStore.getState();
const ws = () => state().workspaceActions;
const ag = () => state().agentActions;

/** The last blob handed to `saveLayoutPrefs`, or throw if it was never called. */
const lastSaved = () => {
  const calls = layoutPrefsIpc.saveLayoutPrefs.mock.calls;
  expect(calls.length, "saveLayoutPrefs should have been called").toBeGreaterThan(0);
  return calls[calls.length - 1][0] as {
    folderOrder: string[];
    collapsedFolders: string[];
    collapsedRoots: string[];
  };
};

/** Create a root agent in `cwd` and return its id (dedupes the boilerplate). */
const makeAgent = (cwd: string, title: string): AgentId =>
  ag().createAgent({ cwd, title });

beforeEach(() => {
  resetStore();
  resetFleetStore();
  // The harness resets the layout + fleet slices, but not the workspace slice this
  // feature lives in — clear it so one test's folderOrder/collapse cannot leak.
  useAppStore.setState((s) => {
    s.folderOrder = [];
    s.collapsedFolders = new Set();
    s.collapsedRoots = new Set();
    s.recentProjects = [];
    s.browseRoots = [];
  });
  terminal.configureTerminal.mockClear();
  terminal.setDefaultTerminalCwd.mockClear();
  layoutPrefsIpc.saveLayoutPrefs.mockClear();
});

/* ══════════════════════ workspaceRoots — ordered by folderOrder ══════════════════════ */

describe("workspaceRoots ordering (same sort as the left rail)", () => {
  it("orders roots by folderOrder when it is provided", () => {
    const agents = {
      [asAgentId("a")]: { cwd: "/w/a" } as never,
      [asAgentId("b")]: { cwd: "/w/b" } as never,
      [asAgentId("c")]: { cwd: "/w/c" } as never,
    };
    const roots = workspaceRoots({
      rootAgentIds: [asAgentId("a"), asAgentId("b"), asAgentId("c")],
      agents,
      browseRoots: [],
      folderOrder: ["/w/c", "/w/a", "/w/b"],
    });
    expect(roots).toEqual(["/w/c", "/w/a", "/w/b"]);
  });

  it("falls back to discovery order (agent cwds, then browse roots) with no folderOrder", () => {
    const roots = workspaceRoots({
      rootAgentIds: [asAgentId("a")],
      agents: { [asAgentId("a")]: { cwd: "/w/a" } as never },
      browseRoots: ["/w/z"],
    });
    expect(roots).toEqual(["/w/a", "/w/z"]);
  });

  it("dedupes a folder that is both an agent cwd and a browse root", () => {
    const roots = workspaceRoots({
      rootAgentIds: [asAgentId("a")],
      agents: { [asAgentId("a")]: { cwd: "/w/shared" } as never },
      browseRoots: ["/w/shared", "/w/other"],
      folderOrder: ["/w/other", "/w/shared"],
    });
    expect(roots).toEqual(["/w/other", "/w/shared"]);
  });
});

/* ══════════════════════ moveFolder ══════════════════════ */

describe("moveFolder", () => {
  it("moves a folder before the target and persists the new order", () => {
    ws().applyLayoutPrefs({
      folderOrder: ["/w/a", "/w/b", "/w/c"],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    layoutPrefsIpc.saveLayoutPrefs.mockClear();

    ws().moveFolder("/w/c", "/w/a");
    expect(state().folderOrder).toEqual(["/w/c", "/w/a", "/w/b"]);
    expect(lastSaved().folderOrder).toEqual(["/w/c", "/w/a", "/w/b"]);
  });

  it("moves a folder to the end when target is null", () => {
    ws().applyLayoutPrefs({
      folderOrder: ["/w/a", "/w/b", "/w/c"],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    ws().moveFolder("/w/a", null);
    expect(state().folderOrder).toEqual(["/w/b", "/w/c", "/w/a"]);
  });
});

/* ══════════════════════ syncFolderOrder ══════════════════════ */

describe("syncFolderOrder (keeps the shared order complete)", () => {
  it("appends newly-seen folders and persists", () => {
    ws().syncFolderOrder(["/w/a", "/w/b"]);
    expect(state().folderOrder).toEqual(["/w/a", "/w/b"]);
    expect(layoutPrefsIpc.saveLayoutPrefs).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no state change, no persist) when nothing is new", () => {
    ws().syncFolderOrder(["/w/a"]);
    const orderRef = state().folderOrder;
    layoutPrefsIpc.saveLayoutPrefs.mockClear();

    ws().syncFolderOrder(["/w/a"]);
    // Same reference (no re-render churn) AND no wasted persist on a quiet tick.
    expect(state().folderOrder).toBe(orderRef);
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
  });

  it("preserves an existing manual order, appending only the new tail", () => {
    ws().applyLayoutPrefs({
      folderOrder: ["/w/b", "/w/a"],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    ws().syncFolderOrder(["/w/a", "/w/b", "/w/c"]);
    expect(state().folderOrder).toEqual(["/w/b", "/w/a", "/w/c"]);
  });
});

/* ══════════════════════════ collapse persistence ══════════════════════════ */

describe("toggleFolderCollapsed (left rail) now persists", () => {
  it("persists the collapse set on toggle", () => {
    ag().toggleFolderCollapsed("/w/gazelle");
    expect(state().collapsedFolders.has("/w/gazelle")).toBe(true);
    expect(lastSaved().collapsedFolders).toEqual(["/w/gazelle"]);

    ag().toggleFolderCollapsed("/w/gazelle");
    expect(state().collapsedFolders.has("/w/gazelle")).toBe(false);
    expect(lastSaved().collapsedFolders).toEqual([]);
  });
});

describe("toggleRootCollapsed (right rail)", () => {
  it("defaults expanded, toggles a path in/out of collapsedRoots, and persists", () => {
    expect(state().collapsedRoots.has("/w/a")).toBe(false); // default expanded
    ws().toggleRootCollapsed("/w/a");
    expect(state().collapsedRoots.has("/w/a")).toBe(true);
    expect(lastSaved().collapsedRoots).toEqual(["/w/a"]);

    ws().toggleRootCollapsed("/w/a");
    expect(state().collapsedRoots.has("/w/a")).toBe(false);
    expect(lastSaved().collapsedRoots).toEqual([]);
  });

  it("is independent of the left rail's collapse set", () => {
    ag().toggleFolderCollapsed("/w/x");
    ws().toggleRootCollapsed("/w/y");
    expect(state().collapsedFolders.has("/w/x")).toBe(true);
    expect(state().collapsedFolders.has("/w/y")).toBe(false);
    expect(state().collapsedRoots.has("/w/y")).toBe(true);
    expect(state().collapsedRoots.has("/w/x")).toBe(false);
  });
});

/* ══════════════════════════ moveRootAgent ══════════════════════════ */

describe("moveRootAgent (reorder agents within a folder)", () => {
  it("moves a root agent before the target in rootAgentIds", () => {
    const a = makeAgent("/w/proj", "a");
    const b = makeAgent("/w/proj", "b");
    const c = makeAgent("/w/proj", "c");
    expect(state().rootAgentIds).toEqual([a, b, c]);

    ag().moveRootAgent(c, a);
    expect(state().rootAgentIds).toEqual([c, a, b]);
  });

  it("moves to the end when target is null", () => {
    const a = makeAgent("/w/proj", "a");
    const b = makeAgent("/w/proj", "b");
    ag().moveRootAgent(a, null);
    expect(state().rootAgentIds).toEqual([b, a]);
  });

  it("is a no-op for an id that is not a root agent", () => {
    const a = makeAgent("/w/proj", "a");
    const before = [...state().rootAgentIds];
    ag().moveRootAgent(asAgentId("ghost"), a);
    expect(state().rootAgentIds).toEqual(before);
  });

  it("does not persist (agent order is session-only)", () => {
    const a = makeAgent("/w/proj", "a");
    const b = makeAgent("/w/proj", "b");
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    ag().moveRootAgent(b, a);
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ applyLayoutPrefs (boot seed) ══════════════════════ */

describe("applyLayoutPrefs (boot seed)", () => {
  it("seeds folderOrder and both collapse sets", () => {
    ws().applyLayoutPrefs({
      folderOrder: ["/w/b", "/w/a"],
      collapsedFolders: ["/w/a"],
      collapsedRoots: ["/w/b"],
    });
    expect(state().folderOrder).toEqual(["/w/b", "/w/a"]);
    expect([...state().collapsedFolders]).toEqual(["/w/a"]);
    expect([...state().collapsedRoots]).toEqual(["/w/b"]);
  });

  it("does NOT persist (it is the read side — Rust just handed us this)", () => {
    ws().applyLayoutPrefs({
      folderOrder: ["/w/a"],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
  });

  it("copies the arrays so later mutations do not alias the prefs blob", () => {
    const prefs = { folderOrder: ["/w/a"], collapsedFolders: [], collapsedRoots: [] };
    ws().applyLayoutPrefs(prefs);
    ws().moveFolder("/w/b", null); // grows folderOrder
    expect(prefs.folderOrder).toEqual(["/w/a"]); // the source blob is untouched
  });
});
