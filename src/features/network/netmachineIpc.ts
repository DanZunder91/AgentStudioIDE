/**
 * Netmachine IPC — the whole-computer connections seam.
 *
 * Its own file rather than more exports on `netcapIpc.ts`: every test that replaces that
 * module with a `vi.mock` factory would silently lack the new exports.
 * Nothing here swallows — a rejection is information the panel shows.
 *
 * Command and event names are pinned literally by `netmachineIpc.test.ts`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { MachineSample, MachineStatus } from "./networkTypes";

/** One full `MachineSample` per second while running. */
export const NETMACHINE_SAMPLE_EVENT = "netmachine://sample";

export function netmachineStatus(): Promise<MachineStatus> {
  return invoke<MachineStatus>("netmachine_status");
}

/** Idempotent; called while the Whole-computer mode is visible. */
export function netmachineStart(): Promise<MachineStatus> {
  return invoke<MachineStatus>("netmachine_start");
}

/** Idempotent. */
export function netmachineStop(): Promise<MachineStatus> {
  return invoke<MachineStatus>("netmachine_stop");
}

/** Subscribe to `netmachine://sample`. */
export function listenSamples(onSample: (sample: MachineSample) => void): Promise<UnlistenFn> {
  return listen<MachineSample>(NETMACHINE_SAMPLE_EVENT, (event) => onSample(event.payload));
}
