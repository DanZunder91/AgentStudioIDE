/**
 * Find IPC — typed wrapper for the project-wide search command.
 *
 * Kept feature-local so the wire types live next to their feature.
 *
 * The Rust half owns `find_in_files`; these types are the wire contract both
 * halves share. They live here — not in `app/types.ts` — mirroring how
 * `fleetIpc.ts` keeps `FleetSnapshot` local.
 */

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

/**
 * One hit. Mirrors Rust's `Match`. `line`/`col` are 1-based (editor
 * convention); `matchStart`/`matchEnd` are 0-based char offsets **into
 * `lineText`**, so the UI can highlight the span without re-running the search.
 */
export interface FindMatch {
  file: string;
  line: number;
  col: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * The whole result set. `truncated` is true when Rust capped the results (a
 * huge repo / a `.*` that matches everything), so the UI can say so rather than
 * imply the list is complete.
 */
export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

/**
 * A fresh id for one search, so it can be cancelled later.
 *
 * The same idiom as the store's `newId()` (`crypto.randomUUID()`, `app/store.ts`),
 * which is module-private there — this is the find feature's copy of the scheme, not
 * a second scheme. Only opacity and uniqueness matter: Rust keys its cancel
 * registry on the string we hand it.
 */
export function newSearchId(): string {
  return crypto.randomUUID();
}

/**
 * `find_in_files` — search `root` recursively for `query` under `options`.
 *
 * Rust is security-scoped to the workspace / recent roots (same as `read_dir`),
 * and rejects an invalid regex with a message the panel surfaces inline rather
 * than crashing.
 *
 * `searchId` (optional, trailing — every existing caller keeps working) is the
 * handle {@link cancelFind} stops this walk by. A cancelled search rejects with
 * the message `cancelled`, which is a NORMAL outcome, not a failure.
 */
export function findInFiles(
  root: string,
  query: string,
  options: FindOptions,
  searchId?: string,
): Promise<FindResult> {
  return invoke<FindResult>("find_in_files", { root, query, options, searchId });
}

/* ── Find Files (fuzzy FILENAME finder) ──────────────────────────────────────
 * A sibling of `find_in_files` that matches file *names* rather than file
 * *content* (the Cmd/Ctrl+Shift+O quick-open). Own command + own wire types,
 * served by the same Rust module. */

/** The one modifier the filename finder carries (no regex/word/glob here). */
export interface FindFilesOptions {
  /** Match the query's case exactly (Cc). */
  caseSensitive: boolean;
}

/**
 * One filename hit. `path` is RELATIVE to the search root with forward slashes
 * (the same normalization `find_in_files` uses for `file`); `name` is the
 * basename, so the row can show it bold without re-splitting the path.
 */
export interface FindFileHit {
  path: string;
  name: string;
}

/**
 * The filename result set. `truncated` is true when Rust capped the list (a huge
 * repo / a one-character query), so the panel can say so rather than imply the
 * list is complete — the same contract as `FindResult`.
 */
export interface FindFilesResult {
  files: FindFileHit[];
  truncated: boolean;
}

/**
 * `find_files` — fuzzy-match file NAMES under `root` for `query`.
 * Same security scope as `find_in_files`/`read_dir`; Rust owns the
 * ranking. Separate from `find_in_files`, which searches file *content*.
 */
export function findFiles(
  root: string,
  query: string,
  options: FindFilesOptions,
  searchId?: string,
): Promise<FindFilesResult> {
  return invoke<FindFilesResult>("find_files", { root, query, options, searchId });
}

/* ── Cancellation ─────────────────────────────────────────────────────────────
 * A search which took too long froze the whole program; it has to run in
 * parallel so that it can be killed. Rust moved the directory walk off the
 * event-loop thread; this is the kill switch. */

/**
 * `find_cancel` — ask Rust to abandon the walk registered under `searchId`.
 * Resolves true when a live search was found and flagged, false otherwise.
 *
 * **Never throws.** A failed cancel is not the user's problem: it is best-effort
 * cleanup, the search settles on its own either way, and a rejection here would
 * surface as a spurious error on a panel the user has just walked away from. The
 * cancel is also *advisory* — the walk stops at its next check, not instantly —
 * so the caller must return to idle on its own rather than wait for this.
 */
export function cancelFind(searchId: string): Promise<boolean> {
  return invoke<boolean>("find_cancel", { searchId }).catch(() => false);
}
