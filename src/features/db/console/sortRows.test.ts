/**
 * Sorting the results grid. Pure, so every way "sort a column of strings" is
 * wrong for database output gets its own case.
 */

import { describe, expect, it } from "vitest";

import { compareCells, nextSort, sortRows, type SortState } from "./sortRows";

/** Sort one column of single-cell rows and read the values back. */
const order = (values: (string | null)[], kind: Parameters<typeof compareCells>[0], dir: "asc" | "desc" = "asc") =>
  sortRows(values.map((v) => [v]), { columnIndex: 0, direction: dir }, kind).map((r) => r[0]);

describe("compareCells — numbers", () => {
  it("orders by VALUE, not by text width", () => {
    // A wide integer column: as text, the shorter one would win.
    expect(compareCells("number", "2468013579246801357", "7531975319753197")).toBeGreaterThan(0);
    expect(order(["100", "9", "80"], "number")).toEqual(["9", "80", "100"]);
  });

  it("keeps integers past Number.MAX_SAFE_INTEGER distinct", () => {
    // Both round to the same double; only BigInt can tell them apart, and a
    // comparator that says they are equal silently mis-orders the column.
    const a = "9007199254740993";
    const b = "9007199254740992";
    expect(Number(a) === Number(b)).toBe(true); // the trap, stated
    expect(compareCells("number", a, b)).toBeGreaterThan(0);
  });

  it("handles negatives, signs and decimals", () => {
    expect(order(["-5", "3", "-10", "0"], "number")).toEqual(["-10", "-5", "0", "3"]);
    expect(order(["1.5", "1.25", "10.1"], "number")).toEqual(["1.25", "1.5", "10.1"]);
    expect(compareCells("number", "+7", "7")).toBe(0);
  });

  it("falls back to text when a numeric column holds something unparseable", () => {
    // Never NaN: NaN compares false against everything and would scatter rows.
    expect(order(["abc", "12", "zzz"], "number")).toEqual(["12", "abc", "zzz"]);
  });
});

describe("compareCells — datetimes", () => {
  it("compares INSTANTS, so offsets do not sort apart", () => {
    // The same moment written two ways: lexicographically these are far apart.
    expect(compareCells("datetime", "2026-08-25 13:51:06+00", "2026-08-25 09:51:06-04")).toBe(0);
  });

  it("orders chronologically", () => {
    expect(
      order(["2026-08-25 13:57:25+00", "2026-07-31 07:57:59+00", "2026-08-25 05:52:22+00"], "datetime"),
    ).toEqual([
      "2026-07-31 07:57:59+00",
      "2026-08-25 05:52:22+00",
      "2026-08-25 13:57:25+00",
    ]);
  });

  it("falls back to text for a value that will not parse", () => {
    expect(order(["not-a-date", "2026-01-01"], "datetime")).toEqual([
      "2026-01-01",
      "not-a-date",
    ]);
  });
});

describe("compareCells — booleans and text", () => {
  it("puts false before true, whatever the engine spells them", () => {
    expect(order(["t", "f"], "bool")).toEqual(["f", "t"]);
    expect(order(["true", "false"], "bool")).toEqual(["false", "true"]);
    expect(order(["1", "0"], "bool")).toEqual(["0", "1"]);
  });

  it("orders text by code point, not by locale", () => {
    // A locale-aware sort would make an id column reorder itself per machine.
    expect(order(["b", "A", "a"], "text")).toEqual(["A", "a", "b"]);
  });

  it("treats the empty string as a value, distinct from NULL", () => {
    // `""` is the empty string, `null` is SQL NULL — they are different
    // facts and must not sort together.
    expect(order(["b", "", null, "a"], "text")).toEqual(["", "a", "b", null]);
  });
});

