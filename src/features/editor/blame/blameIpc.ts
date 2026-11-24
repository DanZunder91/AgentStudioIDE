/**
 * Blame IPC — typed wrapper for the git-blame command.
 *
 * Feature-local for the same reason as `workspaceIpc.ts` / `lspIpc.ts`: the
 * command *name* and arg/result *shapes* below are the whole wire contract with
 * the Rust side (built in parallel against this exact interface).
 *
 * Rust rejects with a plain string message — "…not in a git repository…" for a
 * file outside any repo, a scope error for an out-of-scope path. The editor
 * surfaces every rejection as a calm inline note, never a crash.
 */

import { invoke } from "@tauri-apps/api/core";

/** One commit that owns at least one line of the blamed file. */
export interface BlameCommit {
  /** Full commit hash. */
  id: string;
  author: string;
  email: string;
  /** Author time, milliseconds since the epoch. */
  timeMs: number;
  /** First line of the message. */
  summary: string;
  /** Full commit message. */
  message: string;
}

/** The blame of one file, as of its on-disk content. */
export interface FileBlame {
  /** Repo-relative path of the blamed file. */
  relPath: string;
  commits: BlameCommit[];
  /**
   * `lines[i]` = index into `commits` for document line `i + 1`;
   * `null` = uncommitted line.
   */
  lines: (number | null)[];
}

/** `git_blame` — per-line authorship of the file on disk at `path`. */
export function gitBlame(path: string): Promise<FileBlame> {
  return invoke<FileBlame>("git_blame", { path });
}
