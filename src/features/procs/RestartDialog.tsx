/** Confirm before Restart in the IDE (it SIGTERMs a process started elsewhere), following
 * `CloseTerminalDialog`'s destructive-confirm contract. Busy: buttons disabled, Escape ignored
 * (the signal may be sent). `capture`: same flow, and the new terminal gets the proxy env. */

import { useEffect, useRef } from "react";

import { tabWrapTarget } from "../db/engineFields";

import { commandLine } from "./procsFormat";
import type { DevApp } from "./procsTypes";

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

export const RESTART_QUESTION =
  "Stop it and run the same command in an IDE terminal? Its console and HTTP calls will then show here.";

export const CAPTURE_RESTART_QUESTION =
  "Stop it and run the same command in an IDE terminal with capture on? Its HTTP calls will then show in Network.";

export function RestartDialog({
  app,
  running,
  onCancel,
  onConfirm,
  capture = false,
}: {
  app: DevApp;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Restart with capture: an IDE app started without the IDE's proxy. */
  capture?: boolean;
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Read the opener BEFORE moving focus, in one effect (CloseTerminalDialog's reasoning).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    cancelRef.current!.focus();
    return () => opener.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
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

  const titleId = `procs-restart-title-${app.key}`;
  const bodyId = `procs-restart-body-${app.key}`;
  return (
    <div className="procs-overlay" data-testid="procs-restart-backdrop" onClick={onCancel}>
      <div
        className="procs-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="procs-restart-dialog"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="procs-dialog__title" id={titleId}>
          {capture ? `Restart ${app.name} with capture?` : `Restart ${app.name} in the IDE?`}
        </h2>
        <p className="procs-dialog__message" id={bodyId}>
          {capture ? CAPTURE_RESTART_QUESTION : RESTART_QUESTION}
        </p>
        <dl className="procs-dialog__facts">
          <dt>pid</dt>
          <dd data-testid="procs-restart-pid">{app.pid}</dd>
          <dt>name</dt>
          <dd>{app.name}</dd>
          <dt>command</dt>
          <dd className="procs-dialog__cmd" data-testid="procs-restart-cmd">
            {commandLine(app.argv)}
          </dd>
          <dt>cwd</dt>
          <dd data-testid="procs-restart-cwd">{app.cwd ?? "unknown"}</dd>
        </dl>
        <div className="procs-dialog__actions">
          <button
            type="button"
            ref={cancelRef}
            className="procs-dialog__btn"
            data-testid="procs-restart-cancel"
            disabled={running}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="procs-dialog__btn procs-dialog__btn--danger"
            data-testid="procs-restart-confirm"
            disabled={running}
            onClick={onConfirm}
          >
            {running ? "Restarting…" : "Stop and restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
