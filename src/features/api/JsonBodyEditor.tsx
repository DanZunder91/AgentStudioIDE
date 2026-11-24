/**
 * JsonBodyEditor — an editable request-body field that LOOKS like JSON (the body
 * should look like JSON as well as the response). A transparent `<textarea>` sits over a colored
 * `<pre>` that highlights the same text (the react-simple-code-editor technique) —
 * so it stays fully editable while showing JSON syntax colors, with no new dependency
 * and no CodeMirror instance to manage.
 *
 * 🔴 **Undo is store-backed, not the browser's** (the bug: a change to the
 * request body could not be undone with Command+Z after switching to
 * another window or executing the request). This is a CONTROLLED textarea, and
 * `Pane` unmounts an inactive tab — so switching tabs destroys the node and the
 * native undo stack with it, and a programmatic rewrite (Format, a pasted curl)
 * makes the browser drop it too. Cmd/Ctrl+Z is therefore handled here and served
 * from `bodyHistory` in the store, which outlives both. `preventDefault` stops
 * the browser's own (now empty) undo from also firing.
 *
 * Correctness of the overlay depends on the `<pre>` and `<textarea>` sharing IDENTICAL
 * text metrics (font, size, line-height, padding, wrapping) — both carry `.api-body`
 * + `.json-editor__layer` (see api.css). Scroll is mirrored so the highlight tracks
 * the textarea. Colors reuse the JsonView palette (`jsonview__*`).
 */

import { useRef } from "react";

import { highlightJson } from "./highlightJson";
import "./jsonview.css";

export function JsonBodyEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  onKeyDown,
  onUndo,
  onRedo,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Cmd/Ctrl+Z. Omitted where there is no history to step through. */
  onUndo?: () => void;
  /** Cmd/Ctrl+Shift+Z, and Ctrl+Y off the Mac. */
  onRedo?: () => void;
}): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);

  /**
   * Undo/redo first, then whatever the caller wanted.
   *
   * Matched on `key` and the platform modifier only — the same chords
   * `historyKeymap` binds in the CodeMirror surfaces, so the two editors in this
   * app do not disagree about what Cmd+Z means.
   */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === "z") {
      e.preventDefault();
      if (e.shiftKey) onRedo?.();
      else onUndo?.();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === "y") {
      e.preventDefault();
      onRedo?.();
      return;
    }
    onKeyDown?.(e);
  };

  // Mirror the textarea's scroll onto the highlight layer so they stay aligned.
  const syncScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (pre) {
      pre.scrollTop = e.currentTarget.scrollTop;
      pre.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  const tokens = highlightJson(value);

  return (
    <div className="json-editor">
      <pre
        className="api-body json-editor__layer json-editor__highlight"
        aria-hidden="true"
        ref={preRef}
        data-testid="json-editor-highlight"
      >
        {tokens.map((t, i) =>
          t.cls ? (
            <span key={i} className={t.cls}>
              {t.text}
            </span>
          ) : (
            <span key={i}>{t.text}</span>
          ),
        )}
        {/* A trailing newline keeps the last line + caret from clipping. */}
        {"\n"}
      </pre>
      <textarea
        className="api-body json-editor__layer json-editor__input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
