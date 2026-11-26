/** Typed wrappers for the find commands; the wire types live here, feature-local, like
 * `fleetIpc.ts`. */

import { invoke } from "@tauri-apps/api/core";

/** The four search modifiers (IntelliJ "Find in Files" toggles + file mask). */
export interface FindOptions {
  /** Interpret `query` as a regular expression rather than a literal. */
  regex: boolean;
  /** Match case exactly (Cc). */
  caseSensitive: boolean;
  /** Match whole words only (W). */
  wholeWord: boolean;
  /** A glob file mask ("*.ts", "src/**"); empty string = every file. */
  glob: string;
}

/** Mirrors Rust's `Match`. `line`/`col` are 1-based; `matchStart`/`matchEnd` are 0-based char
 * offsets into `lineText`. */
export interface FindMatch {
  file: string;
  line: number;
  col: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

/** `truncated`: Rust capped the results, so the UI must not imply the list is complete. */
export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

/** Opaque unique id (as the store's `newId()`) that Rust keys its cancel registry on. */
export function newSearchId(): string {
  return crypto.randomUUID();
}

/** Search `root` recursively; Rust scopes it to workspace/recent roots and rejects a bad regex
 * with a message shown inline. `searchId` is the {@link cancelFind} handle; a cancelled search
 * rejects with `cancelled`, a normal outcome. */
export function findInFiles(
  root: string,
  query: string,
  options: FindOptions,
  searchId?: string,
): Promise<FindResult> {
  return invoke<FindResult>("find_in_files", { root, query, options, searchId });
}

/* ── Find Files: fuzzy filename matching (Cmd/Ctrl+Shift+O), same Rust module ── */

/** The one modifier the filename finder carries (no regex/word/glob here). */
export interface FindFilesOptions {
  /** Match the query's case exactly (Cc). */
  caseSensitive: boolean;
}

/** `path` is relative to the root with forward slashes; `name` is its basename. */
export interface FindFileHit {
  path: string;
  name: string;
}

/** `truncated`: Rust capped the list (as in `FindResult`). */
export interface FindFilesResult {
  files: FindFileHit[];
  truncated: boolean;
}

/** Fuzzy-match file names under `root`; same scope as `find_in_files`; Rust owns the ranking. */
export function findFiles(
  root: string,
  query: string,
  options: FindFilesOptions,
  searchId?: string,
): Promise<FindFilesResult> {
  return invoke<FindFilesResult>("find_files", { root, query, options, searchId });
}

/* ── Cancellation: the walk runs off the event-loop thread so it can be killed ── */

/** Ask Rust to abandon `searchId`'s walk; true if a live search was flagged. Never throws, and is
 * advisory (the walk stops at its next check), so callers go idle on their own. */
export function cancelFind(searchId: string): Promise<boolean> {
  return invoke<boolean>("find_cancel", { searchId }).catch(() => false);
}
