/** Public surface of the workspace feature (ARCHITECTURE §4). `<WorkspaceTree/>` subscribes to
 * `workspaceRoots` itself; the IPC wrapper is exported for the bridge and tests. */

export { WorkspaceTree } from "./WorkspaceTree";
export { RailTabs } from "./RailTabs";
export { readDir, readFile, writeFile } from "./workspaceIpc";
