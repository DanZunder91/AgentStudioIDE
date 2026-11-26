/** The feature's one `invoke` seam, kept feature-local. Rejections pass through: a failed scan is
 * information the village shows, coded by {@link externalErrorCode}. */

import { invoke } from "@tauri-apps/api/core";

import type { ExternalAgentsReport, MachineCapacityWire, WeatherWire } from "./villageTypes";

/** Outside-IDE Claude sessions, read by Rust from `~/.claude/projects` (the app never writes it).
 * Omitted `activeWithinMins` is sent as `null` (Rust's default); sent by NAME since serde ignores
 * a misspelt key (pinned in `villageIpc.test.ts`). */
export function listExternalAgents(activeWithinMins?: number): Promise<ExternalAgentsReport> {
  return invoke<ExternalAgentsReport>("list_external_agents", {
    activeWithinMins: activeWithinMins ?? null,
  });
}

/** Brings the app an outside agent runs in to the front. `key` is Rust's key from the last scan
 * (`"ext:"` stripped), so no path or pid is sent. Rejects `no-host`, `unsupported` or
 * `open-failed` (read with {@link externalErrorCode}). */
export function focusExternalAgent(key: string): Promise<void> {
  return invoke<void>("focus_external_agent", { key });
}

/** Real current weather. Rust maps `timeZone` (IANA, from `Intl`) to a city: no geolocation, no
 * macOS prompt. Sent by NAME (`time_zone`); rejects with a coded string. */
export function villageWeather(timeZone: string): Promise<WeatherWire> {
  return invoke<WeatherWire>("village_weather", { timeZone });
}

/** CPUs, RAM and the `claude` sessions' resident memory; read-only in Rust. Rejects with a code. */
export function machineCapacity(): Promise<MachineCapacityWire> {
  return invoke<MachineCapacityWire>("machine_capacity");
}

/** The `"<code>[: detail]"` head of a rejection, or `unknown`. The detail is dropped on purpose: a
 * raw string must not reach a HUD that sits over every repo on the machine. */
export function externalErrorCode(raw: unknown): string {
  let message: string | null = null;
  if (typeof raw === "string") message = raw;
  else if (typeof raw === "object" && raw !== null) {
    const maybe = (raw as { message?: unknown }).message;
    if (typeof maybe === "string") message = maybe;
  }
  if (message === null) return "unknown";
  const cut = message.indexOf(":");
  const head = (cut === -1 ? message : message.slice(0, cut)).trim().toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(head) ? head : "unknown";
}
