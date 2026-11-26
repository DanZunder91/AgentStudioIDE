/** Clock- and zone-free: every entry point gets `now` and `timeZone`. Expectations are hand-worked
 * literals, never re-derived by the code under test. DST and boundary checks come in two-sided
 * pairs, so a hard-coded constant cannot pass. */

import { describe, it, expect } from "vitest";
import {
  EPOCH_UNITS,
  MAX_EPOCH_MS,
  NANOS_PER,
  UNIT_LABEL,
  civilInZone,
  epochIn,
  instantFromCivilUtc,
  instantFromNanos,
  nanosOf,
  parseNumericEpoch,
  relativeTo,
  viewInstant,
  type Civil,
} from "./instant";

/** 2026-06-15T07:12:34Z — the instant every doc comment in `instant.ts` uses. */
const JUN_2026 = 1_781_507_554_000;
/** 2026-01-15T07:12:34Z — the same wall clock in Paris's *winter*. */
const JAN_2026 = 1_768_461_154_000;

/** A `Civil` with the boring fields filled in. */
function civil(over: Partial<Civil>): Civil {
  return { year: 2026, month: 6, day: 15, hour: 7, minute: 12, second: 34, nanos: 0, ...over };
}

describe("splitting a nanosecond count into an instant", () => {
  it("keeps the whole milliseconds and the sub-millisecond remainder apart", () => {
    expect(instantFromNanos(1_500_000n)).toEqual({ epochMs: 1, nanos: 500_000 });
  });

  it("survives a 19-digit nanosecond stamp that a JS number would corrupt", () => {
    // Number("1700000000123456789") is 1700000000123456800 — the last two digits are
    // gone. If this assertion ever reads ...456800, someone reintroduced Number().
    expect(instantFromNanos(1_700_000_000_123_456_789n)).toEqual({
      epochMs: 1_700_000_000_123,
      nanos: 456_789,
    });
  });

  it("floors before 1970 rather than truncating, so the remainder stays positive", () => {
    expect(instantFromNanos(-1n)).toEqual({ epochMs: -1, nanos: 999_999 });
    expect(instantFromNanos(-1_000_001n)).toEqual({ epochMs: -2, nanos: 999_999 });
  });

  it("leaves an exact millisecond boundary with a zero remainder at both signs", () => {
    expect(instantFromNanos(-1_000_000n)).toEqual({ epochMs: -1, nanos: 0 });
    expect(instantFromNanos(1_000_000n)).toEqual({ epochMs: 1, nanos: 0 });
  });

  it("is inverted exactly by nanosOf, including before 1970", () => {
    // Written as literals on both sides rather than as `nanosOf(instantFromNanos(x))`:
    // a round-trip through a pair of functions passes even when both are wrong the
    // same way.
    expect(nanosOf({ epochMs: 0, nanos: 0 })).toBe(0n);
    expect(nanosOf({ epochMs: 1, nanos: 500_000 })).toBe(1_500_000n);
    expect(nanosOf({ epochMs: -1, nanos: 999_999 })).toBe(-1n);
    expect(nanosOf({ epochMs: -2, nanos: 999_999 })).toBe(-1_000_001n);
    expect(nanosOf({ epochMs: 1_700_000_000_123, nanos: 456_789 })).toBe(
      1_700_000_000_123_456_789n,
    );
    expect(nanosOf({ epochMs: -62_167_219_200_001, nanos: 999_999 })).toBe(
      -62_167_219_200_000_000_001n,
    );
  });

  it("floors a pre-1970 count that is not a whole millisecond", () => {
    expect(instantFromNanos(-62_167_219_200_000_000_001n)).toEqual({
      epochMs: -62_167_219_200_001,
      nanos: 999_999,
    });
  });

  it("accepts the last representable millisecond and refuses the one after it", () => {
    expect(instantFromNanos(8_640_000_000_000_000_000_000n)).toEqual({
      epochMs: MAX_EPOCH_MS,
      nanos: 0,
    });
    expect(instantFromNanos(8_640_000_000_001_000_000n * 1_000n)).toBeNull();
  });

  it("refuses a count below the earliest representable millisecond", () => {
    expect(instantFromNanos(-8_640_000_000_000_000_000_000n)).toEqual({
      epochMs: -MAX_EPOCH_MS,
      nanos: 0,
    });
    expect(instantFromNanos(-8_640_000_000_001_000_000n * 1_000n)).toBeNull();
  });
});

