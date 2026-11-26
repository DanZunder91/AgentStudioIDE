/** Tear-off wiring per window (main host forwarding; detached boot, report, hand-back, close).
 * The event plane is mocked so the test can BE Rust; the store is real, registries mocked. */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => {
  type Handler = (e: { payload: unknown }) => void;
  const handlers = new Map<string, { handler: Handler; options?: unknown }[]>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: Handler, options?: unknown) => {
      const list = handlers.get(name) ?? [];
      list.push({ handler, options });
      handlers.set(name, list);
      return () => undefined;
    }),
    /** Deliver an event the way Rust would, to every listener of `name`. */
    emit(name: string, payload: unknown) {
      for (const { handler } of handlers.get(name) ?? []) handler({ payload });
    },
    optionsOf(name: string) {
      return (handlers.get(name) ?? []).map((h) => h.options);
    },
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen }));

const terminalBarrel = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal", () => terminalBarrel);

const terminalRegistry = vi.hoisted(() => ({
  abandon: vi.fn(),
  setRemoteDisposer: vi.fn(),
  noteAgentExited: vi.fn(),
}));
vi.mock("../../features/terminal/TerminalRegistry", () => terminalRegistry);

const editorRegistry = vi.hoisted(() => {
  const listeners = new Set<(path: string) => void>();
  return {
    listeners,
    exportEditor: vi.fn(() => null),
    seedEditor: vi.fn(),
    abandon: vi.fn(),
    onEditorEdit: vi.fn((l: (path: string) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    }),
  };
});
vi.mock("../../features/editor/EditorRegistry", () => editorRegistry);
vi.mock("../../features/editor", () => ({ disposeEditorBuffer: vi.fn() }));

const fleet = vi.hoisted(() => ({
  fleetSnapshot: vi.fn(),
  defaultWorkspace: vi.fn(),
  recentProjects: vi.fn(async () => []),
  ensureAgentHooks: vi.fn(async () => undefined),
  pushRecentProject: vi.fn(async () => undefined),
  pinnedAgents: vi.fn(async () => []),
  pinAgent: vi.fn(async () => undefined),
  unpinAgent: vi.fn(async () => undefined),
}));
vi.mock("../../features/fleet/fleetIpc", () => fleet);

import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { TAB_ELSEWHERE, useAppStore } from "../store";
import { asAgentId, type AgentEvent, type TabId } from "../types";
import {
  closeIfEmpty,
  disposeRemote,
  forwardSelection,
  handBackAndClose,
  heldTerminals,
  holderOf,
  renamedAgents,
  REPORT_DEBOUNCE_MS,
  reportNow,
  routeOpen,
  scheduleReport,
  setHoldings,
  startTearoffHost,
  startTearoffWindow,
  syncHoldings,
  watchDetachedWindow,
  windowShowing,
} from "./boot";
import type { TornTab } from "./contract";
import { findTabByKey, handleMail, moveTabToMainWindow, openHere } from "./handoff";
import { CLOSING_EVENT, HOLDINGS_EVENT, MAIL_EVENT } from "./ipc";

const s = () => useAppStore.getState();
const AGENT = asAgentId("01AGENT");
const VILLAGE: TornTab = { kind: "village" };

function asWindow(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__: { metadata?: unknown } }).__TAURI_INTERNALS__.metadata = {
    currentWindow: { label },
  };
}

/** Let promise chains (listen → claim → adopt) run to completion. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

let ipc: TauriMock;
let claims: Array<{ tabs: TornTab[]; mail: unknown[] }>;
/** Every watcher a test starts — stopped after it, or it fires into the next test. */
const stops: Array<() => void> = [];
const watch = () => void stops.push(watchDetachedWindow());
const boot = async () => void stops.push(await startTearoffWindow());
const host = async () => void stops.push(await startTearoffHost());
const sends = (t: string) =>
  ipc.calls("tearoff_send").map((c) => c.args).filter((a) => (a.mail as { t: string }).t === t);

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
  events.handlers.clear();
  editorRegistry.listeners.clear();
  setHoldings([]);
  claims = [];
  fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [] });
  fleet.defaultWorkspace.mockResolvedValue("/Users/me/gazelle");
  ipc = installTauriMock();
  ipc
    .handle("layout_prefs_save", () => null)
    .handle("tearoff_holdings", () => [])
    .handle("tearoff_claim", () => claims.shift() ?? { tabs: [], mail: [] })
    .handle("tearoff_report", () => null)
    .handle("tearoff_send", () => null)
    .handle("tearoff_close", () => null);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  ipc.reset();
});

