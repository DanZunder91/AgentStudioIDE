/** Command name, arg names (a renamed key fails silently in serde) and untouched rejection
 * passthrough (the store classifies the raw `"<code>[: detail]"`) are the contract. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { claudeMetrics } from "./metricsIpc";
import type { MetricsReport } from "./metricsTypes";

/** Inlined: a non-test helper under `src/features/metrics/` would join the coverage set. */
const EMPTY_REPORT: MetricsReport = {
  window: { kind: "last_24h", fromMs: 0, toMs: 86_400_000 },
  scope: { kind: "all", cwd: null },
  totals: {
    sessions: 0,
    turns: 0,
    humanTurns: 0,
    requests: 0,
    tokens: { freshInput: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    avgContextPerRequest: null,
    highContextRequestShare: null,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: 0,
    timeInTurnsMs: 0,
    turnsWithDuration: 0,
  },
  perRoot: [],
  hourly: [],
  topTurns: [],
  coverage: {
    rootsScanned: 1,
    rootsUnavailable: [],
    filesConsidered: 0,
    filesRead: 0,
    bytesRead: 0,
    scanMs: 1,
    filesTruncated: 0,
    linesUnparseable: 0,
    turnsWithoutCliDuration: 0,
    turnsWithoutPromptId: 0,
    scopeFellBackToAll: false,
    partial: false,
  },
  scannedAtMs: 86_400_000,
};

describe("metricsIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes claude_metrics with window, scope and cwd, and resolves the report untouched", async () => {
    ipc.handle("claude_metrics", () => EMPTY_REPORT);

    await expect(claudeMetrics("last_24h", "project", "/work/proj")).resolves.toEqual(
      EMPTY_REPORT,
    );
    expect(ipc.lastCall("claude_metrics")).toEqual({
      window: "last_24h",
      scope: "project",
      cwd: "/work/proj",
    });
  });

  it("🔴 sends the DEFAULT pair — scope 'all' with a null cwd — as exactly that", async () => {
    ipc.handle("claude_metrics", () => EMPTY_REPORT);

    // The most common open (no agent selected): `"all"` in snake_case and an explicit `null` cwd;
    // `undefined` would drop the key and look like a misspelled one.
    await expect(claudeMetrics("last_24h", "all", null)).resolves.toEqual(EMPTY_REPORT);
    expect(ipc.lastCall("claude_metrics")).toEqual({
      window: "last_24h",
      scope: "all",
      cwd: null,
    });

    await claudeMetrics("last_7d", "all", null);
    expect(ipc.lastCall("claude_metrics")).toEqual({
      window: "last_7d",
      scope: "all",
      cwd: null,
    });
  });

  it("passes a coded string rejection through untouched", async () => {
    // `root-unavailable`, not `scan-failed`: nothing returns the latter any more (see
    // `MetricsErrorCode`), and a test asserting on a rejection the backend cannot produce
    // would quietly become fiction.
    ipc.handle("claude_metrics", () =>
      Promise.reject("root-unavailable: the transcript folder could not be read"),
    );

    await expect(claudeMetrics("last_24h", "all", null)).rejects.toBe(
      "root-unavailable: the transcript folder could not be read",
    );
  });

  it("does not swallow a bare code either", async () => {
    ipc.handle("claude_metrics", () => Promise.reject("home-unresolved"));

    await expect(claudeMetrics("last_24h", "project", "/x")).rejects.toBe("home-unresolved");
  });

  it("sends a cwd in 'all' scope too, rather than second-guessing Rust", async () => {
    ipc.handle("claude_metrics", () => EMPTY_REPORT);

    // The wrapper is a wrapper: it does not decide that a cwd is irrelevant to `all`
    // scope, Rust does (and ignores it, and does not echo it). Filtering arguments here
    // would put the same rule in two places, which is how two places start disagreeing.
    await claudeMetrics("last_24h", "all", "/work/proj");

    expect(ipc.lastCall("claude_metrics")).toEqual({
      window: "last_24h",
      scope: "all",
      cwd: "/work/proj",
    });
  });
});
