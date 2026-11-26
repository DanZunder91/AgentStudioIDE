/** Usage-limits IPC, feature-local like `fleetIpc.ts`. Unlike the best-effort wrappers it does NOT
 * swallow: a failed fetch is shown to the user, via the store's `parseUsageError`. */

import { invoke } from "@tauri-apps/api/core";

import type { UsageSnapshot } from "./usageTypes";

/** Rejects with the `<code>[: detail]` string of {@link import("./usageTypes").UsageErrorCode}.
 * The account is whichever one the local `claude` CLI is signed in as. */
export function claudeUsage(): Promise<UsageSnapshot> {
  return invoke<UsageSnapshot>("claude_usage", {});
}
