/**
 * ViewBar — the TOP-LEVEL strip of views.
 *
 * A **view** is one whole arrangement of terminals: the iTerm2 / tmux-window
 * model — a window-style view that holds, say, four terminals, with a switch to
 * another view that holds two more. Switching a view swaps the entire pane tree;
 * today's per-pane tab strips (`<TabBar>`) read as the sub-level under it, which
 * is the simplest model and looks better.
 *
 * ── Why nothing here keeps an inactive view alive ────────────────────────────
 * `TerminalRegistry` owns the xterm instance and the PTY OUTSIDE React: React
 * only mounts and unmounts a DOM host, and only `dispose()` tears anything down
 * (`useTerminal` detaches on unmount; `detach()` parks the DOM in an offscreen
 * holder). So only the ACTIVE view's tree is ever rendered; inactive views are
 * pure data and their terminals keep running with scrollback intact. There is
 * deliberately no keep-alive / hidden-mount scheme — it would be complexity for
 * a problem the registry already solved. The one real consequence is geometry:
 * a tree that comes back may come back at a different size, which is why
 * `PaneTreeRoot` keys the tree on the active view (see PaneTree.tsx) so every
 * terminal re-`attach`es and `applyFit` re-measures against the NEW pane.
 *
 * ── Visual language ──────────────────────────────────────────────────────────
 * Deliberately the same idiom as `<TabBar>`, one level up: the `+` is literally
 * `pane-icon-button` and `PlusIcon`, the close affordance is `CloseIcon`, rename
 * is `InlineEditInput` (double-click or F2), reorder reuses `insertionIndexAt`
 * and the same inset-shadow insertion line, and the confirmation is the shared
 * `ContextMenu` primitive. The only thing that differs is the accent edge — a
 * view chip carries it on TOP and the active chip takes the pane header's own
 * surface colour, so the active view visually "holds up" the strip beneath it.
 *
 * ── The counts are not decoration ────────────────────────────────────────────
 * Each chip shows how many tabs its view holds, read through the store's
 * `viewTabIds` so the badge and the close confirmation can never disagree.
 * `closeView` **rescues** those tabs into the view you are left looking at
 * rather than killing them, so the confirmation says exactly that — quoting
 * "3 tabs will be closed" would be a scarier lie than saying nothing.
 */

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

/**
 * The strip's class — also the hit-test handle for its own drop logic. Exported
 * so the coupling is explicit and greppable, exactly as `TABBAR_CLASS` is.
 */
export const VIEWBAR_CLASS = "view-bar";

/** What the strip draws per view: identity plus what is inside it. */
export interface ViewChip {
  id: ViewId;
  name: string;
  tabCount: number;
}

/**
 * Where `closeView` would rescue this view's tabs to, by name — `null` when the
 * close is refused (last view / unknown id).
 *
 * Mirrors `closeView`'s survivor rule exactly: closing the ACTIVE view hands
 * over to the next view, else the previous one; closing an inactive view leaves
 * the active one untouched and lands the tabs there.
 */
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

/**
 * The confirmation's wording. The count is the whole point of asking — but so
 * is the verb: these tabs MOVE, they are not destroyed.
 */
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

  /**
   * Moving a tab into another view: drop it on that view's chip.
   *
   * A tab is already a drag source (`<TabItem>` publishes `TAB_DND_MIME`), so
   * this is the whole gesture — no change to the pane tree's drag session,
   * which stays single-tree and therefore keeps telling the truth about its own
   * drop preview. `stopPropagation` keeps the strip's reorder handler out of it.
   */
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
  /**
   * Where a close would rescue that view's tabs to. Asked only for a view the
   * strip is willing to close, and "closable" means another view exists to
   * rescue into — so this is total here, and the label needs no fallback string.
   */
  rescueTargetOf(id: ViewId): string;
}

/**
 * The strip, as pure presentation. Split out from the store-bound `<ViewBar>`
 * so every gesture — rename, the counted close confirmation, reorder, moving a
 * tab into another view — is testable without standing up a whole store.
 */
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

  // The same measurement the tab strip uses (each chip claims the drop up to
  // its own midpoint; past the last midpoint it appends). Under jsdom every
  // rect is 0×0, so this returns "append" — deterministic, and why the tests
  // stub rects rather than trusting the default.
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
  // The ACTIVE view's live tree. Its snapshot in `views` is stale by contract,
  // and `viewTabIds` is the store's own encoding of that rule — a confirmation
  // quoting a count from whenever the view was last left is not one. Selected
  // field by field (never `(s) => s`) so the bar re-renders on the layout slice
  // only, per ARCHITECTURE §4 — and only on the two fields the counts read, which
  // is exactly what `ViewTreeSource` names.
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
      // `rescueTargetName` is null only where a close is REFUSED (the last view,
      // or an id that is not in the bar), and the strip disables the × in exactly
      // that case — so no confirmation can ever ask for a target that is missing.
      // Narrowed here rather than coalesced at the label: `move to “”` would be a
      // wrong sentence shipped to cover an impossible state.
      rescueTargetOf={(id) => rescueTargetName(views, activeViewId, id) as string}
    />
  );
}
