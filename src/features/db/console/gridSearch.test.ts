/**
 * Searching a query result. Pure, so the ordering and the edge cells are pinned
 * without a DOM or a scroll box.
 */

import { describe, expect, it } from "vitest";

import { findCells, matchRange, scrollToRow } from "./gridSearch";

const ROWS: (string | null)[][] = [
  ["region:137", "PO9a5317e289", "shipped"],
  ["region:1", null, "pending"],
  ["REGION:137", "POAB62CB85", "shipped"],
];

describe("findCells", () => {
  it("returns hits row-major — the order the eye reads", () => {
    // Next must walk left-to-right then down, not column by column.
    expect(findCells(ROWS, "shipped")).toEqual([
      { row: 0, col: 2 },
      { row: 2, col: 2 },
    ]);
  });

  it("is case-insensitive in both directions", () => {
    expect(findCells(ROWS, "region:137")).toEqual([
      { row: 0, col: 0 },
      { row: 2, col: 0 },
    ]);
    expect(findCells(ROWS, "poab62cb85")).toEqual([{ row: 2, col: 1 }]);
  });

  it("matches a fragment, which is how an order code is actually searched", () => {
    expect(findCells(ROWS, "5317e2")).toEqual([{ row: 0, col: 1 }]);
  });

  it("never matches NULL — not by 'null', not by the empty string", () => {
    // A NULL cell is drawn as the word NULL. Matching that word would find every
    // empty cell whenever someone searched for it in a text column.
    expect(findCells(ROWS, "null")).toEqual([]);
    expect(findCells([[null]], "n")).toEqual([]);
  });

  it("treats a blank query as no search rather than as everything", () => {
    // The bar is open while the user is still typing.
    expect(findCells(ROWS, "")).toEqual([]);
    expect(findCells(ROWS, "   ")).toEqual([]);
  });

  it("matches an empty-string cell only on a real query", () => {
    // `""` is a value, distinct from NULL — but nothing is a fragment of it.
    expect(findCells([[""]], "x")).toEqual([]);
  });

  it("is literal — a pasted value with regex punctuation is not a pattern", () => {
    const rows = [["a.c"], ["abc"]];
    expect(findCells(rows, "a.c")).toEqual([{ row: 0, col: 0 }]);
  });
});

describe("matchRange", () => {
  it("locates the first occurrence, preserving the original case", () => {
    expect(matchRange("POAB62CB85", "ab62")).toEqual({ from: 2, to: 6 });
  });

  it("marks only the FIRST occurrence in a cell", () => {
    // The bar counts CELLS; a second mark would make the count and the highlights
    // disagree about how many matches there are.
    expect(matchRange("abab", "ab")).toEqual({ from: 0, to: 2 });
  });

  it("returns null for no match and for a blank query", () => {
    expect(matchRange("abc", "zzz")).toBeNull();
    expect(matchRange("abc", "  ")).toBeNull();
  });
});

describe("scrollToRow", () => {
  const H = 24; // row height
  const HEADER = 40;

  it("does not move when the row is already visible", () => {
    // Stepping through matches that share a screen must not yank the grid.
    expect(scrollToRow(5, 0, 400, H, HEADER)).toBeNull();
  });

  it("scrolls down to a row below the fold", () => {
    const top = scrollToRow(100, 0, 400, H, HEADER);
    expect(top).not.toBeNull();
    expect(top!).toBeGreaterThan(0);
    // …and lands the row clear of the sticky header rather than under it.
    expect(top!).toBeLessThanOrEqual(100 * H - HEADER);
  });

  it("scrolls up to a row above the current window", () => {
    expect(scrollToRow(1, 2_000, 400, H, HEADER)).toBeLessThan(2_000);
  });

  it("never returns a negative scroll position", () => {
    // Row 0 with a header taller than the row would otherwise go negative.
    expect(scrollToRow(0, 500, 400, H, HEADER)).toBe(0);
  });

  it("counts the sticky header as covering the top of the box", () => {
    // A row sitting exactly under the header is NOT visible, and the naive
    // `top >= scrollTop` test would wrongly say it is.
    expect(scrollToRow(1, H, 400, H, HEADER)).not.toBeNull();
  });
});
