/** One leaf pane's tab strip. Tabs are drag sources; <Pane> is the drop target (`moveTab`). Each
 * tab subscribes to its own record (ARCHITECTURE §4). Movable kinds tear off to another OS window
 * by menu or by dropping outside the window (docs/design/tab-tearoff.md). */

import { useState, type DragEvent, type MouseEvent } from "react";

import { useAppStore } from "../app/store";
import { canTearOff } from "../app/tearoff/contract";
import { canStartWindow, takeForeignDrop, tearOffIfReleasedOutside } from "../app/tearoff/gesture";
import { moveTabToMainWindow, moveTabToNewWindow } from "../app/tearoff/handoff";
import { currentWindowLabel, isMainWindow } from "../app/tearoff/windowRole";
import { asTabId, type PaneId, type Tab, type TabId } from "../app/types";
import { restoredMarkerCopy } from "../features/fleet/restoredMarker";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  ChartIcon, CloseIcon, DatabaseIcon, FileIcon, LogStreamIcon, NetworkIcon, PlusIcon, TerminalIcon, VillageIcon } from "./icons";
import { InlineEditInput } from "./InlineEditInput";
import { useDragSession } from "./PaneTree";
import "./panes.css";

/** Drag payload: the TabId being moved between panes. */
export const TAB_DND_MIME = "application/x-agentstudio-tab";

/** Drag payload: the dragged tab's WINDOW label. A `TabId` only means something in its own
 * window's store, so another window must know where to ask (tear-off `give`). */
export const TAB_WINDOW_MIME = "application/x-agentstudio-tab-window";

/** A tab's window menu: `newWindow` if `canStartWindow` (movable, not alone in a detached
 * window), `mainWindow` if detached. Empty when neither, and an empty menu is not opened. */
export function tabWindowMenuItems(opts: {
  newWindow: boolean;
  mainWindow: boolean;
  toNewWindow: () => void;
  toMainWindow: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (opts.newWindow) items.push({ label: "Move to New Window", onSelect: opts.toNewWindow });
  if (opts.mainWindow) items.push({ label: "Move to Main Window", onSelect: opts.toMainWindow });
  return items;
}

/** A drop carrying another window's tab: ask that window for it and swallow the drop. False
 * for this window's own tabs. */
export function takeTabFromAnotherWindow(dataTransfer: DataTransfer): boolean {
  return takeForeignDrop(dataTransfer.getData(TAB_DND_MIME), dataTransfer.getData(TAB_WINDOW_MIME));
}

/** The strip's class, also `<Pane>`'s hit-test handle to yield to it; exported to keep that
 * coupling greppable. */
export const TABBAR_CLASS = "pane__tabbar";

/** Insertion index for a drop at `clientX`, counting the dragged tab if from this pane
 * (`moveTab` adjusts). Each tab claims up to its midpoint; under jsdom (0×0) it appends. */
export function insertionIndexAt(tabs: readonly HTMLElement[], clientX: number): number {
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabs.length;
}

/** Sequence tab: three stacked steps with a downward flow. Inline like GlobeIcon. */
function SequenceIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="sequence"
    >
      <rect x="2.5" y="2" width="11" height="3" rx="1" />
      <rect x="2.5" y="11" width="11" height="3" rx="1" />
      <path d="M8 5.5v5.5" />
      <path d="M6.5 9.5 8 11l1.5-1.5" />
    </svg>
  );
}

/** API-request tab: a small globe (no shared icon fits; kept inline). */
function GlobeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.7 1.6 2.6 3.8 2.6 6.25S9.7 12.65 8 14.25c-1.7-1.6-2.6-3.8-2.6-6.25S6.3 3.35 8 1.75z" />
    </svg>
  );
}

/** Session-picker tab: a small clock — history, not a live surface.
 *  Inline like GlobeIcon (no shared icon fits). */
function HistoryIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="history"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.4 1.6" />
    </svg>
  );
}

/** Diff tab (Git ▸ Compare with HEAD): a framed `+` over `−`, the universal
 *  "what changed" glyph. Inline like GlobeIcon/HistoryIcon — no shared icon
 *  fits. */
function DiffIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="diff"
    >
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.75" />
      <path d="M8 4.5v2.5M6.75 5.75h2.5M6.75 10.5h2.5" />
    </svg>
  );
}

