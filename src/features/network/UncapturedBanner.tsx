/** One line per IDE app whose env no longer points at the proxy (`DevApp.captured === false`).
 * Reports only what Rust can verify (the env), not a per-request `--noproxy`. Holds the
 * `procs_list` poll while mounted; renders the restart confirm for the Apps sidebar's ⚠ rows. */

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
