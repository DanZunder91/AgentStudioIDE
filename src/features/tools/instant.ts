/** Time primitives; exported signatures are a CONTRACT for `epoch.ts` and `dateParse.ts`. Epochs
 * are read with `BigInt` (`number` loses ns stamps). `Intl` gives zone NUMBERS only, under an
 * explicit `en-US-u-ca-gregory-nu-latn` locale; every word comes from tables here. */

/** The units a bare number on the clipboard is plausibly in. */
export type EpochUnit = "s" | "ms" | "us" | "ns";

/** Every unit, coarsest first — the order the "also reads as" list is shown in. */
export const EPOCH_UNITS: readonly EpochUnit[] = ["s", "ms", "us", "ns"];

/** How each unit's name is written for a human. */
export const UNIT_LABEL: Readonly<Record<EpochUnit, string>> = {
  s: "seconds",
  ms: "milliseconds",
  us: "microseconds",
  ns: "nanoseconds",
};

/** `epochMs`: FLOORED whole ms since 1970 (negative before); `nanos`: the 0…999_999 remainder
 * ADDED to it, so `epochMs * 1e6 + nanos` is the total at every sign. */
export interface Instant {
  epochMs: number;
  nanos: number;
}

/** Wall-clock fields with no zone attached — what a date STRING literally says. */
export interface Civil {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31, validated against the month and the year's leap day. */
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0…999_999_999 — sub-second precision as typed. */
  nanos: number;
}

/** `Date`'s representable range, in ms either side of 1970 (ECMA-262 §21.4.1.1). */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Nanoseconds in one of each unit — the multiplier a raw number is scaled by. */
export const NANOS_PER: Readonly<Record<EpochUnit, bigint>> = {
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
};

// ───────────────────────────────────────────────────────────────────────────────
// Arithmetic that JavaScript gets wrong by default
// ───────────────────────────────────────────────────────────────────────────────

const NANOS_PER_MS = 1_000_000n;
const MAX_EPOCH_MS_BIG = BigInt(MAX_EPOCH_MS);

/** Floor division for a POSITIVE divisor: `BigInt` `/` truncates toward zero, which would give
 * pre-1970 instants negative `nanos`. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}

/** Keeps a probe time inside `Date`'s range — `Intl` throws `RangeError` outside it. */
function clampMs(ms: number): number {
  return Math.min(MAX_EPOCH_MS, Math.max(-MAX_EPOCH_MS, ms));
}

/** Split total ns into an `Instant` (floored, so `nanos` ≥ 0), or `null` outside `Date`'s range
 * (±273,790 years). */
export function instantFromNanos(totalNs: bigint): Instant | null {
  const ms = floorDiv(totalNs, NANOS_PER_MS);
  if (ms > MAX_EPOCH_MS_BIG) return null;
  if (ms < -MAX_EPOCH_MS_BIG) return null;
  return { epochMs: Number(ms), nanos: Number(totalNs - ms * NANOS_PER_MS) };
}

/** The inverse of {@link instantFromNanos} — the instant as a total nanosecond count. */
export function nanosOf(instant: Instant): bigint {
  return BigInt(instant.epochMs) * NANOS_PER_MS + BigInt(instant.nanos);
}

/** UTC epoch ms of wall-clock fields, `NaN` out of range. Not `Date.UTC`: it maps years 0–99 to
 * the 1900s. Year, month, day go in ONE `setUTCFullYear` call so 0000-02-29 doesn't roll over. */
function utcMsOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, ms);
  return d.getTime();
}

/** The instant those fields name in UTC, or `null` out of range; no calendar validation
 * (`dateParse.ts` owns that). `civil.nanos` splits into whole ms and the sub-ms `nanos`. */
export function instantFromCivilUtc(civil: Civil): Instant | null {
  const carryMs = Math.floor(civil.nanos / 1_000_000);
  const subMs = civil.nanos - carryMs * 1_000_000;
  const ms = utcMsOf(
    civil.year,
    civil.month,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
    carryMs,
  );
  // Out of range is `NaN`, not a throw and not a clamp (ECMA-262 §21.4.1.1).
  if (Number.isNaN(ms)) return null;
  return { epochMs: ms, nanos: subMs };
}

// ───────────────────────────────────────────────────────────────────────────────
// Zones — derived from the platform's tzdata, never tabulated
// ───────────────────────────────────────────────────────────────────────────────

