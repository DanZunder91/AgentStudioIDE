/** Every expectation is a hand-typed literal, never derived from the module under test. No real
 * clock: relative formatters take `nowMs`; absolute cases use local `new Date(y, m, d, h, min)`,
 * so weekday and wall-clock match in every timezone. */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  describeUsageError,
  formatFetchedAt,
  formatPct,
  formatResetsAt,
  formatUsedPct,
  parseUsageError,
  usageTone,
  type UsageTone,
} from "./usageFormat";

const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

/** Local wall-clock → epoch ms. July 2026 is used throughout: the 26th is a Sunday. */
const at = (y: number, m: number, d: number, h: number, min: number): number =>
  new Date(y, m, d, h, min).getTime();

describe("usageTone", () => {
  it("is ok below 60", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(1)).toBe("ok");
    expect(usageTone(59)).toBe("ok");
  });

  // The `<` vs `<=` slip lives exactly here: 59.9 and 60 must land in different
  // bands, and so must 89.9 and 90. Each threshold is inclusive on the upper band.
  it("flips to warn AT 60, not just above it", () => {
    expect(usageTone(59.9)).toBe("ok");
    expect(usageTone(60)).toBe("warn");
  });

  it("flips to danger AT 90, not just above it", () => {
    expect(usageTone(89.9)).toBe("warn");
    expect(usageTone(90)).toBe("danger");
  });

  it("is danger at and beyond 100", () => {
    expect(usageTone(100)).toBe("danger");
    expect(usageTone(100_000)).toBe("danger");
  });

  // A broken number must not paint the bar red — that would tell the user their
  // account is nearly spent on the strength of a value we could not read.
  it("treats non-finite and negative input as an empty window (ok)", () => {
    expect(usageTone(Number.NaN)).toBe("ok");
    expect(usageTone(-Infinity)).toBe("ok");
    expect(usageTone(-3)).toBe("ok");
  });

  it("treats +Infinity as a full window (danger)", () => {
    expect(usageTone(Infinity)).toBe("danger");
  });
});

describe("formatPct / formatUsedPct", () => {
  it("renders whole percents", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(24)).toBe("24%");
    expect(formatPct(100)).toBe("100%");
    expect(formatUsedPct(0)).toBe("0% used");
    expect(formatUsedPct(24)).toBe("24% used");
    expect(formatUsedPct(100)).toBe("100% used");
  });

  it("rounds half-up", () => {
    expect(formatPct(24.4)).toBe("24%");
    expect(formatPct(24.5)).toBe("25%");
    expect(formatPct(0.4)).toBe("0%");
    expect(formatPct(0.5)).toBe("1%");
    expect(formatUsedPct(99.6)).toBe("100% used");
    expect(formatUsedPct(99.4)).toBe("99% used");
  });

  // Rust clamps already; this is the belt to that braces, because "-3% used" or a
  // bar overflowing its track reads as a broken app, not as odd CLI output.
  it("clamps out-of-range and non-finite input", () => {
    expect(formatUsedPct(-3)).toBe("0% used");
    expect(formatUsedPct(-0.6)).toBe("0% used");
    expect(formatUsedPct(137)).toBe("100% used");
    expect(formatUsedPct(Number.NaN)).toBe("0% used");
    expect(formatPct(Infinity)).toBe("100%");
    expect(formatPct(-Infinity)).toBe("0%");
  });
});

