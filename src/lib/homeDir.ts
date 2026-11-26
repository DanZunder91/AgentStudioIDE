/** Home folder for `~/…` display, read once via Tauri's path API (`core:path:default`, no OS
 * prompt) and cached for the session. A failure (no Tauri) is `null`: show the path as is. */

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
