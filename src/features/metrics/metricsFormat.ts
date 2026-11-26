/** Every string the metrics dashboard renders. Pure: no clock (relative formatters take `nowMs`)
 * and no locale (hand-built separators and clock times, local timezone). Deliberately no
 * token-total formatter: see `metricsTypes.ts`. */

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

/** `4h 12m` / `12m 30s` / `30s` / `0.4s`. Null or negative is UNKNOWN; zero is a real `0s`, hence
 * the identity check rather than a falsy test. */
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

/** Compact token count (`456.8k`, `201.2M`, `14`), one decimal from 1k up. Tiles keep the exact
 * figure in their title via {@link formatExact}. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** `1,250` with hand-inserted separators: `toLocaleString` would vary with the machine locale. */
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

/** `8 human turns across 3 sessions`; system-initiated turns are called out, not folded in. */
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

/** `4 of 8 turns measured`, or "" when every turn has a duration. */
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

/** Shared by the header and the empty state so they never disagree about the window. */
export function windowLabel(kind: MetricsWindowKind): string {
  return kind === "last_24h" ? "last 24 h" : "last 7 d";
}

/** "All projects", not "All usage": this side is one machine's transcripts; only the account
 * block may say "all devices". */
export function scopeLabel(kind: MetricsScopeKind): string {
  return kind === "all" ? "All projects" : "This project";
}

/** Names its scope: "no sessions today" and "none in this folder today" are different facts. */
export function formatEmptyTitle(
  scope: MetricsScopeKind,
  window: MetricsWindowKind,
): string {
  const where = scope === "all" ? "on this machine" : "for this project";
  return `No Claude sessions found ${where} in the ${windowLabel(window)}.`;
}

/** How much was scanned and where missing sessions would be; project scope suggests widening. */
export function formatEmptyNote(
  scope: MetricsScopeKind,
  filesConsidered: number,
): string {
  const checked = `${formatCount(filesConsidered)} ${plural(filesConsidered, "transcript")} checked.`;
  return scope === "all"
    ? `${checked} Every project folder on this machine was included.`
    : `${checked} Sessions run in another folder are counted there — switch to All projects to see them.`;
}

/** The "Scope" row. A fallback to a wider scope than asked must be stated, never silent. */
export function formatScopeCoverage(
  scope: MetricsScopeKind,
  fellBackToAll: boolean,
): string {
  if (fellBackToAll) {
    return "All projects — this project was requested, but no project is selected";
  }
  return scope === "all" ? "All projects on this machine" : "This project only";
}

/** `Scanned just now` / `2 min ago` / `3 h ago`. Under a minute, or a clock gone backwards,
 * reads "just now". */
export function formatScannedAt(scannedAtMs: number, nowMs: number): string {
  const delta = nowMs - scannedAtMs;
  if (delta < MINUTE_MS) return "Scanned just now";
  if (delta < HOUR_MS) return `Scanned ${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < 24 * HOUR_MS) return `Scanned ${Math.floor(delta / HOUR_MS)} h ago`;
  return `Scanned ${Math.floor(delta / (24 * HOUR_MS))} d ago`;
}

/** `14:00`, local wall clock. Buckets count from the window start, so `14:30` is possible. */
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

/** The `(cli)` / `(derived)` marker; empty when the duration is unknown. */
export function formatDurationSource(source: DurationSource | null): string {
  if (source === null) return "";
  return source === "cli" ? "cli" : "derived";
}

/** Claude Code's per-turn footer with token classes kept apart (`↑ fresh · ↓ out · ♻ cached`).
 * `cached` folds cache write + read; it is never summed with `out` into a grand total. */
export function formatTurnFooter(turn: TurnRow): string {
  const { freshInput, output, cacheWrite, cacheRead } = turn.tokens;
  return [
    formatDuration(turn.durationMs),
    `↑${formatTokens(freshInput)} fresh`,
    `↓${formatTokens(output)} out`,
    `♻${formatTokens(cacheWrite + cacheRead)} cached`,
  ].join(" · ");
}

/** The turn's own text (Rust sends null in `all` scope: privacy), else
 * `<project basename> · <turn time>`, else the session id's first 8 chars. */
export function turnLabel(turn: TurnRow): string {
  if (turn.label !== null && turn.label.trim() !== "") return turn.label;
  if (turn.projectLabel.trim() !== "") {
    return `${turn.projectLabel} · ${formatClock(turn.startedAtMs)}`;
  }
  return `${turn.sessionId.slice(0, 8)}…`;
}

/** `complete`, or exactly what was missed; reasons are joined since several can hold at once. */
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

/** The code from Rust's `"<code>"` / `"<code>: <detail>"`. The detail is dropped (it could name a
 * path); unrecognised codes become `"unknown"`. Mirrors `usageFormat.parseUsageError`. */
export function parseMetricsError(reason: unknown): MetricsErrorCode {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : String(reason);
  // `split(":", 1)` always yields one element, so no fallback is needed.
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
