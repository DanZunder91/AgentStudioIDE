/**
 * The hand-off, at the store: a tab DESCRIBED, RELEASED without being closed, sent — and
 * on the other side ADOPTED back into a store (docs/design/tab-tearoff.md).
 *
 * The registries are mocked at their module boundary (their own crossing — the buffer and
 * the PTY — is driven for real in `features/editor/tearoffBuffer.test.tsx` and
 * `features/terminal/abandon.test.ts`); the store is real, and the Tauri IPC is the mock
 * that plays Rust. What this file pins is the CHOREOGRAPHY: nothing is killed by a move, a
 * terminal comes back through the reattach path and never a spawn, an editor's buffer is
 * seeded before its tab exists, a failed send puts the tab back, and every arrival is
 * idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalBarrel = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal", () => terminalBarrel);

const terminalRegistry = vi.hoisted(() => ({ abandon: vi.fn() }));
vi.mock("../../features/terminal/TerminalRegistry", () => terminalRegistry);

const editorRegistry = vi.hoisted(() => ({
  exportEditor: vi.fn(),
  seedEditor: vi.fn(),
  abandon: vi.fn(),
  applyCarriedText: vi.fn(async () => true),
}));
vi.mock("../../features/editor/EditorRegistry", () => editorRegistry);
vi.mock("../../features/editor", () => ({ disposeEditorBuffer: vi.fn() }));

import { useLogStore } from "../../features/logs/logStore";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { leafOfTab, leavesOf, useAppStore, viewTabIds } from "../store";
import { asAgentId, asTabId, type AgentId, type Tab, type TabId, type TabKind } from "../types";
import { TEAROFF_KINDS, type EditorBuffer, type TornTab } from "./contract";
import {
  adoptTornTabs,
  describeAll,
  describeTab,
  drainMail,
  findTabByKey,
  handleMail,
  isOpeningHere,
  isRemoteRename,
  moveTabToMainWindow,
  moveTabToNewWindow,
  moveTabToWindow,
  movesSettled,
  openHere,
  orderedTabIds,
  releaseTab,
  revealTab,
} from "./handoff";

const s = () => useAppStore.getState();
const layout = () => s().layoutActions;
const AGENT = asAgentId("01AGENT");

const BUFFER: EditorBuffer = {
  text: "hello\nunsaved",
  baseline: "hello\n",
  state: '{"doc":"hello\\nunsaved"}',
  stamp: { mtimeMs: 1, size: 6 },
  stale: false,
};

/** A tab record straight into the active pane — for kinds with no open action here. */
function putTab(ref: Tab["ref"], title = "x"): TabId {
  const id = asTabId(`tab-${ref.kind}-${Math.random()}`);
  useAppStore.setState((d) => {
    d.tabs[id] = { id, kind: ref.kind, title, ref };
    const leaf = leavesOf(d.layout)[0];
    leaf.tabIds.push(id);
    leaf.activeTabId = id;
  });
  return id;
}

function addAgent(id: AgentId, customTitle: string | null = null): void {
  s().agentActions.applyFleetSnapshot([wireAgent({ id })]);
  if (customTitle) useAppStore.setState((d) => void (d.agents[id].customTitle = customTitle));
}

const activeTab = () => leafOfTab(s().layout, s().tabs[Object.keys(s().tabs)[0] as TabId]?.id)?.activeTabId;
const warnings = () => useLogStore.getState().entries.filter((e) => e.level === "warn");

let ipc: TauriMock;
beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
  useLogStore.getState().clear();
  editorRegistry.exportEditor.mockReturnValue(BUFFER);
  ipc = installTauriMock();
  ipc.handle("layout_prefs_save", () => null);
  ipc.handle("pin_agent", () => null).handle("unpin_agent", () => null);
});
afterEach(() => ipc.reset());

/* ─────────────────────────────── describing ─────────────────────────────── */

