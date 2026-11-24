/**
 * `gitIpc` — the git-panel wire. Thin wrappers, so the command *names*, the arg
 * *shapes*, and the **rejection passthrough** are the whole contract.
 *
 * The passthrough is the part worth pinning: none of these swallow, because a
 * failed status read or PR fetch is information the user needs ("not a repo",
 * "gh not signed in"), and the store can only classify Rust's stable
 * `"<code>[: detail]"` string if it arrives untouched.
 *
 * `git_file_diff` / `git_file_restore` (the tree's Git submenu) answer with a
 * human sentence rather than a code, and the UI renders it verbatim — so the
 * passthrough matters even more there. A revert is destructive: swallowing its
 * rejection would tell the user their edits are gone when they are not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  ghPrs,
  gitFileDiff,
  gitFileRestore,
  gitStatus,
  urlOpen,
  type FileDiff,
  type RepoStatus,
} from "./gitIpc";
import type { PullRequest } from "./gitStore";

const STATUS: RepoStatus = {
  root: "/w/alpha",
  branch: "main",
  changes: [
    { path: "/w/alpha/src/a.ts", status: "modified" },
    { path: "/w/alpha/gone.ts", status: "deleted" },
  ],
};

const PRS: PullRequest[] = [
  {
    number: 7,
    title: "Fix the fit control",
    author: "alex",
    url: "https://github.com/o/r/pull/7",
    headRef: "fix/fit",
    baseRef: "main",
    isDraft: false,
    updatedAt: "2026-08-20T10:00:00Z",
  },
];

const DIFF: FileDiff = {
  path: "/w/alpha/src/a.ts",
  relative: "src/a.ts",
  head: "const a = 1;\n",
  working: "const a = 2;\n",
  unchanged: false,
  binary: false,
};

describe("gitIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("gitStatus invokes git_status with { root } and resolves the status untouched", async () => {
    ipc.handle("git_status", () => STATUS);

    await expect(gitStatus("/w/alpha")).resolves.toEqual(STATUS);
    expect(ipc.lastCall("git_status")).toEqual({ root: "/w/alpha" });
  });

  it("gitStatus passes a rejection through untouched (the store parses the code)", async () => {
    ipc.handle("git_status", () => Promise.reject("not-a-repo"));

    await expect(gitStatus("/w/notes")).rejects.toBe("not-a-repo");
  });

  it("ghPrs invokes gh_prs with { root } and resolves the list untouched", async () => {
    ipc.handle("gh_prs", () => PRS);

    await expect(ghPrs("/w/alpha")).resolves.toEqual(PRS);
    expect(ipc.lastCall("gh_prs")).toEqual({ root: "/w/alpha" });
  });

  it("ghPrs passes a rejection with detail through untouched", async () => {
    ipc.handle("gh_prs", () => Promise.reject("gh-not-signed-in: run gh auth login"));

    await expect(ghPrs("/w/alpha")).rejects.toBe("gh-not-signed-in: run gh auth login");
  });

  it("urlOpen invokes url_open with { url } and resolves", async () => {
    ipc.handle("url_open", () => undefined);

    await expect(urlOpen("https://github.com/o/r/pull/7")).resolves.toBeUndefined();
    expect(ipc.lastCall("url_open")).toEqual({ url: "https://github.com/o/r/pull/7" });
  });

  it("urlOpen passes a rejection through untouched (the panel swallows, knowingly)", async () => {
    ipc.handle("url_open", () => Promise.reject("out-of-scope: not https"));

    await expect(urlOpen("http://plain.example")).rejects.toBe("out-of-scope: not https");
  });

  it("gitFileDiff invokes git_file_diff with { path } and resolves the two sides untouched", async () => {
    ipc.handle("git_file_diff", () => DIFF);

    await expect(gitFileDiff("/w/alpha/src/a.ts")).resolves.toEqual(DIFF);
    expect(ipc.lastCall("git_file_diff")).toEqual({ path: "/w/alpha/src/a.ts" });
  });

  it("gitFileDiff passes a rejection through untouched (the diff tab renders it inline)", async () => {
    ipc.handle("git_file_diff", () => Promise.reject("not in a git repository"));

    await expect(gitFileDiff("/w/notes/a.txt")).rejects.toBe("not in a git repository");
  });

  it("gitFileRestore invokes git_file_restore with { path } and resolves", async () => {
    ipc.handle("git_file_restore", () => undefined);

    await expect(gitFileRestore("/w/alpha/src/a.ts")).resolves.toBeUndefined();
    expect(ipc.lastCall("git_file_restore")).toEqual({ path: "/w/alpha/src/a.ts" });
  });

  it("gitFileRestore passes a rejection through untouched — a failed REVERT is never swallowed", async () => {
    // The one wrapper where swallowing would be a lie about the user's file: the
    // tree has already asked "are you sure?", so a silent no-op would read as
    // "your edits are gone" when they are still there.
    ipc.handle("git_file_restore", () =>
      Promise.reject("file is not tracked — there is nothing to revert to"),
    );

    await expect(gitFileRestore("/w/alpha/new.ts")).rejects.toBe(
      "file is not tracked — there is nothing to revert to",
    );
  });
});
