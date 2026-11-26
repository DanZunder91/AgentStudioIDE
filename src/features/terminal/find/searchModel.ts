/** Pure logic behind the find-in-terminal overlay, testable without a DOM, xterm or React. */

import type { ISearchOptions } from "@xterm/addon-search";

/** The keyboard fields `isFindShortcut` reads — a structural subset of KeyboardEvent. */
export interface FindShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+F on macOS, Ctrl+F elsewhere, strictly: macOS Ctrl+F is readline's forward-char and must
 * reach the PTY; Mod+Shift+F is Find in Files; Alt combinations are never ours. */
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

/** "k/N", 1-based; "" with no query or no event yet (debouncing); "No results" for 0; "N+" when
 * the addon reports `resultIndex: -1` (over its highlight limit the count is a floor). */
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

/** Literal #RRGGBB (xterm decorations cannot resolve CSS variables), pinned to the `--accent`
 * family in `src/App.css`, like `theme.ts`. */
export const SEARCH_DECORATIONS = {
  matchBackground: "#1f4d8f", // dimmed accent — all matches
  matchOverviewRuler: "#3b82f6", // --accent
  activeMatchBackground: "#3b82f6", // --accent — the selected match
  activeMatchColorOverviewRuler: "#79c0ff", // brightBlue (theme.ts)
} as const;

/** `decorations` always set: without it the addon neither highlights all matches nor fires
 * `onDidChangeResults`. No `incremental`/`noScroll`: the default wraps and scrolls into view. */
export function buildSearchOptions(ui: SearchUiOptions): ISearchOptions {
  return {
    caseSensitive: ui.caseSensitive,
    wholeWord: ui.wholeWord,
    regex: ui.regex,
    decorations: SEARCH_DECORATIONS,
  };
}
