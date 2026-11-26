/** The git feature's narrow public surface; import the barrel, never a deep path. */
export { GitPanel } from "./GitPanel";
export { useGitStore, startGitPolling, fileStatusMap, dirsWithChanges } from "./gitStore";
export type { GitChange, PullRequest, RootGitState, RootPrState } from "./gitStore";
// Compare/revert for the tree's Git menu: `<Pane>` renders `<DiffView>`; the tree calls
// `gitFileRestore` after its confirm.
export { DiffView } from "./DiffView";
export { gitFileDiff, gitFileRestore } from "./gitIpc";
export type { FileDiff } from "./gitIpc";
