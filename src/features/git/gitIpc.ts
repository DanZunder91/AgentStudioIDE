/** The `invoke` seam for the Git panel and the tree's Git submenu, feature-local like
 * `usageIpc.ts`. Nothing swallows: Rust's `"<code>[: detail]"` passes through to `lib/wireCode`. */

import { invoke } from "@tauri-apps/api/core";

import type { GitChange, PullRequest } from "./gitStore";

/** The working-tree status of one workspace root, as `git_status` returns it. */
export interface RepoStatus {
  /** The workspace root that was asked about — echoed back verbatim. */
  root: string;
  /** The checked-out branch (or a detached-HEAD description). */
  branch: string;
  /** Every changed file, `path` ABSOLUTE (always under `root` + "/"). */
  changes: GitChange[];
}

/** Branch + changes for `root`. Rejects `out-of-scope | not-a-repo | git | unknown`
 * (`[: detail]`). */
export function gitStatus(root: string): Promise<RepoStatus> {
  return invoke<RepoStatus>("git_status", { root });
}

/** Open GitHub PRs at `root` via `gh`. Rejects `gh-missing | gh-not-signed-in | no-remote |
 * gh-failed | timeout | parse | out-of-scope | unknown`. */
export function ghPrs(root: string): Promise<PullRequest[]> {
  return invoke<PullRequest[]>("gh_prs", { root });
}

/** Open `url` in the OS browser; Rust enforces https-only. Only loaded PR URLs are passed. */
export function urlOpen(url: string): Promise<void> {
  return invoke<void>("url_open", { url });
}

/** One file's two sides for the `diff` tab. Binary, unchanged, no HEAD side and deleted on disk
 * are fields, never errors: they are ordinary answers. */
export interface FileDiff {
  /** The file that was asked about — absolute, canonicalized by Rust. */
  path: string;
  /** Repo-relative, for the tab title / the view's heading. */
  relative: string;
  /** Content at HEAD. `null` = untracked / not yet committed / unborn HEAD. */
  head: string | null;
  /** Content on disk. `null` = the file is deleted in the working tree. */
  working: string | null;
  /** The two sides are byte-identical — there is nothing to show. */
  unchanged: boolean;
  /** Either side is not valid UTF-8; BOTH text fields are then `null`. */
  binary: boolean;
}

/** HEAD vs. working tree for one file; rejects with a sentence the diff tab renders verbatim. */
export function gitFileDiff(path: string): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { path });
}

/** Restore one file's HEAD content (Revert changes…, behind a confirm). Destructive, so a
 * rejection (a human sentence) propagates: a silent no-op would lie about the file. */
export function gitFileRestore(path: string): Promise<void> {
  return invoke<void>("git_file_restore", { path });
}
