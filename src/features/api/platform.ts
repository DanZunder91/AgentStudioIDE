/**
 * platform — the one platform fact the API client needs: is this Windows?
 *
 * On Windows "Copy as cURL" must say which shell it is writing for (PowerShell,
 * cmd or bash — `curlExport.ts`); everywhere else it is bash, as it always was.
 * A thin wrapper over `lib/platform`'s `os()`, the one OS answer for the whole UI
 * (which documents why it matches `Windows`, never `Win`).
 */

import { os } from "../../lib/platform";

export function isWindowsPlatform(): boolean {
  return os() === "windows";
}
