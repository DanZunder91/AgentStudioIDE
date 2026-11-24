/**
 * jsonSort — recursive key sorting for the API client's JSON tree (A/B
 * compare).
 *
 * `sortJsonKeys` returns a deep copy of an already-parsed JSON value with
 * every object's keys sorted, so two responses render key-aligned side by
 * side in the ComparePanel. Three deliberate choices:
 *
 * - **UTF-16 code-unit order** (plain `Array.prototype.sort()`, no
 *   comparator): `"Z"` sorts before `"a"`, and the order is deterministic on
 *   every machine and locale. A locale-aware collator would read more
 *   naturally but varies by environment — and the whole point of sorting here
 *   is that pane A and pane B agree exactly. (Caveat inherited from JS object
 *   semantics, not from this sort: integer-like keys such as `"2"` always
 *   enumerate numerically first, whatever order they are inserted in.
 *   `JSON.parse` output has the same property, so JsonView already shows them
 *   that way.)
 * - **Arrays keep their order.** Element order in a JSON array is data (a
 *   paginated list, an ordered log) — reordering it would lie about the
 *   response. Elements are still recursed, so objects *inside* arrays get
 *   their keys sorted.
 * - **Never mutates.** New objects/arrays come back and the input is
 *   untouched, so the caller can toggle sorting on/off over the same parsed
 *   value and re-render either way.
 *
 * Recursion is depth-capped at 100 to mirror JsonView's MAX_DEPTH: past that
 * depth JsonView renders a `{…}` / `Array(N)` summary instead of children, so
 * whether the buried subtree is sorted is unobservable — returning it
 * unchanged (same reference) costs nothing and keeps a pathological input
 * from blowing the stack.
 */

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
