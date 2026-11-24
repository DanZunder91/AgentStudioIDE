/**
 * `metricsIpc` — the metrics wire. A thin wrapper, so the command *name*, the
 * exact arg shape, and the **rejection passthrough** are the whole contract.
 *
 * The arg shape is worth pinning by name: Rust's `claude_metrics(window, scope, cwd)`
 * reads three keys, and a renamed or missing one would fail as *silence* — a report
 * for the wrong window, or a `scan-failed` nobody can explain — rather than as a type
 * error. The passthrough matters for the same reason it does in `usageIpc`: the store
 * classifies the raw `"<code>[: detail]"` string, which only works untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { claudeMetrics } from "./metricsIpc";
import type { MetricsReport } from "./metricsTypes";

/**
 * The smallest well-formed report. Inlined rather than shared from a helper module:
 * a non-test file under `src/features/metrics/**` would join the measured coverage set
 * and then need its own exclusion, and this wrapper's contract is the arg shape, not
 * the payload's richness.
 */
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

    // This is the argument triple the dashboard sends on the most common open:
    // the metrics tab with no agent selected. `"all"` must reach the wire spelled that
    // way (Rust's serde is `rename_all = "snake_case"` over `MetricsScopeKind::All`), and
    // the cwd must be an explicit `null`: `undefined` would drop the key, and Rust's
    // `Option<String>` would still deserialize — so "no project" and "key misspelled"
    // would become the same wire message, which is exactly the silence this pins.
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
