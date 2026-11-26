/** One splitter for the Raw and Formatted response views, so a hit looks and is found identically
 * in both. React children, never innerHTML (same split as FindInFiles' MatchLine).
 * The .response-body__hit classes live in responseBody.css, imported by ResponseBody. */

import type { MatchRange } from "../editor/find/findModel";

/** `currentAt` indexes `matches`; out of range means no cursor here. The current match gets its own
 * class and testid, which is how the scroll effect finds it. */
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
