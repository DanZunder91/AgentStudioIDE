/** Pure find-bar logic on `@codemirror/search`'s `SearchQuery`, so counts match the highlights.
 * Queries are `literal: true` (`\n` means backslash + `n`, regexps aside); matches never overlap;
 * an invalid regexp gives 0 matches, never a throw. */

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

/** The `SearchQuery` shared by panel, keymap and model, so `literal: true` holds everywhere. */
export function toSearchQuery(spec: FindSpec): SearchQuery {
  return new SearchQuery({
    search: spec.search,
    caseSensitive: spec.caseSensitive,
    wholeWord: spec.wholeWord,
    regexp: spec.regexp,
    literal: true,
  });
}

/** True for a NON-EMPTY regexp that does not compile; an empty query is not an error. */
export function queryHasError(spec: FindSpec): boolean {
  return spec.search !== "" && spec.regexp && !toSearchQuery(spec).valid;
}

/** Accept both plain strings (pure tests) and the editor's own `Text`. */
function toDoc(doc: string | Text): Text {
  return typeof doc === "string" ? Text.of(doc.split("\n")) : doc;
}

/** No try/catch: `query.valid` compiles with the cursors' own flags (search 6.7.1), and the "i" a
 * cursor adds cannot change validity, so a valid query never throws here. */
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

/** 1-based k of "k/N" for the match the selection sits on exactly, else null ("N results"). */
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

export function formatCount(current: number | null, total: number): string {
  if (total <= 0) return "0 results";
  if (current == null) return total === 1 ? "1 result" : `${total} results`;
  return `${current}/${total}`;
}
