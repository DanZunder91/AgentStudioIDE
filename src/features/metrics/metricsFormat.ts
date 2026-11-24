/**
 * Metrics formatting — every string the dashboard renders, and nothing else.
 *
 * ── Why a separate pure module ───────────────────────────────────────────────
 * The panel's entire value is that its numbers are honest, so the numbers get pinned
 * by tests with **literal** expectations instead of being inlined in JSX where only a
 * screenshot could catch a regression. This file is pure: same inputs, same output, no
 * clock, no locale, no `Date.now()`.
 *
 * ── "No clock" is a hard rule ────────────────────────────────────────────────
 * Every relative formatter takes `nowMs` as an explicit parameter. The panel passes
 * its own slow tick; tests pass fixed epoch numbers — so a "scanned 2 min ago"
 * assertion can never be flaky and nobody needs fake timers to test a string.
 *
 * ── "No locale" is a hard rule too ───────────────────────────────────────────
 * Clock times are assembled from `Date`'s local getters, not `toLocaleTimeString`,
 * whose output moves with ICU data and the machine's locale (`11:00 AM` vs `11:00`).
 * The *timezone* is deliberately local: an hour label is only useful in the wall clock
 * the user reads off their own screen.
 *
 * ── 🔴 There is no formatter for a token total ───────────────────────────────
 * Deliberately. {@link formatTokens} takes ONE number, so there is no function in this
 * module you could hand a {@link import("./metricsTypes").TokenClasses} to and get a
 * sum out of. The absence is the guard: see `metricsTypes.ts`.
 */

import type {
  DurationSource,
  MetricsErrorCode,
  MetricsScopeKind,
  MetricsWindowKind,
  TurnRow,
} from "./metricsTypes";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** The dash the panel shows for a value we do not have. Never `0`, never `??`. */
export const UNKNOWN = "—";

