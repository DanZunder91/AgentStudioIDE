/**
 * PaneTree — the recursive render of a PaneNode, plus the drop preview.
 *
 * A pure function of the tree: split → <SplitContainer> with recursive children,
 * leaf → <Pane>. Every mutation goes through store actions; nothing here holds
 * layout state of its own.
 *
 * ── Why the drop preview lives HERE and not in <Pane> ────────────────────────
 *
 * It used to be a rectangle drawn inside the hovered pane ("this half of me").
 * That is a lie whenever the drop changes anything outside that pane — and it
 * always can, because a drop also prunes the source leaf if it empties, which
 * collapses a single-child split, which lets the survivor expand *past the
 * hovered pane*, up to the whole container.
 *
 * That happened in practice: with 2 panes, dragging a pane's only tab to the
 * other pane's edge previewed half of that pane while the tab actually landed in
 * half of the WHOLE work area — the preview covered only half of the screen. With
 * 3+ panes nothing collapses, so the lie was small enough to look fine.
 *
 * So the preview is rendered at the ROOT, over the whole tree, and its geometry
 * comes from running the REAL mutation (`planMoveTabToEdge` / `planMoveTab`)
 * against a copy of the store's tree and measuring where the tab lands. It is
 * correct for 2, 3, n panes and for any canonicalization rule added later,
 * because it renders the truth rather than an approximation of it.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { planDropRect, useAppStore } from "../app/store";
import type { PaneId, PaneNode, SplitNode, TabId } from "../app/types";
import type { DropZone } from "./dropZone";
import { Pane } from "./Pane";
import { SplitContainer } from "./SplitContainer";
import "./panes.css";

/**
 * Identity of a split's *structure* (not its sizes). allotment reads
 * `defaultSizes` on mount only, so remounting on a structural change is what
 * re-seeds it from the store — see SplitContainer's header. Sizes-only updates
 * leave this key untouched, so dragging a sash never remounts a pane.
 */
const structureKey = (node: SplitNode) =>
  `${node.orientation}:${node.children.map((c) => c.id).join("|")}`;

export function PaneTree({ node }: { node: PaneNode }) {
  if (node.type === "leaf") return <Pane node={node} />;

  return (
    <SplitContainer key={structureKey(node)} node={node}>
      {node.children.map((child) => (
        <PaneTree key={child.id} node={child} />
      ))}
    </SplitContainer>
  );
}

/* ────────────────────────── drop preview ────────────────────────── */

/** What the cursor is currently proposing: this tab, into this pane's zone. */
export interface DropIntent {
  tabId: TabId;
  paneId: PaneId;
  zone: DropZone;
}

/**
 * The drag session, shared with every <Pane> and <TabBar> below.
 *
 * Why the drag source has to announce itself at all: during `dragover` the
 * HTML5 drag data store is in **protected mode**, so `dataTransfer.getData()`
 * returns `""` and only `types` is readable. A drop target therefore cannot
 * learn WHICH tab is coming until the drop itself — but the preview needs it on
 * every dragover, to know which leaf would empty. So `<TabItem>` publishes it on
 * `dragstart` and clears it on `dragend` (which fires for a cancelled drag too).
 *
 * `draggedTab()` reads a ref rather than state on purpose: publishing the
 * dragged tab must not re-render the tree, and it is only ever read inside event
 * handlers, never during render.
 */
export interface DragSession {
  /** The drag started: `tabId` is the tab now moving. */
  beginDrag(tabId: TabId): void;
  /** The tab being dragged, if any. Call from event handlers only. */
  draggedTab(): TabId | null;
  /** Publish what the cursor is over; null clears the preview. */
  setIntent(intent: DropIntent | null): void;
  /** The drag ended — dropped or cancelled. Clears the tab and the preview. */
  endDrag(): void;
}

const noop: DragSession = {
  beginDrag: () => {},
  draggedTab: () => null,
  setIntent: () => {},
  endDrag: () => {},
};

const DragSessionContext = createContext<DragSession>(noop);

/**
 * The ambient drag session. Outside a <PaneTreeRoot> this is inert rather than
 * throwing, so a <Pane> can still be rendered on its own (the component tests
 * do exactly that) — a missing preview is not a reason to crash a pane.
 */
export const useDragSession = (): DragSession => useContext(DragSessionContext);

/** The overlay itself: where the dragged tab will land, over the whole tree. */
function DropPreview({ intent }: { intent: DropIntent }) {
  const layout = useAppStore((s) => s.layout);

  // The REAL mutation, run against a copy of the tree — not an approximation of
  // it. Includes the no-op case, which still has a box (the one the tab already
  // occupies): a drag must never go dark just because letting go here would
  // change nothing. Null is only ever an internal inconsistency.
  const rect = planDropRect(layout, intent.tabId, intent.paneId, intent.zone);
  if (!rect) return null;

  return (
    <div
      className="pane__dropzone"
      data-testid="drop-zone"
      data-zone={intent.zone}
      aria-hidden="true"
      style={{
        left: `${rect.left * 100}%`,
        top: `${rect.top * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
      }}
    />
  );
}

/**
 * The center work area's layout root — subscribes to the tree and renders it.
 *
 * M1 reads the single implicit session's tree straight off the store root; at
 * M2 this takes a `sessionId` prop and reads `sessions[sessionId].layout`
 * (ARCHITECTURE §2.3), which is the only change this file needs.
 */
export function PaneTreeRoot() {
  const layout = useAppStore((s) => s.layout);
  const draggedTabId = useRef<TabId | null>(null);
  const [intent, setIntent] = useState<DropIntent | null>(null);

  const publish = useCallback((next: DropIntent | null) => {
    // Only re-render when the proposal actually changes: dragover fires on
    // every pointer move, and the preview must not cost a tree render per frame.
    setIntent((prev) =>
      prev?.tabId === next?.tabId && prev?.paneId === next?.paneId && prev?.zone === next?.zone
        ? prev
        : next,
    );
  }, []);

  const session = useMemo<DragSession>(
    () => ({
      beginDrag: (tabId) => {
        draggedTabId.current = tabId;
      },
      draggedTab: () => draggedTabId.current,
      setIntent: publish,
      endDrag: () => {
        draggedTabId.current = null;
        publish(null);
      },
    }),
    [publish],
  );

  // Pinned to `layout` so that showing/moving/clearing the preview re-renders
  // the overlay ONLY. Without this, every dragover would re-render the whole
  // pane tree — and structural remounts of allotment are expensive enough
  // (SplitContainer's header) that keeping churn off this path is worth a line.
  const tree = useMemo(() => <PaneTree node={layout} />, [layout]);

  return (
    <div className="pane-tree">
      <DragSessionContext.Provider value={session}>{tree}</DragSessionContext.Provider>
      {intent && <DropPreview intent={intent} />}
    </div>
  );
}
