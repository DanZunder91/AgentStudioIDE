import { describe, expect, it } from "vitest";

import {
  basename,
  dirname,
  displayRelative,
  endsWithSegments,
  isAbsolutePath,
  isWindowsPath,
  joinPath,
  msysToWindows,
  relativeTo,
  samePath,
  separatorOf,
  SEPARATOR,
  tildeHome,
  trimTrailingSeparators,
} from "./paths";

describe("SEPARATOR", () => {
  it("matches both separators and nothing else", () => {
    expect(SEPARATOR.test("/")).toBe(true);
    expect(SEPARATOR.test("\\")).toBe(true);
    expect(SEPARATOR.test(":")).toBe(false);
  });
});

describe("isWindowsPath", () => {
  it.each([
    ["C:\\Users\\me", true],
    ["c:/users/me", true],
    ["C:", true],
    ["\\\\srv\\share\\x", true],
    ["/Users/me", false],
    ["\\x", false], // drive-relative root: no drive to read the shape from
    ["C:x", false], // drive-relative, not a drive root
    ["src/a.ts", false],
    ["", false],
  ])("%s → %s", (p, want) => {
    expect(isWindowsPath(p)).toBe(want);
  });
});

describe("isAbsolutePath", () => {
  it.each([
    ["/tmp/x", true],
    ["C:\\x", true],
    ["C:/x", true],
    ["\\\\srv\\share", true],
    ["\\x", true],
    ["gazelle.log", false],
    ["logs/gazelle.log", false],
    ["logs\\gazelle.log", false],
    ["C:x", false],
    ["", false],
  ])("%s → %s", (p, want) => {
    expect(isAbsolutePath(p)).toBe(want);
  });
});

describe("separatorOf", () => {
  it.each([
    ["C:\\repo", "\\"],
    ["C:\\repo/mixed", "\\"],
    ["C:/repo", "/"],
    ["/w", "/"],
    ["C:", "\\"],
    ["name", "/"],
  ])("%s → %s", (p, want) => {
    expect(separatorOf(p)).toBe(want);
  });
});

describe("trimTrailingSeparators", () => {
  it.each([
    ["/w/", "/w"],
    ["/w//", "/w"],
    ["C:\\w\\", "C:\\w"],
    ["C:\\w/\\", "C:\\w"],
    ["/", "/"],
    ["//", "/"],
    ["C:\\", "C:\\"],
    ["C:/", "C:/"],
    ["C:", "C:"],
    ["sub/", "sub"],
    ["", ""],
  ])("%s → %s", (p, want) => {
    expect(trimTrailingSeparators(p)).toBe(want);
  });
});

describe("basename", () => {
  it.each([
    ["/w/gazelle/src/lib.rs", "lib.rs"],
    ["C:\\repo\\sub\\inner.txt", "inner.txt"],
    ["C:\\repo/sub/inner.txt", "inner.txt"],
    ["/w/gazelle/", "gazelle"],
    ["C:\\repo\\", "repo"],
    ["C:\\", "C:"],
    ["/", ""],
    ["name", "name"],
  ])("%s → %s", (p, want) => {
    expect(basename(p)).toBe(want);
  });
});

describe("dirname", () => {
  it.each([
    ["/w/gazelle/src/lib.rs", "/w/gazelle/src"],
    ["C:\\repo\\sub\\inner.txt", "C:\\repo\\sub"],
    // Mixed: the parent keeps exactly the spelling it had in the input.
    ["C:\\repo/sub/inner.txt", "C:\\repo/sub"],
    ["/w//a", "/w"],
    ["/w/a/", "/w"],
    ["/w", "/"],
    ["C:\\w", "C:\\"],
    ["C:/w", "C:/"],
    ["/", "/"],
    ["C:\\", "C:\\"],
    ["C:", "C:"],
    ["\\\\srv\\share\\x", "\\\\srv\\share"],
    ["src/a.ts", "src"],
    ["a.txt", ""],
  ])("%s → %s", (p, want) => {
    expect(dirname(p)).toBe(want);
  });
});

