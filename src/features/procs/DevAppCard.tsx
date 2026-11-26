/** The selected dev app's card above the Logs stream. A console redirected to a file shows its
 * files on the Console line, not in Log files, so no file has two Stream buttons. IDE-started apps
 * never offer Restart in the IDE. All flow state is in the store, so a tab switch keeps it. */

import { useState } from "react";

import { IdeAppCapture } from "../network/IdeAppCapture";
import { modeLabel } from "../network/machineFormat";
import { useMachineStore } from "../network/machineStore";

import { basename, commandLine, formatUptime, processNameOf, streamId } from "./procsFormat";
import {
  cancelRestart,
  confirmRestart,
  dismissStreamError,
  pickAndStream,
  requestRestart,
  startStream,
  stopStream,
  useProcsPolling,
  useProcsStore,
} from "./procsStore";
import { RUNTIME_LABELS, type DevApp, type DevLogFile } from "./procsTypes";
import { RestartDialog } from "./RestartDialog";
import { RuntimeBadge } from "./DevAppsSection";
import "./procs.css";

export const CONSOLE_UNREADABLE =
  "This app prints to a terminal outside the IDE — the system doesn't let another app read that console.";
export const CONSOLE_NONE = "This app has no console — its output is discarded.";

/** A service stream that already tails a file. */
export interface TailedBy {
  /** Its wire label — what the Logs view solos. */
  source: string;
  /** Its display name (`gazelle`, not `gazelle · bg`). */
  name: string;
}

export interface DevAppCardProps {
  app: DevApp;
  /** A stream to solo, by `source`: one just started here, or the service stream already tailing
   * one of the app's files ("Already streaming as …"). */
  onStreamStarted: (source: string) => void;
  /** Restart in the IDE succeeded, or "Open terminal" on an `ide-terminal` console: focus/open this terminal. */
  onOpenTerminal: (terminalId: string) => void;
  /** A port's "connections →": open Network › Whole Mac on this pid. */
  onShowConnections: (pid: number) => void;
  /** An IDE app's "requests →": open Network › IDE traffic with the Process picker on this name. */
  onShowRequests: (processName: string) => void;
  /** The current title of `app.terminalId`'s tab, or null when no tab holds it (falls back to `launchedBy`). */
  terminalTitle: string | null;
  /** The service stream already tailing `path`, or null — decided by the Logs view, which owns the lines. */
  serviceTailing: (path: string) => TailedBy | null;
}

function StreamToggle({
  app,
  path,
  label,
  onStreamStarted,
  serviceTailing,
}: {
  app: DevApp;
  path: string | null;
  label: string;
  onStreamStarted: (source: string) => void;
  serviceTailing: (path: string) => TailedBy | null;
}): React.JSX.Element {
  const id = streamId(app.key, path);
  const active = useProcsStore((s) => s.streams.some((x) => x.id === id));
  const busy = useProcsStore((s) => s.busy.includes(id));
  // A tail started here stays stoppable here, even if a service began tailing the same file since.
  const tailedBy = active || path === null ? null : serviceTailing(path);
  if (tailedBy !== null) {
    return (
      <span className="procs-card__already" data-testid="procs-already" data-stream={path as string}>
        Already streaming as{" "}
        <button
          type="button"
          className="procs-card__link"
          data-testid="procs-already-link"
          title={`Show the ${tailedBy.name} stream — it already tails ${label}`}
          onClick={() => onStreamStarted(tailedBy.source)}
        >
          {tailedBy.name}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`procs-card__btn${active ? " procs-card__btn--on" : ""}`}
      data-testid="procs-stream-toggle"
      data-stream={path ?? "docker"}
      aria-label={`${active ? "Stop" : "Stream"} ${label}`}
      disabled={busy}
      onClick={() => {
        if (active) {
          void stopStream(id);
          return;
        }
        void startStream(app, path).then((source) => {
          if (source !== null) onStreamStarted(source);
        });
      }}
    >
      {busy ? "…" : active ? "Stop" : "Stream"}
    </button>
  );
}

/** What an `ide`-origin app whose console is a terminal/pipe the IDE cannot read says instead of offering a Restart. */
export function ideOwnedConsole(app: Pick<DevApp, "console" | "launchedBy">): string {
  return `Its console is a ${app.console} held by ${app.launchedBy ?? "the IDE"} — its output shows in that stream, not here.`;
}

