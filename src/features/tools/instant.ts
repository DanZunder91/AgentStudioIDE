/**
 * The Tools panel's time primitives — an exact instant, the numeric-epoch reader,
 * and the renderers that turn an instant into the lines a human reads.
 *
 * ⚠️ **This file's exported signatures are a CONTRACT** (see `epoch.ts` and
 * `dateParse.ts`, which are written against it). Change a shape here and you change
 * both of them.
 *
 * ── Why `Instant` and not `Date` ─────────────────────────────────────────────
 * A JS `number` holds an integral nanosecond epoch only up to 2^53 ns ≈ 104 days
 * past 1970, so `1700000000123456789` (a perfectly ordinary Go/`hrtime` nanosecond
 * stamp) does not survive `Number()`. Everything numeric here is read with `BigInt`
 * and only then split into `{ epochMs, nanos }` — whole milliseconds, which `Date`
 * can hold exactly, plus the sub-millisecond remainder that `Date` cannot.
 *
 * ── Why the formatting is hand-rolled ────────────────────────────────────────
 * `new Date(string)` parsing is engine-defined for anything that is not exactly ISO
 * 8601, so it is never used (see `dateParse.ts`). `Date` IS used for calendar maths,
 * but only through its `getUTC*` accessors, which are specified exactly.
 *
 * `usageFormat.ts` and `metricsFormat.ts` each have an "N min ago" helper; neither is
 * reusable here — both hard-code a prefix ("Updated…", "Scanned…"), both stop at
 * hours, and neither can express the future ("in 3 days"), which is half of what a
 * date converter is asked.
 *
 * ── Why `Intl` is used for zones and NOTHING else ────────────────────────────
 * There is no zone database in this repo and there will not be one: the app is
 * zero-install, and shipping `luxon`/`date-fns-tz` to learn that Paris was
 * `+02:00` on 15 Jun 2026 means shipping a tzdata copy that goes stale. The platform
 * already has one, reachable through `Intl.DateTimeFormat`, so zone offsets are
 * *derived* from it (see {@link zoneOffsetMsAt}) rather than tabulated.
 *
 * But `Intl` is asked ONLY for numbers — year, month, day, hour, minute, second —
 * never for words. Every weekday and month name below comes from a table in this
 * file, and every string is assembled here. Two reasons: `toLocaleString` output
 * moves with the host's locale and its ICU version (`11:00 AM` / `11:00 a.m.` /
 * `11.00`), which would make these strings untestable and inconsistent between two
 * developers' laptops; and the panel wants one fixed shape, not the user's. The
 * formatter is built with an explicit `en-US-u-ca-gregory-nu-latn` locale for the
 * same reason — a host whose default locale is `ar-EG` would otherwise hand back
 * Arabic-Indic digits and a non-Gregorian year, and `Number()` would quietly return
 * `NaN`.
 */

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

/**
 * An exact point in time.
 *
 * `epochMs` is FLOORED whole milliseconds since 1970-01-01T00:00:00Z (negative
 * before it), and `nanos` is always `0…999_999` — the remainder ADDED to it. Floor
 * semantics (not truncation) so a pre-1970 instant still has a non-negative
 * remainder and `epochMs * 1e6 + nanos` is the total, at every sign.
 */
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

/**
 * Floor division for a POSITIVE divisor.
 *
 * `BigInt`'s `/` truncates toward zero, so `-1n / 1_000_000n` is `0n` and the
 * remainder comes out negative — which would give a pre-1970 instant a *negative*
 * `nanos` and break the `epochMs * 1e6 + nanos` identity that the whole file rests
 * on. Every division here is a floor for the same reason every epoch is a floor: an
 * epoch names the second/millisecond the instant is *inside*, and truncation would
 * round the past toward the future.
 */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}

/** Keeps a probe time inside `Date`'s range — `Intl` throws `RangeError` outside it. */
function clampMs(ms: number): number {
  return Math.min(MAX_EPOCH_MS, Math.max(-MAX_EPOCH_MS, ms));
}

/**
 * Split a total nanosecond count into an `Instant`, or `null` when it lands outside
 * the range `Date` can represent (±273,790 years). Floor division, so the `nanos`
 * remainder is non-negative before 1970 too.
 */
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

/**
 * The UTC epoch of a set of wall-clock fields, in whole milliseconds — `NaN` when it
 * is out of `Date`'s range.
 *
 * ⚠️ **`Date.UTC` is not used**, and that is the entire point of this function.
 * `Date.UTC(50, 0, 1)` is **1950**, not the year 50: ECMA-262 §21.4.3.4 maps years
 * 0–99 onto 1900–1999, so a converter built on it silently answers a date nineteen
 * centuries away from the one it was asked about. `setUTCFullYear` has no such
 * mapping.
 *
 * The year, month and day are set in ONE call on purpose. Setting them one at a time
 * rolls over through an invalid intermediate — starting from 1 January and setting
 * the day to 29 before setting the month to February is fine, but the reverse order
 * turns 29 February of a leap year into 1 March. `setUTCFullYear(y, m, d)` computes
 * the day number from all three at once (MakeDay), so `0000-02-29` — a real date,
 * year 0 being divisible by 400 — survives.
 */
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

