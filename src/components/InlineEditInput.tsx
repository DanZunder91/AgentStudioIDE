/** One-line rename field (tabs, agent rows): prefilled and selected; Enter/blur commits (empty is
 * the caller's call), Esc cancels; events never propagate. `resolvedRef` guards the unmount-blur
 * React fires after Enter/Esc, which would otherwise undo a cancel with a commit. */

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
