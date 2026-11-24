/**
 * searchModel — the pure logic behind the find-in-terminal overlay.
 *
 * Everything here is a plain function so it can be tested exhaustively without
 * a DOM, xterm, or React: which keystroke means "open find" on which platform,
 * what the `k/N` counter reads for a given `onDidChangeResults` event, and the
 * exact `ISearchOptions` handed to `@xterm/addon-search`.
 */

import type { ISearchOptions } from "@xterm/addon-search";

/** The keyboard fields `isFindShortcut` reads — a structural subset of KeyboardEvent. */
export interface FindShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Is this keydown the find-in-terminal shortcut?
 *
 * Cmd+F on macOS, Ctrl+F elsewhere — and STRICTLY that:
 *   - Ctrl+F on macOS must fall through to the PTY (it is forward-char in every
 *     readline shell and emacs binding; stealing it would be a real regression).
 *   - Cmd/Ctrl+Shift+F is Find-in-Files (`features/find`), not ours.
 *   - Alt combinations are never ours.
 */
export function isFindShortcut(ev: FindShortcutKey, mac: boolean): boolean {
  if (ev.key.toLowerCase() !== "f") return false;
  if (ev.altKey || ev.shiftKey) return false;
  return mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
}

/** The two fields of `ISearchResultChangeEvent` the counter renders from. */
export interface SearchResultCount {
  /** 0-based index of the active match; -1 when the highlight limit was exceeded. */
  resultIndex: number;
  resultCount: number;
}

/**
 * The `k/N` label, IntelliJ-style.
 *
 *   - no query typed → "" (an empty search matches nothing; showing
 *     "No results" for it would read as an error).
 *   - no event yet (search still debouncing) → "".
 *   - 0 matches → "No results".
 *   - over the addon's highlight limit it reports `resultIndex: -1` — the count
 *     is a floor, not a total, so render "N+".
 *   - otherwise "k/N", 1-based.
 */
export function formatMatchCount(result: SearchResultCount | null, hasQuery: boolean): string {
  if (!hasQuery || result === null) return "";
  if (result.resultCount === 0) return "No results";
  if (result.resultIndex < 0) return `${result.resultCount}+`;
  return `${result.resultIndex + 1}/${result.resultCount}`;
}

/** The overlay's toggles — persisted per terminal so reopening feels IntelliJ-like. */
export interface SearchUiOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_SEARCH_UI: SearchUiOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/**
 * Match-highlight colors. `@xterm/addon-search` requires literal #RRGGBB (it
 * feeds them to xterm decorations, which cannot resolve CSS variables), so
 * these are pinned to the `--accent` family in `src/App.css` — same tokens the
 * xterm theme derives from (`theme.ts`).
 */
export const SEARCH_DECORATIONS = {
  matchBackground: "#1f4d8f", // dimmed accent — all matches
  matchOverviewRuler: "#3b82f6", // --accent
  activeMatchBackground: "#3b82f6", // --accent — the selected match
  activeMatchColorOverviewRuler: "#79c0ff", // brightBlue (theme.ts)
} as const;

/**
 * Build the options for every `findNext`/`findPrevious` call.
 *
 * `decorations` is always set: it is what makes the addon highlight ALL
 * matches and fire `onDidChangeResults` (the k/N counter is dead without it).
 * Deliberately NO `incremental` and NO internal `noScroll`: the addon's
 * default find wraps around the buffer edges and scrolls the match into view,
 * which is exactly the IntelliJ behavior we want.
 */
export function buildSearchOptions(ui: SearchUiOptions): ISearchOptions {
  return {
    caseSensitive: ui.caseSensitive,
    wholeWord: ui.wholeWord,
    regex: ui.regex,
    decorations: SEARCH_DECORATIONS,
  };
}