function ConsoleLine({
  app,
  terminalTitle,
  onStreamStarted,
  onOpenTerminal,
  serviceTailing,
}: {
  app: DevApp;
  terminalTitle: string | null;
  onStreamStarted: (source: string) => void;
  onOpenTerminal: (terminalId: string) => void;
  serviceTailing: (path: string) => TailedBy | null;
}): React.JSX.Element {
  if (app.containerId !== null) {
    return (
      <div className="procs-card__console" data-testid="procs-console" data-console="docker">
        <span>
          Console is <code>docker logs {app.containerId.slice(0, 12)}</code>
        </span>
        <StreamToggle app={app} path={null} label="docker logs" onStreamStarted={onStreamStarted} serviceTailing={serviceTailing} />
      </div>
    );
  }
  if (app.console === "file") {
    const files = app.logFiles.filter((f) => f.kind !== "log");
    return (
      <div className="procs-card__console" data-testid="procs-console" data-console="file">
        {files.length === 0 ? (
          <span>Console is written to a file the IDE can&apos;t see.</span>
        ) : (
          files.map((f) => (
            <div key={f.path} className="procs-card__console-file">
              <span title={f.path}>
                Console{f.kind === "stderr" ? " (stderr)" : ""} is written to <code>{basename(f.path)}</code>
              </span>
              <StreamToggle app={app} path={f.path} label={basename(f.path)} onStreamStarted={onStreamStarted} serviceTailing={serviceTailing} />
            </div>
          ))
        )}
      </div>
    );
  }
  if (app.console === "ide-terminal" && app.terminalId !== null) {
    const terminalId = app.terminalId;
    const title = terminalTitle ?? app.launchedBy ?? terminalId;
    return (
      <div className="procs-card__console" data-testid="procs-console" data-console="ide-terminal">
        <span>
          Console is the terminal <strong data-testid="procs-console-terminal">{title}</strong>
        </span>
        <button
          type="button"
          className="procs-card__btn procs-card__btn--primary"
          data-testid="procs-open-terminal"
          onClick={() => onOpenTerminal(terminalId)}
        >
          Open terminal
        </button>
      </div>
    );
  }
  if (app.console === "none") {
    return (
      <div className="procs-card__console" data-testid="procs-console" data-console="none">
        {CONSOLE_NONE}
      </div>
    );
  }
  // An app the IDE started is already in the IDE: no Restart. Its terminal or
  // pipe belongs to the IDE terminal / agent that launched it, whose stream shows its output.
  // (`ide-terminal` without a terminal id — Rust lost the terminal — lands here too.)
  if (app.origin === "ide") {
    return (
      <div className="procs-card__console" data-testid="procs-console" data-console={app.console}>
        {ideOwnedConsole(app)}
      </div>
    );
  }
  // terminal / pipe: owned by another program's pty or pipe — unreadable from here.
  return (
    <div className="procs-card__console" data-testid="procs-console" data-console={app.console}>
      <span>{CONSOLE_UNREADABLE}</span>
      {app.pid !== null && (
        <button
          type="button"
          className="procs-card__btn procs-card__btn--primary"
          data-testid="procs-restart"
          onClick={() => requestRestart(app.key)}
        >
          Restart in the IDE
        </button>
      )}
    </div>
  );
}

