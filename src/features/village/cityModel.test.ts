/** The terminal registry, busy IPC and supervisor snapshot are mocked (no live PTY in a unit
 * test); the store is real. */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  getTerminalMeta: vi.fn(),
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
const busyIpc = vi.hoisted(() => ({ terminalsBusy: vi.fn() }));
const fleet = vi.hoisted(() => ({ fleetSnapshot: vi.fn() }));
vi.mock("../terminal", () => terminal);
vi.mock("../terminal/terminalBusyIpc", () => busyIpc);
vi.mock("../fleet/fleetIpc", () => fleet);

import { useAppStore } from "../../app/store";
import { asTabId, asTerminalId, type Tab, type TabId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { CONSOLE_FOLDER, consoleAgents, useCityConsoles, type ConsoleMetaLookup } from "./cityModel";

function termTab(id: string, title: string, extra: Partial<Tab> = {}): Tab {
  return { id: asTabId(`tab-${id}`), kind: "terminal", title, ref: { kind: "terminal", terminalId: asTerminalId(id) }, ...extra };
}

const tabsOf = (...list: Tab[]): Record<TabId, Tab> => Object.fromEntries(list.map((t) => [t.id, t]));

const metas: Record<string, { cwd: string; status: "live" | "exited" } | null> = {};
const lookup: ConsoleMetaLookup = (id) => metas[id] ?? null;

beforeEach(() => {
  for (const k of Object.keys(metas)) delete metas[k];
});

describe("consoleAgents", () => {
  it("makes every PLAIN terminal tab a root agent of its own, in tab order — agent terminals and other tabs are not consoles", () => {
    metas["1"] = { cwd: "/work/gazelle", status: "live" };
    metas["2"] = { cwd: "/work/AgentStudioIDE/", status: "live" };
    const tabs = tabsOf(
      termTab("1", "zsh"),
      { id: asTabId("tab-a"), kind: "agent-terminal", title: "claude", ref: { kind: "agent-terminal", terminalId: asTerminalId("a"), agentId: "a" as never } },
      { id: asTabId("tab-e"), kind: "editor", title: "x.ts", ref: { kind: "editor", path: "/x.ts" } },
      termTab("2", "npm run dev", { customTitle: "dev server" }),
    );
    expect(consoleAgents(tabs, lookup, null, new Map())).toEqual([
      {
        key: "term:1",
        parentKey: null,
        origin: "ide",
        title: "zsh",
        folder: "gazelle",
        activity: "idle",
        tool: null,
        ideAgentId: null,
        lastActivityAt: null,
        consoleId: "1",
      },
      expect.objectContaining({ key: "term:2", title: "dev server", folder: "AgentStudioIDE", consoleId: "2" }),
    ]);
  });

  it("puts a console whose PTY has not opened yet in the workspace root, and one that names no folder in Terminals", () => {
    metas["3"] = { cwd: ".", status: "live" };
    const tabs = tabsOf(termTab("1", "a"), termTab("2", "b"), termTab("3", "c"));
    const folders = (root: string | null) => consoleAgents(tabs, lookup, root, new Map()).map((a) => a.folder);
    expect(folders("/work/gazelle")).toEqual(["gazelle", "gazelle", CONSOLE_FOLDER]);
    expect(folders(null)).toEqual([CONSOLE_FOLDER, CONSOLE_FOLDER, CONSOLE_FOLDER]);
  });

  it("gives an exited console no floor — it is not running", () => {
    metas["1"] = { cwd: "/w/p", status: "exited" };
    metas["2"] = { cwd: "/w/p", status: "live" };
    expect(consoleAgents(tabsOf(termTab("1", "old"), termTab("2", "new")), lookup, null, new Map()).map((a) => a.key)).toEqual(["term:2"]);
  });

  it("shows what is running: a command → typing, a hand-typed claude → thinking, nothing → idle", () => {
    const tabs = tabsOf(termTab("1", "a"), termTab("2", "b"), termTab("3", "c"));
    const busy = new Map([
      ["1", "command" as const],
      ["2", "agent" as const],
    ]);
    expect(consoleAgents(tabs, lookup, null, busy).map((a) => a.activity)).toEqual(["typing", "thinking", "idle"]);
  });
});

describe("useCityConsoles", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    terminal.getTerminalMeta.mockReset();
    terminal.getTerminalMeta.mockReturnValue(null);
    busyIpc.terminalsBusy.mockReset();
    busyIpc.terminalsBusy.mockResolvedValue([]);
    fleet.fleetSnapshot.mockReset();
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [] });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  const settle = () => act(async () => {});

  it("is empty, and asks the backend nothing, while the city is not on screen", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh")) });
    const { result } = renderHook(() => useCityConsoles({ enabled: false }));
    await settle();
    expect(result.current).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
  });

  it("lists the store's consoles at once and polls what runs in them every few seconds, re-reading the registry", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh"), termTab("2", "dev")), workspaceRoot: "/work/root" });
    const { result } = renderHook(() => useCityConsoles({ enabled: true, pollMs: 1000 }));
    await settle();
    expect(busyIpc.terminalsBusy).toHaveBeenCalledWith(["1", "2"]);
    expect(result.current.map((a) => [a.key, a.folder, a.activity])).toEqual([
      ["term:1", "root", "idle"],
      ["term:2", "root", "idle"],
    ]);
    // The PTY of "1" opens in gazelle and starts a build: both show within one poll.
    terminal.getTerminalMeta.mockImplementation((id: string) => (id === "1" ? { cwd: "/work/gazelle", status: "live" } : null));
    busyIpc.terminalsBusy.mockResolvedValue([{ id: "1", reason: "command", label: "zsh" }]);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.map((a) => [a.key, a.folder, a.activity])).toEqual([
      ["term:1", "gazelle", "typing"],
      ["term:2", "root", "idle"],
    ]);
    // A tab closed in the store disappears without waiting for a poll.
    act(() => useAppStore.setState({ tabs: tabsOf(termTab("2", "dev")) }));
    expect(result.current.map((a) => a.key)).toEqual(["term:2"]);
  });

  /** The supervisor's PTY row for console `id`. */
  const pty = (id: string, cwd: string, status: "live" | "exited") => ({ id, kind: "terminal" as const, title: "zsh", cwd, cols: 80, rows: 24, status });

  it("drops a console whose shell EXITED mid-session within a poll — the registry never hears of it, the supervisor does", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh"), termTab("2", "dev")) });
    // The registry's metadata is written once, at open: it says "live" for good.
    terminal.getTerminalMeta.mockReturnValue({ cwd: "/work/gazelle", status: "live" });
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [pty("1", "/work/gazelle", "live"), pty("2", "/work/gazelle", "live")] });
    const { result } = renderHook(() => useCityConsoles({ enabled: true, pollMs: 1000 }));
    await settle();
    expect(result.current.map((a) => a.key)).toEqual(["term:1", "term:2"]);
    // The user types `exit` in console 1.
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [pty("1", "/work/gazelle", "exited"), pty("2", "/work/gazelle", "live")] });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.map((a) => a.key)).toEqual(["term:2"]);
  });

  it("takes a console's folder from the supervisor, falls back to the registry for a PTY it does not list or when it fails, and asks nothing with no console", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "a"), termTab("2", "b")), workspaceRoot: "/work/root" });
    terminal.getTerminalMeta.mockImplementation((id: string) => (id === "2" ? { cwd: "/work/registry", status: "live" } : null));
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [pty("1", "/work/gazelle", "live")] });
    const { result } = renderHook(() => useCityConsoles({ enabled: true, pollMs: 1000 }));
    await settle();
    expect(result.current.map((a) => a.folder)).toEqual(["gazelle", "registry"]);
    // The snapshot fails: the registry (and the workspace root) take over — nothing breaks.
    fleet.fleetSnapshot.mockRejectedValue(new Error("supervisor gone"));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.map((a) => a.folder)).toEqual(["root", "registry"]);
    // No consoles at all: no snapshot is taken.
    act(() => useAppStore.setState({ tabs: {} }));
    fleet.fleetSnapshot.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(fleet.fleetSnapshot).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("does not poll while the window is hidden, and catches up when it shows again", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh")) });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    renderHook(() => useCityConsoles({ enabled: true, pollMs: 1000 }));
    await settle();
    vi.advanceTimersByTime(5000);
    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
  });

  it("drops a STALE answer — one from before a switch-off — and stops polling when unmounted", async () => {
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh")) });
    let stale!: (v: unknown) => void;
    busyIpc.terminalsBusy.mockReturnValueOnce(new Promise((r) => (stale = r)));
    const { result, rerender, unmount } = renderHook(({ on }) => useCityConsoles({ enabled: on, pollMs: 1000 }), {
      initialProps: { on: true },
    });
    rerender({ on: false });
    rerender({ on: true }); // a fresh poll: nothing is running now
    await settle();
    expect(result.current[0].activity).toBe("idle");
    await act(async () => stale([{ id: "1", reason: "command", label: "zsh" }]));
    expect(result.current[0].activity).toBe("idle");
    const calls = busyIpc.terminalsBusy.mock.calls.length;
    unmount();
    vi.advanceTimersByTime(5000);
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(calls);
  });
});

describe("useCityConsoles — polling stays put", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    terminal.getTerminalMeta.mockReturnValue(null);
    busyIpc.terminalsBusy.mockReset();
    busyIpc.terminalsBusy.mockResolvedValue([]);
    fleet.fleetSnapshot.mockReset();
    fleet.fleetSnapshot.mockResolvedValue({ agents: [], terminals: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("an unrelated tab change (an editor's dirty dot) neither restarts the poll nor fires an extra one", async () => {
    const editor: Tab = { id: asTabId("tab-e"), kind: "editor", title: "a.ts", ref: { kind: "editor", path: "/a.ts" } };
    useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh"), editor) });
    renderHook(() => useCityConsoles({ enabled: true, pollMs: 1000 }));
    await act(async () => {});
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
    act(() => useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh"), { ...editor, dirty: true }) }));
    await act(async () => {});
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
    // A new console does re-poll at once (with both ids).
    act(() => useAppStore.setState({ tabs: tabsOf(termTab("1", "zsh"), termTab("2", "dev"), editor) }));
    await act(async () => {});
    expect(busyIpc.terminalsBusy).toHaveBeenLastCalledWith(["1", "2"]);
  });
});
