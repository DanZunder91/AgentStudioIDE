/** Shown while `saveRequestPrompt` is set: Cmd/Ctrl+S on a tab that still has the DEFAULT title
 * (a renamed tab saves straight to Collections). Reuses the .dialog chrome from App.css. */

import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";

/** Mounts the form only while a prompt is pending, so `name` resets on each open with no effect. */
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
