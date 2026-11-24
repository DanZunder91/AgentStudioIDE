/**
 * extractPath — pull one value out of a parsed JSON response by path (request
 * sequences).
 *
 * A sequence step captures a value from its response (`sessionJwt ← data.jwt`)
 * and later steps use it as `{{sessionJwt}}`. This module is the "←" half, and it
 * is deliberately pure: a path, a parsed value, and an answer.
 *
 * 🔴 **Why every failure carries a REASON, and why `null` is a failure.**
 * `substituteVars` resolves an unknown `{{VAR}}` to the **empty string, silently**
 * — pinned by `substitute.test.ts:21` (`substituteVars("Bearer {{TOKEN}}", {})`
 * is `"Bearer "`). For one hand-edited request that is tolerable. In a chain it is
 * poison: a capture that quietly yields nothing turns "step 2 did not return a
 * token" into "step 3 returns 401 for no visible reason", and the user debugs
 * their API instead of our silence. So a miss is never a value here — it is a
 * `found: false` carrying a sentence that names where the walk stopped, and the
 * runner fails the step with it rather than sending an empty credential.
 *
 * The same rule stated generally: when the data can hold a state
 * the contract cannot express, say so in the OUTPUT rather than collapsing it.
 *
 * No dependency: there is no JSONPath library in this repo and this needs a
 * fraction of one (the app is zero-install).
 */

/** The result of a capture: a string to substitute, or why there wasn't one. */
export type Extracted =
  | { found: true; value: string }
  | { found: false; reason: string };

/** One step of a parsed path: an object key or an array index. */
type Segment = { kind: "key"; name: string } | { kind: "index"; at: number };

/**
 * Parse `a.b[0].c` into segments.
 *
 * Returns null for a path that cannot mean anything — empty, a `[]` with a
 * non-integer inside, an unclosed `[`. The caller turns that into a `found:
 * false` naming the path, because a malformed path is a user typo and deserves
 * to be reported as one rather than silently matching nothing.
 */
function parsePath(path: string): Segment[] | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;

  const segments: Segment[] = [];
  let i = 0;
  let current = "";

  /** Flush the identifier accumulated so far, if any. */
  const flush = (): boolean => {
    if (current === "") return true;
    segments.push({ kind: "key", name: current });
    current = "";
    return true;
  };

  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === ".") {
      // `a..b` and a leading/trailing dot are typos, not empty keys.
      if (current === "" && segments.length === 0) return null;
      if (current === "" && trimmed[i - 1] === ".") return null;
      flush();
      i += 1;
      // A trailing dot has nothing after it.
      if (i === trimmed.length) return null;
      continue;
    }
    if (c === "[") {
      flush();
      const close = trimmed.indexOf("]", i);
      if (close === -1) return null;
      const inner = trimmed.slice(i + 1, close).trim();
      // Only non-negative integers index an array. `[foo]` is a typo for `.foo`.
      if (!/^\d+$/.test(inner)) return null;
      segments.push({ kind: "index", at: Number(inner) });
      i = close + 1;
      // `a[0]b` is malformed; after a bracket only `.`, `[` or the end may follow.
      if (i < trimmed.length && trimmed[i] !== "." && trimmed[i] !== "[") return null;
      if (trimmed[i] === ".") i += 1;
      continue;
    }
    if (c === "]") return null; // a stray closer
    current += c;
    i += 1;
  }
  flush();
  // No `segments.length === 0` guard: a non-empty trimmed path either returned
  // null above (a lone `.`/`]`, a bad bracket) or pushed at least one segment,
  // so an empty result is unreachable. The coverage gate is what proved it.
  return segments;
}

/** How a segment reads in a message, so the reason echoes the user's own path. */
function segmentLabel(seg: Segment): string {
  return seg.kind === "key" ? seg.name : `[${seg.at}]`;
}

/**
 * The JSON-ish name of a value, for a reason a human can act on.
 *
 * No `null` arm: every call site has already returned for null, so one here
 * would be unreachable (design the branch out rather than waive it).
 */
function typeName(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Extract `path` from `root` — the PARSED response body, not the raw text.
 *
 * A leading `body.` is accepted and stripped, because the capture editor shows
 * the path next to the response body and "body.data.jwt" is what a user
 * naturally writes; `data.jwt` means the same thing. Anything else is walked
 * literally, so a real field actually named `body` is still reachable as
 * `body.body`.
 */
export function extractPath(root: unknown, path: string): Extracted {
  const withoutPrefix = path.trim().replace(/^body\./, "");
  const segments = parsePath(withoutPrefix);
  if (segments === null) {
    return { found: false, reason: `"${path.trim()}" is not a valid path` };
  }

  let current: unknown = root;
  const walked: string[] = [];

  for (const seg of segments) {
    const here = walked.length === 0 ? "the response body" : `"${walked.join(".")}"`;

    if (current === null || current === undefined) {
      return { found: false, reason: `${here} is ${current === null ? "null" : "missing"}` };
    }

    if (seg.kind === "index") {
      if (!Array.isArray(current)) {
        return { found: false, reason: `${here} is ${typeName(current)}, not an array` };
      }
      if (seg.at >= current.length) {
        const n = current.length;
        return {
          found: false,
          reason: `${here} has ${n} item${n === 1 ? "" : "s"}, so [${seg.at}] is out of range`,
        };
      }
      current = current[seg.at];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) {
        return { found: false, reason: `${here} is ${typeName(current)}, so it has no "${seg.name}"` };
      }
      const obj = current as Record<string, unknown>;
      if (!(seg.name in obj)) {
        return { found: false, reason: `${here} has no "${seg.name}"` };
      }
      current = obj[seg.name];
    }
    walked.push(segmentLabel(seg));
  }

  const reached = `"${walked.join(".")}"`;

  // A captured value is substituted into a URL, a header or a body — all strings.
  // The three cases below are exactly the ones that would otherwise become the
  // empty string or the literal "[object Object]" downstream.
  if (current === null) return { found: false, reason: `${reached} is null` };
  if (current === undefined) return { found: false, reason: `${reached} is missing` };
  if (typeof current === "object") {
    return { found: false, reason: `${reached} is ${typeName(current)} — capture a single value` };
  }
  return { found: true, value: String(current) };
}
