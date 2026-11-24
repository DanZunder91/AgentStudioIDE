import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TearoffApp from "./TearoffApp";
import { startBridge } from "./app/bridge";
import { suppressNativeContextMenu } from "./app/nativeContextMenu";
import { isMainWindow, startTearoffHost, startTearoffWindow } from "./app/tearoff";

/**
 * The composition root: this is where the app is wired to the OS.
 *
 * `startBridge()` opens the cold plane (`agent://event` -> store) for the
 * process's lifetime. It lives HERE and not in `<App>` deliberately: putting it
 * in a component makes the component tree depend on Tauri, so every test that
 * renders <App /> then needs an event mock to exist at all. Keeping App pure is
 * what lets the layer-5 browser tier render the real thing.
 *
 * Not awaited, and that's fine: the bridge queues events that arrive before the
 * listener attaches, and the rail paints from `fleet_snapshot` regardless.
 * Nothing is torn down because there is no "after" — the process exit is the
 * teardown.
 *
 * ── Two kinds of window, one bundle (tab tear-off, docs/design/tab-tearoff.md) ──
 * Every Tauri window loads this same file into its own JS realm. The MAIN window boots the
 * whole app — and its tear-off host only once the bridge has settled, because a tab coming
 * home is a `rebuildTerminalTabs`, and one that ran before the boot restore placed the
 * persisted layout would consume it. A DETACHED window (label `tearoff-*`)
 * boots only its own tabs: no bridge (its fleet snapshot would rebuild — and steal — every
 * terminal in the app), no layout prefs, no rails.
 */
const main = isMainWindow();

if (main) {
  const host = (): void => void startTearoffHost();
  void startBridge().then(host, host);
} else {
  void startTearoffWindow();
}

// Same shape, same home: window-level wiring for the process's lifetime. The
// webview's default right-click menu (Back/Forward/Reload on WebKitGTK) is a
// browser's, not this app's — suppressed everywhere except editable fields and
// clicks on selected text, where the native menu is the editing/copy menu. See
// `app/nativeContextMenu.ts` for the full rule.
suppressNativeContextMenu();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{main ? <App /> : <TearoffApp />}</React.StrictMode>,
);
