/**
 * Tests for the date-STRING reader.
 *
 * Three rules this file follows, all of them load-bearing:
 *
 * 1. **Hermetic**. `nowMs` is always passed explicitly and never comes
 *    from `Date.now()`, and every expectation is in UTC. Nothing here changes answer
 *    if the machine's clock, zone or DST rules change — which matters more than usual
 *    for a date library, where "works on my laptop" is the classic failure.
 * 2. **Literal expectations**. Every epoch below is written out as a
 *    number, computed by hand from the day count since 1970 — never by running the
 *    code under test, and never read out of `dateParse.ts`'s matcher table. Rewriting a
 *    format name or an offset in the source therefore goes red here instead of quietly
 *    rewriting the expectation with it.
 * 3. **Two-sided**. The offset tests do not merely assert that
 *    `…+02:00` parses; they assert it differs from `…Z` by exactly 7_200_000 ms, so an
 *    implementation that drops the offset — or flips its sign — cannot pass.
 *
 * The reference epochs, all UTC midnight unless stated:
 *   1970-01-01 →              0     2024-01-25 → 1_706_140_800_000
 *   2010-05-05 → 1_273_017_600_000  2010-05-06 → 1_273_104_000_000
 *   2010-06-05 → 1_275_696_000_000  2024-02-29 → 1_709_164_800_000
 *   2000-02-29 →   951_782_400_000  2026-06-15 → 1_781_481_600_000
 * and 2026-06-15T07:12:34Z → 1_781_507_554_000 (07:12:34 = 25_954 s past midnight).
 */

import { describe, expect, it } from "vitest";

import { parseDateString, type DateParse, type DateReading } from "./dateParse";

/** 2026-06-15T07:12:34.123Z — the clock every test is handed. */
const NOW = 1_781_507_554_123;

const JUN_15_2026 = 1_781_481_600_000;
const JUN_15_2026_071234 = 1_781_507_554_000;
const JAN_25_2024 = 1_706_140_800_000;

function parsed(raw: string, nowMs = NOW): DateParse {
  const out = parseDateString(raw, nowMs);
  if (out === null || !out.ok) {
    throw new Error(`expected “${raw}” to read as a date, got ${JSON.stringify(out)}`);
  }
  return out.parse;
}

/** The single reading of an unambiguous input — asserts there is exactly one. */
function only(raw: string, nowMs = NOW): DateReading {
  const parse = parsed(raw, nowMs);
  expect(parse.readings).toHaveLength(1);
  expect(parse.ambiguity).toBeNull();
  return parse.readings[0];
}

/** The reason an input that LOOKED like a date was refused. */
function why(raw: string): string {
  const out = parseDateString(raw, NOW);
  if (out === null || out.ok) {
    throw new Error(`expected “${raw}” to be refused with a reason, got ${JSON.stringify(out)}`);
  }
  return out.reason;
}

