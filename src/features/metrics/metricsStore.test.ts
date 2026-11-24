/**
 * `metricsStore` — the on-demand metrics store.
 *
 * Covers: the success/failure state shapes (including "a failure never blanks the last
 * good report"), the `loading` flag through both outcomes, single-flight dedupe
 * *asserted on IPC call counts*, the ordering guarantee (**peak mocked-IPC concurrency
 * asserted === 1**), query changes refetching, a redundant query change NOT refetching,
 * `ensureMetrics`'s cases, and — deliberately — that this store installs **no timer**,
 * because a filesystem sweep is not a 5 s cadence.
 *
 * 🔴 **The default query is the headline assertion in this file.** `("last_24h", "all",
 * null)`. An earlier default was `("last_24h", "project", null)`, which `claude_metrics`
 * rejected with `scan-failed` — so the packaged dashboard showed "Could not read your
 * sessions" whenever no agent was selected. That triple is pinned here, and the panel-level
 * consequence is pinned in `metricsNoSelectionSeam.test.tsx`.
 *
 * The other new rule with teeth: in `"all"` scope the cwd is **carried but not an input**,
 * so changing it records and does not fetch. Both halves are asserted, because either alone
 * is a bug — no record and the scope toggle cannot enable, no fetch and a project switch
 * would sweep megabytes off disk to recompute the identical answer.
 *
 * ── How this suite stays hermetic and non-flaky ──────────────────────────────
 *
 * `vi.mock("./metricsIpc")` — no Tauri IPC is ever touched.
 * `claudeMetrics` is a `vi.fn()` handed deferreds, so *when* a response lands is the
 * test's decision, never a timing accident.
 *
 * `vi.mock("./metricsFormat")` — `parseMetricsError` is a spy, not the real classifier.
 * That module has its own exhaustive suite; stubbing it keeps this file testing the
 * STORE's contract ("hand the raw rejection to the parser and store what comes back")
 * instead of re-testing theirs, and lets us assert the raw reason arrived unmangled.
 *
 * `vi.resetModules()` before every test, with the module imported *inside* each test:
 * `metricsStore` keeps its single-flight gate in module scope (plumbing, not rendered
 * state) and it is not reachable via `setState`, so a shared module instance would leak
 * an in-flight promise into the next test. `vi.hoisted` keeps the mocks stable across
 * those resets. Mirrors `usageStore.test.ts` exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetricsReport } from "./metricsTypes";

const { mockMetrics, mockParse } = vi.hoisted(() => ({
  mockMetrics: vi.fn<() => Promise<MetricsReport>>(),
  mockParse: vi.fn<(raw: unknown) => string>(),
}));

vi.mock("./metricsIpc", () => ({ claudeMetrics: mockMetrics }));
vi.mock("./metricsFormat", () => ({ parseMetricsError: mockParse }));

type MetricsModule = typeof import("./metricsStore");

/** Fresh module instance ⇒ a fresh single-flight gate. */
async function loadStore(): Promise<MetricsModule> {
  vi.resetModules();
  return import("./metricsStore");
}

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

