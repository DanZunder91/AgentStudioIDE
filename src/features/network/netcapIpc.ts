/** The one `invoke`/`listen` seam of the Network view, feature-local so wire types sit with it.
 * Nothing swallows: rejections reach the store, which shows them. Names mirror the Rust `netcap`
 * commands exactly and are pinned by `netcapIpc.test.ts`. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FlowDetail, FlowSummary, NetcapPatch, NetcapStatus } from "./networkTypes";

/** Upsert-by-id batches (≤ 1 emit / 100 ms): a flow arrives pending, then again when done. */
export const NETCAP_FLOW_EVENT = "netcap://flow";

export function netcapStatus(): Promise<NetcapStatus> {
  return invoke<NetcapStatus>("netcap_status");
}

/** Only keys present in `patch` are sent, so Rust's `Option<bool>` args see "absent", not a
 * `false` the user never chose. */
export function netcapSet(patch: NetcapPatch): Promise<NetcapStatus> {
  const args: Record<string, boolean> = {};
  if (patch.enabled !== undefined) args.enabled = patch.enabled;
  if (patch.decrypt !== undefined) args.decrypt = patch.decrypt;
  if (patch.strictAgentCapture !== undefined) args.strictAgentCapture = patch.strictAgentCapture;
  return invoke<NetcapStatus>("netcap_set", args);
}

/** Per-app HTTPS decryption opt-in. `app` is the name the capture guide shows: the `.app` bundle
 * name, else the executable name. */
export function netcapSetAppDecrypt(app: string, on: boolean): Promise<NetcapStatus> {
  return invoke<NetcapStatus>("netcap_set_app_decrypt", { app, on });
}

/** Every flow in Rust's ring, oldest first. */
export function netcapSnapshot(): Promise<FlowSummary[]> {
  return invoke<FlowSummary[]>("netcap_snapshot");
}

/** One flow's headers and bodies. Rejects `not-found` once the ring evicted it. */
export function netcapFlow(id: number): Promise<FlowDetail> {
  return invoke<FlowDetail>("netcap_flow", { id });
}

export function netcapClear(): Promise<void> {
  return invoke<void>("netcap_clear");
}

/** Subscribe to `netcap://flow`. */
export function listenFlows(onBatch: (batch: FlowSummary[]) => void): Promise<UnlistenFn> {
  return listen<FlowSummary[]>(NETCAP_FLOW_EVENT, (event) => onBatch(event.payload));
}
