/** Wire contract of Rust's context_usage: claude -p --resume <id> --no-session-persistence
 * "/context" in the agent's cwd (read-only, so ~/.claude is never written; no model call). Rust
 * resolves the session id itself. Categories are the CLI's estimate, and the UI says so. */

/** One row of the CLI's "Estimated usage by category" table, in printed order. */
export interface ContextCategory {
  /** Slug of the CLI label (system-prompt, free-space, …): React key, colour key, test handle.
   *  An unknown label still arrives slugified, so a new CLI category renders. */
  key: string;
  /** The CLI's own label, e.g. "System tools (deferred)". */
  label: string;
  /** Tokens, parsed from the CLI's "2.3k" / "1.2m" / "717" form. */
  tokens: number;
  /** Percent of the window, 0..=100, as printed. */
  percent: number;
}

/** A whole `/context` reading for one session. */
export interface ContextUsage {
  /** e.g. "claude-opus-5-5". */
  model: string;
  /** Tokens in use (the CLI's "290.7k" of "290.7k / 1m"). */
  usedTokens: number;
  /** The model's window (the "1m"). */
  windowTokens: number;
  /** Percent used, as printed ("(29%)"). */
  usedPercent: number;
  /** Every category row, in printed order — includes `free-space` and
   *  `autocompact-buffer` when the CLI prints them. */
  categories: ContextCategory[];
  /** When this reading was taken, unix ms. */
  measuredAtMs: number;
}

/** "<code>" or "<code>: <detail>". cli-missing; bad-session (not a live root, or session/cwd failed
 * validation before spawning); no-session (no conversation yet); cli-failed (other non-zero exit);
 * timeout; parse (an answer that is not a table we understand). */
export type ContextErrorCode =
  | "cli-missing"
  | "bad-session"
  | "no-session"
  | "cli-failed"
  | "timeout"
  | "parse";

export const CONTEXT_ERROR_CODES: readonly ContextErrorCode[] = [
  "cli-missing",
  "bad-session",
  "no-session",
  "cli-failed",
  "timeout",
  "parse",
];
