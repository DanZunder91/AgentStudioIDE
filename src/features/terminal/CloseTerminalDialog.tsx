/** Renders `pendingTerminalClose`, resolved only via `cancelTerminalClose`/`proceedTerminalClose`:
 * it never touches a terminal (one close path). Escape/backdrop cancel; Enter is not intercepted,
 * Cancel holds initial focus (safe by focus, not a broken key). No "don't ask again", by design. */

import { useEffect, useRef } from "react";

import { useAppStore } from "../../app/store";
// Shared Tab-wrap helper (no database semantics), imported as `ExportDialog` does: two
// dialogs that trap focus differently is a bug.
import { tabWrapTarget } from "../db/engineFields";
import "./closeTerminalDialog.css";
import type { BusyTerminal } from "./terminalBusyIpc";

/** Focusable descendants, in DOM order, minus the disabled ones. The house set. */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

const TITLE_ID = "close-terminal-title";
const BODY_ID = "close-terminal-body";

/** No props on purpose: the pending record is the single source of truth. */
export function CloseTerminalDialog(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.pendingTerminalClose);
  const cancel = useAppStore((s) => s.layoutActions.cancelTerminalClose);
  const proceed = useAppStore((s) => s.layoutActions.proceedTerminalClose);

  if (pending === null) return null;

  // The confirm is MOUNTED only while a close is pending, which is what makes
  // "focus in on open" and "focus back on close" plain mount/unmount effects
  // rather than a state machine (`ConnectionDialog`'s shell, same reason).
  return (
    <CloseTerminalConfirm
      terminals={pending.terminals}
      onCancel={cancel}
      onProceed={proceed}
    />
  );
}

interface ConfirmProps {
  /** As the backend reported them at the click; never empty in practice (the store holds a
   * gesture only when one is busy), so there is no empty arm. */
  terminals: BusyTerminal[];
  onCancel: () => void;
  onProceed: () => void;
}

function CloseTerminalConfirm({
  terminals,
  onCancel,
  onProceed,
}: ConfirmProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // One effect, in this order: read the opener before moving focus (effects run child-first, so
  // an `autoFocus` would steal `activeElement` first and restore would target `<body>`).
  useEffect(() => {
    // `document.activeElement` is `<body>` when nothing has focus — it is null
    // only in a document without one, which this app and jsdom never have. No
    // defensive branch to leave uncovered; `<body>.focus()` is a harmless no-op.
    const opener = document.activeElement as HTMLElement;
    // Cancel is the default focus, so a reflex Enter or Space keeps every terminal alive.
    // The button is mounted for this effect's lifetime, so the ref is non-null.
    cancelRef.current!.focus();
    return () => opener.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Escape always cancels. Enter is deliberately not handled: Cancel holding focus makes the
    // reflex safe, and intercepting it would make `Close anyway` keyboard-unreachable.
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const target = tabWrapTarget(nodes, document.activeElement, e.shiftKey);
    if (target !== null) {
      e.preventDefault();
      target.focus();
    }
  };

  const many = terminals.length > 1;

  return (
    // Backdrop click = Cancel, with the inside click stopped rather than
    // compared against `currentTarget` — the `ShortcutsPanel` idiom, and one
    // fewer branch for the same behaviour.
    <div
      className="close-terminal-overlay"
      data-testid="close-terminal-backdrop"
      onClick={onCancel}
    >
      <div
        className="close-terminal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={BODY_ID}
        data-testid="close-terminal-dialog"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="close-terminal-dialog__title" id={TITLE_ID}>
          {many ? `Close ${terminals.length} terminals?` : "Close this terminal?"}
        </h2>

        {many ? (
          <>
            <p className="close-terminal-dialog__message" id={BODY_ID}>
              These {terminals.length} terminals are still working. Closing them stops
              everything running in them, and anything they have not finished is lost.
            </p>
            <ul className="close-terminal-dialog__list" data-testid="close-terminal-list">
              {terminals.map((t) => (
                <li key={t.id}>
                  <BusyLine terminal={t} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="close-terminal-dialog__message" id={BODY_ID}>
            <BusyLine terminal={terminals[0]} /> Closing this terminal stops it, and
            anything it has not finished is lost.
          </p>
        )}

        <div className="close-terminal-dialog__actions">
          <button
            type="button"
            ref={cancelRef}
            className="close-terminal-dialog__btn"
            data-testid="close-terminal-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="close-terminal-dialog__btn close-terminal-dialog__btn--danger"
            data-testid="close-terminal-proceed"
            onClick={onProceed}
          >
            Close anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** Label first (what the user recognises); `reason` picks the predicate. */
function BusyLine({ terminal }: { terminal: BusyTerminal }): React.JSX.Element {
  return terminal.reason === "agent" ? (
    <>
      <strong>{terminal.label}</strong> is running a Claude session.
    </>
  ) : (
    <>
      <strong>{terminal.label}</strong> has a command still running.
    </>
  );
}