describe("resolving wall-clock fields in UTC", () => {
  it("reads a two-digit year as itself, not as the 20th century", () => {
    // The whole reason `Date.UTC` is not used: Date.UTC(50, 0, 1) is 1950-01-01.
    expect(instantFromCivilUtc(civil({ year: 50, month: 1, day: 1, hour: 0, minute: 0, second: 0 })))
      .toEqual({ epochMs: -60_589_296_000_000, nanos: 0 });
  });

  it("keeps 29 February of year 0, which is a real leap day", () => {
    expect(
      instantFromCivilUtc(civil({ year: 0, month: 2, day: 29, hour: 0, minute: 0, second: 0 })),
    ).toEqual({ epochMs: -62_162_121_600_000, nanos: 0 });
  });

  it("splits nine fractional digits across the millisecond and the remainder", () => {
    expect(instantFromCivilUtc(civil({ nanos: 123_456_789 }))).toEqual({
      epochMs: JUN_2026 + 123,
      nanos: 456_789,
    });
  });

  it("returns null for a year beyond what Date can hold", () => {
    expect(instantFromCivilUtc(civil({ year: 300_000 }))).toBeNull();
  });
});

describe("resolving wall-clock fields in a named zone", () => {
  it("gives the same instant two different offsets in summer and in winter", () => {
    // Two-sided: one zone id, two instants, two offsets. A hard-coded
    // +02:00 passes the first line and fails the second.
    expect(civilInZone(civil({ hour: 9, minute: 12, second: 34 }), "Europe/Paris")).toEqual({
      epochMs: JUN_2026,
      nanos: 0,
    });
    expect(
      civilInZone(civil({ month: 1, day: 15, hour: 8, minute: 12, second: 34 }), "Europe/Paris"),
    ).toEqual({ epochMs: JAN_2026, nanos: 0 });
  });

  it("resolves a repeated autumn hour to its first occurrence", () => {
    // Paris's DST ends at 01:00 UTC on 2026-10-25, so local 02:30 happens at
    // 00:30 UTC (CEST) and again at 01:30 UTC (CET). The earlier one wins.
    expect(
      civilInZone(
        civil({ month: 10, day: 25, hour: 2, minute: 30, second: 0 }),
        "Europe/Paris",
      ),
    ).toEqual({ epochMs: 1_792_888_200_000, nanos: 0 });
  });

  it("resolves a wall clock the spring jump skipped the way the platform does", () => {
    // 2026-03-29 02:30 does not exist in Paris — 02:00 becomes 03:00. The settled
    // offset (+01:00) lands on 01:30 UTC, which reads back as 03:30 local.
    expect(
      civilInZone(civil({ month: 3, day: 29, hour: 2, minute: 30, second: 0 }), "Europe/Paris"),
    ).toEqual({ epochMs: 1_774_747_800_000, nanos: 0 });
  });

  it("carries the sub-millisecond remainder through the offset maths", () => {
    expect(
      civilInZone(civil({ hour: 9, minute: 12, second: 34, nanos: 123_456_789 }), "Europe/Paris"),
    ).toEqual({ epochMs: JUN_2026 + 123, nanos: 456_789 });
  });

  it("returns null for a zone the platform does not know", () => {
    expect(civilInZone(civil({}), "Mars/Olympus_Mons")).toBeNull();
  });

  it("returns null when the fields are out of range before any zone is consulted", () => {
    expect(civilInZone(civil({ year: 300_000 }), "Europe/Paris")).toBeNull();
  });

  it("returns null when applying a western offset pushes past the last instant", () => {
    // 275760-09-13T00:00:00 UTC is exactly the last representable millisecond, so the
    // same wall clock in New York (UTC−04:00) is four hours past the end of time.
    expect(
      civilInZone(
        civil({ year: 275_760, month: 9, day: 13, hour: 0, minute: 0, second: 0 }),
        "America/New_York",
      ),
    ).toBeNull();
  });
});