describe("sortRows", () => {
  it("puts NULLs last in BOTH directions", () => {
    // Flipping them to the top on desc would bury what the user asked to see.
    expect(order(["b", null, "a"], "text", "asc")).toEqual(["a", "b", null]);
    expect(order(["b", null, "a"], "text", "desc")).toEqual(["b", "a", null]);
  });

  it("is stable — ties keep the server's order", () => {
    const rows = [
      ["x", "first"],
      ["x", "second"],
      ["a", "third"],
    ];
    const sorted = sortRows(rows, { columnIndex: 0, direction: "asc" }, "text");
    expect(sorted.map((r) => r[1])).toEqual(["third", "first", "second"]);
  });

  it("does not mutate the rows it was given", () => {
    const rows = [["b"], ["a"]];
    sortRows(rows, { columnIndex: 0, direction: "asc" }, "text");
    // The grid re-sorts on every render; mutating the store's array would make
    // the unsorted state unrecoverable.
    expect(rows.map((r) => r[0])).toEqual(["b", "a"]);
  });

  it("treats a missing cell as NULL rather than throwing", () => {
    // A ragged row should never take the grid down.
    const sorted = sortRows([["a"], []], { columnIndex: 0, direction: "asc" }, "text");
    expect(sorted[0][0]).toBe("a");
  });

  it("sorts by the named column, not the first one", () => {
    const rows = [
      ["z", "1"],
      ["a", "2"],
    ];
    const sorted = sortRows(rows, { columnIndex: 1, direction: "desc" }, "number");
    expect(sorted.map((r) => r[0])).toEqual(["a", "z"]);
  });
});

describe("compareCells — ties, in every kind", () => {
  it("reports equal for identical values, whichever path they take", () => {
    // A comparator that never returns 0 makes `sort` unstable in practice: ties
    // would be ordered by whatever the engine's pivot happened to do.
    expect(compareCells("number", "42", "42")).toBe(0); // BigInt path
    expect(compareCells("number", "1.5", "1.5")).toBe(0); // decimal path
    expect(compareCells("number", "abc", "abc")).toBe(0); // text fallback
    expect(compareCells("datetime", "2026-01-01", "2026-01-01")).toBe(0);
    expect(compareCells("datetime", "nope", "nope")).toBe(0); // text fallback
    expect(compareCells("bool", "t", "true")).toBe(0); // same value, two spellings
    expect(compareCells("bool", "f", "no")).toBe(0);
    expect(compareCells("text", "x", "x")).toBe(0);
  });

  it("is antisymmetric in every fallback path", () => {
    // Both arms of each ternary: swapping the arguments flips the sign.
    expect(compareCells("number", "zzz", "abc")).toBeGreaterThan(0);
    expect(compareCells("number", "abc", "zzz")).toBeLessThan(0);
    expect(compareCells("datetime", "zzz", "abc")).toBeGreaterThan(0);
    expect(compareCells("datetime", "abc", "zzz")).toBeLessThan(0);
    expect(compareCells("text", "b", "a")).toBeGreaterThan(0);
  });

  it("keeps two NULLs together rather than ordering them", () => {
    const sorted = sortRows(
      [[null], ["a"], [null]],
      { columnIndex: 0, direction: "asc" },
      "text",
    );
    expect(sorted.map((r) => r[0])).toEqual(["a", null, null]);
  });
});

describe("nextSort", () => {
  it("cycles unsorted → asc → desc → unsorted on the same column", () => {
    let s: SortState | null = null;
    s = nextSort(s, 2);
    expect(s).toEqual({ columnIndex: 2, direction: "asc" });
    s = nextSort(s, 2);
    expect(s).toEqual({ columnIndex: 2, direction: "desc" });
    // Back to the SERVER's order — the only way to undo a sort.
    s = nextSort(s, 2);
    expect(s).toBeNull();
  });

  it("starts a different column at ascending", () => {
    expect(nextSort({ columnIndex: 2, direction: "desc" }, 5)).toEqual({
      columnIndex: 5,
      direction: "asc",
    });
  });
});