describe("keywords", () => {
  it("reads “now” as exactly the clock it was given, with nothing assumed about zone", () => {
    const r = only("now");
    expect(r.instant).toEqual({ epochMs: 1_781_507_554_123, nanos: 0 });
    expect(r.format).toBe("Keyword “now”");
    // An instant is the same instant everywhere, so there is no other zone to offer.
    expect(r.zone).toBe("explicit");
    expect(r.civil).toBeNull();
    expect(r.assumption).toContain("the clock this window was given");
  });

  it("is case-insensitive and tolerant of whitespace the caller did not trim", () => {
    expect(only("  NOW ").instant.epochMs).toBe(1_781_507_554_123);
    expect(only("Today").instant.epochMs).toBe(JUN_15_2026);
  });

  it("floors a fractional clock rather than emitting a fractional epochMs", () => {
    expect(only("now", 1000.9).instant).toEqual({ epochMs: 1000, nanos: 0 });
  });

  it("reads “today” as 00:00:00 UTC of the UTC day holding the clock", () => {
    const r = only("today");
    expect(r.instant).toEqual({ epochMs: 1_781_481_600_000, nanos: 0 });
    expect(r.format).toBe("Keyword “today”");
    expect(r.zone).toBe("utc-assumed");
    expect(r.civil).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
      nanos: 0,
    });
    expect(r.assumption).toContain("00:00:00 UTC is assumed");
    expect(r.assumption).toContain("your own zone may already be on a different date");
  });

  it("reads “yesterday” and “tomorrow” as the neighbouring UTC days", () => {
    const yesterday = only("yesterday");
    expect(yesterday.instant.epochMs).toBe(1_781_395_200_000);
    expect(yesterday.format).toBe("Keyword “yesterday”");
    expect(yesterday.civil?.day).toBe(14);

    const tomorrow = only("tomorrow");
    expect(tomorrow.instant.epochMs).toBe(1_781_568_000_000);
    expect(tomorrow.format).toBe("Keyword “tomorrow”");
    expect(tomorrow.civil?.day).toBe(16);
  });

  it("floors the day boundary before 1970 instead of landing on the next day", () => {
    // 1 ms before the epoch is 1969-12-31T23:59:59.999Z, so “today” is 1969-12-31.
    const r = only("today", -1);
    expect(r.instant.epochMs).toBe(-86_400_000);
    expect(r.civil).toEqual({
      year: 1969,
      month: 12,
      day: 31,
      hour: 0,
      minute: 0,
      second: 0,
      nanos: 0,
    });
  });
});

describe("ISO 8601 extended", () => {
  it("reads a full timestamp with Z as an explicit-zone instant", () => {
    const r = only("2026-06-15T07:12:34Z");
    expect(r.instant).toEqual({ epochMs: 1_781_507_554_000, nanos: 0 });
    expect(r.format).toBe("ISO 8601 date and time");
    expect(r.zone).toBe("explicit");
    expect(r.assumption).toBeNull();
    // An explicit offset leaves nothing to re-interpret in another zone.
    expect(r.civil).toBeNull();
  });

  it("reads a bare date as UTC midnight and says both things it assumed", () => {
    const r = only("2026-06-15");
    expect(r.instant).toEqual({ epochMs: 1_781_481_600_000, nanos: 0 });
    expect(r.format).toBe("ISO 8601 date");
    expect(r.zone).toBe("utc-assumed");
    expect(r.assumption).toBe(
      "No time of day was given, so 00:00:00 is assumed, and no zone was given, so it is read as UTC.",
    );
    expect(r.civil).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
      nanos: 0,
    });
  });

  it("accepts a space instead of T, and keeps the civil fields exactly as typed", () => {
    const r = only("2026-06-15 07:12:34");
    expect(r.instant.epochMs).toBe(1_781_507_554_000);
    expect(r.zone).toBe("utc-assumed");
    expect(r.assumption).toBe("No zone was given, so this wall-clock time is read as UTC.");
    expect(r.civil).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 7,
      minute: 12,
      second: 34,
      nanos: 0,
    });
  });

  it("accepts hours and minutes with no seconds", () => {
    expect(only("2026-06-15T07:12").instant.epochMs).toBe(1_781_507_520_000);
  });

  it("keeps a nine-digit fraction at nanosecond precision", () => {
    const r = only("2026-06-15T07:12:34.123456789Z");
    expect(r.instant).toEqual({ epochMs: 1_781_507_554_123, nanos: 456_789 });
  });

  it("truncates a fraction longer than nine digits instead of rounding or refusing", () => {
    const r = only("2026-06-15T07:12:34.1234567899999Z");
    expect(r.instant).toEqual({ epochMs: 1_781_507_554_123, nanos: 456_789 });
    expect(r.civil).toBeNull();
    // The same value with no zone, so the truncated civil field is visible too.
    expect(only("2026-06-15T07:12:34.1234567899999").civil?.nanos).toBe(123_456_789);
  });

  it("pads a short fraction to the left, so .5 is half a second and not 5 ns", () => {
    const r = only("2026-06-15T07:12:34.5Z");
    expect(r.instant).toEqual({ epochMs: 1_781_507_554_500, nanos: 0 });
  });
});

