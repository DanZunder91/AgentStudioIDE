/** Logs panel navigation: one row per source (`agentLogsRunning.ts`), grouped Apps · Services ·
 * Terminals · Agents · Mac apps, All on top; a click solos the source. Names are display names;
 * `data-source` keeps the wire label (the key E2E specs select on). Apps: `agentLogsApps.ts`. */

import { useEffect, useMemo, useRef, useState } from "react";

import { DevAppsSection } from "../procs/DevAppsSection";
import { selectDevApp, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import {
  agentIdsBySource,
  allAppSources,
  appCountLabel,
  appsOfAgent,
  isExactPick,
  placeAppSources,
  streamLabel,
  launcherLabelOf,
} from "./agentLogsApps";
import { servicePaths } from "./agentLogsLinks";
import { selectAppInLogs } from "./agentLogsAppSelection";
import { appsLabel, displayName, sourceTag } from "./agentLogsFormat";
import {
  chipTitle,
  deriveRunning,
  groupLabel,
  groupSources,
  matchCountsBySource,
  visibleRunning,
  type RunningSource,
} from "./agentLogsRunning";
import { SIDEBAR_DEFAULT_WIDTH, useAgentLogsStore } from "./agentLogsStore";
import { renamedTerminalLabels } from "./agentLogsTitles";
import { useAppStore } from "../../app/store";

/** How often the "how long ago" in the rows' titles is refreshed. */
export const RUNNING_TICK_MS = 15_000;

const NO_APPS: readonly DevApp[] = [];

/** The empty sidebar's sentence; `machine` is the machine group's name ({@link appsLabel}). */
export function sourcesEmpty(machine: string): string {
  return `Nothing yet — terminals, services your agents start, agents and ${machine} you stream show up here.`;
}

function SourceRow({
  s,
  solo,
  now,
  machine,
  matches,
  label,
  nested = false,
  apps = NO_APPS,
  onPick,
}: {
  s: RunningSource;
  solo: boolean;
  now: number;
  machine: string;
  /** The match count under the active content filter, or null when none is active. */
  matches: number | null;
  /** The row's text in place of the display name — a dev app's stream reads `server.log` under its app. */
  label?: string;
  /** Under a dev app's row (indented). */
  nested?: boolean;
  /** An agent's running IDE apps — shown as `N apps`. */
  apps?: readonly DevApp[];
  /** In place of "solo this source" — a Service owned by an app selects that app. */
  onPick?: () => void;
}): React.JSX.Element {
  const actions = useAgentLogsStore.getState();
  const errorWord = s.errors === 1 ? "error" : "errors";
  const name = label ?? displayName(s.source);
  const tag = sourceTag(s.source);
  // The row a user is looking for: a service that is up right now.
  const emphasised = s.kind === "task" && s.running;
  return (
    <div
      className={`alog-side__row${s.running ? "" : " alog-side__row--stopped"}${solo ? " alog-side__row--solo" : ""}${emphasised ? " alog-side__row--emph" : ""}${nested ? " alog-side__row--nested" : ""}`}
      data-testid="alog-src-row"
      data-source={s.source}
      data-group={s.kind}
      data-running={s.running}
    >
      <button
        type="button"
        className="alog-side__main"
        aria-pressed={solo}
        title={chipTitle(s, now, machine)}
        onClick={onPick ?? (() => actions.toggleOnlySource(s.source))}
      >
        <span className={`alog-side__dot${s.running ? " alog-side__dot--on" : ""}`} aria-hidden="true">
          {s.running ? "●" : "○"}
        </span>
        <span className="alog-side__name">{name}</span>
        {tag !== null && (
          <span className="alog-tag" data-testid="alog-src-tag" aria-hidden="true">
            {tag}
          </span>
        )}
        {apps.length > 0 && (
          <span
            className="alog-tag alog-tag--apps"
            data-testid="alog-src-apps"
            title={`Running apps this agent started: ${apps.map((a) => a.name).join(", ")}`}
          >
            {appCountLabel(apps.length)}
          </span>
        )}
        {matches === null ? (
          <span className="alog-side__count" data-testid="alog-src-count">
            {s.lines}
          </span>
        ) : (
          <span
            className={`alog-side__matches${matches === 0 ? " alog-side__matches--none" : ""}`}
            data-testid="alog-src-matches"
            title={`${matches} of ${s.lines} lines match the filter`}
          >
            {matches}
          </span>
        )}
      </button>
      {s.errors > 0 && (
        <button
          type="button"
          className="alog-side__errors"
          data-testid="alog-src-errors"
          aria-label={`${s.errors} ${errorWord} in ${name} — jump to the first`}
          title={`${s.errors} ${errorWord}. Click: jump to the first. ↑/↓ while focused: step through them.`}
          onClick={() => actions.requestErrorJump(s.source, "first")}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            actions.requestErrorJump(s.source, e.key === "ArrowDown" ? "next" : "prev");
          }}
        >
          {s.errors}
        </button>
      )}
      {!s.running && (
        <button
          type="button"
          className="alog-side__dismiss"
          aria-label={`Dismiss ${name}`}
          title="Hide this stopped source (it comes back if it logs again)"
          onClick={() => actions.dismissRunning(s.source, s.lastId)}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function SourcesSidebar(): React.JSX.Element {
  const lines = useAgentLogsStore((s) => s.lines);
  const open = useAgentLogsStore((s) => s.sidebarOpen);
  const width = useAgentLogsStore((s) => s.sidebarWidth);
  const dismissed = useAgentLogsStore((s) => s.runningDismissed);
  const filter = useAgentLogsStore((s) => s.filter);
  const syslog = useAgentLogsStore((s) => s.syslog);
  const actions = useAgentLogsStore.getState();

  const streaming = syslog !== null && syslog.running && syslog.filter.enabled;
  const machine = appsLabel(syslog?.backend);
  const all = useMemo(() => deriveRunning(lines, streaming), [lines, streaming]);
  const shown = useMemo(() => visibleRunning(all, dismissed), [all, dismissed]);
  const apps = useProcsStore((s) => s.list?.apps ?? NO_APPS);
  const procStreams = useProcsStore((s) => s.streams);
  const paths = useMemo(() => servicePaths(lines), [lines]);
  const placed = useMemo(() => placeAppSources(shown, apps, paths), [shown, apps, paths]);
  const groups = useMemo(() => groupSources(shown), [shown]);
  const appSources = useMemo(() => {
    // Every stream the Apps group lists — a stopped one included: the row under its app still shows
    // its lines, so All apps must count and solo it too (it used to read "All apps 0" above
    // a stopped `probe.log · 12`).
    const out = allAppSources(apps, procStreams, all, paths, placed.unclaimed);
    for (const srcs of placed.byApp.values()) for (const src of srcs) if (!out.includes(src.source)) out.push(src.source);
    return out;
  }, [apps, procStreams, all, paths, placed]);
  const matches = useMemo(() => matchCountsBySource(lines, filter), [lines, filter]);
  const agentOf = useMemo(() => agentIdsBySource(lines), [lines]);
  const tabs = useAppStore((s) => s.tabs);
  const renamed = useMemo(() => renamedTerminalLabels(lines, tabs), [lines, tabs]);
  const runningCount = all.filter((s) => s.running).length;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), RUNNING_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const only = filter.onlySources;
  const everything = only === null && filter.hiddenSources.length === 0;
  const soloSource = only !== null && only.length === 1 ? only[0] : null;

  // A Service tailing an app's console keeps its Services row, named after the APP (the
  // service may be named after its launcher, `python3`), and a click on it selects the app —
  // the app row's click solos that same stream, so both rows read as selected.
  const serviceExtra = (src: RunningSource): Partial<Parameters<typeof SourceRow>[0]> => {
    const owner = placed.serviceOwners.get(src.source);
    if (owner === undefined) return {};
    return {
      label: owner.name,
      onPick: () => {
        if (soloSource !== src.source) {
          selectAppInLogs(owner);
          return;
        }
        selectDevApp(null);
        actions.setSourcePick([], null);
      },
    };
  };
  const extraOf = (kind: RunningSource["kind"], src: RunningSource): Partial<Parameters<typeof SourceRow>[0]> => {
    if (kind === "agent") return { apps: appsOfAgent(agentOf.get(src.source), apps) };
    if (kind === "task") return serviceExtra(src);
    // A terminal the user renamed reads by its name (the tab's, Network's), not its spawn label.
    if (kind === "terminal") {
      const label = renamed.get(src.source);
      return label === undefined ? {} : { label };
    }
    return {};
  };
  // Its count reads like All's: the lines of those streams — their matches while a filter is on.
  const linesBySource = new Map(all.map((x) => [x.source, x.lines]));
  const appsCount = appSources.reduce((n, source) => n + ((matches ?? linesBySource).get(source) ?? 0), 0);
  const allAppsOn = isExactPick(only, appSources);
  const allAppsRow = (
    // The title lives on a wrapper: a disabled button never shows its own.
    <span className="alog-side__allapps-wrap" title={appSources.length === 0 ? "No app streams anything yet — Stream a log from an app's card" : "Every app's log streams, together"}>
      <button
        type="button"
        className="alog-side__all alog-side__all--apps"
        data-testid="alog-src-all-apps"
        aria-pressed={allAppsOn}
        disabled={appSources.length === 0}
        onClick={() => (allAppsOn ? actions.setSourcePick([], null) : actions.soloSources(appSources))}
      >
        <span className="alog-side__name">All apps</span>
        <span className="alog-side__count">{appsCount}</span>
      </button>
    </span>
  );
  const rowOf = (src: RunningSource, extra: Partial<Parameters<typeof SourceRow>[0]> = {}): React.JSX.Element => (
    <SourceRow
      key={src.source}
      s={src}
      solo={soloSource === src.source}
      now={now}
      machine={machine}
      matches={matches === null ? null : (matches.get(src.source) ?? 0)}
      {...extra}
    />
  );
  const onSelectApp = (app: DevApp | null): void => {
    if (app === null) {
      actions.setSourcePick([], null);
      return;
    }
    selectAppInLogs(app);
  };

  if (!open) {
    return (
      <div className="alog-side alog-side--closed" data-testid="alog-sidebar" role="navigation" aria-label="Log sources">
        <button
          type="button"
          className="alog-side__toggle"
          aria-expanded={false}
          aria-label="Show sources"
          title={`Show the sources sidebar (${runningCount} running)`}
          onClick={() => actions.setSidebarOpen(true)}
        >
          ▸
        </button>
      </div>
    );
  }

  return (
    <div
      className="alog-side"
      data-testid="alog-sidebar"
      role="navigation"
      aria-label="Log sources"
      style={{ width, flexBasis: width }}
    >
      <SidebarResizer width={width} />
      <div className="alog-side__head">
        <span className="alog-side__title">
          Sources <span className="alog-side__total">{runningCount} running</span>
        </span>
        <button
          type="button"
          className="alog-side__toggle"
          aria-expanded={true}
          aria-label="Hide sources"
          title="Hide the sources sidebar"
          onClick={() => actions.setSidebarOpen(false)}
        >
          ◂
        </button>
      </div>
      <div className="alog-side__list">
        <button
          type="button"
          className="alog-side__all"
          data-testid="alog-src-all"
          aria-pressed={everything}
          title="Every source, one stream"
          onClick={() => actions.setSourcePick([], null)}
        >
          <span className="alog-side__name">All</span>
          <span className="alog-side__count">{matches === null ? lines.length : [...matches.values()].reduce((a, b) => a + b, 0)}</span>
        </button>
        <DevAppsSection
          onSelect={onSelectApp}
          launcherLabel={(app) => launcherLabelOf(app, lines, renamed)}
          leading={allAppsRow}
          renderUnder={(app) => placed.byApp.get(app.key)?.map((src) => rowOf(src, { label: streamLabel(src.source, app), nested: true }))}
          trailing={placed.unclaimed.map((src) => rowOf(src))}
          liveKeys={placed.liveKeys}
        />
        {shown.length === 0 ? (
          <p className="alog-side__empty" data-testid="alog-src-empty">
            {sourcesEmpty(machine)}
          </p>
        ) : (
          // The `app` group is not rendered here: its rows live in the Apps section above.
          groups
            .filter((g) => g.kind !== "app")
            .map((g) => {
              const label = groupLabel(g.kind, machine);
              return (
                <div key={g.kind} className="alog-side__group" role="group" aria-label={label} data-testid="alog-src-group">
                  <div className="alog-side__heading">{label}</div>
                  {g.sources.map((src) => rowOf(src, extraOf(g.kind, src)))}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}

/** The sidebar's right-edge drag handle (pointer drag; ←/→ by 10, Shift by 40; double-click resets). */
function SidebarResizer({ width }: { width: number }): React.JSX.Element {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number): void => useAgentLogsStore.getState().setSidebarWidth(w);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sources sidebar"
      aria-valuenow={width}
      tabIndex={0}
      className="alog-side__resizer"
      data-testid="alog-side-resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, w: width };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) set(drag.current.w + (e.clientX - drag.current.x));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => set(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowRight") set(width + step);
        else if (e.key === "ArrowLeft") set(width - step);
        else return;
        e.preventDefault();
      }}
    />
  );
}
