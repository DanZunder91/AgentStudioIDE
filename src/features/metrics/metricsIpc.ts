/** The dashboard's `invoke` seam, feature-local. Rejections pass through for the store to code.
 * Transcripts are read and reduced in Rust; only the small report crosses IPC, and the frontend
 * must never gain a filesystem route to `~/.claude`. */

import { invoke } from "@tauri-apps/api/core";

import type { MetricsReport, MetricsScopeKind, MetricsWindowKind } from "./metricsTypes";

/** Scan local transcripts into a report; rejects with `<code>[: detail]` (see
 * {@link import("./metricsTypes").MetricsErrorCode}). `cwd` is only compared, never a path; null
 * is normal and sent as `null`, not omitted (`project` + null widens to all). */
export function claudeMetrics(
  window: MetricsWindowKind,
  scope: MetricsScopeKind,
  cwd: string | null,
): Promise<MetricsReport> {
  return invoke<MetricsReport>("claude_metrics", { window, scope, cwd });
}
