/** Hermetic: `./usageIpc` and `./usageFormat` are mocked. `vi.resetModules()` per test because the
 * store keeps its timer, ref count and failure streak in module scope (no test-only reset hatch).
 * Every test that starts polling registers its stopper with `track()`: no stray timer survives. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageSnapshot } from "./usageTypes";

const { mockUsage, mockParse } = vi.hoisted(() => ({
  mockUsage: vi.fn<() => Promise<UsageSnapshot>>(),
  mockParse: vi.fn<(raw: unknown) => string>(),
}));

vi.mock("./usageIpc", () => ({ claudeUsage: mockUsage }));
vi.mock("./usageFormat", () => ({ parseUsageError: mockParse }));

type UsageModule = typeof import("./usageStore");

/** Fresh module instance ⇒ fresh ref count, timer and failure streak. */
async function loadStore(): Promise<UsageModule> {
  vi.resetModules();
  return import("./usageStore");
}

const stoppers: Array<() => void> = [];

/** Register a stopper so `afterEach` can guarantee no timer outlives its test. */
function track(stop: () => void): () => void {
  stoppers.push(stop);
  return stop;
}

/** A promise whose settlement this test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake timers do not advance microtasks: drain several turns so the store's await chain
 * (`claudeUsage` → `fetchOnce` → `setState` → `.finally` → re-arm) runs before asserting. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Advance the fake clock and let anything it triggered settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value,
    configurable: true,
  });
}

function fireVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

const snapA: UsageSnapshot = {
  windows: [
    { key: "five_hour", label: "Current session", usedPct: 42, resetsAtMs: 1_000 },
  ],
  fetchedAtMs: 100,
};

const snapB: UsageSnapshot = {
  windows: [{ key: "seven_day", label: "All models", usedPct: 7, resetsAtMs: null }],
  fetchedAtMs: 200,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockUsage.mockReset();
  mockParse.mockReset();
  mockParse.mockReturnValue("unknown");
  setVisibility("visible");
});

afterEach(() => {
  while (stoppers.length > 0) stoppers.pop()?.();
  vi.useRealTimers();
});

describe("the cadence constants", () => {
  it("polls every 5s on the happy path and escalates 5s → 15s → 30s → 60s", async () => {
    const { USAGE_POLL_MS, USAGE_BACKOFF_MS } = await loadStore();
    // The specified number. Pinned literally so a well-meaning "tune the poll"
    // has to be a deliberate edit to a failing test, not a silent drift.
    expect(USAGE_POLL_MS).toBe(5000);
    // Rung 0 IS the happy-path cadence — a success must never cost more than 5s.
    expect(USAGE_BACKOFF_MS).toEqual([5000, 15_000, 30_000, 60_000]);
  });
});

describe("refresh — the success path", () => {
  it("calls claudeUsage once and stores the snapshot with no error", async () => {
    const { useUsageStore } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    await useUsageStore.getState().refresh();

    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(useUsageStore.getState()).toMatchObject({
      snapshot: snapA,
      error: null,
      loading: false,
    });
  });

  it("holds `loading` true for exactly the duration of the flight", async () => {
    const { useUsageStore } = await loadStore();
    const d = deferred<UsageSnapshot>();
    mockUsage.mockReturnValue(d.promise);

    expect(useUsageStore.getState().loading).toBe(false);
    const pending = useUsageStore.getState().refresh();
    // Synchronously true: the spinner must appear on the click, not a tick later.
    expect(useUsageStore.getState().loading).toBe(true);

    d.resolve(snapA);
    await pending;
    expect(useUsageStore.getState().loading).toBe(false);
  });

  it("clears a previous error on the next success", async () => {
    const { useUsageStore } = await loadStore();
    mockParse.mockReturnValue("network");
    mockUsage.mockRejectedValueOnce("network: offline");
    await useUsageStore.getState().refresh();
    expect(useUsageStore.getState().error).toBe("network");

    mockUsage.mockResolvedValueOnce(snapA);
    await useUsageStore.getState().refresh();
    expect(useUsageStore.getState().error).toBeNull();
  });
});

describe("refresh — the failure path", () => {
  it("keeps the last good snapshot and records the parsed code", async () => {
    const { useUsageStore } = await loadStore();
    mockUsage.mockResolvedValueOnce(snapA);
    await useUsageStore.getState().refresh();

    mockParse.mockReturnValue("unauthorized");
    mockUsage.mockRejectedValueOnce("unauthorized: token expired");
    await useUsageStore.getState().refresh();

    // A failed refresh keeps stale-but-true numbers, never a blank panel.
    expect(useUsageStore.getState().snapshot).toBe(snapA);
    expect(useUsageStore.getState().error).toBe("unauthorized");
    expect(useUsageStore.getState().loading).toBe(false);
  });

  it("hands the RAW rejection reason to parseUsageError", async () => {
    const { useUsageStore } = await loadStore();
    const reason = new Error("http: 429 rate_limit_error");
    mockUsage.mockRejectedValueOnce(reason);

    await useUsageStore.getState().refresh();

    // Not a stringified/normalized copy — classifying is usageFormat's job, and it
    // can only do it if the store passes the reason through untouched.
    expect(mockParse).toHaveBeenCalledWith(reason);
  });

  it("leaves snapshot null when the very first fetch fails", async () => {
    const { useUsageStore } = await loadStore();
    mockParse.mockReturnValue("no-credentials");
    mockUsage.mockRejectedValueOnce("no-credentials");

    await useUsageStore.getState().refresh();

    expect(useUsageStore.getState().snapshot).toBeNull();
    expect(useUsageStore.getState().error).toBe("no-credentials");
  });

  it("resolves instead of rejecting, so no rejection can escape", async () => {
    const { useUsageStore } = await loadStore();
    mockUsage.mockRejectedValueOnce("boom");
    // If `refresh()` rejected, every fire-and-forget `void refreshNow()` in the
    // polling path would become an unhandled rejection (and fail the run's exit code).
    await expect(useUsageStore.getState().refresh()).resolves.toBeUndefined();
  });
});

describe("single-flight", () => {
  it("two back-to-back refreshes issue exactly ONE claudeUsage call", async () => {
    const { useUsageStore } = await loadStore();
    const d = deferred<UsageSnapshot>();
    mockUsage.mockReturnValue(d.promise);

    const first = useUsageStore.getState().refresh();
    const second = useUsageStore.getState().refresh();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    d.resolve(snapA);
    // The joiner AWAITS the outstanding fetch (rather than returning early), so an
    // `await refresh()` still means "the numbers on screen are now fresh".
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(useUsageStore.getState().snapshot).toBe(snapA);
  });

  it("re-opens the gate once the flight settles", async () => {
    const { useUsageStore } = await loadStore();
    mockUsage.mockResolvedValue(snapA);
    await useUsageStore.getState().refresh();
    await useUsageStore.getState().refresh();
    // Dedupe must not be a one-shot latch that wedges the store forever.
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("never lets two responses coexist, so a stale one cannot overwrite a newer", async () => {
    const { useUsageStore, startUsagePolling } = await loadStore();
    let live = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    mockUsage.mockImplementation(() => {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise<UsageSnapshot>((resolve) => {
        pending.push(() => {
          live -= 1;
          resolve(snapA);
        });
      });
    });

    track(startUsagePolling());
    // Hammer it: manual refreshes and poll ticks interleaved while a fetch hangs.
    void useUsageStore.getState().refresh();
    await advance(30_000);
    void useUsageStore.getState().refresh();
    await advance(30_000);

    // Peak concurrency 1 IS the ordering guarantee (see the store's docblock): with
    // at most one response in existence there is nothing for a late one to be stale
    // relative to, which is why no sequence-number guard is needed.
    expect(peak).toBe(1);
    expect(mockUsage).toHaveBeenCalledTimes(1);

    pending.forEach((done) => done());
    await flush();
    expect(useUsageStore.getState().snapshot).toBe(snapA);
  });

  it("stores the NEWEST reading when successive fetches return different data", async () => {
    const { useUsageStore } = await loadStore();
    mockUsage.mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapB);
    await useUsageStore.getState().refresh();
    await useUsageStore.getState().refresh();
    expect(useUsageStore.getState().snapshot).toBe(snapB);
  });
});

describe("startUsagePolling — cadence", () => {
  it("fetches IMMEDIATELY on the first start", async () => {
    const { startUsagePolling } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    track(startUsagePolling());
    // Not a tick later, not 5s later: the panel must not open empty.
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });

  it("fetches again at exactly USAGE_POLL_MS, and not before", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    track(startUsagePolling());
    await flush();

    await advance(USAGE_POLL_MS - 1);
    expect(mockUsage).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockUsage).toHaveBeenCalledTimes(2);
    await advance(USAGE_POLL_MS);
    expect(mockUsage).toHaveBeenCalledTimes(3);
  });

  it("stops fetching after the stopper runs", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    const stop = track(startUsagePolling());
    await flush();
    stop();

    await advance(USAGE_POLL_MS * 3);
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });

  it("arms the next attempt from when the fetch FINISHED, not when it started", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    const d = deferred<UsageSnapshot>();
    mockUsage.mockReturnValueOnce(d.promise).mockResolvedValue(snapB);

    track(startUsagePolling());
    // A slow response must not let ticks pile up behind it.
    await advance(USAGE_POLL_MS * 4);
    expect(mockUsage).toHaveBeenCalledTimes(1);

    d.resolve(snapA);
    await flush();
    await advance(USAGE_POLL_MS - 1);
    expect(mockUsage).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });
});

describe("startUsagePolling — failure backoff", () => {
  it("waits 15s (not 5s) after one failure", async () => {
    const { startUsagePolling } = await loadStore();
    mockParse.mockReturnValue("http");
    mockUsage.mockRejectedValue("http: 429");

    track(startUsagePolling());
    await flush();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    // The measured hazard: a blind 5s poll into a 429 keeps hammering the very
    // endpoint that asked us to stop.
    await advance(5000);
    expect(mockUsage).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("escalates 15s → 30s → 60s and HOLDS at 60s", async () => {
    const { startUsagePolling } = await loadStore();
    mockParse.mockReturnValue("http");
    mockUsage.mockRejectedValue("http: 429");

    track(startUsagePolling());
    await flush();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    for (const [delay, expected] of [
      [15_000, 2],
      [30_000, 3],
      [60_000, 4],
      [60_000, 5],
      [60_000, 6],
    ] as const) {
      // One millisecond short of the rung must still be silent — otherwise the
      // "escalation" could be nothing but a shorter delay that happens to pass.
      await advance(delay - 1);
      expect(mockUsage).toHaveBeenCalledTimes(expected - 1);
      await advance(1);
      expect(mockUsage).toHaveBeenCalledTimes(expected);
    }
  });

  it("snaps back to the 5s cadence on the next success", async () => {
    const { startUsagePolling, useUsageStore } = await loadStore();
    mockParse.mockReturnValue("http");
    mockUsage.mockRejectedValueOnce("http: 429").mockResolvedValue(snapA);

    track(startUsagePolling());
    await flush();

    // The backed-off retry succeeds…
    await advance(15_000);
    expect(mockUsage).toHaveBeenCalledTimes(2);
    expect(useUsageStore.getState().snapshot).toBe(snapA);

    // …so the streak is cleared and the very next attempt is 5s away again.
    await advance(4999);
    expect(mockUsage).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockUsage).toHaveBeenCalledTimes(3);
  });

  it("a manual refresh fires immediately mid-backoff — exactly once", async () => {
    const { startUsagePolling, useUsageStore } = await loadStore();
    mockParse.mockReturnValue("http");
    mockUsage.mockRejectedValue("http: 429");

    track(startUsagePolling());
    await flush();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    // Deep into a 15s backoff window, the button must still work — the user asked.
    await advance(2000);
    await useUsageStore.getState().refresh();
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("a manual refresh that succeeds mid-backoff restores the 5s cadence", async () => {
    const { startUsagePolling, useUsageStore, USAGE_POLL_MS } = await loadStore();
    mockParse.mockReturnValue("http");
    mockUsage.mockRejectedValueOnce("http: 429").mockResolvedValue(snapA);

    track(startUsagePolling());
    await flush();

    await advance(2000);
    await useUsageStore.getState().refresh(); // succeeds ⇒ streak cleared
    await flush();
    expect(mockUsage).toHaveBeenCalledTimes(2);
    expect(useUsageStore.getState().error).toBeNull();

    // Re-armed at 5s from that success — not still waiting out the old 15s window.
    await advance(USAGE_POLL_MS - 1); // t = 6999
    expect(mockUsage).toHaveBeenCalledTimes(2);
    await advance(1); // t = 7000
    expect(mockUsage).toHaveBeenCalledTimes(3);

    // The superseded 15s timer must be CANCELLED, not merely outrun: re-arming without cancelling
    // leaks a timer per manual refresh, visible only as surplus round trips.
    await advance(USAGE_POLL_MS); // t = 12000
    expect(mockUsage).toHaveBeenCalledTimes(4);
    await advance(3000); // t = 15000 — the abandoned deadline
    expect(mockUsage).toHaveBeenCalledTimes(4);
  });

  it("a manual refresh while polling is stopped does not resurrect the timer", async () => {
    const { startUsagePolling, useUsageStore, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    const stop = track(startUsagePolling());
    await flush();
    stop();

    await useUsageStore.getState().refresh();
    expect(mockUsage).toHaveBeenCalledTimes(2);
    await advance(USAGE_POLL_MS * 3);
    // Still 2: the manual fetch's re-arm hook must respect "nobody is polling".
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });
});

describe("startUsagePolling — reference counting", () => {
  it("two starts share ONE timer and one immediate fetch", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    track(startUsagePolling());
    track(startUsagePolling());
    await flush();
    // The second consumer joins the existing poller; it does not add a round trip.
    expect(mockUsage).toHaveBeenCalledTimes(1);

    await advance(USAGE_POLL_MS);
    // One timer, therefore one call per cadence — not two.
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after the FIRST of two stoppers, and stops on the second", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    const stopA = track(startUsagePolling());
    const stopB = track(startUsagePolling());
    await flush();

    stopA();
    await advance(USAGE_POLL_MS);
    expect(mockUsage).toHaveBeenCalledTimes(2); // consumer B still wants data

    stopB();
    await advance(USAGE_POLL_MS * 3);
    expect(mockUsage).toHaveBeenCalledTimes(2); // last one out killed the timer
  });

  it("a double-stop is harmless and does not decrement the count twice", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    const stopA = track(startUsagePolling());
    const stopB = track(startUsagePolling());
    await flush();

    stopA();
    stopA(); // React StrictMode double-invokes cleanups — must not unsubscribe B
    await advance(USAGE_POLL_MS);
    expect(mockUsage).toHaveBeenCalledTimes(2);

    stopB();
    stopB();
    await advance(USAGE_POLL_MS * 3);
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });
});

describe("startUsagePolling — document visibility", () => {
  it("does not fetch at all while the document starts hidden", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);
    setVisibility("hidden");

    track(startUsagePolling());
    await flush();
    expect(mockUsage).not.toHaveBeenCalled();

    await advance(USAGE_POLL_MS * 3);
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it("pauses when the document becomes hidden", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    track(startUsagePolling());
    await flush();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    fireVisibilityChange();
    await advance(USAGE_POLL_MS * 4);
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });

  it("fetches IMMEDIATELY on becoming visible again, then resumes the cadence", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);
    setVisibility("hidden");

    track(startUsagePolling());
    await flush();

    setVisibility("visible");
    fireVisibilityChange();
    // The returning user must not be greeted by a 5s-stale (here: empty) panel.
    expect(mockUsage).toHaveBeenCalledTimes(1);

    await flush();
    await advance(USAGE_POLL_MS);
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("a redundant visibilitychange while already visible adds no timer and no fetch", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);

    track(startUsagePolling());
    await flush();

    fireVisibilityChange(); // still "visible"
    fireVisibilityChange();
    expect(mockUsage).toHaveBeenCalledTimes(1);

    // Two timers would show up here as two calls per cadence.
    await advance(USAGE_POLL_MS);
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it("a hidden→hidden visibilitychange while already paused is a no-op", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);
    setVisibility("hidden");

    track(startUsagePolling());
    fireVisibilityChange();
    fireVisibilityChange();
    await advance(USAGE_POLL_MS * 2);
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it("removes the visibilitychange listener on the FINAL stop", async () => {
    const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
    mockUsage.mockResolvedValue(snapA);
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const stopA = track(startUsagePolling());
    const stopB = track(startUsagePolling());
    await flush();

    stopA();
    expect(removeSpy).not.toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );

    stopB();
    expect(removeSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    removeSpy.mockRestore();

    // And it is really gone — a later event cannot revive a stopped poller
    // (a subscription that outlives its owner is the leak).
    setVisibility("hidden");
    fireVisibilityChange();
    setVisibility("visible");
    fireVisibilityChange();
    await advance(USAGE_POLL_MS * 2);
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });

  it("survives a non-DOM environment: polls, and stops without throwing", async () => {
    vi.stubGlobal("document", undefined);
    try {
      const { startUsagePolling, USAGE_POLL_MS } = await loadStore();
      mockUsage.mockResolvedValue(snapA);

      // No document ⇒ nothing can tell us we are hidden, so poll (refusing to
      // would be the worse failure) and bind no listener.
      const stop = startUsagePolling();
      await flush();
      expect(mockUsage).toHaveBeenCalledTimes(1);

      await advance(USAGE_POLL_MS);
      expect(mockUsage).toHaveBeenCalledTimes(2);

      expect(() => stop()).not.toThrow();
      await advance(USAGE_POLL_MS * 2);
      expect(mockUsage).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