/**
 * The instant those wall-clock fields name **in UTC**, or `null` if it is out of
 * range. Does not validate the calendar — `dateParse.ts` owns that.
 *
 * `civil.nanos` carries up to nine fractional digits, so it feeds BOTH halves of the
 * result: its whole-millisecond part joins the `Date` maths, and the sub-millisecond
 * remainder becomes the `Instant`'s `nanos`.
 */
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

/**
 * Numbers only, `h23` so midnight is `00` rather than `12 AM`, and `era` so that a
 * BC year is recognisable — `Intl` reports year 0 as "1 BC", and reading that as
 * 1 would put the offset probe two thousand years off.
 */
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

/**
 * How far the zone is AHEAD of UTC at that instant, in milliseconds — negative west
 * of Greenwich, and DST-correct because it is measured at `atMs` rather than looked
 * up in a table that would be wrong twice a year.
 *
 * Measured against the whole SECOND containing `atMs`: `Intl` reports no sub-second
 * field, and some historical offsets are not whole minutes (Paris ran on
 * +00:09:21 mean time until 1911), so subtracting the raw millisecond value would fold the
 * instant's own fraction into the offset.
 */
function zoneOffsetMsAt(fmt: Intl.DateTimeFormat, atMs: number): number {
  return utcMsOfWall(wallInZone(fmt, atMs)) - Math.floor(atMs / 1000) * 1000;
}

/** A wall clock compared as one value — six `&&`s would be six ways to get it wrong. */
function wallKey(w: Wall): string {
  return `${w.year}|${w.month}|${w.day}|${w.hour}|${w.minute}|${w.second}`;
}

/** How far back to look for the offset in force BEFORE a transition. */
const AMBIGUITY_PROBE_MS = 86_400_000;

/**
 * The instant those wall-clock fields name **in `timeZone`** — how the "you may have
 * meant your own clock" alternative is computed for a date typed with no offset.
 *
 * `null` when the zone is unknown to the platform, or the result is out of range.
 * A wall-clock time that a DST jump skipped resolves the way the platform's own
 * offset lookup does; a repeated hour resolves to its first occurrence.
 *
 * ── Why three probes and not one ─────────────────────────────────────────────
 * Going wall-clock → instant is the hard direction: the answer depends on the offset,
 * and the offset depends on the answer. The standard fix is two passes — read the
 * offset at the UTC guess, apply it, read it again at the corrected guess — and two
 * passes settle every unambiguous case, because a zone transition is at most a couple
 * of hours wide.
 *
 * Two passes are not enough for the hour that DST gives back, though. On 25 October
 * 2026 Paris's 02:30 happens twice, and both passes probe *after* the transition, so
 * they converge on the second (standard-time) occurrence and never see the first.
 * A third probe a day earlier finds the pre-transition offset, and then the candidates
 * are FILTERED — a candidate counts only if the zone actually renders it back as the
 * wall clock we were asked about — and the earliest survivor wins. That filter is what
 * makes the skipped-hour case honest too: on 29 March 2026 Paris has no 02:30 at all,
 * every candidate is rejected, and the fallback is the platform's own settled offset
 * rather than a silently invented time.
 */
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

/**
 * One way of reading a bare number: "if this is microseconds, it is …".
 *
 * `instant` is `null` when that reading falls outside the representable range —
 * which is the NORMAL case for three of the four readings of a 19-digit nanosecond
 * stamp, so it is a state to render, not an error.
 */
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

/**
 * Sign, digits with single `_` separators, an optional fraction, an optional unit.
 *
 * `\d(?:_?\d)*` rather than `[\d_]*` so a trailing or doubled separator is NOT
 * numeric: `1700000000_` is a typo, and reading it as a valid epoch would hide the
 * typo behind a plausible date. Both micro signs are listed because U+00B5 (MICRO
 * SIGN, what a keyboard emits) and U+03BC (GREEK SMALL LETTER MU, what a Go or Rust
 * program prints) are visually identical and both arrive on the clipboard.
 */
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

/**
 * The digit-count heuristic, in the words the panel prints.
 *
 * Every boundary is the same moment — 10^11 seconds, 10^14 milliseconds and 10^17
 * microseconds are all the year 5138 — which is why one rule can sort all four units
 * and why it will not need revisiting in anyone's career.
 */
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

