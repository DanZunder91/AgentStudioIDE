/**
 * Tab tear-off's seams into the store — the open router and the "held elsewhere" provider
 * (`routeOpensElsewhere`, `provideHeldElsewhere`).
 *
 * Two review findings, one per seam:
 *  - opening a file (or a singleton panel) another OS window already shows must bring that
 *    window forward, never open a second copy here — two editor tabs on one file in two
 *    realms are two live writers for it;
 *  - an agent whose tab sits in another window when the app quits must keep its custom
 *    name (the lost-rename bug), so the main window — the only writer of `layout-prefs.json` —
 *    keeps such agents in the blob, names included.
 *
 * Both seams are inert until installed, which is what every other suite relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);
vi.mock("../features/editor", () => ({ disposeEditorBuffer: vi.fn() }));

const layoutPrefs = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefs);

import { resetFleetStore, wireAgent } from "../test/fleet-harness";
import { resetStore } from "../test/store-harness";
import type { PersistedPane } from "./layoutPrefsIpc";
import {
  layoutPrefsBlob,
  leavesOf,
  persistLayoutNow,
  provideHeldElsewhere,
  routeOpensElsewhere,
  serializeCenterLayout,
  TAB_ELSEWHERE,
  useAppStore,
  type OpenRouter,
} from "./store";
import { asAgentId } from "./types";

const s = () => useAppStore.getState();
const actions = () => s().layoutActions;
const AGENT = asAgentId("01AGENT");

const offs: Array<() => void> = [];
beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/** Every open action the router covers, with the key it must be asked about. */
const OPENS: Array<[string, () => string, string]> = [
  ["openEditorTab", () => actions().openEditorTab("/w/a.ts"), "editor:/w/a.ts"],
  ["openDiffTab", () => actions().openDiffTab("/w/a.ts"), "diff:/w/a.ts"],
  ["openMetricsTab", () => actions().openMetricsTab("/w"), "metrics"],
  ["openAgentLogsTab", () => actions().openAgentLogsTab(), "agent-logs"],
  ["openNetworkTab", () => actions().openNetworkTab(), "network"],
  ["openVillageTab", () => actions().openVillageTab(), "village"],
];

describe("the open router", () => {
  it("is not consulted until installed: every open opens here", () => {
    for (const [name, open] of OPENS) expect(open(), name).not.toBe(TAB_ELSEWHERE);
    expect(Object.keys(s().tabs)).toHaveLength(OPENS.length);
  });

  it.each(OPENS)("%s: a tab another window holds is routed there, and nothing opens here", (_, open, key) => {
    const asked: string[] = [];
    offs.push(routeOpensElsewhere((k) => (asked.push(k), true)));
    expect(open()).toBe(TAB_ELSEWHERE);
    expect(asked).toEqual([key]);
    expect(s().tabs).toEqual({});
  });

  it.each(OPENS)("%s: the fallback opens it here after all (the holder was gone)", (_, open) => {
    let fallback!: () => void;
    let routing = true;
    offs.push(routeOpensElsewhere((_k, openHere) => ((fallback = openHere), routing)));
    open();
    routing = false; // what boot's `openHere` bypass amounts to
    fallback();
    expect(Object.keys(s().tabs)).toHaveLength(1);
  });

  it("a router that declines leaves the open alone", () => {
    offs.push(routeOpensElsewhere(() => false));
    expect(actions().openEditorTab("/w/a.ts")).not.toBe(TAB_ELSEWHERE);
  });

  it("a tab already HERE wins — the router is never asked", () => {
    const router = vi.fn<OpenRouter>(() => true);
    const id = actions().openEditorTab("/w/a.ts");
    offs.push(routeOpensElsewhere(router));
    expect(actions().openEditorTab("/w/a.ts")).toBe(id);
    expect(router).not.toHaveBeenCalled();
  });

  it("an uninstall removes only the router it installed", () => {
    const first = routeOpensElsewhere(() => true);
    const second = routeOpensElsewhere(() => true);
    first(); // stale: the second one is installed now
    expect(actions().openVillageTab()).toBe(TAB_ELSEWHERE);
    second();
    expect(actions().openVillageTab()).not.toBe(TAB_ELSEWHERE);
  });
});

/** The terminal entries of a persisted pane tree, depth-first. */
function entries(node: PersistedPane): Array<{ terminalId: string; customTitle: string | null }> {
  return node.type === "leaf" ? node.terminals : node.children.flatMap(entries);
}

describe("agents held elsewhere stay in the persisted layout", () => {
  const OTHER = asAgentId("01OTHER");

  it("are written into the active view's first pane, with the name the agent carries", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT }), wireAgent({ id: OTHER })]);
    s().agentActions.renameAgent(AGENT, "reviewer");
    // A split, so the first pane is found by walking the tree.
    actions().openTerminalTab({ cwd: "/w", agentId: OTHER, runtime: "claude-code" });
    actions().splitPane(leavesOf(s().layout)[0].id, "row");
    offs.push(provideHeldElsewhere(() => [AGENT, "PLAIN-SHELL", OTHER]));

    const blob = layoutPrefsBlob(s());
    const active = blob.views?.find((v) => v.id === blob.activeViewId);
    expect(active?.layout.type).toBe("split");
    expect(entries(active!.layout)).toEqual([
      { terminalId: OTHER, customTitle: null }, // already in the layout: not written twice
      { terminalId: AGENT, customTitle: "reviewer" }, // parked, named
      // "PLAIN-SHELL" is no agent: it dies with the app, and its name lives over there.
    ]);
  });

  it("goes into the ACTIVE view, whichever that is", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    const first = s().activeViewId;
    actions().createView("Second");
    const out = serializeCenterLayout(s(), [AGENT]);
    expect(out.activeViewId).not.toBe(first);
    const byId = Object.fromEntries(out.views.map((v) => [v.id, entries(v.layout)]));
    expect(byId[first]).toEqual([]);
    expect(byId[out.activeViewId]).toEqual([{ terminalId: AGENT, customTitle: null }]);
  });

  it("nothing held elsewhere — the blob is exactly what it always was", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    expect(serializeCenterLayout(s())).toEqual(serializeCenterLayout(s(), []));
    expect(entries(layoutPrefsBlob(s()).views![0].layout)).toEqual([]);
  });

  it("an uninstall removes only the provider it installed", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    const first = provideHeldElsewhere(() => [AGENT]);
    const second = provideHeldElsewhere(() => [AGENT]);
    first();
    expect(entries(layoutPrefsBlob(s()).views![0].layout)).toHaveLength(1);
    second();
    expect(entries(layoutPrefsBlob(s()).views![0].layout)).toHaveLength(0);
  });

  it("persistLayoutNow saves the blob, parked agents included", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    offs.push(provideHeldElsewhere(() => [AGENT]));
    persistLayoutNow();
    expect(layoutPrefs.saveLayoutPrefs).toHaveBeenCalledTimes(1);
    const saved = layoutPrefs.saveLayoutPrefs.mock.calls[0][0] as ReturnType<typeof layoutPrefsBlob>;
    expect(entries(saved.views![0].layout)).toEqual([{ terminalId: AGENT, customTitle: null }]);
  });
});
