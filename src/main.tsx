import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TearoffApp from "./TearoffApp";
import { startBridge } from "./app/bridge";
import { listenAgentCtl } from "./features/agentctl/agentCtlIpc";
import { dispatchAgentCtl } from "./features/agentctl/dispatch";
import { suppressNativeContextMenu } from "./app/nativeContextMenu";
import { isMainWindow, startTearoffHost, startTearoffWindow } from "./app/tearoff";

/** Composition root. `startBridge()` stays out of `<App>` so App renders without Tauri; unawaited,
 * it queues early events. The main window boots the tear-off host after the bridge settles; a
 * `tearoff-*` window gets no bridge: it would steal every terminal (docs/design/tab-tearoff.md). */
const main = isMainWindow();

if (main) {
  const host = (): void => void startTearoffHost();
  void startBridge().then(host, host);
  // What agents do through the `agent-studio` command and MCP tools (Rust `agent_ctl`): the
  // main window only, which is the one with the panels they act on.
  void listenAgentCtl(dispatchAgentCtl);
} else {
  void startTearoffWindow();
}

// The webview's own right-click menu is suppressed except on editable fields and selected text
// (the rule: `app/nativeContextMenu.ts`).
suppressNativeContextMenu();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{main ? <App /> : <TearoffApp />}</React.StrictMode>,
);
