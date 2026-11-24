/**
 * Public surface of the editor feature (M4).
 *
 * `<CodeEditor path/>` is what `<Pane>` renders for an `editor` tab. The Shiki
 * highlighter + grammar map are exported for tests and future consumers.
 */

export { CodeEditor } from "./CodeEditor";
export { ReferencesPanel } from "./ReferencesPanel";
export { UnsavedChangesDialog } from "./UnsavedChangesDialog";
export { languageToShiki } from "./grammar";
// The reusable "open a file at a location" seam — imported by the Find panel.
export { revealInEditor } from "./reveal";
// The registry's dispose, for the store's close paths (closeTab/closePane): a
// tab that is not its pane's ACTIVE tab has no mounted <CodeEditor>, so no
// detach ever fires for it — without this call its CM6 buffer would outlive the
// tab, and reopening the path would find the orphan and never load (the
// eternal-"Loading…" bug). The terminal feature exports `dispose` for the same
// reason.
export { dispose as disposeEditorBuffer } from "./EditorRegistry";
// After a confirmed `Git ▸ Revert changes…` the file on disk no longer
// matches the open buffer. The Git feature calls this so the tab stops showing what
// the user just discarded — and, because it lands as a normal transaction, so
// Cmd/Ctrl+Z can still take those edits back.
export { reloadFromDisk } from "./EditorRegistry";
// "Open in Browser": the file tree asks the SAME predicate the preview mount
// asks, so a file that renders as a page in the app is exactly a file the menu
// offers to a browser. Exported here rather than deep-imported —
// `previewKinds.ts` is the single authority and must stay the only one.
export { opensInExternalBrowser } from "./previewKinds";