export function DevAppCard({
  app,
  onStreamStarted,
  onOpenTerminal,
  onShowConnections,
  onShowRequests,
  terminalTitle,
  serviceTailing,
}: DevAppCardProps): React.JSX.Element {
  useProcsPolling();
  // The clock is the last poll, not `Date.now()`: render stays pure, and uptime ticks with the
  // 3 s poll. Before the first poll lands there is no uptime to show.
  const polledAt = useProcsStore((s) => s.polledAtMs);
  const streams = useProcsStore((s) => s.streams);
  const streamError = useProcsStore((s) => s.streamErrors[app.key] ?? null);
  const restart = useProcsStore((s) => (s.restart?.appKey === app.key ? s.restart : null));
  const machineView = modeLabel(useMachineStore((s) => s.status?.backend));
  const [copied, setCopied] = useState(false);

  const cmd = commandLine(app.argv);
  // Only an IDE app's traffic goes through the IDE's proxy, so only it has "requests" to show.
  const processName = app.origin === "ide" ? processNameOf(app) : null;
  const listed: DevLogFile[] =
    app.console === "file" && app.containerId === null ? app.logFiles.filter((f) => f.kind === "log") : app.logFiles;
  const known = new Set(app.logFiles.map((f) => f.path));
  const picked = streams.filter((s) => s.appKey === app.key && s.path !== null && !known.has(s.path));

  const copyCwd = (cwd: string): void => {
    void navigator.clipboard.writeText(cwd).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <section className="procs-card" data-testid="procs-card" data-key={app.key} aria-label={`${app.name} — ${RUNTIME_LABELS[app.runtime]} app`}>
      <header className="procs-card__head">
        <RuntimeBadge app={app} />
        <strong className="procs-card__name">{app.name}</strong>
        <span className="procs-card__meta" data-testid="procs-card-id">
          {app.pid === null ? `container ${app.containerId ?? "?"}` : `pid ${app.pid}`}
        </span>
        {app.startedMs !== null && polledAt !== null && (
          <span className="procs-card__meta" data-testid="procs-card-uptime" title={new Date(app.startedMs).toLocaleString()}>
            up {formatUptime(polledAt - app.startedMs)}
          </span>
        )}
      </header>

      <dl className="procs-card__facts">
        {app.cwd !== null && (
          <>
            <dt>cwd</dt>
            <dd className="procs-card__cwd">
              <code title={app.cwd}>{app.cwd}</code>
              <button
                type="button"
                className="procs-card__link"
                data-testid="procs-copy-cwd"
                aria-label="Copy the working directory"
                onClick={() => copyCwd(app.cwd as string)}
              >
                {copied ? "copied" : "copy"}
              </button>
            </dd>
          </>
        )}
        {app.argv.length > 0 && (
          <>
            <dt>command</dt>
            <dd className="procs-card__cmd" data-testid="procs-card-cmd" title={cmd}>
              {cmd}
            </dd>
          </>
        )}
        {app.ports.length > 0 && (
          <>
            <dt>ports</dt>
            <dd className="procs-card__ports">
              {app.ports.map((p) => (
                <span key={p} className="procs-card__port" data-testid="procs-card-port">
                  <code>:{p}</code>
                  {app.pid !== null && (
                    <button
                      type="button"
                      className="procs-card__link"
                      data-testid="procs-connections"
                      title={`Show this app's connections in Network › ${machineView}`}
                      onClick={() => onShowConnections(app.pid as number)}
                    >
                      connections →
                    </button>
                  )}
                </span>
              ))}
            </dd>
          </>
        )}
        {processName !== null && (
          <>
            <dt>network</dt>
            <dd className="procs-card__net">
              <button
                type="button"
                className="procs-card__link"
                data-testid="procs-requests"
                title={`Show this app's requests in Network › IDE traffic (Process: ${processName})`}
                onClick={() => onShowRequests(processName)}
              >
                requests →
              </button>
            </dd>
          </>
        )}
      </dl>

      {app.origin === "ide" && (
        <IdeAppCapture
          app={app}
          source={terminalTitle ?? app.launchedBy ?? "its terminal"}
          onShowRequests={onShowRequests}
          onShowConnections={onShowConnections}
        />
      )}

      <ConsoleLine
        app={app}
        terminalTitle={terminalTitle}
        onStreamStarted={onStreamStarted}
        onOpenTerminal={onOpenTerminal}
        serviceTailing={serviceTailing}
      />

      {app.containerId === null && (
        <div className="procs-card__logs">
          <div className="procs-card__subhead">Log files</div>
          {listed.length === 0 && picked.length === 0 && (
            <p className="procs-card__none" data-testid="procs-no-logs">
              No open log files found.
            </p>
          )}
          <ul className="procs-card__files">
            {listed.map((f) => (
              <li key={f.path} data-testid="procs-log-file" data-path={f.path}>
                <code title={f.path}>{basename(f.path)}</code>
                {f.kind !== "log" && <span className="procs-card__kind">{f.kind}</span>}
                <StreamToggle app={app} path={f.path} label={basename(f.path)} onStreamStarted={onStreamStarted} serviceTailing={serviceTailing} />
              </li>
            ))}
            {picked.map((s) => (
              <li key={s.id} data-testid="procs-log-file" data-path={s.path}>
                <code title={s.path as string}>{basename(s.path as string)}</code>
                <span className="procs-card__kind">picked</span>
                <StreamToggle app={app} path={s.path} label={basename(s.path as string)} onStreamStarted={onStreamStarted} serviceTailing={serviceTailing} />
              </li>
            ))}
          </ul>
          {app.pid !== null && (
            <button
              type="button"
              className="procs-card__link"
              data-testid="procs-pick-file"
              onClick={() =>
                void pickAndStream(app).then((source) => {
                  if (source !== null) onStreamStarted(source);
                })
              }
            >
              Pick a log file…
            </button>
          )}
        </div>
      )}

      {streamError !== null && (
        <p className="procs-card__error" role="alert" data-testid="procs-stream-error">
          {streamError}{" "}
          <button type="button" className="procs-card__link" aria-label="Dismiss" onClick={() => dismissStreamError(app.key)}>
            ✕
          </button>
        </p>
      )}
      {restart?.phase === "failed" && (
        <p className="procs-card__error" role="alert" data-testid="procs-restart-error">
          {restart.error}{" "}
          <button type="button" className="procs-card__link" aria-label="Dismiss" onClick={cancelRestart}>
            ✕
          </button>
        </p>
      )}
      {restart !== null && restart.phase !== "failed" && (
        <RestartDialog
          app={app}
          capture={app.captured === false}
          running={restart.phase === "running"}
          onCancel={cancelRestart}
          onConfirm={() =>
            void confirmRestart(app).then((terminalId) => {
              if (terminalId !== null) onOpenTerminal(terminalId);
            })
          }
        />
      )}
    </section>
  );
}
