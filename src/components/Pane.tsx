/**
 * Pane — one LeafNode: <TabBar> + <PaneToolbar> + the active tab's view.
 *
 * The focused pane carries a blue top-border accent and is where new tabs open.
 * Any mousedown inside claims focus (capture phase, so it lands even when a
 * child — xterm, a button — handles/stops the event).
 */

import { useRef, useState, type DragEvent } from "react";

import { useAppStore } from "../app/store";
import { asTabId, type LeafNode, type PaneId, type TabId } from "../app/types";
// Written concurrently by the terminal agent to exactly this contract; the
// import may not resolve until integration.
import { TerminalView } from "../features/terminal/TerminalView";
import { ActivityView } from "../features/fleet/ActivityView";
import { CodeEditor } from "../features/editor";
import { ApiRequestView, SequenceView } from "../features/api";
import { DiffView } from "../features/git";
import { SessionPicker } from "../features/sessions/SessionPicker";
import { MetricsPanel } from "../features/metrics/MetricsPanel";
import { AgentLogsPanel } from "../features/agentlogs";
import { NetworkPanel } from "../features/network";
import { VillagePanel } from "../features/village";
import { DbConsoleTab } from "../features/db/console/DbConsoleTab";
import { zoneFor, type DropZone } from "./dropZone";
import { useDragSession } from "./PaneTree";
import { TabBar, TABBAR_CLASS, TAB_DND_MIME, takeTabFromAnotherWindow } from "./TabBar";
import { CloseIcon, PlusIcon, SplitDownIcon, SplitRightIcon } from "./icons";
import "./panes.css";

