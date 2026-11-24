/**
 * Tab tear-off — public surface (docs/design/tab-tearoff.md).
 *
 * Components use the moves and the gesture; `main.tsx` uses the boot functions; nothing
 * outside this folder needs the mailbox or the registries' hand-off calls directly.
 */

export { canTearOff, tabKey, TEAROFF_KINDS } from "./contract";
export type { EditorBuffer, Mail, ScreenPoint, TornTab } from "./contract";
export { moveTabToMainWindow, moveTabToNewWindow } from "./handoff";
export { canStartWindow, takeForeignDrop, tearOffIfReleasedOutside } from "./gesture";
export { startTearoffHost, startTearoffWindow } from "./boot";
export { currentWindowLabel, isMainWindow, MAIN_WINDOW } from "./windowRole";
