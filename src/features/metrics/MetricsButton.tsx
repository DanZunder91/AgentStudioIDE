/** Titlebar button opening the metrics tab (like `<ApiRequestButton/>`). The cwd only enables
 * "This project"; the tab opens in All projects regardless, and `null` (nothing selected) is the
 * common case, pinned end to end by `metricsNoSelectionSeam.test.tsx`. */

import { useAppStore } from "../../app/store";
import { rootOf } from "../../app/store";

export function MetricsButton(): React.JSX.Element {
  const openMetricsTab = useAppStore((s) => s.layoutActions.openMetricsTab);
  // The selected agent's ROOT cwd — a sub-agent has no cwd of its own, which is the
  // same resolution `applyFocusFollow` uses for the collapse feature.
  const cwd = useAppStore((s) => {
    const selected = s.selection.selectedAgentId;
    if (!selected) return null;
    return rootOf(s.agents, selected)?.cwd ?? null;
  });

  return (
    <button
      type="button"
      className="titlebar__icon-btn"
      data-testid="titlebar-metrics"
      aria-label="Claude usage metrics"
      title="Claude usage metrics — turns, tokens and time for the last 24 hours"
      onClick={() => openMetricsTab(cwd)}
    >
      {/* Three ascending bars — a chart, legible at 15px, stroked with currentColor so
          it inherits the titlebar palette like every other icon here. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 20V13M10 20V6M16 20V10M22 20H2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
