/**
 * Which window is this JS realm running in? (tab tear-off, docs/design/tab-tearoff.md)
 *
 * Every Tauri window is a separate realm with its own module instances and its own store,
 * all loaded from the same bundle. The ROLE decides what the realm boots: the main window
 * runs the whole app (rails, fleet bridge, layout persistence); a detached window runs a
 * minimal shell — its pane tree and tab strip — and must not start the app-wide pollers or
 * write `layout-prefs.json`.
 *
 * The role comes from the window's LABEL, which Tauri injects into every webview
 * (`__TAURI_INTERNALS__.metadata.currentWindow.label`) — not from the URL, which a page can
 * navigate. Rust mints detached labels with the same prefix (`tearoff.rs` `LABEL_PREFIX`)
 * and `capabilities/tearoff.json` grants exactly `tearoff-*`.
 *
 * Outside Tauri (a jsdom test, the browser tier) there is no metadata, and the realm is the
 * main window — which is what every existing test renders.
 */

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
