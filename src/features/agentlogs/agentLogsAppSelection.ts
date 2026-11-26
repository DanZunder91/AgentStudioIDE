/** Dev-app selection rule as one store subscription: a `filter.onlySources` change that is not
 * all the selected app's own streams (`isAppSource`) deselects it. If the app vanishes while its
 * empty pick shows, the pick returns to All (else a blank stream with no explanation). */

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

/** Select `app` in Logs (sidebar row, stream header links): procs store first, then solo its
 * streams, so {@link watchAppSelection} judges a solo that is the app's own. */
export function selectAppInLogs(app: DevApp): void {
  selectDevApp(app.key);
  const p = useProcsStore.getState();
  const logs = useAgentLogsStore.getState();
  // `app` sources are listed whatever the system-apps switch says, so `false` loses none.
  logs.soloSources(appSoloSources(app, p.streams, deriveRunning(logs.lines, false), p.list?.apps ?? [], servicePaths(logs.lines)));
}