describe("declining input that is not a number at all", () => {
  // `null` is how `epoch.ts` learns to try the date-string reader instead, so every
  // one of these shapes must be a decline and not a throw or a bogus epoch.
  it.each([
    ["empty", ""],
    ["a word", "abc"],
    ["a lone plus", "+"],
    ["a lone minus", "-"],
    ["a trailing separator", "1700000000_"],
    ["a leading separator", "_1700000000"],
    ["a doubled separator", "1__2"],
    ["a bare decimal point", "1700000000."],
    ["two decimal points", "1.2.3"],
    ["exponent notation", "1e5"],
    ["an internal space", "12 34"],
    ["a bare unit", "ms"],
    ["an unknown unit", "1700000000d"],
    ["hex", "0x1f"],
    ["a date", "2026-06-15"],
  ])("declines %s", (_label, input) => {
    expect(parseNumericEpoch(input)).toBeNull();
  });
});

describe("guessing the unit of a bare number by its digit count", () => {
  it("explains the rule and the count it counted", () => {
    const read = parseNumericEpoch("1700000000");
    expect(read?.explicit).toBe(false);
    expect(read?.normalized).toBe("1700000000");
    expect(read?.chosen.unit).toBe("s");
    expect(read?.chosen.because).toBe(
      "10 digits — 11 or fewer digits reads as seconds; every boundary sits at the year 5138.",
    );
    expect(read?.chosen.instant).toEqual({ epochMs: 1_700_000_000_000, nanos: 0 });
  });

  it("says “1 digit”, not “1 digits”", () => {
    const read = parseNumericEpoch("0");
    expect(read?.chosen.because).toBe(
      "1 digit — 11 or fewer digits reads as seconds; every boundary sits at the year 5138.",
    );
    expect(read?.chosen.instant).toEqual({ epochMs: 0, nanos: 0 });
  });

  it("does not count leading zeros as digits", () => {
    const read = parseNumericEpoch("000001700000000");
    expect(read?.chosen.unit).toBe("s");
    expect(read?.chosen.because).toBe(
      "10 digits — 11 or fewer digits reads as seconds; every boundary sits at the year 5138.",
    );
    expect(read?.normalized).toBe("000001700000000");
  });

  it("switches from seconds to milliseconds at the 12th digit", () => {
    const eleven = parseNumericEpoch("99999999999");
    expect(eleven?.chosen.unit).toBe("s");
    expect(eleven?.chosen.instant).toEqual({ epochMs: 99_999_999_999_000, nanos: 0 });

    const twelve = parseNumericEpoch("100000000000");
    expect(twelve?.chosen.unit).toBe("ms");
    expect(twelve?.chosen.because).toBe(
      "12 digits — 12 to 14 digits reads as milliseconds; every boundary sits at the year 5138.",
    );
    expect(twelve?.chosen.instant).toEqual({ epochMs: 100_000_000_000, nanos: 0 });
  });

  it("switches from milliseconds to microseconds at the 15th digit", () => {
    const fourteen = parseNumericEpoch("99999999999999");
    expect(fourteen?.chosen.unit).toBe("ms");
    expect(fourteen?.chosen.instant).toEqual({ epochMs: 99_999_999_999_999, nanos: 0 });

    const fifteen = parseNumericEpoch("100000000000000");
    expect(fifteen?.chosen.unit).toBe("us");
    expect(fifteen?.chosen.because).toBe(
      "15 digits — 15 to 17 digits reads as microseconds; every boundary sits at the year 5138.",
    );
    expect(fifteen?.chosen.instant).toEqual({ epochMs: 100_000_000_000, nanos: 0 });
  });

  it("switches from microseconds to nanoseconds at the 18th digit", () => {
    const seventeen = parseNumericEpoch("99999999999999999");
    expect(seventeen?.chosen.unit).toBe("us");
    expect(seventeen?.chosen.instant).toEqual({ epochMs: 99_999_999_999_999, nanos: 999_000 });

    const eighteen = parseNumericEpoch("100000000000000000");
    expect(eighteen?.chosen.unit).toBe("ns");
    expect(eighteen?.chosen.because).toBe(
      "18 digits — 18 or more digits reads as nanoseconds; every boundary sits at the year 5138.",
    );
    expect(eighteen?.chosen.instant).toEqual({ epochMs: 100_000_000_000, nanos: 0 });
  });
});

