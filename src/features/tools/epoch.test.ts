/** Only what `parseToolInput` decides: numeric wins (`20260615` is 1970-08-23 in seconds),
 * empty is a state, and a date-shaped non-date keeps its own reason. */

import { describe, expect, it } from "vitest";

import { UNKNOWN_MESSAGE, parseToolInput } from "./epoch";

/** A fixed clock — nothing here may depend on the machine's own. */
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

describe("parseToolInput — the classifier seam", () => {
  it("treats an untouched box as empty rather than as an error", () => {
    expect(parseToolInput("", NOW)).toEqual({ kind: "empty" });
    expect(parseToolInput("   ", NOW)).toEqual({ kind: "empty" });
  });

  it("reads a bare 8-digit number as a SECONDS epoch, not as YYYYMMDD", () => {
    // The two-sided half of the assertion: 20260615 is a date-shaped-looking string,
    // and the answer must be the 1970 one. If this ever returns kind "date", the
    // ordering in parseToolInput was flipped.
    const r = parseToolInput("20260615", NOW);
    expect(r.kind).toBe("epoch");
    // 20260615 seconds after the epoch — 1970-08-23T11:56:55Z.
    expect(r.kind === "epoch" && r.chosen.unit).toBe("s");
    expect(r.kind === "epoch" && r.chosen.instant?.epochMs).toBe(20_260_615_000);
  });

  it("still reads the compact form as a DATE once the T disambiguates it", () => {
    const r = parseToolInput("20260615T000000Z", NOW);
    expect(r.kind).toBe("date");
    expect(r.kind === "date" && r.readings[0].instant.epochMs).toBe(1_781_481_600_000);
  });

  it("classifies a plain date and a full timestamp, each as typed", () => {
    // First: a date typed without a time, 2024/01/25, converts as a date.
    const dateOnly = parseToolInput("2024/01/25", NOW);
    expect(dateOnly.kind).toBe("date");
    expect(dateOnly.kind === "date" && dateOnly.readings[0].instant.epochMs).toBe(
      1_706_140_800_000,
    );
    // Second: a timestamp that carries its time, 2026-06-15T07:12:34Z.
    const withTime = parseToolInput("2026-06-15T07:12:34Z", NOW);
    expect(withTime.kind).toBe("date");
    expect(withTime.kind === "date" && withTime.readings[0].instant.epochMs).toBe(
      1_781_507_554_000,
    );
  });

  it("passes an impossible date's OWN reason through, not the generic list", () => {
    const r = parseToolInput("2010-02-30", NOW);
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.message).not.toBe(UNKNOWN_MESSAGE);
    // The useful half of a rejection is the specific "why".
    expect(r.kind === "unknown" && r.message).toMatch(/February/i);
  });

  it("falls back to the list of accepted shapes only when nothing is date-shaped", () => {
    const r = parseToolInput("wat", NOW);
    expect(r).toEqual({ kind: "unknown", message: UNKNOWN_MESSAGE });
  });

  it("resolves “now” against the clock it is given, never the machine's", () => {
    const r = parseToolInput("now", NOW);
    expect(r.kind).toBe("date");
    expect(r.kind === "date" && r.readings[0].instant.epochMs).toBe(NOW);
  });
});