function TabKindIcon({ kind }: { kind: Tab["kind"] }) {
  if (kind === "editor") return <FileIcon />;
  if (kind === "api-request") return <GlobeIcon />;
  // Its own glyph, not the terminal fallback: a sequence tab is titled by its
  // NAME, so without an arm here it would be indistinguishable from a terminal.
  if (kind === "sequence") return <SequenceIcon />;
  if (kind === "session-picker") return <HistoryIcon />;
  // Without this a metrics tab falls through to the terminal glyph and reads as
  // a shell — the tab strip is where a wrong icon is most confusing, because it is the
  // only thing distinguishing two tabs whose titles are both short.
  if (kind === "metrics") return <ChartIcon />;
  // Same reasoning as the metrics row above — without this a database console tab
  // falls through to the terminal glyph and reads as a shell, which in a tab strip is
  // the most confusing place for a wrong icon.
  if (kind === "db-console") return <DatabaseIcon />;
  // A diff tab's title is the bare filename: only the icon tells it from the editor tab.
  if (kind === "diff") return <DiffIcon />;
  // The two fleet views — both singletons titled one word, so the glyph
  // is what separates "Logs" from a terminal someone renamed "Logs".
  if (kind === "agent-logs") return <LogStreamIcon />;
  if (kind === "network") return <NetworkIcon />;
  // The Agent Village — another one-word singleton, same reasoning.
  if (kind === "village") return <VillageIcon />;
  return <TerminalIcon />;
}

function TabItem({
  tabId,
  paneId,
  active,
  insertBefore = false,
  insertAfter = false,
}: {
  tabId: TabId;
  paneId: PaneId;
  active: boolean;
  /** Draw the insertion line on this tab's leading edge. */
  insertBefore?: boolean;
  /** Draw it on the trailing edge — only ever the last tab (append). */
  insertAfter?: boolean;
}) {
  const tab = useAppStore((s) => s.tabs[tabId]);
  const setActiveTab = useAppStore((s) => s.layoutActions.setActiveTab);
  // Close through `requestCloseTab`: a dirty editor tab raises the unsaved-changes
  // confirm; everything else closes immediately, exactly like `closeTab`.
  const requestCloseTab = useAppStore((s) => s.editorActions.requestCloseTab);
  const renameTab = useAppStore((s) => s.layoutActions.renameTab);
  const renameAgent = useAppStore((s) => s.agentActions.renameAgent);
  // An agent tab's custom name lives on the agent (one name per agent);
  // subscribe to it so the tab tracks a rename made from the rail row too.
  // Both agent-terminal and agent-activity (a sub-agent's view) carry an agentId.
  const ref = tab?.ref;
  const agentId = ref && (ref.kind === "agent-terminal" || ref.kind === "agent-activity") ? ref.agentId : null;
  const agentCustomTitle = useAppStore((s) => (agentId ? (s.agents[agentId]?.customTitle ?? null) : null));
  // The "Resumed after restart" marker, the same words as the agent's rail row
  // (`restoredMarkerCopy`). Only ever set on a root, so an activity tab never shows it.
  const restored = useAppStore((s) => (agentId ? (s.agents[agentId]?.restored ?? null) : null));
  const agentError = useAppStore((s) => (agentId ? s.agents[agentId]?.error : undefined));
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Where the right-click menu is open (viewport coords), or null. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const session = useDragSession();

  if (!tab) return null; // tab record removed mid-render

  // Agent tabs display the agent's custom name; plain tabs their own.
  const displayName = agentId ? (agentCustomTitle ?? tab.title) : (tab.customTitle ?? tab.title);
  const restoredCopy = restored ? restoredMarkerCopy(restored, agentError) : null;

  const saveName = (name: string) => {
    setEditing(false);
    if (agentId) renameAgent(agentId, name);
    else renameTab(tabId, name);
  };

  const onClose = (e: MouseEvent) => {
    e.stopPropagation(); // don't activate the tab we're closing
    requestCloseTab(tabId);
  };

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(TAB_DND_MIME, tabId);
    e.dataTransfer.setData(TAB_WINDOW_MIME, currentWindowLabel());
    e.dataTransfer.effectAllowed = "move";
    // Publish who is moving for the drop preview: targets can't read `dataTransfer` until the
    // drop. Cleared on dragEnd, including a cancelled drag.
    session.beginDrag(tabId);
    setDragging(true);
  };

  const onDragEnd = (e: DragEvent) => {
    session.endDrag();
    setDragging(false);
    // No target took it (`none`): if released OUTSIDE the window (the OS reports the cursor),
    // tear it off; otherwise it stays. `?.`: a synthetic dragend may carry no DataTransfer.
    if (e.dataTransfer?.dropEffect === "none") void tearOffIfReleasedOutside(tabId);
  };

  const menuItems = (): ContextMenuItem[] =>
    tabWindowMenuItems({
      newWindow: canStartWindow(tabId),
      mainWindow: !isMainWindow() && canTearOff(tab),
      toNewWindow: () => void moveTabToNewWindow(tabId),
      toMainWindow: () => void moveTabToMainWindow(tabId),
    });

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault(); // never the webview's own page menu (nativeContextMenu.ts)
    if (menuItems().length > 0) setMenuAt({ x: e.clientX, y: e.clientY });
  };

  const className = [
    "pane-tab",
    active && "pane-tab--active",
    tab.dirty && "pane-tab--dirty",
    dragging && "pane-tab--dragging",
    insertBefore && "pane-tab--insert-before",
    insertAfter && "pane-tab--insert-after",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        className={className}
        title={displayName}
        draggable={!editing}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu}
        onClick={() => setActiveTab(paneId, tabId)}
        onAuxClick={(e) => {
          if (e.button === 1) requestCloseTab(tabId); // middle-click closes
        }}
      >
        <span className="pane-tab__icon">
          {tab.icon ?? <TabKindIcon kind={tab.kind} />}
        </span>
        {restoredCopy && (
          <span
            className="pane-tab__restored"
            role="img"
            aria-label={restoredCopy.label}
            title={restoredCopy.tooltip}
          >
            ↻
          </span>
        )}
        {editing ? (
          <InlineEditInput
            className="pane-tab__title-input"
            ariaLabel={`Rename tab ${displayName}`}
            value={displayName}
            onCommit={saveName}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="pane-tab__title"
            onDoubleClick={(e) => {
              e.stopPropagation(); // don't drag/select; just start editing
              setEditing(true);
            }}
          >
            {displayName}
          </span>
        )}
        {tab.dirty ? <span className="pane-tab__dirty" aria-label="Unsaved" /> : null}
        <button
          type="button"
          className="pane-tab__close"
          aria-label={`Close ${displayName}`}
          title="Close tab"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {/* A SIBLING of the tab, not a child: inside the draggable tab, a press-and-move on
          an item would start a tab drag, and a middle-click on one would close the tab. */}
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          ariaLabel={`Move ${displayName}`}
          onClose={() => setMenuAt(null)}
          items={menuItems()}
        />
      )}
    </>
  );
}

