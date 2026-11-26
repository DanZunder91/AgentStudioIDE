/** Wire contract of the Rust `claude_usage` command, which parses the user's own CLI's `/usage`
 * output: the CLI owns the credential, so no Keychain prompt and no token here. Its
 * `--no-session-persistence` flag is load-bearing (else each poll leaves a transcript). */

/** One window as rendered. `key`: a stable slug of the CLI's row label, a plain string (not a
 * union) because the CLI decides which rows exist. `label`: condensed wording, e.g.
 * "Current week (all models)" → "All models". */
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

/** Stable `claude_usage` error codes, so a failure reads as something TRUE and specific. Rust
 * returns `Err(String)` shaped as `"<code>"` or `"<code>: <detail>"`. */
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