describe("describeTab", () => {
  it("describes a plain terminal by its PTY, with its custom name", () => {
    const id = layout().openTerminalTab({ cwd: "/w/gazelle" });
    layout().renameTab(id, "build");
    const ref = s().tabs[id].ref as { terminalId: string };
    expect(describeTab(id)).toEqual({
      kind: "terminal",
      terminalId: ref.terminalId,
      title: "gazelle",
      customTitle: "build",
    });
  });

  it("takes an agent tab's name from the AGENT, falling back to the tab's parked one", () => {
    addAgent(AGENT, "reviewer");
    const id = layout().openTerminalTab({ cwd: "/w/gazelle", agentId: AGENT, runtime: "claude-code" });
    expect(describeTab(id)).toEqual({
      kind: "agent-terminal",
      terminalId: AGENT,
      agentId: AGENT,
      title: "gazelle",
      customTitle: "reviewer",
    });
    useAppStore.setState((d) => {
      delete d.agents[AGENT];
      d.tabs[id].customTitle = "parked";
    });
    expect(describeTab(id)).toMatchObject({ customTitle: "parked" });
    useAppStore.setState((d) => void (d.tabs[id].customTitle = null));
    expect(describeTab(id)).toMatchObject({ customTitle: null });
  });

  it("carries an editor's buffer, asking for the undo stack only when told to", () => {
    const id = layout().openEditorTab("/w/a.ts");
    expect(describeTab(id)).toEqual({
      kind: "editor",
      path: "/w/a.ts",
      title: "a.ts",
      customTitle: null,
      buffer: BUFFER,
    });
    expect(editorRegistry.exportEditor).toHaveBeenLastCalledWith("/w/a.ts", { history: true });
    describeTab(id, { history: false });
    expect(editorRegistry.exportEditor).toHaveBeenLastCalledWith("/w/a.ts", { history: false });
  });

  it("describes the cheap kinds by what re-creates them", () => {
    expect(describeTab(layout().openDiffTab("/w/a.ts"))).toEqual({
      kind: "diff",
      path: "/w/a.ts",
      title: "a.ts ↔ HEAD",
    });
    expect(describeTab(layout().openMetricsTab("/w"))).toEqual({ kind: "metrics", cwd: "/w" });
    expect(describeTab(layout().openAgentLogsTab())).toEqual({ kind: "agent-logs" });
    expect(describeTab(layout().openNetworkTab())).toEqual({ kind: "network" });
    expect(describeTab(layout().openVillageTab())).toEqual({ kind: "village" });
  });

  it("refuses the kinds a move would break, and an unknown id", () => {
    expect(describeTab(putTab({ kind: "api-request", requestId: "r1" }))).toBeNull();
    expect(describeTab(asTabId("nope"))).toBeNull();
  });

  it("agrees with TEAROFF_KINDS about every kind — the menu and the move cannot drift", () => {
    const refs: Record<TabKind, Tab["ref"]> = {
      terminal: { kind: "terminal", terminalId: "T" as never },
      "agent-terminal": { kind: "agent-terminal", terminalId: "A" as never, agentId: "A" as never },
      editor: { kind: "editor", path: "/w/p" },
      diff: { kind: "diff", path: "/w/p" },
      metrics: { kind: "metrics", cwd: null },
      "agent-logs": { kind: "agent-logs" },
      network: { kind: "network" },
      village: { kind: "village" },
      "api-request": { kind: "api-request", requestId: "r" },
      sequence: { kind: "sequence", sequenceId: "q" },
      "db-console": { kind: "db-console", connectionId: "c" },
      "session-picker": { kind: "session-picker", cwd: "/w" },
      "agent-activity": { kind: "agent-activity", agentId: "A" as never },
    };
    for (const [kind, ref] of Object.entries(refs)) {
      expect(describeTab(putTab(ref)) !== null, kind).toBe(TEAROFF_KINDS.has(kind as TabKind));
    }
  });
});

describe("describeAll / orderedTabIds", () => {
  it("lists every movable tab in on-screen order, across views", () => {
    const a = layout().openTerminalTab({ cwd: "/w/a" });
    putTab({ kind: "api-request", requestId: "r1" });
    const view2 = layout().createView();
    const b = layout().openEditorTab("/w/b.ts");
    expect(orderedTabIds()).toHaveLength(3);
    expect(orderedTabIds()[2]).toBe(b);
    expect(viewTabIds(s(), view2)).toEqual([b]);
    const all = describeAll({ history: false });
    expect(all.map((t) => t.kind)).toEqual(["terminal", "editor"]);
    expect(all[0]).toMatchObject({ terminalId: (s().tabs[a].ref as { terminalId: string }).terminalId });
  });
});

/* ─────────────────────────────── releasing ──────────────────────────────── */

