/**
 * CloseTabShortcut — the Cmd/Ctrl+W wiring. Two platform paths:
 *   • non-macOS — a webview keydown listener (Ctrl+W) closes the active tab.
 *   • macOS — the native menu emits `menu://close-tab`; we listen for it (the
 *     webview never sees Cmd+W there).
 *
 * The store, the Tauri event bridge, and platform detection are mocked at the
 * module boundary so both paths are drivable in jsdom. `closeActiveTab`'s real
 * behaviour is covered separately in `app/store.test.ts`; here we test the wiring.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store seam: the component only reaches `getState().layoutActions.closeActiveTab`.
const store = vi.hoisted(() => {
  const closeActiveTab = vi.fn();
  return {
    closeActiveTab,
    useAppStore: { getState: () => ({ layoutActions: { closeActiveTab } }) },
  };
});
vi.mock("../../app/store", () => ({ useAppStore: store.useAppStore }));

// `listen` — capture the callback + control when the subscription resolves.
const tauri = vi.hoisted(() => {
  const unlisten = vi.fn();
  const handlers = new Map<string, (e?: unknown) => void>();
  const ctl = { pending: false, release: undefined as undefined | (() => void) };
  const listen = vi.fn((name: string, cb: (e?: unknown) => void) => {
    handlers.set(name, cb);
    if (ctl.pending) {
      return new Promise<() => void>((resolve) => {
        ctl.release = () => resolve(unlisten);
      });
    }
    return Promise.resolve(unlisten);
  });
  return { unlisten, handlers, ctl, listen };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

// Platform detection — flip per test.
const shortcuts = vi.hoisted(() => ({ isMac: vi.fn(() => false) }));
vi.mock("./shortcuts", () => shortcuts);

import { act } from "@testing-library/react";

import { CloseTabShortcut, MENU_CLOSE_TAB } from "./CloseTabShortcut";

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

/** Let the `listen(...).then(...)` microtask settle. */
const settle = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  tauri.listen.mockClear();
  tauri.unlisten.mockClear();
  tauri.handlers.clear();
  tauri.ctl.pending = false;
  tauri.ctl.release = undefined;
  shortcuts.isMac.mockReturnValue(false);
  store.closeActiveTab.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CloseTabShortcut — non-macOS (keydown)", () => {
  it("Ctrl+W closes the active tab and prevents the browser default", () => {
    render(<CloseTabShortcut />);
    const ev = key({ key: "w", ctrlKey: true });
    window.dispatchEvent(ev);
    expect(store.closeActiveTab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores an already-handled Ctrl+W (the editor's own Mod-w keymap preventDefaulted it)", () => {
    render(<CloseTabShortcut />);
    // A focused CodeMirror closes its tab and preventDefaults; the window
    // fallback must not close a SECOND tab for the same keystroke.
    const ev = key({ key: "w", ctrlKey: true });
    ev.preventDefault();
    window.dispatchEvent(ev);
    expect(store.closeActiveTab).not.toHaveBeenCalled();
  });

  it("ignores anything that isn't the close chord", () => {
    render(<CloseTabShortcut />);
    for (const ev of [
      key({ key: "a", ctrlKey: true }), // wrong key
      key({ key: "w" }), // no modifier
      key({ key: "w", ctrlKey: true, shiftKey: true }), // Shift held
      key({ key: "w", ctrlKey: true, altKey: true }), // Alt held
    ]) {
      window.dispatchEvent(ev);
    }
    expect(store.closeActiveTab).not.toHaveBeenCalled();
  });
});

describe("CloseTabShortcut — macOS (native menu)", () => {
  it("closes on the native-menu event, and NOT on a webview Cmd+W keydown", async () => {
    shortcuts.isMac.mockReturnValue(true);
    render(<CloseTabShortcut />);
    await settle();

    // No keydown listener on macOS — the menu owns Cmd+W.
    window.dispatchEvent(key({ key: "w", metaKey: true }));
    expect(store.closeActiveTab).not.toHaveBeenCalled();

    // The menu item's event does close the tab.
    act(() => tauri.handlers.get(MENU_CLOSE_TAB)?.());
    expect(store.closeActiveTab).toHaveBeenCalledTimes(1);
  });
});

describe("CloseTabShortcut — one window, not every window (tab tear-off)", () => {
  // Rust sends "Close Tab" to the FOCUSED window only (menu.rs `close_tab_target`), but a
  // Tauri listener left on the default `Any` target receives every `emit_to` whatever
  // label it names — so the target is the half of the fix that lives here. Without it,
  // one Cmd+W in a torn-off window also closed the main window's active tab.
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("listens as the main window when there is no window metadata", async () => {
    render(<CloseTabShortcut />);
    await settle();
    expect(tauri.listen).toHaveBeenCalledWith(MENU_CLOSE_TAB, expect.any(Function), {
      target: { kind: "WebviewWindow", label: "main" },
    });
  });

  it("listens as ITS OWN window in a detached one", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "tearoff-3" } },
    };
    render(<CloseTabShortcut />);
    await settle();
    expect(tauri.listen).toHaveBeenCalledWith(MENU_CLOSE_TAB, expect.any(Function), {
      target: { kind: "WebviewWindow", label: "tearoff-3" },
    });
  });
});

describe("CloseTabShortcut — lifecycle", () => {
  it("subscribes on mount and unsubscribes on unmount", async () => {
    const { unmount } = render(<CloseTabShortcut />);
    await settle();
    expect(tauri.listen).toHaveBeenCalledWith(MENU_CLOSE_TAB, expect.any(Function), expect.anything());

    unmount();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
    // The keydown listener is gone too.
    window.dispatchEvent(key({ key: "w", ctrlKey: true }));
    expect(store.closeActiveTab).not.toHaveBeenCalled();
  });

  it("unsubscribes even if it unmounts before the subscription resolves", async () => {
    tauri.ctl.pending = true; // hold listen's promise open
    const { unmount } = render(<CloseTabShortcut />);
    unmount(); // cleanup runs while `unlisten` is still undefined

    // Now the subscription resolves; because it's disposed, it must unlisten at once.
    await act(async () => {
      tauri.ctl.release?.();
      await Promise.resolve();
    });
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });
});
