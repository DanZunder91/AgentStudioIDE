/**
 * The Tools panel's date-STRING reader: "2024/01/25", "2026-06-15T07:12:34Z",
 * "Mon, 15 Jun 2026 07:12:34 GMT", "now" → an instant.
 *
 * ⚠️ **Exported signatures are a CONTRACT** — `epoch.ts` and the panel are written
 * against them.
 *
 * ── `new Date(string)` is never used ─────────────────────────────────────────
 * ECMA-262 specifies string parsing ONLY for the ISO 8601 profile in §21.4.1.32;
 * everything else is explicitly implementation-defined, and engines disagree in ways
 * that silently produce the wrong day (`"2024/01/25"` is local midnight in V8 and
 * `Invalid Date` in older Safari; a bare `"2024-01-25"` is UTC while
 * `"2024-1-25"` is local). A converter whose answer depends on the webview is not a
 * converter, so every format below is matched by an explicit pattern and assembled
 * from validated fields.
 *
 * ── Ambiguity is a RESULT, not a coin flip ───────────────────────────────────
 * `05/06/2010` is 5 June in most of the world and 6 May in the US, and nothing in the
 * string decides it. When the data holds N+1 states, the output must say so: that
 * returns TWO readings and a filled `ambiguity` line, and the panel shows
 * both — rather than picking one silently and being wrong half the time.
 *
 * ── How this file is built, and what was rejected ────────────────────────────
 * A **table of `{ pattern, build }` matchers, tried in order.** The two alternatives
 * were both worse:
 *
 * * *One mega-regex with named groups.* It collapses to a pattern nobody can review,
 *   and it cannot give a format a NAME — but the name is half the product here. The
 *   whole point of showing `Day-first date (D/M/Y)` is that a wrong reading is visible.
 * * *A hand-written scanner.* More code, more places to get a leap year wrong, and no
 *   gain: these grammars are regular and short.
 *
 * Three details of the table are load-bearing:
 *
 * 1. **Order is meaning.** The strict `YYYY-MM-DD` matcher runs before the lenient
 *    year-first one so that a padded dash date is named `ISO 8601 date` and only the
 *    unpadded `2024-1-25` falls through to the honest `Year-first date (Y/M/D)`. A name
 *    that over-claims conformance is a small lie the panel would repeat all day.
 * 2. **Every matcher ends with the SAME five groups** — hour, minute, second, fraction,
 *    zone — so `tail()` reads them with `slice(-5)` and the trailing-zone grammar
 *    (`Z`, `UTC`, `GMT`, `UT`, `±HH:MM`, `±HHMM`, `±HH`) exists exactly once, in
 *    {@link readZone}. Three copies would drift apart — a rarely used token like `UT`
 *    is exactly where one of them would disagree with the others.
 * 3. **The date separator is a backreference (`\2`)**, so `2024-01/25` is not a date.
 *    Accepting a mixed separator would mean accepting a typo as if it were meant.
 *
 * ── Why an explicit offset erases `civil` ────────────────────────────────────
 * `DateReading.civil` exists for one purpose: the panel's "…or, read in your own zone,
 * <other epoch>" offer. A string that carried `+02:00` has no other reading — its
 * author already said which clock they meant — so `civil` is `null` there rather than
 * an invitation to re-interpret a decided instant. The same reasoning makes `now`
 * report `zone: "explicit"`: an instant is the same instant in every zone, so claiming
 * "UTC was assumed" would be a lie about a value nothing was assumed for.
 */

import { instantFromCivilUtc, type Civil, type Instant } from "./instant";

/** One way the input can be read, already resolved to an instant. */
export interface DateReading {
  instant: Instant;
  /** The format that matched, named for a human: `ISO 8601 date and time`. */
  format: string;
  /** Whether the string carried its own offset, or UTC had to be assumed. */
  zone: "explicit" | "utc-assumed";
  /**
   * What had to be assumed to get an instant, as a full sentence, or `null` when the
   * string said everything (`No time of day was given, so 00:00:00 UTC is assumed.`).
   */
  assumption: string | null;
  /**
   * The wall-clock fields exactly as typed — present only when the string carried NO
   * offset, so the panel can offer "…or, read in your own zone, <other epoch>".
   * `null` when an offset was explicit and there is nothing to re-interpret.
   */
  civil: Civil | null;
}

/** What the reader made of the string. `readings` is never empty. */
export interface DateParse {
  /** Best first. More than one ⟹ the string is genuinely ambiguous. */
  readings: DateReading[];
  /** Set iff `readings.length > 1` — what is ambiguous, in one sentence. */
  ambiguity: string | null;
}

/**
 * Three outcomes, deliberately distinct:
 * - `{ ok: true }` — read it.
 * - `{ ok: false, reason }` — it LOOKED like a date and is not a real one, with why
 *   (`February 2010 has 28 days.`). This is the message worth showing.
 * - `null` — not date-shaped at all, so the caller says so in its own words.
 */
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

/**
 * The proleptic Gregorian rule, written out rather than delegated to `Date`.
 * `new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29` would work, but it answers a
 * different question (does the *platform* roll over?) and hides the one line anybody
 * reviewing a date library actually wants to read.
 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
}

/* ──────────────────────────────── validation ────────────────────────────────── */

/**
 * Why these date fields are not a real date, or `null` if they are.
 *
 * The reason is the product, not a status code: a converter that says "invalid date"
 * has told the user nothing they did not already know. Every sentence names the field,
 * the legal range *for that particular month and year*, and what was actually typed.
 */
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

/**
 * Time of day: `T` or whitespace, `HH:mm`, optional `:ss`, optional `.` + digits.
 * The hour is `\d{1,2}` on purpose — `2024-01-25 7:30` is a thing people type, and the
 * range check below is what decides whether it is real, not the digit count.
 */