describe("the trailing zone", () => {
  it("shifts by the offset — +02:00 and Z are exactly 7 200 000 ms apart", () => {
    const plusTwo = only("2026-06-15T07:12:34+02:00").instant.epochMs;
    const zulu = only("2026-06-15T07:12:34Z").instant.epochMs;
    // Two-sided: the exact gap, not merely "they differ". An
    // implementation that ignored the offset, or flipped its sign, fails here.
    expect(zulu).toBe(1_781_507_554_000);
    expect(plusTwo).toBe(1_781_500_354_000);
    expect(zulu - plusTwo).toBe(7_200_000);
  });

  it("accepts ±HHMM and ±HH, which must mean the same shift as ±HH:MM", () => {
    expect(only("2026-06-15T07:12:34+0200").instant.epochMs).toBe(1_781_500_354_000);
    expect(only("2026-06-15T07:12:34+02").instant.epochMs).toBe(1_781_500_354_000);
  });

  it("moves a negative offset the other way, minutes included", () => {
    // −05:30 is 5h30m BEHIND UTC, so the instant is 19 800 000 ms LATER.
    const r = only("2026-06-15T07:12:34-05:30");
    expect(r.instant.epochMs).toBe(1_781_527_354_000);
    expect(r.instant.epochMs - JUN_15_2026_071234).toBe(19_800_000);
  });

  it("treats Z, z, UTC, GMT and UT alike, with or without a space", () => {
    for (const suffix of ["Z", "z", "UTC", "GMT", "UT", " UTC", " gmt"]) {
      const r = only(`2026-06-15T07:12:34${suffix}`);
      expect(r.instant.epochMs).toBe(1_781_507_554_000);
      expect(r.zone).toBe("explicit");
      expect(r.civil).toBeNull();
    }
  });

  it("refuses an offset that is not a real offset, and says which half is wrong", () => {
    expect(why("2026-06-15T07:12:34+24:00")).toBe(
      "A zone offset's hours must be 0–23, and “+24:00” says 24.",
    );
    expect(why("2026-06-15T07:12:34+02:60")).toBe(
      "A zone offset's minutes must be 0–59, and “+02:60” says 60.",
    );
  });

  it("does not invent a meaning for a zone ABBREVIATION it was never taught", () => {
    // `EST` is not in the grammar, so the whole string is not date-shaped — `null`,
    // which lets the caller list what it does accept instead of guessing −05:00.
    expect(parseDateString("2026-06-15T07:12:34 EST", NOW)).toBeNull();
  });
});

describe("year-first dates with / and .", () => {
  it("reads a slash-separated date, 2024/01/25, as 25 January 2024 UTC", () => {
    const r = only("2024/01/25");
    expect(r.instant.epochMs).toBe(1_706_140_800_000);
    expect(r.format).toBe("Year-first date (Y/M/D)");
    expect(r.zone).toBe("utc-assumed");
  });

  it("reads the dotted form the same way", () => {
    expect(only("2024.01.25").instant.epochMs).toBe(JAN_25_2024);
  });

  it("names an UNPADDED dash date for its order, not for a standard it does not meet", () => {
    const r = only("2024-1-25");
    expect(r.instant.epochMs).toBe(JAN_25_2024);
    expect(r.format).toBe("Year-first date (Y/M/D)");
  });

  it("carries a time, and says so in the format name", () => {
    const r = only("2024/01/25 07:12:34");
    expect(r.instant.epochMs).toBe(1_706_166_754_000);
    expect(r.format).toBe("Year-first date (Y/M/D) and time");
  });

  it("refuses a MIXED separator rather than treating a typo as intent", () => {
    expect(parseDateString("2024-01/25", NOW)).toBeNull();
    expect(parseDateString("2024/01.25", NOW)).toBeNull();
  });
});

