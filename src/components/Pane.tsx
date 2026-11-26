/** One LeafNode: <TabBar> + <PaneToolbar> + active view. Any mousedown inside claims focus, in
 * capture phase so it lands even when a child (xterm, a button) stops the event. */

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
  // `request*`: this ✕ kills EVERY terminal in the pane with no undo, so it asks when one is
  // busy (idle falls straight through to `closePane`).
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
      // NOT keyed by cwd: a singleton re-pointed in place; a remount would blank it mid-switch.
      return <MetricsPanel cwd={tab.ref.cwd} />;
    case "db-console":
      // Keyed by connectionId so a switch remounts rather than re-pointing the editor; the
      // buffer survives in the store (`dbConsoles`).
      return <DbConsoleTab key={tab.ref.connectionId} connectionId={tab.ref.connectionId} />;
    case "diff":
      // Keyed by path like the editor: re-pointing a live MergeView leaves the old panes.
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

  /** Report this pane's zone; <PaneTreeRoot> draws the preview, as the landing box can exceed
   * this `overflow: hidden` pane (see PaneTree's header). */
  const publish = (zone: DropZone | null) => {
    setDropZone(zone);
    const tabId = session.draggedTab();
    session.setIntent(zone && tabId ? { tabId, paneId: node.id, zone } : null);
  };

  const acceptsDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(TAB_DND_MIME);

  /** The tab strip beats the pane's zones: its events bubble here, and over it the gesture is a
   * reorder. The strip doesn't stop dragover, so this can clear a leftover body preview. */
  const overTabStrip = (e: DragEvent) =>
    (e.target as Element | null)?.closest?.(`.${TABBAR_CLASS}`) != null;

  /** Measured against the body so the strip is never an edge; `zoneFor` handles a missing rect. */
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

  // No `overTabStrip` guard: the strip stops propagation on its own drops, so it would be
  // unreachable; the test "a drop on the strip reorders…" guards the invariant.
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
