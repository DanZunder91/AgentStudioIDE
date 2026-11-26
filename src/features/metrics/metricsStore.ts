/** Feature-local zustand store for one metrics report (like `usageStore`). A failed refresh keeps
 * the last good report (shown stale); scans are single-flight, which also orders responses. No
 * timer: a scan runs on tab open, on Rescan or on a query change, never on a cadence. */

import { create } from "zustand";

import { claudeMetrics } from "./metricsIpc";
import { parseMetricsError } from "./metricsFormat";
import type {
  MetricsErrorCode,
  MetricsReport,
  MetricsScopeKind,
  MetricsWindowKind,
} from "./metricsTypes";

/** What was asked for. `cwd` is kept even in `"all"` scope, where it only tells the panel whether
 * `"project"` is possible; see {@link applyQuery}. */
export interface MetricsQuery {
  window: MetricsWindowKind;
  scope: MetricsScopeKind;
  /** Project root. `null` (nothing selected) is common and never a failure. */
  cwd: string | null;
}

export interface MetricsStoreState {
  /** Last successful report, kept across a failed refresh; `null` until the first success. */
  report: MetricsReport | null;
  /** Code of the most recent failure; cleared on the next success. */
  error: MetricsErrorCode | null;
  /** True while a scan is in flight — drives the Rescan button's busy state. */
  loading: boolean;
  /** The query the current `report` was produced for (and the next fetch will use). */
  query: MetricsQuery;
  /** Scan now; never throws (failures land in {@link error}). Joins an outstanding scan. */
  refresh: () => Promise<void>;
  /** No-op, and no fetch, when the window is already selected. */
  setWindow: (window: MetricsWindowKind) => Promise<void>;
  /** Same no-op rule. Rust widens a null-cwd `"project"`; the panel disables it anyway. */
  setScope: (scope: MetricsScopeKind) => Promise<void>;
  /** Called on mount with the tab's cwd. Refetches only in `"project"` scope; in `"all"` it just
   * records the cwd for the scope toggle. */
  setCwd: (cwd: string | null) => Promise<void>;
}

/** Last 24 h across the whole machine. `"all"` because the panel usually opens with no agent
 * selected, so `cwd` is null. */
const INITIAL_QUERY: MetricsQuery = {
  window: "last_24h",
  scope: "all",
  cwd: null,
};

export const useMetricsStore = create<MetricsStoreState>()(() => ({
  report: null,
  error: null,
  loading: false,
  query: INITIAL_QUERY,
  // Stable function identities (hoisted declarations, not closures minted per store
  // creation), so a consumer can safely put them in a `useEffect` dep array.
  refresh: refreshNow,
  setWindow: setWindow,
  setScope: setScope,
  setCwd: setCwd,
}));

/* ── the single-flight fetch ──────────────────────────────────────────────── */

/** The outstanding scan, or null: the single-flight gate and the ordering guarantee. */
let inFlight: Promise<void> | null = null;

/** Scan once and fold the outcome into the store. Never rejects, so callers fire-and-forget. */
async function fetchOnce(): Promise<void> {
  const { window, scope, cwd } = useMetricsStore.getState().query;
  try {
    const report = await claudeMetrics(window, scope, cwd);
    useMetricsStore.setState({ report, error: null, loading: false });
  } catch (reason) {
    // No `report` in the patch: a failure keeps the last good one. The detail may name a path and
    // is never rendered or logged.
    useMetricsStore.setState({ error: parseMetricsError(reason), loading: false });
  }
}

/** Start a scan, or join the running one. `inFlight` is set before returning, so no caller can
 * see null while a scan is outstanding. */
function refreshNow(): Promise<void> {
  if (inFlight) return inFlight;
  useMetricsStore.setState({ loading: true });
  const pending = fetchOnce().finally(() => {
    inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/** Refetch only when the scan's answer would change: in `"all"` scope a new cwd is recorded but
 * reads nothing. Also stops a per-render `setCwd` from sweeping the disk every render. */
function applyQuery(patch: Partial<MetricsQuery>): Promise<void> {
  const current = useMetricsStore.getState().query;
  const next: MetricsQuery = { ...current, ...patch };
  if (
    next.window === current.window &&
    next.scope === current.scope &&
    next.cwd === current.cwd
  ) {
    return Promise.resolve();
  }
  useMetricsStore.setState({ query: next });
  // `cwd` is an input to the scan only in `project` scope. Note the check is on the NEXT
  // scope: switching `all` → `project` and the cwd in one go must still refetch, which it
  // does via the scope comparison above.
  const answerChanged =
    next.window !== current.window ||
    next.scope !== current.scope ||
    (next.scope === "project" && next.cwd !== current.cwd);
  return answerChanged ? refreshNow() : Promise.resolve();
}

function setWindow(window: MetricsWindowKind): Promise<void> {
  return applyQuery({ window });
}

function setScope(scope: MetricsScopeKind): Promise<void> {
  return applyQuery({ scope });
}

function setCwd(cwd: string | null): Promise<void> {
  return applyQuery({ cwd });
}

/** Record the cwd (fetches only in `"project"` scope), then fetch if there are no numbers yet. A
 * scan started by the first step sets `loading` synchronously, so the second cannot pile on. */
export function ensureMetrics(cwd: string | null): void {
  if (useMetricsStore.getState().query.cwd !== cwd) void setCwd(cwd);
  const state = useMetricsStore.getState();
  if (state.report === null && !state.loading) void refreshNow();
}