/** Drain the microtask queue so the store's await/finally chain can settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function report(patch: Partial<MetricsReport> = {}): MetricsReport {
  return {
    window: { kind: "last_24h", fromMs: 0, toMs: 86_400_000 },
    scope: { kind: "all", cwd: null },
    totals: {
      sessions: 1,
      turns: 2,
      humanTurns: 2,
      requests: 3,
      tokens: { freshInput: 16, output: 390, cacheWrite: 200, cacheRead: 12_000 },
      avgContextPerRequest: 4072,
      highContextRequestShare: 0,
      toolCalls: 2,
      toolErrors: 1,
      filesChanged: 1,
      timeInTurnsMs: 20_500,
      turnsWithDuration: 1,
    },
    perRoot: [],
    hourly: [],
    topTurns: [],
    coverage: {
      rootsScanned: 1,
      rootsUnavailable: [],
      filesConsidered: 1,
      filesRead: 1,
      bytesRead: 1024,
      scanMs: 2,
      filesTruncated: 0,
      linesUnparseable: 0,
      turnsWithoutCliDuration: 0,
      turnsWithoutPromptId: 0,
      scopeFellBackToAll: false,
      partial: false,
    },
    scannedAtMs: 86_400_000,
    ...patch,
  };
}

const reportA = report();
const reportB = report({ scannedAtMs: 90_000_000 });

beforeEach(() => {
  mockMetrics.mockReset();
  mockParse.mockReset();
  mockParse.mockReturnValue("unknown");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refresh — the success path", () => {
  it("calls claudeMetrics once with the current query and stores the report", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().refresh();

    expect(mockMetrics).toHaveBeenCalledTimes(1);
    // 🔴 THE DEFAULT QUERY, and the one-line fix for the no-selection bug. `"all"`,
    // not `"project"`: the tab opens with nothing selected far more often than not, and
    // an earlier version paired that null cwd with `scope: "project"`, which Rust rejected
    // with `scan-failed` — so the dashboard read "Could not read your sessions" over a
    // machine full of them. It is also the dashboard's question: total usage on this
    // machine, not one folder's.
    expect(mockMetrics).toHaveBeenCalledWith("last_24h", "all", null);
    expect(useMetricsStore.getState()).toMatchObject({
      report: reportA,
      error: null,
      loading: false,
    });
  });

  it("holds `loading` true for exactly the duration of the scan", async () => {
    const { useMetricsStore } = await loadStore();
    const d = deferred<MetricsReport>();
    mockMetrics.mockReturnValue(d.promise);

    expect(useMetricsStore.getState().loading).toBe(false);
    const pending = useMetricsStore.getState().refresh();
    // Synchronously true: the button must go busy on the click, not a tick later.
    expect(useMetricsStore.getState().loading).toBe(true);

    d.resolve(reportA);
    await pending;
    expect(useMetricsStore.getState().loading).toBe(false);
  });

  it("clears a previous error on the next success", async () => {
    const { useMetricsStore } = await loadStore();
    mockParse.mockReturnValue("scan-failed");
    mockMetrics.mockRejectedValueOnce("scan-failed: nope");
    await useMetricsStore.getState().refresh();
    expect(useMetricsStore.getState().error).toBe("scan-failed");

    mockMetrics.mockResolvedValueOnce(reportA);
    await useMetricsStore.getState().refresh();
    expect(useMetricsStore.getState().error).toBeNull();
  });
});

describe("refresh — the failure path", () => {
  it("🔴 a failed refresh NEVER blanks the last good report", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValueOnce(reportA);
    await useMetricsStore.getState().refresh();
    expect(useMetricsStore.getState().report).toBe(reportA);

    mockParse.mockReturnValue("unknown");
    mockMetrics.mockRejectedValueOnce("unknown: boom");
    await useMetricsStore.getState().refresh();

    // Stale-but-true beats no numbers; the panel marks it stale off `error !== null`.
    expect(useMetricsStore.getState().report).toBe(reportA);
    expect(useMetricsStore.getState().error).toBe("unknown");
    expect(useMetricsStore.getState().loading).toBe(false);
  });

  it("hands the RAW rejection reason to parseMetricsError, unmangled", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockRejectedValueOnce("home-unresolved: no home directory");
    mockParse.mockReturnValue("home-unresolved");

    await useMetricsStore.getState().refresh();

    expect(mockParse).toHaveBeenCalledWith("home-unresolved: no home directory");
    expect(useMetricsStore.getState().error).toBe("home-unresolved");
  });

  it("never rejects, so every fire-and-forget call site is safe", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockRejectedValueOnce(new Error("boom"));
    await expect(useMetricsStore.getState().refresh()).resolves.toBeUndefined();
  });
});

describe("single-flight", () => {
  it("collapses concurrent refreshes into ONE scan and both callers await it", async () => {
    const { useMetricsStore } = await loadStore();
    const d = deferred<MetricsReport>();
    mockMetrics.mockReturnValue(d.promise);

    const first = useMetricsStore.getState().refresh();
    const second = useMetricsStore.getState().refresh();
    const third = useMetricsStore.getState().refresh();

    expect(mockMetrics).toHaveBeenCalledTimes(1);
    // Joining, not returning early: `await refresh()` must still mean "the numbers on
    // screen are now fresh" — which is what a spinner needs.
    d.resolve(reportA);
    await Promise.all([first, second, third]);
    expect(useMetricsStore.getState().report).toBe(reportA);
    expect(mockMetrics).toHaveBeenCalledTimes(1);
  });

  it("🔴 peak concurrency of the mocked IPC is exactly 1 — the ordering guarantee", async () => {
    const { useMetricsStore } = await loadStore();
    let live = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    mockMetrics.mockImplementation(() => {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise<MetricsReport>((resolve) => {
        pending.push(() => {
          live -= 1;
          resolve(reportA);
        });
      });
    });

    // Every way a second scan could be provoked, interleaved.
    const a = useMetricsStore.getState().refresh();
    const b = useMetricsStore.getState().refresh();
    const c = useMetricsStore.getState().setWindow("last_7d");
    const d = useMetricsStore.getState().setCwd("/work/proj");
    const e = useMetricsStore.getState().refresh();
    await flush();

    while (pending.length > 0) pending.shift()?.();
    await Promise.all([a, b, c, d, e]);
    await flush();

    // At most one response can exist at any instant, so a stale response landing
    // after a newer one is not representable — no `seq` guard is needed, and one
    // would be unreachable code pretending to be defence.
    expect(peak).toBe(1);
  });

  it("allows a NEW scan once the previous one has settled", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValueOnce(reportA).mockResolvedValueOnce(reportB);

    await useMetricsStore.getState().refresh();
    await useMetricsStore.getState().refresh();

    expect(mockMetrics).toHaveBeenCalledTimes(2);
    expect(useMetricsStore.getState().report).toBe(reportB);
  });
});

describe("the query is state, and changing it refetches", () => {
  it("setWindow records the window and rescans with it", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().setWindow("last_7d");

    expect(useMetricsStore.getState().query.window).toBe("last_7d");
    expect(mockMetrics).toHaveBeenCalledWith("last_7d", "all", null);
  });

  it("setScope switches between all and this project, rescanning each time", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    // Narrowing needs the project, so the panel records it first (in `all` scope that
    // costs nothing — see the test below).
    await useMetricsStore.getState().setCwd("/work/proj");
    expect(mockMetrics).toHaveBeenCalledTimes(0);

    await useMetricsStore.getState().setScope("project");
    expect(useMetricsStore.getState().query.scope).toBe("project");
    expect(mockMetrics).toHaveBeenLastCalledWith("last_24h", "project", "/work/proj");

    await useMetricsStore.getState().setScope("all");
    expect(useMetricsStore.getState().query.scope).toBe("all");
    // The cwd is still CARRIED, so the toggle can come back — it just stops filtering.
    expect(useMetricsStore.getState().query.cwd).toBe("/work/proj");
    expect(mockMetrics).toHaveBeenLastCalledWith("last_24h", "all", "/work/proj");
    expect(mockMetrics).toHaveBeenCalledTimes(2);
  });

  it("🔴 changing the project in ALL scope records it and reads NO disk", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    // In `all` scope the cwd is not an input to the scan, so re-pointing the tab at
    // another project cannot change the answer — and must therefore not sweep megabytes off
    // disk to produce the same numbers. The cwd is still recorded, because the scope
    // toggle needs to know a project is available.
    await useMetricsStore.getState().setCwd("/work/proj");
    await useMetricsStore.getState().setCwd("/work/other");
    await useMetricsStore.getState().setCwd(null);

    expect(mockMetrics).not.toHaveBeenCalled();
    expect(useMetricsStore.getState().query.cwd).toBeNull();
  });

  it("setCwd DOES rescan in project scope, where the cwd is the filter", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().setCwd("/work/proj");
    await useMetricsStore.getState().setScope("project");
    expect(mockMetrics).toHaveBeenCalledTimes(1);

    await useMetricsStore.getState().setCwd("/work/other");

    expect(mockMetrics).toHaveBeenCalledTimes(2);
    expect(mockMetrics).toHaveBeenLastCalledWith("last_24h", "project", "/work/other");
  });

  it("switching scope AND project at once still refetches exactly once", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    // The `answerChanged` check keys on the NEXT scope, so `all` → `project` refetches
    // even though the comparison "did the cwd change?" is evaluated under the new scope.
    await useMetricsStore.getState().setCwd("/work/proj");
    await useMetricsStore.getState().setScope("project");

    expect(mockMetrics).toHaveBeenCalledTimes(1);
    expect(mockMetrics).toHaveBeenCalledWith("last_24h", "project", "/work/proj");
  });

  it("a redundant query change costs NO disk sweep", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().setWindow("last_7d");
    expect(mockMetrics).toHaveBeenCalledTimes(1);

    // Clicking the already-active toggle, or a panel re-running its effect, must not
    // re-read megabytes off disk.
    await useMetricsStore.getState().setWindow("last_7d");
    await useMetricsStore.getState().setScope("all");
    expect(mockMetrics).toHaveBeenCalledTimes(1);
  });

  it("the fetch reads the query at CALL time, not at store-creation time", async () => {
    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().setCwd("/other");
    await useMetricsStore.getState().setWindow("last_7d");
    await useMetricsStore.getState().setScope("project");

    // Every change must carry the previous ones — otherwise the header and the numbers
    // would disagree about which window and scope produced them.
    expect(mockMetrics).toHaveBeenLastCalledWith("last_7d", "project", "/other");
  });
});

describe("ensureMetrics", () => {
  it("records the project AND fetches on a first mount", async () => {
    const { ensureMetrics, useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    ensureMetrics("/work/proj");
    await flush();

    // Two things had to happen and neither is optional: the cwd is recorded (or the scope
    // toggle could not tell that narrowing is possible) and a scan runs (or the panel sits
    // on its placeholder forever). In `all` scope the first does NOT imply the second, so
    // an `if/else` here — as an earlier version had — would silently do only one of them.
    expect(useMetricsStore.getState().query.cwd).toBe("/work/proj");
    expect(mockMetrics).toHaveBeenCalledTimes(1);
    expect(mockMetrics).toHaveBeenCalledWith("last_24h", "all", "/work/proj");
  });

  it("🔴 fetches on a first mount with a NULL project — the common real open", async () => {
    const { ensureMetrics, useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    // Nothing selected in the agent rail: the cwd matches the initial `null`, so `setCwd`
    // is skipped entirely and the fetch must come from the second step.
    ensureMetrics(null);
    await flush();

    expect(mockMetrics).toHaveBeenCalledTimes(1);
    expect(mockMetrics).toHaveBeenCalledWith("last_24h", "all", null);
    expect(useMetricsStore.getState().report).toBe(reportA);
    expect(useMetricsStore.getState().error).toBeNull();
  });

  it("does NOTHING when there is already a report — reopening a tab is free", async () => {
    const { ensureMetrics, useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    await useMetricsStore.getState().refresh();
    expect(mockMetrics).toHaveBeenCalledTimes(1);

    ensureMetrics(null);
    await flush();

    expect(mockMetrics).toHaveBeenCalledTimes(1);
  });

  it("re-points at another project without re-sweeping the disk in all scope", async () => {
    const { ensureMetrics, useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);

    ensureMetrics("/work/proj");
    await flush();
    expect(mockMetrics).toHaveBeenCalledTimes(1);

    // The tab followed the selection to another agent. The numbers are machine-wide and
    // cannot have changed, so the cwd moves and the disk stays untouched.
    ensureMetrics("/work/other");
    await flush();

    expect(useMetricsStore.getState().query.cwd).toBe("/work/other");
    expect(mockMetrics).toHaveBeenCalledTimes(1);
  });

  it("does not pile a second scan on top of one already in flight", async () => {
    const { ensureMetrics } = await loadStore();
    const d = deferred<MetricsReport>();
    mockMetrics.mockReturnValue(d.promise);

    ensureMetrics(null);
    ensureMetrics(null);
    await flush();

    expect(mockMetrics).toHaveBeenCalledTimes(1);
    d.resolve(reportA);
    await flush();
  });

  it("retries after a failure, because a failed mount leaves no report", async () => {
    const { ensureMetrics, useMetricsStore } = await loadStore();
    mockMetrics.mockRejectedValueOnce("unknown: boom");

    ensureMetrics(null);
    await flush();
    expect(useMetricsStore.getState().report).toBeNull();

    mockMetrics.mockResolvedValueOnce(reportA);
    ensureMetrics(null);
    await flush();
    expect(useMetricsStore.getState().report).toBe(reportA);
  });
});

describe("no timer", () => {
  it("🔴 installs NO interval or timeout — a filesystem sweep is not a 5 s cadence", async () => {
    // `usageStore` polls every 5 s, correctly: that is a ~1 s CLI call for a live
    // account limit. A 24 h scan reads megabytes and a 7 d scan far more, so polling it
    // would spend the user's disk on numbers that move by a rounding error — and the
    // live account figure is already covered by the usage strip. Asserted, not
    // promised, because "we removed the timer" is exactly the kind of decision a
    // later copy-paste from usageStore would silently undo.
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const setTimeout = vi.spyOn(globalThis, "setTimeout");

    const { useMetricsStore } = await loadStore();
    mockMetrics.mockResolvedValue(reportA);
    await useMetricsStore.getState().refresh();
    await useMetricsStore.getState().setWindow("last_7d");

    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