describe("compact ISO 8601", () => {
  it("reads YYYYMMDDTHHmmss with a zone", () => {
    const r = only("20260615T071234Z");
    expect(r.instant.epochMs).toBe(1_781_507_554_000);
    expect(r.format).toBe("Compact ISO 8601 date and time");
    expect(r.zone).toBe("explicit");
  });

  it("accepts the shorter compact forms, assuming UTC when no zone is given", () => {
    expect(only("20260615T0712").instant.epochMs).toBe(1_781_507_520_000);
    expect(only("20260615T0712").zone).toBe("utc-assumed");
    expect(only("20260615T07").instant.epochMs).toBe(1_781_506_800_000);
    expect(only("20260615T000000Z").instant.epochMs).toBe(JUN_15_2026);
  });

  it("keeps a fraction on the compact form too", () => {
    expect(only("20260615T071234.5Z").instant.epochMs).toBe(1_781_507_554_500);
  });

  it("refuses a bare 8-digit number, because the caller reads it as a SECONDS epoch", () => {
    // Deliberate: `epoch.ts` tries the numeric reader first and every 8-digit string
    // is a valid seconds epoch (20260615 s = 1970-08-23). If this file also claimed it
    // as YYYYMMDD, the two readers would disagree about the same input and whichever
    // ran first would win silently. The `T` is what makes the compact form a date.
    expect(parseDateString("20260615", NOW)).toBeNull();
  });

  it("refuses EVERY bare digit-run, not just the 8-digit one — the T is mandatory", () => {
    // The test above is named after the guarantee, so try the bypass.
    // Dropping the `T` from the pattern still leaves `20260615` refused (the hour group
    // is what rejects it), and a "the T is required" claim that only ever sees an
    // 8-digit input is not testing the T at all. These runs are all valid epochs to the
    // numeric reader — 14 digits is milliseconds, 10 is seconds — so a date reading of
    // any of them would put two answers on the same input.
    expect(parseDateString("20260615071234", NOW)).toBeNull();
    expect(parseDateString("202606150712", NOW)).toBeNull();
    expect(parseDateString("2026061507", NOW)).toBeNull();
  });

  it("refuses a compact time with an odd number of digits", () => {
    expect(parseDateString("20260615T071", NOW)).toBeNull();
  });
});

describe("year-last dates and their ambiguity", () => {
  it("returns BOTH readings for 05/06/2010, day-first first, and names each order", () => {
    const parse = parsed("05/06/2010");
    expect(parse.readings).toHaveLength(2);

    expect(parse.readings[0].format).toBe("Day-first date (D/M/Y)");
    expect(parse.readings[0].instant.epochMs).toBe(1_275_696_000_000); // 5 June 2010
    expect(parse.readings[1].format).toBe("Month-first date (M/D/Y)");
    expect(parse.readings[1].instant.epochMs).toBe(1_273_104_000_000); // 6 May 2010

    expect(parse.ambiguity).toBe(
      "Nothing in “05/06/2010” says whether 5 is the day or the month, so both readings are shown — day-first first, because most of the world writes it that way.",
    );
  });

  it("is unambiguous the moment a component cannot be a month", () => {
    const dayFirst = only("15/06/2026");
    expect(dayFirst.instant.epochMs).toBe(JUN_15_2026);
    expect(dayFirst.format).toBe("Day-first date (D/M/Y)");

    const monthFirst = only("06/15/2026");
    expect(monthFirst.instant.epochMs).toBe(JUN_15_2026);
    expect(monthFirst.format).toBe("Month-first date (M/D/Y)");
  });

  it("prints ONE row when day and month are the same number, not two identical ones", () => {
    const r = only("05/05/2010");
    expect(r.instant.epochMs).toBe(1_273_017_600_000); // 5 May 2010
    expect(r.format).toBe("Numeric date (D/M/Y and M/D/Y agree)");
  });

  it("applies the same ambiguity to - and . separators", () => {
    expect(parsed("05-06-2010").readings.map((r) => r.instant.epochMs)).toEqual([
      1_275_696_000_000, 1_273_104_000_000,
    ]);
    expect(parsed("1.2.2010").readings.map((r) => r.instant.epochMs)).toEqual([
      1_264_982_400_000, // 1 February 2010
      1_262_390_400_000, // 2 January 2010
    ]);
  });

  it("carries the time and the offset into BOTH ambiguous readings", () => {
    const plain = parsed("05/06/2010 07:12:34");
    expect(plain.readings.map((r) => r.instant.epochMs)).toEqual([
      1_275_721_954_000, 1_273_129_954_000,
    ]);
    expect(plain.readings.every((r) => r.zone === "utc-assumed")).toBe(true);

    const shifted = parsed("05/06/2010T07:12:34+02:00");
    expect(shifted.readings.map((r) => r.instant.epochMs)).toEqual([
      1_275_714_754_000, 1_273_122_754_000,
    ]);
    expect(shifted.readings.every((r) => r.zone === "explicit" && r.civil === null)).toBe(true);
  });

  it("refuses when NEITHER component can be a month", () => {
    expect(why("13/14/2010")).toBe("A month must be 1–12, and neither 13 nor 14 can be one.");
  });

  it("reports the near-miss reading's reason, not the nonsense one", () => {
    // 30 cannot be a month, so the only reading is month-first — and February is the
    // useful thing to say. "A month must be 1–12, and this says 30" would answer a
    // question nobody asked.
    expect(why("02/30/2010")).toBe("February 2010 has 28 days, and this says 30.");
    expect(why("31/02/2010")).toBe("February 2010 has 28 days, and this says 31.");
    expect(why("00/05/2010")).toBe("A day of the month must be 1 or more, and this says 0.");
  });

  it("validates the clock and the offset before it ever considers the order", () => {
    expect(why("05/06/2010 25:00")).toBe("An hour must be 0–23, and this says 25.");
    expect(why("05/06/2010 07:00+24:00")).toBe(
      "A zone offset's hours must be 0–23, and “+24:00” says 24.",
    );
  });
});

