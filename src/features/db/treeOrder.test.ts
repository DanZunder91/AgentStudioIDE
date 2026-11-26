/** The cases that matter are mismatches between a saved order and the current schema: tables
 * created or dropped, or a malformed file on disk. */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyOrder, moveBefore, sameOrder, type TreeOrder } from "./treeOrder";

/** The real shape: children are NODES, not strings — `keyOf` is what earns the generic. */
type Table = { readonly name: string; readonly rows: number };
const t = (name: string, rows = 0): Table => ({ name, rows });
const nameOf = (table: Table) => table.name;
const namesOf = (tables: readonly Table[]) => tables.map(nameOf);

describe("applyOrder — a saved order meeting a schema that has moved on", () => {
  it("returns the items untouched when the order is empty", () => {
    // The overwhelmingly common case: nobody has ever dragged anything in this connection,
    // so the engine's `ORDER BY` result IS the display order.
    const items = [t("accounts"), t("blocks"), t("customers")];
    expect(applyOrder(items, nameOf, [])).toEqual(items);
  });

  it("reorders A,B,C to C,B,A — the reference example", () => {
    const items = [t("A"), t("B"), t("C")];
    expect(namesOf(applyOrder(items, nameOf, ["C", "B", "A"]))).toEqual(["C", "B", "A"]);
  });

  it("puts the items the order names first and the rest after, in arrival order", () => {
    // A partial order is what a real connection looks like: the user dragged the two tables
    // they care about to the top and never touched the other forty. Those forty must keep
    // arriving alphabetically (rule 2), not shuffle on every refresh.
    const items = [t("accounts"), t("blocks"), t("customers"), t("deposits")];
    expect(namesOf(applyOrder(items, nameOf, ["deposits", "blocks"]))).toEqual([
      "deposits",
      "blocks",
      "accounts",
      "customers",
    ]);
  });

  it("lands a NEWLY created table at the bottom, not in its alphabetical slot", () => {
    // Once a level is hand-ordered there is no alphabetical slot; the bottom is predictable.
    const items = [t("aardvark"), t("customers"), t("blocks")];
    expect(namesOf(applyOrder(items, nameOf, ["customers", "blocks"]))).toEqual([
      "customers",
      "blocks",
      "aardvark",
    ]);
  });

  it("skips a key naming a table that no longer exists, and renders the rest", () => {
    // Someone dropped `sessions` in a migration between two launches. Rule 3: the key is
    // skipped. The failure this prevents is a blank row in the tree — or worse, an
    // `undefined` reaching the renderer and taking the whole level down with it.
    const items = [t("accounts"), t("blocks")];
    expect(namesOf(applyOrder(items, nameOf, ["sessions", "blocks", "accounts"]))).toEqual([
      "blocks",
      "accounts",
    ]);
  });

  it("survives an order in which EVERY key is gone", () => {
    // The whole schema was replaced (a different database behind the same connection). The
    // order names nothing that exists, so it contributes nothing and arrival order stands.
    const items = [t("accounts"), t("blocks")];
    expect(namesOf(applyOrder(items, nameOf, ["gone", "also_gone"]))).toEqual([
      "accounts",
      "blocks",
    ]);
  });

  it("renders an item once when a saved order names it twice", () => {
    // Sibling table names are unique, so a duplicate key should be impossible — but the
    // order arrives from a FILE, and this module does not get to assume a file is
    // well-formed. Rendering `blocks` twice would be a phantom table in the tree.
    const items = [t("accounts"), t("blocks")];
    const out = applyOrder(items, nameOf, ["blocks", "accounts", "blocks"]);
    expect(namesOf(out)).toEqual(["blocks", "accounts"]);
  });

  it("does not mutate the items it was handed", () => {
    // The caller's array is React state; ordering it in place would be a render-time
    // mutation that survives past the render that caused it.
    const items = [t("accounts"), t("blocks"), t("customers")];
    applyOrder(items, nameOf, ["customers", "accounts"]);
    expect(namesOf(items)).toEqual(["accounts", "blocks", "customers"]);
  });

  it("returns a fresh array even on the empty-order fast path", () => {
    // The fast path is a length check, not a "return the input" — otherwise a caller that
    // sorts the result would reach back into its own state through the alias.
    const items = [t("accounts")];
    expect(applyOrder(items, nameOf, [])).not.toBe(items);
  });

  it("matches orderFolders' rule for unnamed items, on plain strings", () => {
    // Pins this to `orderFolders` (app/folderOrder.ts): one ordering rule, or the rails and the db
    // tree sort unnamed items differently.
    const paths = ["/x", "/a", "/y"];
    expect(applyOrder(paths, (p) => p, ["/a"])).toEqual(["/a", "/x", "/y"]);
  });
});

