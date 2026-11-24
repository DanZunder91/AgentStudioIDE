/**
 * The USAGE-LIMITS store — one live reading of the account's limits, polled.
 *
 * Deliberately its OWN `create(...)`, NOT the main app store (`src/app/store.ts`),
 * for the same reason as the diagnostics log (`features/logs/logStore.ts`): a
 * self-contained feature that needs state gets a feature-local store so it never
 * contends for the central store file (a remote poll has nothing to do with the
 * pane-tree reducers, and the layout store must never grow an async cache).
 *
 * ── The three hard requirements, and why ─────────────────────────────────────
 *
 * 1. **A failed refresh must never blank the panel.** `snapshot` holds the last
 *    SUCCESSFUL reading and is never cleared by a failure; `error` carries the
 *    reason alongside it. Numbers that are stale-but-true beat no numbers, and
 *    inventing numbers is never an option (see `usageTypes.ts`).
 *
 * 2. **Single-flight.** `claudeUsage()` is a real network round trip. Two mounted
 *    consumers, a poll tick landing on top of a button click, or an impatient
 *    double-click must all collapse into ONE request. `inFlight` is that gate: a
 *    `refresh()` arriving while a fetch is outstanding does not start a second one,
 *    it **awaits the outstanding promise** (rather than returning early) so the
 *    caller's `await refresh()` still means "the numbers on screen are now fresh" —
 *    which is exactly what a refresh button's spinner needs.
 *
 *    Single-flight is also the ordering guarantee, and a strictly stronger one than
 *    a request sequence number would give: because `inFlight` is set synchronously
 *    before the first `await` and only cleared once the underlying promise has
 *    settled, **at most one `claudeUsage()` response exists at any instant**. A
 *    stale response landing after a newer one is therefore not representable — there
 *    is no second response to be stale *relative to*. A `seq`-number guard would be
 *    unreachable code pretending to defend against it. `usageStore.test.ts` pins the
 *    invariant directly (peak concurrency of the mocked IPC is asserted to be 1).
 *
 * 3. **Never poll a window nobody is looking at.** Each refresh spawns a `claude`
 *    process (~1s), so doing that every five seconds for a hidden/backgrounded
 *    window is pure waste of the user's CPU. The timer is torn down on `visibilitychange` → hidden and
 *    rebuilt — with an immediate fetch, because a five-second-stale panel greeting
 *    the returning user is the thing we are trying to avoid — on becoming visible.
 *    An explicit `refresh()` still works while hidden: that is user intent, not
 *    background chatter.
 *
 * 4. **Back off on failure.** `GET /api/oauth/usage` is IP-rate-limited — probing it
 *    unauthenticated returns HTTP 429 `rate_limit_error` (measured). A
 *    fixed 5s poll that keeps firing into a failure is how a transient error becomes
 *    a self-inflicted, sustained one: we would be hammering the very endpoint that
 *    just asked us to stop. So the *automatic* cadence escalates on consecutive
 *    failures per {@link USAGE_BACKOFF_MS} and snaps back to 5s on the next success.
 *    Deliberately NOT keyed on the 429 specifically: Rust collapses every non-2xx
 *    into the `http` code (`usageTypes.ts`), and "the server is unhappy" deserves the
 *    same restraint whatever its shape — offline, 500, or rate-limited.
 *
 * The polling lifecycle lives in module scope, not in the store, because it is
 * *plumbing*: reference counting, a timer handle and a failure streak are not state
 * the UI renders, and keeping them out means no reducer ever performs a side effect.
 */

import { create } from "zustand";

import { claudeUsage } from "./usageIpc";
import { parseUsageError } from "./usageFormat";
import type { UsageErrorCode, UsageSnapshot } from "./usageTypes";

/**
 * Auto-refresh cadence on the HAPPY PATH, ms — the specified 5 seconds, honoured
 * exactly for as long as fetches keep succeeding. One constant so the cadence is a
 * one-token change, and so tests advance the clock by exactly this much instead of
 * hard-coding a number that would silently stop matching.
 */
