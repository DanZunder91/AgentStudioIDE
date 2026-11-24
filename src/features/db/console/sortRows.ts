/**
 * sortRows — ordering the results grid by a column.
 *
 * Pure, so the comparison can be tested exhaustively without a DOM — and it
 * needs to be, because "sort a column of strings" is wrong in three separate
 * ways for real database output.
 *
 * 🔴 **1. Numbers are not their text.** A `NUMERIC` amount column can hold
 * `2468013579246801357` next to `7531975319753197` — as
 * text, the shorter one sorts higher. And values like these are past
 * `Number.MAX_SAFE_INTEGER` (9007199254740991), so parsing them as `number`
 * silently rounds: two different amounts can compare EQUAL. Integers are therefore
 * compared as `BigInt` when both sides are integral, and only fall back to
 * `Number` for genuine decimals.
 *
 * 🔴 **2. NULL is not a value.** It sorts last in BOTH directions rather than
 * flipping with the arrow: the user is looking for the biggest amount or the newest
 * record, and a screenful of empties at the top is never the answer they wanted.
 * (SQL's own default is NULLS LAST for ASC and FIRST for DESC — deliberately not
 * copied, because this is a view over rows already fetched, not a query.)
 *
 * 🔴 **3. A timestamp is not a string** unless every row shares an offset.
 * `2026-08-25 13:51:06+00` and `2026-08-25 09:51:06-04` are the same instant and
 * sort apart lexicographically, so datetimes are parsed and compared as instants,
 * falling back to text when a value will not parse.
 *
 * ## What this deliberately does NOT do
 *
 * It reorders **the rows already fetched** — it never re-runs the query with an
 * `ORDER BY`. Rewriting arbitrary user SQL is not something this app will do
 * (`guard.rs` refuses to be a SQL semantic authority). The consequence is real
 * and the UI states it: on a TRUNCATED result, this sorts the page you have, not
 * the table. Sorting 1,000 of 40,000 rows by amount and calling the top one "the
 * largest amount" would be exactly the kind of quiet lie this codebase keeps
 * refusing.
 */

import type { DbCellKind } from "../types";

/** Which way a column is ordered. `null` = unsorted, in the server's own order. */
export type SortDirection = "asc" | "desc";

export interface SortState {
  columnIndex: number;
  direction: SortDirection;
}

/** One cell as it arrives: `null` is SQL NULL, `""` is the empty string. */
type Cell = string | null;

/** Is every character a digit, with an optional leading sign? */
function isIntegerText(s: string): boolean {
  return /^[+-]?\d+$/.test(s);
}

/**
 * Compare two non-null cells of a column of `kind`.
 *
 * Returns the usual negative / zero / positive, always in ASCENDING order; the
 * caller flips it for descending, so the direction lives in exactly one place.
 */
export function compareCells(kind: DbCellKind, a: string, b: string): number {
  if (kind === "number") {
    // BigInt first: these are the values a `number` would round away.
    if (isIntegerText(a) && isIntegerText(b)) {
      const ba = BigInt(a);
      const bb = BigInt(b);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    }
    const na = Number(a);
    const nb = Number(b);
    // A column typed `number` whose text will not parse (an engine's `Infinity`,
    // a formatted value) falls back to text rather than sorting as NaN, which
    // compares false against everything and would scatter those rows at random.
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (kind === "datetime") {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (kind === "bool") {
    // Whatever the engine spells them, false sorts before true.
    const va = /^(t|true|1|y|yes)$/i.test(a) ? 1 : 0;
    const vb = /^(t|true|1|y|yes)$/i.test(b) ? 1 : 0;
    return va - vb;
  }

  // text / json / binary / unknown: plain code-point order. Deliberately not
  // `localeCompare` — an identifier column reordering itself by the machine's
  // locale is a surprise, and the grid shows raw server text.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A copy of `rows`, ordered by one column.
 *
 * Stable: `Array#sort` is specified stable, so rows that tie keep the order the
 * server sent them in — which is the closest thing to "unsorted" a tie can have.
 */
export function sortRows(
  rows: Cell[][],
  { columnIndex, direction }: SortState,
  kind: DbCellKind,
): Cell[][] {
  const flip = direction === "desc" ? -1 : 1;
  return [...rows].sort((ra, rb) => {
    const a = ra[columnIndex] ?? null;
    const b = rb[columnIndex] ?? null;
    // NULLs last in BOTH directions — see the module doc.
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return flip * compareCells(kind, a, b);
  });
}

/**
 * The next sort state when a header is clicked: unsorted → asc → desc →
 * unsorted, and clicking a different column starts that column at asc.
 *
 * The third click returning to the SERVER's order matters: it is the only way
 * back to the ordering the query itself asked for, and a grid you cannot restore
 * has taken something away.
 */
export function nextSort(current: SortState | null, columnIndex: number): SortState | null {
  if (current === null || current.columnIndex !== columnIndex) {
    return { columnIndex, direction: "asc" };
  }
  return current.direction === "asc" ? { columnIndex, direction: "desc" } : null;
}
