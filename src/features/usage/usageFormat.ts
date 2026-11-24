/**
 * Usage-limits formatting — every string the usage panel renders, and nothing else.
 *
 * ── Why a separate pure module ───────────────────────────────────────────────
 * The panel shows numbers about the user's *account*: how much of a rate-limit
 * window is spent and when it turns over. Those strings are the whole feature —
 * a wrong percent or an optimistic reset time is worse than no panel at all, so
 * they get pinned by tests with literal expectations instead of being inlined in
 * JSX where only a screenshot could catch a regression. The store owns fetching
 * and state; this file owns *wording*, and it is pure: same inputs, same output,
 * no clock, no locale, no `Date.now()`.
 *
 * ── "No clock" is a hard rule ────────────────────────────────────────────────
 * Both relative formatters take `nowMs` as an explicit parameter. The caller
 * passes its own tick (the panel re-renders on a timer), and tests pass fixed
 * epoch numbers — so a countdown assertion can never be flaky, and nobody needs
 * `vi.useFakeTimers` to test a string.
 *
 * ── "No locale" is a hard rule too ───────────────────────────────────────────
 * The absolute reset time is assembled by hand from `Date`'s local getters with
 * the weekday table below, NOT by `toLocaleString`. `toLocaleString` output moves
 * with ICU data and the machine's locale (`11:00 AM` vs `11:00 a.m.` vs `11:00`),
 * which would make the tests machine-dependent and the UI inconsistent between
 * two developers' laptops. The *timezone* is still deliberately local — a reset
 * time is only useful in the wall-clock the user reads off their own screen.
 */

import { parseWireCode } from "../../lib/wireCode";
import type { UsageErrorCode } from "./usageTypes";

/** Severity of a window's fill, used to pick the bar colour + the pill class. */
export type UsageTone = "ok" | "warn" | "danger";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `getDay()` → short weekday. Index 0 is Sunday, per the `Date` contract. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Normalize an incoming percent to a renderable 0..100.
 *
 * Rust already clamps `utilization × 100` into range, so in practice this is a
 * no-op — it exists because "in practice" is not a guarantee across an IPC seam,
 * and a panel that renders `-3% used` or a bar overflowing its track would look
 * like the app is broken rather than like the CLI printed something odd. `NaN` (a
 * missing field deserialized loosely, a 0/0) collapses to 0 for the same reason:
 * `NaN% used` is not a sentence, and an empty bar is the least alarming way to
 * render a number we could not read.
 *
 * The **order** of the guards matters. `NaN` is rejected by name rather than by
 * `!Number.isFinite`, so `±Infinity` falls through to the range clamp and lands
 * at 100 / 0 — an infinite utilization is over the limit, and treating it that
 * way is the same rule that maps 137 to 100, not a special case. Written the
 * other way round first, this mapped `Infinity` to an *empty* bar, which the
 * monotonicity property in the test file caught immediately.
 *
 * This single funnel is also why {@link usageTone} and {@link formatUsedPct}
 * can never disagree — a bar cannot be painted red while its label reads 0%.
 */
function clampPct(usedPct: number): number {
  if (Number.isNaN(usedPct)) return 0;
  if (usedPct < 0) return 0;
  if (usedPct > 100) return 100;
  return usedPct;
}

/**
 * The thresholds: green below 60, yellow from 60, red from 90.
 *
 * The boundaries are inclusive on the *upper* band (60 is already `warn`, 90 is
 * already `danger`) because these are "you have crossed this line" warnings —
 * a window sitting at exactly 90% should look spent, not comfortable.
 *
 * Non-finite input answers `"ok"`: it goes through {@link clampPct} to 0, so a
 * broken number reads as an un-alarming empty bar. Painting `danger` would be
 * the worse lie — it would tell the user their account is nearly exhausted on
 * the strength of a value we could not read.
 */
