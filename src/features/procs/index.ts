/**
 * Dev apps on this machine — the UI half.
 *
 * ── Mount points ──
 *
 * 1. **Sidebar group** — `<DevAppsSection onSelect={(app) => …} />` is the TOP "Apps" group of
 *    the Logs Sources sidebar (`agentlogs/SourcesSidebar.tsx`), grouped by runtime (every
 *    runtime shown). It renders its own heading and its own loading / empty / unavailable
 *    (reason) states, and holds the 3 s `procs_list` poll while mounted. `onSelect(null)` = the
 *    selected row was clicked again (deselected). The selected key is already in
 *    `useProcsStore` — `onSelect` is only for side effects, e.g. soloing the app's streams
 *    (`toggleOnlySource` with the sources from `streamsOf(state, app.key)`). Host slots:
 *    `leading` (the sidebar's "All apps" row), `renderUnder(app)` (the app's streams, under its
 *    row) and `trailing` (streams whose app exited); `liveKeys` = apps the host knows stream
 *    (the Service tailing an app's console, matched by path).
 *
 * 2. **App card** — above the stream (between the stream header and the list), in
 *    `agentlogs/AgentLogsPanel.tsx`:
 *      const app = useSelectedDevApp();
 *      {app && <DevAppCard app={app}
 *                 onStreamStarted={(source) => soloSource(source)}
 *                 onOpenTerminal={(terminalId) => focusTerminal(terminalId)}
 *                 onShowConnections={(pid) => openWholeMacOnPid(pid)} />}
 *    `useSelectedDevApp()` goes null when the app exits, which unmounts the card. Clearing the
 *    selection when the user picks another source (All, a terminal…) is `selectDevApp(null)`
 *    (`agentlogs/agentLogsAppSelection.ts`). `onShowConnections` switches Network to Whole Mac
 *    with that app selected (`network/machineStore.revealMachinePid`; `machineStore`'s
 *    `selectApp` keys are `name:pid`). The card also takes `onShowRequests`
 *    (→ `agentlogs/agentLogsFocus.showRequestsOf`), `terminalTitle` and `serviceTailing` (both
 *    from the panel, which owns the fleet and the lines).
 *
 * 3. **Grouping `kind: "app"` lines** — streams started here log with `kind: "app"` and
 *    `source` `<name> · <file>` / `<name> · docker`. Such a source belongs under its DevApp row:
 *    `devAppForSource(source, apps)` (prefix `<name> · `, longest name wins; used by
 *    `agentlogs/agentLogsApps.ts`). A source no listed app claims (the app exited, the tail
 *    lives on) is shown as its own row, like a service.
 */

export { DevAppsSection, RuntimeBadge, type DevAppsSectionProps } from "./DevAppsSection";
export { DevAppCard, type DevAppCardProps } from "./DevAppCard";
export { devAppForSource } from "./procsFormat";
export {
  selectDevApp,
  streamsOf,
  useProcsStore,
  useSelectedDevApp,
  type ActiveStream,
} from "./procsStore";
export type { DevApp, DevRuntime, ProcsList } from "./procsTypes";
