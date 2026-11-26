/** Which window this realm runs in (tab-tearoff.md): main runs the whole app, detached a minimal
 * shell (no app-wide pollers, no `layout-prefs.json`). Read from the injected LABEL, never the URL;
 * prefix synced with `tearoff.rs` and `capabilities/tearoff.json`. No Tauri (tests) → main. */

/** The main window's label (`tauri.conf.json`). */
export const MAIN_WINDOW = "main";

/** Every detached window's label starts with this (mirrors `tearoff.rs` `LABEL_PREFIX`). */
export const TEAROFF_PREFIX = "tearoff-";

interface TauriMetadata {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } };
}

/** This realm's window label; `"main"` when there is no Tauri metadata at all. */
export function currentWindowLabel(): string {
  const label = (window as unknown as TauriMetadata).__TAURI_INTERNALS__?.metadata?.currentWindow
    ?.label;
  return typeof label === "string" && label.length > 0 ? label : MAIN_WINDOW;
}

/** Is `label` a detached (torn-off) window's? The bare prefix is not a label Rust mints. */
export function isTearoffLabel(label: string): boolean {
  return label.length > TEAROFF_PREFIX.length && label.startsWith(TEAROFF_PREFIX);
}

/** True in the main window — the one that persists the layout and runs the rails. */
export function isMainWindow(): boolean {
  return !isTearoffLabel(currentWindowLabel());
}
