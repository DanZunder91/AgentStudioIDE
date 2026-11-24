import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ancestorDirsWithin, rootContaining } from "./revealPath";

/** Non-empty path segment containing neither separator — for property inputs. */
const segArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => !/[\\/]/.test(s));

describe("rootContaining — which workspace root a file reveals under", () => {
  it("finds the root that contains a nested file", () => {
    expect(
      rootContaining(["/w/gazelle", "/other"], "/w/gazelle/crates/core/lib.rs"),
    ).toBe("/w/gazelle");
  });

  it("returns null when no root contains the path", () => {
    expect(rootContaining(["/w/gazelle"], "/elsewhere/file.rs")).toBeNull();
  });

  it("returns null for an empty roots list", () => {
    expect(rootContaining([], "/w/gazelle/a.rs")).toBeNull();
  });

  it("returns null when the path IS a root (inside means strictly inside)", () => {
    expect(rootContaining(["/w/gazelle"], "/w/gazelle")).toBeNull();
    // ...even when the path carries a trailing separator.
    expect(rootContaining(["/w/gazelle"], "/w/gazelle/")).toBeNull();
  });

  it('honors segment boundaries — "/a/bc" is NOT under "/a/b"', () => {
    expect(rootContaining(["/a/b"], "/a/bc")).toBeNull();
    expect(rootContaining(["/a/b"], "/a/bc/file.rs")).toBeNull();
  });

  it('is not fooled by sibling dirs that are string prefixes ("src" vs "src2")', () => {
    expect(rootContaining(["/w/src"], "/w/src2/a.ts")).toBeNull();
    expect(rootContaining(["/w/src", "/w/src2"], "/w/src2/a.ts")).toBe("/w/src2");
  });

  it("ignores a trailing separator on a root (and returns the root verbatim)", () => {
    expect(rootContaining(["/w/gazelle/"], "/w/gazelle/a.rs")).toBe("/w/gazelle/");
  });

  it("handles Windows separators", () => {
    expect(rootContaining(["C:\\w\\g"], "C:\\w\\g\\a\\b.rs")).toBe("C:\\w\\g");
  });

  it('handles MIXED separators ("/" root, "\\" path from the Rust side)', () => {
    expect(rootContaining(["/w/gazelle"], "\\w\\gazelle\\a.rs")).toBe("/w/gazelle");
  });

  it("ignores case for Windows paths (a `c:\\w` root owns `C:\\W\\a.rs`), never for POSIX ones", () => {
    expect(rootContaining(["c:\\w"], "C:\\W\\a.rs")).toBe("c:\\w");
    expect(rootContaining(["/w"], "/W/a.rs")).toBeNull();
  });

  it("a drive root owns everything on its drive", () => {
    expect(rootContaining(["C:\\"], "C:\\a\\b.rs")).toBe("C:\\");
    expect(ancestorDirsWithin("C:\\", "C:\\a\\b.rs")).toEqual(["C:\\a"]);
  });

  it("picks the LONGEST match when one root is nested inside another", () => {
    const path = "/w/gazelle/crates/lib.rs";
    expect(rootContaining(["/w", "/w/gazelle"], path)).toBe("/w/gazelle");
    // ...regardless of the order the roots were opened in.
    expect(rootContaining(["/w/gazelle", "/w"], path)).toBe("/w/gazelle");
  });

  it("property: the deeper of two nested roots always wins, in either order", () => {
    fc.assert(
      fc.property(
        fc.array(segArb, { minLength: 1, maxLength: 3 }),
        fc.array(segArb, { minLength: 1, maxLength: 3 }),
        fc.array(segArb, { minLength: 0, maxLength: 3 }),
        segArb,
        (shallowSegs, extraSegs, dirSegs, file) => {
          const shallow = "/" + shallowSegs.join("/");
          const deep = shallow + "/" + extraSegs.join("/");
          const path = [deep, ...dirSegs, file].join("/");
          expect(rootContaining([shallow, deep], path)).toBe(deep);
          expect(rootContaining([deep, shallow], path)).toBe(deep);
        },
      ),
    );
  });
});