/* ─────────────────────────────── holdings ─────────────────────────────── */

describe("holdings cache", () => {
  it("answers who holds a key, and forgets on the next broadcast", () => {
    setHoldings([{ label: "tearoff-1", keys: ["terminal:T1", "village"] }]);
    expect(holderOf("terminal:T1")).toBe("tearoff-1");
    expect(holderOf("village")).toBe("tearoff-1");
    expect(holderOf("terminal:T2")).toBeNull();
    setHoldings([]);
    expect(holderOf("terminal:T1")).toBeNull();
  });
});

describe("windowShowing / forwardSelection", () => {
  it("in the main window: a detached holder is brought forward; a local or unheld agent is not", async () => {
    setHoldings([{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    expect(windowShowing(AGENT)).toBe("tearoff-1");
    forwardSelection(AGENT);
    await flush();
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "tearoff-1", mail: { t: "focus", key: `terminal:${AGENT}` } });

    expect(windowShowing(asAgentId("unheld"))).toBeNull();
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().layoutActions.openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    expect(windowShowing(AGENT), "its tab is right here").toBeNull();
  });

  it("in a detached window: an agent nobody detached holds is in the MAIN window", () => {
    asWindow("tearoff-2");
    expect(windowShowing(AGENT)).toBe("main");
    setHoldings([{ label: "tearoff-5", keys: [`terminal:${AGENT}`] }]);
    expect(windowShowing(AGENT)).toBe("tearoff-5");
    // Rust's ledger can name THIS window before its own store has the tab — no self-mail.
    setHoldings([{ label: "tearoff-2", keys: [`terminal:${AGENT}`] }]);
    expect(windowShowing(AGENT)).toBeNull();
  });

  it("a sub-agent never brings another window forward — its activity tab opened HERE", async () => {
    // Review finding: from a detached window (the Village lists sub-agents), the click
    // opened the activity tab locally and then raised the MAIN window over it.
    const SUB = asAgentId("01SUB");
    asWindow("tearoff-2");
    s().agentActions.applyFleetSnapshot([
      wireAgent({ id: AGENT }),
      wireAgent({ id: SUB, parentId: AGENT, kind: "subagent" }),
    ]);
    stops.push(await startTearoffWindow());
    s().agentActions.selectAgent(SUB);
    await flush();
    expect(windowShowing(SUB)).toBeNull();
    expect(sends("focus"), "nothing raised over the tab just opened").toHaveLength(0);
    expect(Object.values(s().tabs).map((t) => t.ref.kind)).toContain("agent-activity");
    // Even with no tab of it here at all: a sub-agent has no PTY in ANY window, so there is
    // no window to send the user to.
    s().layoutActions.closeTab(Object.keys(s().tabs)[0] as TabId);
    expect(windowShowing(SUB)).toBeNull();
  });

  it("an agent with ANY tab here (an activity view of a root) stays here", () => {
    asWindow("tearoff-2");
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    useAppStore.setState((d) => {
      d.tabs["t-act" as TabId] = {
        id: "t-act" as TabId,
        kind: "agent-activity",
        title: "activity",
        ref: { kind: "agent-activity", agentId: AGENT },
      };
    });
    expect(windowShowing(AGENT)).toBeNull();
  });

  it("does not post anything when there is nowhere to go", async () => {
    forwardSelection(AGENT);
    await flush();
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });

  it("swallows a failed send", async () => {
    setHoldings([{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    ipc.handle("tearoff_send", () => {
      throw new Error("gone");
    });
    forwardSelection(AGENT);
    await flush(); // an unhandled rejection here would fail the run
  });
});

describe("disposeRemote", () => {
  it("hands the close of a terminal held elsewhere to that window", async () => {
    setHoldings([{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    expect(disposeRemote(AGENT as never)).toBe(true);
    await flush();
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "tearoff-1", mail: { t: "close", key: `terminal:${AGENT}` } });
  });

  it("declines a terminal nobody else holds — or one this window holds itself", () => {
    expect(disposeRemote("T-unheld" as never)).toBe(false);
    asWindow("tearoff-1");
    setHoldings([{ label: "tearoff-1", keys: ["terminal:T1"] }]);
    expect(disposeRemote("T1" as never)).toBe(false);
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });

  it("swallows a failed send", async () => {
    setHoldings([{ label: "tearoff-1", keys: ["terminal:T1"] }]);
    ipc.handle("tearoff_send", () => {
      throw new Error("gone");
    });
    expect(disposeRemote("T1" as never)).toBe(true);
    await flush();
  });
});

const noop = (): void => {};

describe("routeOpen (the store's open router)", () => {
  it("an open of a tab another window holds brings that window forward instead", async () => {
    await host();
    events.emit(HOLDINGS_EVENT, [{ label: "tearoff-1", keys: ["editor:/w/a.ts", "network"] }]);
    expect(s().layoutActions.openEditorTab("/w/a.ts")).toBe(TAB_ELSEWHERE);
    expect(s().layoutActions.openNetworkTab()).toBe(TAB_ELSEWHERE);
    await flush();
    expect(sends("focus")).toEqual([
      { to: "tearoff-1", mail: { t: "focus", key: "editor:/w/a.ts" } },
      { to: "tearoff-1", mail: { t: "focus", key: "network" } },
    ]);
    expect(s().tabs, "no second live writer for the file here").toEqual({});
    // A file nobody else holds opens here as always.
    expect(s().layoutActions.openEditorTab("/w/b.ts")).not.toBe(TAB_ELSEWHERE);
  });

  it("opens it here after all when the holder is gone", async () => {
    setHoldings([{ label: "tearoff-1", keys: ["editor:/w/a.ts"] }]);
    ipc.handle("tearoff_send", () => {
      throw new Error("no window tearoff-1");
    });
    const fallback = vi.fn(() => void s().layoutActions.openEditorTab("/w/a.ts"));
    expect(routeOpen("editor:/w/a.ts", fallback)).toBe(true);
    await flush();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("never routes an arriving tab, a tab nobody holds, or one this window holds itself", () => {
    setHoldings([{ label: "tearoff-1", keys: ["village"] }]);
    expect(openHere(() => routeOpen("village", noop))).toBe(false);
    expect(routeOpen("network", noop)).toBe(false);
    asWindow("tearoff-1");
    expect(routeOpen("village", noop)).toBe(false);
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });
});

describe("heldTerminals / syncHoldings", () => {
  it("lists the terminal ids held elsewhere, sorted, and nothing else", () => {
    setHoldings([
      { label: "tearoff-2", keys: ["terminal:B", "village"] },
      { label: "tearoff-1", keys: ["terminal:A", "editor:/w/a.ts"] },
    ]);
    expect(heldTerminals()).toEqual(["A", "B"]);
  });

  it("re-saves the layout only when the set of terminals held elsewhere changed", () => {
    syncHoldings([{ label: "tearoff-1", keys: ["terminal:A"] }]);
    expect(ipc.calls("layout_prefs_save")).toHaveLength(1);
    syncHoldings([{ label: "tearoff-1", keys: ["terminal:A", "village"] }]);
    expect(ipc.calls("layout_prefs_save"), "a village moving is not the layout's business").toHaveLength(1);
    syncHoldings([]);
    expect(ipc.calls("layout_prefs_save")).toHaveLength(2);
  });
});

describe("renames across windows", () => {
  it("renamedAgents: only agents present in both snapshots whose name changed", () => {
    const a = wireAgent({ id: AGENT });
    const b = wireAgent({ id: asAgentId("B") });
    expect(renamedAgents({ [AGENT]: { ...a, customTitle: "x" }, [b.id]: b }, { [AGENT]: a })).toEqual([
      { agentId: AGENT, name: "x" },
    ]);
    expect(renamedAgents({ [AGENT]: a }, { [AGENT]: { ...a, customTitle: "x" } })).toEqual([
      { agentId: AGENT, name: null },
    ]);
    expect(renamedAgents({ [AGENT]: a }, { [AGENT]: a })).toEqual([]);
  });

  it("main: a rail rename of an agent another window shows reaches that window — never echoed", async () => {
    await host();
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT }), wireAgent({ id: asAgentId("LOCAL") })]);
    events.emit(HOLDINGS_EVENT, [{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    s().agentActions.renameAgent(AGENT, "reviewer");
    s().agentActions.renameAgent(asAgentId("LOCAL"), "mine"); // held by nobody: nobody to tell
    handleMail({ t: "renamed", agentId: AGENT, name: "from-there" }); // came FROM the holder
    await flush();
    expect(sends("renamed")).toEqual([{ to: "tearoff-1", mail: { t: "renamed", agentId: AGENT, name: "reviewer" } }]);
    expect(s().agents[AGENT].customTitle).toBe("from-there");
  });

  it("main: the host's subscriptions end with its unsubscribe", async () => {
    const stop = await startTearoffHost();
    stop();
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    setHoldings([{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    s().agentActions.renameAgent(AGENT, "reviewer");
    expect(s().layoutActions.openVillageTab()).not.toBe(TAB_ELSEWHERE);
    await flush();
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });

  it("main: the layout file keeps a held agent, with its name, while its tab is away", async () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().agentActions.renameAgent(AGENT, "reviewer");
    await host();
    events.emit(HOLDINGS_EVENT, [{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    const saved = ipc.lastCall("layout_prefs_save") as { prefs: { views: Array<{ layout: unknown }> } };
    expect(JSON.stringify(saved.prefs.views)).toContain(`{"terminalId":"${AGENT}","customTitle":"reviewer"}`);
  });

  it("detached: a rename here goes to the main window and into the next report", async () => {
    asWindow("tearoff-1");
    vi.useFakeTimers();
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().layoutActions.openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    watch();
    s().agentActions.renameAgent(AGENT, "reviewer");
    expect(sends("renamed")).toEqual([{ to: "main", mail: { t: "renamed", agentId: AGENT, name: "reviewer" } }]);
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(JSON.stringify(ipc.lastCall("tearoff_report"))).toContain('"customTitle":"reviewer"');
  });

  it("detached: a rename the main window sent is reported, but not sent back", async () => {
    asWindow("tearoff-1");
    vi.useFakeTimers();
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().layoutActions.openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    watch();
    handleMail({ t: "renamed", agentId: AGENT, name: "from-main" });
    expect(sends("renamed")).toHaveLength(0);
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(JSON.stringify(ipc.lastCall("tearoff_report"))).toContain('"customTitle":"from-main"');
  });
});

/* ───────────────────────────── the main window ───────────────────────────── */

describe("startTearoffHost", () => {
  it("routes remote closes and rail clicks, listens to ITS doorbell only, and claims what is waiting", async () => {
    ipc.handle("tearoff_holdings", () => [{ label: "tearoff-1", keys: [`terminal:${AGENT}`] }]);
    claims.push({ tabs: [], mail: [{ t: "adopt", tabs: [VILLAGE] }] });
    await host();

    expect(terminalRegistry.setRemoteDisposer).toHaveBeenCalledWith(disposeRemote);
    expect(events.optionsOf(MAIL_EVENT)).toEqual([{ target: { kind: "WebviewWindow", label: "main" } }]);
    expect(holderOf(`terminal:${AGENT}`)).toBe("tearoff-1");
    // A detached window closed while this page loaded: its tabs were waiting.
    expect(findTabByKey(s().tabs, "village")).not.toBeNull();

    // A rail click on the agent another window holds brings that window forward.
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().agentActions.selectAgent(AGENT);
    await flush();
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "tearoff-1", mail: { t: "focus", key: `terminal:${AGENT}` } });
  });

  it("claims on a doorbell addressed to it, and ignores one addressed elsewhere", async () => {
    await host();
    const before = ipc.calls("tearoff_claim").length;
    events.emit(MAIL_EVENT, "tearoff-3");
    await flush();
    expect(ipc.calls("tearoff_claim")).toHaveLength(before);
    claims.push({ tabs: [], mail: [{ t: "adopt", tabs: [VILLAGE] }] });
    events.emit(MAIL_EVENT, "main");
    await flush();
    expect(ipc.calls("tearoff_claim")).toHaveLength(before + 1);
    expect(findTabByKey(s().tabs, "village")).not.toBeNull();
  });

  it("keeps the holdings cache current from the broadcast", async () => {
    await host();
    events.emit(HOLDINGS_EVENT, [{ label: "tearoff-9", keys: ["network"] }]);
    expect(holderOf("network")).toBe("tearoff-9");
  });
});

/* ──────────────────────────── a detached window ──────────────────────────── */

describe("startTearoffWindow", () => {
  beforeEach(() => asWindow("tearoff-1"));

  it("mirrors the fleet, adopts its tabs, and reports what it holds", async () => {
    fleet.fleetSnapshot.mockResolvedValue({ agents: [wireAgent({ id: AGENT })], terminals: [] });
    claims.push({ tabs: [VILLAGE], mail: [{ t: "adopt", tabs: [VILLAGE, { kind: "network" }] }] });
    await boot();
    await flush();

    // The fleet mirror: agents only — the snapshot's terminals are never rebuilt here.
    expect(s().agents[AGENT]).toBeDefined();
    expect(terminalBarrel.configureTerminal).not.toHaveBeenCalled();
    expect(Object.values(s().tabs).map((t) => t.ref.kind).sort()).toEqual(["network", "village"]);
    expect(events.optionsOf(MAIL_EVENT)).toEqual([{ target: { kind: "WebviewWindow", label: "tearoff-1" } }]);
    expect(events.optionsOf(CLOSING_EVENT)).toEqual([{ target: { kind: "WebviewWindow", label: "tearoff-1" } }]);
    expect(ipc.lastCall("tearoff_report")).toEqual({ tabs: [VILLAGE, { kind: "network" }] });
    // A "+" terminal here opens where the main window's would.
    expect(s().workspaceRoot).toBe("/Users/me/gazelle");
  });

  it("applies telemetry that raced the snapshot, in order, after it", async () => {
    let resolveSnapshot!: (v: unknown) => void;
    fleet.fleetSnapshot.mockReturnValue(new Promise((r) => (resolveSnapshot = r)));
    claims.push({ tabs: [VILLAGE], mail: [] });
    const booting = startTearoffWindow();
    await flush();
    const started: AgentEvent = {
      t: "agent_started",
      agentId: AGENT,
      parentId: null,
      title: "gazelle",
      cwd: "/w",
      branch: "trunk",
      runtime: "claude-code",
    };
    events.emit("agent://event", started);
    expect(s().agents[AGENT], "buffered until the snapshot lands").toBeUndefined();
    resolveSnapshot({ agents: [], terminals: [] });
    stops.push(await booting);
    expect(s().agents[AGENT]).toBeDefined();
    events.emit("agent://event", { t: "title", agentId: AGENT, title: "renamed" });
    expect(s().agents[AGENT].title).toBe("renamed");
  });

  it("un-sticks a killed agent's terminal held HERE — live and while buffered behind the snapshot", async () => {
    let resolveSnapshot!: (v: unknown) => void;
    fleet.fleetSnapshot.mockReturnValue(new Promise((r) => (resolveSnapshot = r)));
    claims.push({ tabs: [VILLAGE], mail: [] });
    const booting = startTearoffWindow();
    await flush();
    events.emit("agent://event", { t: "exited", agentId: AGENT, code: 137 });
    expect(terminalRegistry.noteAgentExited, "buffered until the snapshot lands").not.toHaveBeenCalled();
    resolveSnapshot({ agents: [], terminals: [] });
    stops.push(await booting);
    expect(terminalRegistry.noteAgentExited).toHaveBeenCalledWith(AGENT, 137);
    events.emit("agent://event", { t: "exited", agentId: AGENT, code: 0 });
    expect(terminalRegistry.noteAgentExited).toHaveBeenLastCalledWith(AGENT, 0);
    expect(terminalRegistry.noteAgentExited).toHaveBeenCalledTimes(2);
  });

  it("keeps its holdings cache current too — a village click on an agent elsewhere finds it", async () => {
    claims.push({ tabs: [VILLAGE], mail: [] });
    await boot();
    events.emit(HOLDINGS_EVENT, [{ label: "tearoff-7", keys: [`terminal:${AGENT}`] }]);
    expect(holderOf(`terminal:${AGENT}`)).toBe("tearoff-7");
    expect(windowShowing(AGENT)).toBe("tearoff-7");
  });

  it("survives a failed snapshot on live telemetry alone", async () => {
    fleet.fleetSnapshot.mockRejectedValue(new Error("no supervisor"));
    claims.push({ tabs: [VILLAGE], mail: [] });
    await boot();
    expect(findTabByKey(s().tabs, "village")).not.toBeNull();
  });

  it("closes itself when the tabs it was opened for never arrive", async () => {
    await boot();
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
    expect(ipc.calls("tearoff_report")).toHaveLength(0);
  });

  it("claims on its own doorbell — without re-adopting what Rust still lists as held", async () => {
    claims.push({ tabs: [VILLAGE], mail: [] });
    await boot();
    s().layoutActions.closeTab(findTabByKey(s().tabs, "village") as TabId);
    s().layoutActions.openNetworkTab(); // keep the window open
    claims.push({ tabs: [VILLAGE], mail: [] }); // Rust's copy has not caught up yet
    events.emit(MAIL_EVENT, "tearoff-1");
    await flush();
    expect(findTabByKey(s().tabs, "village"), "a closed tab stays closed").toBeNull();
    events.emit(MAIL_EVENT, "main"); // not ours
    await flush();
  });

  it("hands every tab home on the close button, then closes", async () => {
    claims.push({ tabs: [VILLAGE], mail: [] });
    await boot();
    events.emit(CLOSING_EVENT, "tearoff-1");
    await flush();
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "main", mail: { t: "adopt", tabs: [VILLAGE] } });
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });
});

describe("handBackAndClose", () => {
  it("silences the reports first — a late one would re-fill the ledger Rust just released", async () => {
    // Review finding: an edit < 250 ms before the close left a debounced report pending; it
    // fired after the hand-back and put every tab back in Rust's ledger, so the destroy path
    // posted them to the main window a second time.
    asWindow("tearoff-1");
    vi.useFakeTimers();
    s().layoutActions.openVillageTab();
    watch();
    for (const l of editorRegistry.listeners) l("/w/a.ts"); // an edit: report pending
    await handBackAndClose();
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS * 4);
    s().layoutActions.openNetworkTab(); // and the watcher is off too
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS * 4);
    expect(ipc.calls("tearoff_report")).toHaveLength(0);
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "main", mail: { t: "adopt", tabs: [VILLAGE] } });
    expect(editorRegistry.listeners.size).toBe(0);
  });

  it("closes even when the hand-back fails — Rust re-homes the last report", async () => {
    s().layoutActions.openVillageTab();
    ipc.handle("tearoff_send", () => {
      throw new Error("main is reloading");
    });
    await handBackAndClose();
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });

  it("with nothing to hand back, just closes", async () => {
    await handBackAndClose();
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });

  it("swallows a close that fails", async () => {
    ipc.handle("tearoff_close", () => {
      throw new Error("already gone");
    });
    await expect(handBackAndClose()).resolves.toBeUndefined();
  });
});

describe("watchDetachedWindow", () => {
  beforeEach(() => asWindow("tearoff-1"));

  it("reports once per burst of tab changes and edits, after the debounce", () => {
    vi.useFakeTimers();
    const stop = watchDetachedWindow();
    s().layoutActions.openVillageTab();
    s().layoutActions.openNetworkTab();
    for (const l of editorRegistry.listeners) l("/w/a.ts");
    expect(ipc.calls("tearoff_report")).toHaveLength(0);
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(ipc.calls("tearoff_report")).toHaveLength(1);
    expect(ipc.lastCall("tearoff_report")).toEqual({ tabs: [VILLAGE, { kind: "network" }] });
    stop();
    s().layoutActions.openAgentLogsTab();
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(ipc.calls("tearoff_report"), "unsubscribed").toHaveLength(1);
    expect(editorRegistry.listeners.size).toBe(0);
  });

  it("reportNow cancels a pending debounced report", () => {
    vi.useFakeTimers();
    s().layoutActions.openVillageTab();
    scheduleReport();
    reportNow();
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(ipc.calls("tearoff_report")).toHaveLength(1);
  });

  it("closes the window once its last tab has gone home — after the move lands", async () => {
    const id = s().layoutActions.openVillageTab();
    watch();
    let land!: () => void;
    ipc.handle("tearoff_send", () => new Promise<null>((r) => (land = () => r(null))));
    const move = moveTabToMainWindow(id);
    await flush();
    try {
      expect(ipc.calls("tearoff_close"), "not while the send is in flight").toHaveLength(0);
    } finally {
      land(); // never leave a move in flight for the next test to wait on
    }
    await move;
    await flush();
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });

  it("stays open when the move failed and the tab came back", async () => {
    const id = s().layoutActions.openVillageTab();
    watch();
    ipc.handle("tearoff_send", () => {
      throw new Error("main is gone");
    });
    await act(async () => {
      await moveTabToMainWindow(id);
      await flush();
    });
    expect(findTabByKey(s().tabs, "village")).not.toBeNull();
    expect(ipc.calls("tearoff_close")).toHaveLength(0);
  });

  it("tells the main window when an agent's tab was closed for good here", async () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().layoutActions.openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    s().layoutActions.openVillageTab();
    watch();
    s().layoutActions.closeTab(findTabByKey(s().tabs, `terminal:${AGENT}`) as TabId);
    await flush();
    expect(ipc.calls("tearoff_send").map((c) => c.args)).toContainEqual({
      to: "main",
      mail: { t: "dismissed", agentId: AGENT },
    });
  });

  it("a MOVE is not a dismissal: moving an agent's tab away tells the main window nothing", async () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    const id = s().layoutActions.openTerminalTab({ cwd: "/w", agentId: AGENT, runtime: "claude-code" });
    s().layoutActions.openVillageTab();
    watch();
    await moveTabToMainWindow(id);
    await flush();
    const dismissed = ipc.calls("tearoff_send").filter((c) => (c.args.mail as { t: string }).t === "dismissed");
    expect(dismissed).toHaveLength(0);
    expect(s().agents[AGENT]).toBeDefined();
  });

  it("swallows a failed dismissal notice", async () => {
    s().agentActions.applyFleetSnapshot([wireAgent({ id: AGENT })]);
    s().layoutActions.openVillageTab();
    watch();
    ipc.handle("tearoff_send", () => {
      throw new Error("gone");
    });
    s().agentActions.removeAgent(AGENT);
    await flush();
  });
});

describe("closeIfEmpty", () => {
  it("cancels a pending report before it closes", async () => {
    vi.useFakeTimers();
    scheduleReport();
    await closeIfEmpty();
    vi.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    expect(ipc.calls("tearoff_report")).toHaveLength(0);
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });

  it("does nothing while the window still shows a tab", async () => {
    s().layoutActions.openVillageTab();
    await closeIfEmpty();
    expect(ipc.calls("tearoff_close")).toHaveLength(0);
  });

  it("swallows a close that fails", async () => {
    ipc.handle("tearoff_close", () => {
      throw new Error("already gone");
    });
    await expect(closeIfEmpty()).resolves.toBeUndefined();
  });
});
