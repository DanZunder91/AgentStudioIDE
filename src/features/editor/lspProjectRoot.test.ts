/** A file's server roots in its own project, never the primary root. The Rust `lsp_project_root`
 * command owns the marker walk; this helper is the fallback when that command is unavailable. */
import { describe, expect, it } from "vitest";

import { containingWorkspaceRoot } from "./EditorRegistry";

describe("containingWorkspaceRoot", () => {
  it("picks the root that prefixes the path", () => {
    expect(containingWorkspaceRoot(["/w/a", "/w/b"], "/w/b/src/lib.rs")).toBe("/w/b");
  });

  it("picks the LONGEST root when roots nest", () => {
    expect(containingWorkspaceRoot(["/w", "/w/b"], "/w/b/src/lib.rs")).toBe("/w/b");
  });

  it("matches path-segment-wise, never by raw string prefix (/a/bee is not in /a/b)", () => {
    expect(containingWorkspaceRoot(["/a/b"], "/a/bee/x.rs")).toBeNull();
  });

  it("a path equal to a root is contained by it", () => {
    expect(containingWorkspaceRoot(["/w/a"], "/w/a")).toBe("/w/a");
  });

  it("no containing root → null (the caller falls back to the primary root)", () => {
    expect(containingWorkspaceRoot(["/w/a"], "/elsewhere/x.rs")).toBeNull();
  });

  it("an empty root list → null", () => {
    expect(containingWorkspaceRoot([], "/w/a/x.rs")).toBeNull();
  });

  it("a trailing separator on a root changes nothing", () => {
    expect(containingWorkspaceRoot(["/w/a/"], "/w/a/x.rs")).toBe("/w/a/");
  });

  it("finds a Windows root for a Windows path (backslashes, as Rust sends them)", () => {
    expect(containingWorkspaceRoot(["C:\\w\\a", "C:\\w\\b"], "C:\\w\\b\\src\\rpc.rs")).toBe("C:\\w\\b");
    expect(containingWorkspaceRoot(["C:\\w\\b"], "C:\\w\\bee\\x.rs")).toBeNull();
  });

  it("ignores the drive letter's case — `c:\\w` and `C:\\w` are one folder", () => {
    expect(containingWorkspaceRoot(["c:\\w"], "C:\\w\\x.rs")).toBe("c:\\w");
  });
});
