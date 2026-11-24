/**
 * The seam test. This file exists because of a specific failure, and its only job is to
 * make that failure impossible to reintroduce.
 *
 * ── What happened ────────────────────────────────────────────────────────────
 * Opening the Metrics tab for the first time showed:
 *
 *     Could not read your sessions
 *     The session scan could not be run for this folder.
 *
 * The chain: `MetricsButton` passes the selected agent's root cwd, which is `null` when
 * no agent row is selected (the common case on a fresh launch). The store paired that
 * `null` with `scope: "project"`, and `claude_metrics` rejected the combination with
 * `scan-failed: project scope requires a cwd`.
 *
 * ── Why the suite was green anyway ───────────────────────────────────────────
 * There was a test for *"the button passes null"* and a test for *"the command rejects
 * a null cwd"*. Both passed. Both were right. **Nothing exercised the path between
 * them**, so the composition — the only thing the user actually touches — was never
 * asserted. That is the lesson worth keeping: two unit tests that each assume the other
 * side is correct do not add up to an integration test.
 *
 * So this file deliberately does NOT unit-test anything. It drives the real store with
 * the real argument the button sends, over a mocked IPC boundary, and asserts the user
 * gets **numbers**. If it ever fails, that screen is broken again.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the IPC edge is mocked: everything above it — the store, its query defaults, the
// panel — is the real code, because the bug lived in how those three composed.
const ipc = vi.hoisted(() => ({ claudeMetrics: vi.fn() }));
vi.mock("./metricsIpc", () => ipc);

// The account row consumes `features/usage`; stub it so this file tests one thing.
vi.mock("../usage/usageStore", () => ({
  startUsagePolling: () => () => {},
  useUsageStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ snapshot: null, error: null, loading: false, refresh: vi.fn() }),
}));

import { MetricsPanel } from "./MetricsPanel";
import { ensureMetrics, useMetricsStore } from "./metricsStore";
import type { MetricsReport } from "./metricsTypes";

/** A minimal but honest report: one turn, real token classes, nothing invented. */
const REPORT: MetricsReport = {
  window: { kind: "last_24h", fromMs: 1_785_100_000_000, toMs: 1_785_186_400_000 },
  scope: { kind: "all", cwd: null },
  totals: {
    sessions: 3,
    turns: 20,
    humanTurns: 8,
    requests: 489,
    toolCalls: 330,
    toolErrors: 2,
    filesChanged: 18,
    timeInTurnsMs: 15_120_000,
    turnsWithDuration: 19,
    tokens: { freshInput: 14_523, output: 552_329, cacheWrite: 3_925_676, cacheRead: 210_303_264 },
    avgContextPerRequest: 145_000,
    highContextRequestShare: 0.55,
  },
  hourly: [],
  topTurns: [],
  // `perRoot` survives the multi-root removal as a single-entry list: the machine is one
  // root, and keeping the shape means the panel's per-root rendering needs no special case.
  perRoot: [],
  coverage: {
    rootsScanned: 1,
    rootsUnavailable: [],
    filesConsidered: 163,
    filesRead: 6,
    bytesRead: 9_676_196,
    scanMs: 99,
    filesTruncated: 0,
    linesUnparseable: 0,
    turnsWithoutCliDuration: 5,
    turnsWithoutPromptId: 0,
    scopeFellBackToAll: false,
    partial: false,
  },
  scannedAtMs: 1_785_186_400_000,
};

beforeEach(() => {
  ipc.claudeMetrics.mockReset();
  // Reset the real store to its boot state, the way a fresh app launch arrives.
  useMetricsStore.setState({ report: null, error: null, loading: false });
});

describe("no agent selected — the seam that shipped a broken screen", () => {
  it("🔴 renders NUMBERS, not an error, when nothing is selected (cwd === null)", async () => {
    ipc.claudeMetrics.mockResolvedValue(REPORT);

    // EXACTLY what `MetricsButton` does with no selection. This single line is the whole
    // point of the file: it is the call no earlier test made.
    ensureMetrics(null);
    render(<MetricsPanel cwd={null} />);

    await waitFor(() => expect(screen.queryByTestId("metrics-error")).toBeNull());
    // A number the user can read, from the real store, through the real panel.
    expect(screen.getByTestId("metrics-panel").textContent).toContain("489");
    expect(screen.queryByText(/could not be run for this folder/i)).toBeNull();
  });

  it("asks for ALL scope by default, because that is the dashboard's question", async () => {
    ipc.claudeMetrics.mockResolvedValue(REPORT);

    ensureMetrics(null);
    await waitFor(() => expect(ipc.claudeMetrics).toHaveBeenCalled());

    // The arguments the command receives are the thing that was wrong before: a null cwd
    // paired with `scope: "project"`. Asserting the *sent* values — not the store's
    // internal state — is what makes this an integration test rather than a restatement.
    // (Positional: `claudeMetrics(window, scope, cwd)`.)
    const [window, scope, cwd] = ipc.claudeMetrics.mock.calls[0] as [string, string, string | null];
    expect(window).toBe("last_24h");
    expect(scope).toBe("all");
    expect(cwd).toBeNull();
  });

  it("still surfaces a GENUINE failure honestly — this is not a blanket catch", async () => {
    // The fix must not have turned every error into silence. A real failure (no home
    // directory, an unreadable root) must still reach the user, because a dashboard that
    // swallows errors is the other way to lie about what it knows.
    ipc.claudeMetrics.mockRejectedValue("home-unresolved: no home directory");

    ensureMetrics(null);
    render(<MetricsPanel cwd={null} />);

    await waitFor(() => expect(screen.getByTestId("metrics-error")).toBeInTheDocument());
  });
});
