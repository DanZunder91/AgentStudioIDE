/** Recursive render of a PaneNode (split → <SplitContainer>, leaf → <Pane>); no layout state
 * here. The drop preview renders at the ROOT from the REAL mutation (`planMoveTabToEdge` /
 * `planMoveTab`) on a tree copy, since pruning can grow the survivor past the hovered pane. */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { planDropRect, useAppStore } from "../app/store";
import type { PaneId, PaneNode, SplitNode, TabId } from "../app/types";
import type { DropZone } from "./dropZone";
import { Pane } from "./Pane";
import { SplitContainer } from "./SplitContainer";
import "./panes.css";

/** A split's structure key (not sizes): allotment reads `defaultSizes` on mount only, so a
 * structural remount re-seeds it, and a sash drag never remounts a pane. */
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

/** The drag session shared with every <Pane> and <TabBar>. Drag data is unreadable during
 * dragover, so `<TabItem>` publishes the tab on dragstart and clears it on dragend.
 * `draggedTab()` reads a ref: publishing must not re-render; it's read only in handlers. */
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

/** Inert outside a <PaneTreeRoot> (not throwing), so a <Pane> renders alone, as in tests. */
export const useDragSession = (): DragSession => useContext(DragSessionContext);

/** The overlay itself: where the dragged tab will land, over the whole tree. */
function DropPreview({ intent }: { intent: DropIntent }) {
  const layout = useAppStore((s) => s.layout);

  // The REAL mutation on a tree copy. A no-op still has a box (where the tab already is), so a
  // drag never goes dark; null is only an internal inconsistency.
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

/** The center work area's layout root. At M2 it takes a `sessionId` and reads
 * `sessions[sessionId].layout` (ARCHITECTURE §2.3). */
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

  // Memoized on `layout` so the preview re-renders only the overlay, not the tree (allotment
  // remounts are expensive; see SplitContainer's header).
  const tree = useMemo(() => <PaneTree node={layout} />, [layout]);

  return (
    <div className="pane-tree">
      <DragSessionContext.Provider value={session}>{tree}</DragSessionContext.Provider>
      {intent && <DropPreview intent={intent} />}
    </div>
  );
}
