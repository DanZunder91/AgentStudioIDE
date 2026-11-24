/**
 * TerminalSearch — the IntelliJ-style find-in-terminal overlay.
 *
 * A small floating bar rendered by `<TerminalView>` in the terminal host's
 * top-right corner: query input, Cc / W / .* toggles, a live `k/N` counter,
 * ↑ ↓ navigation and ✕. All searching is delegated to the per-terminal
 * `@xterm/addon-search` instance the registry loaded (`getSearchAddon`) — the
 * addon searches the whole buffer including scrollback and keeps highlights
 * fresh as new output streams in (it re-runs on `onWriteParsed`).
 *
 * Keyboard contract (keyboard bugs here are FOCUS bugs):
 *   - the input is focused on mount and re-focused whenever `focusSignal`
 *     bumps (Cmd/Ctrl+F pressed while already open), and a non-null `seed`
 *     riding along with that bump replaces the query — the terminal's selection;
 *   - Enter / ↓ = next, Shift+Enter / ↑ = previous (the addon wraps natively);
 *   - Esc or ✕ = clear decorations, close, and hand focus BACK to the terminal
 *     (`term.focus()`), so the shell keeps typing without a click.
 *
 * Query + toggles persist per terminal in the registry (`searchUi`), so
 * reopening recalls the last search — and the state dies with the terminal.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TerminalId } from "../../../app/types";
import {
  getSearchAddon,
  getTerminal,
  getTerminalSearchUi,
  setTerminalSearchUi,
} from "../TerminalRegistry";
import {
  buildSearchOptions,
  DEFAULT_SEARCH_UI,
  formatMatchCount,
  type SearchResultCount,
  type SearchUiOptions,
} from "./searchModel";
import "./terminalSearch.css";

/** Idle time after the last keystroke before a live search fires. */
const DEBOUNCE_MS = 100;

export interface TerminalSearchProps {
  terminalId: TerminalId;
  /** Close the overlay (unmounts this component). Focus is returned to the terminal first. */
  onClose: () => void;
  /**
   * Bump to re-focus + select the input while the overlay is already open —
   * the "Cmd/Ctrl+F pressed again" IntelliJ affordance.
   */
  focusSignal?: number;
  /**
   * What the terminal had selected when Cmd/Ctrl+F was pressed, already passed
   * through `selectionSeed`'s rule; `null` means "leave the query alone" (no
   * selection, or a multi-line one). Applied on every `focusSignal` bump, so it
   * overwrites an already-open bar exactly as VS Code does.
   */
  seed?: string | null;
}

