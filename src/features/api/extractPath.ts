/** The capture half of a sequence (sessionJwt from data.jwt). A miss, null included, is
 * found: false with a reason naming where the walk stopped: substituteVars would silently send ""
 * and the user would chase a 401. No JSONPath dependency (zero-install). */

/** The result of a capture: a string to substitute, or why there wasn't one. */
export type Extracted =
  | { found: true; value: string }
  | { found: false; reason: string };

/** One step of a parsed path: an object key or an array index. */
type Segment = { kind: "key"; name: string } | { kind: "index"; at: number };

/** null for a meaningless path (empty, non-integer [], unclosed [): a typo the caller reports. */
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

/** No null arm: every caller has already returned for null. */
function typeName(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** root is the PARSED body. A leading "body." is stripped, as users write it; a real field named
 * body is reachable as body.body. */
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
