/**
 * InlineEditInput — a one-line rename field, shared by tab labels and agent rows.
 *
 * Rendered in place of a label while editing. Contract:
 *   - prefilled with the current display name, text pre-selected
 *   - Enter or blur → `onCommit(value)`   (empty clears — the caller decides)
 *   - Esc → `onCancel()`, no save
 *
 * All pointer/key events are stopped from propagating, so typing, clicking, or
 * pressing Enter/Esc inside the field never selects a row, activates/closes a
 * tab, or starts a drag — the same discipline the disclosure caret uses.
 *
 * `resolvedRef` guards the Enter/Esc→unmount→blur race: React fires `blur` when
 * a focused input unmounts, so without the flag an Esc-cancel would be followed
 * by a blur-commit and the cancel would be silently undone.
 */

import { useCallback, useRef, useState, type KeyboardEvent } from "react";

export interface InlineEditInputProps {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
  ariaLabel: string;
}

export function InlineEditInput({ value, onCommit, onCancel, className, ariaLabel }: InlineEditInputProps) {
  const [draft, setDraft] = useState(value);
  const resolved = useRef(false);

  // Callback ref: focus + pre-select on mount (el set), no-op on unmount (null).
  const focusRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = () => {
    if (resolved.current) return;
    resolved.current = true;
    onCommit(draft);
  };

  const cancel = () => {
    if (resolved.current) return;
    resolved.current = true;
    onCancel();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <input
      ref={focusRef}
      type="text"
      className={className}
      aria-label={ariaLabel}
      value={draft}
      draggable={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      // Keep the parent (row select / tab activate / drag) out of it: a click or
      // mousedown inside the field must not select a row or start a tab drag.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
