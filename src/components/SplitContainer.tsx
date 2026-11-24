/**
 * SplitContainer — renders one SplitNode with `allotment` (ARCHITECTURE §4:
 * "own the PaneNode tree in the store; render split *containers* with
 * allotment").
 *
 * ── On "controlled sizes ↔ onChange" ─────────────────────────────────────────
 * allotment has **no controlled `sizes` prop**: its `sizes` prop is deprecated
 * in favour of `defaultSizes`, which is read on mount only (the escape hatch is
 * an imperative `AllotmentHandle.resize()`). So the store cannot drive it
 * frame-by-frame the way a controlled input works. The contract we implement:
 *
 *   - store → allotment: `defaultSizes` seeds the split on mount, and <PaneTree>
 *     keys this component by the split's child-id list, so any *structural*
 *     change (split/close/move) remounts it and re-seeds from the store.
 *   - allotment → store: `onChange` writes back through `resizePane`, which
 *     normalizes pixels to fractions and ignores no-op emissions.
 *
 * Net: the store stays the source of truth for persisted fractions, allotment
 * owns only transient drag state, and there is no feedback loop (a `defaultSizes`
 * change mid-life is inert by design).
 */

import { Children, type ReactNode } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";

import { useAppStore } from "../app/store";
import type { SplitNode } from "../app/types";
import "./panes.css";

/**
 * allotment treats `defaultSizes` as relative weights (it sums them into a
 * descriptor, then lays out into the container). Our fractions sum to 1, which
 * would collide with allotment's 30px default minimum during construction, so
 * scale them into a comfortable integer range first.
 */
const SIZE_SCALE = 1000;

/** Keep a pane from being dragged down to an unusable sliver. */
const MIN_PANE_PX = 140;

export function SplitContainer({
  node,
  children,
}: {
  node: SplitNode;
  children: ReactNode;
}) {
  const resizePane = useAppStore((s) => s.layoutActions.resizePane);

  return (
    <Allotment
      className="split"
      // types.ts: 'row' = side-by-side (vertical divider); 'column' = stacked.
      vertical={node.orientation === "column"}
      defaultSizes={node.sizes.map((f) => Math.max(1, Math.round(f * SIZE_SCALE)))}
      onChange={(sizes) => resizePane(node.id, sizes)}
      proportionalLayout
    >
      {Children.map(children, (child) => (
        <Allotment.Pane minSize={MIN_PANE_PX}>{child}</Allotment.Pane>
      ))}
    </Allotment>
  );
}
