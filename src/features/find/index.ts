/** Find feature surface. Both overlays are self-contained: mount once (App.tsx) and they install
 * their own toggles. */

export { FindInFiles } from "./FindInFiles";
export { FindFiles, OPEN_FIND_FILES_EVENT } from "./FindFiles";
export { findInFiles, findFiles, cancelFind, newSearchId } from "./findIpc";
export type { FindOptions, FindMatch, FindResult } from "./findIpc";
export type { FindFilesOptions, FindFileHit, FindFilesResult } from "./findIpc";
