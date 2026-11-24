/**
 * Which picture the Agent Village tab shows — the VILLAGE (a house per project, seen from
 * above) or the CITY (a building per project, a floor per console or
 * agent, seen from the side) — remembered per viewer, the way the sky override is
 * (`useVillageAmbience`). Storage is a convenience: every access is wrapped, and a missing,
 * corrupt or unreadable value means the village.
 */

import { useCallback, useState } from "react";

import type { Scene } from "./villageView";

export const MODE_STORAGE_KEY = "agentstudio.village.mode";

/** The stored mode; anything but "city" (or no storage at all) is the village. */
export function readStoredMode(): Scene {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "city" ? "city" : "village";
  } catch {
    return "village";
  }
}

function writeStoredMode(mode: Scene): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Private window / blocked storage: the choice still applies for this session.
  }
}

/** The current mode and its setter, which also remembers the choice. */
export function useVillageMode(): [Scene, (mode: Scene) => void] {
  const [mode, setModeState] = useState<Scene>(readStoredMode);
  const setMode = useCallback((m: Scene) => {
    setModeState(m);
    writeStoredMode(m);
  }, []);
  return [mode, setMode];
}
