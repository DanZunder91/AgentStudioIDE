/**
 * Agent Village IPC — the ONE `invoke` seam for the feature.
 *
 * Kept feature-local (not in `app/ipc.ts`) so the wire types live next to their feature.
 *
 * The wrapper does not swallow: a failed scan is information the village shows ("could
 * not see agents outside the IDE"), so the rejection passes through and the hook turns
 * it into a code with {@link externalErrorCode}.
 */

import { invoke } from "@tauri-apps/api/core";

import type { ExternalAgentsReport, MachineCapacityWire, WeatherWire } from "./villageTypes";

/**
 * `list_external_agents` — the Claude Code sessions on this machine that the IDE does
 * NOT run, discovered read-only from `~/.claude/projects` by Rust (reads
 * only — the app never writes `~/.claude`). `activeWithinMins` bounds how stale a session may be and still count; omitted,
 * it is sent as `null` so Rust applies its own default.
 *
 * The key is sent by NAME (Tauri camel-cases Rust's `active_within_mins`); serde ignores
 * unknown fields, so a misspelt key would fail as silence — `villageIpc.test.ts` pins
 * the exact argument object.
 */
export function listExternalAgents(activeWithinMins?: number): Promise<ExternalAgentsReport> {
  return invoke<ExternalAgentsReport>("list_external_agents", {
    activeWithinMins: activeWithinMins ?? null,
  });
}

/**
 * `focus_external_agent` — bring the app an outside agent runs in (iTerm2, Terminal,
 * VS Code… on macOS; Windows Terminal, VS Code, a console window… on Windows) to the
 * front. `key` is the RUST key from the last scan (the village's `"ext:"` prefix
 * stripped); Rust looks the app up in its own cache, so no path or pid is ever sent from
 * here. Nothing here is platform-gated: an agent whose `host` Rust filled in is clickable
 * on every OS that can find one. Rejects with a coded string (`no-host`, `unsupported` —
 * neither macOS nor Windows — `open-failed`) — read it with {@link externalErrorCode}.
 */
export function focusExternalAgent(key: string): Promise<void> {
  return invoke<void>("focus_external_agent", { key });
}

/**
 * `village_weather` — the REAL current weather outside, for the village sky.
 * `timeZone` is the IANA zone from `Intl` (e.g. `"Asia/Tokyo"`): Rust maps it
 * to a city-level place, so no geolocation API is ever touched (no macOS
 * permission prompt). Sent by NAME (`time_zone` in Rust); `villageIpc.test.ts` pins the
 * exact argument object. Rejects with a coded string — read it with {@link externalErrorCode}.
 */
export function villageWeather(timeZone: string): Promise<WeatherWire> {
  return invoke<WeatherWire>("village_weather", { timeZone });
}

/**
 * `machine_capacity` — this machine's CPUs and RAM and the `claude` sessions' resident memory, for
 * the capacity buildings. Read-only in Rust (the process table and two kernel
 * counters); takes no arguments. Rejects with a coded string — read it with {@link externalErrorCode}.
 */
export function machineCapacity(): Promise<MachineCapacityWire> {
  return invoke<MachineCapacityWire>("machine_capacity");
}

/**
 * The code of a rejection from {@link listExternalAgents} / {@link focusExternalAgent}: the `"<code>[: detail]"` head
 * (the app's coded-error convention), or `unknown` for anything else. The detail is dropped on purpose — a
 * raw string is exactly what must not reach a HUD that sits over every repo on the machine.
 */
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