describe("joinPath", () => {
  it("joins under a POSIX dir with one '/'", () => {
    expect(joinPath("/w", "src/a.ts")).toBe("/w/src/a.ts");
    expect(joinPath("/w/", "a.ts")).toBe("/w/a.ts");
    expect(joinPath("/", "a.ts")).toBe("/a.ts");
  });

  it("keeps a POSIX rel byte for byte — '\\' is a file-name character there", () => {
    expect(joinPath("/w", "odd\\name.txt")).toBe("/w/odd\\name.txt");
  });

  it("joins under a Windows dir in its native '\\', converting the rel's '/'", () => {
    // find_files sends `src/a.ts`, find_in_files `src\a.ts`: both must land on the tree's spelling.
    expect(joinPath("C:\\repo", "src/a.ts")).toBe("C:\\repo\\src\\a.ts");
    expect(joinPath("C:\\repo", "src\\a.ts")).toBe("C:\\repo\\src\\a.ts");
    expect(joinPath("C:\\repo\\", "a.ts")).toBe("C:\\repo\\a.ts");
  });

  it("never doubles the separator after a root", () => {
    expect(joinPath("C:\\", "a.ts")).toBe("C:\\a.ts");
    expect(joinPath("C:", "a.ts")).toBe("C:\\a.ts");
  });

  it("follows a forward-slash Windows dir's own style", () => {
    expect(joinPath("C:/repo", "src/a.ts")).toBe("C:/repo/src/a.ts");
  });
});

describe("samePath", () => {
  it.each([
    ["/w/a", "/w/a", true],
    ["/w/a/", "/w/a", true],
    ["/w//a", "/w/a", true],
    ["/w/a", "/W/a", false], // POSIX stays case-sensitive
    ["/w/a", "/w/ab", false],
    ["C:\\repo\\a.ts", "C:/repo/a.ts", true],
    ["c:\\Repo\\", "C:\\repo", true], // Windows ignores case, drive letter included
    ["C:\\\\Users\\\\me", "C:\\Users\\me", true], // a bash-escaped `\\` is one separator
    ["C:\\repo", "D:\\repo", false],
    ["\\\\srv\\share", "//srv/share", true],
    ["\\\\srv\\share", "/srv/share", false], // UNC is not a POSIX absolute path
    ["/", "//", true],
  ])("%s vs %s → %s", (a, b, want) => {
    expect(samePath(a, b)).toBe(want);
  });
});

describe("displayRelative", () => {
  it("spells a relative path in a Windows root's native \\ (both find_files' / and find's \\)", () => {
    expect(displayRelative("C:\\Users\\me\\app", "scripts/verify.mjs")).toBe("scripts\\verify.mjs");
    expect(displayRelative("C:\\Users\\me\\app", "src\\features\\terminal")).toBe("src\\features\\terminal");
    expect(displayRelative("c:/repo", "a/b/c.ts")).toBe("a\\b\\c.ts");
    expect(displayRelative("\\\\srv\\share", "docs/x.md")).toBe("docs\\x.md");
  });

  it("keeps a POSIX root's relative path byte for byte (\\ is a file-name character there)", () => {
    expect(displayRelative("/Users/me/app", "scripts/verify.mjs")).toBe("scripts/verify.mjs");
    expect(displayRelative("/w", "odd\\name/x")).toBe("odd\\name/x");
  });
});

