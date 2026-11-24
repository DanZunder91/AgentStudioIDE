/**
 * Blame — the pure logic behind the IntelliJ-style annotate gutter.
 *
 * Everything here is a pure function of its arguments (no DOM, no IPC, no CM6),
 * so the label rules, the run collapsing, the line clamping, and the popover
 * model are exhaustively unit-testable under jsdom. The CM6/DOM glue in
 * `blameGutter.ts` stays thin by consuming these.
 *
 * Locale note: the `locale` parameter exists for deterministic tests (which pass
 * "en-US"); production callers omit it, so dates render in the user's locale —
 * IntelliJ's "short local date" behavior.
 */

import type { BlameCommit, FileBlame } from "./blameIpc";

/** What an uncommitted (or beyond-blame) line shows in the gutter, dimmed. */
export const UNCOMMITTED_LABEL = "—"; // em dash

/**
 * The author's LAST name — the final whitespace-separated token, IntelliJ-style
 * ("Max Turing" → "Turing"; a single-word author is returned as-is).
 */
export function lastNameOf(author: string): string {
  const parts = author.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** Short local date for the gutter label, e.g. "5/27/26" in en-US. */
export function shortBlameDate(timeMs: number, locale?: string): string {
  return new Date(timeMs).toLocaleDateString(locale, {
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  });
}

/** Full local date + time for the popover, e.g. "May 27, 2026, 3:41:22 PM". */
export function fullBlameDate(timeMs: number, locale?: string): string {
  return new Date(timeMs).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/**
 * Which lines start a run — IntelliJ only labels the FIRST line of a consecutive
 * same-commit run. `flags[i]` is true iff `lines[i]` differs from its
 * predecessor (line 0's predecessor is taken to be `null`, so `flags[0]` is true
 * exactly when line 0 is committed).
 */
export function firstOfRunFlags(lines: (number | null)[]): boolean[] {
  return lines.map((v, i) => v !== (i === 0 ? null : lines[i - 1]));
}

/**
 * The commit owning document line `lineNumber` (1-based), or null for an
 * uncommitted line. CLAMPS both ways: a line beyond the blame (buffer grew, or
 * blame is stale) and a commit index outside `commits` both yield null — a
 * mismatch renders as "uncommitted", never a crash.
 */
export function commitForLine(blame: FileBlame, lineNumber: number): BlameCommit | null {
  const idx = blame.lines[lineNumber - 1];
  if (idx === null || idx === undefined) return null;
  return blame.commits[idx] ?? null;
}

/**
 * The gutter label for one line: "5/27/26 Turing" on the first line of a
 * committed run, "" on the run's continuation lines, and a dimmed em dash for an
 * uncommitted line (every one — a dash is a placeholder, not an annotation).
 */
export function gutterLabel(
  commit: BlameCommit | null,
  firstOfRun: boolean,
  locale?: string,
): string {
  if (commit === null) return UNCOMMITTED_LABEL;
  if (!firstOfRun) return "";
  return `${shortBlameDate(commit.timeMs, locale)} ${lastNameOf(commit.author)}`;
}

/** The hover popover's display model — one string per row, plus the message. */
export interface BlamePopoverModel {
  /** Full commit hash (rendered monospace, prefixed "commit "). */
  hash: string;
  /** "Name <email>". */
  author: string;
  /** Localized date + time. */
  date: string;
  /** Repo-relative path. */
  path: string;
  /** Full commit message, trailing whitespace trimmed; falls back to summary. */
  message: string;
}

/** Build the popover model for one commit of `relPath`'s blame. */
export function popoverModel(
  commit: BlameCommit,
  relPath: string,
  locale?: string,
): BlamePopoverModel {
  return {
    hash: commit.id,
    author: `${commit.author} <${commit.email}>`,
    date: fullBlameDate(commit.timeMs, locale),
    path: relPath,
    message: commit.message.replace(/\s+$/, "") || commit.summary,
  };
}

/**
 * The calm inline note for a rejected `git_blame` — "No git history" for a file
 * outside any repo, a generic note otherwise. Rust rejects with a plain string
 * (see `blameIpc.ts`), but an `Error` is tolerated too.
 */
export function blameErrorNote(err: unknown): string {
  const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return /not in a git repository/i.test(msg) ? "No git history" : "Blame unavailable";
}