describe("reading a bare number in all four units at once", () => {
  it("offers the other three readings in coarsest-first order", () => {
    const read = parseNumericEpoch("1700000000");
    expect(read?.others.map((r) => r.unit)).toEqual(["ms", "us", "ns"]);
    expect(read?.others[0].because).toBe("If “1700000000” is in milliseconds.");
    expect(read?.others[0].instant).toEqual({ epochMs: 1_700_000_000, nanos: 0 });
    expect(read?.others[1].instant).toEqual({ epochMs: 1_700_000, nanos: 0 });
    expect(read?.others[2].instant).toEqual({ epochMs: 1_700, nanos: 0 });
  });

  it("marks a reading that lands outside representable time as null, not as an error", () => {
    // Only two of the four readings of a 19-digit stamp exist: as seconds or as
    // milliseconds it is hundreds of millions of years past the end of `Date`.
    const read = parseNumericEpoch("1700000000123456789");
    expect(read?.chosen.unit).toBe("ns");
    expect(read?.chosen.instant).toEqual({ epochMs: 1_700_000_000_123, nanos: 456_789 });
    expect(read?.others.map((r) => r.unit)).toEqual(["s", "ms", "us"]);
    expect(read?.others[0].instant).toBeNull();
    expect(read?.others[1].instant).toBeNull();
    expect(read?.others[2].instant).toEqual({ epochMs: 1_700_000_000_123_456, nanos: 789_000 });
  });

  it("reads a negative epoch as a pre-1970 instant with a non-negative remainder", () => {
    const read = parseNumericEpoch("-1");
    expect(read?.normalized).toBe("-1");
    expect(read?.chosen.unit).toBe("s");
    expect(read?.chosen.instant).toEqual({ epochMs: -1000, nanos: 0 });
    expect(read?.others[2].instant).toEqual({ epochMs: -1, nanos: 999_999 });
  });
});

describe("reading a number whose unit was typed out", () => {
  it("says the suffix decided it, not the digit count", () => {
    const read = parseNumericEpoch("1700000000ms");
    expect(read?.explicit).toBe(true);
    expect(read?.chosen.unit).toBe("ms");
    expect(read?.chosen.because).toBe(
      "The “ms” suffix says milliseconds, so nothing was guessed.",
    );
    expect(read?.chosen.instant).toEqual({ epochMs: 1_700_000_000, nanos: 0 });
  });

  // Each expected sentence is written out in full rather than assembled from the
  // input, so a wrong label cannot corrupt its own expectation.
  it.each([
    ["s", "s", "The “s” suffix says seconds, so nothing was guessed."],
    ["ms", "ms", "The “ms” suffix says milliseconds, so nothing was guessed."],
    ["us", "us", "The “us” suffix says microseconds, so nothing was guessed."],
    // U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU are different code points
    // that render identically; both arrive on the clipboard, so both are accepted.
    ["µs", "us", "The “µs” suffix says microseconds, so nothing was guessed."],
    ["μs", "us", "The “μs” suffix says microseconds, so nothing was guessed."],
    ["ns", "ns", "The “ns” suffix says nanoseconds, so nothing was guessed."],
    ["MS", "ms", "The “ms” suffix says milliseconds, so nothing was guessed."],
    ["NS", "ns", "The “ns” suffix says nanoseconds, so nothing was guessed."],
  ])("accepts the suffix %s as %s", (suffix, unit, because) => {
    const read = parseNumericEpoch(`1700000000${suffix}`);
    expect(read?.chosen.unit).toBe(unit);
    expect(read?.chosen.because).toBe(because);
  });

  it("allows a space before the suffix", () => {
    expect(parseNumericEpoch("1700000000 ns")?.chosen.unit).toBe("ns");
  });

  it("lets the suffix override the reading the digit count would have chosen", () => {
    // 1700000000 in nanoseconds is 1.7 seconds after the epoch — a perfectly good
    // reading that only the suffix can select, which is the point of `explicit`.
    expect(parseNumericEpoch("1700000000ns")?.chosen.instant).toEqual({
      epochMs: 1_700,
      nanos: 0,
    });
    expect(parseNumericEpoch("1700000000")?.chosen.unit).toBe("s");
  });
});

