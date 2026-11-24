/**
 * selectionSeed — "what should Cmd/Ctrl+F put in the box?", answered ONCE for
 * every find bar in the app (pressing Cmd+F with text selected must search for
 * that selection).
 *
 * The editor's in-file bar did this first (`bufferSearch.ts`), and the other
 * five surfaces opened an empty box. So this module is not a new
 * behaviour — it is the editor's rule lifted out of CM6 so the terminal, the
 * Markdown preview, the DB results grid and both API response bodies can answer
 * the question identically. `bufferSearch` now calls it too, which is what makes
 * "identically" a fact rather than a promise (when one surface of a
 * class behaves and four do not, the fix is one shared seam, not four copies).
 *
 * ## The rule (VS Code's `getSelectionSearchString`, and ours before it)
 *
 *   - **non-empty** — an empty/collapsed selection seeds nothing;
 *   - **single-line** — a selection spanning a line break leaves the existing
 *     query **untouched**, not cleared. Scoping a search *to* a selection is a
 *     different feature (VS Code's `autoFindInSelection`, default off). Chrome
 *     seeds multi-line selections; we follow VS Code and our own editor;
 *   - **sane-sized** — over `SEED_MAX` characters is a paragraph, not a query
 *     (the cap CodeMirror's own search panel uses).
 *
 * Nothing is trimmed: a selection of two spaces is a legitimate search for two
 * spaces, and the editor has always seeded it.
 *
 * ## Why the DOM reader lives here too
 *
 * Three of the six surfaces read `window.getSelection()` and the other three do
 * not (CM6 has `state.selection`, xterm has `getSelection()`). The DOM read is
 * the part with the traps — the selection must be read SYNCHRONOUSLY in the key
 * handler, because every one of those surfaces defers focusing its input and
 * focusing an input collapses the document selection — so it is written once,
 * here, instead of three times.
 *
 * 🔴 jsdom caveat, for whoever writes the next test: jsdom's `Selection.
 * toString()` is `Range.toString()`, which concatenates character data and does
 * NOT insert the line breaks a real browser puts between block elements. So a
 * jsdom selection spanning two `<p>`s yields a single-line string. Construct the
 * multi-line case from a text node that genuinely contains `\n` (a `<pre>`, a
 * code fence, a multi-line cell value) and it behaves the same in both.
 */

/**
 * Longest selection that may seed a find bar. 200 is `@codemirror/search`'s own
 * cap on the query it derives from a selection; the editor's find bar uses it
 * and every other bar inherits it.
 */
export const SEED_MAX = 200;

/**
 * The seed for a raw selection string, or `null` for "leave the query alone".
 *
 * Accepts `null`/`undefined` so callers can hand over whatever their selection
 * API returns (xterm's `getSelection()` on a disposed terminal, a mocked
 * registry in a test) without a guard each.
 */
export function seedFromSelectionText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw.length > SEED_MAX) return null;
  // A line break anywhere means the selection spans lines. `\r` is here because
  // a paste-driven selection can carry CRLF; a real browser, xterm and CM6 all
  // join with `\n`.
  if (/[\r\n]/.test(raw)) return null;
  return raw;
}

/**
 * The seed for a DOM surface: the document selection, but only when it actually
 * lies inside `container`.
 *
 * The containment check is not paranoia — it is what stops one surface seeding
 * another's bar. The API client renders two `<ResponseBody>`s side by side in
 * compare mode: selecting in the left one and pressing Cmd/Ctrl+F over the right
 * one must open the right one's bar unchanged, not fill it with the left one's
 * text. It is also what lets the Markdown preview's WINDOW-level fallback seed
 * at all: there, focus is on a tree row or a tab, so "is the selection ours?" is
 * the only question that can be asked.
 *
 * `container` is non-optional on purpose: every call site holds a ref to an
 * element that renders unconditionally, so a nullable parameter would be a
 * branch no test could honestly reach.
 */
export function domSelectionSeed(container: HTMLElement): string | null {
  // `null` where the document has no view (a detached document); jsdom and every
  // real WebView hand back a Selection.
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  // `contains` is true for the container itself, so a select-all inside it —
  // whose common ancestor IS the container — still counts as ours.
  if (!container.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
  return seedFromSelectionText(selection.toString());
}
