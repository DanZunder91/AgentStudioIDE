/** The Apps group of the Logs Sources sidebar, one sub-section per runtime, all shown even empty;
 * open/closed lives in the store (tab switches remount). Holds the `procs_list` poll while mounted.
 * Host slots let Network's Apps sidebar reuse it unforked; unused, the Logs row is unchanged. */

import { Fragment } from "react";

import { APPS_TITLE, commandLine, groupByRuntime, originTag, portsLabel, RUNTIME_SECTION_LABELS, uncapturedText } from "./procsFormat";
import { runtimeSectionOpen, selectDevApp, toggleRuntimeSection, useProcsPolling, useProcsStore } from "./procsStore";
import { RUNTIME_LABELS, type DevApp } from "./procsTypes";
import "./procs.css";

export const DEV_APPS_EMPTY = "No JVM, Node, Rust, Python, Go or Docker apps running.";
export const DEV_APPS_LOADING = "Looking for dev apps…";

export function RuntimeBadge({ app }: { app: DevApp }): React.JSX.Element {
  return (
    <span className={`procs-badge procs-badge--${app.runtime}`} data-testid="procs-badge" data-runtime={app.runtime}>
      {RUNTIME_LABELS[app.runtime]}
    </span>
  );
}

function rowTitle(app: DevApp): string {
  return [
    app.pid === null ? `container ${app.containerId ?? "?"}` : `pid ${app.pid}`,
    app.cwd ?? undefined,
    app.argv.length > 0 ? commandLine(app.argv) : undefined,
  ]
    .filter((x) => x !== undefined)
    .join("\n");
}

const NO_LABEL = (): string | null => null;