/** Wall-clock fields with no sub-second part — what a zone lookup hands back. */
interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Numbers only; `h23` so midnight is `00`; `era` so year 0 ("1 BC") isn't misread as 1. */
const ZONE_FIELDS: Intl.DateTimeFormatOptions = {
  era: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** The locale is pinned, not the host's — see the file header. */
const ZONE_LOCALE = "en-US-u-ca-gregory-nu-latn";

/** A formatter for `timeZone`, or `null` when the platform does not know the id. */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat(ZONE_LOCALE, { ...ZONE_FIELDS, timeZone });
  } catch {
    // An unknown IANA id is a `RangeError`, which is the ONLY way to find out — there
    // is no `Intl.supportedTimeZonesOf`, and `Intl.supportedValuesOf("timeZone")` is
    // both newer than our floor and a list we would have to linear-scan.
    return null;
  }
}

/** What clock the zone reads at that instant. */
function wallInZone(fmt: Intl.DateTimeFormat, atMs: number): Wall {
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(atMs))) parts[part.type] = part.value;
  const year = Number(parts.year);
  return {
    // "1 BC" is astronomical year 0, "2 BC" is −1, and so on.
    year: parts.era === "BC" ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    // `% 24` guards the old ICU quirk where `h23` still reported midnight as "24".
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The UTC epoch of a wall clock, whole seconds — the inverse of {@link wallInZone}. */
function utcMsOfWall(w: Wall): number {
  return utcMsOf(w.year, w.month, w.day, w.hour, w.minute, w.second, 0);
}

/** Zone offset AHEAD of UTC at `atMs`, ms (DST-correct: measured, not tabulated), against the
 * whole containing SECOND: `Intl` has no sub-second field and old offsets aren't whole minutes. */
function zoneOffsetMsAt(fmt: Intl.DateTimeFormat, atMs: number): number {
  return utcMsOfWall(wallInZone(fmt, atMs)) - Math.floor(atMs / 1000) * 1000;
}

/** A wall clock compared as one value — six `&&`s would be six ways to get it wrong. */
function wallKey(w: Wall): string {
  return `${w.year}|${w.month}|${w.day}|${w.hour}|${w.minute}|${w.second}`;
}

/** How far back to look for the offset in force BEFORE a transition. */
const AMBIGUITY_PROBE_MS = 86_400_000;

/** The instant wall-clock fields name in `timeZone`; `null` for an unknown zone or out of range.
 * Three offset probes (one a day earlier), filtered to candidates the zone renders back, earliest
 * wins: a repeated DST hour gives its first occurrence, a skipped one the platform's offset. */
export function civilInZone(civil: Civil, timeZone: string): Instant | null {
  const asUtc = instantFromCivilUtc(civil);
  if (asUtc === null) return null;
  const fmt = zoneFormatter(timeZone);
  if (fmt === null) return null;

  const target = asUtc.epochMs;
  const settled = zoneOffsetMsAt(fmt, clampMs(target - zoneOffsetMsAt(fmt, target)));
  const before = zoneOffsetMsAt(fmt, clampMs(target - settled - AMBIGUITY_PROBE_MS));
  const wanted = wallKey(civil);

  let best: number | null = null;
  for (const offset of [settled, before]) {
    const at = target - offset;
    if (Math.abs(at) > MAX_EPOCH_MS) continue;
    if (wallKey(wallInZone(fmt, at)) !== wanted) continue;
    if (best === null || at < best) best = at;
  }
  if (best !== null) return { epochMs: best, nanos: asUtc.nanos };

  // Nothing rendered back: the wall clock was skipped by a DST jump (or the caller
  // handed us a non-canonical civil). Concede to the platform's settled offset.
  const at = target - settled;
  if (Math.abs(at) > MAX_EPOCH_MS) return null;
  return { epochMs: at, nanos: asUtc.nanos };
}

/** One reading of a bare number; `instant` null (out of range) is a NORMAL state to render. */
export interface EpochReading {
  unit: EpochUnit;
  /** Why this unit could be the one, in a sentence the panel prints verbatim. */
  because: string;
  instant: Instant | null;
}

/** What {@link parseNumericEpoch} understood a numeric input to be. */
export interface NumericEpoch {
  /** The reading the panel leads with. */
  chosen: EpochReading;
  /** The other three, in {@link EPOCH_UNITS} order — the "also reads as" list. */
  others: EpochReading[];
  /** True when a unit SUFFIX was typed (`1700000000ms`), so nothing was guessed. */
  explicit: boolean;
  /** The digits as understood, separators stripped — quoted back in the explanation. */
  normalized: string;
}

/** `\d(?:_?\d)*` so a trailing or doubled `_` is a typo, not numeric. Both micro signs (U+00B5
 * from keyboards, U+03BC from program output) are accepted. */
const NUMERIC_RE = /^([+-]?)(\d(?:_?\d)*)(?:\.(\d(?:_?\d)*))?\s*(s|ms|us|µs|μs|ns)?$/i;

/** Typed suffix (lower-cased) → the unit it names. */
const SUFFIX_UNIT: Readonly<Record<string, EpochUnit>> = {
  s: "s",
  ms: "ms",
  us: "us",
  "µs": "us",
  "μs": "us",
  ns: "ns",
};

/** The digit-count rule as printed. Every boundary is the same moment (10^11 s = 10^14 ms = 10^17
 * µs, year 5138), so one rule sorts all four units. */
const DIGIT_RULE_TEXT: Readonly<Record<EpochUnit, string>> = {
  s: "11 or fewer digits reads as seconds",
  ms: "12 to 14 digits reads as milliseconds",
  us: "15 to 17 digits reads as microseconds",
  ns: "18 or more digits reads as nanoseconds",
};

/** Which unit a bare integer of `count` digits is guessed to be. */
function unitForDigits(count: number): EpochUnit {
  if (count <= 11) return "s";
  if (count <= 14) return "ms";
  if (count <= 17) return "us";
  return "ns";
}

/** `1 digit` / `13 digits` — the plural rule is the same one {@link relativeTo} uses. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Read a bare number as an epoch, or `null` when not numeric (the caller then tries a date).
 * Without a suffix the unit comes from significant integer digits (≤11 s, ≤14 ms, ≤17 µs, else
 * ns). All via `BigInt` from the digit STRING, never `Number()`; sub-ns digits are floored. */
export function parseNumericEpoch(raw: string): NumericEpoch | null {
  const m = NUMERIC_RE.exec(raw.trim());
  if (m === null) return null;

  const fracRaw: string | undefined = m[3];
  const suffix: string | undefined = m[4];
  const negative = m[1] === "-";
  const intDigits = m[2].replace(/_/g, "");
  const fracDigits = fracRaw === undefined ? "" : fracRaw.replace(/_/g, "");

  const magnitude = BigInt(intDigits + fracDigits);
  const signed = negative ? -magnitude : magnitude;
  const divisor = 10n ** BigInt(fracDigits.length);

  const normalized =
    (negative ? "-" : "") + intDigits + (fracDigits === "" ? "" : `.${fracDigits}`);

  // Leading zeros are not information: keep the lookahead so "0" stays one digit.
  const significant = intDigits.replace(/^0+(?=\d)/, "");
  const explicit = suffix !== undefined;
  const unit = explicit ? SUFFIX_UNIT[suffix.toLowerCase()] : unitForDigits(significant.length);

  const readings = EPOCH_UNITS.map((u): EpochReading => {
    return {
      unit: u,
      because: `If “${normalized}” is in ${UNIT_LABEL[u]}.`,
      instant: instantFromNanos(floorDiv(signed * NANOS_PER[u], divisor)),
    };
  });

  const because = explicit
    ? `The “${suffix.toLowerCase()}” suffix says ${UNIT_LABEL[unit]}, so nothing was guessed.`
    : `${plural(significant.length, "digit")} — ${DIGIT_RULE_TEXT[unit]}; every boundary sits at the year 5138.`;

  return {
    chosen: { ...readings[EPOCH_UNITS.indexOf(unit)], because },
    others: readings.filter((r) => r.unit !== unit),
    explicit,
    normalized,
  };
}

/** The epoch in `unit` as an exact decimal string (a `number` can't hold it), floored: 1 ns
 * before 1970 is `-1` seconds, never `0`. */
export function epochIn(instant: Instant, unit: EpochUnit): string {
  return floorDiv(nanosOf(instant), NANOS_PER[unit]).toString();
}

/** Everything the panel prints about one instant. */
export interface InstantView {
  /** `2026-06-15T07:12:34.123456789Z` — trailing zero groups trimmed to ms, µs or ns. */
  iso: string;
  /** `Mon, 15 Jun 2026 · 07:12:34 UTC` — the same instant, spelled for a human. */
  utc: string;
  /** The same instant in `timeZone`: `Mon, 15 Jun 2026 · 09:12:34`. */
  local: string;
  /** The zone the `local` line is in, e.g. `Europe/Paris` (`UTC` if unknown). */
  zoneName: string;
  /** That zone's offset AT THIS INSTANT, e.g. `UTC+02:00` (DST-correct). */
  zoneOffset: string;
  /** `2 hours ago` / `in 3 days` / `just now`. */
  relative: string;
  /** The epoch in each unit, exact — the four copy targets. */
  epochs: Readonly<Record<EpochUnit, string>>;
}

/** `getUTCDay()` → short weekday. Index 0 is Sunday, per the `Date` contract. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Month number − 1 → short name. Ours, not the host's — see the file header. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** Four digits, or as many as the year needs — `0050`, `2026`, `275760`, `-000001`. */
function formatYear(year: number): string {
  if (year < 0) return `-${String(-year).padStart(4, "0")}`;
  return String(year).padStart(4, "0");
}

/** The wall clock UTC reads at that instant. */
function utcWall(epochMs: number): Wall {
  const d = new Date(epochMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** `Mon, 15 Jun 2026 · 07:12:34`. The weekday is derived from the fields, never asked of a
 * second source that could disagree. */
function formatWall(w: Wall): string {
  const weekday = WEEKDAYS[new Date(utcMsOfWall(w)).getUTCDay()];
  const date = `${pad2(w.day)} ${MONTHS[w.month - 1]} ${formatYear(w.year)}`;
  return `${weekday}, ${date} · ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

/** `UTC+02:00` / `UTC-03:30` / `UTC`, rounded to whole minutes (only pre-1900 mean times have
 * seconds). */
function formatOffset(offsetMs: number): string {
  const minutes = Math.round(offsetMs / 60_000);
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** ISO 8601 widened only as far as the instant goes (ms, µs or ns digits); `toISOString`
 * supplies the calendar part, expanded years included. */
function isoOf(instant: Instant): string {
  const base = new Date(instant.epochMs).toISOString();
  if (instant.nanos === 0) return base;
  const head = base.slice(0, -1);
  const micros = pad3(Math.floor(instant.nanos / 1000));
  const nanos = instant.nanos % 1000;
  if (nanos === 0) return `${head}${micros}Z`;
  return `${head}${micros}${pad3(nanos)}Z`;
}

/** The zone's name, its clock and its offset at one instant — UTC if the id is bad. */
function zoneReading(epochMs: number, timeZone: string): { name: string; wall: Wall; offsetMs: number } {
  const fmt = zoneFormatter(timeZone);
  if (fmt === null) return { name: "UTC", wall: utcWall(epochMs), offsetMs: 0 };
  return {
    // The platform's own spelling: `utc` comes back `UTC`, and a deprecated alias
    // comes back as the zone it aliases.
    name: fmt.resolvedOptions().timeZone,
    wall: wallInZone(fmt, epochMs),
    offsetMs: zoneOffsetMsAt(fmt, epochMs),
  };
}

/** Render an instant; `now` drives {@link relativeTo}. An unknown IANA `timeZone` degrades to
 * UTC rather than throwing. */
export function viewInstant(instant: Instant, opts: { now: number; timeZone: string }): InstantView {
  const zone = zoneReading(instant.epochMs, opts.timeZone);
  return {
    iso: isoOf(instant),
    utc: `${formatWall(utcWall(instant.epochMs))} UTC`,
    local: formatWall(zone.wall),
    zoneName: zone.name,
    zoneOffset: formatOffset(zone.offsetMs),
    relative: relativeTo(instant, opts.now),
    epochs: {
      s: epochIn(instant, "s"),
      ms: epochIn(instant, "ms"),
      us: epochIn(instant, "us"),
      ns: epochIn(instant, "ns"),
    },
  };
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A Julian year / 12 = 30.4375 days — so twelve months are exactly one year. */
const MONTH_MS = 2_629_800_000;
/** 365.25 days. The Julian year, for the same reason: the two must be consistent. */
const YEAR_MS = 31_557_600_000;

/** Divide by `ms` while `|Δ|` < `limit`. Each `limit` is the next rung's unit, so no rung prints
 * `0` and every rung can print `1` ("2 hours ago" means at least two). Years has no limit. */
const SCALES: readonly { limit: number; ms: number; noun: string }[] = [
  { limit: MINUTE_MS, ms: SECOND_MS, noun: "second" },
  { limit: HOUR_MS, ms: MINUTE_MS, noun: "minute" },
  { limit: DAY_MS, ms: HOUR_MS, noun: "hour" },
  { limit: MONTH_MS, ms: DAY_MS, noun: "day" },
  { limit: YEAR_MS, ms: MONTH_MS, noun: "month" },
];

/** `just now` (within a second) / `42 seconds ago` / `in 3 days`: bidirectional, real plurals;
 * the ladder is {@link SCALES}. Sub-millisecond parts are ignored. */
export function relativeTo(instant: Instant, nowMs: number): string {
  const delta = nowMs - instant.epochMs;
  const abs = Math.abs(delta);
  if (abs < SECOND_MS) return "just now";

  let scale = { ms: YEAR_MS, noun: "year" };
  for (const candidate of SCALES) {
    if (abs < candidate.limit) {
      scale = candidate;
      break;
    }
  }

  const phrase = plural(Math.floor(abs / scale.ms), scale.noun);
  return delta >= 0 ? `${phrase} ago` : `in ${phrase}`;
}
