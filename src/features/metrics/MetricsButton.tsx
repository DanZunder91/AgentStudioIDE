/**
 * MetricsButton — the titlebar affordance that opens the metrics dashboard.
 *
 * Mirrors `<ApiRequestButton/>` exactly: a small icon button whose only job is one
 * store action. The dashboard is a **tab**, not an overlay — you keep it
 * open beside a running agent, split it next to a terminal, and drill total → turn →
 * child, none of which an `aria-modal` overlay can do.
 *
 * The bar-chart glyph is defined here rather than in `src/components/icons.tsx` for the
 * same reason `UsageLimits.tsx` keeps its own refresh glyph: the feature owns its mark,
 * and it keeps this addition from touching a shared file.
 *
 * 🔴 **What the cwd is for, and what it is NOT for.** It names the project the dashboard
 * *can* narrow to — it enables the "This project" toggle — and nothing more. The dashboard
 * opens in **All projects** scope regardless, because that is the question it answers
 * (it is about total usage on the machine, not about one project).
 *
 * Passing `null` when nothing is selected is correct and is the common case. It used to be
 * a *fatal* case: an earlier store paired that `null` with a hard-coded `scope: "project"`,
 * which `claude_metrics` rejected with `scan-failed`, so opening the tab showed
 * "Could not read your sessions". Nothing about this component was wrong — the seam
 * between it and the command was never tested. `metricsNoSelectionSeam.test.tsx` is that
 * missing test, and it drives the real path from this button's click.
 */

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
