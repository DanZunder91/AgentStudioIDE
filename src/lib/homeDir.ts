/**
 * homeDir — the user's home folder, for showing paths as `~/…` (`paths.tildeHome`).
 *
 * Read once from Tauri's core path API (`plugin:path|resolve_directory`, granted by
 * `core:default` → `core:path:default`; no OS prompt, no Rust of ours): `/Users/me` on macOS,
 * `/home/me` on Linux, `C:\Users\me` on Windows. Cached for the session — it cannot change
 * under a running app. A failure (no Tauri, as in a browser test) is `null`, which every
 * caller treats as "show the path as it is".
 */

import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

let cached: string | null = null;
let pending: Promise<string | null> | null = null;

/** The home folder, fetched at most once per session; `null` when it cannot be known. */
export function loadHomeDir(): Promise<string | null> {
  pending ??= homeDir().then(
    (h) => (cached = h),
    () => null,
  );
  return pending;
}

/** The home folder for a component: `null` until (and unless) it is known. */
export function useHomeDir(): string | null {
  const [home, setHome] = useState(cached);
  useEffect(() => {
    if (home !== null) return;
    let live = true;
    void loadHomeDir().then((h) => {
      if (live && h !== null) setHome(h);
    });
    return () => {
      live = false;
    };
  }, [home]);
  return home;
}

/** Tests only: forget the cached answer. */
export function resetHomeDirForTests(): void {
  cached = null;
  pending = null;
}
