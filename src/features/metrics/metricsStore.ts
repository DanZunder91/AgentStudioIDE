/**
 * The METRICS store — one report of the local transcripts, fetched on demand.
 *
 * Its own `create(...)`, NOT the main app store: a self-contained feature that needs
 * state gets a feature-local store so it never contends for the central store file (an
 * async scan cache has nothing to do with the pane-tree reducers, and the layout store
 * must never grow one). Same shape as `usageStore` and `logStore`.
 *
 * ── The three requirements it shares with `usageStore`, and why ───────────────
 *
 * 1. **A failed refresh must never blank the panel.** {@link MetricsStoreState.report}
 *    holds the last SUCCESSFUL report and is never cleared by a failure; `error`
 *    carries the reason alongside it and the panel marks the numbers **stale**.
 *    Stale-but-true beats no numbers; inventing numbers is never an option.
 *
 * 2. **Single-flight.** A scan reads megabytes off disk. Two mounted consumers, a
 *    window/scope change landing on top of a Rescan click, or an impatient
 *    double-click must all collapse into ONE scan. {@link inFlight} is that gate: a
 *    `refresh()` arriving while a scan is outstanding **awaits the outstanding
 *    promise** rather than returning early, so a caller's `await refresh()` still
 *    means "the numbers on screen are now fresh" — what a refresh spinner needs.
 *
 *    Single-flight is also the ordering guarantee, and a strictly stronger one than a
 *    sequence number: `inFlight` is set synchronously before the first `await` and
 *    cleared only once the underlying promise has settled, so **at most one
 *    `claudeMetrics()` response exists at any instant**. A stale response landing
 *    after a newer one is not representable — there is no second response for it to be
 *    stale relative to. `metricsStore.test.ts` pins it directly (peak concurrency of
 *    the mocked IPC asserted `=== 1`).
 *
 * 3. **The query is state, and changing it refetches.** Window and scope live here
 *    rather than in the component, so the honesty header, the charts and the fetch can
 *    never disagree about which window produced the numbers on screen.
 *
 * ── 🔴 And the one requirement it deliberately does NOT share: no timer ──────
 *
 * `usageStore` polls every 5 s. That is right for a ~1 s CLI call whose answer is a
 * live account limit; it is **wrong for a filesystem sweep**. A 24 h scan reads
 * megabytes in ~100 ms and a 7 d scan far more; doing that every five seconds
 * would spend the user's disk and CPU on numbers that move by a rounding error, and
 * the genuinely live account figure is already covered by the usage strip. So the scan
 * runs on **tab open, on Rescan, and when the query changes** — nothing else. There is
 * no `setInterval` in this file, and its absence is asserted by a test.
 */

import { create } from "zustand";

import { claudeMetrics } from "./metricsIpc";
import { parseMetricsError } from "./metricsFormat";
import type {
  MetricsErrorCode,
  MetricsReport,
  MetricsScopeKind,
  MetricsWindowKind,
} from "./metricsTypes";

/**
 * What was asked for. Every fetch is a function of exactly this.
 *
 * Note `cwd` is part of the query even in `"all"` scope, where it does not affect the
 * result: the panel needs it to know whether narrowing to `"project"` is even *possible*
 * (a toggle that produces an error when clicked is worse than no toggle). Which is why
 * {@link applyQuery} distinguishes "the query changed" from "the ANSWER would change".
 */
export interface MetricsQuery {
  window: MetricsWindowKind;
  scope: MetricsScopeKind;
  /**
   * The project root. `null` is a legitimate and **common** state — nothing selected in
   * the agent rail — and in `"all"` scope it is simply irrelevant. It is never a reason
   * to fail: see the note on {@link INITIAL_QUERY}.
   */
  cwd: string | null;
}

export interface MetricsStoreState {
  /**
   * Last SUCCESSFUL report. Kept across a failed refresh so the panel shows
   * stale-but-true numbers instead of blanking. `null` until the first success.
   */
  report: MetricsReport | null;
  /** Code of the most recent failure; cleared on the next success. */
  error: MetricsErrorCode | null;
  /** True while a scan is in flight — drives the Rescan button's busy state. */
  loading: boolean;
  /** The query the current `report` was produced for (and the next fetch will use). */
  query: MetricsQuery;
  /**
   * Scan once, **now**. Never throws: failures land in {@link error}. Resolves when
   * the numbers on screen are fresh (it joins an outstanding scan rather than starting
   * a second one).
   */
  refresh: () => Promise<void>;
  /**
   * Change the window and refetch. A no-op (and no fetch) when the window is already
   * the one selected — clicking the active toggle must not cost a disk sweep.
   */
  setWindow: (window: MetricsWindowKind) => Promise<void>;
  /**
   * Change the scope and refetch. Same no-op rule. Narrowing to `"project"` with a `null`
   * cwd is not an error — Rust widens it back and says so — but the panel disables the
   * control in that state rather than relying on that.
   */
  setScope: (scope: MetricsScopeKind) => Promise<void>;
  /**
   * Point the store at a project. Called by the panel on mount with the tab's cwd, and
   * again if the tab is re-pointed. Refetches **only when the answer would change** —
   * i.e. in `"project"` scope. In `"all"` scope the cwd is recorded (the scope toggle
   * needs it) and no disk is touched.
   */
  setCwd: (cwd: string | null) => Promise<void>;
}

