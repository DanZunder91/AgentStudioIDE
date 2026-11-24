/**
 * findModel — exhaustive pure tests for the find bar's counting/indexing
 * logic. No DOM, no view: strings in, numbers out.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  countMatches,
  currentMatchIndex,
  formatCount,
  listMatches,
  queryHasError,
  toSearchQuery,
} from "./findModel";
import type { FindSpec } from "./findModel";

/** A plain literal spec with the given flags flipped on. */
const spec = (search: string, flags: Partial<Omit<FindSpec, "search">> = {}): FindSpec => ({
  search,
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  ...flags,
});

describe("countMatches", () => {
  it("counts literal occurrences across lines", () => {
    expect(countMatches(spec("foo"), "foo bar foo\nbaz foo")).toBe(3);
  });

  it("is case-insensitive by default and case-sensitive with the flag", () => {
    const doc = "Foo foo FOO fOo";
    expect(countMatches(spec("foo"), doc)).toBe(4);
    expect(countMatches(spec("foo", { caseSensitive: true }), doc)).toBe(1);
  });

  it("wholeWord drops embedded occurrences", () => {
    const doc = "cat catalog cat concatenate";
    expect(countMatches(spec("cat"), doc)).toBe(4);
    expect(countMatches(spec("cat", { wholeWord: true }), doc)).toBe(2);
  });

  it("wholeWord and caseSensitive interact", () => {
    const doc = "Cat cat concat";
    expect(
      countMatches(spec("cat", { wholeWord: true, caseSensitive: true }), doc),
    ).toBe(1); // only the standalone lowercase one
    expect(countMatches(spec("cat", { wholeWord: true }), doc)).toBe(2); // Cat + cat
  });

  it("counts regexp matches", () => {
    expect(countMatches(spec("fo+", { regexp: true }), "f fo foo fooo")).toBe(3);
    expect(countMatches(spec("\\bcat\\b", { regexp: true }), "cat catalog")).toBe(1);
  });

  it("counts string matches non-overlapping, like the highlighter paints them", () => {
    expect(countMatches(spec("aa"), "aaa")).toBe(1);
    expect(countMatches(spec("aa"), "aaaa")).toBe(2);
  });

  it("treats the query literally: '\\n' finds a backslash-n, not a newline", () => {
    expect(countMatches(spec("\\n"), "a\\nb")).toBe(1); // literal backslash + n
    expect(countMatches(spec("\\n"), "a\nb")).toBe(0); // a real newline is NOT matched
    expect(countMatches(spec("\\n", { regexp: true }), "a\nb")).toBe(1); // regexp mode still is
  });

  it("returns 0 for an empty query and for an empty document", () => {
    expect(countMatches(spec(""), "anything at all")).toBe(0);
    expect(countMatches(spec("x"), "")).toBe(0);
  });

  it("an INVALID regexp yields 0 matches and never throws", () => {
    const bad = spec("(unclosed", { regexp: true });
    expect(() => countMatches(bad, "some (unclosed doc")).not.toThrow();
    expect(countMatches(bad, "some (unclosed doc")).toBe(0);
    expect(listMatches(bad, "some (unclosed doc")).toEqual([]);
    expect(currentMatchIndex(bad, "some (unclosed doc", 0, 3)).toBeNull();
  });
});

describe("queryHasError", () => {
  it("flags only non-empty invalid regexps", () => {
    expect(queryHasError(spec("(", { regexp: true }))).toBe(true);
    expect(queryHasError(spec("[a-", { regexp: true }))).toBe(true);
    expect(queryHasError(spec("(a)", { regexp: true }))).toBe(false);
    expect(queryHasError(spec("(", { regexp: false }))).toBe(false); // literal "(" is fine
    expect(queryHasError(spec("", { regexp: true }))).toBe(false); // empty ≠ error
  });
});

