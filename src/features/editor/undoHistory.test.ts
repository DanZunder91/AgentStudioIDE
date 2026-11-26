/** Opaque marker payloads (only the registry knows it is `EditorState.toJSON`). Pins the
 * doc-identity guard, consume-on-take and the bounds; close→reopen end to end is in
 * `undoAcrossSaveAndClose.test.tsx`. */

import { afterEach, describe, expect, it } from "vitest";

import {
  clearUndoCache,
  rememberUndo,
  takeUndo,
  undoCacheSize,
  type UndoSnapshot,
} from "./undoHistory";

/** A stand-in for the CM6 state JSON — identity is all this module cares about. */
const stack = (id: string): UndoSnapshot["json"] => ({ marker: id });

/** The registry's read-only gate, mirrored: `TOO_BIG` is 2 MB. */
const TWO_MB = 2_000_000;

afterEach(() => clearUndoCache()); // module singleton — never leak between tests

describe("undoHistory", () => {
  it("hands the stack back when the file on disk is byte-for-byte unchanged", () => {
    rememberUndo("/w/a.ts", stack("a"), "hello\n");
    expect(undoCacheSize()).toBe(1);

    expect(takeUndo("/w/a.ts", "hello\n")).toEqual(stack("a"));
  });

  it("returns null for a path that was never remembered", () => {
    expect(takeUndo("/w/never-opened.ts", "hello\n")).toBeNull();
  });

  it("DROPS the stack when the file changed on disk while closed", () => {
    rememberUndo("/w/a.ts", stack("a"), "hello\n");

    // Two-sided: the very same snapshot WOULD have come back for
    // the unchanged text — so it is the mismatch doing the work, not an empty
    // cache. A single trailing space is enough to invalidate it, and must be.
    expect(takeUndo("/w/a.ts", "hello \n")).toBeNull();
    rememberUndo("/w/a.ts", stack("a"), "hello\n");
    expect(takeUndo("/w/a.ts", "hello\n")).toEqual(stack("a"));
  });

  it("consumes a MISMATCHED snapshot too — it can never be handed to a later reopen", () => {
    rememberUndo("/w/a.ts", stack("a"), "hello\n");

    expect(takeUndo("/w/a.ts", "rewritten by an agent\n")).toBeNull();
    expect(undoCacheSize()).toBe(0);
    // Even if the file is later restored to exactly the old text, the stale stack
    // is gone: a snapshot that once failed its identity check stays failed.
    expect(takeUndo("/w/a.ts", "hello\n")).toBeNull();
  });

  it("consumes the snapshot on a SUCCESSFUL take — a second reopen starts clean", () => {
    rememberUndo("/w/a.ts", stack("a"), "hello\n");

    expect(takeUndo("/w/a.ts", "hello\n")).toEqual(stack("a"));
    expect(undoCacheSize()).toBe(0);
    expect(takeUndo("/w/a.ts", "hello\n")).toBeNull();
  });

  it("keeps paths independent — taking one leaves the others parked", () => {
    rememberUndo("/w/a.ts", stack("a"), "A");
    rememberUndo("/w/b.ts", stack("b"), "B");

    expect(takeUndo("/w/a.ts", "A")).toEqual(stack("a"));
    expect(takeUndo("/w/b.ts", "B")).toEqual(stack("b"));
  });

  it("re-remembering a path REPLACES its snapshot (the newer close wins)", () => {
    rememberUndo("/w/a.ts", stack("old"), "v1");
    rememberUndo("/w/a.ts", stack("new"), "v2");

    expect(undoCacheSize()).toBe(1); // replaced, not appended
    expect(takeUndo("/w/a.ts", "v1")).toBeNull(); // the old doc no longer matches
  });

  describe("bounds", () => {
    it("holds at most 24 paths, evicting the least-recently-remembered", () => {
      // The size is the "f0 is still here" check: `takeUndo` would consume it, and re-remembering
      // it would make it the newest.
      for (let i = 0; i < 24; i++) rememberUndo(`/w/f${i}.ts`, stack(`${i}`), "x");
      expect(undoCacheSize()).toBe(24);

      rememberUndo("/w/f24.ts", stack("24"), "x"); // the 25th

      expect(undoCacheSize()).toBe(24); // capped, not grown
      expect(takeUndo("/w/f0.ts", "x")).toBeNull(); // oldest evicted…
      expect(takeUndo("/w/f1.ts", "x")).toEqual(stack("1")); // …and only the oldest
      expect(takeUndo("/w/f24.ts", "x")).toEqual(stack("24")); // newest kept
    });

    it("re-remembering refreshes recency — the touched path is no longer the oldest", () => {
      for (let i = 0; i < 24; i++) rememberUndo(`/w/f${i}.ts`, stack(`${i}`), "x");

      rememberUndo("/w/f0.ts", stack("0-again"), "x"); // touched → moves to newest
      rememberUndo("/w/f24.ts", stack("24"), "x"); // forces one eviction

      expect(takeUndo("/w/f0.ts", "x")).toEqual(stack("0-again")); // survived
      expect(takeUndo("/w/f1.ts", "x")).toBeNull(); // f1 was the oldest instead
    });

    it("parks nothing for a doc past the 2 MB read-only threshold", () => {
      const huge = "x".repeat(TWO_MB + 1);
      rememberUndo("/w/huge.log", stack("huge"), huge);

      expect(undoCacheSize()).toBe(0);
      expect(takeUndo("/w/huge.log", huge)).toBeNull();
    });

    it("still parks a doc exactly AT the threshold (the boundary is `>`, not `>=`)", () => {
      const atLimit = "x".repeat(TWO_MB);
      rememberUndo("/w/big.log", stack("big"), atLimit);

      expect(undoCacheSize()).toBe(1);
      expect(takeUndo("/w/big.log", atLimit)).toEqual(stack("big"));
    });
  });

  it("clearUndoCache() empties it (what disposeAll uses for test isolation)", () => {
    rememberUndo("/w/a.ts", stack("a"), "A");
    rememberUndo("/w/b.ts", stack("b"), "B");
    expect(undoCacheSize()).toBe(2);

    clearUndoCache();

    expect(undoCacheSize()).toBe(0);
    expect(takeUndo("/w/a.ts", "A")).toBeNull();
  });
});
