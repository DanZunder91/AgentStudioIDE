/** Public surface of the editor feature; `<CodeEditor path/>` is what `<Pane>` renders. */

export { CodeEditor } from "./CodeEditor";
export { ReferencesPanel } from "./ReferencesPanel";
export { UnsavedChangesDialog } from "./UnsavedChangesDialog";
export { languageToShiki } from "./grammar";
// The reusable "open a file at a location" seam — imported by the Find panel.
export { revealInEditor } from "./reveal";
// A background tab has no mounted <CodeEditor> to detach, so the store's close paths must call
// this, or the orphaned buffer stops a reopen from loading. Same reason as the terminal's dispose.
export { dispose as disposeEditorBuffer } from "./EditorRegistry";
// For Git's revert: reloads as a normal transaction, so Cmd/Ctrl+Z can take the edits back.
export { reloadFromDisk } from "./EditorRegistry";
// The file tree asks the same predicate as the preview mount; `previewKinds.ts` stays the only
// authority.
export { opensInExternalBrowser } from "./previewKinds";
