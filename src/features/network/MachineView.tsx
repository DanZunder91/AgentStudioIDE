/**
 * MachineView — the Network panel's Whole-computer mode: every app's sockets, grouped by
 * app, one sample per second.
 *
 * Not windowed on purpose: a busy Mac measured ~80 apps / ~250 sockets, and sockets only
 * render under an expanded app, so the DOM stays around a hundred rows. Keyboard reveal is
 * plain offset arithmetic against the scroll box for the same reason.
 *
 * All state lives in `machineStore` (the panel is a tab and remounts); this file only holds the
 * scroll box.
 */

import { Fragment, useEffect, useMemo, useRef } from "react";

import { AppPicker } from "../../components/AppPicker";
import { ColumnResizer, ColumnsMenu, useColumnLayout, visibleColumns } from "../../components/columns";
import { CaptureGuide, CaptureGuideButton } from "./CaptureGuide";
import {
  appItems,
  BYTE_SORTS,
  bytesCell,
  DASH,
  effectiveSort,
  modeLabel,
  NO_BYTES_TITLE,
  OTHER_USER_TITLE,
  rateCell,
  rateNaTitle,
  remoteCell,
  remoteTitle,
  shownApps,
  sortApps,
  summarizeShown,
  type MachineSortKey,
  type ShownApp,
} from "./machineFormat";
import {
  acquireMachine,
  displayedSample,
  releaseMachine,
  selectApp,
  setExpanded,
  setHideListeners,
  setMachineFilter,
  setMachinePaused,
  setMachineSelection,
  sortBy,
  toggleExpanded,
  useMachineStore,
} from "./machineStore";
import { MACHINE_COLUMNS, MACHINE_VIEW_KEY, tableMinWidth, type MachineColumn, type MachineColumnId } from "./networkColumns";
import type { MachineConn } from "./networkTypes";

/** The sort each header drives; PID is not sortable. */
const SORT_OF: Record<MachineColumnId, MachineSortKey | null> = {
  app: "name",
  pid: null,
  conns: "conns",
  rateIn: "rateIn",
  rateOut: "rateOut",
  bytesIn: "bytesIn",
  bytesOut: "bytesOut",
};

/** The columns of a backend that sees no byte counts: no rates, no totals (`BYTE_SORTS`). */
const NO_BYTE_COLUMNS: readonly MachineColumn[] = MACHINE_COLUMNS.filter((c) => {
  const key = SORT_OF[c.id];
  return key === null || !BYTE_SORTS.has(key);
});

/** Sticky header height — mirrored in network.css (`--net-head-h`). */
const HEAD_H = 22;

export function MachineView(): React.JSX.Element {
  useEffect(() => {
    acquireMachine();
    return releaseMachine;
  }, []);

  const status = useMachineStore((s) => s.status);
  const statusError = useMachineStore((s) => s.statusError);

  let body: React.JSX.Element;
  if (status === null) {
    body = (
      <div className="net-empty" data-testid="netm-waiting">
        {statusError ? null : "Starting the connection sampler…"}
      </div>
    );
  } else if (!status.available) {
    body = (
      <div className="net-empty" data-testid="netm-unavailable">
        <p>{modeLabel(status.backend)} isn&apos;t available here.</p>
        <p>{status.reason ?? "This platform has no connection backend yet."}</p>
      </div>
    );
  } else {
    body = <MachineTable />;
  }

  return (
    <>
      {statusError ? (
        <div className="net-area__err" role="alert">
          {statusError}
        </div>
      ) : null}
      {body}
    </>
  );
}

