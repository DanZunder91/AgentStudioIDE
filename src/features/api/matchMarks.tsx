/**
 * markMatches — split some text into plain runs and `<mark>`ed hits.
 *
 * ONE splitter for BOTH response views (search must work in the tree view
 * too). The Raw view marks one long
 * string; the Formatted (JSON tree) view marks each key name and each
 * primitive value separately. Same function, same classes, same testids —
 * so a hit looks identical and is *found* identically wherever you are, and
 * the two views cannot drift on what a highlight is.
 *
 * It lives in its own module rather than inside either view because both
 * import it: `ResponseBody` renders the raw `<pre>` and also owns the tree,
 * and `JsonView` marks the slots inside that tree. Putting it in either one
 * would make the other import its sibling for a pure helper (a shared seam gets one
 * owner, not two copies).
 *
 * React children, never `innerHTML`: this subtree is React-owned, so the
 * erased-by-re-render hazard does not apply (the same three-way split
 * `FindInFiles`' `MatchLine` uses).
 *
 * The `.response-body__hit` classes live in `responseBody.css`, which
 * `ResponseBody` imports — every caller renders inside one.
 */

import type { MatchRange } from "../editor/find/findModel";

/**
 * `text` split into plain runs and marks.
 *
 * `currentAt` is the index *within `matches`* of the one match that is the
 * find bar's cursor — pass anything out of range (the tree passes a negative
 * or too-large number for slots that hold no cursor) for "none of these".
 * The current match gets its own class and testid, which is also how the
 * scroll effect finds it: an offset is not something you can scroll to.
 */
export function markMatches(
  text: string,
  matches: MatchRange[],
  currentAt: number,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.from > at) out.push(text.slice(at, m.from));
    const isCurrent = i === currentAt;
    out.push(
      <mark
        key={`m${i}`}
        className={`response-body__hit${isCurrent ? " is-current" : ""}`}
        data-testid={isCurrent ? "response-find-current" : "response-find-hit"}
      >
        {text.slice(m.from, m.to)}
      </mark>,
    );
    at = m.to;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
