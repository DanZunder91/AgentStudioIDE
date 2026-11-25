/**
 * The fan-out tree — the product's headline surface, from M3.
 *
 * A flat render of `selectFleetRows`, not a recursive component tree. The
 * recursion happens at build time in `flattenFleet`; see that module's header
 * for the full argument. The short version: a recursive component tree cannot
 * be virtualized, and M3 makes this list unbounded.
 *
 * When virtualization lands, it replaces the `.map()` below and nothing else:
 * `rows` is already the windowable array a virtualizer wants, and `<AgentRow>`
 * already takes its depth as a prop rather than inheriting it from the DOM.
 */

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
          // Roll-up is destructured into PRIMITIVE props on purpose: `<AgentRow>`
          // is memoized, so handing it the rollup object (fresh identity every
          // flatten) would re-render every parent row on every activity tick.
          // Numbers + a bool compare by value, so a row re-renders only when its
          // own counts actually change. This is what keeps the 600-ticks→0-renders
          // budget holding at depth.
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