describe("ancestorDirsWithin — the dirs to expand between root and file", () => {
  it("returns the outermost → innermost ancestor chain for a nested file", () => {
    expect(
      ancestorDirsWithin("/w/gazelle", "/w/gazelle/crates/core/src/lib.rs"),
    ).toEqual([
      "/w/gazelle/crates",
      "/w/gazelle/crates/core",
      "/w/gazelle/crates/core/src",
    ]);
  });

  it("returns [] for a direct child of the root (nothing to expand)", () => {
    expect(ancestorDirsWithin("/w/gazelle", "/w/gazelle/README.md")).toEqual([]);
  });

  it("returns null when the path IS the root", () => {
    expect(ancestorDirsWithin("/w/gazelle", "/w/gazelle")).toBeNull();
    expect(ancestorDirsWithin("/w/gazelle", "/w/gazelle/")).toBeNull();
  });

  it("returns null when the path is outside the root", () => {
    expect(ancestorDirsWithin("/w/gazelle", "/elsewhere/a/b.rs")).toBeNull();
  });

  it('honors segment boundaries — "/a/bc/…" is NOT under "/a/b"', () => {
    expect(ancestorDirsWithin("/a/b", "/a/bc/file.rs")).toBeNull();
  });

  it('is not fooled by sibling dirs that are string prefixes ("src" vs "src2")', () => {
    expect(ancestorDirsWithin("/w/src", "/w/src2/a/b.ts")).toBeNull();
  });

  it("ignores a trailing separator on the root (entries have no double slash)", () => {
    expect(ancestorDirsWithin("/w/gazelle/", "/w/gazelle/a/b.rs")).toEqual([
      "/w/gazelle/a",
    ]);
  });

  it("handles Windows separators, preserving them in the output", () => {
    expect(ancestorDirsWithin("C:\\w\\g", "C:\\w\\g\\a\\b.rs")).toEqual([
      "C:\\w\\g\\a",
    ]);
  });

  it("handles MIXED separators, preserving root's form + the path's segments", () => {
    // The root keeps its "/" form; the appended segments keep the path's "\".
    expect(ancestorDirsWithin("/w/gazelle", "\\w\\gazelle\\crates\\lib.rs")).toEqual([
      "/w/gazelle\\crates",
    ]);
  });

  it("property: returns exactly the prefix chain of the relative dir segments", () => {
    fc.assert(
      fc.property(
        fc.array(segArb, { minLength: 1, maxLength: 4 }),
        fc.array(segArb, { minLength: 0, maxLength: 5 }),
        segArb,
        (rootSegs, dirSegs, file) => {
          const root = "/" + rootSegs.join("/");
          const path = [root, ...dirSegs, file].join("/");
          const expected = dirSegs.map((_, i) =>
            [root, ...dirSegs.slice(0, i + 1)].join("/"),
          );
          expect(ancestorDirsWithin(root, path)).toEqual(expected);
        },
      ),
    );
  });

  it("property: each entry is a boundary-prefix of the next; the last is the dirname", () => {
    fc.assert(
      fc.property(
        fc.array(segArb, { minLength: 1, maxLength: 4 }),
        fc.array(segArb, { minLength: 1, maxLength: 5 }),
        segArb,
        (rootSegs, dirSegs, file) => {
          const root = "/" + rootSegs.join("/");
          const path = [root, ...dirSegs, file].join("/");
          const dirs = ancestorDirsWithin(root, path);
          expect(dirs).not.toBeNull();
          expect(dirs).toHaveLength(dirSegs.length);
          for (let i = 1; i < dirs!.length; i += 1) {
            expect(dirs![i].startsWith(dirs![i - 1] + "/")).toBe(true);
          }
          const dirname = path.slice(0, path.lastIndexOf("/"));
          expect(dirs![dirs!.length - 1]).toBe(dirname);
        },
      ),
    );
  });
});