export function TabBar({
  paneId,
  tabIds,
  activeTabId,
}: {
  paneId: PaneId;
  tabIds: TabId[];
  activeTabId: TabId | null;
}) {
  const openTerminalTab = useAppStore((s) => s.layoutActions.openTerminalTab);
  const moveTab = useAppStore((s) => s.layoutActions.moveTab);
  /** Where the insertion line sits, as an index into the strip as drawn. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // `currentTarget` is the strip itself — non-null by definition inside a
  // handler bound to it, so this needs no ref and carries no dead null branch.
  const indexAt = (e: DragEvent): number =>
    insertionIndexAt([...e.currentTarget.querySelectorAll<HTMLElement>(".pane-tab")], e.clientX);

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(TAB_DND_MIME);

  /** The strip handles its own drops (reorder, not split). `<Pane>` yields by hit-test but stays
   * on the dragover path to clear its edge preview, so NO stopPropagation here. */
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(indexAt(e));
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropIndex(null);
  };

  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    // Ours alone: without this the pane's drop handler would also fire and
    // append the tab a second time.
    e.stopPropagation();
    const index = indexAt(e);
    setDropIndex(null);
    // A tab from another window: it moves here as a whole (tab tear-off), and lands
    // where that window's moves land — this window's focused pane.
    if (takeTabFromAnotherWindow(e.dataTransfer)) return;
    const raw = e.dataTransfer.getData(TAB_DND_MIME);
    if (raw) moveTab(asTabId(raw), paneId, index);
  };

  const lastIndex = tabIds.length - 1;

  return (
    <div
      className={TABBAR_CLASS}
      role="tablist"
      // Named because it is no longer the only tablist on screen: the view bar above is one too
      // (aria-label="Views"). Two same-role, same-name-less groups are ambiguous to a screen
      // reader in exactly the way they were ambiguous to `getByRole("tab")` in the E2E smokes.
      aria-label="Tabs in this pane"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {tabIds.map((tabId, i) => (
        <TabItem
          key={tabId}
          tabId={tabId}
          paneId={paneId}
          active={tabId === activeTabId}
          insertBefore={dropIndex === i}
          // Only the final tab can carry a trailing line: that is "append".
          insertAfter={i === lastIndex && dropIndex === tabIds.length}
        />
      ))}
      <button
        type="button"
        className="pane-icon-button pane-tab__new"
        aria-label="New terminal tab"
        title="New terminal"
        onClick={() => openTerminalTab({ paneId })}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