describe("listMatches / currentMatchIndex", () => {
  const doc = "a b a b a";

  it("lists matches in order with document offsets", () => {
    expect(listMatches(spec("a"), doc)).toEqual([
      { from: 0, to: 1 },
      { from: 4, to: 5 },
      { from: 8, to: 9 },
    ]);
  });

  it("gives the 1-based k for a selection sitting exactly on a match", () => {
    expect(currentMatchIndex(spec("a"), doc, 0, 1)).toBe(1);
    expect(currentMatchIndex(spec("a"), doc, 4, 5)).toBe(2);
    expect(currentMatchIndex(spec("a"), doc, 8, 9)).toBe(3);
  });

  it("returns null when the selection is not exactly a match", () => {
    expect(currentMatchIndex(spec("a"), doc, 1, 2)).toBeNull(); // on a space
    expect(currentMatchIndex(spec("a"), doc, 0, 2)).toBeNull(); // superset of a match
    expect(currentMatchIndex(spec("a"), doc, 0, 0)).toBeNull(); // empty selection
    expect(currentMatchIndex(spec(""), doc, 0, 1)).toBeNull(); // empty query
  });
});

describe("formatCount", () => {
  it("formats the three display states", () => {
    expect(formatCount(null, 0)).toBe("0 results");
    expect(formatCount(null, 1)).toBe("1 result");
    expect(formatCount(null, 7)).toBe("7 results");
    expect(formatCount(2, 5)).toBe("2/5");
    expect(formatCount(1, 1)).toBe("1/1");
  });
});

describe("toSearchQuery", () => {
  it("builds a literal query carrying all three flags", () => {
    const q = toSearchQuery(spec("x", { caseSensitive: true, wholeWord: true }));
    expect(q.literal).toBe(true);
    expect(q.caseSensitive).toBe(true);
    expect(q.wholeWord).toBe(true);
    expect(q.regexp).toBe(false);
  });
});

/* ── properties (fast-check) ────────────────────────────────────────────── */

describe("properties", () => {
  // Filler that can never contain or overlap the planted needle.
  const filler = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n"), maxLength: 30 });
  const needle = "%";

  it("count of a planted literal equals the number of planted occurrences", () => {
    fc.assert(
      fc.property(fc.array(filler, { minLength: 1, maxLength: 20 }), (parts) => {
        const doc = parts.join(needle);
        expect(countMatches(spec(needle), doc)).toBe(parts.length - 1);
      }),
    );
  });

  it("the j-th planted match reports index j (1-based) via currentMatchIndex", () => {
    fc.assert(
      fc.property(fc.array(filler, { minLength: 2, maxLength: 10 }), (parts) => {
        const doc = parts.join(needle);
        const s = spec(needle);
        const matches = listMatches(s, doc);
        matches.forEach((m, j) => {
          expect(currentMatchIndex(s, doc, m.from, m.to)).toBe(j + 1);
        });
      }),
    );
  });

  // ASCII-only so NFKD normalization / exotic case folding can't blur the
  // set-inclusion argument the properties rest on.
  const asciiText = fc.string({
    unit: fc.constantFrom(..."abAB xy_9\n".split("")),
    maxLength: 60,
  });
  const asciiQuery = fc.string({
    unit: fc.constantFrom(..."abAB".split("")),
    minLength: 1,
    maxLength: 4,
  });

  it("case-insensitive count >= case-sensitive count", () => {
    fc.assert(
      fc.property(asciiText, asciiQuery, (doc, q) => {
        expect(countMatches(spec(q), doc)).toBeGreaterThanOrEqual(
          countMatches(spec(q, { caseSensitive: true }), doc),
        );
      }),
    );
  });

  it("wholeWord count <= plain count", () => {
    fc.assert(
      fc.property(asciiText, asciiQuery, (doc, q) => {
        expect(countMatches(spec(q, { wholeWord: true }), doc)).toBeLessThanOrEqual(
          countMatches(spec(q), doc),
        );
      }),
    );
  });

  it("currentMatchIndex is within 1..count or null, for arbitrary selections", () => {
    fc.assert(
      fc.property(
        asciiText,
        asciiQuery,
        fc.nat(80),
        fc.nat(80),
        (doc, q, a, b) => {
          const s = spec(q);
          const total = countMatches(s, doc);
          const k = currentMatchIndex(s, doc, Math.min(a, b), Math.max(a, b));
          if (k !== null) {
            expect(k).toBeGreaterThanOrEqual(1);
            expect(k).toBeLessThanOrEqual(total);
          }
        },
      ),
    );
  });
});