describe("tildeHome", () => {
  it("spells the home folder ~ on macOS / Linux, keeping the path's separators", () => {
    expect(tildeHome("/Users/me/projects/app", "/Users/me")).toBe("~/projects/app");
    expect(tildeHome("/home/me/x", "/home/me/")).toBe("~/x");
    expect(tildeHome("/Users/me", "/Users/me")).toBe("~");
  });

  it("on Windows, case-insensitively and in the path's own spelling", () => {
    expect(tildeHome("C:\\Users\\me\\projects\\Agent Studio", "C:\\Users\\me")).toBe(
      "~\\projects\\Agent Studio",
    );
    expect(tildeHome("c:\\users\\ME\\projects", "C:\\Users\\me")).toBe("~\\projects");
    expect(tildeHome("C:\\Users\\me\\", "c:\\users\\me")).toBe("~");
  });

  it("leaves the path alone when home is unknown, a bare root, or not an ancestor", () => {
    expect(tildeHome("/Users/me/x", null)).toBe("/Users/me/x");
    expect(tildeHome("/Users/me/x", "")).toBe("/Users/me/x");
    expect(tildeHome("/Users/me/x", "/")).toBe("/Users/me/x");
    expect(tildeHome("C:\\x", "C:\\")).toBe("C:\\x");
    expect(tildeHome("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x");
    expect(tildeHome("D:\\Users\\me\\x", "C:\\Users\\me")).toBe("D:\\Users\\me\\x");
    // POSIX stays case-sensitive: /Users/Me is a different folder.
    expect(tildeHome("/Users/Me/x", "/Users/me")).toBe("/Users/Me/x");
  });
});

describe("relativeTo", () => {
  it("answers the relative part for a path inside the root", () => {
    expect(relativeTo("/w/gazelle", "/w/gazelle/src/lib.rs")).toBe("src/lib.rs");
    expect(relativeTo("C:\\repo", "C:\\repo\\sub\\inner.txt")).toBe("sub\\inner.txt");
  });

  it('answers "" for the root itself, trailing separators either side ignored', () => {
    expect(relativeTo("/w", "/w")).toBe("");
    expect(relativeTo("/w/", "/w")).toBe("");
    expect(relativeTo("/w", "/w/")).toBe("");
    expect(relativeTo("C:\\repo", "C:\\repo\\")).toBe("");
  });

  it('honours segment boundaries — "/a/bc" is not inside "/a/b"', () => {
    expect(relativeTo("/a/b", "/a/bc")).toBeNull();
    expect(relativeTo("C:\\a\\b", "C:\\a\\bc\\x")).toBeNull();
  });

  it("answers null outside the root", () => {
    expect(relativeTo("/w/a", "/w/b/x")).toBeNull();
    expect(relativeTo("/w/a/b", "/w/a")).toBeNull();
  });

  it("treats either separator as one (a root joined with a '/'-separated path)", () => {
    expect(relativeTo("C:\\repo", "C:\\repo/sub/inner.txt")).toBe("sub/inner.txt");
    expect(relativeTo("/w/gazelle", "\\w\\gazelle\\a.rs")).toBe("a.rs");
  });

  it("ignores case for Windows paths and keeps the PATH's own spelling", () => {
    expect(relativeTo("c:\\repo", "C:\\Repo\\Src\\A.ts")).toBe("Src\\A.ts");
  });

  it("stays case-sensitive for POSIX paths", () => {
    expect(relativeTo("/w/Repo", "/w/repo/a")).toBeNull();
  });

  it("a root ending in a separator is its own boundary", () => {
    expect(relativeTo("/", "/w/a")).toBe("w/a");
    expect(relativeTo("C:\\", "C:\\w\\a")).toBe("w\\a");
  });

  it("keeps the case of a character whose lower case is longer (fold is length-preserving)", () => {
    // "İ" lower-cases to two code units; folding it would shift every index after it by
    // one per "İ" — two of them push the slice past the separator into the name itself.
    expect(relativeTo("C:\\İİ", "C:\\İİ\\abc")).toBe("abc");
    expect(relativeTo("C:\\İİX", "c:\\İİx\\Src\\a.ts")).toBe("Src\\a.ts");
  });
});

describe("endsWithSegments", () => {
  it.each([
    ["/work/gazelle/logs/gazelle.log", "gazelle.log", true],
    ["/work/gazelle/logs/gazelle.log", "logs/gazelle.log", true],
    ["/work/gazelle/logs/gazelle.log", "zelle.log", false], // never a partial segment
    ["C:\\work\\logs\\gazelle.log", "gazelle.log", true],
    ["C:\\work\\logs\\gazelle.log", "logs/gazelle.log", true],
    ["C:\\work\\logs\\gazelle.log", "logs\\gazelle.log", true],
    ["C:\\work\\logs\\Gazelle.log", "gazelle.LOG", true], // Windows ignores case
    ["/work/logs/Gazelle.log", "gazelle.log", false], // POSIX does not
    ["gazelle.log", "gazelle.log", true],
    ["/", "", false],
  ])("%s ends with %s → %s", (path, tail, want) => {
    expect(endsWithSegments(path, tail)).toBe(want);
  });
});

describe("msysToWindows", () => {
  it.each([
    ["/c/Users/me/x.log", "C:/Users/me/x.log"],
    ["/d", "D:/"],
    ["/c/", "C:/"],
    ["/cx/y", "/cx/y"],
    ["/tmp/x", "/tmp/x"],
    ["C:/x", "C:/x"],
  ])("%s → %s", (p, want) => {
    expect(msysToWindows(p)).toBe(want);
  });
});
