/**
 * SaveRequestDialog — the "name this request" modal. Mounted once at the
 * app root; renders only while `saveRequestPrompt` is set, which Cmd/Ctrl+S does when
 * the active API-request tab still carries the DEFAULT title (a renamed tab saves
 * straight to Collections with no prompt). The user types a name → the request lands
 * in Collections and the tab is retitled to match.
 *
 * Reuses the shared `.dialog-overlay` / `.dialog` chrome (App.css) so it matches the
 * unsaved-changes confirm. Enter confirms, Esc cancels; confirm is disabled until the
 * name is non-empty (the store guards this too — belt and braces).
 */

import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";

/**
 * The outer gate: mounts the inner form only while a prompt is pending. Because the
 * form unmounts on close, its `name` state resets to empty for free on the next open
 * — no setState-in-effect needed to clear a stale name.
 */
export function SaveRequestDialog(): React.JSX.Element | null {
  const open = useAppStore((s) => s.saveRequestPrompt !== null);
  return open ? <SaveRequestForm /> : null;
}

function SaveRequestForm(): React.JSX.Element {
  const confirmSaveRequestName = useAppStore(
    (s) => s.apiActions.confirmSaveRequestName,
  );
  const cancelSaveRequestName = useAppStore(
    (s) => s.apiActions.cancelSaveRequestName,
  );

  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on open (a DOM side effect, not state). The field starts empty
  // because this component mounts fresh each time the dialog opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const confirm = () => {
    if (trimmed) confirmSaveRequestName(trimmed);
  };

  return (
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save request"
        data-testid="save-request-dialog"
      >
        <p className="dialog__message">Save this request to Collections as:</p>
        <input
          ref={inputRef}
          type="text"
          className="api-save-name"
          aria-label="Request name"
          placeholder="Name this request"
          data-testid="save-request-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelSaveRequestName();
            }
          }}
        />
        <div className="dialog__actions">
          <button
            type="button"
            className="dialog__btn"
            data-testid="save-request-confirm"
            disabled={trimmed === ""}
            onClick={confirm}
          >
            Save
          </button>
          <button
            type="button"
            className="dialog__btn"
            data-testid="save-request-cancel"
            onClick={cancelSaveRequestName}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
