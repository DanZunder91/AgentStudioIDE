/**
 * The ONE folder-ordering primitive, shared by both rails.
 *
 * Dragging a folder up/down must keep the left (Agents) rail
 * and the right (Files) rail in the *same* sort. That only holds if both sides order
 * folders by a single source of truth — the persisted `folderOrder` list — through
 * the same pure function. This is that function (and the generic list-move the drag
 * gestures reduce to), kept dependency-free so it is trivially testable and cannot
 * disagree with itself between the two rails.
 */

/**
 * Stable-sort `paths` by their index in `order`. A path present in `order` sorts to
 * that rank; a path NOT in `order` keeps its original relative position, after every
 * ordered one (Array.prototype.sort is stable, so equal ranks preserve input order).
 *
 * In practice every visible folder is kept in `order` (see the store's
 * `syncFolderOrder`), so the "not in order" tail is only a transient — a folder that
 * has just appeared and not yet been reconciled — never a permanent divergence.
 */
export function orderFolders(
  paths: readonly string[],
  order: readonly string[],
): string[] {
  const rank = new Map(order.map((p, i) => [p, i] as const));
  return [...paths].sort(
    (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
  );
}

/**
 * Move `item` so it sits immediately BEFORE `before` in a fresh copy of `list`
 * (or at the END when `before` is null). The standard list-reorder a drag reduces
 * to: "drop A onto B" → A lands just above B.
 *
 * Robust to inputs a drag can produce:
 *   - `item` absent from `list` → it is INSERTED (a drag can seed a not-yet-listed
 *     path); `moveFolder` relies on this so it need not pre-check membership.
 *   - `before` absent (or === `item`) → `item` goes to the end.
 * Never mutates `list`.
 */
export function moveBefore<T>(list: readonly T[], item: T, before: T | null): T[] {
  const without = list.filter((x) => x !== item);
  if (before === null || before === item) return [...without, item];
  const i = without.indexOf(before);
  if (i < 0) return [...without, item];
  return [...without.slice(0, i), item, ...without.slice(i)];
}

/**
 * Append any of `paths` not already in `order`, preserving both `order` and the
 * incoming order of the new ones. Returns the SAME array reference when nothing was
 * added, so a caller can cheaply skip a persist/re-render when discovery changed
 * nothing (the store leans on this to avoid a write per telemetry tick).
 */
export function appendMissing(
  order: readonly string[],
  paths: readonly string[],
): string[] {
  const known = new Set(order);
  const additions = paths.filter((p) => !known.has(p));
  if (additions.length === 0) return order as string[];
  return [...order, ...additions];
}