describe("formatResetsAt", () => {
  const now = at(2026, 6, 25, 11, 0); // Sat 25 Jul 2026, 11:00 local

  it("renders nothing when the reset time was not parseable (null)", () => {
    expect(formatResetsAt(null, now)).toBe("");
  });

  // Once the boundary passes, the snapshot in hand is stale — "Reset 3 min ago"
  // would be a claim about a window we have not re-read. Sub-minute joins the same
  // bucket so the string can never read "Resets in 0 min".
  it("says 'Resets now' when past, at, or under a minute from the boundary", () => {
    expect(formatResetsAt(now - HR, now)).toBe("Resets now");
    expect(formatResetsAt(now, now)).toBe("Resets now");
    expect(formatResetsAt(now + 1, now)).toBe("Resets now");
    expect(formatResetsAt(now + MIN - 1, now)).toBe("Resets now");
  });

  it("counts minutes under an hour", () => {
    expect(formatResetsAt(now + MIN, now)).toBe("Resets in 1 min");
    expect(formatResetsAt(now + 34 * MIN, now)).toBe("Resets in 34 min");
    expect(formatResetsAt(now + HR - 1, now)).toBe("Resets in 59 min");
  });

  it("counts hours and minutes under a day", () => {
    expect(formatResetsAt(now + 4 * HR + 34 * MIN, now)).toBe("Resets in 4 hr 34 min");
    expect(formatResetsAt(now + 23 * HR + 59 * MIN, now)).toBe("Resets in 23 hr 59 min");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatResetsAt(now + HR, now)).toBe("Resets in 1 hr");
    expect(formatResetsAt(now + 4 * HR, now)).toBe("Resets in 4 hr");
    expect(formatResetsAt(now + 23 * HR, now)).toBe("Resets in 23 hr");
  });

  // Truncation, not rounding: the displayed number only ticks down, and it never
  // overstates the wait. 4h34m59s is "4 hr 34 min", never "4 hr 35 min".
  it("truncates the remaining seconds instead of rounding up", () => {
    expect(formatResetsAt(now + 4 * HR + 34 * MIN + 59_000, now)).toBe(
      "Resets in 4 hr 34 min",
    );
    expect(formatResetsAt(now + 34 * MIN + 59_000, now)).toBe("Resets in 34 min");
    expect(formatResetsAt(now + HR + 59_000, now)).toBe("Resets in 1 hr");
  });

  it("switches to an absolute weekday + clock AT 24 hours", () => {
    const sunday11am = at(2026, 6, 26, 11, 0);
    // Exactly one day out is already the absolute form — the boundary is inclusive.
    expect(formatResetsAt(sunday11am, sunday11am - DAY)).toBe("Resets Sun 11:00 AM");
    expect(formatResetsAt(sunday11am, sunday11am - DAY + 1)).toBe("Resets in 23 hr 59 min");
  });

  // The 12-hour clock's two traps: hour 0 and hour 12 both display as 12.
  it("renders midnight as 12:00 AM and noon as 12:00 PM", () => {
    const midnight = at(2026, 6, 27, 0, 0); // Mon
    const noon = at(2026, 6, 28, 12, 0); // Tue
    expect(formatResetsAt(midnight, midnight - DAY)).toBe("Resets Mon 12:00 AM");
    expect(formatResetsAt(noon, noon - DAY)).toBe("Resets Tue 12:00 PM");
  });

  it("zero-pads the minutes and picks AM/PM around noon", () => {
    const early = at(2026, 6, 29, 0, 5); // Wed 00:05
    const lateNight = at(2026, 6, 30, 23, 59); // Thu 23:59
    const afternoon = at(2026, 6, 31, 13, 7); // Fri 13:07
    const lastAm = at(2026, 7, 1, 11, 59); // Sat 11:59
    expect(formatResetsAt(early, early - DAY)).toBe("Resets Wed 12:05 AM");
    expect(formatResetsAt(lateNight, lateNight - DAY)).toBe("Resets Thu 11:59 PM");
    expect(formatResetsAt(afternoon, afternoon - DAY)).toBe("Resets Fri 1:07 PM");
    expect(formatResetsAt(lastAm, lastAm - DAY)).toBe("Resets Sat 11:59 AM");
  });

  // Sun/Mon/Tue/Wed/Thu/Fri/Sat all appear across the cases above; this pins the
  // one that a wrong table offset would break first (index 0 = Sunday).
  it("names the weekday from the reset date, not from 'now'", () => {
    const sunday = at(2026, 6, 26, 9, 30);
    // "now" is a Thursday three days earlier; the label must still say Sun.
    expect(formatResetsAt(sunday, at(2026, 6, 23, 9, 30))).toBe("Resets Sun 9:30 AM");
  });

  it("renders nothing for input it cannot describe truthfully", () => {
    expect(formatResetsAt(Number.NaN, now)).toBe("");
    expect(formatResetsAt(Infinity, now)).toBe("");
    expect(formatResetsAt(now + DAY, Number.NaN)).toBe("");
    expect(formatResetsAt(now + DAY, Infinity)).toBe("");
    // Past ±8.64e15 ms a Date is invalid and every getter yields NaN — without the
    // guard this printed "Resets undefined NaN:NaN AM".
    expect(formatResetsAt(9e15, now)).toBe("");
    expect(formatResetsAt(1e300, now)).toBe("");
  });
});

