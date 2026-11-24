/**
 * UncapturedBanner — the capture guard in Network › IDE traffic (an agent can run
 * `gazelle` with every proxy variable stripped and its own `curl --noproxy '*'`, so none of
 * that traffic reaches this view — and the view must say so).
 *
 * One line per IDE app whose environment no longer points at the IDE's proxy (Rust's
 * `DevApp.captured === false`, `procsFormat.uncapturedApps`): "Not captured: gazelle (pid N) —
 * started without the IDE's proxy." with **Restart with capture** (the dev-app card's confirm,
 * `RestartDialog capture`, then the new terminal gets a focused tab — the card's own path) and
 * **Show app** (Logs with that app selected — its card says the same and offers the same).
 * Renders nothing while every IDE app is captured, or before the first `procs_list`.
 *
 * DECIDED: a per-request `--noproxy` cannot be seen from outside the process, so it is not
 * claimed here; the banner reports exactly what Rust can verify — the app's environment.
 *
 * Holds the `procs_list` poll while mounted (the Network view may be open with Logs closed).
 * The restart flow state is the procs store's, so a failure survives a tab switch;
 * the confirm for a restart asked from the Apps sidebar's ⚠ row is rendered here too, since the
 * banner lists exactly the apps that row offers it for.
 */

import { useAppStore } from "../../app/store";
import { selectAppInLogs } from "../agentlogs/agentLogsAppSelection";
import { uncapturedApps } from "../procs/procsFormat";
import { requestRestart, useProcsPolling, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { RestartWithCaptureFlow } from "./IdeAppCapture";
import "../procs/procs.css";

export function uncapturedLine(app: Pick<DevApp, "name" | "pid">): string {
  return `Not captured: ${app.name} (pid ${app.pid}) — started without the IDE's proxy.`;
}

export function UncapturedBanner(): React.JSX.Element | null {
  useProcsPolling();
  const apps = useProcsStore((s) => s.list?.apps);
  const list = uncapturedApps(apps ?? []);
  if (list.length === 0) return null;
  return (
    <div className="net-uncaptured" role="alert" data-testid="net-uncaptured">
      {list.map((app) => (
        <div key={app.key} className="net-uncaptured__row" data-testid="net-uncaptured-row" data-key={app.key}>
          <span>⚠ {uncapturedLine(app)}</span>
          <button type="button" className="net-uncaptured__btn" data-testid="net-uncaptured-restart" onClick={() => requestRestart(app.key)}>
            Restart with capture
          </button>
          <button
            type="button"
            className="net-uncaptured__btn"
            data-testid="net-uncaptured-show"
            onClick={() => {
              selectAppInLogs(app);
              useAppStore.getState().layoutActions.openAgentLogsTab();
            }}
          >
            Show app
          </button>
          <RestartWithCaptureFlow app={app} />
        </div>
      ))}
    </div>
  );
}