describe("month names", () => {
  it("reads day-then-month, full or three-letter, in any case", () => {
    for (const input of ["15 Jun 2026", "15 June 2026", "15 jun 2026", "15 JUNE 2026"]) {
      expect(only(input).instant.epochMs).toBe(JUN_15_2026);
    }
    expect(only("15 Jun 2026").format).toBe("Month-name date (D Mon YYYY)");
  });

  it("reads month-then-day, comma optional", () => {
    expect(only("Jun 15, 2026").instant.epochMs).toBe(JUN_15_2026);
    expect(only("June 15 2026").instant.epochMs).toBe(JUN_15_2026);
    expect(only("Jun 15, 2026").format).toBe("Month-name date (Mon D, YYYY)");
  });

  it("carries a time and an offset on either word order", () => {
    const dayFirst = only("15 June 2026 07:12:34 +0200");
    expect(dayFirst.instant.epochMs).toBe(1_781_500_354_000);
    expect(dayFirst.format).toBe("Month-name date (D Mon YYYY) and time");

    const monthFirst = only("June 15, 2026 07:12:34");
    expect(monthFirst.instant.epochMs).toBe(1_781_507_554_000);
    expect(monthFirst.format).toBe("Month-name date (Mon D, YYYY) and time");
  });

  it("maps every month to the right number", () => {
    // Hand-written expectations, NOT read from the source's month table:
    // each epoch is 2010-<month>-01T00:00:00Z, from the cumulative day counts of a
    // common year (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334).
    const firstOfEachMonth2010: [string, number][] = [
      ["1 Jan 2010", 1_262_304_000_000],
      ["1 February 2010", 1_264_982_400_000],
      ["1 Mar 2010", 1_267_401_600_000],
      ["1 April 2010", 1_270_080_000_000],
      ["1 May 2010", 1_272_672_000_000],
      ["1 Jun 2010", 1_275_350_400_000],
      ["1 July 2010", 1_277_942_400_000],
      ["1 Aug 2010", 1_280_620_800_000],
      ["1 September 2010", 1_283_299_200_000],
      ["1 Oct 2010", 1_285_891_200_000],
      ["1 November 2010", 1_288_569_600_000],
      ["1 Dec 2010", 1_291_161_600_000],
    ];
    for (const [input, epochMs] of firstOfEachMonth2010) {
      expect(only(input).instant.epochMs).toBe(epochMs);
    }
  });

  it("reads RFC 2822 / HTTP-date, weekday and all", () => {
    const r = only("Mon, 15 Jun 2026 07:12:34 GMT");
    expect(r.instant.epochMs).toBe(1_781_507_554_000);
    expect(r.format).toBe("RFC 2822 / HTTP date");
    expect(r.zone).toBe("explicit");
    expect(only("Monday, 15 Jun 2026").format).toBe("RFC 2822 / HTTP date");
  });

  it("accepts a weekday that does not match the date, and stays silent about it", () => {
    // 15 June 2026 is a Monday. `Tue` is wrong and carries no information the date
    // does not already carry, so it is ignored rather than turned into a rejection.
    const r = only("Tue, 15 Jun 2026 07:12:34 GMT");
    expect(r.instant.epochMs).toBe(1_781_507_554_000);
    expect(r.assumption).toBeNull();
    expect(r.format).toBe("RFC 2822 / HTTP date");
  });

  it("is not fooled by a word that is not a month", () => {
    expect(parseDateString("15 Foo 2026", NOW)).toBeNull();
    expect(parseDateString("Foo 15, 2026", NOW)).toBeNull();
  });
});

