/** Every HTTP, WebSocket and gRPC call the IDE's terminals make. State that must survive the tab's
 * remount lives in `networkStore`; only scroll geometry is local. Rows are windowed (5 000-flow
 * ring); selection reveal is index arithmetic, as an off-screen row is not in the DOM. */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { AppPicker, summarize } from "../../components/AppPicker";
import { ColumnResizer, ColumnsMenu, useColumnLayout } from "../../components/columns";
import { visibleWindow } from "../db/console/consoleFormat";
import { PortChangedBanner } from "./CaptureGuide";
import { NetworkAppsSidebar } from "./NetworkAppsSidebar";
import { appPredicate, type AppPick } from "./networkApps";
import { UncapturedBanner } from "./UncapturedBanner";
import { useProcsStore } from "../procs/procsStore";
import { FlowDetailPane } from "./FlowDetailPane";
import { watchTerminalTitles } from "./terminalTitles";
import { StrictCaptureSwitch } from "./TunnelCard";
import { modeLabel } from "./machineFormat";
import { ensureMachineStatus, useMachineStore } from "./machineStore";
import { MachineView } from "./MachineView";
import { fitColumns, IDE_COLUMNS, IDE_VIEW_KEY, tableMinWidth, type IdeColumn, type IdeColumnId } from "./networkColumns";
import {
  chipCounts,
  AI_PROVIDERS,
  hiddenBy,
  isAiProviderCall,
  matchesChips,
  matchesFilter,
  parseFilter,
  PROTO_CHIPS,
  tableFlows,
  type PickerPredicates,
  type ProtoChip,
} from "./networkFilter";
import {
  durationTone,
  formatDuration,
  formatTime,
  grpcFailed,
  hostCell,
  methodTone,
  pathCell,
  processCell,
  protoLabel,
  sizeCell,
  statusBucket,
  statusCell,
  typeCell,
} from "./networkFormat";
import {
  hostItems,
  hostKey,
  processItems,
  processKey,
  resolveSource,
  sourceIndex,
  sourceItems,
  sourceKey,
  sourceText,
  type SourceLabel,
} from "./networkSource";
import {
  clearFlows,
  closeDetail,
  ensureNetwork,
  openDetail,
  refreshStatus,
  selectFlow,
  setFilter,
  setHideAiProviders,
  setHostSelection,
  setNetcap,
  setNetworkMode,
  setPaused,
  setProcessSelection,
  setSourceSelection,
  showAllFlows,
  toggleChip,
  toggleDetailTab,
  useNetworkStore,
} from "./networkStore";
import type { FlowSummary } from "./networkTypes";
import "./network.css";

/** Row and header heights — mirrored in network.css (`.net-table tr`). */
export const ROW_H = 20;
export const HEAD_H = 22;
/** Used until the scroll box has been measured (and in jsdom, where nothing is). */
export const FALLBACK_VIEWPORT = 480;

export const DECRYPT_EXPLAINER =
  "Decrypt HTTPS: the proxy terminates TLS with a local certificate authority so paths, headers and bodies become visible. " +
  "Only processes started in IDE terminals opened after you enable it trust that CA — nothing is added to your system trust store. " +
  "A client that pins certificates or ignores the CA fails once; that host then tunnels (passthrough) for the rest of the session.";

export const HIDE_AI_EXPLAINER =
  "Hide the requests an agent CLI (Claude Code, Codex) itself sends to AI providers — each agent's conversation " +
  `with the model, its telemetry and its update checks. Providers: ${AI_PROVIDERS.map((p) => p.name).join(", ")}. ` +
  "Requests an agent runs (curl, scripts, the app it is building) stay visible, even to those providers.";

export const CAPTURE_EXPLAINER =
  "Capture: new IDE terminals get HTTP(S)_PROXY pointing at the IDE's local proxy, so their traffic shows here. " +
  "Terminals already open keep the environment they started with.";

