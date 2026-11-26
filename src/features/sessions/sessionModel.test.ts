/** Local-time Date constructor (not UTC epochs) so strings hold in any timezone; `now` is passed
 * explicitly so the current-year rule never depends on the wall clock. */

import { describe, expect, it } from "vitest";

import { formatSessionDate, formatSize } from "./sessionModel";

describe("formatSessionDate", () => {
  const now = new Date(2026, 6, 24, 12, 0); // Jul 24 2026, local

  it("renders 'Mon D, HH:MM' for a same-year timestamp", () => {
    const at = new Date(2026, 6, 24, 16, 2).getTime();
    expect(formatSessionDate(at, now)).toBe("Jul 24, 16:02");
  });

  it("zero-pads hours and minutes", () => {
    const at = new Date(2026, 0, 5, 3, 7).getTime();
    expect(formatSessionDate(at, now)).toBe("Jan 5, 03:07");
  });

  it("appends the year when it is not the current one", () => {
    const at = new Date(2025, 4, 27, 15, 41).getTime();
    expect(formatSessionDate(at, now)).toBe("May 27 2025, 15:41");
  });

  it("defaults `now` to the wall clock — a just-now timestamp never shows a year", () => {
    // Built FROM the current wall clock, so this holds whatever year it runs in.
    const current = new Date();
    const at = new Date(current.getFullYear(), 2, 9, 8, 30).getTime();
    expect(formatSessionDate(at)).toBe("Mar 9, 08:30");
  });
});

describe("formatSize", () => {
  it("whole bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(532)).toBe("532 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("one decimal below 10 of a unit", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5.5 * 1024 * 1024 * 1024)).toBe("5.5 GB");
  });

  it("drops the decimal at a round value and from 10 of a unit up", () => {
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(532 * 1024)).toBe("532 KB");
    expect(formatSize(11 * 1024 * 1024)).toBe("11 MB");
  });

  it("caps at TB rather than inventing units", () => {
    expect(formatSize(3 * 1024 ** 4)).toBe("3 TB");
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB");
  });

  it("clamps a corrupt negative size to 0 B", () => {
    expect(formatSize(-5)).toBe("0 B");
  });
});