export const USAGE_POLL_MS = 5000;

/**
 * Delay before the next AUTOMATIC attempt, indexed by the number of consecutive
 * failures: 0 failures → 5s (i.e. {@link USAGE_POLL_MS}), then 15s, 30s, 60s, and
 * held at 60s while failures continue.
 *
 * Exported so it is inspectable and assertable rather than buried in an arithmetic
 * expression — a backoff curve you cannot read off the source is a backoff curve
 * nobody notices has drifted.
 *
 * A manual `refresh()` ignores this entirely (see {@link UsageStoreState.refresh}).
 */
export const USAGE_BACKOFF_MS: readonly number[] = [
  USAGE_POLL_MS,
  15_000,
  30_000,
  60_000,
];

export interface UsageStoreState {
  /**
   * Last SUCCESSFUL reading. Kept across a failed refresh so the panel shows
   * stale-but-true numbers instead of blanking. `null` until the first success.
   */
  snapshot: UsageSnapshot | null;
  /** Code of the most recent failure; cleared on the next success. */
  error: UsageErrorCode | null;
  /** True while a fetch is in flight — drives the refresh button's spinner. */
  loading: boolean;
  /**
   * Fetch once, **now** — immediately, regardless of any backoff window in effect.
   * The user asked for it, so they get it; only the automatic cadence is throttled.
   * Never throws: failures land in {@link error}. Resolves when the numbers on
   * screen are fresh (it joins an outstanding fetch rather than starting a second).
   */
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

/**
 * The outstanding fetch, or `null` when idle. This is the single-flight gate AND
 * the ordering guarantee (see requirement 2 in the module docblock).
 */
let inFlight: Promise<void> | null = null;

/**
 * Fetch once and fold the outcome into the store. Resolves in both cases and
 * **never rejects** — the rejection is translated into an `error` code here, which
 * is what lets every call site fire-and-forget (`void refreshNow()`) without
 * risking an unhandled promise rejection.
 */
async function fetchOnce(): Promise<void> {
  try {
    const snapshot = await claudeUsage();
    failures = 0;
    useUsageStore.setState({ snapshot, error: null, loading: false });
  } catch (reason) {
    // Capped at the last rung so the counter stays a bounded, meaningful index
    // rather than an ever-climbing number clamped at read time.
    failures = Math.min(failures + 1, USAGE_BACKOFF_MS.length - 1);
    // `snapshot` is deliberately absent from this patch: a failure must LEAVE the
    // last good reading in place. The raw rejection is handed to `parseUsageError`
    // verbatim — classifying the `"<code>[: detail]"` string is that module's job,
    // and the detail is never rendered or logged (it could carry CLI output).
    useUsageStore.setState({ error: parseUsageError(reason), loading: false });
  }
}

/**
 * Start a fetch, or join the one already running.
 *
 * Note the synchronous window is airtight: `fetchOnce()` runs up to its first
 * `await` (i.e. it calls `claudeUsage()`) and `inFlight` is assigned before this
 * function returns, so there is no interleaving point at which a second caller
 * could observe `inFlight === null` while a request is actually outstanding.
 */
function refreshNow(): Promise<void> {
  if (inFlight) return inFlight;
  useUsageStore.setState({ loading: true });
  const pending = fetchOnce().finally(() => {
    inFlight = null;
    // Re-arm the automatic timer relative to the fetch that just FINISHED, not to
    // the one that started it. One rescheduling point for every fetch — manual or
    // automatic — is what keeps the two from drifting apart: a button click can
    // never leave a stale short timer armed, and a slow response can never cause
    // two attempts to pile up back-to-back.
    rearmAutoTimer();
  });
  inFlight = pending;
  return pending;
}

/* ── polling lifecycle: reference-counted, visibility-aware ───────────────── */

/**
 * `document` when there is one, else `null`. The store is imported by non-DOM
 * consumers (a node test runner, a future headless harness) and a bare
 * `document.addEventListener` would throw there — so the DOM is treated as
 * optional plumbing, and "no document" is read as "always visible" (nothing can
 * tell us otherwise, and refusing to poll would be worse than polling).
 */
function usageDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

/** True only when a document exists AND reports itself hidden. */
function isHidden(): boolean {
  return usageDocument()?.visibilityState === "hidden";
}

/** How many live `startUsagePolling()` callers there are. Zero ⇒ nothing runs. */
let consumers = 0;

/**
 * True between the first `startUsagePolling()` and the last stop, EXCEPT while
 * paused for a hidden document. Tracked separately from {@link timer} because the
 * gap between "the immediate fetch started" and "the next timer is armed" is a real
 * window in which we are polling but hold no handle — deciding "are we polling?" by
 * `timer !== null` would misread that window as stopped.
 */
let ticking = false;

/**
 * Handle for the next automatic attempt; `null` while idle, paused, or while the
 * fetch that will arm the next one is still in flight.
 */
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Consecutive failed fetches, an index into {@link USAGE_BACKOFF_MS}.
 *
 * Deliberately origin-AGNOSTIC: it counts failed fetches, not failed *automatic*
 * fetches. Under single-flight a manual `refresh()` and a poll tick can be the very
 * same request, so "was this attempt the user's or the timer's?" has no coherent
 * answer to key off. Consequence, and it is the right one: repeatedly hitting a
 * failing refresh button escalates the automatic backoff too — the endpoint sees the
 * same load either way, and it is the load the endpoint is complaining about.
 */
let failures = 0;

/** Delay before the next automatic attempt, given the current failure streak. */
function nextDelayMs(): number {
  return USAGE_BACKOFF_MS[failures];
}

/**
 * Undoes the `visibilitychange` subscription — captured as a closure over the very
 * document and handler that were bound, so the final stop detaches exactly what it
 * attached, and stays `null` in a non-DOM environment. Storing the *undo* rather
 * than the handler keeps the teardown a single unconditional `?.()` instead of a
 * two-part `doc && handler` check whose combinations can never all occur.
 */
let unbindVisibility: (() => void) | null = null;

/** Cancel any armed attempt. Safe to call when none is armed. */
function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/**
 * Arm the next automatic attempt, unless we are stopped or paused — in which case
 * the fetch that just settled was a manual `refresh()` (or the last one before a
 * pause), and arming a timer for it would resurrect polling nobody asked for.
 */
function rearmAutoTimer(): void {
  if (!ticking) return;
  clearTimer();
  timer = setTimeout(() => void refreshNow(), nextDelayMs());
}

/**
 * Begin ticking. Idempotent: a redundant `visibilitychange` (browsers do fire them)
 * cannot double-tick, which would mean two timers and two requests per cadence.
 *
 * The first attempt is IMMEDIATE — the panel must not sit empty for 5s on open, nor
 * 5s stale when the window returns to the foreground. `refreshNow`'s `finally` arms
 * the follow-up, so a slow first response delays the cadence rather than racing it.
 */
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

/**
 * Start auto-refreshing; returns a stop function.
 *
 * **Reference-counted**: N concurrent starts share ONE timer and one in-flight
 * request, and the timer is torn down only when the LAST stopper runs. Two consumers
 * of the same reading (say the rail panel and a titlebar badge) must not mean two
 * round trips per tick.
 *
 * The returned stopper is **idempotent** — calling it twice must not decrement the
 * count twice, or a surviving consumer would be silently unsubscribed by someone
 * else's double cleanup. (React 18 StrictMode double-invokes effect cleanups in
 * development, so this is a real case, not a theoretical one.)
 *
 * Only the FIRST start fetches immediately; a later one joins a poller that already
 * has (or is already fetching) a reading. A restart does get its own immediate
 * attempt even mid-backoff, but the follow-up delay keeps the failure streak — the
 * endpoint's mood does not reset just because a panel was reopened.
 */
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