export function NetworkPanel(): React.JSX.Element {
  useEffect(() => {
    void ensureNetwork();
    void refreshStatus();
    void ensureMachineStatus();
  }, []);
  // Also started by the titlebar button (the app's whole life); here so a panel alone is complete.
  useEffect(() => watchTerminalTitles(), []);
  const mode = useNetworkStore((s) => s.mode);

  return (
    <div className="net" data-testid="network-panel">
      <ModeSwitch />
      {mode === "ide" ? (
        <>
          <NetworkHeader />
          {/* The capture guard: IDE apps whose traffic cannot reach this table, named. */}
          <UncapturedBanner />
          <div className="net-ide">
            <NetworkAppsSidebar />
            <IdeMain />
          </div>
          <KeyHints />
        </>
      ) : (
        <MachineView />
      )}
    </div>
  );
}

/* ── mode switch ────────────────────────────────────────────────────────────── */

/** Never disabled: an unavailable backend is explained inside the Whole-computer pane. */
function ModeSwitch(): React.JSX.Element {
  const mode = useNetworkStore((s) => s.mode);
  const backend = useMachineStore((s) => s.status?.backend);
  const modes: readonly [typeof mode, string, string][] = [
    ["ide", "IDE traffic", "HTTP, WebSocket and gRPC calls made from terminals opened in the IDE, through its capture proxy."],
    ["machine", modeLabel(backend), "Every app's open connections on this computer — no proxy, no permission prompt."],
  ];
  return (
    <div className="net-mode" role="group" aria-label="Network mode">
      {modes.map(([m, label, title]) => (
        <button
          key={m}
          type="button"
          className="net-mode__btn"
          aria-pressed={mode === m}
          title={title}
          onClick={() => setNetworkMode(m)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ── header ─────────────────────────────────────────────────────────────────── */

function NetworkHeader(): React.JSX.Element {
  // One row per call: a neutralised bypass is not a row of its own (networkFilter.tableFlows).
  const ring = useNetworkStore((s) => s.flows);
  const flows = useMemo(() => tableFlows(ring), [ring]);
  const count = flows.length;
  const status = useNetworkStore((s) => s.status);
  const statusError = useNetworkStore((s) => s.statusError);
  const setting = useNetworkStore((s) => s.setting);
  const unknown = status === null;
  const waitReason = "Waiting for the capture proxy's status…";

  return (
    <>
      <div className="net-head">
        <span className="net-head__title" data-testid="net-title">
          Network — {count} {count === 1 ? "flow" : "flows"}
        </span>
        <span className="net-switch-wrap" title={unknown ? waitReason : CAPTURE_EXPLAINER}>
          <button
            type="button"
            role="switch"
            className="net-switch"
            aria-checked={status?.enabled ?? false}
            disabled={unknown || setting}
            onClick={() => void setNetcap({ enabled: !status?.enabled })}
          >
            Capture
          </button>
        </span>
        <span className="net-switch-wrap" title={unknown ? waitReason : DECRYPT_EXPLAINER}>
          <button
            type="button"
            role="switch"
            className="net-switch"
            aria-checked={status?.decrypt ?? false}
            disabled={unknown || setting}
            onClick={() => void setNetcap({ decrypt: !status?.decrypt })}
          >
            Decrypt HTTPS
          </button>
        </span>
        {/* The bypass rows' switch: agents' `curl --noproxy` is captured anyway. */}
        <StrictCaptureSwitch />
        <span className="net-head__meta" data-testid="net-port">
          {status === null ? "" : status.running && status.port !== null ? `proxy 127.0.0.1:${status.port}` : "proxy not running"}
        </span>
        {status && status.passthroughHosts.length > 0 ? (
          <span className="net-head__meta" title={status.passthroughHosts.join("\n")}>
            passthrough: {status.passthroughHosts.length}
          </span>
        ) : null}
        <span className="net-head__note">Applies to terminals opened after enabling.</span>
        {status?.skippedReason ? (
          <span className="net-head__warn" data-testid="net-skipped">
            Not injected: {status.skippedReason}
          </span>
        ) : null}
        {statusError ? (
          <span className="net-head__err" role="alert">
            {statusError}
          </span>
        ) : null}
        <HideAiProvidersCheckbox flows={flows} />
      </div>
      {/* A moved port breaks every app pointed at the proxy by hand — say so here too. */}
      <PortChangedBanner status={status} />
    </>
  );
}

/** Shows how many of the table's flows it matches, so nothing disappears unannounced. */
function HideAiProvidersCheckbox({ flows }: { flows: readonly FlowSummary[] }): React.JSX.Element {
  const hide = useNetworkStore((s) => s.hideAiProviders);
  const n = useMemo(() => flows.reduce((k, f) => (isAiProviderCall(f) ? k + 1 : k), 0), [flows]);
  return (
    <label className="net-head__hide" title={HIDE_AI_EXPLAINER}>
      <input type="checkbox" data-testid="net-hide-ai" checked={hide} onChange={(e) => setHideAiProviders(e.target.checked)} />
      Hide AI providers
      <span className="net-chip__count" data-testid="net-ai-count">
        {n}
      </span>
    </label>
  );
}

/** Toolbar + table. Owns the fit-to-width (`fitColumns`): the table reports its scroll box's
 * width, the fit decides the columns, and Columns ▾ lists the ones it hid (unticked). */
function IdeMain(): React.JSX.Element {
  const [tableWidth, setTableWidth] = useState(0);
  const layout = useColumnLayout(IDE_VIEW_KEY);
  const fit = useMemo(() => fitColumns(IDE_COLUMNS, layout, tableWidth), [layout, tableWidth]);
  return (
    <div className="net-ide__main">
      <Toolbar autoHidden={fit.autoHidden} />
      <FlowArea cols={fit.cols} tight={fit.tight} onWidth={setTableWidth} />
    </div>
  );
}

/* ── toolbar ────────────────────────────────────────────────────────────────── */

function Toolbar({ autoHidden }: { autoHidden: readonly string[] }): React.JSX.Element {
  const filter = useNetworkStore((s) => s.filter);
  const chips = useNetworkStore((s) => s.chips);
  const paused = useNetworkStore((s) => s.paused);
  const waiting = useNetworkStore((s) => s.buffered.size);
  const clearError = useNetworkStore((s) => s.clearError);
  const invalid = useMemo(() => parseFilter(filter).invalid, [filter]);
  const ring = useNetworkStore((s) => s.flows);
  const flows = useMemo(() => tableFlows(ring), [ring]);
  const sourceSelection = useNetworkStore((s) => s.sourceSelection);
  const processSelection = useNetworkStore((s) => s.processSelection);
  const hostSelection = useNetworkStore((s) => s.hostSelection);
  const tabs = useAppStore((s) => s.tabs);
  const agents = useAppStore((s) => s.agents);
  const closedTitles = useNetworkStore((s) => s.terminalTitles);
  const items = useMemo(() => sourceItems(flows, sourceIndex(tabs, agents), closedTitles), [flows, tabs, agents, closedTitles]);
  const procItems = useMemo(() => processItems(flows), [flows]);
  const hostRows = useMemo(() => hostItems(flows), [flows]);
  const counts = useMemo(() => chipCounts(flows), [flows]);

  return (
    <div className="net-bar">
      <input
        id="net-filter"
        className="net-bar__filter"
        type="search"
        aria-label="Filter flows"
        placeholder="/ filter — host, path, status:5xx, proto:grpc, method:post, host:api"
        value={filter}
        spellCheck={false}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            document.getElementById("net-scroll")?.focus();
          }
        }}
      />
      {invalid.length > 0 ? (
        <span className="net-bar__invalid" data-testid="net-invalid">
          ignored: {invalid.join(" ")}
        </span>
      ) : null}
      <AppPicker
        items={items}
        selected={sourceSelection}
        onChange={setSourceSelection}
        noun="sources"
        label="Filter by source"
      />
      <AppPicker
        items={procItems}
        selected={processSelection}
        onChange={setProcessSelection}
        noun="processes"
        label="Filter by process"
      />
      {/* Hosts, with the protocols seen on each; the text filter's `host:` stays. */}
      <AppPicker
        items={hostRows}
        selected={hostSelection}
        onChange={setHostSelection}
        noun="hosts"
        label="Filter by host"
      />
      <div className="net-chips" role="group" aria-label="Protocols">
        {PROTO_CHIPS.map(({ chip, label }) => (
          <button
            key={chip}
            type="button"
            className="net-chip"
            aria-pressed={chips.includes(chip)}
            title={`${counts[chip]} ${counts[chip] === 1 ? "flow" : "flows"}`}
            onClick={() => toggleChip(chip)}
          >
            {label}
            <span className="net-chip__count" aria-hidden="true">
              {counts[chip]}
            </span>
          </button>
        ))}
      </div>
      <button type="button" className="net-btn" aria-pressed={paused} onClick={() => setPaused(!paused)}>
        {paused ? "Resume" : "Pause"}
      </button>
      {paused && waiting > 0 ? (
        <span className="net-bar__paused" data-testid="net-waiting">
          {waiting} {waiting === 1 ? "update" : "updates"} waiting
        </span>
      ) : null}
      <button type="button" className="net-btn" onClick={() => void clearFlows()}>
        Clear
      </button>
      {clearError ? (
        <span className="net-head__err" role="alert">
          Clear failed: {clearError}
        </span>
      ) : null}
      <ColumnsMenu viewKey={IDE_VIEW_KEY} defs={IDE_COLUMNS} autoHidden={autoHidden} />
    </div>
  );
}

/* ── table ──────────────────────────────────────────────────────────────────── */

function FlowArea({
  cols,
  tight,
  onWidth,
}: {
  cols: ReadonlyArray<IdeColumn & { px: number }>;
  /** The columns were squeezed (`Fit.tight`): the tight cell padding their compact widths assume. */
  tight: boolean;
  /** The scroll box's client width, on mount and on every resize (0 = unmeasured). */
  onWidth: (px: number) => void;
}): React.JSX.Element {
  const appSelection = useNetworkStore((s) => s.appSelection);
  const devApps = useProcsStore((s) => s.list?.apps);
  const ring = useNetworkStore((s) => s.flows);
  const flows = useMemo(() => tableFlows(ring), [ring]);
  const filter = useNetworkStore((s) => s.filter);
  const chips = useNetworkStore((s) => s.chips);
  const hideAiProviders = useNetworkStore((s) => s.hideAiProviders);
  const selectedId = useNetworkStore((s) => s.selectedId);
  const detailOpen = useNetworkStore((s) => s.detailOpen);
  const loadError = useNetworkStore((s) => s.loadError);
  const sourceSelection = useNetworkStore((s) => s.sourceSelection);
  const processSelection = useNetworkStore((s) => s.processSelection);
  const hostSelection = useNetworkStore((s) => s.hostSelection);
  const tabs = useAppStore((s) => s.tabs);
  const agents = useAppStore((s) => s.agents);
  const sources = useMemo(() => sourceIndex(tabs, agents), [tabs, agents]);
  const closedTitles = useNetworkStore((s) => s.terminalTitles);

  // Keyed by terminal id, so a pick survives the terminal's title changing under it.
  const sourceOk = useMemo(
    () => (sourceSelection === null ? null : (f: FlowSummary) => sourceSelection.includes(sourceKey(f))),
    [sourceSelection],
  );
  const processOk = useMemo(
    () => (processSelection === null ? null : (f: FlowSummary) => processSelection.includes(processKey(f))),
    [processSelection],
  );
  const hostOk = useMemo(
    () => (hostSelection === null ? null : (f: FlowSummary) => hostSelection.includes(hostKey(f))),
    [hostSelection],
  );
  // The Apps sidebar's picks (networkApps): by the app's pid, else its executable name.
  const appOk = useMemo(() => appPredicate(appSelection, devApps ?? []), [appSelection, devApps]);
  const pickers = useMemo<PickerPredicates>(
    () => ({ source: sourceOk, process: processOk, host: hostOk, app: appOk }),
    [sourceOk, processOk, hostOk, appOk],
  );
  const rows = useMemo(() => {
    const parsed = parseFilter(filter);
    return flows.filter(
      (f) =>
        matchesChips(f, chips) &&
        !(hideAiProviders && isAiProviderCall(f)) &&
        matchesFilter(f, parsed) &&
        (sourceOk === null || sourceOk(f)) &&
        (processOk === null || processOk(f)) &&
        (hostOk === null || hostOk(f)) &&
        (appOk === null || appOk(f)),
    );
  }, [flows, filter, chips, hideAiProviders, sourceOk, processOk, hostOk, appOk]);
  const selectedHidden = selectedId !== null && !rows.some((r) => r.id === selectedId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);

  // The box is attached before any effect or event can run, so callers pass it in.
  const measure = useCallback((el: HTMLElement) => {
    setViewport(el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEWPORT);
    setScrollTop(el.scrollTop);
    onWidth(el.clientWidth);
  }, [onWidth]);

  useEffect(() => {
    const el = scrollRef.current as HTMLDivElement;
    const onResize = (): void => measure(el);
    onResize();
    window.addEventListener("resize", onResize);
    // The pane also narrows without a window resize: a split, a rail, the Apps sidebar's drag.
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [measure]);

  // Newest at the bottom: stay pinned there unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current as HTMLDivElement;
    if (!following.current) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [rows.length]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= ROW_H / 2;
    measure(el);
  };

  const reveal = (el: HTMLElement, index: number): void => {
    const body = Math.max(viewport - HEAD_H, ROW_H);
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + body) el.scrollTop = top + ROW_H - body;
    following.current = index === rows.length - 1;
    setScrollTop(el.scrollTop);
  };

  const selectAt = (el: HTMLElement, index: number): void => {
    const row = rows[index] as FlowSummary | undefined;
    if (!row) return; // an empty table: nothing to move to
    selectFlow(row.id);
    reveal(el, index);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
    const last = rows.length - 1;
    const box = e.currentTarget;
    let handled = true;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        selectAt(box, idx < 0 ? 0 : Math.min(idx + 1, last));
        break;
      case "k":
      case "ArrowUp":
        selectAt(box, idx < 0 ? last : Math.max(idx - 1, 0));
        break;
      case "g":
        selectAt(box, 0);
        break;
      case "G":
        selectAt(box, last);
        break;
      case "Enter":
        if (idx >= 0) openDetail(rows[idx].id);
        break;
      case "Tab":
        // Only claimed while there is a Request/Response pair to flip; otherwise Tab moves focus.
        if (detailOpen && !e.shiftKey) toggleDetailTab();
        else handled = false;
        break;
      case "Escape":
        if (detailOpen) closeDetail();
        else handled = false;
        break;
      case "c":
        void clearFlows();
        break;
      case "p":
        setPaused(!useNetworkStore.getState().paused);
        break;
      case "/":
        document.getElementById("net-filter")?.focus();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const win = visibleWindow(scrollTop, Math.max(viewport - HEAD_H, 0), ROW_H, rows.length);
  const visible = rows.slice(win.start, win.end);

  return (
    <div className={`net-area${detailOpen ? " net-area--split" : ""}`}>
      {loadError ? (
        <div className="net-area__err" role="alert">
          Could not load earlier flows: {loadError}
        </div>
      ) : null}
      <div
        id="net-scroll"
        ref={scrollRef}
        className="net-scroll"
        data-testid="net-scroll"
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <table
          className={`net-table${tight ? " net-table--tight" : ""}`}
          aria-label="Network flows"
          aria-rowcount={rows.length}
          style={{ minWidth: tableMinWidth(cols) }}
        >
          <colgroup>
            {cols.map((c) => (
              <col key={c.id} className={`net-col--${c.id}`} style={c.flex ? undefined : { width: c.px }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.id} className="net-th">
                  {c.label}
                  {c.flex ? null : <ColumnResizer viewKey={IDE_VIEW_KEY} def={c} width={c.px} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {win.padTop > 0 ? <tr aria-hidden="true" style={{ height: win.padTop }} /> : null}
            {visible.map((f, i) => (
              <FlowRow
                key={f.id}
                flow={f}
                cols={cols}
                index={win.start + i}
                selected={f.id === selectedId}
                source={resolveSource(f, sources, closedTitles)}
                onPick={() => {
                  openDetail(f.id);
                  (scrollRef.current as HTMLDivElement).focus();
                }}
              />
            ))}
            {win.padBottom > 0 ? <tr aria-hidden="true" style={{ height: win.padBottom }} /> : null}
          </tbody>
        </table>
        {rows.length === 0 ? (
          flows.length > 0 ? (
            <FilteredEmpty
              flows={flows}
              chips={chips}
              filter={filter}
              pickers={pickers}
              sources={sources}
              hideAiProviders={hideAiProviders}
            />
          ) : (
            <EmptyState />
          )
        ) : null}
      </div>
      {detailOpen ? <FlowDetailPane sources={sources} hidden={selectedHidden} /> : null}
    </div>
  );
}

function FlowRow({
  flow: f,
  cols,
  index,
  selected,
  source,
  onPick,
}: {
  flow: FlowSummary;
  cols: ReadonlyArray<{ id: IdeColumnId }>;
  index: number;
  selected: boolean;
  source: SourceLabel;
  onPick: () => void;
}): React.JSX.Element {
  const bucket = grpcFailed(f) ? "5xx" : statusBucket(f);
  const type = typeCell(f);
  const pending = f.state === "pending" || f.durationMs === null;
  const proc = processCell(f);
  const cell: Record<IdeColumnId, () => React.JSX.Element> = {
    time: () => <td className="net-c--time">{formatTime(f.startedMs)}</td>,
    proto: () => <td className="net-c--proto">{protoLabel(f.proto)}</td>,
    method: () => <td className={`net-c--method net-method--${methodTone(f.method)}`}>{f.method === "" ? "—" : f.method}</td>,
    host: () => (
      <td className="net-c--host" title={hostCell(f)}>
        {hostCell(f)}
      </td>
    ),
    path: () => (
      <td className="net-c--path" title={f.proto === "tunnel" || f.path === "" ? pathCell(f) : f.path}>
        {pathCell(f)}
      </td>
    ),
    // A squeezed Status (fitColumns) ellipsizes `not captured`; the title keeps it whole.
    status: () => (
      <td className={`net-c--status net-status--${bucket}`} title={statusCell(f)}>
        {statusCell(f)}
      </td>
    ),
    type: () => (
      <td className={`net-c--type net-type--${type.kind}`} title={type.text}>
        {type.text}
      </td>
    ),
    size: () => (
      <td className="net-c--size" title={`↑${f.reqBytes} B  ↓${f.resBytes} B`}>
        {sizeCell(f)}
      </td>
    ),
    dur: () => (
      <td className={`net-c--dur${pending ? " net-dur--pending" : ` net-dur--${durationTone(f.durationMs as number)}`}`}>
        {pending ? "…" : formatDuration(f.durationMs as number)}
      </td>
    ),
    source: () => (
      // An external process's hover names its executable and pid.
      <td className={`net-c--source net-source--${source.kind}`} title={source.kind === "external" ? source.title : sourceText(source)}>
        {sourceText(source)}
      </td>
    ),
    process: () => (
      <td className={`net-c--process${proc.known ? "" : " net-process--unknown"}`} title={proc.title}>
        {proc.text}
      </td>
    ),
  };
  return (
    <tr
      data-testid="net-row"
      data-flow-id={f.id}
      aria-rowindex={index + 1}
      aria-selected={selected}
      className={`net-row${selected ? " is-selected" : ""}`}
      onClick={onPick}
    >
      {cols.map((c) => (
        <Fragment key={c.id}>{cell[c.id]()}</Fragment>
      ))}
    </tr>
  );
}

const CHIP_NAME: Record<ProtoChip, string> = Object.fromEntries(PROTO_CHIPS.map((c) => [c.chip, c.label])) as Record<
  ProtoChip,
  string
>;

/** Empty table over a non-empty capture: name the control hiding the flows and how many, with one
 * button back, so it does not read as a broken view. */
function FilteredEmpty({
  flows,
  chips,
  filter,
  pickers,
  sources,
  hideAiProviders,
}: {
  flows: FlowSummary[];
  chips: ProtoChip[];
  filter: string;
  pickers: PickerPredicates;
  sources: ReadonlyMap<string, string>;
  hideAiProviders: boolean;
}): React.JSX.Element {
  const why = hiddenBy(flows, chips, filter, pickers, hideAiProviders);
  const sourceSelection = useNetworkStore((s) => s.sourceSelection);
  const processSelection = useNetworkStore((s) => s.processSelection);
  const hostSelection = useNetworkStore((s) => s.hostSelection);
  const appSelection = useNetworkStore((s) => s.appSelection);
  const closedTitles = useNetworkStore((s) => s.terminalTitles);
  const n = flows.length;
  const fam = why.chips?.families;
  const families = fam
    ? PROTO_CHIPS.filter(({ chip }) => fam[chip] > 0)
        .map(({ chip, label }) => `${fam[chip]} ${label}`)
        .join(", ")
    : "";
  return (
    <div className="net-empty" data-testid="net-empty">
      <p>
        {n === 1 ? "The only flow is hidden" : `All ${n} flows are hidden`} by the current filters.
      </p>
      <ul className="net-empty__why">
        {why.chips ? (
          <li data-testid="net-hidden-by-chips">
            Protocol chips (showing {chips.map((c) => CHIP_NAME[c]).join(" + ")} only) hide {why.chips.count}
            {families ? ` — ${families}` : ""}
          </li>
        ) : null}
        {why.ai !== null ? (
          <li data-testid="net-hidden-by-ai">Hide AI providers hides {why.ai}</li>
        ) : null}
        {why.text !== null ? (
          <li data-testid="net-hidden-by-text">
            Filter &quot;{filter.trim()}&quot; hides {why.text}
          </li>
        ) : null}
        {why.source !== null ? (
          <li data-testid="net-hidden-by-source">
            Source picker ({summarize(sourceSelection, sourceItems(flows, sources, closedTitles), "sources")}) hides {why.source}
          </li>
        ) : null}
        {why.process !== null ? (
          <li data-testid="net-hidden-by-process">
            Process picker ({summarize(processSelection, processItems(flows), "processes")}) hides {why.process}
          </li>
        ) : null}
        {why.app !== null ? (
          <li data-testid="net-hidden-by-app">
            Apps sidebar ({appSelectionText(appSelection as AppPick[])}) hides {why.app}
          </li>
        ) : null}
        {why.host !== null ? (
          <li data-testid="net-hidden-by-host">
            Host picker ({summarize(hostSelection, hostItems(flows), "hosts")}) hides {why.host}
          </li>
        ) : null}
      </ul>
      <button type="button" className="net-btn" onClick={showAllFlows}>
        Show all flows
      </button>
    </div>
  );
}

/** "gazelle" / "gazelle + web" — the picked apps, for the hidden-by line (only shown while picks exist). */
export function appSelectionText(selection: readonly { name: string }[]): string {
  return selection.map((p) => p.name).join(" + ");
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="net-empty" data-testid="net-empty">
      <p>No traffic yet.</p>
      <p>
        Calls made from terminals opened in the IDE appear here — every HTTP, WebSocket and gRPC request your
        agents send.
      </p>
      <p>
        HTTPS shows as encrypted tunnels (host and bytes only) until <strong>Decrypt HTTPS</strong> is on.
      </p>
    </div>
  );
}

/* ── key hints ──────────────────────────────────────────────────────────────── */

const HINTS: readonly [string, string][] = [
  ["j/k", "nav"],
  ["g/G", "top/bot"],
  ["Enter", "open"],
  ["Tab", "req/res"],
  ["Esc", "close"],
  ["/", "filter"],
  ["c", "clear"],
  ["p", "pause"],
];

function KeyHints(): React.JSX.Element {
  return (
    <div className="net-keys" data-testid="net-keys">
      {HINTS.map(([key, what]) => (
        <span key={key} className="net-keys__item">
          <kbd>{key}</kbd>:{what}
        </span>
      ))}
    </div>
  );
}
