/**
 * Public surface of the git feature (App.tsx imports the barrel,
 * never a deep path). Kept narrow on purpose — the panel, plus the polling
 * starter and the tree-decoration selectors the workspace feature consumes.
 */
export { GitPanel } from "./GitPanel";
export { useGitStore, startGitPolling, fileStatusMap, dirsWithChanges } from "./gitStore";
export type { GitChange, PullRequest, RootGitState, RootPrState } from "./gitStore";
// The compare/revert pair (Git compare and Git revert in the file tree's
// right-click menu). `<DiffView>` is what `<Pane>` renders for a
// `diff` tab; `gitFileRestore` is what the tree calls once its confirm is
// answered. `FileDiff` is the wire shape both sides read.
export { DiffView } from "./DiffView";
export { gitFileDiff, gitFileRestore } from "./gitIpc";
export type { FileDiff } from "./gitIpc";