describe("releaseTab", () => {
  it("lets a terminal go WITHOUT killing it, and leaves its agent in the fleet", () => {
    addAgent(AGENT);
    const id = layout().openTerminalTab({ cwd: "/w/gazelle", agentId: AGENT, runtime: "claude-code" });
    const torn = describeTab(id) as TornTab;
    releaseTab(id, torn);

    expect(s().tabs[id]).toBeUndefined();
    expect(leavesOf(s().layout).flatMap((l) => l.tabIds)).toEqual([]);
    expect(terminalRegistry.abandon).toHaveBeenCalledWith(AGENT);
    // Two-sided: the PTY-killing path never ran, and the agent is still in the rail.
    expect(terminalBarrel.dispose).not.toHaveBeenCalled();
    expect(s().agents[AGENT]).toBeDefined();
  });

  it("drops an editor's buffer here (the other window is the only writer now)", () => {
    const id = layout().openEditorTab("/w/a.ts");
    s().editorActions.initEditor("/w/a.ts"); // the UI slice the store keeps for the buffer
    releaseTab(id, describeTab(id) as TornTab);
    expect(editorRegistry.abandon).toHaveBeenCalledWith("/w/a.ts");
    expect(s().editors["/w/a.ts"]).toBeUndefined();
    expect(terminalRegistry.abandon).not.toHaveBeenCalled();
  });

  it("tears nothing down for a kind with no registry behind it", () => {
    const id = layout().openVillageTab();
    releaseTab(id, describeTab(id) as TornTab);
    expect(s().tabs[id]).toBeUndefined();
    expect(terminalRegistry.abandon).not.toHaveBeenCalled();
    expect(editorRegistry.abandon).not.toHaveBeenCalled();
  });
});

/* ──────────────────────────────── arriving ──────────────────────────────── */

