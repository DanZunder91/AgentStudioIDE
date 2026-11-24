/**
 * PreviewFindBar — the find bar over the RENDERED Markdown preview (search must
 * work inside the rendered .md file, not only in its source).
 *
 * Deliberately shaped like `features/api/ResponseBody`'s bar — input, count,
 * ↑ ↓ ✕, in that order, with the same `formatCount` label — so the app's find
 * bars look and read like each other wherever the user opens one. It is a
 * PRESENTATIONAL component: it owns no query, no cursor and no matches. All of
 * that lives in `MarkdownPreview`, which is where the DOM being searched lives.
 *
 * The one piece of imperative behaviour it does own is focus. `focusSignal` is a
 * counter the parent bumps on every Cmd/Ctrl+F, so pressing the shortcut again
 * while the bar is already open re-focuses and re-selects the query instead of
 * doing nothing (the same trick `TerminalView` plays on its overlay:
 * a shortcut over an editable element needs a focus-local answer).
 *
 * Escape is NOT handled here. It is handled once, on the preview container, so
 * closing the bar works identically whether the caret is in the query box or the
 * user is scrolling the document.
 */

import { useEffect, useRef } from "react";

import { formatCount } from "./find/findModel";

export function PreviewFindBar({
  query,
  total,
  current,
  focusSignal,
  onQueryChange,
  onStep,
  onClose,
}: {
  /** The live query text. */
  query: string;
  /** How many matches the preview found. */
  total: number;
  /** 1-based index of the match the cursor is on (meaningless when total is 0). */
  current: number;
  /** Bumped by the parent to focus + select the input (see the file header). */
  focusSignal: number;
  onQueryChange: (query: string) => void;
  /** +1 = next match, -1 = previous. The parent wraps. */
  onStep: (delta: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The input is rendered unconditionally, so the ref is always live here.
    const input = inputRef.current as HTMLInputElement;
    input.focus();
    // Select, so a second Cmd/Ctrl+F lets the user just type over the old query.
    input.select();
  }, [focusSignal]);

  const empty = total === 0;

  return (
    <div className="preview-find" data-testid="preview-find">
      <input
        ref={inputRef}
        className="preview-find__input"
        data-testid="preview-find-input"
        aria-label="Search the preview"
        placeholder="Find in preview…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Enter walks the matches, Shift+Enter walks back — the house idiom,
          // and preventDefault so the key never submits an enclosing form.
          e.preventDefault();
          onStep(e.shiftKey ? -1 : 1);
        }}
      />
      <span className="preview-find__count" data-testid="preview-find-count">
        {formatCount(empty ? null : current, total)}
      </span>
      <button
        type="button"
        className="preview-find__btn"
        data-testid="preview-find-prev"
        aria-label="Previous match"
        disabled={empty}
        onClick={() => onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="preview-find__btn"
        data-testid="preview-find-next"
        aria-label="Next match"
        disabled={empty}
        onClick={() => onStep(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="preview-find__btn"
        data-testid="preview-find-close"
        aria-label="Close search"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
