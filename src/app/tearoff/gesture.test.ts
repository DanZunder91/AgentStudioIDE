/**
 * The drag gesture across windows: let go OUTSIDE the window → a new window at the cursor;
 * drop on ANOTHER window → ask that tab's window to give it over. The OS reads are mocked
 * (`probeRelease`); the decision (`releasedOutside`) and the move are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ probeRelease: vi.fn() }));
vi.mock("./geometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./geometry")>()),
  probeRelease: probe.probeRelease,
}));

vi.mock("../../features/terminal", () => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal/TerminalRegistry", () => ({ abandon: vi.fn() }));
vi.mock("../../features/editor/EditorRegistry", () => ({
  exportEditor: vi.fn(() => null),
  seedEditor: vi.fn(),
  abandon: vi.fn(),
}));
vi.mock("../../features/editor", () => ({ disposeEditorBuffer: vi.fn() }));

import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { useAppStore } from "../store";
import { asTabId } from "../types";
import { canStartWindow, takeForeignDrop, tearOffIfReleasedOutside } from "./gesture";
import type { ReleaseProbe } from "./geometry";

const s = () => useAppStore.getState();

/** The main window at (0, 0) 1280×832, scale 1. */
const released = (x: number, y: number): ReleaseProbe => ({
  cursor: { x, y },
  frame: { x: 0, y: 0, width: 1280, height: 832 },
  cursorScale: 1,
  frameScale: 1,
});

function asWindow(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__: { metadata?: unknown } }).__TAURI_INTERNALS__.metadata = {
    currentWindow: { label },
  };
}

let ipc: TauriMock;
beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  ipc = installTauriMock();
  ipc.handle("layout_prefs_save", () => null).handle("tearoff_open", () => "tearoff-1").handle("tearoff_send", () => null);
});
afterEach(() => ipc.reset());

describe("canStartWindow", () => {
  it("any movable tab may start a window from the main window — even its only tab", () => {
    const id = s().layoutActions.openVillageTab();
    expect(canStartWindow(id)).toBe(true);
  });

  it("the only tab of a DETACHED window may not — it already has a window of its own", () => {
    asWindow("tearoff-1");
    const id = s().layoutActions.openVillageTab();
    expect(canStartWindow(id)).toBe(false);
    s().layoutActions.openNetworkTab();
    expect(canStartWindow(id)).toBe(true);
  });

  it("a kind that cannot move, or an unknown tab, never may", () => {
    const api = s().layoutActions.openApiRequestTab();
    expect(canStartWindow(api)).toBe(false);
    expect(canStartWindow(asTabId("nope"))).toBe(false);
  });
});

describe("tearOffIfReleasedOutside", () => {
  it("opens the tab in a new window AT the release point when it was let go outside", async () => {
    const id = s().layoutActions.openVillageTab();
    probe.probeRelease.mockResolvedValue(released(1600, 300));
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(true);
    expect(ipc.lastCall("tearoff_open")).toEqual({ tabs: [{ kind: "village" }], at: { x: 1600, y: 300 } });
    expect(s().tabs[id]).toBeUndefined();
  });

  it("leaves a tab let go INSIDE the window exactly where it was", async () => {
    const id = s().layoutActions.openVillageTab();
    probe.probeRelease.mockResolvedValue(released(640, 400));
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(false);
    expect(ipc.calls("tearoff_open")).toHaveLength(0);
    expect(s().tabs[id]).toBeDefined();
  });

  it("degrades to nothing on Wayland's (0, 0) and on an unreadable cursor", async () => {
    const id = s().layoutActions.openVillageTab();
    probe.probeRelease.mockResolvedValue({ ...released(0, 0), frame: { x: 500, y: 500, width: 800, height: 600 } });
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(false);
    probe.probeRelease.mockResolvedValue({ ...released(0, 0), cursor: null });
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(false);
    probe.probeRelease.mockResolvedValue(null);
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(false);
    expect(ipc.calls("tearoff_open")).toHaveLength(0);
  });

  it("does not even ask the OS for a tab that may not start a window", async () => {
    const id = s().layoutActions.openApiRequestTab();
    await expect(tearOffIfReleasedOutside(id)).resolves.toBe(false);
    expect(probe.probeRelease).not.toHaveBeenCalled();
  });
});

describe("takeForeignDrop", () => {
  it("asks the tab's own window to give it HERE, and reports the drop as handled", async () => {
    asWindow("tearoff-2");
    expect(takeForeignDrop("tab-7", "main")).toBe(true);
    await Promise.resolve();
    expect(ipc.lastCall("tearoff_send")).toEqual({
      to: "main",
      mail: { t: "give", tabId: "tab-7", to: "tearoff-2" },
    });
  });

  it("leaves this window's own tabs — and a drag that names no window — to the caller", () => {
    expect(takeForeignDrop("tab-7", "main")).toBe(false); // we ARE main
    expect(takeForeignDrop("tab-7", "")).toBe(false); // an older drag payload
    expect(takeForeignDrop("", "tearoff-3")).toBe(false);
    expect(ipc.calls("tearoff_send")).toHaveLength(0);
  });

  it("swallows a give that could not be posted", async () => {
    ipc.handle("tearoff_send", () => {
      throw new Error("that window closed");
    });
    expect(takeForeignDrop("tab-7", "tearoff-9")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
  });
});