describe("calendar validation", () => {
  it("knows how long each month is, and says so", () => {
    expect(why("2010-02-30")).toBe("February 2010 has 28 days, and this says 30.");
    expect(why("2010-04-31")).toBe("April 2010 has 30 days, and this says 31.");
    expect(why("2010-01-32")).toBe("January 2010 has 31 days, and this says 32.");
  });

  it("rejects a month outside 1–12 from either end", () => {
    expect(why("2010-13-01")).toBe("A month must be 1–12, and this says 13.");
    expect(why("2010-00-01")).toBe("A month must be 1–12, and this says 0.");
  });

  it("rejects a zeroth day", () => {
    expect(why("2010-01-00")).toBe("A day of the month must be 1 or more, and this says 0.");
  });

  it("rejects an impossible clock, naming the field", () => {
    expect(why("2026-06-15T25:00")).toBe("An hour must be 0–23, and this says 25.");
    expect(why("2026-06-15T07:60")).toBe("A minute must be 0–59, and this says 60.");
    expect(why("2026-06-15T07:12:60")).toBe(
      "A second must be 0–59, and this says 60 — no epoch counts leap seconds.",
    );
  });

  it("gets the Gregorian leap rule right at all three of its edges", () => {
    // Divisible by 4 → leap.
    expect(only("2024-02-29").instant.epochMs).toBe(1_709_164_800_000);
    // Divisible by 100 → NOT leap, even though it is divisible by 4.
    expect(why("1900-02-29")).toBe("February 1900 has 28 days, and this says 29.");
    // Divisible by 400 → leap after all.
    expect(only("2000-02-29").instant.epochMs).toBe(951_782_400_000);
    // Not divisible by 4 at all.
    expect(why("2023-02-29")).toBe("February 2023 has 28 days, and this says 29.");
    // And the leap year's February still stops at 29.
    expect(why("2024-02-30")).toBe("February 2024 has 29 days, and this says 30.");
  });
});

describe("null versus a refusal — two different answers", () => {
  it("returns null for input that is not date-shaped, so the caller can list what is", () => {
    for (const input of ["wat", "", "   ", "hello world", "15 of June", "2026-06"]) {
      expect(parseDateString(input, NOW)).toBeNull();
    }
  });

  it("returns ok:false with a reason for input that is date-shaped but not a date", () => {
    const out = parseDateString("2010-02-30", NOW);
    expect(out).not.toBeNull();
    expect(out?.ok).toBe(false);
    expect(out).toEqual({ ok: false, reason: "February 2010 has 28 days, and this says 30." });
  });

  it("never rolls a bad date over into a neighbouring one", () => {
    // The trap `new Date(2010, 1, 30)` falls into: it silently becomes 2 March.
    expect(parseDateString("2010-02-30", NOW)).not.toMatchObject({ ok: true });
  });
});
