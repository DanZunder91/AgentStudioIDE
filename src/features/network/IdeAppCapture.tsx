/**
 * IdeAppCapture — what an IDE-started app's capture looks like, in words the user can act on
 * (the bug: for `gazelle`, started by an agent with the proxy variables stripped, Whole Mac's
 * guide showed the EXTERNAL-app steps — set `HTTPS_PROXY` by hand, trust the CA in gazelle —
 * and "appear under IDE traffic as external · gazelle", which was wrong, and gave no way to
 * tell where to look). Shown by the dev-app card and by Whole Mac's guide for a row whose pid
 * is an IDE app. No manual env or certificate steps: the IDE owns an IDE app's environment.
 *
 * | state (`networkApps.captureState`) | shows |
 * |---|---|
 * | `uncaptured` | why (its launcher removed the proxy variables) · **Restart with capture** · "Right now — its live connections" from the Whole Mac sampler (what can be seen without capture) · "all connections in Whole Mac →" |
 * | `captured` | "✓ Receiving gazelle's requests — N so far" · **Show them** · where exactly they appear (Source, Process) · the Rust/Go decrypt caveat |
 * | `unknown` / `external` | nothing (the card's other lines cover it) |
 *
 * The restart confirm is rendered by the component that owns the restart flow on that screen: the
 * card renders its own `RestartDialog`; the guide passes `ownsDialog` ({@link
 * RestartWithCaptureFlow}).
 */

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

/**
 * "Right now — its live connections": the pid's sockets from the Whole Mac sampler (~1 s),
 * listeners left out (they are not calls). Samples while mounted — the sampler is shared and
 * ref-counted, so this adds nothing when Whole Mac is also open.
 */
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

/**
 * The restart-with-capture flow for a screen that has no dev-app card (Network's banner and
 * Apps sidebar, Whole Mac's guide): its failure line, and its confirm while one is requested
 * for this app. A confirmed restart focuses the new terminal, as the card does.
 */
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
