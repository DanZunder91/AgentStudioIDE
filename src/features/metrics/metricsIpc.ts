/**
 * Metrics IPC — the one `invoke` seam for the dashboard.
 *
 * Feature-local (not `app/ipc.ts`), like `usageIpc.ts` and `fleetIpc.ts`, so the wire
 * types live next to their feature.
 *
 * Like `claudeUsage` and unlike the best-effort persistence wrappers, this one **does
 * not swallow**: a failed scan is information the user needs ("we could not read your
 * transcripts"), so the rejection passes through and the store turns it into a code.
 *
 * Note what does NOT happen here: the frontend never touches the filesystem. Megabytes
 * of transcript for a 24 h window (far more for 7 d) are read and reduced in Rust, and
 * only the kilobyte-sized report crosses IPC — ARCHITECTURE's invariant that
 * high-volume data never enters React state, and the reason the frontend has no
 * filesystem route to `~/.claude` and must not gain one.
 */

import { invoke } from "@tauri-apps/api/core";

import type { MetricsReport, MetricsScopeKind, MetricsWindowKind } from "./metricsTypes";

/**
 * `claude_metrics` — scan the local transcripts and reduce them to a report.
 *
 * Rejects with the stable `<code>[: detail]` string documented on
 * {@link import("./metricsTypes").MetricsErrorCode}.
 *
 * `cwd` is **optional and only meaningful for `scope: "project"`**, where it is only ever
 * *compared* against each transcript's own `cwd` field Rust-side — never used to build a
 * path. A `null` cwd is a normal argument, not an error: with `scope: "all"` (the default)
 * it is simply irrelevant, and with `scope: "project"` Rust widens to `"all"` and reports
 * `coverage.scopeFellBackToAll`. An earlier version rejected that pair with `scan-failed`,
 * which is the bug this contract fixes — so it stays a `null` on the wire rather than being
 * omitted, and `metricsIpc.test.ts` pins that.
 */
export function claudeMetrics(
  window: MetricsWindowKind,
  scope: MetricsScopeKind,
  cwd: string | null,
): Promise<MetricsReport> {
  return invoke<MetricsReport>("claude_metrics", { window, scope, cwd });
}
