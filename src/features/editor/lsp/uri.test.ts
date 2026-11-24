/**
 * `file://` URI ↔ OS path (M5). The seam LSP navigation crosses, so the gotchas
 * — Windows drive letters and spaces — are pinned here.
 */

import { describe, expect, it } from "vitest";

import { pathFromUri, uriFromPath } from "./uri";

describe("uriFromPath", () => {
  it("maps a POSIX path to a file:// URI", () => {
    expect(uriFromPath("/Users/me/proj/src/main.rs")).toBe(
      "file:///Users/me/proj/src/main.rs",
    );
  });

  it("percent-encodes spaces and other reserved characters, not the slashes", () => {
    expect(uriFromPath("/Users/me/my project/a.rs")).toBe(
      "file:///Users/me/my%20project/a.rs",
    );
  });

  it("maps a Windows drive-letter path, keeping the drive colon", () => {
    expect(uriFromPath("C:\\Users\\me\\a.rs")).toBe("file:///C:/Users/me/a.rs");
  });
});

describe("pathFromUri", () => {
  it("maps a POSIX file:// URI back to a path", () => {
    expect(pathFromUri("file:///Users/me/proj/src/main.rs")).toBe(
      "/Users/me/proj/src/main.rs",
    );
  });

  it("decodes percent-escapes (spaces)", () => {
    expect(pathFromUri("file:///Users/me/my%20project/a.rs")).toBe(
      "/Users/me/my project/a.rs",
    );
  });

  it("rebuilds a Windows path from file:///C:/…", () => {
    expect(pathFromUri("file:///C:/Users/me/a.rs")).toBe("C:\\Users\\me\\a.rs");
  });

  it("upper-cases the drive letter a language server sends lower-case (`file:///c%3A/…`)", () => {
    // rust-analyzer / typescript-language-server spelling; the tree and git say `C:\…`.
    expect(pathFromUri("file:///c%3A/Users/me/a.rs")).toBe("C:\\Users\\me\\a.rs");
    expect(pathFromUri("file:///d:/x.rs")).toBe("D:\\x.rs");
  });

  it("rebuilds a UNC path from file://server/share/…", () => {
    expect(pathFromUri("file://srv/share/my%20dir/a.rs")).toBe("\\\\srv\\share\\my dir\\a.rs");
  });

  it("a URI that is not file: passes through decoded — never mistaken for a UNC server", () => {
    expect(pathFromUri("deno:/std%2Fpath.ts")).toBe("deno:/std/path.ts");
  });

  it("round-trips POSIX, Windows and UNC paths", () => {
    for (const p of ["/a/b/c.rs", "/a/b c/d.rs", "C:\\a\\b.rs", "\\\\srv\\share\\a b.rs"]) {
      expect(pathFromUri(uriFromPath(p))).toBe(p);
    }
  });
});

describe("uriFromPath — UNC", () => {
  it("puts the server in the authority: \\\\srv\\share\\x → file://srv/share/x", () => {
    expect(uriFromPath("\\\\srv\\share\\a b.rs")).toBe("file://srv/share/a%20b.rs");
  });
});