export interface DevAppsSectionProps {
  /** The Logs selection changed (not called when the host takes the click with `onRowClick`). */
  onSelect?: (app: DevApp | null) => void;
  /** The host's name for who launched an IDE app (its sidebar label), or null to use Rust's. */
  launcherLabel?: (app: DevApp) => string | null;
  /** Right under the heading, in every state — the host's "All apps" row. */
  leading?: React.ReactNode;
  /** Rows shown under `app`'s row — the host's log streams of that app. */
  renderUnder?: (app: DevApp) => React.ReactNode;
  /** Rows after the list, in every state (loading, empty, unavailable, listed). */
  trailing?: React.ReactNode;
  /** Apps the host knows have a live log stream this section cannot see (e.g. a Service tailing the
   * console): they get ● and sort first, like an app streamed from its card. */
  liveKeys?: ReadonlySet<string>;
  /** Replaces the default click (the Logs selection): the host decides what a row click does. */
  onRowClick?: (app: DevApp) => void;
  /** Which rows are pressed, when the host owns the selection (with `onRowClick`). */
  isSelected?: (app: DevApp) => boolean;
  /** Before the row button — e.g. Network's checkbox. */
  rowLead?: (app: DevApp) => React.ReactNode;
  /** After the row button — e.g. Network's capture state and its action. Replaces the row's own ⚠. */
  rowTrail?: (app: DevApp) => React.ReactNode;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export const RUNTIME_NONE = "Nothing running";

export function DevAppsSection({
  onSelect,
  launcherLabel = NO_LABEL,
  leading,
  renderUnder,
  trailing,
  liveKeys = NO_KEYS,
  onRowClick,
  isSelected,
  rowLead,
  rowTrail,
}: DevAppsSectionProps): React.JSX.Element {
  useProcsPolling();
  const list = useProcsStore((s) => s.list);
  const error = useProcsStore((s) => s.listError);
  const selected = useProcsStore((s) => s.selectedKey);
  const streams = useProcsStore((s) => s.streams);
  const runtimeOpen = useProcsStore((s) => s.runtimeOpen);

  let body: React.ReactNode;
  if (list === null) {
    body = (
      <p className="procs-side__empty" data-testid="procs-empty">
        {error === null ? DEV_APPS_LOADING : `Could not list apps: ${error}`}
      </p>
    );
  } else if (!list.available) {
    body = (
      <p className="procs-side__empty" data-testid="procs-unavailable">
        {list.reason ?? "Not available on this system."}
      </p>
    );
  } else {
    // Two apps with the same name (e.g. two Node processes in one repo) are told apart by pid —
    // otherwise the sidebar shows two identical "repo" rows.
    const seen = new Map<string, number>();
    for (const a of list.apps) seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    const isLive = (app: DevApp): boolean => liveKeys.has(app.key) || streams.some((s) => s.appKey === app.key);
    const row = (app: DevApp): React.JSX.Element => {
      const live = isLive(app);
      const isSel = isSelected ? isSelected(app) : selected === app.key;
      const button = (
          <button
            type="button"
            className={`procs-side__row${isSel ? " procs-side__row--sel" : ""}`}
            data-testid="procs-row"
            data-key={app.key}
            data-origin={app.origin}
            data-runtime={app.runtime}
            aria-pressed={isSel}
            title={rowTitle(app)}
            onClick={() => {
              if (onRowClick) {
                onRowClick(app);
                return;
              }
              selectDevApp(isSel ? null : app.key);
              onSelect?.(isSel ? null : app);
            }}
          >
            <span className="procs-side__name">{app.name}</span>
            {(seen.get(app.name) ?? 0) > 1 && app.pid !== null && (
              <span className="procs-side__pid" data-testid="procs-pid">
                pid {app.pid}
              </span>
            )}
            {app.ports.length > 0 && (
              <span className="procs-side__ports" data-testid="procs-ports">
                {portsLabel(app.ports)}
              </span>
            )}
            <span className={`procs-side__tag procs-side__tag--${app.origin}`} data-testid="procs-origin">
              {originTag(app, launcherLabel(app))}
            </span>
            {app.origin === "ide" && app.captured === false && rowTrail === undefined && (
              <span className="procs-side__uncaptured" data-testid="procs-uncaptured-mark" aria-label="not captured" title={uncapturedText(app)}>
                ⚠
              </span>
            )}
            {live && (
              <span className="procs-side__live" data-testid="procs-live" aria-label="streaming" title="A log stream is running">
                ●
              </span>
            )}
          </button>
      );
      return (
        <Fragment key={app.key}>
          {rowLead || rowTrail ? (
            <div className="procs-side__line" data-testid="procs-line" data-key={app.key}>
              {rowLead?.(app)}
              {button}
              {rowTrail?.(app)}
            </div>
          ) : (
            button
          )}
          {renderUnder?.(app)}
        </Fragment>
      );
    };
    body = (
      <>
        {list.apps.length === 0 && (
          <p className="procs-side__empty" data-testid="procs-empty">
            {DEV_APPS_EMPTY}
          </p>
        )}
        {groupByRuntime(list.apps, isLive).map(({ runtime, apps }) => {
          const label = RUNTIME_SECTION_LABELS[runtime];
          const open = runtimeSectionOpen({ runtimeOpen }, runtime, apps.length);
          return (
            <div
              key={runtime}
              className={`procs-rt${apps.length === 0 ? " procs-rt--empty" : ""}`}
              role="group"
              aria-label={label}
              data-testid="procs-runtime"
              data-runtime={runtime}
              data-open={open}
            >
              <button
                type="button"
                className="procs-rt__head"
                data-testid="procs-runtime-head"
                aria-expanded={open}
                title={`${open ? "Hide" : "Show"} the ${label} apps`}
                onClick={() => toggleRuntimeSection(runtime, apps.length)}
              >
                <span className="procs-rt__caret" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span className="procs-rt__label">{label}</span>
                <span className="procs-rt__count" data-testid="procs-runtime-count">
                  {apps.length}
                </span>
              </button>
              {open &&
                (apps.length === 0 ? (
                  <p className="procs-rt__none" data-testid="procs-runtime-none">
                    {RUNTIME_NONE}
                  </p>
                ) : (
                  apps.map(row)
                ))}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div className="procs-side" role="group" aria-label={APPS_TITLE} data-testid="procs-section">
      <div className="procs-side__heading">
        {APPS_TITLE}
        {/* A poll that fails AFTER a good one keeps the last list and says so here. */}
        {list !== null && error !== null && (
          <span className="procs-side__stale" data-testid="procs-stale" title={`Could not refresh: ${error}`}>
            {" "}
            (stale)
          </span>
        )}
      </div>
      {/* Listed, with a partial note (`reason` while available — e.g. "Docker is not running"). */}
      {list !== null && list.available && list.reason !== null && (
        <p className="procs-side__note" data-testid="procs-note">
          {list.reason}
        </p>
      )}
      {leading}
      {body}
      {trailing}
    </div>
  );
}