describe("formatFetchedAt", () => {
  const now = at(2026, 6, 29, 15, 0);

  it("says 'just now' under ten seconds", () => {
    expect(formatFetchedAt(now, now)).toBe("Updated just now");
    expect(formatFetchedAt(now - 9_999, now)).toBe("Updated just now");
  });

  it("counts seconds from ten seconds to a minute", () => {
    expect(formatFetchedAt(now - 10_000, now)).toBe("Updated 10s ago");
    expect(formatFetchedAt(now - 42_000, now)).toBe("Updated 42s ago");
    expect(formatFetchedAt(now - (MIN - 1), now)).toBe("Updated 59s ago");
  });

  it("counts minutes from a minute to an hour", () => {
    expect(formatFetchedAt(now - MIN, now)).toBe("Updated 1 min ago");
    expect(formatFetchedAt(now - 2 * MIN, now)).toBe("Updated 2 min ago");
    expect(formatFetchedAt(now - (HR - 1), now)).toBe("Updated 59 min ago");
  });

  it("counts hours beyond an hour, with no further buckets", () => {
    expect(formatFetchedAt(now - HR, now)).toBe("Updated 1 hr ago");
    expect(formatFetchedAt(now - 5 * HR, now)).toBe("Updated 5 hr ago");
    // Deliberately not "3 days ago": a snapshot this old is pathological, and
    // "74 hr ago" already reads as "very stale".
    expect(formatFetchedAt(now - 74 * HR, now)).toBe("Updated 74 hr ago");
  });

  it("never prints a negative age when the timestamps disagree", () => {
    expect(formatFetchedAt(now + 5 * MIN, now)).toBe("Updated just now");
    expect(formatFetchedAt(now, Number.NaN)).toBe("Updated just now");
    expect(formatFetchedAt(Number.NaN, now)).toBe("Updated just now");
    expect(formatFetchedAt(-Infinity, now)).toBe("Updated just now");
    expect(formatFetchedAt(0, Infinity)).toBe("Updated just now");
  });
});

describe("parseUsageError", () => {
  it("accepts a bare code", () => {
    expect(parseUsageError("cli-missing")).toBe("cli-missing");
    expect(parseUsageError("not-signed-in")).toBe("not-signed-in");
    expect(parseUsageError("cli-failed")).toBe("cli-failed");
    expect(parseUsageError("timeout")).toBe("timeout");
    expect(parseUsageError("parse")).toBe("parse");
    expect(parseUsageError("unknown")).toBe("unknown");
  });

  it("takes the segment before the first colon and ignores the detail", () => {
    expect(parseUsageError("cli-missing: No such file or directory")).toBe("cli-missing");
    expect(parseUsageError("not-signed-in: Invalid API key")).toBe("not-signed-in");
    expect(parseUsageError("cli-failed: exit status: 1")).toBe("cli-failed");
    expect(parseUsageError("timeout: no output within 15s")).toBe("timeout");
    expect(parseUsageError("parse: no usage rows in output")).toBe("parse");
  });

  it("trims and lowercases the code", () => {
    expect(parseUsageError("  NOT-SIGNED-IN  ")).toBe("not-signed-in");
    expect(parseUsageError(" Cli-Failed : exit status: 2")).toBe("cli-failed");
  });

  // Tauri sometimes hands the catch block an Error rather than the raw string.
  it("reads .message off an Error", () => {
    expect(parseUsageError(new Error("cli-missing: claude not found on PATH"))).toBe(
      "cli-missing",
    );
    expect(parseUsageError(new TypeError("timeout"))).toBe("timeout");
  });

  // Duck-typed, not `instanceof`: an Error that crossed a realm boundary (worker,
  // webview bridge) fails `instanceof` while still carrying a good message.
  it("reads .message off any object that has a string one", () => {
    expect(parseUsageError({ message: "not-signed-in: run claude auth login" })).toBe(
      "not-signed-in",
    );
  });

  it("is 'unknown' for anything it cannot recognize", () => {
    expect(parseUsageError(null)).toBe("unknown");
    expect(parseUsageError(undefined)).toBe("unknown");
    expect(parseUsageError(42)).toBe("unknown");
    expect(parseUsageError({})).toBe("unknown");
    expect(parseUsageError([])).toBe("unknown");
    expect(parseUsageError({ message: 5 })).toBe("unknown");
    expect(parseUsageError("")).toBe("unknown");
    expect(parseUsageError("teapot: 418")).toBe("unknown");
  });

  // The numbers come from `claude -p "/usage"`; a stale build emitting a v1 word must degrade to
  // "unknown", not be rendered as a diagnosis about a network we never touched.
  it("rejects the retired v1 error vocabulary", () => {
    expect(parseUsageError("no-credentials")).toBe("unknown");
    expect(parseUsageError("unauthorized: 401")).toBe("unknown");
    expect(parseUsageError("http: 500 Internal Server Error")).toBe("unknown");
    expect(parseUsageError("network: dns error: name not resolved")).toBe("unknown");
  });

  // The delimiter is load-bearing: we never scan for a code as a substring, so a
  // message some layer in between rewrote cannot be mistaken for a diagnosis.
  it("requires the colon delimiter and never substring-matches", () => {
    expect(parseUsageError("cli-missing from this machine")).toBe("unknown");
    expect(parseUsageError("Error: not-signed-in")).toBe("unknown");
    expect(parseUsageError("pre-timeout: 15s")).toBe("unknown");
    expect(parseUsageError("spawn claude: cli-missing")).toBe("unknown");
  });
});

