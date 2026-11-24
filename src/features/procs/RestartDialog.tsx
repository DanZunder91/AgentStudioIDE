/**
 * RestartDialog — the confirm in front of "Restart in the IDE". It SIGTERMs a process the
 * user started somewhere else, so it follows the
 * house destructive-confirm contract of `CloseTerminalDialog` exactly:
 *
 * - `role="alertdialog"`, labelled by its heading, described by its question.
 * - It NAMES what is at stake — pid, name, command (already masked by Rust), cwd — never a bare
 *   "Are you sure?" (CloseTerminalDialog §1).
 * - **Cancel holds initial focus**, so a reflexive Enter cancels; Enter is NOT intercepted, so a
 *   user who Tabs to the destructive button can press it. Escape and a backdrop
 *   click cancel. Tab is trapped inside; focus returns to the opener on close.
 * - While the restart runs, both buttons are disabled and Escape does nothing (the store refuses
 *   to cancel a running restart — it may already have sent the signal).
 *
 * `capture` (the capture guard): the same confirm for an IDE app started
 * without the IDE's proxy — "Restart with capture". Same two steps in Rust; the new terminal
 * gets the IDE's proxy env on top of the app's own, so its calls show in Network.
 */

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
