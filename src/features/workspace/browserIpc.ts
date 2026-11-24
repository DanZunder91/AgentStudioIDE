/**
 * browserIpc — the one `invoke` seam for "Open in Browser" on an `.html` file.
 * A dedicated scoped command that names a browser by bundle id — never a widened
 * `url_open`, and never the OS default handler for the file type.
 *
 * Feature-local rather than in `app/ipc.ts`, like `gitIpc.ts`, so the wire types
 * live next to their feature. The command *names* and arg/result *shapes* here are
 * the whole wire contract with `src-tauri/src/browser_open.rs`, which is written
 * against this exact interface.
 *
 * # Why there is a cache at all
 *
 * The context menu cannot grow after it opens. `ContextMenu` measures and clamps
 * on `[x, y, anchor]` only, and its focus effect keys on `[activeIndex, openSub]`
 * — so a submenu that starts as a "Loading…" row and gains real rows later is
 * never re-measured (it can run off the bottom of the screen) and never gains a
 * focus ring. The Git submenu makes the same call: the menu is built from git
 * status the tree ALREADY holds — no IPC fires just to open a menu.
 *
 * So the list is primed once per app session and read SYNCHRONOUSLY when the
 * menu is built. Before it resolves — and if it fails — `cachedBrowsers()`
 * returns null and the caller shows a single "Open in Browser" leaf that uses
 * the system default. That fallback is accepted behaviour (opening in the
 * default browser is acceptable), which is why enumeration is
 * allowed to fail soft instead of blocking the gesture.
 */

import { invoke } from "@tauri-apps/api/core";

/** One browser the OS can open a page with. */
export interface BrowserChoice {
  /**
   * The opaque OS-level handle Rust needs to launch it — a macOS bundle id
   * (`com.google.Chrome`), a Linux `.desktop` id (`firefox.desktop`), a Windows
   * `StartMenuInternet` key. 🔴 Never an executable path: the frontend must not
   * be able to name an arbitrary binary for Rust to spawn, so this value is only
   * ever one Rust itself produced, and Rust re-resolves it against its own list
   * before launching.
   */
  id: string;
  /** What to show in the menu — the app's display name ("Google Chrome"). */
  name: string;
  /** Is this the OS's current default for `http`/`https`? Exactly one, at most. */
  isDefault: boolean;
}

/**
 * `list_browsers` — the browsers installed on this machine, default first.
 *
 * Rejects only on an internal error; an OS where enumeration is not implemented
 * returns an empty list, because "I could not enumerate" and "you have no
 * browsers" lead to the same menu and neither is worth an error dialog.
 */
export function listBrowsers(): Promise<BrowserChoice[]> {
  return invoke<BrowserChoice[]>("list_browsers");
}

/**
 * `open_in_browser` — open the local file at `path` in a browser.
 *
 * `browserId` is a {@link BrowserChoice.id}; omit it for the system default.
 * Rust canonicalizes `path` and proves it is inside an allowed workspace root
 * BEFORE spawning anything — without that this command is
 * arbitrary-local-file exfiltration from the webview.
 *
 * Rejects with Rust's stable `"<code>[: detail]"` string:
 * `out-of-scope | not-a-file | unknown-browser | spawn-failed | unknown`.
 */
export function openInBrowser(path: string, browserId?: string): Promise<void> {
  return invoke<void>("open_in_browser", {
    path,
    // Null, not undefined: an omitted key is dropped by the serializer and the
    // NAME is the contract — serde reads `browserId` and silently ignores
    // anything else (same rule as `fleetIpc.spawnAgent`'s `prompt`).
    browserId: browserId ?? null,
  });
}

/* ─────────────────────────── the session-long cache ─────────────────────────── */

let cache: BrowserChoice[] | null = null;
let inFlight: Promise<BrowserChoice[]> | null = null;

/**
 * Start (or join) the one enumeration for this app session.
 *
 * Idempotent and de-duplicated, the idiom `gitStore`'s PR fetch uses: many
 * callers, one IPC. Safe to call on every mount.
 */
export function primeBrowsers(): Promise<BrowserChoice[]> {
  if (cache !== null) return Promise.resolve(cache);
  if (inFlight !== null) return inFlight;
  inFlight = listBrowsers()
    .then((list) => {
      cache = list;
      return list;
    })
    .catch(() => {
      // Fail soft, and leave `cache` null so a later prime can retry: a machine
      // we cannot enumerate still gets the working "system default" leaf.
      return [];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The primed list, or null if it has not arrived (or failed).
 *
 * Synchronous on purpose — this is read while BUILDING the menu items, and the
 * menu must know its full size before it opens. See the header.
 */
export function cachedBrowsers(): BrowserChoice[] | null {
  return cache;
}

/** Test-only: forget the primed list so each test starts from a known state. */
export function resetBrowserCache(): void {
  cache = null;
  inFlight = null;
}
