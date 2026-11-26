/** Cmd/Ctrl+W closes the focused pane's active tab, not the window. On macOS Cmd+W is a native
 * menu accelerator (`src-tauri/src/menu.rs` emits `menu://close-tab`); elsewhere a webview
 * keydown. Renders nothing; mounted once in <App/>. */

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

    // macOS: the menu emits to the focused window only. Listen on this window's label: an `Any`
    // target receives every `emit_to` (docs/design/tab-tearoff.md §4.4).
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
