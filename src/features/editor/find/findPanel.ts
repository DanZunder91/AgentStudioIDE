/**
 * findPanel — the in-file find bar's DOM.
 *
 * A CM6 `Panel` (plain DOM by design — CM6 panels live outside React), docked
 * at the top of the editor, IntelliJ-style:
 *
 *   [ input ] [Cc] [W] [.*]  k/N   ↑ ↓        ✕
 *
 * The panel is a thin VIEW over `@codemirror/search`'s state: the query of
 * record lives in the editor state (set via `setSearchQuery`, read via
 * `getSearchQuery`), which is what makes the query survive close/reopen and
 * keeps the highlighter, the navigation commands, and this bar in agreement.
 * The count comes from `findModel.ts` — the same `SearchQuery` engine, run
 * headless over the whole document.
 *
 * Keyboard contract (see `bufferSearch.ts` for the editor-side keymap):
 *   - Keys pressed INSIDE the panel are first offered to the app's
 *     "search-panel"-scoped bindings via `runScopeHandlers` (so Mod-f
 *     re-seeds/re-selects, Escape closes, F3/Mod-g navigate, from within
 *     the input too).
 *   - Enter / Shift+Enter in the input = next / previous match.
 */

import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { Panel, ViewUpdate } from "@codemirror/view";

import {
  countMatches,
  currentMatchIndex,
  formatCount,
  queryHasError,
  toSearchQuery,
} from "./findModel";
import type { FindSpec } from "./findModel";

/* ── tiny DOM helpers (no React in a CM6 panel) ─────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attrs: Record<string, string> = {},
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function toggleButton(label: string, name: string, pressed: boolean): HTMLButtonElement {
  const btn = el("button", "find-bar__toggle", {
    type: "button",
    "aria-label": name,
    title: name,
    "aria-pressed": pressed ? "true" : "false",
  });
  btn.textContent = label;
  return btn;
}

const isPressed = (btn: HTMLButtonElement) => btn.getAttribute("aria-pressed") === "true";
const setPressed = (btn: HTMLButtonElement, on: boolean) =>
  btn.setAttribute("aria-pressed", on ? "true" : "false");

/* ── the panel ──────────────────────────────────────────────────────────── */

/** Build the find bar for one editor view. Passed to `search({ createPanel })`. */
export function createFindPanel(view: EditorView): Panel {
  const start = getSearchQuery(view.state);

  const input = el("input", "find-bar__input", {
    type: "text",
    placeholder: "Find",
    "aria-label": "Find",
    // The search extension focuses/select-alls whatever carries this marker.
    "main-field": "true",
  });
  input.value = start.search;

  const caseBtn = toggleButton("Cc", "Match case", start.caseSensitive);
  const wordBtn = toggleButton("W", "Words", start.wholeWord);
  const regexpBtn = toggleButton(".*", "Regex", start.regexp);

  const count = el("span", "find-bar__count", { "aria-live": "polite" }, "0 results");

  const prevBtn = el(
    "button",
    "find-bar__nav",
    { type: "button", "aria-label": "Previous match", title: "Previous match (Shift+Enter)" },
    "↑",
  );
  const nextBtn = el(
    "button",
    "find-bar__nav",
    { type: "button", "aria-label": "Next match", title: "Next match (Enter)" },
    "↓",
  );
  const spacer = el("span", "find-bar__spacer");
  const closeBtn = el(
    "button",
    "find-bar__close",
    { type: "button", "aria-label": "Close find bar", title: "Close (Escape)" },
    "✕",
  );

  const dom = el("div", "find-bar");
  dom.append(input, caseBtn, wordBtn, regexpBtn, count, prevBtn, nextBtn, spacer, closeBtn);

  /** The spec as currently shown by the bar's own controls. */
  const specFromDom = (): FindSpec => ({
    search: input.value,
    caseSensitive: isPressed(caseBtn),
    wholeWord: isPressed(wordBtn),
    regexp: isPressed(regexpBtn),
  });

  /** Recompute "k/N" + the error state from the query of record. */
  const refresh = () => {
    const q = getSearchQuery(view.state);
    const spec: FindSpec = {
      search: q.search,
      caseSensitive: q.caseSensitive,
      wholeWord: q.wholeWord,
      regexp: q.regexp,
    };
    const total = countMatches(spec, view.state.doc);
    const sel = view.state.selection.main;
    const k = total > 0 ? currentMatchIndex(spec, view.state.doc, sel.from, sel.to) : null;
    count.textContent = formatCount(k, total);

    // IntelliJ semantics: red input when a non-empty query finds nothing
    // (including a regexp that does not compile — never a crash).
    const error = spec.search !== "" && total === 0;
    input.classList.toggle("find-bar__input--error", error);
    input.setAttribute("aria-invalid", error ? "true" : "false");
    input.title = queryHasError(spec) ? "Invalid regular expression" : "";
  };

  /** Push the bar's controls into the editor's search state (live search). */
  const commit = () => {
    const next = toSearchQuery(specFromDom());
    if (!next.eq(getSearchQuery(view.state))) {
      view.dispatch({ effects: setSearchQuery.of(next) }); // update() → refresh()
    } else {
      refresh();
    }
  };

  /** Mirror an externally-set query (e.g. Mod-f seeding from the selection). */
  const syncFromQuery = (q: SearchQuery) => {
    if (input.value !== q.search) input.value = q.search;
    setPressed(caseBtn, q.caseSensitive);
    setPressed(wordBtn, q.wholeWord);
    setPressed(regexpBtn, q.regexp);
  };

  const valid = () => getSearchQuery(view.state).valid;

  input.addEventListener("input", commit);
  for (const btn of [caseBtn, wordBtn, regexpBtn]) {
    btn.addEventListener("click", () => {
      setPressed(btn, !isPressed(btn));
      commit(); // toggles re-run the query immediately
      input.focus(); // keep the typing flow in the input, IntelliJ-style
    });
  }
  nextBtn.addEventListener("click", () => {
    if (valid()) findNext(view); // empty/invalid query → arrows no-op
  });
  prevBtn.addEventListener("click", () => {
    if (valid()) findPrevious(view);
  });
  closeBtn.addEventListener("click", () => {
    closeSearchPanel(view);
    view.focus(); // hand focus back to the document
  });
  dom.addEventListener("keydown", (event) => {
    // App-level bindings first: Mod-f (re-seed + select-all), Escape (close),
    // F3 / Mod-g (navigate) — all scoped "search-panel" in bufferSearch.ts.
    if (runScopeHandlers(view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      if (!valid()) return;
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
    }
  });

  refresh();

  return {
    dom,
    top: true, // docked at the top, like IntelliJ's find bar
    mount() {
      input.focus();
      input.select();
    },
    update(update: ViewUpdate) {
      let queryChanged = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery)) {
            queryChanged = true;
            syncFromQuery(effect.value);
          }
        }
      }
      // The count depends on the query, the document, AND where the selection
      // sits (the k of k/N) — refresh on any of the three moving.
      if (queryChanged || update.docChanged || update.selectionSet) refresh();
    },
  };
}
