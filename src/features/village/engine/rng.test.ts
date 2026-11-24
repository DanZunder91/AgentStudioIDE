import { describe, expect, it } from "vitest";
import { hash2, hashString, intRange, mulberry32, range } from "./rng";

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it("spreads values across the range", () => {
    const r = mulberry32(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(r() * 10)]++;
    for (const n of buckets) expect(n).toBeGreaterThan(800);
  });
});

describe("hashes", () => {
  it("hashString is stable FNV-1a", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("acb"));
  });

  it("hash2 is deterministic, unsigned and varies with both coordinates", () => {
    expect(hash2(3, 4)).toBe(hash2(3, 4));
    expect(hash2(3, 4)).not.toBe(hash2(4, 3));
    expect(hash2(-5, 9)).toBeGreaterThanOrEqual(0);
    const seen = new Set<number>();
    for (let c = 0; c < 20; c++) for (let r = 0; r < 20; r++) seen.add(hash2(c, r) & 3);
    expect(seen.size).toBe(4);
  });
});

describe("range helpers", () => {
  it("range and intRange respect their bounds", () => {
    const r = mulberry32(1);
    const ints = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const f = range(r, 2, 20);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThan(20);
      ints.add(intRange(r, 3, 6));
    }
    expect([...ints].sort()).toEqual([3, 4, 5, 6]);
  });
});