describe("reading separators and fractions", () => {
  it("strips underscore separators from the digits it reports back", () => {
    const read = parseNumericEpoch("1_700_000_000");
    expect(read?.normalized).toBe("1700000000");
    expect(read?.chosen.instant).toEqual({ epochMs: 1_700_000_000_000, nanos: 0 });
  });

  it("scales a fractional part exactly", () => {
    const read = parseNumericEpoch("1700000000.123456789");
    expect(read?.normalized).toBe("1700000000.123456789");
    expect(read?.chosen.unit).toBe("s");
    expect(read?.chosen.instant).toEqual({ epochMs: 1_700_000_000_123, nanos: 456_789 });
  });

  it("floors precision finer than a nanosecond toward the past at both signs", () => {
    expect(parseNumericEpoch("0.0000000015")?.chosen.instant).toEqual({ epochMs: 0, nanos: 1 });
    expect(parseNumericEpoch("-0.0000000015")?.chosen.instant).toEqual({
      epochMs: -1,
      nanos: 999_998,
    });
  });

  it("accepts separators inside the fraction too", () => {
    expect(parseNumericEpoch("1700000000.123_456")?.normalized).toBe("1700000000.123456");
  });

  it("drops a leading plus from the digits it reports back", () => {
    expect(parseNumericEpoch("+1700000000")?.normalized).toBe("1700000000");
  });
});

describe("the epoch of an instant in one unit", () => {
  it("prints a 19-digit nanosecond epoch exactly", () => {
    // The single assertion that a `Number()`-based implementation cannot pass: it
    // would print 1700000000123456800.
    expect(epochIn({ epochMs: 1_700_000_000_123, nanos: 456_789 }, "ns")).toBe(
      "1700000000123456789",
    );
  });

  it("truncates toward the past before 1970, never toward zero", () => {
    const oneNanoBefore = { epochMs: -1, nanos: 999_999 };
    expect(epochIn(oneNanoBefore, "ns")).toBe("-1");
    expect(epochIn(oneNanoBefore, "us")).toBe("-1");
    expect(epochIn(oneNanoBefore, "ms")).toBe("-1");
    expect(epochIn(oneNanoBefore, "s")).toBe("-1");
  });

  it("truncates toward the past after 1970 as well", () => {
    const justAfter = { epochMs: 999, nanos: 999_999 };
    expect(epochIn(justAfter, "s")).toBe("0");
    expect(epochIn(justAfter, "ms")).toBe("999");
    expect(epochIn(justAfter, "us")).toBe("999999");
    expect(epochIn(justAfter, "ns")).toBe("999999999");
  });

  it("prints the epoch itself as 0 in every unit", () => {
    for (const unit of EPOCH_UNITS) {
      expect(epochIn({ epochMs: 0, nanos: 0 }, unit)).toBe("0");
    }
  });
});

