/** In-file find: `@codemirror/search`, the custom top bar and a `Prec.highest` keymap. The editor
 * is contenteditable, so Mod-f must be a CM6 binding with preventDefault or the WebView sees it. */

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

/** The shared rule from `selectionSeed.ts`, so every find bar in the app answers the same way. */
function selectionSeed(state: EditorState): string | null {
  const { main } = state.selection;
  return seedFromSelectionText(state.sliceDoc(main.from, main.to));
}

/** The bar's own input, once the panel exists. */
function findInput(view: { dom: HTMLElement }): HTMLInputElement | null {
  return view.dom.querySelector<HTMLInputElement>(".find-bar [main-field]");
}

/** Opens or refocuses the bar, seeding from the selection; leaves the input's text selected. */
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

/** Search state + highlighter, the top-docked panel, and the Mod-f / Escape / F3 / Mod-g keymap. */
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