export function TerminalSearch({
  terminalId,
  onClose,
  focusSignal = 0,
  seed = null,
}: TerminalSearchProps): React.JSX.Element {
  // Recall the previous session's query/toggles for this terminal, if any.
  const [query, setQuery] = useState(() => getTerminalSearchUi(terminalId)?.query ?? "");
  const [ui, setUi] = useState<SearchUiOptions>(() => {
    const persisted = getTerminalSearchUi(terminalId);
    return persisted
      ? { caseSensitive: persisted.caseSensitive, wholeWord: persisted.wholeWord, regex: persisted.regex }
      : DEFAULT_SEARCH_UI;
  });
  const [result, setResult] = useState<SearchResultCount | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Pending debounce timer — cancelled by explicit navigation so Enter right
   *  after typing runs ONE search, not two (which would skip a match). */
  const debounceRef = useRef<number | null>(null);

  /**
   * The selection seed, applied DURING RENDER — React's documented "adjust state
   * when a prop changes" pattern, the same one `ResultsGrid` and `ResponseBody`
   * use, keyed on the press counter so one Cmd/Ctrl+F seeds exactly once.
   *
   * 🔴 Not an effect, and the difference is visible: an effect would land the
   * seed one render late, so the focus effect below would `select()` the OLD
   * value and React's following `node.value = …` assignment would collapse the
   * selection to the caret — a seeded query the user cannot type over, which is
   * the whole affordance. Seeding in render means the committed DOM already
   * carries the query when `select()` runs, and the debounced search effect
   * fires ONCE, with the seed.
   *
   * `setQuery` is the SAME call the input's onChange makes, so a seeded search
   * and a typed one are one code path — there is deliberately no second "apply
   * the query" route (the bar must actually search for what was selected, not
   * merely display it).
   */
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (seededFor !== focusSignal) {
    setSeededFor(focusSignal);
    if (seed !== null) setQuery(seed);
  }

  /* ── focus: on mount and on every repeated Cmd/Ctrl+F ── */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  /* ── live k/N from the addon (fires because we always pass `decorations`) ── */
  useEffect(() => {
    const addon = getSearchAddon(terminalId);
    if (!addon) return;
    const sub = addon.onDidChangeResults((e) => setResult(e));
    return () => sub.dispose();
  }, [terminalId]);

  /* ── searching ── */

  const runSearch = useCallback(
    (direction: "next" | "previous", q: string, opts: SearchUiOptions): void => {
      const addon = getSearchAddon(terminalId);
      if (!addon) return; // terminal disposed while the overlay is up — inert, not a crash
      try {
        if (q === "") {
          addon.clearDecorations();
          setResult(null);
          return;
        }
        const searchOptions = buildSearchOptions(opts);
        if (direction === "next") addon.findNext(q, searchOptions);
        else addon.findPrevious(q, searchOptions);
      } catch {
        // A half-typed regex ("foo(") throws inside the addon; treat it as
        // "no verdict yet" rather than crashing the overlay mid-keystroke.
        setResult(null);
      }
    },
    [terminalId],
  );

  const cancelPending = useCallback((): void => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  // Live search: debounced on every query/toggle change. Also runs once on
  // mount, which re-highlights a recalled query (the IntelliJ reopen feel).
  useEffect(() => {
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      runSearch("next", query, ui);
    }, DEBOUNCE_MS);
    return cancelPending;
  }, [query, ui, runSearch, cancelPending]);

  // Persist for the next open of this terminal's overlay.
  useEffect(() => {
    setTerminalSearchUi(terminalId, { query, ...ui });
  }, [terminalId, query, ui]);

  // Unmount for ANY reason (Esc, ✕, tab switch, terminal closed): drop the
  // highlights. The results listener above is disposed by its own effect.
  useEffect(() => {
    return () => {
      try {
        getSearchAddon(terminalId)?.clearDecorations();
      } catch {
        /* addon already disposed with its terminal */
      }
    };
  }, [terminalId]);

  const navigate = useCallback(
    (direction: "next" | "previous"): void => {
      cancelPending();
      runSearch(direction, query, ui);
    },
    [cancelPending, runSearch, query, ui],
  );

  const close = useCallback((): void => {
    // Focus back to the shell BEFORE unmounting — the whole point of Esc.
    getTerminal(terminalId)?.focus();
    onClose();
  }, [terminalId, onClose]);

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        navigate(ev.shiftKey ? "previous" : "next");
        break;
      case "ArrowUp":
        ev.preventDefault();
        navigate("previous");
        break;
      case "ArrowDown":
        ev.preventDefault();
        navigate("next");
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        close();
        break;
    }
  };

  const toggle = (key: keyof SearchUiOptions): void => {
    setUi((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /** Keep the input focused when a toggle/arrow button is clicked (IntelliJ does). */
  const keepInputFocus = (ev: React.MouseEvent): void => {
    ev.preventDefault();
  };

  const countText = formatMatchCount(result, query !== "");
  const noResults = countText === "No results";

  return (
    <div className="terminal-search" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className={`terminal-search__input${noResults ? " is-no-results" : ""}`}
        type="text"
        value={query}
        onChange={(ev) => setQuery(ev.target.value)}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        autoComplete="off"
      />
      <span className={`terminal-search__count${noResults ? " is-no-results" : ""}`} aria-live="polite">
        {countText}
      </span>
      <div className="terminal-search__toggles">
        <button
          type="button"
          className={`terminal-search__toggle${ui.caseSensitive ? " is-active" : ""}`}
          onClick={() => toggle("caseSensitive")}
          onMouseDown={keepInputFocus}
          aria-label="Case sensitive"
          aria-pressed={ui.caseSensitive}
          title="Match case"
        >
          Cc
        </button>
        <button
          type="button"
          className={`terminal-search__toggle${ui.wholeWord ? " is-active" : ""}`}
          onClick={() => toggle("wholeWord")}
          onMouseDown={keepInputFocus}
          aria-label="Whole word"
          aria-pressed={ui.wholeWord}
          title="Whole words"
        >
          W
        </button>
        <button
          type="button"
          className={`terminal-search__toggle${ui.regex ? " is-active" : ""}`}
          onClick={() => toggle("regex")}
          onMouseDown={keepInputFocus}
          aria-label="Regular expression"
          aria-pressed={ui.regex}
          title="Regular expression"
        >
          .*
        </button>
      </div>
      <button
        type="button"
        className="terminal-search__btn"
        onClick={() => navigate("previous")}
        onMouseDown={keepInputFocus}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-search__btn"
        onClick={() => navigate("next")}
        onMouseDown={keepInputFocus}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-search__btn terminal-search__close"
        onClick={close}
        aria-label="Close find"
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}

export default TerminalSearch;
