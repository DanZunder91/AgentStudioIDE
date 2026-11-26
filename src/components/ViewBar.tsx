/** Top-level strip of views (tmux-window model: a view is a whole pane tree; `<TabBar>` is the
 * sub-level). Only the active tree renders; `TerminalRegistry` keeps inactive terminals alive.
 * Counts read `viewTabIds`; `closeView` MOVES tabs, and the confirmation says so. */

import { useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import {
  useAppStore,
  viewTabIds,
  type ViewId,
  type ViewTreeSource,
  type ViewSnapshot,
} from "../app/store";
import { asTabId, type TabId } from "../app/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { CloseIcon, PlusIcon } from "./icons";
import { InlineEditInput } from "./InlineEditInput";
import { TAB_DND_MIME, insertionIndexAt } from "./TabBar";
import "./viewBar.css";

/** Drag payload for reordering the strip itself (tabs use `TAB_DND_MIME`). */
export const VIEW_DND_MIME = "application/x-agentstudio-view";

/** The strip's class and its own drop hit-test handle; exported like `TABBAR_CLASS`. */
export const VIEWBAR_CLASS = "view-bar";

/** What the strip draws per view: identity plus what is inside it. */
export interface ViewChip {
  id: ViewId;
  name: string;
  tabCount: number;
}

/** Name of the view `closeView` would rescue tabs into, `null` when the close is refused. Mirrors
 * its survivor rule: active view → next (else previous); inactive → the active one. */
export function rescueTargetName(
  views: readonly ViewSnapshot[],
  activeViewId: ViewId,
  closingId: ViewId,
): string | null {
  if (views.length <= 1) return null;
  const i = views.findIndex((v) => v.id === closingId);
  if (i < 0) return null;
  if (closingId !== activeViewId) {
    // Indexed, not `find(...)?.name ?? null`: `activeViewId` always names a member
    // of `views` (the store invariant `writeBackActiveView` leans on), so a
    // "no such active view" arm would be dead code, never a behaviour.
    return views[views.findIndex((v) => v.id === activeViewId)].name;
  }
  return (views[i + 1] ?? views[i - 1]).name;
}

/** Confirmation wording: count and verb both matter (the tabs MOVE, they are not destroyed). */
export function closeLabel(name: string, tabCount: number, into: string): string {
  if (tabCount === 0) return `Close “${name}” — it is empty`;
  const tabs = tabCount === 1 ? "1 tab" : `${tabCount} tabs`;
  return `Close “${name}” — its ${tabs} move to “${into}”`;
}

/* ───────────────────────────── the chip ───────────────────────────── */

interface ChipProps {
  chip: ViewChip;
  active: boolean;
  /** The last view standing cannot be closed — the store refuses, so do we. */
  closable: boolean;
  editing: boolean;
  /** Where the reorder line sits relative to this chip. */
  insertBefore: boolean;
  insertAfter: boolean;
  /** A tab is hovering over this chip and would move into it. */
  tabTarget: boolean;
  onActivate(): void;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onRequestClose(at: { x: number; y: number }): void;
  onTabHover(over: boolean): void;
  onTabDropped(tabId: TabId): void;
}

function ViewChipItem({
  chip,
  active,
  closable,
  editing,
  insertBefore,
  insertAfter,
  tabTarget,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestClose,
  onTabHover,
  onTabDropped,
}: ChipProps) {
  /** A tab is being dragged (not a view) — this chip is a move-into target. */
  const acceptsTab = (e: DragEvent) => e.dataTransfer.types.includes(TAB_DND_MIME);

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(VIEW_DND_MIME, chip.id);
    e.dataTransfer.effectAllowed = "move";
  };

  /** Drop a tab (`TAB_DND_MIME`) on a view's chip to move it there, without touching the pane
   * tree's single-tree drag session; `stopPropagation` keeps the strip's reorder out of it. */
  const onDragOver = (e: DragEvent) => {
    if (!acceptsTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    onTabHover(true);
  };

  const onDrop = (e: DragEvent) => {
    if (!acceptsTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    onTabHover(false);
    const raw = e.dataTransfer.getData(TAB_DND_MIME);
    if (raw) onTabDropped(asTabId(raw));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      onStartRename();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };

  const className = [
    "view-tab",
    active && "view-tab--active",
    tabTarget && "view-tab--tab-target",
    insertBefore && "view-tab--insert-before",
    insertAfter && "view-tab--insert-after",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={className}
      title={`${chip.name} — ${chip.tabCount} tab${chip.tabCount === 1 ? "" : "s"}`}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => onTabHover(false)}
      onDrop={onDrop}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {editing ? (
        <InlineEditInput
          className="view-tab__title-input"
          ariaLabel={`Rename view ${chip.name}`}
          value={chip.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span
          className="view-tab__title"
          onDoubleClick={(e) => {
            e.stopPropagation(); // rename, don't re-activate or start a drag
            onStartRename();
          }}
        >
          {chip.name}
        </span>
      )}
      {/* What is inside, before you have to ask — the same number the close
          confirmation quotes, from the same source, so they cannot disagree. */}
      <span className="view-tab__count" aria-hidden="true">
        {chip.tabCount}
      </span>
      <button
        type="button"
        className="view-tab__close"
        aria-label={`Close view ${chip.name}`}
        title={closable ? "Close view" : "A view cannot be closed while it is the only one"}
        disabled={!closable}
        onClick={(e: MouseEvent) => {
          e.stopPropagation(); // don't activate the view we're closing
          onRequestClose({ x: e.clientX, y: e.clientY });
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/* ─────────────────────────── the strip ─────────────────────────── */

export interface ViewBarViewProps {
  views: readonly ViewChip[];
  activeViewId: ViewId;
  onActivate(id: ViewId): void;
  onCreate(): void;
  onRename(id: ViewId, name: string): void;
  onClose(id: ViewId): void;
  /** Drop-onto-B: move `id` before `beforeId`, or to the end when null. */
  onReorder(id: ViewId, beforeId: ViewId | null): void;
  onMoveTabToView(tabId: TabId, viewId: ViewId): void;
  /** Rescue target for a closable view ("closable" means another view exists), so it is total. */
  rescueTargetOf(id: ViewId): string;
}

/** The strip as pure presentation, split from the store-bound `<ViewBar>` so gestures are
 * testable without a store. */
export function ViewBarView({
  views,
  activeViewId,
  onActivate,
  onCreate,
  onRename,
  onClose,
  onReorder,
  onMoveTabToView,
  rescueTargetOf,
}: ViewBarViewProps) {
  const [editingId, setEditingId] = useState<ViewId | null>(null);
  const [tabTargetId, setTabTargetId] = useState<ViewId | null>(null);
  /** Where the reorder line sits, as an index into the strip as drawn. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /** The pending close, anchored where the × was clicked. */
  const [confirming, setConfirming] = useState<{ chip: ViewChip; x: number; y: number } | null>(
    null,
  );

  // The last view standing is not closable — `closeView` refuses it, and an
  // affordance that is always refused is worse than no affordance.
  const closable = views.length > 1;

  const acceptsView = (e: DragEvent) => e.dataTransfer.types.includes(VIEW_DND_MIME);

  // Same measurement as the tab strip. Under jsdom every rect is 0×0 (returns "append"), which
  // is why tests stub rects.
  const indexAt = (e: DragEvent): number =>
    insertionIndexAt([...e.currentTarget.querySelectorAll<HTMLElement>(".view-tab")], e.clientX);

  const onBarDragOver = (e: DragEvent) => {
    if (!acceptsView(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(indexAt(e));
  };

  const onBarDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropIndex(null);
  };

  const onBarDrop = (e: DragEvent) => {
    if (!acceptsView(e)) return;
    e.preventDefault();
    const index = indexAt(e);
    setDropIndex(null);
    const raw = e.dataTransfer.getData(VIEW_DND_MIME);
    // `reorderViews` is drop-onto-B, not by index: the chip at the insertion
    // point IS the "before" anchor, and past the last one it is the end (null).
    if (raw) onReorder(raw as ViewId, views[index]?.id ?? null);
  };

  const commitRename = (id: ViewId, raw: string) => {
    setEditingId(null);
    const name = raw.trim();
    // An empty name is a rejected rename, not a nameless view: the strip's only
    // handle on a view IS its name. (`renameView` refuses it too — this keeps
    // the field from closing as if it had worked.)
    if (name) onRename(id, name);
  };

  const confirmItems = (chip: ViewChip): ContextMenuItem[] => [
    {
      label: closeLabel(chip.name, chip.tabCount, rescueTargetOf(chip.id)),
      onSelect: () => onClose(chip.id),
      danger: true,
    },
    { label: "Keep it", onSelect: () => {} },
  ];

  const lastIndex = views.length - 1;

  return (
    <div
      className={VIEWBAR_CLASS}
      role="tablist"
      aria-label="Views"
      data-testid="view-bar"
      onDragOver={onBarDragOver}
      onDragLeave={onBarDragLeave}
      onDrop={onBarDrop}
    >
      {views.map((chip, i) => (
        <ViewChipItem
          key={chip.id}
          chip={chip}
          active={chip.id === activeViewId}
          closable={closable}
          editing={editingId === chip.id}
          insertBefore={dropIndex === i}
          // Only the final chip can carry a trailing line: that is "append".
          insertAfter={i === lastIndex && dropIndex === views.length}
          tabTarget={tabTargetId === chip.id}
          onActivate={() => onActivate(chip.id)}
          onStartRename={() => setEditingId(chip.id)}
          onCommitRename={(name) => commitRename(chip.id, name)}
          onCancelRename={() => setEditingId(null)}
          onRequestClose={({ x, y }) => setConfirming({ chip, x, y })}
          onTabHover={(over) => setTabTargetId(over ? chip.id : null)}
          onTabDropped={(tabId) => onMoveTabToView(tabId, chip.id)}
        />
      ))}
      <button
        type="button"
        className="pane-icon-button view-tab__new"
        aria-label="New view"
        title="New view"
        onClick={onCreate}
      >
        <PlusIcon />
      </button>
      {confirming && (
        <ContextMenu
          items={confirmItems(confirming.chip)}
          x={confirming.x}
          y={confirming.y}
          ariaLabel={`Close view ${confirming.chip.name}?`}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

/** The store-bound strip — the one mounted in `App`. */
export function ViewBar() {
  const views = useAppStore((s) => s.views);
  const activeViewId = useAppStore((s) => s.activeViewId);
  const actions = useAppStore((s) => s.layoutActions);
  // The ACTIVE view's live tree (its `views` snapshot is stale by contract). Selected per field,
  // never `(s) => s`, so the bar re-renders only on what `ViewTreeSource` names (ARCHITECTURE §4).
  const liveLayout = useAppStore((s) => s.layout);

  const chips = useMemo<ViewChip[]>(() => {
    const state: ViewTreeSource = { layout: liveLayout, views, activeViewId };
    return views.map((view) => ({
      id: view.id,
      name: view.name,
      tabCount: viewTabIds(state, view.id).length,
    }));
  }, [views, activeViewId, liveLayout]);

  return (
    <ViewBarView
      views={chips}
      activeViewId={activeViewId}
      onActivate={actions.activateView}
      // `createView` already activates; calling it is the whole `+`.
      onCreate={() => actions.createView()}
      onRename={actions.renameView}
      onClose={actions.closeView}
      onReorder={actions.reorderViews}
      onMoveTabToView={actions.moveTabToView}
      // Null only where a close is refused, and the × is disabled exactly then; narrowed rather
      // than coalesced so an impossible state never ships a wrong sentence.
      rescueTargetOf={(id) => rescueTargetName(views, activeViewId, id) as string}
    />
  );
}
