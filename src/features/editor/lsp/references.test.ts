/** The request itself is covered in `lsp.browser.test.tsx`; this pins the Windows spelling. */
import { describe, expect, it } from "vitest";

import { displayPath } from "./references";

describe("displayPath", () => {
  it("is relative to the workspace root when the file is under it", () => {
    expect(displayPath("/w/proj/src/main.rs", "/w/proj")).toBe("src/main.rs");
    expect(displayPath("/w/proj/src/main.rs", "/w/proj/")).toBe("src/main.rs");
  });

  it("is relative on Windows too — backslashes, and the drive letter's case ignored", () => {
    expect(displayPath("C:\\w\\proj\\src\\main.rs", "C:\\w\\proj")).toBe("src\\main.rs");
    expect(displayPath("C:\\w\\proj\\src\\main.rs", "c:\\w\\proj")).toBe("src\\main.rs");
  });

  it("stays absolute outside the root, at the root itself, and with no root", () => {
    expect(displayPath("/elsewhere/lib.rs", "/w/proj")).toBe("/elsewhere/lib.rs");
    expect(displayPath("/w/projx/lib.rs", "/w/proj")).toBe("/w/projx/lib.rs");
    expect(displayPath("/w/proj", "/w/proj")).toBe("/w/proj");
    expect(displayPath("/w/proj/a.rs", null)).toBe("/w/proj/a.rs");
  });
});
