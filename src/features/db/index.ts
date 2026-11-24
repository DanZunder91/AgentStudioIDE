/**
 * The database client's public surface.
 *
 * A barrel for the same reason `features/api/index.ts` is one: `App.tsx` mounts the rail
 * panel and should not have to know which file inside the feature it lives in. Deliberately
 * NARROW — only what something outside `features/db/**` legitimately needs.
 *
 * `dbIpc` and `dbErrors` are re-exported because the STORE imports them (the db slice's
 * actions are the IPC's only caller), and `types.ts` because everything speaks its shapes.
 * `engineFields` is not here: it is the dialog's private logic, and its 40-odd exports on a
 * barrel would invite the rest of the app to reach into it.
 */

export { DbPanel } from "./DbPanel";
export { ConnectionDialog } from "./ConnectionDialog";
// The console TAB (the container), not `DbConsole` itself: `Pane` mounts a tab and must not
// have to know the presentational component or assemble its fifteen props.
export { DbConsoleTab } from "./console/DbConsoleTab";
export * from "./dbIpc";
export * from "./dbErrors";
export type * from "./types";
