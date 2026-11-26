/** Deep copy with keys in UTF-16 code-unit order (locale-independent, so A/B panes agree);
 * arrays keep their order (it is data); never mutates. Past JsonView's MAX_DEPTH a subtree is
 * returned unchanged: JsonView only summarizes it, and the cap protects the stack. */

/** Mirrors JsonView's MAX_DEPTH — past it the tree shows a summary anyway. */
const MAX_DEPTH = 100;

/** Recursively sort object keys (values travel with their keys); arrays keep order. */
export function sortJsonKeys(value: unknown): unknown {
  return sortAtDepth(value, 0);
}

function sortAtDepth(value: unknown, depth: number): unknown {
  // Primitives (string/number/boolean/null/undefined/bigint/…) have no keys.
  if (value === null || typeof value !== "object") return value;
  // At the cap JsonView summarizes this subtree — sorted-or-not is invisible.
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((element) => sortAtDepth(element, depth + 1));
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortAtDepth(source[key], depth + 1);
  }
  return sorted;
}
