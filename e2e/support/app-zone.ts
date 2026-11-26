/** Per-spec app time zone via a TZ launcher, since tauri-driver is one process for every spec. The
 * worker keeps the container's zone; e2e-linux.mjs maps the weather host to 127.0.0.1. */

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

/** POSIX `sh` launcher, Linux only: on Windows `TZ` does not move WebView2's zone anyway. */
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
