/** Capture status of an IDE-started app (dev-app card; Whole Mac's guide for an IDE app's pid).
 * No manual env or certificate steps: the IDE owns an IDE app's environment. The restart
 * confirm is rendered by the flow's owner: the card's RestartDialog or the guide (`ownsDialog`). */

import { useEffect, useMemo } from "react";

import { processNameOf } from "../procs/procsFormat";
import { cancelRestart, confirmRestart, requestRestart, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { RestartDialog } from "../procs/RestartDialog";
import { focusTerminalTab } from "../agentlogs/agentLogsFocus";
import { bytesCell, isListener, modeLabel, rateCell, remoteCell, remoteTitle } from "./machineFormat";
import { acquireMachine, releaseMachine, useMachineStore } from "./machineStore";
import {
  appFlowCount,
  captureState,
  ignoresIdeCa,
  LIVE_CONNS_NONE,
  LIVE_CONNS_TITLE,
  liveConnsWaiting,
  notCapturedText,
  receivingText,
  RUST_GO_CAVEAT,
  whereText,
} from "./networkApps";
import { useNetworkStore } from "./networkStore";

/** At most this many live connections are listed; the rest are counted. */
export const LIVE_CONNS_MAX = 8;

export interface IdeAppCaptureProps {
  app: DevApp;
  /** The Source label its flows carry in IDE traffic (its terminal's / agent's title). */
  source: string;
  onShowRequests: (process: string) => void;
  onShowConnections: (pid: number) => void;
  /** Render the restart confirm here (Whole Mac's guide); the card renders its own. */
  ownsDialog?: boolean;
}

export function IdeAppCapture({ app, source, onShowRequests, onShowConnections, ownsDialog = false }: IdeAppCaptureProps): React.JSX.Element | null {
  const flows = useNetworkStore((s) => s.flows);
  const apps = useProcsStore((s) => s.list?.apps);
  const count = useMemo(() => appFlowCount(flows, app, apps ?? [app]), [flows, app, apps]);
  const state = captureState(app, count);
  const process = processNameOf(app);
  const machineView = modeLabel(useMachineStore((s) => s.status?.backend));

  if (state === "uncaptured" && app.pid !== null) {
    const pid = app.pid;
    return (
      <div className="net-idecap net-idecap--off" data-testid="net-idecap" data-state="uncaptured">
        <p className="net-idecap__why" data-testid="procs-uncaptured">
          ⚠ {notCapturedText(app.name)}
        </p>
        <button type="button" className="net-idecap__primary" data-testid="procs-restart-capture" onClick={() => requestRestart(app.key)}>
          Restart with capture
        </button>
        <LiveConnections pid={pid} />
        <button type="button" className="net-idecap__link" data-testid="net-idecap-all-conns" onClick={() => onShowConnections(pid)}>
          all connections in {machineView} →
        </button>
        {ownsDialog ? <RestartWithCaptureFlow app={app} /> : null}
      </div>
    );
  }
  if (state === "captured" && app.origin === "ide") {
    return (
      <div className="net-idecap net-idecap--on" data-testid="net-idecap" data-state="captured">
        <p className="net-idecap__ok" data-testid="net-idecap-receiving">
          {receivingText(app.name, count)}
          {process !== null ? (
            <>
              {" "}
              <button type="button" className="net-idecap__link" data-testid="net-idecap-show" onClick={() => onShowRequests(process)}>
                Show them
              </button>
            </>
          ) : null}
        </p>
        <p className="net-idecap__where" data-testid="net-idecap-where">
          {whereText(source, process)}
        </p>
        {ignoresIdeCa(app.runtime) ? (
          <p className="net-idecap__caveat" data-testid="net-idecap-caveat">
            {RUST_GO_CAVEAT}
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

/** The pid's live sockets (listeners excluded) from the Whole Mac sampler while mounted.
 * The sampler is shared and ref-counted, so this adds nothing when Whole Mac is also open. */
export function LiveConnections({ pid }: { pid: number }): React.JSX.Element {
  useEffect(() => {
    acquireMachine();
    return releaseMachine;
  }, []);
  const latest = useMachineStore((s) => s.latest);
  const backend = useMachineStore((s) => s.status?.backend);
  const conns = (latest?.apps.find((a) => a.pid === pid)?.connections ?? []).filter((c) => !isListener(c));
  return (
    <div className="net-idecap__conns" data-testid="net-idecap-conns">
      <div className="net-idecap__subhead">{LIVE_CONNS_TITLE}</div>
      {latest === null ? (
        <p className="net-idecap__dim">{liveConnsWaiting(modeLabel(backend))}</p>
      ) : conns.length === 0 ? (
        <p className="net-idecap__dim">{LIVE_CONNS_NONE}</p>
      ) : (
        <table className="net-idecap__table">
          <tbody>
            {conns.slice(0, LIVE_CONNS_MAX).map((c) => (
              <tr key={`${c.proto}|${c.local}|${c.remote as string}`} data-testid="net-idecap-conn">
                <td title={remoteTitle(c)}>{remoteCell(c)}</td>
                <td>{c.state}</td>
                <td title="received / sent">
                  ↓{bytesCell(c.bytesIn)} ↑{bytesCell(c.bytesOut)}
                </td>
                <td title="receive / send rate">
                  ↓{rateCell(c.rateIn)} ↑{rateCell(c.rateOut)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {conns.length > LIVE_CONNS_MAX ? (
        <p className="net-idecap__dim" data-testid="net-idecap-more">
          …and {conns.length - LIVE_CONNS_MAX} more
        </p>
      ) : null}
    </div>
  );
}

/** Restart-with-capture flow for screens with no dev-app card (Network banner, Apps sidebar,
 * Whole Mac's guide): failure line and confirm. A confirmed restart focuses the new terminal. */
export function RestartWithCaptureFlow({ app }: { app: DevApp }): React.JSX.Element | null {
  const restart = useProcsStore((s) => (s.restart?.appKey === app.key ? s.restart : null));
  if (restart === null) return null;
  if (restart.phase === "failed") {
    return (
      <span className="net-uncaptured__error" role="alert" data-testid="net-uncaptured-error">
        {restart.error}{" "}
        <button type="button" className="net-uncaptured__btn" aria-label="Dismiss" onClick={cancelRestart}>
          ✕
        </button>
      </span>
    );
  }
  return (
    <RestartDialog
      app={app}
      capture
      running={restart.phase === "running"}
      onCancel={cancelRestart}
      onConfirm={() =>
        void confirmRestart(app).then((terminalId) => {
          if (terminalId !== null) focusTerminalTab(terminalId, app.name, app.cwd);
        })
      }
    />
  );
}
