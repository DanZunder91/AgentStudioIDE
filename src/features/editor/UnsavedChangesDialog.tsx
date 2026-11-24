/**
 * UnsavedChangesDialog — the confirm shown when a DIRTY editor tab is closed
 * (M4). Mounted once at the app root; it reads `confirmCloseTab` from the
 * store and offers Save / Discard / Cancel so a user never loses edits by
 * accident. Nothing renders while no dirty close is pending.
 */

import { useAppStore } from "../../app/store";
import { save } from "./EditorRegistry";

export function UnsavedChangesDialog(): React.JSX.Element | null {
  const path = useAppStore((s) => {
    const tabId = s.confirmCloseTab;
    if (!tabId) return null;
    const tab = s.tabs[tabId];
    return tab && tab.ref.kind === "editor" ? tab.ref.path : null;
  });
  const cancelCloseTab = useAppStore((s) => s.editorActions.cancelCloseTab);
  const closePendingTab = useAppStore((s) => s.editorActions.closePendingTab);

  if (!path) return null;

  const name = fileName(path);

  const onSave = async () => {
    // Save first; only close if it succeeds, so a failed write keeps the tab
    // (and its edits) with the error visible in the editor.
    if (await save(path)) closePendingTab();
    else cancelCloseTab();
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Unsaved changes">
        <p className="dialog__message">
          Discard unsaved changes to <strong>{name}</strong>?
        </p>
        <div className="dialog__actions">
          <button type="button" className="dialog__btn" onClick={() => void onSave()}>
            Save
          </button>
          <button
            type="button"
            className="dialog__btn dialog__btn--danger"
            onClick={closePendingTab}
          >
            Discard
          </button>
          <button type="button" className="dialog__btn" onClick={cancelCloseTab}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}