describe("sameOrder — the write this saves is the one that changed nothing", () => {
  it("is true for two orders with the same keys in the same sequence", () => {
    expect(sameOrder(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
  });

  it("is true for two empty orders", () => {
    expect(sameOrder([], [])).toBe(true);
  });

  it("is false when the sequence differs", () => {
    // Same set, different render — the whole point of the feature, so it must be a write.
    expect(sameOrder(["a", "b", "c"], ["c", "b", "a"])).toBe(false);
  });

  it("is false when one order has an extra key", () => {
    // Length is checked first; without it `every` over the shorter array would call a
    // prefix a match and a newly discovered table would never be persisted.
    expect(sameOrder(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(sameOrder(["a", "b", "c"], ["a", "b"])).toBe(false);
  });

  it("is false when the keys differ entirely", () => {
    expect(sameOrder(["a"], ["b"])).toBe(false);
  });

  it("compares by value, not by array identity", () => {
    // A store that rebuilds the order array on every refresh would otherwise write to disk
    // on every tick.
    const a: TreeOrder = ["a", "b"];
    const b: TreeOrder = ["a", "b"];
    expect(a).not.toBe(b);
    expect(sameOrder(a, b)).toBe(true);
  });
});

describe("moveBefore — the drop gesture", () => {
  it("drops a row immediately above the row it was released over", () => {
    expect(moveBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("moves the first row to last when dropped past the end (before = null)", () => {
    expect(moveBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("moves the last row to first", () => {
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("is a NO-OP when a row is dropped onto itself", () => {
    // Unlike folderOrder's primitive: a drop on itself must not move to the end or report a
    // change, or every aborted drag writes a file.
    const current = ["a", "b", "c"];
    const out = moveBefore(current, "b", "b");
    expect(out).toEqual(["a", "b", "c"]);
    expect(sameOrder(current, out)).toBe(true);
    expect(out).not.toBe(current); // a copy, so the caller can never alias its own state
  });

  it("appends when the anchor row is not in the list", () => {
    // A concurrent refresh dropped the table the pointer was over. Appending is a defined
    // outcome; guessing an index from a row that no longer exists is not.
    expect(moveBefore(["a", "b"], "a", "gone")).toEqual(["b", "a"]);
  });

  it("inserts a key that is not yet in the list rather than discarding the drag", () => {
    // Delegated behaviour, kept deliberately: the visible list should always contain the
    // dragged key, but if it somehow does not, silently ignoring the user's drag is worse
    // than a stray key — `applyOrder` rule 3 skips a key that names nothing.
    expect(moveBefore(["a", "b"], "z", "a")).toEqual(["z", "a", "b"]);
  });

  it("handles a single-row level", () => {
    expect(moveBefore(["a"], "a", null)).toEqual(["a"]);
    expect(moveBefore(["a"], "a", "a")).toEqual(["a"]);
  });

  it("does not mutate the order it was handed", () => {
    const current = ["a", "b", "c"];
    moveBefore(current, "c", "a");
    expect(current).toEqual(["a", "b", "c"]);
  });

  it("composes: A,B,C to C,B,A in the two drags a user would actually perform", () => {
    // End to end through the gesture rather than through a hand-written order, because the
    // saved order is produced BY this function — if it and applyOrder disagree, the tree
    // renders something the user did not drag.
    const items = [t("A"), t("B"), t("C")];
    const afterFirst = moveBefore(namesOf(items), "C", "A"); // drag C above A
    const afterSecond = moveBefore(afterFirst, "B", "A"); // drag B above A
    expect(afterSecond).toEqual(["C", "B", "A"]);
    expect(namesOf(applyOrder(items, nameOf, afterSecond))).toEqual(["C", "B", "A"]);
  });
});

// The invariant: reordering never drops, duplicates or invents a row; a permutation check
// catches every shape of that bug.
describe("property: reordering never loses, duplicates, or invents a row", () => {
  /** Distinct sibling keys — table names at one level are unique by construction. */
  const keysArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
    minLength: 1,
    maxLength: 8,
  });

  /** A whole drag: the visible keys, the row picked up, and the row released over. */
  const dragArb = keysArb.chain((keys) =>
    fc.record({
      keys: fc.constant(keys),
      moved: fc.constantFrom(...keys),
      before: fc.oneof(fc.constantFrom(...keys), fc.constant(null)),
    }),
  );

  /** Multiset equality — "same rows, any order". */
  const expectSameRows = (actual: readonly string[], expected: readonly string[]) => {
    expect([...actual].sort()).toEqual([...expected].sort());
  };

  it("moveBefore returns a permutation of the list it was given", () => {
    fc.assert(
      fc.property(dragArb, ({ keys, moved, before }) => {
        const out = moveBefore(keys, moved, before);
        expect(out).toHaveLength(keys.length);
        expectSameRows(out, keys);
      }),
    );
  });

  it("moveBefore stays a permutation across a long chain of drags", () => {
    // One move being safe does not make a session of moves safe: the output of each drag is
    // the input of the next, so a defect that only shows up on an already-reordered list
    // (an index computed against the pre-move array, say) needs iteration to surface.
    fc.assert(
      fc.property(
        keysArb.chain((keys) =>
          fc.record({
            keys: fc.constant(keys),
            drags: fc.array(
              fc.record({
                moved: fc.constantFrom(...keys),
                before: fc.oneof(fc.constantFrom(...keys), fc.constant(null)),
              }),
              { maxLength: 12 },
            ),
          }),
        ),
        ({ keys, drags }) => {
          let order: readonly string[] = keys;
          for (const { moved, before } of drags) order = moveBefore(order, moved, before);
          expectSameRows(order, keys);
        },
      ),
    );
  });

  it("applyOrder renders every item exactly once, for ANY saved order", () => {
    // Draw the order from the live keys plus junk, with repeats: random strings almost never
    // collide with a key, so the duplicate branch would never run.
    const orderArb = keysArb.chain((keys) =>
      fc.record({
        keys: fc.constant(keys),
        order: fc.array(
          fc.oneof(
            { weight: 3, arbitrary: fc.constantFrom(...keys) },
            { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 6 }) },
          ),
          { maxLength: 12 },
        ),
      }),
    );
    fc.assert(
      fc.property(orderArb, ({ keys, order }) => {
        const items = keys.map((k) => t(k));
        expectSameRows(namesOf(applyOrder(items, nameOf, order)), keys);
      }),
    );
  });

  it("applyOrder is idempotent: re-applying the order it produced changes nothing", () => {
    // The tree re-renders on every refresh with the same saved order. If a second
    // application moved anything, rows would drift on their own while nobody dragged.
    fc.assert(
      fc.property(dragArb, ({ keys, moved, before }) => {
        const items = keys.map((k) => t(k));
        const order = moveBefore(keys, moved, before);
        const once = applyOrder(items, nameOf, order);
        const twice = applyOrder(once, nameOf, order);
        expect(namesOf(twice)).toEqual(namesOf(once));
      }),
    );
  });

  it("a drag's result IS what the tree renders — the two halves agree", () => {
    // The seam: `moveBefore` writes the order and `applyOrder` reads it. Each being
    // individually correct is not the guarantee the user cares about; the guarantee is that
    // the row lands where they dropped it.
    fc.assert(
      fc.property(dragArb, ({ keys, moved, before }) => {
        const items = keys.map((k) => t(k));
        const order = moveBefore(keys, moved, before);
        expect(namesOf(applyOrder(items, nameOf, order))).toEqual(order);
      }),
    );
  });
});
