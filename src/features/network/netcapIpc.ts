/**
 * Netcap IPC — the ONE `invoke`/`listen` seam of the Network view.
 *
 * Feature-local (not `app/ipc.ts`) so the wire types live next to their feature. Nothing here
 * swallows — a failed call is information the panel
 * shows, so rejections pass straight through to the store.
 *
 * Command names and argument shapes are pinned by `netcapIpc.test.ts`; they mirror
 * the Rust `netcap` commands exactly.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FlowDetail, FlowSummary, NetcapPatch, NetcapStatus } from "./networkTypes";

/** Upsert-by-id batches (≤ 1 emit / 100 ms): a flow arrives pending, then again when done. */
export const NETCAP_FLOW_EVENT = "netcap://flow";

export function netcapStatus(): Promise<NetcapStatus> {
  return invoke<NetcapStatus>("netcap_status");
}

/**
 * Change capture/decrypt. Only the keys present in `patch` are sent, so Rust's
 * `Option<bool>` args see "absent" rather than a `false` the user never chose.
 */
export function netcapSet(patch: NetcapPatch): Promise<NetcapStatus> {
  const args: Record<string, boolean> = {};
  if (patch.enabled !== undefined) args.enabled = patch.enabled;
  if (patch.decrypt !== undefined) args.decrypt = patch.decrypt;
  if (patch.strictAgentCapture !== undefined) args.strictAgentCapture = patch.strictAgentCapture;
  return invoke<NetcapStatus>("netcap_set", args);
}

/**
 * Opt one app in to (or out of) HTTPS decryption. `app` is the name the
 * capture guide shows — the `.app` bundle name, else the executable name.
 */
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