describe("adoptTornTabs", () => {
  it("brings a terminal back through the REATTACH path — never a spawn — and shows it", () => {
    layout().openTerminalTab({ cwd: "/w/other" }); // something already active here
    const [id] = adoptTornTabs([{ kind: "terminal", terminalId: "T9", title: "gazelle", customTitle: null }]);

    expect(terminalBarrel.configureTerminal).toHaveBeenCalledWith("T9", { reattach: true });
    expect(s().tabs[id]).toMatchObject({ kind: "terminal", ref: { kind: "terminal", terminalId: "T9" } });
    expect(leafOfTab(s().layout, id)?.activeTabId).toBe(id);
  });

  it("carries a plain tab's custom name", () => {
    const [id] = adoptTornTabs([{ kind: "terminal", terminalId: "T9", title: "gazelle", customTitle: "build" }]);
    expect(s().tabs[id].customTitle).toBe("build");
  });

  it("puts an agent's name back on the AGENT when the fleet has it", () => {
    addAgent(AGENT, "old name");
    const [id] = adoptTornTabs([
      { kind: "agent-terminal", terminalId: AGENT, agentId: AGENT, title: "gazelle", customTitle: "reviewer" },
    ]);
    expect(terminalBarrel.configureTerminal).toHaveBeenCalledWith(AGENT, { reattach: true, agentId: AGENT });
    expect(s().tabs[id].ref).toEqual({ kind: "agent-terminal", terminalId: AGENT, agentId: AGENT });
    expect(s().agents[AGENT].customTitle).toBe("reviewer");
  });

  it("clears an agent's name the other window cleared, and leaves an equal one alone", () => {
    addAgent(AGENT, "reviewer");
    const agentTab = (customTitle: string | null): TornTab => ({
      kind: "agent-terminal",
      terminalId: AGENT,
      agentId: AGENT,
      title: "g",
      customTitle,
    });
    const saves = () => ipc.calls("layout_prefs_save").length;
    const goAway = () => layout().releaseTab(findTabByKey(s().tabs, `terminal:${AGENT}`) as TabId);

    // An equal name is not a rename: no extra persist beyond the adoption's own.
    let before = saves();
    adoptTornTabs([agentTab("reviewer")]);
    const adoptionOnly = saves() - before;
    goAway();
    // A different name IS one — exactly one more write (renameAgent persists the layout).
    before = saves();
    adoptTornTabs([agentTab("renamed")]);
    expect(saves() - before).toBe(adoptionOnly + 1);
    expect(s().agents[AGENT].customTitle).toBe("renamed");
    goAway();
    adoptTornTabs([agentTab(null)]);
    expect(s().agents[AGENT].customTitle).toBeNull();
  });

  it("names an agent that had no custom name yet", () => {
    addAgent(AGENT); // never renamed: no customTitle on the record at all
    adoptTornTabs([
      { kind: "agent-terminal", terminalId: AGENT, agentId: AGENT, title: "gazelle", customTitle: "reviewer" },
    ]);
    expect(s().agents[AGENT].customTitle).toBe("reviewer");
  });

  it("parks an agent's name on the tab when the fleet has not delivered the agent yet", () => {
    const [id] = adoptTornTabs([
      { kind: "agent-terminal", terminalId: AGENT, agentId: AGENT, title: "gazelle", customTitle: "reviewer" },
    ]);
    // The strip shows `tab.title` for an agent with no row; the next move re-reads it.
    expect(s().tabs[id]).toMatchObject({ title: "reviewer", customTitle: "reviewer" });
    expect(describeTab(id)).toMatchObject({ customTitle: "reviewer" });
    // …and an unnamed agent tab is left as it came.
    const [other] = adoptTornTabs([
      { kind: "agent-terminal", terminalId: "A2", agentId: "A2", title: "gazelle", customTitle: null },
    ]);
    expect(s().tabs[other]).toMatchObject({ title: "gazelle" });
  });

  it("seeds an editor's buffer BEFORE its tab exists, then marks it dirty", () => {
    let tabExistedAtSeed = true;
    editorRegistry.seedEditor.mockImplementation((path: string) => {
      tabExistedAtSeed = findTabByKey(s().tabs, `editor:${path}`) !== null;
    });
    const [id] = adoptTornTabs([
      { kind: "editor", path: "/w/a.ts", title: "a.ts", customTitle: "notes", buffer: BUFFER },
    ]);
    expect(editorRegistry.seedEditor).toHaveBeenCalledWith("/w/a.ts", BUFFER);
    // Seeded first, or the CodeEditor that mounts would read the file and drop the edits.
    expect(tabExistedAtSeed).toBe(false);
    expect(s().tabs[id]).toMatchObject({ kind: "editor", dirty: true, customTitle: "notes" });
  });

  it("an editor whose buffer matches its baseline is clean; one with no buffer reads the file", () => {
    const [clean] = adoptTornTabs([
      { kind: "editor", path: "/w/a.ts", title: "a.ts", customTitle: null, buffer: { ...BUFFER, text: BUFFER.baseline } },
    ]);
    expect(s().tabs[clean].dirty).toBe(false);
    const [loading] = adoptTornTabs([{ kind: "editor", path: "/w/b.ts", title: "b.ts", customTitle: null, buffer: null }]);
    expect(editorRegistry.seedEditor).toHaveBeenCalledTimes(1);
    expect(s().tabs[loading].dirty).toBeFalsy();
  });

  it("re-opens the cheap kinds through their own open actions", () => {
    const ids = adoptTornTabs([
      { kind: "diff", path: "/w/a.ts", title: "a.ts ↔ HEAD" },
      { kind: "metrics", cwd: "/w" },
      { kind: "agent-logs" },
      { kind: "network" },
      { kind: "village" },
    ]);
    expect(ids.map((id) => s().tabs[id].ref)).toEqual([
      { kind: "diff", path: "/w/a.ts" },
      { kind: "metrics", cwd: "/w" },
      { kind: "agent-logs" },
      { kind: "network" },
      { kind: "village" },
    ]);
    // The last one is the one the user just moved: it is in front.
    expect(leafOfTab(s().layout, ids[4])?.activeTabId).toBe(ids[4]);
  });

  it("is idempotent by key — a tab already here is not adopted twice", () => {
    const torn: TornTab = { kind: "terminal", terminalId: "T9", title: "gazelle", customTitle: null };
    const [first] = adoptTornTabs([torn]);
    const [second] = adoptTornTabs([torn, torn]);
    expect(second).toBe(first);
    expect(Object.keys(s().tabs)).toHaveLength(1);
  });

  it("survives the IPC boundary: describe → JSON → adopt gives the same tab back", () => {
    addAgent(AGENT, "reviewer");
    const id = layout().openTerminalTab({ cwd: "/w/gazelle", agentId: AGENT, runtime: "claude-code" });
    const wire = JSON.parse(JSON.stringify(describeTab(id))) as TornTab;
    releaseTab(id, describeTab(id) as TornTab);
    expect(s().tabs[id]).toBeUndefined();
    const [back] = adoptTornTabs([wire]);
    expect(s().tabs[back].ref).toEqual({ kind: "agent-terminal", terminalId: AGENT, agentId: AGENT });
    expect(s().agents[AGENT].customTitle).toBe("reviewer");
  });
});

