/**
 * Bare Cmd/Ctrl+O and the UNCLAIMED Cmd/Ctrl+F — the two find keys a hand reaches
 * for before it remembers the Shift (Ctrl+F and Ctrl+O use the workspace of the
 * window that is open).
 *
 * Before this, both keys did nothing outside a find-capable surface: bare Mod+O had
 * no binding anywhere (no native menu item either — `src-tauri/src/menu.rs` binds only
 * Cmd+W), and Mod+F answered only when focus sat in an editor, a terminal, a rendered
 * preview, an API response, a results grid or the logs panel. On a village tab, an
 * empty pane, a tree row or a tab header, the key fell on the floor.
 *
 *   • **Mod+O → quick-open a file** (the `<FindFiles/>` overlay, same as Mod+Shift+O).
 *     IntelliJ's habit (⌘O / ⌘⇧O are both "go to"), and VS Code's ⌘O "open file"
 *     means the same thing in an app with no native open dialog. It is an OPEN, never
 *     a toggle. Exception: on Linux/Windows, Ctrl+O inside a TERMINAL stays with the
 *     shell (readline's operate-and-get-next, nano's write-out), exactly as macOS
 *     Ctrl+F stays with readline in `terminal/find/searchModel`.
 *
 *   • **Mod+F nobody claimed → Find in Files.** Strictly a FALLBACK: every in-surface
 *     find keeps the key (the terminal's capture listener stops it dead; CodeMirror,
 *     the preview's own window listener, ResponseBody, ResultsGrid and the logs panel
 *     all `preventDefault`). The decision is taken a macrotask AFTER dispatch, because
 *     the preview's window listener may have been registered after this one and so
 *     runs later in the same dispatch; by the timer, `defaultPrevented` is final.
 *     A key typed into some other text field (a rail filter box) is left alone, the
 *     same rule as `editor/previewFind.isEditableTarget`.
 *
 * Both overlays open on the scope of the tab the user is in (`find/ScopeSelector`'s
 * `useScope`), so in a torn-off window — which mounts this host too — they search
 * THAT window's workspace. Platform modifiers are strict (⌘ on macOS, Ctrl elsewhere),
 * so macOS Ctrl+F / Ctrl+O always reach the PTY or the field untouched.
 *
 * Renders nothing — an effect host mounted once per window (App, TearoffApp).
 */

import { useEffect } from "react";

import { useAppStore } from "../../app/store";
import { OPEN_FIND_FILES_EVENT } from "../find/FindFiles";
import { isMac } from "./shortcuts";

/** The fields read off a keydown — a structural subset of KeyboardEvent. */
export interface ModKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Which bare platform-modifier find key is this — "f", "o", or neither?
 * Shift and Alt variants belong to other bindings (Find in Files, quick open).
 */
export function bareFindKey(e: ModKeyEvent, mac: boolean): "f" | "o" | null {
  if (e.altKey || e.shiftKey) return null;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();
  return k === "f" || k === "o" ? k : null;
}

/** Is the event's target inside an embedded terminal (xterm's host)? */
function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm") !== null;
}

/** Is the event's target a text field the user is typing in? */
function inEditable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null
  );
}

export function FindKeysShortcut(): null {
  useEffect(() => {
    const mac = isMac();
    let pending: ReturnType<typeof setTimeout> | undefined;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // a focused surface already answered
      const k = bareFindKey(e, mac);
      if (k === "o") {
        if (!mac && inTerminal(e.target)) return; // the shell's Ctrl+O
        e.preventDefault();
        window.dispatchEvent(new Event(OPEN_FIND_FILES_EVENT));
      } else if (k === "f") {
        if (inEditable(e.target)) return;
        clearTimeout(pending);
        pending = setTimeout(() => {
          if (!e.defaultPrevented) useAppStore.getState().uiActions.setFindInFilesOpen(true);
        }, 0);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(pending);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return null;
}
