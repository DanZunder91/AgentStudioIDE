/** Tools panel date-string reader; exported signatures are a contract. Never `new Date(string)`:
 * non-ISO parsing is engine-defined. Matchers all end with the same five groups (zone grammar only
 * in {@link readZone}); the separator is a backreference. Ambiguous D/M vs M/D returns both. */

import { instantFromCivilUtc, type Civil, type Instant } from "./instant";

/** One way the input can be read, already resolved to an instant. */
export interface DateReading {
  instant: Instant;
  /** The format that matched, named for a human: `ISO 8601 date and time`. */
  format: string;
  /** Whether the string carried its own offset, or UTC had to be assumed. */
  zone: "explicit" | "utc-assumed";
  /** What had to be assumed, as a full sentence; `null` when the string said everything. */
  assumption: string | null;
  /** Wall-clock fields as typed, only when no offset was given (for "read in your own zone");
   * `null` with an explicit offset: the author already chose the clock. */
  civil: Civil | null;
}

/** What the reader made of the string. `readings` is never empty. */
export interface DateParse {
  /** Best first. More than one ⟹ the string is genuinely ambiguous. */
  readings: DateReading[];
  /** Set iff `readings.length > 1` — what is ambiguous, in one sentence. */
  ambiguity: string | null;
}

/** `ok: false` = date-shaped but not a real date, with the reason worth showing; `null` = not
 * date-shaped, so the caller words it. */
export type DateParseOutcome =
  | { ok: true; parse: DateParse }
  | { ok: false; reason: string }
  | null;

/** The outcome a matcher can produce: it already matched, so `null` is off the table. */
type Matched = Exclude<DateParseOutcome, null>;

/* ─────────────────────────────── calendar maths ─────────────────────────────── */

/** Month names, index 0 = January — used in the reasons a rejection prints. */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** Days per month in a common year; February is corrected by {@link daysInMonth}. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const DAY_MS = 86_400_000;

/** The proleptic Gregorian rule written out, not delegated to `Date`: the line reviewers want. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
}

/* ──────────────────────────────── validation ────────────────────────────────── */

/** The reason is the product: name the field, the legal range for that month and year, and what
 * was typed. */
function dateReason(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return `A month must be 1–12, and this says ${month}.`;
  if (day < 1) return `A day of the month must be 1 or more, and this says ${day}.`;
  const length = daysInMonth(year, month);
  if (day > length) {
    return `${MONTH_NAMES[month - 1]} ${year} has ${length} days, and this says ${day}.`;
  }
  return null;
}

/** Why this time of day is not a real one, or `null` if it is. */
function clockReason(t: Tail): string | null {
  if (t.hour > 23) return `An hour must be 0–23, and this says ${t.hour}.`;
  if (t.minute > 59) return `A minute must be 0–59, and this says ${t.minute}.`;
  if (t.second > 59) {
    return `A second must be 0–59, and this says ${t.second} — no epoch counts leap seconds.`;
  }
  return null;
}

/* ──────────────────────────── the shared tail grammar ───────────────────────── */

/** Hour is `\d{1,2}` on purpose (`2024-01-25 7:30` is typed); the range check decides validity. */
const TIME = String.raw`(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?`;

/** `UTC` precedes `UT` so the longer token wins without backtracking. */
const ZONE = String.raw`(?:\s*(Z|UTC|GMT|UT|[+-]\d{2}(?::?\d{2})?))?`;

const TAIL = TIME + ZONE;

/** The five trailing groups of every matcher, already turned into numbers. */
interface Tail {
  /** False when the string named a date and no time — the panel says 00:00:00 is ours. */
  hasTime: boolean;
  hour: number;
  minute: number;
  second: number;
  /** 0…999_999_999 — the fraction as typed, truncated at nanosecond precision. */
  nanos: number;
  /** The raw zone token, or `undefined` when the string carried none. */
  zoneToken: string | undefined;
}

function num(text: string | undefined): number {
  return text === undefined ? 0 : Number(text);
}

/** Truncates, never rounds or rejects: rounding could change the second, and long fractions are
 * real (padded `%f`). Same floor rule as `epochIn`. */
function fracNanos(frac: string | undefined): number {
  if (frac === undefined) return 0;
  return Number(`${frac}000000000`.slice(0, 9));
}

