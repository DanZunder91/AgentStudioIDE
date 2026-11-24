/**
 * platform — the ONE answer to "which OS is this window running on?" for the whole UI.
 *
 * Every platform branch in the UI (⌘ vs Ctrl, Finder vs File Explorer, the terminal's
 * copy/paste keys, "Copy as cURL"'s shell, `~` for the home folder) reads this, so two
 * surfaces can never disagree about where they are. `isMac()` / `isWindows()`
 * (`features/shortcuts/shortcuts.ts`) and `isWindowsPlatform()` (`features/api/platform.ts`)
 * are thin wrappers over it, kept because many tests mock them by those names.
 *
 * The answer comes from the webview's user agent, the one thing the UI can read
 * synchronously without an IPC round trip:
 *   - macOS — WKWebView says `Macintosh; Intel Mac OS X …` (Apple Silicon too) and
 *     `navigator.platform` is `MacIntel`. iPhone/iPad/iPod are kept in the same bucket
 *     exactly as `isMac()` always had them (⌘ is their modifier as well).
 *   - Windows — WebView2 says `Windows NT 10.0; Win64; x64` (ARM64 also says `Windows NT`).
 *     Deliberately the word `Windows`, never `Win`: jsdom's own user agent carries Node's
 *     `process.platform` (`win32` on a Windows dev box), and a test must not change OS with
 *     the machine it runs on.
 *   - Linux — WebKitGTK says `X11; Linux x86_64` (or `aarch64`). Case-SENSITIVE `Linux`:
 *     jsdom on a Linux host says `(linux)`, lower-case, and must stay "other" for the same
 *     reason as `win32` above.
 */

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
