/** Tab tear-off public surface (docs/design/tab-tearoff.md): moves and gesture for components,
 * boot for `main.tsx`; the mailbox and registry hand-off calls stay inside this folder. */

export { canTearOff, tabKey, TEAROFF_KINDS } from "./contract";
export type { EditorBuffer, Mail, ScreenPoint, TornTab } from "./contract";
export { moveTabToMainWindow, moveTabToNewWindow } from "./handoff";
export { canStartWindow, takeForeignDrop, tearOffIfReleasedOutside } from "./gesture";
export { startTearoffHost, startTearoffWindow } from "./boot";
export { currentWindowLabel, isMainWindow, MAIN_WINDOW } from "./windowRole";
