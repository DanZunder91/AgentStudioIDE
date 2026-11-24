/**
 * Public surface of the find feature.
 *
 * `<FindInFiles/>` (Cmd/Ctrl+Shift+F, content search) and `<FindFiles/>`
 * (Cmd/Ctrl+Shift+O, filename finder) are each self-contained: mount them once
 * (App.tsx) and they install their own toggle. The IPC wrappers + wire types are
 * exported for the bridge and for tests.
 */

export { FindInFiles } from "./FindInFiles";
export { FindFiles, OPEN_FIND_FILES_EVENT } from "./FindFiles";
export { findInFiles, findFiles, cancelFind, newSearchId } from "./findIpc";
export type { FindOptions, FindMatch, FindResult } from "./findIpc";
export type { FindFilesOptions, FindFileHit, FindFilesResult } from "./findIpc";