export function usageTone(usedPct: number): UsageTone {
  const pct = clampPct(usedPct);
  if (pct >= 90) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

/**
 * `"24% used"` — the row's label under the bar.
 *
 * Rounds half-up to a whole percent: fractional precision is noise at this size,
 * and `Math.round` on an already-clamped non-negative value is exactly half-up
 * (the `-0.5` asymmetry that makes `Math.round` unsuitable in general cannot be
 * reached here). Note the ceiling behaviour is intentional at both ends: 99.6
 * shows `100% used` because a window that close is, for the user's purposes,
 * full — and 0.4 shows `0% used` rather than pretending the window is untouched
 * only when it truly is 0. The exact value stays in the snapshot for the
 * tooltip/bar width; only the label rounds.
 */
export function formatUsedPct(usedPct: number): string {
  return `${formatPct(usedPct)} used`;
}

/** Just the number + sign, e.g. `"24%"` — for the collapsed rail chip. */
export function formatPct(usedPct: number): string {
  return `${Math.round(clampPct(usedPct))}%`;
}

/**
 * When this window turns over, phrased for a glance.
 *
 * - `null` → `""`. Rust reports `null` when the CLI's reset wording could not be
 *   parsed confidently; the panel renders nothing rather than guessing a time, and
 *   `""` lets the caller skip the element.
 * - Past, or under a minute out → `"Resets now"`. Deliberately *not* "Reset 3
 *   min ago": once the boundary passes, the snapshot in hand is stale and the
 *   only true statement is that the window is turning over. Sub-minute is folded
 *   into the same bucket so the string never reads `"Resets in 0 min"`.
 * - Under an hour → `"Resets in 34 min"`.
 * - Under a day → `"Resets in 4 hr 34 min"` (Claude Code's own wording).
 *   A whole number of hours drops the minutes entirely — `"Resets in 4 hr"`, not
 *   `"Resets in 4 hr 0 min"`.
 * - A day or more out → `"Resets Sun 11:00 AM"`. Beyond ~24h a countdown stops
 *   being actionable ("in 31 hr" makes nobody plan anything), while a weekday +
 *   wall-clock time does. It is truncated to weekday deliberately: the weekly
 *   windows never span more than 7 days, so no date is needed to disambiguate.
 *
 * Remaining time **truncates** rather than rounds (4 hr 34 min 59 s reads
 * `"4 hr 34 min"`), which is how every countdown a user has ever read behaves:
 * the number only ever ticks down, and it never overstates the wait.
 *
 * Returns `""` for input we cannot describe truthfully: a non-finite `nowMs` or
 * `resetsAtMs`, or a timestamp outside the representable `Date` range (past
 * ±8.64e15 ms `new Date()` is an Invalid Date and every getter yields `NaN`, so
 * the absolute branch would otherwise emit `"Resets undefined NaN:NaN AM"`).
 *
 * @param resetsAtMs Unix ms of the reset, or `null` when the CLI's wording for it
 *                   was not parseable.
 * @param nowMs      Unix ms "now", supplied by the caller — never read here.
 */
export function formatResetsAt(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return "";
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs)) return "";

  const remaining = resetsAtMs - nowMs;
  if (remaining < MINUTE_MS) return "Resets now";

  if (remaining < HOUR_MS) {
    return `Resets in ${Math.floor(remaining / MINUTE_MS)} min`;
  }

  if (remaining < DAY_MS) {
    const hours = Math.floor(remaining / HOUR_MS);
    const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
    return minutes === 0
      ? `Resets in ${hours} hr`
      : `Resets in ${hours} hr ${minutes} min`;
  }

  const at = new Date(resetsAtMs);
  if (Number.isNaN(at.getTime())) return "";
  return `Resets ${WEEKDAYS[at.getDay()]} ${formatClock(at)}`;
}

/**
 * `h:mm AM/PM` from a valid `Date`'s local getters. Hand-rolled, not
 * `toLocaleTimeString` — see the locale note in this file's header.
 *
 * Both 0 and 12 o'clock map to `12` (`"12:00 AM"` for midnight, `"12:00 PM"` for
 * noon), which is the one place 12-hour clocks trip people up.
 */
