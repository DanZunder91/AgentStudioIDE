/** IDE traffic's left sidebar: `procs/DevAppsSection`'s Apps list (picks live in `networkStore`)
 * plus Terminals / Agents / Other source rows sharing `sourceSelection` with the toolbar's Source
 * picker. Copies each origin tag's text onto its `title`, as DevAppsSection gives it none. */

import { useLayoutEffect, useMemo, useRef } from "react";

import { terminalCustomTitles } from "../agentlogs/agentLogsTitles";
import { DevAppsSection } from "../procs/DevAppsSection";
import { uncapturedText } from "../procs/procsFormat";
import { requestRestart, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { useAppStore } from "../../app/store";
import type { PickerRow } from "./networkSource";
import { modeLabel } from "./machineFormat";
import { revealMachinePid, useMachineStore } from "./machineStore";
import { appFlowCount, captureState, pickOf } from "./networkApps";
import { tableFlows } from "./networkFilter";
import { groupedSourceItems, type SourceGroup } from "./networkSource";
import {
  allAppPicks,
  allSidebarPicks,
  NET_SIDEBAR_DEFAULT_WIDTH,
  onlyAppPick,
  onlySourcePick,
  setNetSidebarWidth,
  setNetworkMode,
  toggleAppPick,
  toggleSourcePick,
  useNetworkStore,
} from "./networkStore";

export const ALL_APPS = "All apps";
export const ALL_SOURCES = "All";

/** The source groups, in the Logs sidebar's order, with their headings. */
export const SOURCE_GROUPS: readonly (readonly [SourceGroup, string])[] = [
  ["terminals", "Terminals"],
  ["agents", "Agents"],
  ["other", "Other"],
];

export function NetworkAppsSidebar(): React.JSX.Element {
  const selection = useNetworkStore((s) => s.appSelection);
  // Counted like the table: one row per call (networkFilter.tableFlows).
  const ring = useNetworkStore((s) => s.flows);
  const flows = useMemo(() => tableFlows(ring), [ring]);
  const apps = useProcsStore((s) => s.list?.apps);
  const listed = useMemo(() => apps ?? [], [apps]);
  const picked = useMemo(() => new Set((selection ?? []).map((p) => p.key)), [selection]);
  const gone = (selection ?? []).filter((p) => !listed.some((a) => a.key === p.key));
  const sourceSelection = useNetworkStore((s) => s.sourceSelection);
  const width = useNetworkStore((s) => s.sidebarWidth);
  const tabs = useAppStore((s) => s.tabs);
  const agents = useAppStore((s) => s.agents);
  const closedTitles = useNetworkStore((s) => s.terminalTitles);
  const groups = useMemo(() => groupedSourceItems(flows, tabs, agents, closedTitles), [flows, tabs, agents, closedTitles]);
  // The origin tag names a renamed launcher terminal by its live title (`by gazelle`, like its
  // Terminals row), not Rust's spawn-time `bash`.
  const renamed = useMemo(() => terminalCustomTitles(tabs), [tabs]);
  const machineView = modeLabel(useMachineStore((s) => s.status?.backend));
  const aside = useRef<HTMLElement>(null);

  // The origin tags' full text on hover (module doc, "Width") — after every render, as the rows change.
  useLayoutEffect(() => {
    for (const tag of (aside.current as HTMLElement).querySelectorAll<HTMLElement>('[data-testid="procs-origin"]')) {
      tag.title = tag.textContent as string;
    }
  });

  const lead = (app: DevApp): React.ReactNode => (
    <input
      type="checkbox"
      className="net-apps__check"
      data-testid="net-app-check"
      aria-label={`Show ${app.name}'s requests`}
      checked={picked.has(app.key)}
      onChange={() => toggleAppPick(pickOf(app))}
    />
  );

  const trail = (app: DevApp): React.ReactNode => {
    const count = appFlowCount(flows, app, listed);
    const state = captureState(app, count);
    if (state === "captured") {
      return (
        <span
          className="net-apps__cap net-apps__cap--on"
          data-testid="net-app-capture"
          data-state="captured"
          title={count > 0 ? `${count} requests captured` : "Captured — its requests show here"}
        >
          ✓
        </span>
      );
    }
    if (state === "uncaptured") {
      return (
        <span className="net-apps__cap net-apps__cap--off" data-testid="net-app-capture" data-state="uncaptured" title={uncapturedText(app)}>
          ⚠
          <button type="button" className="net-apps__act" data-testid="net-app-restart-capture" onClick={() => requestRestart(app.key)}>
            Restart with capture
          </button>
        </span>
      );
    }
    if (state === "external" && app.pid !== null) {
      const pid = app.pid;
      return (
        <span className="net-apps__cap" data-testid="net-app-capture" data-state="external">
          <button
            type="button"
            className="net-apps__act"
            data-testid="net-app-guide"
            title={`How to point ${app.name} at the IDE's capture proxy (${machineView} › Capture this app)`}
            onClick={() => {
              setNetworkMode("machine");
              revealMachinePid(pid, true);
            }}
          >
            capture →
          </button>
        </span>
      );
    }
    return (
      <span
        className="net-apps__cap"
        data-testid="net-app-capture"
        data-state={state}
        title="Whether its requests can reach the IDE's proxy is not known"
      />
    );
  };

  const sourceRow = (row: PickerRow): React.JSX.Element => {
    const checked = sourceSelection?.includes(row.id) ?? false;
    const only = sourceSelection !== null && sourceSelection.length === 1 && sourceSelection[0] === row.id;
    return (
      <div key={row.id} className="net-side__line" data-testid="net-src-row" data-source={row.id}>
        <input
          type="checkbox"
          className="net-apps__check"
          data-testid="net-src-check"
          aria-label={`Show ${row.label}'s requests`}
          checked={checked}
          onChange={() => toggleSourcePick(row.id)}
        />
        <button
          type="button"
          className="net-side__row"
          aria-pressed={only}
          title={row.sublabel === undefined ? `Only ${row.label}` : `Only ${row.label} — ${row.sublabel}`}
          onClick={() => onlySourcePick(row.id)}
        >
          <span className="net-side__name">{row.label}</span>
          {row.sublabel !== undefined && <span className="net-side__sub">{row.sublabel}</span>}
          <span className="net-side__count" data-testid="net-src-count">
            {row.count}
          </span>
        </button>
      </div>
    );
  };

  const everything = selection === null && sourceSelection === null;
  return (
    <aside ref={aside} className="net-apps" aria-label="Apps" data-testid="net-apps" style={{ width, flexBasis: width }}>
      <SidebarResizer width={width} />
      <div className="net-apps__list">
        <button
          type="button"
          className={`net-side__row net-side__all${everything ? " net-side__row--sel" : ""}`}
          data-testid="net-side-all"
          aria-pressed={everything}
          title="Every app and every source (the Process and Host pickers are the toolbar's)"
          onClick={allSidebarPicks}
        >
          <span className="net-side__name">{ALL_SOURCES}</span>
          <span className="net-side__count">{flows.length}</span>
        </button>
        <DevAppsSection
          onRowClick={(app) => onlyAppPick(pickOf(app))}
          isSelected={(app) => selection !== null && selection.length === 1 && selection[0].key === app.key}
          rowLead={lead}
          rowTrail={trail}
          launcherLabel={(app) => (app.terminalId === null ? null : (renamed.get(app.terminalId) ?? null))}
          leading={
            <button
              type="button"
              className={`procs-side__row net-apps__all${selection === null ? " procs-side__row--sel" : ""}`}
              data-testid="net-apps-all"
              aria-pressed={selection === null}
              onClick={allAppPicks}
            >
              <span className="procs-side__name">{ALL_APPS}</span>
            </button>
          }
          trailing={gone.map((p) => (
            <div key={p.key} className="procs-side__line" data-testid="net-app-gone" data-key={p.key}>
              <input type="checkbox" className="net-apps__check" aria-label={`Show ${p.name}'s requests`} checked onChange={() => toggleAppPick(p)} />
              <span className="procs-side__name net-apps__gone" title="No longer running — its captured requests are still shown">
                {p.name} (exited)
              </span>
            </div>
          ))}
        />
        {SOURCE_GROUPS.map(([group, label]) =>
          groups[group].length === 0 ? null : (
            <div key={group} className="net-side__group" role="group" aria-label={label} data-testid="net-src-group" data-group={group}>
              <div className="net-side__heading">{label}</div>
              {groups[group].map(sourceRow)}
            </div>
          ),
        )}
      </div>
    </aside>
  );
}

/** Right-edge resizer, mirroring the Logs sidebar's `SidebarResizer`. */
function SidebarResizer({ width }: { width: number }): React.JSX.Element {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the apps sidebar"
      aria-valuenow={width}
      tabIndex={0}
      className="net-side__resizer"
      data-testid="net-side-resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, w: width };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) setNetSidebarWidth(drag.current.w + (e.clientX - drag.current.x));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => setNetSidebarWidth(NET_SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowRight") setNetSidebarWidth(width + step);
        else if (e.key === "ArrowLeft") setNetSidebarWidth(width - step);
        else return;
        e.preventDefault();
      }}
    />
  );
}