describe("rendering an instant for the panel", () => {
  const now = JUN_2026;

  it("writes milliseconds when there is nothing finer to show", () => {
    const view = viewInstant({ epochMs: JUN_2026 + 123, nanos: 0 }, { now, timeZone: "UTC" });
    expect(view.iso).toBe("2026-06-15T07:12:34.123Z");
  });

  it("widens to six digits for microseconds and nine for nanoseconds", () => {
    expect(viewInstant({ epochMs: JUN_2026, nanos: 456_000 }, { now, timeZone: "UTC" }).iso).toBe(
      "2026-06-15T07:12:34.000456Z",
    );
    expect(viewInstant({ epochMs: JUN_2026, nanos: 456_789 }, { now, timeZone: "UTC" }).iso).toBe(
      "2026-06-15T07:12:34.000456789Z",
    );
    expect(viewInstant({ epochMs: JUN_2026, nanos: 7 }, { now, timeZone: "UTC" }).iso).toBe(
      "2026-06-15T07:12:34.000000007Z",
    );
  });

  it("renders one nanosecond before the epoch without a negative remainder", () => {
    const view = viewInstant({ epochMs: -1, nanos: 999_999 }, { now, timeZone: "UTC" });
    expect(view.iso).toBe("1969-12-31T23:59:59.999999999Z");
    expect(view.utc).toBe("Wed, 31 Dec 1969 · 23:59:59 UTC");
    expect(view.epochs).toEqual({ s: "-1", ms: "-1", us: "-1", ns: "-1" });
  });

  it("spells the UTC line from its own weekday and month tables", () => {
    const view = viewInstant({ epochMs: JUN_2026, nanos: 0 }, { now, timeZone: "UTC" });
    expect(view.utc).toBe("Mon, 15 Jun 2026 · 07:12:34 UTC");
    expect(view.local).toBe("Mon, 15 Jun 2026 · 07:12:34");
    expect(view.zoneName).toBe("UTC");
    expect(view.zoneOffset).toBe("UTC");
  });

  it("pads a day-of-month below ten", () => {
    // 1970-01-02T03:46:40Z.
    expect(viewInstant({ epochMs: 100_000_000, nanos: 0 }, { now, timeZone: "UTC" }).utc).toBe(
      "Fri, 02 Jan 1970 · 03:46:40 UTC",
    );
  });

  it("gives the four copy targets as exact decimal strings", () => {
    const view = viewInstant({ epochMs: JUN_2026, nanos: 0 }, { now, timeZone: "UTC" });
    expect(view.epochs).toEqual({
      s: "1781507554",
      ms: "1781507554000",
      us: "1781507554000000",
      ns: "1781507554000000000",
    });
  });

  it("reports a DST-correct offset — the same zone, two instants, two offsets", () => {
    // Two-sided. A table lookup or a constant passes one of these.
    const summer = viewInstant({ epochMs: JUN_2026, nanos: 0 }, { now, timeZone: "Europe/Paris" });
    expect(summer.local).toBe("Mon, 15 Jun 2026 · 09:12:34");
    expect(summer.zoneName).toBe("Europe/Paris");
    expect(summer.zoneOffset).toBe("UTC+02:00");

    const winter = viewInstant({ epochMs: JAN_2026, nanos: 0 }, { now, timeZone: "Europe/Paris" });
    expect(winter.local).toBe("Thu, 15 Jan 2026 · 08:12:34");
    expect(winter.zoneName).toBe("Europe/Paris");
    expect(winter.zoneOffset).toBe("UTC+01:00");

    expect(summer.zoneOffset).not.toBe(winter.zoneOffset);
  });

  it("reports a western offset with a minus sign, DST included", () => {
    const summer = viewInstant(
      { epochMs: JUN_2026, nanos: 0 },
      { now, timeZone: "America/New_York" },
    );
    expect(summer.local).toBe("Mon, 15 Jun 2026 · 03:12:34");
    expect(summer.zoneOffset).toBe("UTC-04:00");

    const winter = viewInstant(
      { epochMs: JAN_2026, nanos: 0 },
      { now, timeZone: "America/New_York" },
    );
    expect(winter.local).toBe("Thu, 15 Jan 2026 · 02:12:34");
    expect(winter.zoneOffset).toBe("UTC-05:00");
  });

  it("reports a half-hour offset on both sides of Greenwich", () => {
    expect(
      viewInstant({ epochMs: JUN_2026, nanos: 0 }, { now, timeZone: "Asia/Kolkata" }).zoneOffset,
    ).toBe("UTC+05:30");
    expect(
      viewInstant({ epochMs: JAN_2026, nanos: 0 }, { now, timeZone: "America/St_Johns" })
        .zoneOffset,
    ).toBe("UTC-03:30");
  });

  it("prints a zero offset as UTC rather than as UTC+00:00", () => {
    const view = viewInstant({ epochMs: JAN_2026, nanos: 0 }, { now, timeZone: "Europe/London" });
    expect(view.zoneName).toBe("Europe/London");
    expect(view.zoneOffset).toBe("UTC");
    expect(view.local).toBe("Thu, 15 Jan 2026 · 07:12:34");
  });

  it("degrades an unknown zone to UTC instead of throwing", () => {
    const view = viewInstant(
      { epochMs: JUN_2026, nanos: 0 },
      { now, timeZone: "Mars/Olympus_Mons" },
    );
    expect(view.zoneName).toBe("UTC");
    expect(view.zoneOffset).toBe("UTC");
    expect(view.local).toBe("Mon, 15 Jun 2026 · 07:12:34");
  });

  it("reports the zone under the platform's own spelling", () => {
    expect(viewInstant({ epochMs: JUN_2026, nanos: 0 }, { now, timeZone: "utc" }).zoneName).toBe(
      "UTC",
    );
  });

  it("uses the ISO expanded-year form past 9999 and pads a four-digit year", () => {
    const far = viewInstant({ epochMs: MAX_EPOCH_MS, nanos: 0 }, { now, timeZone: "UTC" });
    expect(far.iso).toBe("+275760-09-13T00:00:00.000Z");
    expect(far.utc).toBe("Sat, 13 Sep 275760 · 00:00:00 UTC");

    const yearFifty = viewInstant({ epochMs: -60_589_296_000_000, nanos: 0 }, { now, timeZone: "UTC" });
    expect(yearFifty.iso).toBe("0050-01-01T00:00:00.000Z");
    expect(yearFifty.utc).toBe("Sat, 01 Jan 0050 · 00:00:00 UTC");
  });

  it("reads a BC year back out of the zone lookup as an astronomical year", () => {
    // `Intl` says "1 BC" for astronomical year 0 and "2 BC" for −1. Reading those as
    // 1 and 2 would put the zone's clock two millennia away from the UTC line.
    const yearZero = viewInstant({ epochMs: -62_167_219_200_000, nanos: 0 }, { now, timeZone: "UTC" });
    expect(yearZero.utc).toBe("Sat, 01 Jan 0000 · 00:00:00 UTC");
    expect(yearZero.local).toBe("Sat, 01 Jan 0000 · 00:00:00");
    expect(yearZero.zoneOffset).toBe("UTC");

    const beforeYearZero = viewInstant(
      { epochMs: -62_198_755_200_000, nanos: 0 },
      { now, timeZone: "UTC" },
    );
    expect(beforeYearZero.iso).toBe("-000001-01-01T00:00:00.000Z");
    expect(beforeYearZero.utc).toBe("Fri, 01 Jan -0001 · 00:00:00 UTC");
  });

  it("puts the relative phrase on the view", () => {
    expect(
      viewInstant({ epochMs: JUN_2026 - 7_200_000, nanos: 0 }, { now, timeZone: "UTC" }).relative,
    ).toBe("2 hours ago");
  });
});