describe("an editor arriving where its file is already open", () => {
  // One path is one tab here, so an arriving editor folds into the one already open — and
  // the arriving buffer may be the ONLY copy of some unsaved edits (review finding: it used
  // to be dropped on the floor by the idempotency check, silently).
  const PATH = "/w/a.ts";
  const arriving = (buffer: EditorBuffer | null): TornTab => ({
    kind: "editor",
    path: PATH,
    title: "a.ts",
    customTitle: null,
    buffer,
  });
  const here = (text: string, baseline = "hello\n"): EditorBuffer => ({ ...BUFFER, text, baseline, state: null });

  it("applies the arriving unsaved text to the tab here when the tab here is clean", () => {
    const id = layout().openEditorTab(PATH);
    editorRegistry.exportEditor.mockReturnValue(here("hello\n"));
    expect(adoptTornTabs([arriving(BUFFER)])).toEqual([id]);
    expect(editorRegistry.applyCarriedText).toHaveBeenCalledWith(PATH, BUFFER.text);
    expect(editorRegistry.seedEditor, "never a second buffer for the path").not.toHaveBeenCalled();
    expect(Object.keys(s().tabs)).toHaveLength(1);
    expect(warnings()).toHaveLength(0);
  });

  it("applies it to a tab here that is still loading (nothing here to lose)", () => {
    layout().openEditorTab(PATH);
    editorRegistry.exportEditor.mockReturnValue(null);
    adoptTornTabs([arriving(BUFFER)]);
    expect(editorRegistry.applyCarriedText).toHaveBeenCalledWith(PATH, BUFFER.text);
    expect(warnings()).toHaveLength(0);
  });

  it("two unsaved copies: the arriving one is shown, and the log says undo has the other", () => {
    layout().openEditorTab(PATH);
    editorRegistry.exportEditor.mockReturnValue(here("hello\nlocal edits"));
    adoptTornTabs([arriving(BUFFER)]);
    expect(editorRegistry.applyCarriedText).toHaveBeenCalledWith(PATH, BUFFER.text);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain(PATH);
  });

  it("leaves the tab here alone when nothing unsaved arrived, or the same text is already here", () => {
    layout().openEditorTab(PATH);
    editorRegistry.exportEditor.mockReturnValue(here("hello\nlocal edits"));
    adoptTornTabs([arriving(null)]); // still loading over there
    adoptTornTabs([arriving({ ...BUFFER, text: "saved", baseline: "saved" })]); // clean
    editorRegistry.exportEditor.mockReturnValue(here(BUFFER.text));
    adoptTornTabs([arriving(BUFFER)]); // identical
    expect(editorRegistry.applyCarriedText).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(0);
  });
});

