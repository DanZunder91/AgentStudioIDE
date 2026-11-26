/** Bare Mod+O quick-opens (but off macOS Ctrl+O in a terminal stays the shell's); an unclaimed
 * Mod+F opens Find in Files, decided a macrotask after dispatch so `defaultPrevented` is final.
 * Both use the current tab's scope; modifiers are strict (⌘ on macOS, Ctrl elsewhere). */

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

/** Shift and Alt variants belong to other bindings (Find in Files, quick open). */
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
