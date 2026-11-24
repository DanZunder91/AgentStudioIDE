/**
 * Cmd/Ctrl+W → close the focused pane's active tab (any kind), instead of the
 * default "close the window" (which quit the whole app).
 *
 * Two platform paths, because on macOS **Cmd+W is a native menu accelerator** that
 * fires before the webview ever sees the keystroke:
 *   • macOS — the Rust app menu (`src-tauri/src/menu.rs`) binds Cmd+W to a
 *     "Close Tab" item that emits `menu://close-tab`; we subscribe to it here.
 *   • non-macOS — no native accelerator, so the webview receives Ctrl+W; a keydown
 *     listener closes the tab and prevents the browser default.
 *
 * Renders nothing — an effect host mounted once in <App/>.
 */

import { useEffect } from "react";

import { listen } from "@tauri-apps/api/event";

import { useAppStore } from "../../app/store";
import { currentWindowLabel } from "../../app/tearoff/windowRole";
import { isMac } from "./shortcuts";

/** The Rust menu event (macOS) — mirrors `menu::CLOSE_TAB_EVENT` in src-tauri. */
export const MENU_CLOSE_TAB = "menu://close-tab";

export function CloseTabShortcut(): null {
  useEffect(() => {
    const closeActiveTab = () => useAppStore.getState().layoutActions.closeActiveTab();

    // macOS path: the native-menu "Close Tab" item emits this event — to the FOCUSED
    // window only (menu.rs `close_tab_target`). Listening with this window's own label as
    // the target is the other half: a listener on the default `Any` target receives every
    // `emit_to` whatever label it names, so with a torn-off window open, one Cmd+W would
    // close a tab in every window (docs/design/tab-tearoff.md §4.4).
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const target = { kind: "WebviewWindow", label: currentWindowLabel() } as const;
    void listen(MENU_CLOSE_TAB, closeActiveTab, { target }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });

    // Non-macOS path: intercept Ctrl+W in the webview (no native accelerator there).
    const onKeyDown = (e: KeyboardEvent) => {
      // The editor handles Ctrl+W itself (EditorRegistry's Mod-w keymap) and
      // preventDefaults it; skip already-handled events so a focused editor's
      // tab isn't closed twice.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeActiveTab();
      }
    };
    const keydownHost = isMac() ? null : window;
    keydownHost?.addEventListener("keydown", onKeyDown);

    return () => {
      disposed = true;
      unlisten?.();
      keydownHost?.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return null;
}
