/**
 * User-defined ordering for a level of the database tree: tables can be moved into any
 * order the user chooses, for example turning A,B,C into C,B,A.
 *
 * Pure, and deliberately generic over the child type: the tree's node shape belongs to
 * `DbTree`, the persistence belongs to Rust, and the part with the actual decisions in it —
 * what happens to a saved order when the schema underneath it changes — belongs here, where
 * a test can reach every branch without a database (a test must never need Docker or a
 * live connection to prove the logic).
 *
 * ## The model: an explicit order, and everything else after it
 *
 * A saved order is a list of child keys in display order. Rendering applies it as:
 *
 *   1. keys the order names, in the order's sequence;
 *   2. then every key it does NOT name, in the order they arrived — which is alphabetical,
 *      because the Rust engines all `ORDER BY`;
 *   3. keys the order names that no longer exist are skipped.
 *
 * Rules 2 and 3 are the whole point, and they are why this is not a plain array swap. A
 * saved order is a snapshot of a schema that keeps changing underneath it: a table gets
 * created, another gets dropped, someone runs a migration between two app launches. An
 * order that only worked while the schema stood still would break silently — tables
 * vanishing from the tree because they were not in a list written last week is the kind of
 * bug that reads as "the IDE lost my table".
 *
 * **A new table lands at the bottom, not in its alphabetical slot.** Once a level is
 * hand-ordered there is no alphabetical slot to land in — position no longer means anything
 * about the name. The bottom is the one position that is predictable and that never
 * reshuffles what the user arranged.
 *
 * ## Relationship to `app/folderOrder.ts`
 *
 * `orderFolders(paths, order)` there is the string-only sibling of `applyOrder` and follows
 * the SAME rule for unnamed items (ranked first, unranked after in arrival order — it gets
 * there via a stable sort with rank `Infinity`, this gets there by a second pass; same
 * output). The drag primitive is not re-implemented here at all: `moveBefore` below wraps
 * the one in `folderOrder.ts`, because two copies of the same reduce are exactly how two
 * rails end up disagreeing about what a drop means.
 *
 * The two ordering functions stay separate for two reasons, neither of them cosmetic:
 *
 *   - **Type.** The db tree's children are node OBJECTS, not paths. `orderFolders` would
 *     force the caller to project to keys, sort, and then re-associate nodes back to
 *     strings on every render of an expanded level. `keyOf` does it in one pass.
 *   - **Lifecycle.** Their unordered tails mean opposite things. The folder rail keeps
 *     every visible folder inside `folderOrder` (`syncFolderOrder` + `appendMissing`), so
 *     its tail is a transient that reconciliation is expected to drain. Here the tail is
 *     PERMANENT and load-bearing: an untouched schema has an EMPTY order, and a new table
 *     is *supposed* to live in the tail forever until someone drags it. Merging the two
 *     would mean one of them silently acquiring the other's reconciliation contract.
 */

// The generic list-move every drag reduces to, imported rather than copied. See the
// `moveBefore` wrapper at the bottom for the single gesture difference the db tree needs.
import { moveBefore as moveInList } from "../../app/folderOrder";

/** A saved order: child keys, in the sequence the user put them in. */
export type TreeOrder = readonly string[];

/**
 * Order `items` by `order`, appending anything the order does not name.
 *
 * An empty order returns `items` untouched — the overwhelmingly common case (nobody has
 * dragged anything), so it costs one length check rather than a sort.
 */
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
    // A duplicate key in a saved order would otherwise render the same table twice. It
    // should be impossible — sibling names are unique — but a file on disk is not a thing
    // this module gets to assume is well-formed. First occurrence wins, so the rendered
    // position matches the first thing a human reading the file would expect.
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

/**
 * True when two orders would render identically, so the caller can avoid writing a file and
 * re-rendering for a drag that put the row back where it started.
 */
export function sameOrder(a: TreeOrder, b: TreeOrder): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * The order produced by dropping `moved` immediately before `before` — or at the end when
 * `before` is null (a drop past the last row).
 *
 * `current` is the keys **as they are displayed right now**, which is what makes this
 * simple: there is no "materialise the implicit alphabetical order on the first drag" step,
 * because the caller always has the complete visible list and passes it. The result is
 * therefore always a total order over what is on screen.
 *
 * A WRAPPER rather than a bare re-export, for exactly one difference. `folderOrder`'s
 * primitive treats `before === item` as "move to the end" (there is no 'before myself' in a
 * list), but in this tree that call comes from a real gesture: releasing a dragged row over
 * itself. Sending the table to the bottom of the schema because the user picked a row up
 * and put it down again is not a defensible outcome, so it is a no-op here.
 *
 * The other edge cases delegate unchanged, including `moved` not being in `current` — the
 * primitive inserts it. That is the right call even here: rejecting the whole move would
 * silently discard a drag the user really performed, whereas the worst case of inserting is
 * a key naming nothing, which `applyOrder`'s rule 3 already skips.
 */
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
