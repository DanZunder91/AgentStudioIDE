/** Integers compare as BigInt (NUMERIC exceeds MAX_SAFE_INTEGER), NULL sorts last both ways, and
 * datetimes compare as instants (offsets differ). Reorders only the fetched rows, never re-runs
 * with ORDER BY (guard.rs is no SQL authority), so a truncated result sorts only its page. */

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

/** Always ASCENDING; the caller flips it for descending, so direction lives in one place. */
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

/** Stable (Array#sort), so ties keep the server's order. */
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

/** asc, desc, then unsorted: the only way back to the server's order. New columns start at asc. */
export function nextSort(current: SortState | null, columnIndex: number): SortState | null {
  if (current === null || current.columnIndex !== columnIndex) {
    return { columnIndex, direction: "asc" };
  }
  return current.direction === "asc" ? { columnIndex, direction: "desc" } : null;
}