function formatClock(at: Date): string {
  const h24 = at.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

/**
 * `"Updated just now"` / `"Updated 2 min ago"` — the panel's footer, so a stale
 * reading can never be mistaken for a live one.
 *
 * Buckets: under 10 s is `"just now"` (finer than that is churn nobody reads),
 * then seconds (`"Updated 42s ago"`), then minutes, then hours. Hours is the
 * last bucket by design — a snapshot older than a day is pathological, and
 * `"Updated 74 hr ago"` communicates "very stale" perfectly well without another
 * branch to test.
 *
 * A `fetchedAtMs` in the future (Rust stamps the fetch with its own clock, and
 * the two clocks are the same machine's but not the same read) clamps to
 * `"Updated just now"` rather than printing a negative age.
 */
export function formatFetchedAt(fetchedAtMs: number, nowMs: number): string {
  const raw = nowMs - fetchedAtMs;
  const age = Number.isFinite(raw) && raw > 0 ? raw : 0;

  if (age < 10_000) return "Updated just now";
  if (age < MINUTE_MS) return `Updated ${Math.floor(age / 1000)}s ago`;
  if (age < HOUR_MS) return `Updated ${Math.floor(age / MINUTE_MS)} min ago`;
  return `Updated ${Math.floor(age / HOUR_MS)} hr ago`;
}

/** The codes we are willing to act on; everything else becomes `"unknown"`. */
const KNOWN_CODES: readonly UsageErrorCode[] = [
  "cli-missing",
  "not-signed-in",
  "cli-failed",
  "timeout",
  "parse",
  "unknown",
];

/**
 * Map a raw rejection from `claudeUsage()` to a stable {@link UsageErrorCode}.
 *
 * Rust rejects with `"<code>"` or `"<code>: <detail>"`, but what actually lands
 * in the `catch` is only *usually* that string: Tauri wraps some failures in an
 * `Error`, and a plumbing fault (a panic, a missing command, a serialization
 * error) can surface as an object or `undefined`. So this is written as a parser
 * over untrusted input, not as a lookup:
 *
 * 1. take the message — the string itself, or `.message` when there is one;
 * 2. take the segment before the first `":"`, trim it, lowercase it;
 * 3. accept it only if it is a code we know.
 *
 * Anything else — `null`, `undefined`, a number, a plain object, a rewritten
 * message from some layer in between — is `"unknown"`. Guessing would be worse
 * than admitting ignorance: telling a user "sign in again" when the real fault
 * was a PATH that hides the binary sends them off to break a working login.
 *
 * `.message` is duck-typed rather than gated on `instanceof Error`, because an
 * `Error` that crossed a realm boundary (a worker, the webview bridge) fails
 * `instanceof` while still carrying a perfectly good message.
 */
export function parseUsageError(raw: unknown): UsageErrorCode {
  // Delegated to `lib/wireCode` — and this file's version is the one the shared reader
  // adopted: duck-typing `.message` instead of requiring `instanceof Error` is what keeps a
  // cross-realm error readable, and the other two copies were the ones that had it wrong.
  return parseWireCode(raw, KNOWN_CODES, "unknown");
}

/**
 * One short, TRUE sentence per code — what happened, and the next move.
 *
 * Every sentence here describes the CLI, because the CLI is the whole data path:
 * we run `claude -p --no-session-persistence "/usage"` and read its stdout, so
 * this app makes no request of its own and never reads a credential.
 * That is why none of these mention a network, an API, a token or a keychain —
 * a sentence like "couldn't reach Anthropic" would be a *guess about someone
 * else's process*, and it would send the user to check a connection that was
 * never in the path.
 *
 * Rules these sentences follow, and the reason for each: they never blame the
 * user (a signed-out CLI is not a mistake they made), they never invent a cause
 * we did not observe (`cli-failed` says "exited with an error", not "you are
 * rate limited"), and they never imply the panel could show numbers if only the
 * user tried harder — `parse` says outright that retrying will not help, because
 * pointing at a retry button that cannot work is its own small lie.
 *
 * The `claude` CLI is named by name, and `claude auth login` is spelled exactly
 * as the CLI spells it, because that CLI is the only place a login can be
 * established — the IDE deliberately never writes to `~/.claude`,
 * so it cannot sign anyone in itself.
 *
 * `cli-missing` says "couldn't be found" rather than "isn't installed": a GUI
 * app is launched by the window server, not by a login shell, so it inherits a
 * minimal PATH without `~/.local/bin` — the overwhelmingly likely case is a CLI
 * that *is* installed and merely invisible to us, and "install it" alone would
 * be the wrong diagnosis for it.
 *
 * Exhaustive `switch` with no `default`: adding a code to the union then has to
 * fail `tsc` here rather than silently render nothing.
 */
export function describeUsageError(code: UsageErrorCode): string {
  switch (code) {
    case "cli-missing":
      return "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry.";
    case "not-signed-in":
      return "The claude CLI is signed out — run claude auth login in a terminal, then retry.";
    case "cli-failed":
      return "The claude CLI ran but exited with an error — retry, or run claude \"/usage\" in a terminal to see what it reports.";
    case "timeout":
      return "The claude CLI did not answer in time — retry in a moment.";
    case "parse":
      return "The claude CLI answered, but its output was not in a format this panel can read — its wording has probably changed, so retrying will not help.";
    case "unknown":
      return "The usage read failed for an unrecognized reason — retrying may help.";
  }
}