function tail(m: RegExpExecArray): Tail {
  // `RegExpExecArray` is typed `string[]`, but a group that did not participate is
  // `undefined` at runtime. Widening here is the honest type, and it is the reason
  // every optional group in this file is read through `num` / `fracNanos`.
  const groups: (string | undefined)[] = m;
  const [hour, minute, second, frac, zoneToken] = groups.slice(-5);
  return {
    hasTime: hour !== undefined,
    hour: num(hour),
    minute: num(minute),
    second: num(second),
    nanos: fracNanos(frac),
    zoneToken,
  };
}

/** `{ minutes: null }` = no zone token; a number = an explicit offset; else the reason. */
type ZoneRead = { minutes: number | null } | { reason: string };

/** The one place the zone grammar is interpreted. Offsets are range-checked so a typo never
 * silently shifts the instant by 25 hours. */
function readZone(token: string | undefined): ZoneRead {
  if (token === undefined) return { minutes: null };
  const upper = token.toUpperCase();
  if (upper === "Z" || upper === "UTC" || upper === "GMT" || upper === "UT") {
    return { minutes: 0 };
  }
  const hours = Number(token.slice(1, 3));
  const rest = token.slice(3).replace(":", "");
  const minutes = rest === "" ? 0 : Number(rest);
  if (hours > 23) {
    return { reason: `A zone offset's hours must be 0–23, and “${token}” says ${hours}.` };
  }
  if (minutes > 59) {
    return { reason: `A zone offset's minutes must be 0–59, and “${token}” says ${minutes}.` };
  }
  const sign = token.startsWith("-") ? -1 : 1;
  return { minutes: sign * (hours * 60 + minutes) };
}

/* ───────────────────────────────── assembly ─────────────────────────────────── */

/** `as Instant` is safe: `null` only outside `Date`'s ±8.64e15 ms, and `\d{4}` years stay two
 * orders of magnitude inside, so a guard would be unreachable. */
function utcInstant(civil: Civil): Instant {
  return instantFromCivilUtc(civil) as Instant;
}

function assumedSentence(hasTime: boolean): string {
  return hasTime
    ? "No zone was given, so this wall-clock time is read as UTC."
    : "No time of day was given, so 00:00:00 is assumed, and no zone was given, so it is read as UTC.";
}

function assemble(
  format: string,
  civil: Civil,
  offsetMinutes: number | null,
  hasTime: boolean,
): DateReading {
  const utc = utcInstant(civil);
  if (offsetMinutes === null) {
    return {
      instant: utc,
      format,
      zone: "utc-assumed",
      assumption: assumedSentence(hasTime),
      civil,
    };
  }
  // The wall clock was `offsetMinutes` ahead of UTC, so the instant is that much earlier; the
  // test pins the exact 7_200_000 ms gap between `…+02:00` and `…Z`.
  return {
    instant: { epochMs: utc.epochMs - offsetMinutes * 60_000, nanos: utc.nanos },
    format,
    zone: "explicit",
    assumption: null,
    civil: null,
  };
}

function civilOf(year: number, month: number, day: number, t: Tail): Civil {
  return {
    year,
    month,
    day,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
    nanos: t.nanos,
  };
}

function fail(reason: string): Matched {
  return { ok: false, reason };
}

function only(reading: DateReading): Matched {
  return { ok: true, parse: { readings: [reading], ambiguity: null } };
}

/** Validate, then assemble, the one reading a non-ambiguous format produces. */
function single(format: string, year: number, month: number, day: number, t: Tail): Matched {
  const reason = dateReason(year, month, day) ?? clockReason(t);
  if (reason !== null) return fail(reason);
  const zone = readZone(t.zoneToken);
  if ("reason" in zone) return fail(zone.reason);
  return only(assemble(format, civilOf(year, month, day, t), zone.minutes, t.hasTime));
}

/* ──────────────────────────────── the matchers ──────────────────────────────── */

/** `Jan(?:uary)?|Feb(?:ruary)?|…` — three letters or the full name, nothing between. */
const MONTH_ALT = MONTH_NAMES.map((n) => `${n.slice(0, 3)}(?:${n.slice(3)})?`).join("|");
const WEEKDAY_ALT = WEEKDAY_NAMES.map((n) => `${n.slice(0, 3)}(?:${n.slice(3)})?`).join("|");

