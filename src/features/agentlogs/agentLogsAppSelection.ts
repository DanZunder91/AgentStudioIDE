/**
 * The dev-app selection rule of the Logs view, as one store subscription rather than a check at
 * every call site: whatever changes the SOURCE PICK — a sidebar row, All, the stream header's
 * "All sources", the toolbar picker, an
 * error badge, a block's "→ open stream" link — a pick that is not all the selected app's own
 * streams deselects the app (`selectDevApp(null)`), which unmounts its card.
 *
 * Only a change of `filter.onlySources` is judged — never a level chip or the text box (they
 * keep the array's identity), and never the selection itself: selecting an app sets the
 * procs store first and solos second, so the solo is what gets judged, and it is the app's.
 * The Service that tails the app's console counts as the app's own (`isAppSource`).
 * A selected app that is no longer listed (it exited) is let go on the next pick too.
 *
 * Also: when the selected app disappears from the list while its empty "nothing streams yet"
 * pick is on screen, the pick goes back to All — an empty pick with no card above it would
 * be a blank stream with no way to tell why.
 */

import { selectDevApp, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { appSoloSources, pickKeepsApp } from "./agentLogsApps";
import { servicePaths } from "./agentLogsLinks";
import { deriveRunning } from "./agentLogsRunning";
import { useAgentLogsStore } from "./agentLogsStore";

/** Start watching; returns the unsubscribe (a `useEffect` cleanup). */
export function watchAppSelection(): () => void {
  const offPick = useAgentLogsStore.subscribe((s, prev) => {
    if (s.filter.onlySources === prev.filter.onlySources) return;
    const p = useProcsStore.getState();
    if (p.selectedKey === null) return;
    const apps = p.list?.apps ?? [];
    const app = apps.find((a) => a.key === p.selectedKey);
    // The Service tailing the app's console is one of its streams — known from the ring.
    if (app === undefined || !pickKeepsApp(s.filter.onlySources, app, p.streams, apps, servicePaths(s.lines))) selectDevApp(null);
  });
  const offList = useProcsStore.subscribe((p, prev) => {
    if (p.list === prev.list || p.list === null || p.selectedKey === null) return;
    if (p.list.apps.some((a) => a.key === p.selectedKey)) return;
    selectDevApp(null);
    const only = useAgentLogsStore.getState().filter.onlySources;
    if (only !== null && only.length === 0) useAgentLogsStore.getState().setSourcePick([], null);
  });
  return () => {
    offPick();
    offList();
  };
}

/**
 * Select `app` in the Logs view — the sidebar row's click and the stream header's app links
 * share it: the procs store first, then the solo of its streams (none yet →
 * the empty pick, and the card says what to do), so {@link watchAppSelection} judges the solo
 * and it is the app's own.
 */
export function selectAppInLogs(app: DevApp): void {
  selectDevApp(app.key);
  const p = useProcsStore.getState();
  const logs = useAgentLogsStore.getState();
  // `app` sources are listed whatever the system-apps switch says, so `false` loses none.
  logs.soloSources(appSoloSources(app, p.streams, deriveRunning(logs.lines, false), p.list?.apps ?? [], servicePaths(logs.lines)));
}
