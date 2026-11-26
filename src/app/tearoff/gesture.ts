/** Tear-off drag gestures (tab-tearoff.md §5): released outside every target and window → a NEW
 * window at the cursor (`tearOffIfReleasedOutside`); dropped on ANOTHER IDE window → the receiver
 * asks the source to `give` it (`takeForeignDrop`). Works from detached windows too. */

import { useAppStore } from "../store";
import type { TabId } from "../types";
import { canTearOff } from "./contract";
import { probeRelease, releasedOutside } from "./geometry";
import { moveTabToNewWindow } from "./handoff";
import { tearoffSend } from "./ipc";
import { currentWindowLabel, isMainWindow } from "./windowRole";

/** May `tabId` start its own window? Not as the only tab of a detached window (it has one). */
export function canStartWindow(tabId: TabId): boolean {
  const tabs = useAppStore.getState().tabs;
  if (!canTearOff(tabs[tabId])) return false;
  return isMainWindow() || Object.keys(tabs).length > 1;
}

/** At `dragend`: if released outside this window with no taker, open the tab in a new window
 * there; resolves whether it did. Every doubt resolves false (the menu command remains). */
export async function tearOffIfReleasedOutside(tabId: TabId): Promise<boolean> {
  if (!canStartWindow(tabId)) return false;
  const probe = await probeRelease();
  if (!probe?.cursor || !releasedOutside(probe)) return false;
  return moveTabToNewWindow(tabId, probe.cursor);
}

/** At `drop`: a tab from ANOTHER window (`sourceWindow` label off the drag data; empty or own =
 * ours) is asked for via `give` and the drop reported handled; `false` lets the caller go on. */
export function takeForeignDrop(rawTabId: string, sourceWindow: string): boolean {
  const here = currentWindowLabel();
  if (!rawTabId || !sourceWindow || sourceWindow === here) return false;
  void tearoffSend(sourceWindow, { t: "give", tabId: rawTabId, to: here }).catch(() => undefined);
  return true;
}
