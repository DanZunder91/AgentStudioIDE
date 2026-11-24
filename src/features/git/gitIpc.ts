/**
 * Git IPC — the one `invoke` seam for the Git rail panel (status, PRs, opening
 * a PR in the browser) and for the file tree's Git submenu (compare, revert).
 *
 * Kept feature-local (not `app/ipc.ts`), like `usageIpc.ts` / `blameIpc.ts`, so
 * the wire types live next to their feature. The command *names* and arg/result
 * *shapes* below are the whole wire contract with the Rust side.
 *
 * None of these wrappers swallow: a failed status read or PR fetch is
 * information the user needs ("not a repo", "gh not signed in"), so the
 * rejection — Rust's stable `"<code>[: detail]"` string — is passed through
 * untouched and the store classifies it via `lib/wireCode`.
 */

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

/**
 * `git_status` — branch + working-tree changes for the repo at `root`.
 * Rejects with `out-of-scope | not-a-repo | git | unknown` (`[: detail]`).
 */
export function gitStatus(root: string): Promise<RepoStatus> {
  return invoke<RepoStatus>("git_status", { root });
}

/**
 * `gh_prs` — the open GitHub pull requests of the repo at `root`, via the
 * local `gh` CLI. Rejects with
 * `gh-missing | gh-not-signed-in | no-remote | gh-failed | timeout | parse | out-of-scope | unknown`.
 */
export function ghPrs(root: string): Promise<PullRequest[]> {
  return invoke<PullRequest[]>("gh_prs", { root });
}

/**
 * `url_open` — open `url` in the OS browser. Rust enforces https-only; the
 * panel only ever passes URLs that arrived on a loaded {@link PullRequest}.
 */
export function urlOpen(url: string): Promise<void> {
  return invoke<void>("url_open", { url });
}

/**
 * One file's two sides, as `git_file_diff` returns them — what the `diff` center
 * tab renders (the file tree's **Compare with HEAD**).
 *
 * Every non-diff outcome is a FIELD, never an error: a binary file, a file that
 * matches HEAD, a file with no HEAD side yet, a file deleted on disk. They are
 * all ordinary answers to "what changed?", and collapsing them into a rejection
 * would make the view say "something went wrong" about four situations where
 * nothing did (when a contract can hold N states, say which one).
 */
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

/**
 * `git_file_diff` — HEAD vs. the working tree for one file.
 * Rejects with a human sentence ("not in a git repository"), which the diff tab
 * renders inline verbatim.
 */
export function gitFileDiff(path: string): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { path });
}

/**
 * `git_file_restore` — throw away the working-tree changes to one file, putting
 * back its HEAD content (the tree's **Revert changes…**, behind a confirm).
 *
 * DESTRUCTIVE and irreversible on disk, which is exactly why this rejection is
 * propagated rather than swallowed: a revert that silently did nothing would be
 * a lie about the user's file. Rejects with a human sentence ("file is not
 * tracked — there is nothing to revert to").
 */
export function gitFileRestore(path: string): Promise<void> {
  return invoke<void>("git_file_restore", { path });
}