/** The pane's top-right toolbar cluster. */
function PaneToolbar({ paneId }: { paneId: PaneId }) {
  const splitPane = useAppStore((s) => s.layoutActions.splitPane);
  // `request*`, not the raw primitive: this ✕ kills EVERY terminal in the pane
  // in one click with no undo, so it has to ask first when one of them is busy.
  // `requestClosePane` falls straight through to
  // `closePane` when nothing is running, so the idle case is unchanged.
  const requestClosePane = useAppStore((s) => s.layoutActions.requestClosePane);
  const isOnlyPane = useAppStore((s) => s.layout.type === "leaf");

  return (
    <div className="pane__toolbar">
      <button
        type="button"
        className="pane-icon-button"
        aria-label="Split pane right"
        title="Split right"
        // 'row' = side-by-side / vertical divider (types.ts).
        onClick={() => splitPane(paneId, "row")}
      >
        <SplitRightIcon />
      </button>
      <button
        type="button"
        className="pane-icon-button"
        aria-label="Split pane down"
        title="Split down"
        onClick={() => splitPane(paneId, "column")}
      >
        <SplitDownIcon />
      </button>
      <button
        type="button"
        className="pane-icon-button"
        aria-label="Close pane"
        title={isOnlyPane ? "Close all tabs" : "Close pane"}
        onClick={() => requestClosePane(paneId)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** The tab body — switches on the active tab's kind. */
function TabView({ tabId }: { tabId: TabId }) {
  const tab = useAppStore((s) => s.tabs[tabId]);
  if (!tab) return null;

  switch (tab.ref.kind) {
    case "terminal":
    case "agent-terminal":
      // Keyed by terminalId so switching tabs never re-points a live xterm
      // host at a different PTY.
      return (
        <TerminalView
          key={tab.ref.terminalId}
          terminalId={tab.ref.terminalId}
        />
      );
    case "agent-activity":
      // A sub-agent's read-only transcript. Keyed by agentId so switching tabs
      // never leaves one activity view polling for a different sub-agent.
      return <ActivityView key={tab.ref.agentId} agentId={tab.ref.agentId} />;
    case "editor":
      // Keyed by path so switching files remounts CM6 with the new document
      // rather than mutating a live editor in place.
      return <CodeEditor key={tab.ref.path} path={tab.ref.path} />;
    case "api-request":
      // Keyed by requestId so switching tabs never re-points one request view
      // at a different request's state.
      return <ApiRequestView key={tab.ref.requestId} requestId={tab.ref.requestId} />;
        case "sequence":
      return <SequenceView key={tab.ref.sequenceId} sequenceId={tab.ref.sequenceId} />;
case "session-picker":
      // A folder's past Claude sessions. Keyed by cwd so switching
      // between two folders' pickers remounts rather than re-pointing an
      // in-flight fetch at a different folder.
      return <SessionPicker key={tab.ref.cwd} cwd={tab.ref.cwd} />;
    case "metrics":
      // The Claude metrics dashboard. Deliberately NOT keyed by cwd: the tab
      // is a singleton that gets re-pointed at a new project in place, and the
      // panel's own mount effect refetches when `cwd` changes — remounting would
      // throw away the last good report and blank the panel mid-switch.
      return <MetricsPanel cwd={tab.ref.cwd} />;
    case "db-console":
      // A database query console. Keyed by connectionId so switching between two
      // connections' consoles remounts rather than re-pointing one console's editor at
      // another connection's session. The BUFFER survives that remount because it lives
      // in the store (`dbConsoles`), not in the component — see DbConsoleTab's header.
      return <DbConsoleTab key={tab.ref.connectionId} connectionId={tab.ref.connectionId} />;
    case "diff":
      // HEAD ↔ working tree for one file. Keyed by path for the same reason the
      // editor is: switching tabs must remount the MergeView on the new file
      // rather than re-point a live one, which would leave the old file's two
      // panes on screen under the new file's heading.
      return <DiffView key={tab.ref.path} path={tab.ref.path} />;
    case "agent-logs":
      // The fleet-wide log stream. Singleton, no key needed.
      return <AgentLogsPanel />;
    case "network":
      // The capture-proxy flow table. Singleton, no key needed.
      return <NetworkPanel />;
    case "village":
      // The Agent Village. Singleton, no key needed.
      return <VillagePanel />;
  }
}

/** Empty leaf: a split with nothing in it yet, or the last pane after a close. */
function EmptyPane({ paneId }: { paneId: PaneId }) {
  const openTerminalTab = useAppStore((s) => s.layoutActions.openTerminalTab);
  return (
    <div className="pane__placeholder">
      <span className="pane__placeholder-hint">This pane is empty</span>
      <button
        type="button"
        className="pane__button"
        data-testid="empty-pane-new-terminal"
        onClick={() => openTerminalTab({ paneId })}
      >
        <PlusIcon />
        New terminal
      </button>
    </div>
  );
}

export function Pane({ node }: { node: LeafNode }) {
  const focused = useAppStore((s) => s.focusedPaneId === node.id);
  const focusPane = useAppStore((s) => s.layoutActions.focusPane);
  const moveTab = useAppStore((s) => s.layoutActions.moveTab);
  const moveTabToEdge = useAppStore((s) => s.layoutActions.moveTabToEdge);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const session = useDragSession();

  /**
   * Report what this pane's zone would mean, and let <PaneTreeRoot> draw it.
   *
   * This pane deliberately does NOT draw the preview itself: the box the tab
   * lands in can be larger than this pane (a drop can prune the source leaf and
   * collapse a split, letting the survivor fill the container), and `.pane` is
   * `overflow: hidden`. See PaneTree's header — this is the half-screen
   * preview bug.
   */
  const publish = (zone: DropZone | null) => {
    setDropZone(zone);
    const tabId = session.draggedTab();
    session.setIntent(zone && tabId ? { tabId, paneId: node.id, zone } : null);
  };

  const acceptsDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(TAB_DND_MIME);

  /**
   * Hit-test priority: the tab strip wins over the pane's zones.
   *
   * `<TabBar>` is a descendant, so its drag events bubble here too. Over the
   * strip the gesture means *reorder / insert at index*, which the strip owns —
   * so the pane must not also paint an edge preview or run a second drop. The
   * strip does not stopPropagation on dragover precisely so this handler still
   * runs and can clear a preview left over from the body.
   */
  const overTabStrip = (e: DragEvent) =>
    (e.target as Element | null)?.closest?.(`.${TABBAR_CLASS}`) != null;

  /**
   * Measured against the body so the tab strip is never an edge — see
   * `zoneFor`, which also absorbs the "not laid out yet / no rect" case.
   */
  const zoneOf = (e: DragEvent): DropZone =>
    zoneFor(bodyRef.current?.getBoundingClientRect(), e.clientX, e.clientY);

  const onDragOver = (e: DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault(); // required to become a drop target
    e.dataTransfer.dropEffect = "move";
    publish(overTabStrip(e) ? null : zoneOf(e));
  };

  const onDragLeave = (e: DragEvent) => {
    // Ignore the leave events fired while crossing descendants.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    publish(null);
  };

  // NOTE: no `overTabStrip` guard here, deliberately. The strip stops
  // propagation on its own drops, so a drop from the strip provably never
  // reaches this handler — a second guard would be unreachable code pretending
  // to be defence. What actually protects the invariant is a test:
  // "a drop on the strip reorders — it does not also move/split via the pane".
  const onDrop = (e: DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    // Recomputed from the drop's own coordinates rather than trusting the last
    // dragover: the two always agree, and this cannot land the tab somewhere
    // the preview never showed.
    const zone = zoneOf(e);
    publish(null);

    // A tab from ANOTHER window (tab tear-off): it moves into this window whole, and
    // lands where that window's moves land — so the zone does not apply to it.
    if (takeTabFromAnotherWindow(e.dataTransfer)) return;

    // Read only here, never on dragover: the HTML5 drag data store is in
    // protected mode until the drop, so `getData()` returns "" before it.
    const raw = e.dataTransfer.getData(TAB_DND_MIME);
    if (!raw) return;
    const tabId = asTabId(raw);

    if (zone === "center") moveTab(tabId, node.id);
    else moveTabToEdge(tabId, node.id, zone);
  };

  const className = [
    "pane",
    focused && "pane--focused",
    dropZone && "pane--drop-target",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onMouseDownCapture={() => focusPane(node.id)}
      onFocusCapture={() => focusPane(node.id)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="pane__header">
        <TabBar
          paneId={node.id}
          tabIds={node.tabIds}
          activeTabId={node.activeTabId}
        />
        <PaneToolbar paneId={node.id} />
      </div>
      <div className="pane__body" ref={bodyRef}>
        {node.activeTabId ? (
          <TabView tabId={node.activeTabId} />
        ) : (
          <EmptyPane paneId={node.id} />
        )}
      </div>
      {/* NOTE: no drop preview here — <PaneTreeRoot> draws it over the whole
          tree, because the box the tab lands in can be bigger than this pane.
          See PaneTree's header. */}
    </div>
  );
}
