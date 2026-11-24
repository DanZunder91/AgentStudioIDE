/**
 * `releaseTab` — taking a tab out of this window WITHOUT closing it (tab tear-off) — and
 * `onAgentSelected`, the gesture hook tear-off forwards rail clicks through.
 *
 * `releaseTab` must do to the LAYOUT exactly what `closeTab` does (one emptiness rule, one
 * focus repair, inactive views swept) and to the THING nothing at all: no dispose, no buffer
 * disposal, no agent dismissal, no unpin. Both halves are asserted, because a release that
 * quietly closed would kill the agent the user was only moving.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

const editor = vi.hoisted(() => ({ disposeEditorBuffer: vi.fn() }));
vi.mock("../features/editor", () => editor);

const layoutPrefs = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefs);

const fleetIpc = vi.hoisted(() => ({
  ensureAgentHooks: vi.fn(),
  pushRecentProject: vi.fn(),
  pinAgent: vi.fn(async () => undefined),
  unpinAgent: vi.fn(async () => undefined),
}));
vi.mock("../features/fleet/fleetIpc", () => fleetIpc);

import { resetFleetStore, wireAgent } from "../test/fleet-harness";
import { assertLiveStoreInvariants, resetStore } from "../test/store-harness";
import { leafOfTab, leavesOf, onAgentSelected, useAppStore, viewTabIds } from "./store";
import { asAgentId, asTabId } from "./types";

const s = () => useAppStore.getState();
const actions = () => s().layoutActions;
const AGENT = asAgentId("01AGENT");

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
});

describe("releaseTab", () => {
  it("removes the tab from the window and nothing else — the PTY and the agent live on", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    useAppStore.setState((d) => void (d.agents[AGENT].pinned = true));
    const id = actions().openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    actions().releaseTab(id);

    expect(s().tabs[id]).toBeUndefined();
    expect(leavesOf(s().layout).flatMap((l) => l.tabIds)).toEqual([]);
    // What closeTab would have done, and release must not:
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(s().agents[AGENT]).toBeDefined();
    expect(s().agents[AGENT].pinned).toBe(true);
    expect(fleetIpc.unpinAgent).not.toHaveBeenCalled();
    expect(s().dismissedAgentIds).not.toContain(AGENT);
  });

  it("prunes the pane it emptied and repairs focus, like closeTab", () => {
    const root = leavesOf(s().layout)[0].id;
    actions().openTerminalTab({ paneId: root, cwd: "/w/a" });
    const right = actions().splitPane(root, "row");
    const moving = actions().openTerminalTab({ paneId: right, cwd: "/w/b" });
    expect(leavesOf(s().layout)).toHaveLength(2);

    actions().releaseTab(moving);
    expect(leavesOf(s().layout)).toHaveLength(1);
    expect(s().focusedPaneId).toBe(leavesOf(s().layout)[0].id);
    assertLiveStoreInvariants("after releaseTab");
  });

  it("drops an editor's UI slice here but never disposes the buffer itself", () => {
    const id = actions().openEditorTab("/w/a.ts");
    s().editorActions.initEditor("/w/a.ts");
    actions().releaseTab(id);
    expect(s().editors["/w/a.ts"]).toBeUndefined();
    expect(editor.disposeEditorBuffer).not.toHaveBeenCalled();
  });

  it("reaches a tab in a view that is not on screen", () => {
    const hidden = actions().openTerminalTab({ cwd: "/w/a" });
    const firstView = s().activeViewId;
    actions().createView();
    actions().releaseTab(hidden);
    expect(s().tabs[hidden]).toBeUndefined();
    expect(viewTabIds(s(), firstView)).toEqual([]);
  });

  it("clears a confirm that was about this tab — and leaves one about another alone", () => {
    const a = actions().openTerminalTab({ cwd: "/w/a" });
    const b = actions().openTerminalTab({ cwd: "/w/b" });
    const c = actions().openEditorTab("/w/c.ts");
    useAppStore.setState((d) => {
      d.confirmCloseTab = c;
      d.pendingTerminalClose = { scope: { kind: "tab", tabId: a }, terminals: [] };
    });
    actions().releaseTab(b);
    expect(s().confirmCloseTab).toBe(c);
    expect(s().pendingTerminalClose?.scope).toEqual({ kind: "tab", tabId: a });

    actions().releaseTab(a);
    expect(s().pendingTerminalClose).toBeNull();
    actions().releaseTab(c);
    expect(s().confirmCloseTab).toBeNull();
  });

  it("leaves a pending close of a whole PANE alone", () => {
    const a = actions().openTerminalTab({ cwd: "/w/a" });
    actions().openTerminalTab({ cwd: "/w/b" });
    const pane = leafOfTab(s().layout, a)!.id;
    useAppStore.setState((d) => void (d.pendingTerminalClose = { scope: { kind: "pane", paneId: pane }, terminals: [] }));
    actions().releaseTab(a);
    expect(s().pendingTerminalClose?.scope).toEqual({ kind: "pane", paneId: pane });
  });

  it("persists the new layout — the moved tab must not come back here on a restart", () => {
    const id = actions().openTerminalTab({ cwd: "/w/a" });
    layoutPrefs.saveLayoutPrefs.mockClear();
    actions().releaseTab(id);
    expect(layoutPrefs.saveLayoutPrefs).toHaveBeenCalledTimes(1);
    const blob = layoutPrefs.saveLayoutPrefs.mock.calls[0][0] as { views: { layout: unknown }[] };
    expect(JSON.stringify(blob.views)).not.toContain(id);
  });

  it("is a no-op for an unknown tab — nothing written", () => {
    actions().openTerminalTab({ cwd: "/w/a" });
    layoutPrefs.saveLayoutPrefs.mockClear();
    const before = s().layout;
    actions().releaseTab(asTabId("nope"));
    expect(s().layout).toBe(before);
    expect(layoutPrefs.saveLayoutPrefs).not.toHaveBeenCalled();
  });
});

describe("onAgentSelected", () => {
  it("runs after every selectAgent — the gesture — with the agent's id", () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    const hook = vi.fn();
    const off = onAgentSelected(hook);
    s().agentActions.selectAgent(AGENT);
    s().agentActions.selectAgent(AGENT); // re-clicking still asks
    expect(hook.mock.calls).toEqual([[AGENT], [AGENT]]);
    off();
    s().agentActions.selectAgent(AGENT);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("does NOT run when a removal re-points the selection — nobody asked for anything", () => {
    const other = asAgentId("02OTHER");
    s().agentActions.applyFleetSnapshot([wireAgent({ id: other }), wireAgent({ id: AGENT })]);
    s().agentActions.selectAgent(AGENT);
    const hook = vi.fn();
    const off = onAgentSelected(hook);
    s().agentActions.removeAgent(AGENT); // the selection falls to `other`
    expect(s().selection.selectedAgentId).toBe(other);
    expect(hook).not.toHaveBeenCalled();
    off();
  });
});
