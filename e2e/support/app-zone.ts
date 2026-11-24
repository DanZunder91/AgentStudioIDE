/**
 * The APP's time zone, per spec — not the runner's, and not the other specs'.
 *
 * Why: the Agent City shows the machine's own city when its IANA zone is one the art knows
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo"`: Mt Fuji, Tokyo Tower and
 * Skytree on the skyline, sakura, vending machines and a torii in both pictures). The E2E container
 * is UTC, so a spec that photographs that theme has to launch the app in Tokyo.
 *
 * How: `tauri-driver` is ONE process for the whole run (wdio.conf `onPrepare`), and the app inherits
 * its environment, so an env var there would move every spec's app. Instead wdio.conf's
 * `beforeSession` points THIS spec's session at a tiny launcher ({@link zonedLauncher}) that sets
 * `TZ` and `exec`s the real binary — same process, same argv (WebKitWebDriver's own flags pass
 * through), same environment otherwise. The wdio worker (the spec's own Node process) keeps the
 * container's zone, which the spec checks, so a date the SPEC formats is never silently shifted.
 *
 * The weather: an app in a real zone asks Open-Meteo for that city's weather (`weather.rs`). In the
 * Docker run nothing may leave the container, so `scripts/e2e-linux.mjs` maps the weather host to
 * 127.0.0.1 (`--add-host`) and says which hosts it mapped (`E2E_BLOCKED_HOSTS`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Spec name (`record.ts` `specName`: `village-city.e2e.ts` → `village-city`) → the zone its app runs in. */
export const APP_ZONES: Readonly<Record<string, string>> = {
  // The Tokyo street theme and skyline, photographed for the PR.
  "village-city": "Asia/Tokyo",
};

/** An IANA zone name ("Asia/Tokyo", "America/Argentina/Buenos_Aires", "UTC") — nothing a shell would read. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * Write (idempotently) an executable launcher that runs `binary` with `TZ=zone`, and return its path.
 * POSIX `sh` — the Linux E2E only (on Windows `TZ` does not move WebView2's zone anyway).
 */
export function zonedLauncher(binary: string, zone: string, dir = path.join(os.tmpdir(), "agent-studio-e2e-launchers")): string {
  if (!ZONE_NAME.test(zone)) throw new Error(`not an IANA time zone name: ${JSON.stringify(zone)}`);
  if (binary.includes("'")) throw new Error(`cannot quote the app binary path for sh: ${binary}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${zone.replace(/\//g, "_")}.sh`);
  const body = [
    "#!/bin/sh",
    `# Written by e2e/support/app-zone.ts: the app under test, in ${zone} (the rest of the run keeps its own zone).`,
    `export TZ='${zone}'`,
    `exec '${binary}' "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}
