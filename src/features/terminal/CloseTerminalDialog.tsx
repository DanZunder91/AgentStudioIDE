/**
 * CloseTerminalDialog — the confirm in front of a close that would kill a
 * terminal which is still doing something.
 *
 * A stray tab close can lose a running session, so a terminal that is running
 * claude asks for confirmation before it is closed.
 *
 * ── What this component is, exactly ──────────────────────────────────────────
 * The whole decision already lives in the store: `requestCloseTab`,
 * `requestClosePane` and `requestDismissAgent` ask the backend which terminals
 * are busy (`terminalsBusy`) and, if any are, park the gesture in
 * `pendingTerminalClose` instead of carrying it out. This file renders that
 * record and resolves it through exactly two actions —
 * `cancelTerminalClose()` (dismiss, kill nothing) and `proceedTerminalClose()`
 * (replay the held close). It decides nothing else, and it never touches a
 * terminal directly: a dialog that could kill a PTY would be a second close
 * path, and the reason the gate is a *wrapper* over the primitives is that
 * there must only ever be one.
 *
 * Absence IS "nothing pending" — no `open` flag, no tombstone. Mounted once at
 * the app root; renders `null` whenever `pendingTerminalClose` is `null`.
 *
 * ── 1. It names what is at stake, it does not just scare ─────────────────────
 * "Are you sure?" with no object is a dialog people learn to dismiss without
 * reading, and once they have learned that, this gate is worse than nothing —
 * it costs a click and prevents nothing. So the busy terminals are listed by
 * `label` (the agent's name, or the terminal's title) and the wording comes
 * from `reason`: `"agent"` says a Claude session is running, `"command"` says a
 * command is. Those are two genuinely different losses — an agent session is
 * work you cannot re-run for free; a command is usually a build you can start
 * again — and a user who can tell them apart can answer honestly.
 *
 * ── 2. ONE dialog, never a queue ─────────────────────────────────────────────
 * A pane ✕ kills every terminal in the pane in one click, which is why the
 * store models `terminals` as an ARRAY snapshotted at the moment of the
 * gesture. One terminal reads as a sentence; several read as a list. Asking N
 * times for one gesture would be the reflex-training failure above, in its
 * purest form.
 *
 * ── 3. The safe default comes from WHERE FOCUS STARTS ────────────────────────
 * 🔴 Escape always cancels — never the destructive path; that is not negotiable
 * in a confirm. A backdrop click is Cancel too, for the same reason.
 *
 * **Enter is left alone.** It does what Enter does everywhere: activates the
 * control that has focus. The safety property is that **Cancel holds initial
 * focus**, so hitting Enter the instant this appears — the cheap reflex, the
 * whole thing this gate is guarding against — cancels. A user who has
 * deliberately Tabbed to *Close anyway* and pressed Enter meant it, and gets it.
 *
 * This was briefly built the other way (Enter `preventDefault`ed dialog-wide so
 * it always cancelled) and that is the wrong track, recorded here so it is not
 * re-introduced: it makes the destructive button unactivatable from the
 * keyboard, which is a worse accessibility failure than the reflex it prevents.
 * Safety belongs in the default focus, not in breaking a standard key.
 *
 * ── 4. No "don't ask again" checkbox, and that is a decision ─────────────────
 * There is no `localStorage` anywhere in this app (config lives in the app
 * config dir, written by Rust), so a "don't ask again" box is not a checkbox —
 * it is a new persisted `layout-prefs.json` field, its migration, and a
 * settings surface to turn it back on once someone regrets it. That is its own
 * feature, not a corner of this one. Recorded here so its absence reads as a
 * choice rather than as an oversight.
 *
 * ── Accessibility ────────────────────────────────────────────────────────────
 * `role="alertdialog"` (not `dialog`): this interrupts a gesture already in
 * flight and the consequence is destructive, which is exactly what that role
 * is for. Labelled by its heading, described by its body, focus moved to Cancel
 * on open, focus restored to whatever opened it on close, and Tab trapped
 * inside while it is up — the `ConnectionDialog` / `ExportDialog` contract.
 * (`UnsavedChangesDialog`, the older confirm this matches visually, has none of
 * that; it is the house *chrome* here, not the house behaviour.)
 */

import { useEffect, useRef } from "react";

import { useAppStore } from "../../app/store";
// A pure, already-tested Tab-wrap helper with no database semantics in it.
// Imported rather than reimplemented, exactly as `ExportDialog` does — two
// dialogs that trap focus differently in one app is a bug, not a style choice.
// It wants to live in a shared module; until one exists it is imported from
// here rather than duplicated.
import { tabWrapTarget } from "../db/engineFields";
import "./closeTerminalDialog.css";
import type { BusyTerminal } from "./terminalBusyIpc";

/** Focusable descendants, in DOM order, minus the disabled ones. The house set. */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

const TITLE_ID = "close-terminal-title";
const BODY_ID = "close-terminal-body";

/**
 * The store-bound mount point. Takes no props on purpose: the pending record is
 * the single source of truth, so there is nothing for a caller to get wrong (or
 * to keep in sync). The app shell mounts exactly `<CloseTerminalDialog />`.
 */
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
  /**
   * The busy terminals this close would kill, as the backend reported them when
   * the user clicked. Never empty in practice — the store only holds a gesture
   * when at least one terminal came back busy — so there is no "nothing is
   * busy" arm here to leave uncovered (a guard you cannot falsify
   * is dead code). An empty array would simply render the plural shape with an
   * empty list; it kills nothing either way, because this component cannot.
   */
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

  // The whole focus contract, in one effect and in this order on purpose: the
  // opener has to be read BEFORE focus is moved, so the capture and the move
  // cannot be split across two effects (React runs effects child-first, so an
  // `autoFocus` on the button below would already have stolen `activeElement`
  // by the time this ran, and "restore" would hand focus back to a button that
  // no longer exists — i.e. to `<body>`).
  useEffect(() => {
    // `document.activeElement` is `<body>` when nothing has focus — it is null
    // only in a document without one, which this app and jsdom never have. No
    // defensive branch to leave uncovered; `<body>.focus()` is a harmless no-op.
    const opener = document.activeElement as HTMLElement;
    // Cancel is the default action, so it is also the default focus: whatever a
    // user does next by reflex — Enter, Space — keeps every terminal alive.
    // The button is mounted for this effect's whole lifetime, so the ref is
    // non-null (the `ContextMenu` idiom: no defensive branch left uncovered).
    cancelRef.current!.focus();
    return () => opener.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // 🔴 Escape cancels, always — it is never the destructive path.
    //
    // Enter is deliberately NOT handled here: it must keep activating whatever
    // has focus (§3 in the header). Cancel holding initial focus is what makes
    // the reflex safe; intercepting the key would only make `Close anyway`
    // unreachable from the keyboard.
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

/**
 * What one busy terminal is busy WITH, as a sentence. The label is the subject
 * so the user reads the thing they recognise first — the agent's name, or the
 * terminal's title — and `reason` picks the predicate. Shared by both shapes:
 * on its own it is the single-terminal sentence, and repeated it is the list.
 */
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