describe("openHere", () => {
  it("is set while it runs (adoption included), and unwinds even on a throw", () => {
    expect(isOpeningHere()).toBe(false);
    expect(openHere(() => isOpeningHere())).toBe(true);
    expect(() =>
      openHere(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(isOpeningHere()).toBe(false);
    let during = false;
    const off = useAppStore.subscribe(
      (st) => st.tabs,
      () => (during = isOpeningHere()),
    );
    adoptTornTabs([{ kind: "village" }]);
    off();
    expect(during, "an arriving tab is opened HERE, whatever the router thinks").toBe(true);
  });
});

describe("revealTab", () => {
  it("switches to the view holding the tab and makes it active", () => {
    const first = s().activeViewId;
    const hidden = layout().openTerminalTab({ cwd: "/w/a" });
    layout().createView();
    expect(s().activeViewId).not.toBe(first);
    revealTab(hidden);
    expect(s().activeViewId).toBe(first);
    expect(leafOfTab(s().layout, hidden)?.activeTabId).toBe(hidden);
    expect(s().focusedPaneId).toBe(leafOfTab(s().layout, hidden)?.id);
  });

  it("is a no-op for a tab this window does not hold", () => {
    const before = s().layout;
    revealTab(asTabId("nope"));
    expect(s().layout).toBe(before);
  });
});

/* ───────────────────────────────── moving ───────────────────────────────── */

describe("moveTabToNewWindow", () => {
  it("releases the tab, then asks Rust for a window with it — at the drop point", async () => {
    const id = layout().openTerminalTab({ cwd: "/w/gazelle" });
    const torn = describeTab(id);
    ipc.handle("tearoff_open", () => "tearoff-1");
    await expect(moveTabToNewWindow(id, { x: 900, y: 300 })).resolves.toBe(true);
    expect(ipc.lastCall("tearoff_open")).toEqual({ tabs: [torn], at: { x: 900, y: 300 } });
    expect(s().tabs[id]).toBeUndefined();
    expect(terminalBarrel.dispose).not.toHaveBeenCalled();
  });

  it("without a drop point, lets the OS place the window", async () => {
    const id = layout().openVillageTab();
    ipc.handle("tearoff_open", () => "tearoff-1");
    await moveTabToNewWindow(id);
    expect(ipc.lastCall("tearoff_open")?.at).toBeNull();
  });

  it("takes the tab back if the window cannot open, and says why", async () => {
    const id = layout().openTerminalTab({ cwd: "/w/gazelle" });
    const terminalId = (s().tabs[id].ref as { terminalId: string }).terminalId;
    ipc.handle("tearoff_open", () => {
      throw new Error("no display");
    });
    await expect(moveTabToNewWindow(id)).resolves.toBe(false);
    // Back, through the reattach path (its own view of the PTY was abandoned).
    const back = findTabByKey(s().tabs, `terminal:${terminalId}`);
    expect(back).not.toBeNull();
    expect(terminalBarrel.configureTerminal).toHaveBeenLastCalledWith(terminalId, { reattach: true });
    expect(warnings().map((w) => w.message)).toEqual(["Could not open a new window — the tab stayed here"]);
    expect(warnings()[0].detail).toContain("no display");
  });

  it("does nothing for a tab that cannot move", async () => {
    const id = putTab({ kind: "db-console", connectionId: "c1" });
    await expect(moveTabToNewWindow(id)).resolves.toBe(false);
    expect(s().tabs[id]).toBeDefined();
    expect(ipc.calls("tearoff_open")).toHaveLength(0);
  });
});

describe("moveTabToWindow / moveTabToMainWindow", () => {
  it("posts the tab to the main window", async () => {
    const id = layout().openEditorTab("/w/a.ts");
    ipc.handle("tearoff_send", () => null);
    await expect(moveTabToMainWindow(id)).resolves.toBe(true);
    expect(ipc.lastCall("tearoff_send")).toEqual({
      to: "main",
      mail: { t: "adopt", tabs: [{ kind: "editor", path: "/w/a.ts", title: "a.ts", customTitle: null, buffer: BUFFER }] },
    });
    expect(s().tabs[id]).toBeUndefined();
  });

  it("takes the tab back when the other window is gone", async () => {
    const id = layout().openNetworkTab();
    ipc.handle("tearoff_send", () => {
      throw new Error("no window tearoff-4");
    });
    await expect(moveTabToWindow(id, "tearoff-4")).resolves.toBe(false);
    expect(findTabByKey(s().tabs, "network")).not.toBeNull();
    expect(warnings()[0].message).toBe("Could not move the tab to tearoff-4 — it stayed here");
  });

  it("does nothing for an unknown tab", async () => {
    await expect(moveTabToWindow(asTabId("nope"), "main")).resolves.toBe(false);
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });
});

describe("movesSettled", () => {
  it("waits for a move in flight, whichever way it ends", async () => {
    let release!: () => void;
    ipc.handle("tearoff_open", () => new Promise<string>((resolve) => (release = () => resolve("tearoff-1"))));
    const id = layout().openVillageTab();
    const move = moveTabToNewWindow(id);
    let settled = false;
    const waiting = movesSettled().then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await move;
    await waiting;
    expect(settled).toBe(true);
    // And with nothing in flight it resolves at once.
    await expect(movesSettled()).resolves.toBeUndefined();
  });
});

/* ────────────────────────────────── mail ────────────────────────────────── */

describe("handleMail", () => {
  it("adopt: rehydrates the tabs", () => {
    handleMail({ t: "adopt", tabs: [{ kind: "village" }] });
    expect(findTabByKey(s().tabs, "village")).not.toBeNull();
  });

  it("focus: brings the tab with that key to the front, across views", () => {
    const first = s().activeViewId;
    layout().openVillageTab();
    layout().createView();
    handleMail({ t: "focus", key: "village" });
    expect(s().activeViewId).toBe(first);
    // An unknown key is ignored.
    handleMail({ t: "focus", key: "terminal:ghost" });
  });

  it("close: closes the tab for good, with the primitive — the sender already confirmed", () => {
    addAgent(AGENT);
    layout().openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    handleMail({ t: "close", key: `terminal:${AGENT}` });
    expect(findTabByKey(s().tabs, `terminal:${AGENT}`)).toBeNull();
    expect(terminalBarrel.dispose).toHaveBeenCalledWith(AGENT);
    expect(s().pendingTerminalClose).toBeNull(); // no "are you sure?" raised here
    handleMail({ t: "close", key: "terminal:ghost" });
    expect(terminalBarrel.dispose).toHaveBeenCalledTimes(1);
  });

  it("dismissed: the agent leaves the fleet rail here too", () => {
    addAgent(AGENT);
    handleMail({ t: "dismissed", agentId: AGENT });
    expect(s().agents[AGENT]).toBeUndefined();
    expect(s().dismissedAgentIds).toContain(AGENT);
  });

  it("give: one of our tabs, dropped on another window, moves there", async () => {
    const id = layout().openVillageTab();
    ipc.handle("tearoff_send", () => null);
    handleMail({ t: "give", tabId: id, to: "tearoff-2" });
    await movesSettled();
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "tearoff-2", mail: { t: "adopt", tabs: [{ kind: "village" }] } });
    expect(s().tabs[id]).toBeUndefined();
  });
});

