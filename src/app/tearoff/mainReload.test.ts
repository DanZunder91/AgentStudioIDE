/**
 * The seam between `bridge.ts` and tear-off: a MAIN-window reload must not
 * rebuild the terminals a detached window is showing.
 *
 * `fleet_snapshot` lists every PTY in the app, wherever it is on screen. Rebuilding a tab
 * for one a detached window holds would re-attach it HERE — `terminal_reattach` swaps the
 * pump's channel to this window — and the window that was showing it would freeze. Driven
 * through the real `startBridge`, with Rust played by the mocked fleet IPC and the real
 * `tearoff_holdings` wrapper over the IPC mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal", () => terminal);

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const fleet = vi.hoisted(() => ({
  fleetSnapshot: vi.fn(),
  defaultWorkspace: vi.fn(async () => "/w"),
  recentProjects: vi.fn(async () => []),
  ensureAgentHooks: vi.fn(async () => undefined),
  pushRecentProject: vi.fn(async () => undefined),
  pinnedAgents: vi.fn(async () => []),
  restoredAgents: vi.fn(async () => []),
}));
vi.mock("../../features/fleet/fleetIpc", () => fleet);

const prefs = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn(async () => undefined),
}));
vi.mock("../layoutPrefsIpc", () => prefs);

import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { startBridge } from "../bridge";
import { useAppStore } from "../store";
import { asAgentId, type TerminalMeta } from "../types";
import { wireAgent } from "../../test/fleet-harness";

const meta = (id: string): TerminalMeta =>
  ({ id, kind: "terminal", title: id, cwd: "/w", cols: 80, rows: 24, status: "live" }) as TerminalMeta;

const shown = () =>
  Object.values(useAppStore.getState().tabs).map((t) => (t.ref as { terminalId: string }).terminalId);

let ipc: TauriMock;
beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
  fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [meta("HERE"), meta("THERE")] });
  prefs.loadLayoutPrefs.mockResolvedValue({ folderOrder: [], collapsedFolders: [], collapsedRoots: [] });
  ipc = installTauriMock();
});
afterEach(() => ipc.reset());

describe("a main-window reload with a detached window open", () => {
  it("rebuilds only the terminals no detached window holds", async () => {
    ipc.handle("tearoff_holdings", () => [{ label: "tearoff-1", keys: ["terminal:THERE", "village"] }]);
    await startBridge();
    expect(shown()).toEqual(["HERE"]);
    // …and never reattaches the other one: its stream stays with the window showing it.
    expect(terminal.configureTerminal).not.toHaveBeenCalledWith("THERE", expect.anything());
  });

  it("rebuilds everything when no window holds anything (or the ledger cannot be read)", async () => {
    ipc.handle("tearoff_holdings", () => []);
    await startBridge();
    expect(shown().sort()).toEqual(["HERE", "THERE"]);

    resetStore();
    ipc.handle("tearoff_holdings", () => {
      throw new Error("no such command");
    });
    await startBridge();
    expect(shown().sort()).toEqual(["HERE", "THERE"]);
  });
});

describe("a main-window reload keeps the names of agents a detached window shows", () => {
  // The rebuild that restores a terminal's persisted name skips the held ones — so without
  // this, the next save would write a held agent out unnamed (review finding: the lost-rename
  // bug coming back for an agent whose tab sits in another window).
  const leaf = (terminals: Array<[string, string | null]>) => ({
    type: "leaf" as const,
    terminals: terminals.map(([terminalId, customTitle]) => ({ terminalId, customTitle })),
    activeTerminalId: null,
  });

  it("puts each held agent's persisted name back — and nothing it should not", async () => {
    prefs.loadLayoutPrefs.mockResolvedValue({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      views: [
        {
          id: "v1",
          name: "View 1",
          layout: {
            type: "split",
            orientation: "row",
            sizes: [0.5, 0.5],
            children: [
              leaf([["HELD", "reviewer"], ["LOCAL", "not held"]]),
              leaf([["UNNAMED", null], ["GONE", "ghost"], ["NAMED", "stale"]]),
            ],
          },
        },
      ],
      activeViewId: "v1",
    });
    fleet.fleetSnapshot.mockResolvedValue({
      agents: ["HELD", "LOCAL", "UNNAMED", "NAMED"].map((id) => wireAgent({ id: asAgentId(id) })),
      terminals: [],
    });
    // NAMED already carries a name in this realm (a snapshot keeps a row's existing name).
    useAppStore.getState().agentActions.applyFleetSnapshot([wireAgent({ id: asAgentId("NAMED") })]);
    useAppStore.setState((d) => void (d.agents[asAgentId("NAMED")].customTitle = "live"));
    ipc.handle("tearoff_holdings", () => [
      { label: "tearoff-1", keys: ["terminal:HELD", "terminal:UNNAMED", "terminal:GONE", "terminal:NAMED"] },
    ]);
    await startBridge();
    const name = (id: string) => useAppStore.getState().agents[asAgentId(id)]?.customTitle ?? null;
    expect(name("HELD")).toBe("reviewer");
    expect(name("LOCAL"), "not held: the rebuild's business, and it has no terminal").toBeNull();
    expect(name("UNNAMED")).toBeNull();
    expect(name("NAMED"), "a live name is never overwritten by the file").toBe("live");
    expect(useAppStore.getState().agents[asAgentId("GONE")], "no row conjured").toBeUndefined();
  });
});