function MachineTable(): React.JSX.Element {
  const status = useMachineStore((s) => s.status)!;
  const sample = useMachineStore(displayedSample);
  const latest = useMachineStore((s) => s.latest);
  const paused = useMachineStore((s) => s.paused);
  // No byte counts on this backend (Windows): those columns, their sorts and the totals go.
  const hasBytes = status.hasBytes;
  const sort = effectiveSort(
    useMachineStore((s) => s.sort),
    hasBytes,
  );
  const selection = useMachineStore((s) => s.selection);
  const filter = useMachineStore((s) => s.filter);
  const hideListeners = useMachineStore((s) => s.hideListeners);
  const expanded = useMachineStore((s) => s.expanded);
  const selectedKey = useMachineStore((s) => s.selectedKey);
  const guideKey = useMachineStore((s) => s.guideKey);

  const all = useMemo(() => shownApps(sample, { selection: null, filter: "", hideListeners }), [sample, hideListeners]);
  const rows = useMemo(
    () => sortApps(shownApps(sample, { selection, filter, hideListeners }), sort),
    [sample, selection, filter, hideListeners, sort],
  );
  const sum = summarizeShown(rows);
  // The picker lists what is running now, even while the table is frozen.
  const items = useMemo(() => appItems(latest ?? sample), [latest, sample]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = useColumnLayout(MACHINE_VIEW_KEY);
  const defs = hasBytes ? MACHINE_COLUMNS : NO_BYTE_COLUMNS;
  const cols = visibleColumns(defs, layout) as Array<MachineColumn & { px: number }>;

  const reveal = (box: HTMLElement, key: string): void => {
    const row = box.querySelector<HTMLElement>(`[data-app-key="${CSS.escape(key)}"]`)!;
    const top = row.offsetTop;
    if (top - HEAD_H < box.scrollTop) box.scrollTop = top - HEAD_H;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight;
  };

  const moveTo = (box: HTMLElement, index: number): void => {
    const row = rows[index] as ShownApp | undefined;
    if (!row) return; // an empty table: nothing to move to
    selectApp(row.app.key);
    reveal(box, row.app.key);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = selectedKey === null ? -1 : rows.findIndex((r) => r.app.key === selectedKey);
    const last = rows.length - 1;
    const box = e.currentTarget;
    let handled = true;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        moveTo(box, idx < 0 ? 0 : Math.min(idx + 1, last));
        break;
      case "k":
      case "ArrowUp":
        moveTo(box, idx < 0 ? last : Math.max(idx - 1, 0));
        break;
      case "g":
        moveTo(box, 0);
        break;
      case "G":
        moveTo(box, last);
        break;
      case "Enter":
      case " ":
        if (idx >= 0) toggleExpanded(rows[idx].app.key);
        break;
      case "ArrowRight":
        if (idx >= 0) setExpanded(rows[idx].app.key, true);
        break;
      case "ArrowLeft":
        if (idx >= 0) setExpanded(rows[idx].app.key, false);
        break;
      case "p":
        setMachinePaused(!useMachineStore.getState().paused);
        break;
      case "/":
        (document.getElementById("netm-filter") as HTMLInputElement).focus();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const header = (c: MachineColumn & { px: number }): React.JSX.Element => {
    const key = SORT_OF[c.id];
    const cls = `net-th ${c.id === "app" ? "netm-h--app" : "netm-h--num"}`;
    const resizer = c.flex ? null : <ColumnResizer viewKey={MACHINE_VIEW_KEY} def={c} width={c.px} />;
    if (key === null) {
      return (
        <th key={c.id} className="net-th">
          {c.label}
          {resizer}
        </th>
      );
    }
    const on = sort.key === key;
    return (
      <th key={c.id} className={cls} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" className="netm-sort" onClick={() => sortBy(key)}>
          {c.label}
          {on ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
        </button>
        {resizer}
      </th>
    );
  };

  return (
    <>
      <div className="net-head">
        <span className="net-head__title" data-testid="netm-title">
          {modeLabel(status.backend)} —{" "}
          {sum.apps === all.length ? `${sum.apps}` : `${sum.apps} of ${all.length}`}{" "}
          {all.length === 1 ? "app" : "apps"} · {sum.conns} {sum.conns === 1 ? "connection" : "connections"}
          {hasBytes ? ` · ↓ ${rateCell(sum.rateIn)} ↑ ${rateCell(sum.rateOut)}` : null}
        </span>
        {status.reason ? (
          <span className="net-head__note" data-testid="netm-partial">
            {status.reason}
          </span>
        ) : null}
      </div>
      <div className="net-bar">
        <input
          id="netm-filter"
          className="net-bar__filter"
          type="search"
          aria-label="Filter apps and connections"
          placeholder="/ filter — app, pid, address, host"
          value={filter}
          spellCheck={false}
          onChange={(e) => setMachineFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              e.preventDefault();
              scrollRef.current!.focus();
            }
          }}
        />
        <AppPicker items={items} selected={selection} onChange={setMachineSelection} label="Filter by app" />
        <button
          type="button"
          role="switch"
          className="net-switch"
          aria-checked={hideListeners}
          title="Hide sockets that are not talking to anyone: TCP listeners and UDP sockets with no peer."
          onClick={() => setHideListeners(!hideListeners)}
        >
          Hide listeners
        </button>
        <button type="button" className="net-btn" aria-pressed={paused} onClick={() => setMachinePaused(!paused)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <ColumnsMenu viewKey={MACHINE_VIEW_KEY} defs={defs} />
      </div>
      <div className="net-area">
        <div
          id="netm-scroll"
          ref={scrollRef}
          className="net-scroll"
          data-testid="netm-scroll"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <table
            className="net-table netm-table"
            aria-label="Apps and connections"
            style={{ minWidth: tableMinWidth(cols) }}
          >
            <colgroup>
              {cols.map((c) => (
                <col key={c.id} className={`netm-col--${c.id}`} style={c.flex ? undefined : { width: c.px }} />
              ))}
            </colgroup>
            <thead>
              <tr>{cols.map(header)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AppRows
                  key={r.app.key}
                  row={r}
                  cols={cols}
                  hasBytes={hasBytes}
                  open={expanded.includes(r.app.key)}
                  guide={r.app.key === guideKey}
                  selected={r.app.key === selectedKey}
                  onPick={() => {
                    selectApp(r.app.key);
                    toggleExpanded(r.app.key);
                    scrollRef.current!.focus();
                  }}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? (
            <div className="net-empty" data-testid="netm-empty">
              {sample === null ? "Waiting for the first sample…" : "No apps match."}
            </div>
          ) : null}
        </div>
      </div>
      <div className="net-keys" data-testid="netm-keys">
        {HINTS.map(([key, what]) => (
          <span key={key} className="net-keys__item">
            <kbd>{key}</kbd>:{what}
          </span>
        ))}
      </div>
    </>
  );
}

const HINTS: readonly [string, string][] = [
  ["j/k", "nav"],
  ["g/G", "top/bot"],
  ["Enter", "expand"],
  ["/", "filter"],
  ["p", "pause"],
];

function NumCell({
  value,
  text,
  className,
  naTitle = NO_BYTES_TITLE,
}: {
  value: number | null;
  text: string;
  className: string;
  naTitle?: string;
}): React.JSX.Element {
  return (
    <td className={`${className}${value === null ? " netm-na" : ""}`} title={value === null ? naTitle : undefined}>
      {text}
    </td>
  );
}

function AppRows({
  row: { app, conns },
  cols,
  hasBytes,
  open,
  guide,
  selected,
  onPick,
}: {
  row: ShownApp;
  cols: ReadonlyArray<{ id: MachineColumnId }>;
  hasBytes: boolean;
  open: boolean;
  /** This row's "Capture this app" guide is the open one. */
  guide: boolean;
  selected: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const other = app.user === "other";
  const cell: Record<MachineColumnId, () => React.JSX.Element> = {
    app: () => (
      <td className="netm-c--app" title={app.name}>
        <span className="netm-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>{" "}
        {app.name}
      </td>
    ),
    pid: () => (
      <td className="netm-c--pid" title={app.pid === 0 ? "Unknown process" : undefined}>
        {app.pid === 0 ? DASH : app.pid}
      </td>
    ),
    conns: () => <td className="netm-c--conns">{conns.length}</td>,
    rateIn: () => (
      <NumCell className="netm-c--rate" value={app.rateIn} text={rateCell(app.rateIn)} naTitle={rateNaTitle(app.bytesIn)} />
    ),
    rateOut: () => (
      <NumCell className="netm-c--rate" value={app.rateOut} text={rateCell(app.rateOut)} naTitle={rateNaTitle(app.bytesOut)} />
    ),
    bytesIn: () => <NumCell className="netm-c--total" value={app.bytesIn} text={bytesCell(app.bytesIn)} />,
    bytesOut: () => <NumCell className="netm-c--total" value={app.bytesOut} text={bytesCell(app.bytesOut)} />,
  };
  return (
    <>
      <tr
        data-testid="netm-row"
        data-app-key={app.key}
        aria-selected={selected}
        aria-expanded={open}
        className={`net-row netm-row${selected ? " is-selected" : ""}${other ? " netm-row--other" : ""}`}
        title={other ? OTHER_USER_TITLE : undefined}
        onClick={onPick}
      >
        {cols.map((c) => (
          <Fragment key={c.id}>{cell[c.id]()}</Fragment>
        ))}
      </tr>
      {open ? (
        <tr className="netm-conns-row" data-testid="netm-conns">
          <td colSpan={cols.length}>
            {/* How to see what this app is DOING, not only who it talks to. */}
            <CaptureGuideButton appKey={app.key} />
            {guide ? <CaptureGuide app={app} /> : null}
            <ConnTable app={app.name} conns={conns} hasBytes={hasBytes} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ConnTable({ app, conns, hasBytes }: { app: string; conns: MachineConn[]; hasBytes: boolean }): React.JSX.Element {
  if (conns.length === 0) {
    return <div className="netm-conns__none">No sockets listed for this process.</div>;
  }
  return (
    <table className="netm-conns" aria-label={`${app} connections`}>
      <colgroup>
        <col className="netm-ccol--proto" />
        <col className="netm-ccol--local" />
        <col className="netm-ccol--remote" />
        <col className="netm-ccol--state" />
        {hasBytes ? (
          <>
            <col className="netm-ccol--bytes" />
            <col className="netm-ccol--bytes" />
          </>
        ) : null}
      </colgroup>
      <thead>
        <tr>
          <th>Proto</th>
          <th>Local</th>
          <th>Remote (host)</th>
          <th>State</th>
          {hasBytes ? (
            <>
              <th>↓</th>
              <th>↑</th>
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {conns.map((c, i) => (
          <tr key={`${c.proto}|${c.local}|${c.remote ?? ""}|${i}`} data-testid="netm-conn">
            <td className="netm-cc--proto">{c.proto}</td>
            <td className="netm-cc--local" title={c.local}>
              {c.local}
            </td>
            <td className="netm-cc--remote" title={remoteTitle(c)}>
              {remoteCell(c)}
            </td>
            <td className="netm-cc--state">{c.state || DASH}</td>
            {hasBytes ? (
              <>
                <NumCell className="netm-cc--bytes" value={c.bytesIn} text={bytesCell(c.bytesIn)} />
                <NumCell className="netm-cc--bytes" value={c.bytesOut} text={bytesCell(c.bytesOut)} />
              </>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