/**
 * Read a bare number as an epoch, or return `null` when the input is not numeric at
 * all (so the caller can try to parse it as a date string instead).
 *
 * Accepts: optional sign, `_` digit separators, an optional fractional part, and an
 * optional unit suffix (`s`, `ms`, `us`, `µs`, `ns`, case-insensitive, with or
 * without a space). Anything else is not numeric.
 *
 * **Unit detection, when no suffix was typed**, by the digit count of the integer
 * part — the standard heuristic, chosen because each boundary sits at the year 5138:
 * ≤11 digits → seconds, ≤14 → milliseconds, ≤17 → microseconds, more → nanoseconds.
 * `because` states the rule that fired, because a guess the user cannot see is a
 * guess they cannot correct.
 *
 * Leading zeros do not count — `01700000000` is ten significant digits and a seconds
 * epoch, not eleven digits of something else.
 *
 * All four readings are computed every time, and each is scaled with `BigInt` from
 * the digit STRING. Nothing here ever goes through `Number()`: `1700000000123456789`
 * is 2^53-and-then-some, and the one number this tool exists to read correctly is
 * exactly the one that `Number()` corrupts. Fractional digits finer than a nanosecond
 * are floored away, in the same direction (toward the past) as everything else.
 */
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

/**
 * The instant's epoch in one unit, as an exact decimal string.
 *
 * A string, not a number: `1700000000123456789` is not representable as a `number`,
 * and this value's whole purpose is to be copied and pasted somewhere else. Sub-unit
 * precision that the unit cannot hold is TRUNCATED toward the past (floor), matching
 * how every epoch is a floor of the instant it names — so one nanosecond before 1970
 * is `-1` seconds, the second it is inside, and never `0`.
 */
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

/**
 * `Mon, 15 Jun 2026 · 07:12:34`.
 *
 * The weekday is DERIVED from the fields rather than read from `Intl`: a wall clock
 * plus a weekday is redundant information, and asking two different sources for it
 * is how a UI ends up claiming that Monday the 15th was a Tuesday.
 */
function formatWall(w: Wall): string {
  const weekday = WEEKDAYS[new Date(utcMsOfWall(w)).getUTCDay()];
  const date = `${pad2(w.day)} ${MONTHS[w.month - 1]} ${formatYear(w.year)}`;
  return `${weekday}, ${date} · ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

/**
 * `UTC+02:00` / `UTC-03:30` / `UTC`.
 *
 * Rounded to whole minutes. Modern offsets are all whole minutes; the ones that are
 * not are pre-1900 local mean times (Paris's +00:09:21), where the seconds are an
 * artefact of a town clock rather than information anybody wants in this field.
 */
function formatOffset(offsetMs: number): string {
  const minutes = Math.round(offsetMs / 60_000);
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * The ISO 8601 form, widened only as far as the instant actually goes: milliseconds
 * normally, six digits when there are microseconds, nine when there are nanoseconds.
 * Padding every timestamp out to nine digits would make `.000000000` the most common
 * thing on screen and bury the digits that matter.
 *
 * `toISOString` supplies the calendar part, including the expanded-year form for
 * anything outside 0000–9999 (`+275760-09-13T…`, `-000001-…`) — a format worth
 * inheriting rather than re-deriving. The sub-millisecond digits are ours, because
 * `Date` does not have them.
 */
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

/**
 * Render an instant. `now` drives {@link relativeTo}; `timeZone` is an IANA zone id
 * (the panel passes the host's). An unknown zone degrades to UTC rather than
 * throwing — a converter that dies because a machine has an odd zone is worse than
 * one that says UTC.
 */
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

/**
 * The scale ladder: use `ms` as the divisor while `|Δ|` is under `limit`.
 *
 * Each `limit` is exactly the next scale's unit, which is what makes the floor below
 * safe: the smallest `|Δ|` that reaches a rung is one whole unit of that rung, so no
 * rung can ever print `0`, and every rung can print `1`. That is the property the
 * commonly-copied ladder (45s / 90min / 36h / 30d) does NOT have — under it the
 * smallest value on the "hours" rung is 90 minutes, which floors to 1 but rounds to
 * 2, "1 day ago" is unreachable, and there is a window where the honest answer is
 * "12 months". The rungs below are boring and always true: `2 hours ago` means at
 * least two hours have passed, at every scale.
 *
 * Years is the open-ended rung and therefore has no `limit`; see {@link relativeTo}.
 */
const SCALES: readonly { limit: number; ms: number; noun: string }[] = [
  { limit: MINUTE_MS, ms: SECOND_MS, noun: "second" },
  { limit: HOUR_MS, ms: MINUTE_MS, noun: "minute" },
  { limit: DAY_MS, ms: HOUR_MS, noun: "hour" },
  { limit: MONTH_MS, ms: DAY_MS, noun: "day" },
  { limit: YEAR_MS, ms: MONTH_MS, noun: "month" },
];

/**
 * `just now` / `42 seconds ago` / `in 3 days` / `2 years ago`.
 *
 * Bidirectional on purpose (an epoch converter is asked about the future as often as
 * the past), and singular/plural is real English. The scale boundaries are pinned by
 * tests, not by feel — see {@link SCALES} for the ladder and why it is that one.
 *
 * Anything within a second either way is `just now`, which is also how the sign stops
 * mattering at the point where it stops being meaningful. The instant's sub-millisecond
 * part is deliberately ignored: no phrasing here has the resolution to show it.
 */
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
