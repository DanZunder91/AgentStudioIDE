/** A transparent textarea over a highlighted <pre>; both need identical text metrics (api.css).
 * Undo is store-backed (`bodyHistory`): Pane unmounts inactive tabs and programmatic rewrites drop
 * the native undo stack, so Cmd/Ctrl+Z is handled here and preventDefaulted. */

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

  /** Same chords as CodeMirror's historyKeymap, so the app's editors agree on Cmd+Z. */
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
