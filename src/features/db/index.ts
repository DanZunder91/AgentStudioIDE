/** Public surface for code outside the feature; `engineFields` stays private to the dialog. */

export { DbPanel } from "./DbPanel";
export { ConnectionDialog } from "./ConnectionDialog";
// The console TAB (the container), not `DbConsole` itself: `Pane` mounts a tab and must not
// have to know the presentational component or assemble its fifteen props.
export { DbConsoleTab } from "./console/DbConsoleTab";
export * from "./dbIpc";
export * from "./dbErrors";
export type * from "./types";