const TIME = String.raw`(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?`;

/**
 * The trailing zone. `UTC` precedes `UT` in the alternation so that the longer token
 * wins without relying on backtracking to find it.
 */
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

/**
 * `.5` → 500_000_000; `.123456789123` → 123_456_789.
 *
 * Truncation, not rounding, and not a rejection. Rounding `.9999999995` up would
 * change the second, and refusing a 12-digit fraction would refuse timestamps that
 * real systems emit (Python's `%f` padded, Java's `Instant` round-tripped through a
 * higher-precision clock). Nanoseconds are the floor of the value either way — the
 * same rule `epochIn` uses when a unit cannot hold the precision it was given.
 */
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

/**
 * The one place the trailing-zone grammar is interpreted.
 *
 * The offset IS range-checked, even though nothing in ISO 8601 makes `+25:00`
 * syntactically impossible. A converter exists to be trusted about a number, and
 * silently shifting by 25 hours because of a typo'd `+205:00` → `+20` would be exactly
 * the class of quiet wrongness this file was written to avoid.
 */
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

/**
 * The civil fields as a UTC instant.
 *
 * The `as Instant` is a proof, not a shrug: `instantFromCivilUtc` returns `null` only
 * outside `Date`'s ±8.64e15 ms range, every year in this file is captured by `\d{4}`,
 * and the extreme `9999-12-31T23:59:59` is 2.5e14 ms — two orders of magnitude inside
 * it. A guard here would be a branch no input can reach, and an
 * unfalsifiable guard is dead code, not safety.
 */
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
  // An offset says "this wall clock was `offsetMinutes` AHEAD of UTC", so the instant
  // is that much EARLIER than the same fields read as UTC. Getting this sign wrong is
  // the single most common bug in a date reader, which is why the test asserts the
  // exact 7_200_000 ms gap between `…+02:00` and `…Z` rather than just "they differ".
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

/**
 * A month name → 1–12. Total by construction: the token can only be something
 * {@link MONTH_ALT} matched, and the first three letters of the twelve month names are
 * all distinct, so a prefix compare is exact.
 */
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

/**
 * `now` / `today` / `yesterday` / `tomorrow`.
 *
 * All four resolve against `nowMs` — never `Date.now()`, so the panel and the tests
 * read the same clock and nothing here depends on when it runs. The day
 * boundary is floor-divided rather than taken from `Date`'s accessors so that a
 * pre-1970 clock lands on the START of its day and not the end of the previous one.
 */
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

/**
 * `D/M/YYYY` and `M/D/YYYY`, the only genuinely ambiguous shape here.
 *
 * The classification is written as four early returns rather than "build both readings
 * and filter the valid ones", because the useful rejection differs per case: for
 * `02/30/2010` the near-miss reading is month-first (February the 30th), and reporting
 * day-first's "a month must be 1–12, and this says 30" instead would answer a question
 * nobody asked. A component that cannot be a month decides the order; when both can and
 * they differ, nothing decides it and both are returned.
 */
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

/**
 * The table. **Order is meaning** — see the file header, point 1.
 *
 * A test must never read its expectations out of this table: every
 * format name and every epoch in `dateParse.test.ts` is written out by hand, so
 * rewriting a row here goes red instead of quietly rewriting the expectation with it.
 */
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
      // The weekday is accepted and IGNORED — deliberately not checked against the
      // date. `Tue, 15 Jun 2026` is a wrong weekday for a right date, and the date is
      // what the user asked us to convert; rejecting it would refuse a perfectly
      // readable timestamp over a field that carries no information.
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

/**
 * Read a date string. `nowMs` resolves the relative keywords (`now`, `today`,
 * `yesterday`, `tomorrow`) and is otherwise unused.
 *
 * Formats accepted — each matched by pattern, never by `Date`:
 *  1. Keywords: `now`, `today`, `yesterday`, `tomorrow` (case-insensitive).
 *  2. ISO 8601 extended: `YYYY-MM-DD`, optionally `T` or a space then `HH:mm`,
 *     `:ss`, `.` + 1–9 fractional digits; optionally `Z`, `±HH:MM`, `±HHMM`, `±HH`,
 *     or the words `UTC` / `GMT` / `UT`.
 *  3. The same with `/` or `.` separating the date parts: `2024/01/25`, `2024.01.25`.
 *  4. Year-LAST numeric dates, `D/M/YYYY` and `M/D/YYYY` (also `-` or `.`): read
 *     unambiguously when one component exceeds 12, and as TWO readings when it does
 *     not — see the ambiguity note in the file header.
 *  5. Basic ISO with the `T` present: `20260615T071234Z`, `20260615T0712`.
 *  6. Month names: `15 Jun 2026`, `June 15, 2026`, `15 June 2026 07:12:34 +0200`,
 *     and RFC 2822 / HTTP-date with its leading weekday: `Mon, 15 Jun 2026 07:12:34 GMT`.
 *
 * A **bare 8-digit number** (`20260615`) is deliberately NOT read as a date here: the
 * caller tries the numeric epoch reader first, and every 8-digit string is a valid
 * seconds epoch. The `T` in form 5 is what makes the compact form unambiguous.
 *
 * Calendar validation is real: month 1–12, day within that month in that year
 * (leap-day aware), hour 0–23, minute/second 0–59. A failure returns `ok: false` with
 * the reason, never a rolled-over date.
 */
export function parseDateString(raw: string, nowMs: number): DateParseOutcome {
  const text = raw.trim();
  for (const matcher of MATCHERS) {
    const m = matcher.pattern.exec(text);
    if (m !== null) return matcher.build({ m, text, nowMs });
  }
  return null;
}
