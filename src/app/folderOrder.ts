/** The one folder-ordering primitive: both rails sort folders through it by the persisted
 * `folderOrder`, so a drag keeps them in the same order. Dependency-free on purpose. */

/** Stable-sort `paths` by their index in `order`; unlisted paths keep their relative order after
 * the listed ones. That tail is transient: `syncFolderOrder` keeps every visible folder listed. */
export function orderFolders(
  paths: readonly string[],
  order: readonly string[],
): string[] {
  const rank = new Map(order.map((p, i) => [p, i] as const));
  return [...paths].sort(
    (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
  );
}

/** Copy of `list` with `item` just before `before` (at the end if `before` is null, absent or
 * `item`). An absent `item` is inserted, which `moveFolder` relies on. Never mutates `list`. */
export function moveBefore<T>(list: readonly T[], item: T, before: T | null): T[] {
  const without = list.filter((x) => x !== item);
  if (before === null || before === item) return [...without, item];
  const i = without.indexOf(before);
  if (i < 0) return [...without, item];
  return [...without.slice(0, i), item, ...without.slice(i)];
}

/** Append the `paths` missing from `order`, in order. Returns the SAME reference when nothing was
 * added, so the store can skip a persist per telemetry tick. */
export function appendMissing(
  order: readonly string[],
  paths: readonly string[],
): string[] {
  const known = new Set(order);
  const additions = paths.filter((p) => !known.has(p));
  if (additions.length === 0) return order as string[];
  return [...order, ...additions];
}
