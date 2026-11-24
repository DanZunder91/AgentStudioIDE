/**
 * Public surface of the workspace feature (ARCHITECTURE §4).
 *
 * Mount `<WorkspaceTree/>` in the right rail; it self-subscribes to the store
 * for its multi-root set (the `workspaceRoots` union of agent folders + browse
 * roots). The IPC wrapper is exported for the bridge and for tests.
 */

export { WorkspaceTree } from "./WorkspaceTree";
export { RailTabs } from "./RailTabs";
export { readDir, readFile, writeFile } from "./workspaceIpc";