/** Total: the token is a {@link MONTH_ALT} match and the twelve 3-letter prefixes are distinct. */
function monthNumber(token: string): number {
  const head = token.slice(0, 3).toLowerCase();
  return MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(head)) + 1;
}

const DAY_FIRST = "Day-first date (D/M/Y)";
const MONTH_FIRST = "Month-first date (M/D/Y)";
/** `05/05/2010` — day and month are the same number, so the two readings coincide. */
const BOTH_ORDERS_AGREE = "Numeric date (D/M/Y and M/D/Y agree)";

function withTime(base: string, hasTime: boolean): string {
  return hasTime ? `${base} and time` : base;
}

/** Everything a `build` needs: the match, the trimmed text, and the caller's clock. */
interface MatchContext {
  m: RegExpExecArray;
  text: string;
  nowMs: number;
}

/** Resolved against `nowMs`, never `Date.now()`. The day boundary is floor-divided so a pre-1970
 * clock lands on the start of its day. */
function keywordReading(word: string, nowMs: number): DateReading {
  const clock = Math.floor(nowMs);
  if (word === "now") {
    return {
      instant: { epochMs: clock, nanos: 0 },
      format: "Keyword “now”",
      zone: "explicit",
      assumption:
        "“now” is the clock this window was given, not anything in the text; an instant is the same instant in every zone, so no zone was assumed.",
      civil: null,
    };
  }
  const delta = word === "yesterday" ? -1 : word === "tomorrow" ? 1 : 0;
  const start = (Math.floor(clock / DAY_MS) + delta) * DAY_MS;
  const at = new Date(start);
  return {
    instant: { epochMs: start, nanos: 0 },
    format: `Keyword “${word}”`,
    zone: "utc-assumed",
    assumption: `“${word}” is resolved against the clock this window was given and against the UTC day, so 00:00:00 UTC is assumed — your own zone may already be on a different date.`,
    civil: {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
      nanos: 0,
    },
  };
}

/** The only ambiguous shape. Early returns, not "build both and filter", so the rejection names
 * the near-miss reading (`02/30/2010` is month-first). Both readings when both fit and differ. */
function buildYearLast(ctx: MatchContext): Matched {
  const t = tail(ctx.m);
  const clock = clockReason(t);
  if (clock !== null) return fail(clock);
  const zone = readZone(t.zoneToken);
  if ("reason" in zone) return fail(zone.reason);

  const first = Number(ctx.m[1]);
  const second = Number(ctx.m[3]);
  const year = Number(ctx.m[4]);
  const firstIsMonth = first >= 1 && first <= 12;
  const secondIsMonth = second >= 1 && second <= 12;

  if (!firstIsMonth && !secondIsMonth) {
    return fail(`A month must be 1–12, and neither ${first} nor ${second} can be one.`);
  }

  const oneWay = (format: string, month: number, day: number): Matched => {
    const reason = dateReason(year, month, day);
    if (reason !== null) return fail(reason);
    return only(assemble(format, civilOf(year, month, day, t), zone.minutes, t.hasTime));
  };

  if (first === second) return oneWay(BOTH_ORDERS_AGREE, first, first);
  if (!secondIsMonth) return oneWay(MONTH_FIRST, first, second);
  if (!firstIsMonth) return oneWay(DAY_FIRST, second, first);

  // Both components could be the month and they differ: two real readings. Neither can
  // fail the calendar — a day of 1–12 fits every month of every year — so no validation
  // is repeated here.
  return {
    ok: true,
    parse: {
      readings: [
        assemble(DAY_FIRST, civilOf(year, second, first, t), zone.minutes, t.hasTime),
        assemble(MONTH_FIRST, civilOf(year, first, second, t), zone.minutes, t.hasTime),
      ],
      ambiguity: `Nothing in “${ctx.text}” says whether ${first} is the day or the month, so both readings are shown — day-first first, because most of the world writes it that way.`,
    },
  };
}

/** Order is meaning: strict `YYYY-MM-DD` runs before the lenient year-first matcher, so only an
 * unpadded date is named `Year-first date (Y/M/D)`. Tests never read expectations from here. */
