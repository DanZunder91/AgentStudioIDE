/** The fan-out tree as a flat render of `selectFleetRows` (see `flatten.ts`), so a virtualizer
 * can later replace the `.map()` and nothing else. */

import { useAppStore } from "../../app/store";
import { AgentRow } from "./AgentRow";
import { FolderGroupRow } from "./FolderGroupRow";
import { selectFleetRows } from "./flatten";
import "./fleet.css";

export function AgentTree() {
  // Referentially stable — see `selectFleetRows`. Selecting an un-memoized
  // `flattenFleet(...)` here is the infinite-loop footgun it exists to close.
  const rows = useAppStore(selectFleetRows);
  // How projects are drawn (Settings → Interface). One class on the list switches the
  // whole style in CSS, so changing it re-renders this element and no row.
  const groupStyle = useAppStore((s) => s.railGroupStyle);

  if (rows.length === 0) {
    return (
      <p className="fleet-empty">
        No agents yet.
        <br />
        <span className="fleet-empty__hint">Use + to start one.</span>
      </p>
    );
  }

  return (
    <ul className={`fleet-tree fleet-tree--groups-${groupStyle}`} role="tree" aria-label="Agents">
      {rows.map((row) =>
        row.kind === "folder" ? (
          <FolderGroupRow
            key={`folder:${row.path}`}
            path={row.path}
            name={row.name}
            agentCount={row.agentCount}
            collapsed={row.collapsed}
            rollupRunning={row.rollup.running}
            rollupWaiting={row.rollup.waiting_input}
            rollupDone={row.rollup.done}
            rollupError={row.rollup.error}
          />
        ) : (
          // Rollup as primitives: a fresh object per flatten would defeat
          // `<AgentRow>`'s memo on every activity tick.
          <AgentRow
            key={row.agentId}
            agentId={row.agentId}
            depth={row.depth}
            hasChildren={row.hasChildren}
            expanded={row.expanded}
            attention={row.attention}
            rollupRunning={row.rollup?.running ?? 0}
            rollupDone={row.rollup?.done ?? 0}
            rollupError={row.rollup?.error ?? 0}
          />
        ),
      )}
    </ul>
  );
}