describe("saying how long ago an instant was", () => {
  const now = JUN_2026;
  const at = (deltaMs: number) => relativeTo({ epochMs: now - deltaMs, nanos: 0 }, now);

  it("calls anything inside a second “just now”, in either direction", () => {
    expect(at(0)).toBe("just now");
    expect(at(999)).toBe("just now");
    expect(at(-999)).toBe("just now");
  });

  it("starts counting seconds at exactly one second, past and future", () => {
    expect(at(1_000)).toBe("1 second ago");
    expect(at(-1_000)).toBe("in 1 second");
    expect(at(2_000)).toBe("2 seconds ago");
    expect(at(-2_000)).toBe("in 2 seconds");
  });

  it("switches from seconds to minutes at exactly one minute", () => {
    expect(at(59_999)).toBe("59 seconds ago");
    expect(at(60_000)).toBe("1 minute ago");
    expect(at(-60_000)).toBe("in 1 minute");
  });

  it("switches from minutes to hours at exactly one hour", () => {
    expect(at(3_599_999)).toBe("59 minutes ago");
    expect(at(3_600_000)).toBe("1 hour ago");
    expect(at(7_200_000)).toBe("2 hours ago");
  });

  it("switches from hours to days at exactly one day", () => {
    expect(at(86_399_999)).toBe("23 hours ago");
    expect(at(86_400_000)).toBe("1 day ago");
    expect(at(-259_200_000)).toBe("in 3 days");
  });

  it("switches from days to months at one average month (30.4375 days)", () => {
    expect(at(2_629_799_999)).toBe("30 days ago");
    expect(at(2_629_800_000)).toBe("1 month ago");
    expect(at(-5_259_600_000)).toBe("in 2 months");
  });

  it("switches from months to years at one Julian year, never printing 12 months", () => {
    expect(at(31_557_599_999)).toBe("11 months ago");
    expect(at(31_557_600_000)).toBe("1 year ago");
    expect(at(63_115_200_000)).toBe("2 years ago");
    expect(at(-31_557_600_000)).toBe("in 1 year");
  });
});

describe("the constants the panel and the sibling readers share", () => {
  it("names every unit exactly once, coarsest first", () => {
    expect(EPOCH_UNITS).toEqual(["s", "ms", "us", "ns"]);
    expect(UNIT_LABEL).toEqual({
      s: "seconds",
      ms: "milliseconds",
      us: "microseconds",
      ns: "nanoseconds",
    });
  });

  it("scales each unit to nanoseconds by a factor of a thousand", () => {
    expect(NANOS_PER).toEqual({ s: 1_000_000_000n, ms: 1_000_000n, us: 1_000n, ns: 1n });
  });

  it("stops at the last millisecond ECMA-262 lets a Date hold", () => {
    expect(MAX_EPOCH_MS).toBe(8_640_000_000_000_000);
  });
});
