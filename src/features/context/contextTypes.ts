/**
 * Context window — the wire contract between the Rust `context_usage` command and
 * the Metrics panel's "Context window" card (modelled on Claude Code's `/context` grid
 * and a stacked bar).
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 * We ask the user's own CLI, exactly like the usage strip:
 *
 *     claude -p --resume <session-id> --no-session-persistence "/context"
 *
 * run in the agent's cwd. The frontend calls `invoke("context_usage", { agentId })` with a
 * live ROOT agent's id; Rust looks up that agent's minted session id and cwd itself —
 * the session id never crosses the wire, so it is not part of this contract. The CLI loads the session read-only and prints its
 * "Estimated usage by category" table. Measured with claude 2.1.289: the
 * session's transcript size and mtime do not change and no new transcript appears,
 * so the app still never writes `~/.claude` — we ask the process
 * that owns it a read-only question. `/context` is a local command: no model call,
 * no tokens spent.
 *
 * Caveat shown in the UI: a `-p` run may load a slightly different tool/MCP set from
 * the interactive TUI, so categories are the CLI's *estimate* for that session — the
 * same word `/context` itself uses.
 */

/** One row of the CLI's "Estimated usage by category" table, in printed order. */
export interface ContextCategory {
  /** Stable slug of the CLI label: `system-prompt`, `system-tools`, `mcp-tools`,
   *  `memory-files`, `skills`, `messages`, `free-space`, `autocompact-buffer`, … —
   *  the React key, the colour key and the test handle. An unknown label still
   *  arrives (slugified), so a new CLI category renders instead of vanishing. */
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

/**
 * Error vocabulary: every `Err` is `"<code>"` or `"<code>: <detail>"`.
 * - `cli-missing`   — no `claude` binary found.
 * - `bad-session`   — not a live root agent, or its session id / cwd failed
 *                     validation (refused before spawning anything).
 * - `no-session`    — the CLI has no saved conversation for that id yet (an agent
 *                     that hasn't been sent a prompt).
 * - `cli-failed`    — non-zero exit for another reason.
 * - `timeout`       — no answer within the deadline.
 * - `parse`         — the CLI answered but not with a table we understand.
 */
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
