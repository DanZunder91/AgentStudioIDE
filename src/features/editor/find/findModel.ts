/**
 * findModel — the PURE logic behind the in-file find bar.
 *
 * Everything here is headless: it runs on plain strings (or a CM6 `Text`) and
 * never touches a view. The panel (`findPanel.ts`) calls these against
 * `view.state.doc`, and the jsdom test suite (`findModel.test.ts`) exercises
 * them exhaustively, including with fast-check properties.
 *
 * Match semantics deliberately come from `@codemirror/search`'s own
 * `SearchQuery` — NOT a reimplementation — so the numbers shown in the bar can
 * never disagree with the highlights and the next/previous navigation the same
 * package paints and drives. Notes on that engine:
 *
 *   - Queries are built with `literal: true`: typing `\n` in the find input
 *     searches for a backslash followed by an `n`, like IntelliJ, instead of
 *     CM's default escape-sequence unquoting. (Regexp mode is unaffected —
 *     `\n` in a regexp is still a newline, as expected.)
 *   - String matches are counted non-overlapping, exactly as the highlighter
 *     paints them (`"aa"` in `"aaa"` is 1 match, not 2).
 *   - An INVALID regexp (or an empty query) yields 0 matches and never
 *     throws; `queryHasError` is the flag the panel uses for the red state.
 */

import { EditorState, Text } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

/** The four knobs on the find bar: query text + Cc / W / .* toggles. */
export interface FindSpec {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

/** A single match, in document offsets. */
export interface MatchRange {
  from: number;
  to: number;
}

/**
 * Build the `SearchQuery` the whole feature shares (panel, keymap, model).
 * Centralized so the `literal: true` decision above holds everywhere.
 */
export function toSearchQuery(spec: FindSpec): SearchQuery {
  return new SearchQuery({
    search: spec.search,
    caseSensitive: spec.caseSensitive,
    wholeWord: spec.wholeWord,
    regexp: spec.regexp,
    literal: true,
  });
}

/**
 * True when the spec is a NON-EMPTY regexp query that does not compile.
 * (An empty query is merely "nothing to search", not an error.)
 */
export function queryHasError(spec: FindSpec): boolean {
  return spec.search !== "" && spec.regexp && !toSearchQuery(spec).valid;
}

/** Accept both plain strings (pure tests) and the editor's own `Text`. */
function toDoc(doc: string | Text): Text {
  return typeof doc === "string" ? Text.of(doc.split("\n")) : doc;
}

/**
 * Every match of `spec` in the document, in order. Empty for an empty or
 * invalid query — never a throw.
 *
 * Invariant (why there is no try/catch here): `query.valid` is the complete
 * guard. In @codemirror/search 6.7.1, `SearchQuery.valid` pre-compiles a
 * regexp query with the exact same `baseFlags` ("gm"+"u") the search cursors
 * themselves use; the only flag a cursor ever adds is "i", and in JavaScript
 * the "i" flag can never change a pattern's syntactic validity (only "u"/"v"
 * can, and those are identical on both sides). So once `valid` is true,
 * cursor construction cannot throw, and cursor iteration is throw-free string
 * scanning / `exec` calls. A dead catch would be uncoverable by any test —
 * removed per the repo's no-dead-guards rule.
 */
export function listMatches(spec: FindSpec, doc: string | Text): MatchRange[] {
  const query = toSearchQuery(spec);
  if (!query.valid) return [];
  const state = EditorState.create({ doc: toDoc(doc) });
  const out: MatchRange[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    out.push({ from: step.value.from, to: step.value.to });
  }
  return out;
}

/** Total number of matches (the N of "k/N"). 0 for empty/invalid queries. */
export function countMatches(spec: FindSpec, doc: string | Text): number {
  return listMatches(spec, doc).length;
}

/**
 * The 1-based index (the k of "k/N") of the match the selection sits on
 * exactly, or null when the selection is not a match (so the bar falls back
 * to "N results", IntelliJ-style).
 */
export function currentMatchIndex(
  spec: FindSpec,
  doc: string | Text,
  selFrom: number,
  selTo: number,
): number | null {
  const matches = listMatches(spec, doc);
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from === selFrom && matches[i].to === selTo) return i + 1;
  }
  return null;
}

/**
 * The label the bar shows: "0 results" when nothing matches, "k/N" when the
 * selection is on match k, and "N results" (singular-aware) otherwise.
 */
export function formatCount(current: number | null, total: number): string {
  if (total <= 0) return "0 results";
  if (current == null) return total === 1 ? "1 result" : `${total} results`;
  return `${current}/${total}`;
}
