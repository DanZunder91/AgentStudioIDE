/** Typed wrapper for the git-blame command. Rust rejects with a plain string (not a repo, out of
 * scope); the editor shows every rejection as an inline note. */

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
  /** `lines[i]` indexes `commits` for document line `i + 1`; `null` = uncommitted. */
  lines: (number | null)[];
}

/** `git_blame` — per-line authorship of the file on disk at `path`. */
export function gitBlame(path: string): Promise<FileBlame> {
  return invoke<FileBlame>("git_blame", { path });
}
