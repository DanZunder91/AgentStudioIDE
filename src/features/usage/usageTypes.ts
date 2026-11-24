/**
 * Usage limits — the wire contract between the Rust `claude_usage` command and
 * the left-rail usage strip.
 *
 * ── Where the numbers come from, and why THIS way ────────────────────────────
 * `claude -p --no-session-persistence "/usage"` — we ask the user's own CLI, and
 * parse the three lines it prints:
 *
 *     Current session: 20% used · resets Jul 29 at 3:10pm (UTC)
 *     Current week (all models): 40% used · resets Aug 2 at 11am (UTC)
 *     Current week (Fable): 60% used · resets Aug 2 at 10:59am (UTC)
 *
 * The first implementation of this feature read the OAuth token out of the login
 * Keychain and called `GET /api/oauth/usage` directly. It worked, but it made
 * macOS raise a "Agent Studio wants to use your confidential information stored in
 * Claude Code-credentials" password prompt — because that Keychain item's ACL
 * trusts the `claude` binary, not ours, and the app must never require an OS
 * permission prompt for this. Asking the CLI instead means
 * the process that already owns the credential is the one that reads it, so
 * **there is no prompt, and this app never touches a token at all** — strictly
 * better on privacy, not just on UX.
 *
 * `--no-session-persistence` is load-bearing: without it every poll leaves a
 * transcript in `~/.claude/projects/…` (~720 files/hour at a 5 s cadence, which
 * would also flood the "Recover session" picker). With it, measured: exit 0,
 * ~1 s, and the transcript count does not move.
 *
 * ── One unit, one clock ──────────────────────────────────────────────────────
 * `resetsAtMs` is **unix milliseconds**, resolved Rust-side from the CLI's
 * human-formatted local time. The CLI prints in the machine's own timezone (it
 * names it in parentheses), so it is parsed as local time; anything unparseable
 * becomes `null` rather than a guess, and the UI simply shows no reset hint.
 */

/**
 * One usage window as the strip renders it.
 *
 * `key` is a stable slug derived from the CLI's row label — the React key and the
 * test handle. Deliberately a plain `string`, not a union: the CLI decides which
 * rows exist (today session / all models / one per metered model), so a closed
 * union would silently DROP a row the day a new one appears.
 *
 * `label` is what the user reads. The CLI's own wording is condensed: "Current
 * session" stays, "Current week (all models)" → "All models",
 * "Current week (Fable)" → "Fable".
 */
export interface UsageWindow {
  key: string;
  label: string;
  /** Percent consumed, 0..100, as the CLI reported it. */
  usedPct: number;
  /** When this window resets, unix ms — `null` when the CLI's wording was not parseable. */
  resetsAtMs: number | null;
}

/** A whole reading of the account's limits, in the order the CLI printed them. */
export interface UsageSnapshot {
  windows: UsageWindow[];
  /** When this reading was taken (unix ms, Rust's clock). */
  fetchedAtMs: number;
}

/**
 * Stable error codes from `claude_usage`. The strip must be able to say something
 * TRUE and specific when the read fails — "the CLI isn't installed" and "you're
 * signed out" call for different words, and inventing numbers is never an option.
 *
 * Rust returns `Err(String)` shaped as `"<code>"` or `"<code>: <detail>"`.
 */
export type UsageErrorCode =
  /** The `claude` binary could not be found (GUI apps inherit a minimal PATH). */
  | "cli-missing"
  /** The CLI ran but is not authenticated — `claude auth login` fixes it. */
  | "not-signed-in"
  /** The CLI ran and failed for some other reason (non-zero exit). */
  | "cli-failed"
  /** The CLI did not answer within the timeout. */
  | "timeout"
  /** It answered, but the output held no readable usage rows. */
  | "parse"
  /** Anything unclassified — kept so the UI never renders a raw Rust string. */
  | "unknown";
