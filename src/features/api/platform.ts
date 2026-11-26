/** On Windows "Copy as cURL" must name its target shell (curlExport.ts); elsewhere it is bash.
 * Wraps lib/platform's os(), the one OS answer for the whole UI. */

import { os } from "../../lib/platform";

export function isWindowsPlatform(): boolean {
  return os() === "windows";
}
