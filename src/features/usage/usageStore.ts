/** Feature-local polled usage store. A failure never blanks the last snapshot; fetches are
 * single-flight (at most one response exists, so none is stale). Each poll spawns a `claude`
 * process, so polling pauses while hidden and backs off on failure. Plumbing is module-scoped. */

import { create } from "zustand";

import { claudeUsage } from "./usageIpc";
import { parseUsageError } from "./usageFormat";
import type { UsageErrorCode, UsageSnapshot } from "./usageTypes";

/** Happy-path auto-refresh cadence, ms; tests advance the clock by exactly this. */
export const USAGE_POLL_MS = 5000;

/** Delay before the next AUTOMATIC attempt by consecutive failures: 5s, 15s, 30s, 60s, held at
 * 60s. A manual `refresh()` ignores it. */
export const USAGE_BACKOFF_MS: readonly number[] = [
  USAGE_POLL_MS,
  15_000,
  30_000,
  60_000,
];

export interface UsageStoreState {
  /** Last SUCCESSFUL reading, kept across failures (stale-but-true beats blank); `null` at
   * first. */
  snapshot: UsageSnapshot | null;
  /** Code of the most recent failure; cleared on the next success. */
  error: UsageErrorCode | null;
  /** True while a fetch is in flight — drives the refresh button's spinner. */
  loading: boolean;
  /** Fetch NOW, ignoring backoff (only the automatic cadence is throttled). Never throws: failures
   * land in {@link error}. Resolves once the numbers are fresh (joins an outstanding fetch). */
  refresh: () => Promise<void>;
}

export const useUsageStore = create<UsageStoreState>()(() => ({
  snapshot: null,
  error: null,
  loading: false,
  // A stable function identity (a hoisted declaration, not a closure minted per
  // store creation), so a consumer can safely put it in a `useEffect` dep array.
  refresh: refreshNow,
}));

/* ── the single-flight fetch ──────────────────────────────────────────────── */

/** The outstanding fetch, or `null`: the single-flight gate AND the ordering guarantee. */
let inFlight: Promise<void> | null = null;

/** Fetch once and fold the outcome into the store. Never rejects (errors become a code), so call
 * sites can fire-and-forget. */
async function fetchOnce(): Promise<void> {
  try {
    const snapshot = await claudeUsage();
    failures = 0;
    useUsageStore.setState({ snapshot, error: null, loading: false });
  } catch (reason) {
    // Capped at the last rung so the counter stays a bounded, meaningful index
    // rather than an ever-climbing number clamped at read time.
    failures = Math.min(failures + 1, USAGE_BACKOFF_MS.length - 1);
    // `snapshot` is absent on purpose: a failure LEAVES the last good reading. The raw rejection
    // goes to `parseUsageError` verbatim; its detail is never rendered or logged (CLI output).
    useUsageStore.setState({ error: parseUsageError(reason), loading: false });
  }
}

/** Start a fetch or join the running one. `inFlight` is assigned synchronously, before this
 * returns, so no caller can see `null` while a request is outstanding. */
function refreshNow(): Promise<void> {
  if (inFlight) return inFlight;
  useUsageStore.setState({ loading: true });
  const pending = fetchOnce().finally(() => {
    inFlight = null;
    // Re-arm relative to the fetch that just FINISHED: one rescheduling point for manual and
    // automatic fetches, so a click never leaves a stale timer and slow responses never pile up.
    rearmAutoTimer();
  });
  inFlight = pending;
  return pending;
}

/* ── polling lifecycle: reference-counted, visibility-aware ───────────────── */

/** `document`, or `null` for non-DOM consumers (node tests); no document reads as always visible
 * (refusing to poll would be worse). */
function usageDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

/** True only when a document exists AND reports itself hidden. */
function isHidden(): boolean {
  return usageDocument()?.visibilityState === "hidden";
}

/** How many live `startUsagePolling()` callers there are. Zero ⇒ nothing runs. */
let consumers = 0;

/** True from the first start to the last stop, except while hidden. Not `timer !== null`: between
 * a fetch starting and the next timer arming we poll with no handle. */
let ticking = false;

/** Next automatic attempt; `null` while idle, paused, or while the fetch that will arm it runs. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** Consecutive failed fetches (index into {@link USAGE_BACKOFF_MS}), manual or automatic alike:
 * under single-flight one request can be both, so failing manual refreshes escalate backoff too. */
let failures = 0;

/** Delay before the next automatic attempt, given the current failure streak. */
function nextDelayMs(): number {
  return USAGE_BACKOFF_MS[failures];
}

/** Undo for the `visibilitychange` subscription, closed over the bound document and handler;
 * `null` without a DOM, so teardown is one `?.()`. */
let unbindVisibility: (() => void) | null = null;

/** Cancel any armed attempt. Safe to call when none is armed. */
function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** Arm the next automatic attempt unless stopped or paused (then the settled fetch was manual, or
 * the last before a pause, and arming would resurrect polling). */
function rearmAutoTimer(): void {
  if (!ticking) return;
  clearTimer();
  timer = setTimeout(() => void refreshNow(), nextDelayMs());
}

/** Idempotent (browsers fire redundant `visibilitychange`). The first attempt is IMMEDIATE;
 * `refreshNow`'s `finally` arms the next, so a slow response delays the cadence, never races. */
function startTicking(): void {
  if (ticking) return;
  ticking = true;
  void refreshNow();
}

/** Stop ticking. Idempotent, so pausing an already-paused poller is a no-op. */
function stopTicking(): void {
  if (!ticking) return;
  ticking = false;
  clearTimer();
}

/** First consumer: subscribe to visibility, and start ticking unless hidden. */
function attachPolling(): void {
  const doc = usageDocument();
  if (doc) {
    const handler = (): void => {
      if (isHidden()) stopTicking();
      else startTicking();
    };
    doc.addEventListener("visibilitychange", handler);
    unbindVisibility = () => doc.removeEventListener("visibilitychange", handler);
  }
  if (!isHidden()) startTicking();
}

/** Last consumer left: stop the clock and remove the listener — no leaks. */
function detachPolling(): void {
  stopTicking();
  unbindVisibility?.();
  unbindVisibility = null;
}

/** Start polling; returns an idempotent stopper (StrictMode double-invokes cleanups). Ref-counted:
 * N starts share one timer and request. Only the first start fetches at once; a restart mid-backoff
 * fetches immediately but keeps the failure streak. */
export function startUsagePolling(): () => void {
  consumers += 1;
  if (consumers === 1) attachPolling();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    consumers -= 1;
    if (consumers === 0) detachPolling();
  };
}
