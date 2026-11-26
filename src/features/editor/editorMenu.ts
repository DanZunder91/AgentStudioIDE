/** Items for the editor's right-click menu (CodeEditor owns the handler and mounting). Clipboard
 * paths never throw; Cut deletes only after the copy resolves, so a failed write loses nothing. */

import type { EditorView } from "@codemirror/view";

import type { ContextMenuItem } from "../../components/ContextMenu";
import { openFindPanel } from "./find/bufferSearch";

/** What the menu needs to know about the editor it was opened over. */
export interface EditorMenuContext {
  /** The CM6 view behind the tab, or null if it has not been created yet. */
  view: EditorView | null;
  /** False for read-only buffers (oversized/binary-gated) — no Cut/Paste. */
  editable: boolean;
  /** Whether the blame gutter is currently on — flips the toggle's label. */
  blameOn: boolean;
  /** Flip the blame toggle (the same state the header button used to drive). */
  onToggleBlame: () => void;
}

/** Best-effort swallow — a clipboard failure must never throw out of a click. */
const noop = (): void => {};

/** Copy the selection to the system clipboard; focus goes back to the editor. */
function copySelection(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(view.state.sliceDoc(from, to)).catch(noop);
  }
  view.focus();
}

/** Copy, then delete the selection — but only once the copy has SUCCEEDED. */
function cutSelection(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (navigator.clipboard) {
    void navigator.clipboard
      .writeText(view.state.sliceDoc(from, to))
      .then(() => view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } }))
      .catch(noop);
  }
  view.focus();
}

/** Replace the selection with the clipboard text (read at resolve time). */
function pasteClipboard(view: EditorView): void {
  if (navigator.clipboard) {
    void navigator.clipboard
      .readText()
      .then((text) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
      })
      .catch(noop);
  }
  view.focus();
}

/** Disabled items never fire `onSelect`, and every view-needing item is disabled while `view` is
 * null, so the `view!` assertions in the handlers are safe. */
export function buildEditorMenu({
  view,
  editable,
  blameOn,
  onToggleBlame,
}: EditorMenuContext): ContextMenuItem[] {
  const noSelection = view === null || view.state.selection.main.empty;
  return [
    { label: "Copy", disabled: noSelection, onSelect: () => copySelection(view!) },
    { label: "Cut", disabled: noSelection || !editable, onSelect: () => cutSelection(view!) },
    { label: "Paste", disabled: view === null || !editable, onSelect: () => pasteClipboard(view!) },
    { separator: true },
    { label: "Find in file…", disabled: view === null, onSelect: () => void openFindPanel(view!) },
    { separator: true },
    {
      label: blameOn ? "Hide Git Blame" : "Annotate with Git Blame",
      onSelect: onToggleBlame,
    },
  ];
}