/**
 * The default query: **everything on this machine**, the last 24 h.
 *
 * 🔴 `scope: "all"` and not `"project"`, and this one line is the fix for the
 * no-selection bug. The dashboard opens with no agent selected far more often than not, so
 * `cwd` is `null` on the overwhelming majority of first opens — and an earlier version
 * paired that `null` with `scope: "project"`, which Rust rejected with `scan-failed`. The header read
 * "24 h · This project" and the body read "Could not read your sessions".
 *
 * It is also the dashboard's question: total usage on the machine, not one project's.
 */
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

/**
 * The outstanding scan, or `null` when idle. This is the single-flight gate AND the
 * ordering guarantee (requirement 2 in the module docblock).
 */
let inFlight: Promise<void> | null = null;

/**
 * Scan once and fold the outcome into the store. Resolves in both cases and **never
 * rejects** — the rejection is translated into an `error` code here, which is what lets
 * every call site fire-and-forget (`void refreshNow()`) without risking an unhandled
 * promise rejection.
 */
async function fetchOnce(): Promise<void> {
  const { window, scope, cwd } = useMetricsStore.getState().query;
  try {
    const report = await claudeMetrics(window, scope, cwd);
    useMetricsStore.setState({ report, error: null, loading: false });
  } catch (reason) {
    // `report` is deliberately absent from this patch: a failure must LEAVE the last
    // good report in place. The raw rejection goes to `parseMetricsError` verbatim —
    // classifying the `"<code>[: detail]"` string is that module's job, and the detail
    // is never rendered or logged (it could name a path).
    useMetricsStore.setState({ error: parseMetricsError(reason), loading: false });
  }
}

/**
 * Start a scan, or join the one already running.
 *
 * The synchronous window is airtight: `fetchOnce()` runs up to its first `await` (i.e.
 * it calls `claudeMetrics()`) and `inFlight` is assigned before this function returns,
 * so there is no interleaving point at which a second caller could observe
 * `inFlight === null` while a scan is actually outstanding.
 */
function refreshNow(): Promise<void> {
  if (inFlight) return inFlight;
  useMetricsStore.setState({ loading: true });
  const pending = fetchOnce().finally(() => {
    inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/**
 * Apply a query change and refetch, or do nothing if it changes nothing.
 *
 * The guard is not just an optimization: without it, a panel that calls `setCwd` on
 * every render (a mistake one dependency array away) would sweep the disk on every
 * render.
 *
 * ── Two distinct questions, and conflating them costs a disk sweep ────────────
 *
 * "Did the query change?" and "would the ANSWER change?" are not the same since `"all"`
 * became the default: in `"all"` scope the cwd is carried (the scope toggle needs to know
 * whether a project is available) but does not narrow anything, so re-pointing the tab at
 * another project must record the cwd and read **nothing** off disk. Only a change the
 * scan would actually notice refetches.
 */
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

/**
 * Ensure the panel has numbers, and that the store knows which project the tab is
 * pointing at — fetching only if it must.
 *
 * Called from the panel's mount effect. Two steps, in this order, because in `"all"` scope
 * the first one does not fetch:
 *
 * 1. **Record the cwd.** `setCwd` refetches only in `"project"` scope (see
 *    {@link applyQuery}). In `"all"` scope it just records — and it must still be called,
 *    or the scope toggle could not tell whether narrowing is possible.
 * 2. **Fetch if there are no numbers.** A first mount, or a mount after a failure. If
 *    step 1 already started a scan, `loading` is `true` **synchronously** by then, so this
 *    cannot pile on a second one; and re-opening the tab with a report already in hand
 *    does nothing at all — the Rescan button is right there.
 */
export function ensureMetrics(cwd: string | null): void {
  if (useMetricsStore.getState().query.cwd !== cwd) void setCwd(cwd);
  const state = useMetricsStore.getState();
  if (state.report === null && !state.loading) void refreshNow();
}
