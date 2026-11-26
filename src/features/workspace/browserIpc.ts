/** "Open in Browser" seam: a scoped command naming a browser by id, never a widened `url_open`
 * (contract: `src-tauri/src/browser_open.rs`). `ContextMenu` cannot grow once open, so the list is
 * primed once and read synchronously; until then a single default-browser leaf is shown. */

import { invoke } from "@tauri-apps/api/core";

/** One browser the OS can open a page with. */
export interface BrowserChoice {
  /** Opaque OS handle (bundle id, `.desktop` id, `StartMenuInternet` key), NEVER an executable
   * path: only a value Rust produced, re-resolved against its own list before launching. */
  id: string;
  /** What to show in the menu — the app's display name ("Google Chrome"). */
  name: string;
  /** Is this the OS's current default for `http`/`https`? Exactly one, at most. */
  isDefault: boolean;
}

/** Installed browsers, default first. No enumeration on an OS returns `[]`: same menu, no error. */
export function listBrowsers(): Promise<BrowserChoice[]> {
  return invoke<BrowserChoice[]>("list_browsers");
}

/** Opens local file `path` (`browserId` omitted: system default). Rust proves `path` is inside a
 * workspace root before spawning, or this is file exfiltration. Rejects `out-of-scope |
 * not-a-file | unknown-browser | spawn-failed | unknown`. */
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

/** Starts or joins the session's one enumeration; idempotent, safe on every mount. */
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

/** Read synchronously while BUILDING menu items: the menu must know its size before it opens. */
export function cachedBrowsers(): BrowserChoice[] | null {
  return cache;
}

/** Test-only: forget the primed list so each test starts from a known state. */
export function resetBrowserCache(): void {
  cache = null;
  inFlight = null;
}