const MATCHERS: readonly { pattern: RegExp; build: (ctx: MatchContext) => Matched }[] = [
  // `now`, `today`, `yesterday`, `tomorrow`.
  {
    pattern: /^(now|today|yesterday|tomorrow)$/i,
    build: (ctx) => only(keywordReading(ctx.m[1].toLowerCase(), ctx.nowMs)),
  },

  // Strict ISO 8601 extended: `2026-06-15`, `2026-06-15T07:12:34.123Z`. First, so that
  // a fully padded dash date gets the name that actually claims conformance.
  {
    pattern: new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${TAIL}$`, "i"),
    build: (ctx) => {
      const t = tail(ctx.m);
      return single(
        withTime("ISO 8601 date", t.hasTime),
        Number(ctx.m[1]),
        Number(ctx.m[2]),
        Number(ctx.m[3]),
        t,
      );
    },
  },

  // Compact ISO 8601, which the `T` — and only the `T` — makes unambiguous:
  // `20260615T071234Z`, `20260615T0712`. See the bare-8-digit note on
  // {@link parseDateString}.
  {
    pattern: new RegExp(
      String.raw`^(\d{4})(\d{2})(\d{2})T(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d+))?)?)?${ZONE}$`,
      "i",
    ),
    build: (ctx) =>
      single(
        "Compact ISO 8601 date and time",
        Number(ctx.m[1]),
        Number(ctx.m[2]),
        Number(ctx.m[3]),
        tail(ctx.m),
      ),
  },

  // Year-first with any separator, unpadded allowed: `2024/01/25`, `2024.01.25`,
  // `2024-1-25`. Named for the ORDER it pins, not for a standard it may not meet.
  {
    pattern: new RegExp(String.raw`^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})${TAIL}$`, "i"),
    build: (ctx) => {
      const t = tail(ctx.m);
      return single(
        withTime("Year-first date (Y/M/D)", t.hasTime),
        Number(ctx.m[1]),
        Number(ctx.m[3]),
        Number(ctx.m[4]),
        t,
      );
    },
  },

  // Year-LAST: `15/06/2026`, `05/06/2010`, `1.2.2010` — the ambiguous family.
  {
    pattern: new RegExp(String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})${TAIL}$`, "i"),
    build: buildYearLast,
  },

  // Day then month name, with the optional leading weekday of RFC 2822 / HTTP-date:
  // `15 Jun 2026`, `Mon, 15 Jun 2026 07:12:34 GMT`.
  {
    pattern: new RegExp(
      String.raw`^(?:(${WEEKDAY_ALT}),\s*)?(\d{1,2})\s+(${MONTH_ALT})\s+(\d{4})${TAIL}$`,
      "i",
    ),
    build: (ctx) => {
      const t = tail(ctx.m);
      // The weekday is accepted and ignored, not checked: a wrong weekday must not refuse a
      // readable date.
      const groups: (string | undefined)[] = ctx.m;
      const format =
        groups[1] === undefined
          ? withTime("Month-name date (D Mon YYYY)", t.hasTime)
          : "RFC 2822 / HTTP date";
      return single(format, Number(ctx.m[4]), monthNumber(ctx.m[3]), Number(ctx.m[2]), t);
    },
  },

  // Month name then day: `June 15, 2026`, `Jun 15 2026 07:12:34 -0500`.
  {
    pattern: new RegExp(String.raw`^(${MONTH_ALT})\s+(\d{1,2}),?\s+(\d{4})${TAIL}$`, "i"),
    build: (ctx) => {
      const t = tail(ctx.m);
      return single(
        withTime("Month-name date (Mon D, YYYY)", t.hasTime),
        Number(ctx.m[3]),
        monthNumber(ctx.m[1]),
        Number(ctx.m[2]),
        t,
      );
    },
  },
];

/** `nowMs` resolves only the keywords. Accepts keywords, ISO 8601 (also `/` or `.`), year-last
 * D/M or M/D, basic ISO with `T`, month names and RFC 2822. A bare 8-digit number is not a date
 * (it is a seconds epoch). Calendar validation is real: failures give a reason, never roll over. */
export function parseDateString(raw: string, nowMs: number): DateParseOutcome {
  const text = raw.trim();
  for (const matcher of MATCHERS) {
    const m = matcher.pattern.exec(text);
    if (m !== null) return matcher.build({ m, text, nowMs });
  }
  return null;
}
