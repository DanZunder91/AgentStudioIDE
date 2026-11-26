/** One SplitNode via `allotment` (ARCHITECTURE §4). allotment has no controlled sizes:
 * `defaultSizes` seeds on mount and <PaneTree> keys by structure to re-seed; `onChange` writes
 * back via `resizePane`. The store owns fractions, allotment only drag state: no feedback loop. */

import { Children, type ReactNode } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";

import { useAppStore } from "../app/store";
import type { SplitNode } from "../app/types";
import "./panes.css";

/** allotment reads `defaultSizes` as relative weights; fractions summing to 1 would collide with
 * its 30px default minimum during construction, so scale them up. */
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
