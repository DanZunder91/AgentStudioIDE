/**
 * Usage-limits IPC — the one `invoke` seam for the left-rail usage panel.
 *
 * Kept feature-local (not `app/ipc.ts`), like `fleetIpc.ts`, so the wire types live
 * next to their feature.
 *
 * Unlike the best-effort persistence wrappers (`pinAgent`, `saveApiStore`), this
 * one **does not swallow**: a failed usage fetch is information the user needs to
 * see ("not signed in" / "offline"), so the rejection is passed through and the
 * store turns it into a code via `parseUsageError`.
 */

import { invoke } from "@tauri-apps/api/core";

import type { UsageSnapshot } from "./usageTypes";

/**
 * `claude_usage` — fetch the account's live usage windows.
 *
 * Rejects with the stable `<code>[: detail]` string documented on
 * {@link import("./usageTypes").UsageErrorCode}. Takes no arguments: which account
 * to read is whichever one the local `claude` CLI is signed in as.
 */
export function claudeUsage(): Promise<UsageSnapshot> {
  return invoke<UsageSnapshot>("claude_usage", {});
}
