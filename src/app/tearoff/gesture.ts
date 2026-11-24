/**
 * The drag half of tear-off (docs/design/tab-tearoff.md §5) — the two things a tab drag
 * can do across windows:
 *
 *  - **released outside every window's drop target, and outside its own window** → it opens
 *    in a NEW window at the cursor (`tearOffIfReleasedOutside`, from the tab's `dragend`);
 *  - **dropped on ANOTHER IDE window** → it moves into that window (`takeForeignDrop`, from
 *    the receiving strip's or pane's `drop`). The receiver cannot describe a tab that lives
 *    in another realm, so it asks the source to give it over (`give` mail).
 *
 * The same gesture works from a detached window, so a tab can be dragged back home — the
 * merge-back WezTerm still has open as an issue (§6) — or out into yet another window.
 */

import { useAppStore } from "../store";
import type { TabId } from "../types";
import { canTearOff } from "./contract";
import { probeRelease, releasedOutside } from "./geometry";
import { moveTabToNewWindow } from "./handoff";
import { tearoffSend } from "./ipc";
import { currentWindowLabel, isMainWindow } from "./windowRole";

/**
 * May `tabId` start a window of its own from here? Not when it is the only tab of a
 * detached window — it already has one, and tearing it off would only swap one window for
 * another.
 */
export function canStartWindow(tabId: TabId): boolean {
  const tabs = useAppStore.getState().tabs;
  if (!canTearOff(tabs[tabId])) return false;
  return isMainWindow() || Object.keys(tabs).length > 1;
}

/**
 * At `dragend`: if the drag ended outside this window (and no drop target took it), open
 * the tab in a new window where it was released. Resolves whether it did. Every doubt —
 * an unreadable cursor, Wayland's `(0, 0)` — resolves false, and the menu command remains.
 */
export async function tearOffIfReleasedOutside(tabId: TabId): Promise<boolean> {
  if (!canStartWindow(tabId)) return false;
  const probe = await probeRelease();
  if (!probe?.cursor || !releasedOutside(probe)) return false;
  return moveTabToNewWindow(tabId, probe.cursor);
}

/**
 * At `drop`: was this a tab from ANOTHER window? Then ask that window to give it here and
 * report the drop as handled; `false` means it is one of ours and the caller carries on.
 * `rawTabId` is the source window's tab id, `sourceWindow` its label (both off the drag's
 * data); an empty or own label is ours.
 */
export function takeForeignDrop(rawTabId: string, sourceWindow: string): boolean {
  const here = currentWindowLabel();
  if (!rawTabId || !sourceWindow || sourceWindow === here) return false;
  void tearoffSend(sourceWindow, { t: "give", tabId: rawTabId, to: here }).catch(() => undefined);
  return true;
}