describe("describeUsageError", () => {
  const CODES = [
    "cli-missing",
    "not-signed-in",
    "cli-failed",
    "timeout",
    "parse",
    "unknown",
  ] as const;

  // Hand-typed sentences, one per code — NOT read from the source's switch (see
  // the header note). Each says what happened and the next move,
  // names no cause we did not observe, and blames nobody.
  it("gives one actionable sentence per code", () => {
    expect(describeUsageError("cli-missing")).toBe(
      "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry.",
    );
    expect(describeUsageError("not-signed-in")).toBe(
      "The claude CLI is signed out — run claude auth login in a terminal, then retry.",
    );
    expect(describeUsageError("cli-failed")).toBe(
      'The claude CLI ran but exited with an error — retry, or run claude "/usage" in a terminal to see what it reports.',
    );
    expect(describeUsageError("timeout")).toBe(
      "The claude CLI did not answer in time — retry in a moment.",
    );
    expect(describeUsageError("parse")).toBe(
      "The claude CLI answered, but its output was not in a format this panel can read — its wording has probably changed, so retrying will not help.",
    );
    expect(describeUsageError("unknown")).toBe(
      "The usage read failed for an unrecognized reason — retrying may help.",
    );
  });

  // The numbers come from the user's own CLI (no request, no credential): naming a network, API or
  // keychain would send the user to check something never involved.
  it("never names a network, an API, or a credential store", () => {
    const forbidden = /anthropic|api|network|internet|offline|connection|token|credential|keychain/i;
    for (const code of CODES) {
      expect(describeUsageError(code)).not.toMatch(forbidden);
    }
  });

  // A code that renders the same words as another code is a code that carries no
  // information — the whole reason the union has six members is that the six
  // failures need six different next moves.
  it("gives every code its own distinct sentence", () => {
    const sentences = CODES.map(describeUsageError);
    expect(new Set(sentences).size).toBe(CODES.length);
  });

  // Not a canned fallback: every code must produce a real sentence, and the two
  // fixable ones must name the tool the user has to reach for.
  it("always returns one non-empty sentence, and names the CLI where that is the fix", () => {
    for (const code of CODES) {
      const sentence = describeUsageError(code);
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence.endsWith(".")).toBe(true);
    }
    expect(describeUsageError("cli-missing")).toContain("claude CLI");
    expect(describeUsageError("not-signed-in")).toContain("claude auth login");
  });
});

/* ── properties ── severity is declared HERE, not imported, so a wrong band order fails. */

const SEVERITY: Record<UsageTone, number> = { ok: 0, warn: 1, danger: 2 };

describe("properties", () => {
  it("usageTone is monotone non-decreasing in severity as the percent rises", () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (a, b) => {
        // NaN has no place in an ordering claim; it is pinned by its own case above.
        fc.pre(!Number.isNaN(a) && !Number.isNaN(b));
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(SEVERITY[usageTone(lo)]).toBeLessThanOrEqual(SEVERITY[usageTone(hi)]);
      }),
    );
  });

  it("formatPct is always a 0..100 whole percent", () => {
    fc.assert(
      fc.property(fc.double(), (pct) => {
        const s = formatPct(pct);
        expect(s).toMatch(/^\d{1,3}%$/);
        const n = Number(s.slice(0, -1));
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }),
    );
  });

  it("formatResetsAt never throws and never leaks NaN/undefined into the label", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.double(), fc.integer()),
        fc.oneof(fc.double(), fc.integer()),
        (resetsAtMs, nowMs) => {
          const s = formatResetsAt(resetsAtMs, nowMs);
          expect(typeof s).toBe("string");
          expect(s).not.toMatch(/NaN|undefined|Invalid/);
        },
      ),
    );
  });

  it("formatFetchedAt never renders a negative age", () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (fetchedAtMs, nowMs) => {
        const s = formatFetchedAt(fetchedAtMs, nowMs);
        expect(s.startsWith("Updated ")).toBe(true);
        expect(s).not.toMatch(/-|NaN|undefined/);
      }),
    );
  });
});
