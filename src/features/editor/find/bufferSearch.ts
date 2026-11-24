/**
 * bufferSearch — the public in-file find extension.
 *
 * The one export the editor assembly wires in:
 *
 *   import { bufferSearch } from "./find/bufferSearch";
 *   extensions: [..., bufferSearch()]
 *
 * It bundles `@codemirror/search` (match state + highlighter) with the custom
 * IntelliJ-style top bar (`findPanel.ts`) and a HIGH-PRECEDENCE keymap.
 * The editor is a contenteditable — Cmd/Ctrl+F must be a CM6
 * keymap binding with preventDefault so the WebView / anything above never
 * sees it. `Prec.highest` keeps it ahead of every other editor binding.
 *
 * Open semantics (IntelliJ): if the editor has a non-empty single-line
 * selection when Mod-f fires, it seeds the query; otherwise the previous
 * query is kept. Either way the input gets focus with its text selected.
 * Escape closes the bar and puts focus back in the document. The query
 * itself lives in the editor state, so it survives close/reopen.
 */

import { Prec } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";

import { createFindPanel } from "./findPanel";
import { seedFromSelectionText } from "./selectionSeed";
import "./find.css";

/**
 * The seed IntelliJ would use: a non-empty, single-line, sane-sized selection.
 *
 * The rule itself lives in `selectionSeed.ts`, shared with the terminal, the
 * Markdown preview, the DB grid and the API response bodies. It used to be
 * inlined here with its own doc-position arithmetic;
 * that version and this one are the same function — CM stores lines without
 * their terminator and `sliceDoc` rejoins them with `\n`, so "the slice contains
 * a line break" and "`lineAt(from).number !== lineAt(to).number`" agree by
 * construction, and a slice's length is exactly `to - from`. Sharing it is what
 * makes every bar in the app answer the question the same way, by construction
 * rather than by two lists of rules that drift.
 */
function selectionSeed(state: EditorState): string | null {
  const { main } = state.selection;
  return seedFromSelectionText(state.sliceDoc(main.from, main.to));
}

/** The bar's own input, once the panel exists. */
function findInput(view: { dom: HTMLElement }): HTMLInputElement | null {
  return view.dom.querySelector<HTMLInputElement>(".find-bar [main-field]");
}

/**
 * Mod-f: open the bar (or refocus it), seeding from the selection when there
 * is one. Always leaves the input focused with its text selected.
 */
export const openFindPanel: Command = (view) => {
  // Capture BEFORE opening: openSearchPanel itself re-derives a default query
  // (with its own multi-line escaping) — our seeding policy overrides it.
  const previous = getSearchQuery(view.state);
  const seed = selectionSeed(view.state);

  if (!searchPanelOpen(view.state)) openSearchPanel(view);

  const desired =
    seed !== null
      ? new SearchQuery({
          search: seed,
          literal: true,
          caseSensitive: previous.caseSensitive,
          wholeWord: previous.wholeWord,
          regexp: previous.regexp,
        })
      : previous; // no usable selection → keep the last query
  if (!desired.eq(getSearchQuery(view.state))) {
    view.dispatch({ effects: setSearchQuery.of(desired) });
  }

  const input = findInput(view);
  if (input) {
    input.focus();
    input.select();
  }
  return true;
};

/** Escape: close the bar (if open) and put the caret back in the document. */
export const closeFindPanel: Command = (view) => {
  if (!searchPanelOpen(view.state)) return false; // let other Escape handlers run
  closeSearchPanel(view);
  view.focus();
  return true;
};

/**
 * The in-file find extension: search state + highlighter with the custom
 * top-docked panel, plus the Mod-f / Escape / F3 / Mod-g keymap.
 */
export function bufferSearch(): Extension {
  return [
    search({ top: true, literal: true, createPanel: createFindPanel }),
    Prec.highest(
      keymap.of([
        // scope includes "search-panel" so the same bindings fire from inside
        // the bar's input (findPanel.ts routes panel keydowns through
        // runScopeHandlers).
        { key: "Mod-f", run: openFindPanel, scope: "editor search-panel", preventDefault: true },
        { key: "Escape", run: closeFindPanel, scope: "editor search-panel" },
        {
          key: "F3",
          run: findNext,
          shift: findPrevious,
          scope: "editor search-panel",
          preventDefault: true,
        },
        {
          key: "Mod-g",
          run: findNext,
          shift: findPrevious,
          scope: "editor search-panel",
          preventDefault: true,
        },
      ]),
    ),
  ];
}
