/** User-defined order for a db tree level: named keys first, then unnamed in arrival order (new
 * tables land at the bottom), missing keys skipped, so a changing schema never loses a table. Same
 * rule as `orderFolders` (`app/folderOrder.ts`), but here the unordered tail is permanent. */

// The generic list-move every drag reduces to, imported rather than copied. See the
// `moveBefore` wrapper at the bottom for the single gesture difference the db tree needs.
import { moveBefore as moveInList } from "../../app/folderOrder";

/** A saved order: child keys, in the sequence the user put them in. */
export type TreeOrder = readonly string[];

/** An empty order (nobody dragged) returns `items` untouched, at the cost of one length check. */
export function applyOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  order: TreeOrder,
): T[] {
  if (order.length === 0) return [...items];

  // Index once. A schema with a few hundred tables is ordinary, and this runs on every
  // render of an expanded level.
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);

  const out: T[] = [];
  const placed = new Set<string>();
  for (const key of order) {
    const item = byKey.get(key);
    // Rule 3: named but gone (a dropped table, or a stale entry from another schema).
    // Skipped rather than rendered as a blank row.
    if (item === undefined) continue;
    // A saved file may hold duplicate keys; first occurrence wins so no table renders twice.
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(item);
  }
  // Rule 2: everything the order does not name, in arrival order.
  for (const item of items) {
    if (!placed.has(keyOf(item))) out.push(item);
  }
  return out;
}

/** Lets the caller skip the write and re-render when a drag put the row back where it was. */
export function sameOrder(a: TreeOrder, b: TreeOrder): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** Drop `moved` before `before` (null = end); `current` is the keys as displayed now. Unlike
 * folderOrder's primitive, dropping a row on itself is a no-op rather than a move to the end. */
export function moveBefore(
  current: TreeOrder,
  moved: string,
  before: string | null,
): string[] {
  // Dropping a row onto itself is a click, not a move. Copied, not returned as-is, so the
  // caller always owns a mutable array regardless of which branch it came from.
  if (before === moved) return [...current];
  return moveInList(current, moved, before);
}
