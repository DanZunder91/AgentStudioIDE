/** The Logs ⌘F bar, presentational: the panel owns matches, reveal and focus; the store owns
 * the query. Borrows the editor bar's look and `formatCount`. `in detail` marks a drawer search;
 * an invalid regex shows its message in place of the count. */

import type { RefObject } from "react";

import { formatCount } from "../editor/find/findModel";
import { modChord } from "../shortcuts/shortcuts";
import "../editor/find/find.css";

export interface LogsFindBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  barRef: RefObject<HTMLDivElement | null>;
  scope: "list" | "detail";
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** The invalid regex's message, or null. */
  error: string | null;
  /** 0-based current match (already clamped). */
  current: number;
  total: number;
  onQuery(query: string): void;
  onToggleCase(): void;
  onToggleRegex(): void;
  onStep(delta: number): void;
  onClose(): void;
}

export function LogsFindBar({
  inputRef, barRef, scope, query, caseSensitive, regex, error, current, total,
  onQuery, onToggleCase, onToggleRegex, onStep, onClose,
}: LogsFindBarProps): React.JSX.Element {
  // Destructured, not `p.x`: the React compiler's lint treats a props object that carries
  // refs as a ref itself, so every `p.query` would read as "a ref accessed during render".
  const where = scope === "detail" ? "detail" : "logs";
  return (
    <div className="alog-find" ref={barRef} data-testid="alog-find" data-scope={scope} role="search">
      <input
        ref={inputRef}
        className={`find-bar__input alog-find__input${error !== null ? " find-bar__input--error" : ""}`}
        data-testid="alog-find-input"
        aria-label={`Find in ${where}`}
        aria-invalid={error !== null}
        placeholder={`Find in ${where}…`}
        spellCheck={false}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onStep(e.shiftKey ? -1 : 1);
        }}
      />
      {scope === "detail" && (
        <span
          className="alog-find__scope"
          data-testid="alog-find-scope"
          title={`${modChord("F")} was pressed in the detail drawer: its text is searched, not the stream`}
        >
          in detail
        </span>
      )}
      <button
        type="button"
        className="find-bar__toggle"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={onToggleCase}
      >
        Aa
      </button>
      <button
        type="button"
        className="find-bar__toggle"
        aria-label="Regular expression"
        aria-pressed={regex}
        title="Regular expression"
        onClick={onToggleRegex}
      >
        .*
      </button>
      {error !== null ? (
        <span className="alog-find__error" data-testid="alog-find-error">
          Invalid regex: {error}
        </span>
      ) : (
        <span className="find-bar__count" data-testid="alog-find-count" aria-live="polite">
          {formatCount(total === 0 ? null : current + 1, total)}
        </span>
      )}
      <button
        type="button"
        className="find-bar__nav"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      >
        ▲
      </button>
      <button
        type="button"
        className="find-bar__nav"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={total === 0}
        onClick={() => onStep(1)}
      >
        ▼
      </button>
      <button type="button" className="find-bar__close" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