/**
 * `4h 12m` — the hero figure's shape, the same shape the CLI's own footer uses.
 *
 * `null` (or a negative duration, which cannot happen but would be a lie if rendered)
 * gives {@link UNKNOWN}. Zero is a real, knowable value — a turn the CLI measured at
 * 0 ms — and renders as `0s`, which is why the null check is by identity and not a
 * falsy test.
 *
 * Granularity steps down as the number shrinks so the string is never longer than it
 * has to be: `4h 12m`, `12m 30s`, `30s`, `0.4s`. Sub-second gets one decimal because
 * `0s` for 400 ms reads as "instant" when it is not.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms) || ms < 0) return UNKNOWN;
  if (ms < SECOND_MS) return ms === 0 ? "0s" : `${(ms / SECOND_MS).toFixed(1)}s`;
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * A token count, compacted: `456.8k`, `201.2M`, `14`.
 *
 * Compact because these numbers span four orders of magnitude (~10 k fresh input
 * against ~200 M cache reads in the same window) and a tile is ~120 px wide. One decimal from 1 k up: two
 * would be noise at this magnitude and would make the tile widths jump.
 *
 * The exact figure is never lost — {@link formatExact} puts it in the tile's title
 * attribute, so nothing is reachable only through a rounded string.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * A plain count for a KPI tile: `1,250`. Thousands separators inserted by hand rather
 * than `toLocaleString`, for the no-locale reason in the docblock (a German locale
 * would render `1.250`, and the tests would then depend on the developer's machine).
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  return formatExact(Math.round(n));
}

/** `201234567` → `201,234,567`. The un-rounded truth, for titles and tooltips. */
export function formatExact(n: number): string {
  if (!Number.isFinite(n)) return UNKNOWN;
  const negative = n < 0;
  const digits = Math.abs(Math.round(n)).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/**
 * The hero's subtitle: `8 human turns across 3 sessions`.
 *
 * System-initiated turns are called out separately rather than folded in — collapsing
 * them would inflate "you prompted N tasks", and a sizeable share of turns are
 * `promptSource: "system"`. Pluralization is explicit because "1 human turns" is the
 * kind of detail that makes a dashboard look unfinished.
 */
export function formatTurnSubtitle(
  humanTurns: number,
  turns: number,
  sessions: number,
): string {
  const base = `${formatCount(humanTurns)} ${plural(humanTurns, "human turn")} across ${formatCount(sessions)} ${plural(sessions, "session")}`;
  const systemTurns = turns - humanTurns;
  if (systemTurns <= 0) return base;
  return `${base} · ${formatCount(systemTurns)} system-initiated`;
}

/**
 * How much of `timeInTurns` we actually know, when we do not know all of it:
 * `4 of 8 turns measured`. Empty string when every turn has a duration, so the panel
 * renders nothing rather than a reassurance nobody needs.
 */
export function formatDurationCoverage(
  turnsWithDuration: number,
  turns: number,
): string {
  if (turns === 0 || turnsWithDuration >= turns) return "";
  return `${formatCount(turnsWithDuration)} of ${formatCount(turns)} ${plural(turns, "turn")} measured`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** `145.2k` context, or {@link UNKNOWN} when there were no requests to average. */
export function formatAvgContext(avg: number | null): string {
  return avg === null ? UNKNOWN : formatTokens(avg);
}

/** `55%` of requests at ≥150 k context, or {@link UNKNOWN}. */
export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return UNKNOWN;
  return `${Math.round(Math.min(Math.max(share, 0), 1) * 100)}%`;
}

/**
 * The window's human name, used in the header and in the empty state's sentence so
 * the two can never disagree about which window produced no results.
 */
export function windowLabel(kind: MetricsWindowKind): string {
  return kind === "last_24h" ? "last 24 h" : "last 7 d";
}

/**
 * The scope toggle's two labels. "All projects" and not "All usage": this side of the
 * dashboard is one machine's transcripts, and only the account block above it may say
 * "all devices" (a truth condition, not styling).
 */
export function scopeLabel(kind: MetricsScopeKind): string {
  return kind === "all" ? "All projects" : "This project";
}

/**
 * The empty window's headline, which must name the scope it found nothing in — "no
 * sessions today" and "no sessions in THIS FOLDER today" are different facts, and an
 * earlier version only ever said the second.
 */
export function formatEmptyTitle(
  scope: MetricsScopeKind,
  window: MetricsWindowKind,
): string {
  const where = scope === "all" ? "on this machine" : "for this project";
  return `No Claude sessions found ${where} in the ${windowLabel(window)}.`;
}

/**
 * The empty window's second line: how much was looked at, and where the missing sessions
 * would be. In `project` scope that sentence has an actionable answer (widen the scope),
 * so it says so instead of leaving the user to guess that a toggle exists.
 */
export function formatEmptyNote(
  scope: MetricsScopeKind,
  filesConsidered: number,
): string {
  const checked = `${formatCount(filesConsidered)} ${plural(filesConsidered, "transcript")} checked.`;
  return scope === "all"
    ? `${checked} Every project folder on this machine was included.`
    : `${checked} Sessions run in another folder are counted there — switch to All projects to see them.`;
}

/**
 * The coverage block's "Scope" row.
 *
 * The fallback case is the one that matters: the report then answers a **wider** question
 * than the one it was asked, and a dashboard that does that silently is the same class of
 * dishonesty as a summed token total.
 */
export function formatScopeCoverage(
  scope: MetricsScopeKind,
  fellBackToAll: boolean,
): string {
  if (fellBackToAll) {
    return "All projects — this project was requested, but no project is selected";
  }
  return scope === "all" ? "All projects on this machine" : "This project only";
}

/**
 * `Scanned just now` / `Scanned 2 min ago` / `Scanned 3 h ago`.
 *
 * Under a minute is "just now": a per-second countdown on a scan nobody is watching
 * is noise, and "Scanned 0 min ago" is not a sentence. A clock that has gone backwards
 * (`nowMs < scannedAtMs`, e.g. an NTP correction) also reads "just now" rather than
 * "in 3 minutes".
 */
export function formatScannedAt(scannedAtMs: number, nowMs: number): string {
  const delta = nowMs - scannedAtMs;
  if (delta < MINUTE_MS) return "Scanned just now";
  if (delta < HOUR_MS) return `Scanned ${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < 24 * HOUR_MS) return `Scanned ${Math.floor(delta / HOUR_MS)} h ago`;
  return `Scanned ${Math.floor(delta / (24 * HOUR_MS))} d ago`;
}

/**
 * An hour bucket's axis label, local wall clock: `14:00`.
 *
 * Buckets are hour-long slots measured from the window's start, so a label can carry
 * minutes (`14:30`) if the window did not begin on the hour — which is the honest
 * thing to show, since the bucket really does start there.
 */
export function formatHourLabel(startMs: number): string {
  const d = new Date(startMs);
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

/** A turn's start, for the table's `when` column: `14:32`. */
export function formatClock(ms: number): string {
  return formatHourLabel(ms);
}

/**
 * The `(cli)` / `(derived)` marker beside a duration. Empty when the duration is
 * unknown — there is no source to name.
 */
export function formatDurationSource(source: DurationSource | null): string {
  if (source === null) return "";
  return source === "cli" ? "cli" : "derived";
}

/**
 * The corrected form of Claude Code's own per-turn footer.
 *
 * The CLI's own footer has the shape `4m 30s · ↓ 72.0k tokens`. That single token
 * number cannot be salvaged: even at one-turn scale cache reads dominate by ~200×, so
 * it would be reporting the wrong quantity. The compact *form* survives with the
 * classes kept apart:
 *
 * ```text
 * 4m 30s · ↑200 fresh · ↓60.0k out · ♻12.0M cached
 * ```
 *
 * `cached` folds cache write and cache read into one **labelled** figure — they are
 * both "context that was not fresh", and the four-tile group above is where the split
 * lives. This is a compact restatement of numbers already broken out on the same
 * screen, not a summary that replaces them, and it is never a grand total: `out` is
 * never added to `cached`.
 */
export function formatTurnFooter(turn: TurnRow): string {
  const { freshInput, output, cacheWrite, cacheRead } = turn.tokens;
  return [
    formatDuration(turn.durationMs),
    `↑${formatTokens(freshInput)} fresh`,
    `↓${formatTokens(output)} out`,
    `♻${formatTokens(cacheWrite + cacheRead)} cached`,
  ].join(" · ");
}

/**
 * A turn's display label, and the place the `all`-scope privacy rule becomes visible.
 *
 * Three rungs, in order:
 * 1. The turn's own text, when there is any — which in `all` scope there **never** is
 *    (Rust sends `label: null` by rule, so this rung is unreachable there and no future
 *    edit to this function can put another repo's prompt on screen).
 * 2. **`<project basename> · <turn time>`** — the identification the design specifies for
 *    `all` scope. It names *which* repo a turn came from, which is genuinely the
 *    useful thing once several are on one screen, and it is a basename so it is never a
 *    path.
 * 3. The session id's first 8 chars — a handle rather than content, for a transcript that
 *    carried no `cwd` field at all (empty or summary-only).
 */
export function turnLabel(turn: TurnRow): string {
  if (turn.label !== null && turn.label.trim() !== "") return turn.label;
  if (turn.projectLabel.trim() !== "") {
    return `${turn.projectLabel} · ${formatClock(turn.startedAtMs)}`;
  }
  return `${turn.sessionId.slice(0, 8)}…`;
}

/**
 * The coverage badge's text: `complete`, or what exactly was missed.
 *
 * A partial scan must announce *what* was partial — "partial" alone tells the user
 * their numbers are wrong without telling them how, which is worse than either
 * extreme. Reasons are joined rather than prioritized because two can be true at once.
 */
export function formatCoverageBadge(coverage: {
  partial: boolean;
  filesTruncated: number;
  rootsUnavailable: string[];
}): string {
  if (!coverage.partial) return "complete";
  const reasons: string[] = [];
  if (coverage.filesTruncated > 0) {
    reasons.push(
      `${formatCount(coverage.filesTruncated)} ${plural(coverage.filesTruncated, "file")} truncated`,
    );
  }
  if (coverage.rootsUnavailable.length > 0) {
    reasons.push(`${formatCount(coverage.rootsUnavailable.length)} source unavailable`);
  }
  return reasons.length === 0 ? "partial" : `partial — ${reasons.join(", ")}`;
}

/**
 * Split a raw rejection into its code. Rust returns `"<code>"` or
 * `"<code>: <detail>"`; **the detail is deliberately discarded here** — it could
 * mention a path, and this module's output is rendered.
 *
 * Anything unrecognized becomes `"unknown"`, so a raw Rust string can never reach the
 * DOM. Mirrors `usageFormat.parseUsageError`.
 */
export function parseMetricsError(reason: unknown): MetricsErrorCode {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : String(reason);
  // `split(":", 1)` always yields exactly one element — even for `""` — so there is
  // no absent-element case to guard. An `?? ""` here would be an unreachable branch
  // pretending to be defence, and the `default` arm below already
  // handles every string this can produce.
  const code = text.split(":", 1)[0].trim();
  switch (code) {
    case "home-unresolved":
    case "no-transcripts":
    case "scan-failed":
    case "root-unavailable":
      return code;
    default:
      return "unknown";
  }
}

/** One true sentence per failure code. Never a stack trace, never a path. */
export function describeMetricsError(code: MetricsErrorCode): string {
  switch (code) {
    case "home-unresolved":
      return "Your home directory could not be resolved, so there is nowhere to read sessions from.";
    case "no-transcripts":
      return "No Claude session transcripts were found.";
    case "scan-failed":
      return "The session scan could not be run for this folder.";
    case "root-unavailable":
      return "The transcript folder could not be read.";
    case "unknown":
      return "The session scan failed for an unknown reason.";
  }
}
