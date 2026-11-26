/** Pure logic behind the annotate gutter (`blameGutter.ts` is the DOM glue). `locale` exists only
 * for deterministic tests; production omits it so dates use the user's locale. */

import type { BlameCommit, FileBlame } from "./blameIpc";

/** What an uncommitted (or beyond-blame) line shows in the gutter, dimmed. */
export const UNCOMMITTED_LABEL = "—"; // em dash

/** The final whitespace-separated token ("Max Turing" → "Turing"); one word is returned as is. */
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

/** `flags[i]` is true iff `lines[i]` differs from its predecessor (null before line 0); only a
 * run's first line is labeled. */
export function firstOfRunFlags(lines: (number | null)[]): boolean[] {
  return lines.map((v, i) => v !== (i === 0 ? null : lines[i - 1]));
}

/** Clamps both ways: a line beyond the blame or a commit index outside `commits` gives null, so a
 * stale blame renders as uncommitted rather than crashing. */
export function commitForLine(blame: FileBlame, lineNumber: number): BlameCommit | null {
  const idx = blame.lines[lineNumber - 1];
  if (idx === null || idx === undefined) return null;
  return blame.commits[idx] ?? null;
}

/** Date + last name on a run's first line, "" on its continuation, a dimmed dash on every
 * uncommitted line. */
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

/** Rust rejects with a plain string (see `blameIpc.ts`); an `Error` is tolerated too. */
export function blameErrorNote(err: unknown): string {
  const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return /not in a git repository/i.test(msg) ? "No git history" : "Blame unavailable";
}
