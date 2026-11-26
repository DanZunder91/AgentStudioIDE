/** Every expectation is a hand-written literal: one derived from the output proves nothing. */

import { describe, expect, it } from "vitest";

import { sortJsonKeys } from "./jsonSort";

/** Recursively freeze — any strict-mode write at any level throws TypeError. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("sortJsonKeys", () => {
  it("sorts keys recursively, values traveling with their keys", () => {
    const result = sortJsonKeys({ b: { d: "dee", c: "cee" }, a: "ay" }) as {
      a: string;
      b: { c: string; d: string };
    };
    expect(result).toEqual({ a: "ay", b: { c: "cee", d: "dee" } });
    // toEqual ignores key order — pin it explicitly, outer and nested.
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b)).toEqual(["c", "d"]);
  });

  it("keeps array order but sorts the objects inside arrays", () => {
    const result = sortJsonKeys([
      { b: 1, a: 2 },
      { d: 3, c: 4 },
      "tail",
    ]) as [Record<string, number>, Record<string, number>, string];
    // Array order is data — element 0 stays element 0 (toEqual checks indices).
    expect(result).toEqual([{ a: 2, b: 1 }, { c: 4, d: 3 }, "tail"]);
    expect(Object.keys(result[0])).toEqual(["a", "b"]);
    expect(Object.keys(result[1])).toEqual(["c", "d"]);
  });

  it("returns new objects/arrays and never mutates the (frozen) input", () => {
    // Frozen input: were the implementation to mutate, strict mode would throw.
    const input = deepFreeze({ b: [{ y: 1, x: 2 }], a: "ay" });
    const result = sortJsonKeys(input) as { a: string; b: { x: number; y: number }[] };
    expect(result).not.toBe(input);
    expect(result.b).not.toBe(input.b);
    expect(result.b[0]).not.toBe(input.b[0]);
    // The input keeps its original (unsorted) key order at every level…
    expect(Object.keys(input)).toEqual(["b", "a"]);
    expect(Object.keys(input.b[0])).toEqual(["y", "x"]);
    // …while the copy is sorted at every level.
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b[0])).toEqual(["x", "y"]);
  });

  it("passes primitives through unchanged", () => {
    expect(sortJsonKeys("hi")).toBe("hi");
    expect(sortJsonKeys(42)).toBe(42);
    expect(sortJsonKeys(true)).toBe(true);
    expect(sortJsonKeys(null)).toBeNull();
    expect(sortJsonKeys(undefined)).toBeUndefined();
  });

  it("orders by UTF-16 code units — uppercase before lowercase, locale-free", () => {
    // Code units: "A"(0x41) < "Z"(0x5A) < "_"(0x5F) < "a"(0x61) < "b"(0x62).
    // A locale-aware sort would interleave the cases (a, A, b, …, Z); pinning
    // code-unit order is what makes pane A and pane B agree on every machine.
    const result = sortJsonKeys({ a: 1, Z: 2, b: 3, _: 4, A: 5 });
    expect(Object.keys(result as object)).toEqual(["A", "Z", "_", "a", "b"]);
  });

  it("stops recursing at depth 100 and returns the buried subtree unchanged", () => {
    // 100 wrappers put `deep` at depth 100 — exactly where JsonView stops
    // rendering children (MAX_DEPTH), so sorted-or-not is unobservable there.
    const deep = { z: 1, a: 2 };
    let input: Record<string, unknown> = deep;
    for (let i = 0; i < 100; i += 1) input = { z: input, a: i };

    let node = sortJsonKeys(input) as Record<string, unknown>;
    // Depths 0..99 are sorted copies…
    for (let i = 0; i < 100; i += 1) {
      expect(Object.keys(node)).toEqual(["a", "z"]);
      node = node.z as Record<string, unknown>;
    }
    // …and the node AT the cap is the very same object, key order untouched.
    expect(node).toBe(deep);
    expect(Object.keys(node)).toEqual(["z", "a"]);
  });
});