describe("handleMail: renamed", () => {
  it("names the agent here, flagged as a remote rename while it happens", () => {
    addAgent(AGENT);
    let remote = false;
    const off = useAppStore.subscribe(
      (st) => st.agents,
      () => (remote = isRemoteRename()),
    );
    handleMail({ t: "renamed", agentId: AGENT, name: "reviewer" });
    off();
    expect(s().agents[AGENT].customTitle).toBe("reviewer");
    expect(remote).toBe(true);
    expect(isRemoteRename()).toBe(false);
    handleMail({ t: "renamed", agentId: AGENT, name: null });
    expect(s().agents[AGENT].customTitle).toBeNull();
  });

  it("ignores an agent this window does not know", () => {
    handleMail({ t: "renamed", agentId: "nobody", name: "x" });
    expect(s().agents).toEqual({});
  });
});

describe("drainMail", () => {
  it("on boot, recovers the held tabs AND processes the mail — without doubling a tab", async () => {
    const term: TornTab = { kind: "terminal", terminalId: "T1", title: "sh", customTitle: null };
    ipc.handle("tearoff_claim", () => ({ tabs: [term], mail: [{ t: "adopt", tabs: [term, { kind: "village" }] }] }));
    await drainMail(true);
    expect(Object.values(s().tabs).map((t) => t.ref.kind).sort()).toEqual(["terminal", "village"]);
  });

  it("on a doorbell, ignores the held tabs — a tab closed a moment ago must not come back", async () => {
    const term: TornTab = { kind: "terminal", terminalId: "T1", title: "sh", customTitle: null };
    ipc.handle("tearoff_claim", () => ({ tabs: [term], mail: [] }));
    await drainMail(false);
    expect(Object.keys(s().tabs)).toHaveLength(0);
  });

  it("logs a claim that failed instead of throwing", async () => {
    ipc.handle("tearoff_claim", () => {
      throw new Error("gone");
    });
    await expect(drainMail(true)).resolves.toBeUndefined();
    expect(warnings()[0].message).toBe("Could not collect this window's tabs");
  });

  it("does not touch the active tab of an empty claim", async () => {
    layout().openVillageTab();
    const before = activeTab();
    ipc.handle("tearoff_claim", () => ({ tabs: [], mail: [] }));
    await drainMail(true);
    expect(activeTab()).toBe(before);
  });
});
