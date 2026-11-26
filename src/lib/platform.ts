/** The one OS answer for the UI (`isMac`, `isWindows`, `isWindowsPlatform` wrap it), from the
 * webview's user agent. Matches `Windows` (never `Win`) and case-sensitive `Linux`: jsdom's agent
 * carries the host's `win32` / `(linux)`. iPhone/iPad/iPod count as macOS (⌘ modifier). */

export type Os = "macos" | "windows" | "linux" | "other";

/** Which OS this webview is on. macOS is checked first so `isMac()` keeps its exact old rule. */
export function os(): Os {
  // `navigator` always exists in the WebView (and in jsdom under test).
  const { userAgent, platform } = navigator;
  if (/Mac|iPhone|iPad|iPod/i.test(`${userAgent} ${platform}`)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux|X11/.test(`${userAgent} ${platform}`)) return "linux";
  return "other";
}
