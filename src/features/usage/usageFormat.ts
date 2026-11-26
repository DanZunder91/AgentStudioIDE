/** Every string the usage panel renders; pure, pinned by literal tests. No clock (callers pass
 * `nowMs`) and no locale (times are assembled by hand, never `toLocaleString`, so output matches
 * on every machine); the timezone is deliberately local. */

import { parseWireCode } from "../../lib/wireCode";
import type { UsageErrorCode } from "./usageTypes";

/** Severity of a window's fill, used to pick the bar colour + the pill class. */
export type UsageTone = "ok" | "warn" | "danger";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `getDay()` → short weekday. Index 0 is Sunday, per the `Date` contract. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Clamp to 0..100 (IPC input is not guaranteed). `NaN` → 0, but ±Infinity clamps like any value
 * (Infinity → 100), so the guard order matters. One funnel keeps tone and label in agreement. */
function clampPct(usedPct: number): number {
  if (Number.isNaN(usedPct)) return 0;
  if (usedPct < 0) return 0;
  if (usedPct > 100) return 100;
  return usedPct;
}

/** Green below 60, yellow from 60, red from 90 (upper band inclusive: crossing a line warns).
 * Non-finite input clamps to 0 → "ok": an unreadable value must not claim exhaustion. */
export function usageTone(usedPct: number): UsageTone {
  const pct = clampPct(usedPct);
  if (pct >= 90) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

/** `"24% used"`: rounds half-up to a whole percent (`Math.round` is exact half-up on a clamped
 * non-negative value). The exact value stays in the snapshot; only the label rounds. */
export function formatUsedPct(usedPct: number): string {
  return `${formatPct(usedPct)} used`;
}

/** Just the number + sign, e.g. `"24%"` — for the collapsed rail chip. */
export function formatPct(usedPct: number): string {
  return `${Math.round(clampPct(usedPct))}%`;
}

/** `null` → `""`; past or < 1 min → "Resets now"; < 1 h → "in 34 min"; < 1 day → "in 4 hr 34 min"
 * (or "in 4 hr"); else "Resets Sun 11:00 AM" (weekly windows never span > 7 days). Remaining time
 * truncates, never overstating. Non-finite or out-of-`Date`-range input → `""`. */
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

/** `h:mm AM/PM` from local getters (no locale, see header); 0 and 12 o'clock both show `12`. */
function formatClock(at: Date): string {
  const h24 = at.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

/** "Updated just now" (< 10 s), then seconds, minutes, hours (the last bucket). A future
 * `fetchedAtMs` (Rust's clock) clamps to "just now". */
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

/** Parse an untrusted rejection: its string or duck-typed `.message` (a cross-realm `Error` fails
 * `instanceof`), the segment before `:`, trimmed and lowercased, kept only if a known code.
 * Anything else is `"unknown"`: a wrong guess sends the user to fix the wrong thing. */
export function parseUsageError(raw: unknown): UsageErrorCode {
  // Delegated to `lib/wireCode` — and this file's version is the one the shared reader
  // adopted: duck-typing `.message` instead of requiring `instanceof Error` is what keeps a
  // cross-realm error readable, and the other two copies were the ones that had it wrong.
  return parseWireCode(raw, KNOWN_CODES, "unknown");
}

/** One short TRUE sentence per code. The CLI is the whole data path, so none mentions a network,
 * API or keychain; none blames the user or invents a cause. `cli-missing` says "couldn't be found":
 * GUI apps get a minimal PATH. No `default`, so a new code fails `tsc` here. */
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
