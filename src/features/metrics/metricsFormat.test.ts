/**
 * `metricsFormat` — every string the dashboard renders.
 *
 * These are pinned with **literal** expectations, on purpose. A wrong duration or a
 * token count off by 1000× is worse than no dashboard, and the only thing standing
 * between the two is this file. Zero, `null` and "unknown" get their own cases
 * everywhere they are representable, because those three are exactly where a
 * "helpful" `?? 0` sneaks in.
 *
 * No fake timers anywhere: every relative formatter takes `nowMs`, so a countdown
 * assertion is arithmetic, not timing.
 */

import { describe, expect, it } from "vitest";

import {
  formatEmptyNote,
  formatEmptyTitle,
  formatScopeCoverage,
  UNKNOWN,
  describeMetricsError,
  formatAvgContext,
  formatClock,
  formatCount,
  formatCoverageBadge,
  formatDuration,
  formatDurationCoverage,
  formatDurationSource,
  formatExact,
  formatHourLabel,
  formatScannedAt,
  formatShare,
  formatTokens,
  formatTurnFooter,
  formatTurnSubtitle,
  parseMetricsError,
  turnLabel,
  windowLabel,
} from "./metricsFormat";
import type { MetricsErrorCode, TurnRow } from "./metricsTypes";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function turn(patch: Partial<TurnRow> = {}): TurnRow {
  return {
    turnId: "turn-1",
    sessionId: "0000dddd-0000-4000-8000-0000000000e5",
    rootId: "local",
    projectLabel: "proj",
    label: "add a metrics tab",
    startedAtMs: 0,
    endedAtMs: 1000,
    durationMs: 270_000,
    durationSource: "cli",
    requests: 44,
    tokens: { freshInput: 200, output: 60_000, cacheWrite: 12_000, cacheRead: 12_000_000 },
    toolCalls: 47,
    toolErrors: 0,
    filesChanged: 0,
    interrupted: false,
    humanPrompt: true,
    models: ["claude-opus-5"],
    ...patch,
  };
}

describe("formatDuration", () => {
  it("steps granularity down as the number shrinks", () => {
    expect(formatDuration(4 * HOUR + 12 * MINUTE)).toBe("4h 12m");
    expect(formatDuration(12 * MINUTE + 30_000)).toBe("12m 30s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(400)).toBe("0.4s");
  });

  it("renders an UNKNOWN duration as a dash and NEVER as 0", () => {
    // 🔴 The rule, encoded: a turn with no terminal assistant message
    // has a null duration, and a `0s` there would be a lie the user cannot detect.
    expect(formatDuration(null)).toBe(UNKNOWN);
    expect(formatDuration(null)).not.toBe("0s");
    expect(formatDuration(NaN)).toBe(UNKNOWN);
    expect(formatDuration(-1)).toBe(UNKNOWN);
  });

  it("renders a genuine zero as 0s — zero is a value, null is not", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("uses the CLI footer's own shape for the hero magnitude", () => {
    // Minutes and seconds, the way the CLI's per-turn footer prints them.
    expect(formatDuration(4 * MINUTE + 30_000)).toBe("4m 30s");
    expect(formatDuration(31 * MINUTE + 8_000)).toBe("31m 8s");
    expect(formatDuration(2 * HOUR)).toBe("2h 0m");
  });
});

describe("formatTokens", () => {
  it("compacts across the 14,000x range the four classes actually span", () => {
    // Invented figures in the magnitudes a 24 h window spans, so the tile widths are realistic.
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(456_789)).toBe("456.8k");
    expect(formatTokens(3_876_543)).toBe("3.9M");
    expect(formatTokens(201_234_567)).toBe("201.2M");
  });

  it("keeps small counts exact and handles the boundaries", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(999_999)).toBe("1000.0k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_000_000_000)).toBe("1.0B");
  });

  it("refuses to render a number it cannot read", () => {
    expect(formatTokens(NaN)).toBe(UNKNOWN);
    expect(formatTokens(Infinity)).toBe(UNKNOWN);
    expect(formatTokens(-5)).toBe(UNKNOWN);
  });
});

describe("formatCount / formatExact", () => {
  it("groups thousands by hand, so the string never depends on the machine locale", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
    expect(formatCount(1_250)).toBe("1,250");
    expect(formatExact(201_234_567)).toBe("201,234,567");
    expect(formatExact(1_000)).toBe("1,000");
    expect(formatExact(100)).toBe("100");
  });

  it("handles the signs and the unreadable cases", () => {
    expect(formatExact(-1_234)).toBe("-1,234");
    expect(formatExact(NaN)).toBe(UNKNOWN);
    expect(formatCount(NaN)).toBe(UNKNOWN);
    expect(formatCount(-1)).toBe(UNKNOWN);
  });
});

describe("formatTurnSubtitle", () => {
  it("names human turns and shows system-initiated ones SEPARATELY", () => {
    // Collapsing the two would inflate "you prompted N tasks" — 502 of this
    // machine's turns are promptSource "system".
    expect(formatTurnSubtitle(8, 8, 3)).toBe("8 human turns across 3 sessions");
    expect(formatTurnSubtitle(8, 11, 3)).toBe(
      "8 human turns across 3 sessions · 3 system-initiated",
    );
  });

  it("pluralizes so a one-turn day does not read as unfinished software", () => {
    expect(formatTurnSubtitle(1, 1, 1)).toBe("1 human turn across 1 session");
    expect(formatTurnSubtitle(0, 0, 0)).toBe("0 human turns across 0 sessions");
  });

  it("never shows a negative system count if the two numbers disagree", () => {
    expect(formatTurnSubtitle(5, 3, 1)).toBe("5 human turns across 1 session");
  });
});

describe("formatDurationCoverage", () => {
  it("says how many turns were measured only when it is not all of them", () => {
    expect(formatDurationCoverage(4, 8)).toBe("4 of 8 turns measured");
    expect(formatDurationCoverage(1, 2)).toBe("1 of 2 turns measured");
    expect(formatDurationCoverage(8, 8)).toBe("");
    expect(formatDurationCoverage(0, 0)).toBe("");
    // A count above the total is nonsense; saying nothing beats saying nonsense.
    expect(formatDurationCoverage(9, 8)).toBe("");
  });
});

describe("formatAvgContext / formatShare", () => {
  it("renders the honest headline that replaces a token total", () => {
    // ~145k is a plausible 24 h average — and it is a quantity that genuinely IS the
    // context size, unlike a sum of the four classes.
    expect(formatAvgContext(145_000)).toBe("145.0k");
    expect(formatAvgContext(35_102)).toBe("35.1k");
  });

  it("renders NULL as a dash — an average of nothing is not 0", () => {
    expect(formatAvgContext(null)).toBe(UNKNOWN);
    expect(formatAvgContext(null)).not.toBe("0");
  });

  it("renders the high-context share as a whole percent, clamped", () => {
    expect(formatShare(0.55)).toBe("55%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(1)).toBe("100%");
    expect(formatShare(1.4)).toBe("100%");
    expect(formatShare(-0.2)).toBe("0%");
    expect(formatShare(null)).toBe(UNKNOWN);
    expect(formatShare(NaN)).toBe(UNKNOWN);
  });
});

describe("windowLabel", () => {
  it("names the window the same way everywhere it is mentioned", () => {
    expect(windowLabel("last_24h")).toBe("last 24 h");
    expect(windowLabel("last_7d")).toBe("last 7 d");
  });
});

describe("formatScannedAt", () => {
  const NOW = 1_785_326_400_000;

  it("folds sub-minute freshness into 'just now'", () => {
    expect(formatScannedAt(NOW, NOW)).toBe("Scanned just now");
    expect(formatScannedAt(NOW - 59_000, NOW)).toBe("Scanned just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(formatScannedAt(NOW - 2 * MINUTE, NOW)).toBe("Scanned 2 min ago");
    expect(formatScannedAt(NOW - 59 * MINUTE, NOW)).toBe("Scanned 59 min ago");
    expect(formatScannedAt(NOW - 3 * HOUR, NOW)).toBe("Scanned 3 h ago");
    expect(formatScannedAt(NOW - 50 * HOUR, NOW)).toBe("Scanned 2 d ago");
  });

  it("reads a backwards clock as 'just now' rather than as the future", () => {
    // An NTP correction must not produce "Scanned in 3 minutes".
    expect(formatScannedAt(NOW + 5 * MINUTE, NOW)).toBe("Scanned just now");
  });
});

describe("formatHourLabel / formatClock", () => {
  it("renders local wall clock, zero-padded, with no locale involved", () => {
    // Built from a local Date so the expectation holds in every timezone: the point
    // is the SHAPE (`HH:MM`, padded), which `toLocaleTimeString` would not guarantee.
    const d = new Date(2026, 6, 29, 9, 5, 0);
    expect(formatHourLabel(d.getTime())).toBe("09:05");
    expect(formatClock(new Date(2026, 6, 29, 14, 32, 0).getTime())).toBe("14:32");
    expect(formatHourLabel(new Date(2026, 6, 29, 0, 0, 0).getTime())).toBe("00:00");
    expect(formatHourLabel(new Date(2026, 6, 29, 23, 59, 0).getTime())).toBe("23:59");
  });
});

describe("formatDurationSource", () => {
  it("names the source, and names nothing when there is no duration", () => {
    expect(formatDurationSource("cli")).toBe("cli");
    expect(formatDurationSource("derived")).toBe("derived");
    expect(formatDurationSource(null)).toBe("");
  });
});

describe("formatTurnFooter", () => {
  it("is the corrected form of the CLI's own footer — the classes kept APART", () => {
    // The CLI's footer has the shape `4m 30s · ↓ 72.0k tokens`. That single token
    // number is the wrong quantity; this is the same compact form with the classes split.
    expect(formatTurnFooter(turn())).toBe(
      "4m 30s · ↑200 fresh · ↓60.0k out · ♻12.0M cached",
    );
  });

  it("🔴 never adds output into the cached figure — there is no grand total", () => {
    const footer = formatTurnFooter(
      turn({ tokens: { freshInput: 0, output: 100, cacheWrite: 200, cacheRead: 300 } }),
    );
    // cached = 200 + 300 = 500, a LABELLED subtotal of the two non-fresh classes.
    expect(footer).toContain("♻500 cached");
    expect(footer).toContain("↓100 out");
    // 600 would be output folded in — the exact mistake this feature exists to avoid.
    expect(footer).not.toContain("600");
  });

  it("shows a dash for an unknown duration, in the footer too", () => {
    expect(formatTurnFooter(turn({ durationMs: null }))).toBe(
      `${UNKNOWN} · ↑200 fresh · ↓60.0k out · ♻12.0M cached`,
    );
  });
});

describe("turnLabel", () => {
  it("prefers the turn's own first line", () => {
    expect(turnLabel(turn())).toBe("add a metrics tab");
  });

  it("falls back to PROJECT · TIME, never to invented content", () => {
    // Changed when ALL scope landed. A turn with no label used to fall back to a
    // truncated session id; now it falls back to the project basename plus the turn
    // time, because that is what identifies a turn to a human scanning *every* project
    // at once — a session id identifies it to a machine. The session handle is still
    // reachable, in the expanded turn detail.
    //
    // What has NOT changed, and is the actual claim: the fallback is always DERIVED
    // (project, clock), never fabricated, and a whitespace-only label counts as absent
    // rather than being rendered as an empty cell.
    // The clock is LOCAL time, so build the expectation the same way instead of
    // hard-coding a clock string — that only holds in one timezone and fails on a
    // runner in another (a test must give the same answer in every timezone).
    const at = turn({ label: null }).startedAtMs;
    expect(turnLabel(turn({ label: null }))).toBe(`proj · ${formatClock(at)}`);
    expect(turnLabel(turn({ label: "   " }))).toBe(`proj · ${formatClock(at)}`);
  });
});

describe("formatCoverageBadge", () => {
  it("says 'complete' when nothing was missed", () => {
    expect(
      formatCoverageBadge({ partial: false, filesTruncated: 0, rootsUnavailable: [] }),
    ).toBe("complete");
    // Truncation without the partial flag would be a Rust bug; the badge still
    // trusts the flag, because that is the single source of truth.
    expect(
      formatCoverageBadge({ partial: false, filesTruncated: 3, rootsUnavailable: [] }),
    ).toBe("complete");
  });

  it("says WHAT was partial, not merely that something was", () => {
    // "partial" alone tells the user their numbers are wrong without telling them
    // how, which is worse than either extreme.
    expect(
      formatCoverageBadge({ partial: true, filesTruncated: 2, rootsUnavailable: [] }),
    ).toBe("partial — 2 files truncated");
    expect(
      formatCoverageBadge({ partial: true, filesTruncated: 1, rootsUnavailable: [] }),
    ).toBe("partial — 1 file truncated");
    expect(
      formatCoverageBadge({ partial: true, filesTruncated: 0, rootsUnavailable: ["This machine"] }),
    ).toBe("partial — 1 source unavailable");
    expect(
      formatCoverageBadge({
        partial: true,
        filesTruncated: 2,
        rootsUnavailable: ["This machine"],
      }),
    ).toBe("partial — 2 files truncated, 1 source unavailable");
  });

  it("degrades to a bare 'partial' rather than lying about a reason", () => {
    expect(
      formatCoverageBadge({ partial: true, filesTruncated: 0, rootsUnavailable: [] }),
    ).toBe("partial");
  });
});

describe("parseMetricsError", () => {
  it("keeps every documented code and DISCARDS the detail", () => {
    // The detail could name a path, and this module's output is rendered.
    expect(parseMetricsError("home-unresolved: no home directory")).toBe("home-unresolved");
    expect(parseMetricsError("scan-failed: project scope requires a cwd")).toBe("scan-failed");
    expect(parseMetricsError("root-unavailable")).toBe("root-unavailable");
    expect(parseMetricsError("no-transcripts")).toBe("no-transcripts");
  });

  it("collapses anything unrecognized to 'unknown' so no raw Rust string reaches the DOM", () => {
    expect(parseMetricsError("unknown: the metrics scan did not finish")).toBe("unknown");
    expect(parseMetricsError("thread 'main' panicked at src/metrics.rs:1")).toBe("unknown");
    expect(parseMetricsError("")).toBe("unknown");
    expect(parseMetricsError(new Error("scan-failed: nope"))).toBe("scan-failed");
    expect(parseMetricsError(new Error("boom"))).toBe("unknown");
    expect(parseMetricsError(undefined)).toBe("unknown");
    expect(parseMetricsError(null)).toBe("unknown");
    expect(parseMetricsError({ code: 7 })).toBe("unknown");
  });

  it("tolerates surrounding whitespace in the code", () => {
    expect(parseMetricsError("  scan-failed : detail")).toBe("scan-failed");
  });
});

describe("describeMetricsError", () => {
  const CODES: MetricsErrorCode[] = [
    "home-unresolved",
    "no-transcripts",
    "scan-failed",
    "root-unavailable",
    "unknown",
  ];

  it("gives every code one true sentence — no code falls through to a blank", () => {
    for (const code of CODES) {
      const text = describeMetricsError(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text.endsWith(".")).toBe(true);
      // Never a stack trace, never a path, never the machine-readable code —
      // `"unknown"` is exempt because the English word legitimately appears in
      // its own sentence ("for an unknown reason"), which is prose, not a code.
      expect(text).not.toContain("/");
      if (code !== "unknown") expect(text).not.toContain(code);
    }
  });

  it("distinguishes the failures a user would act on differently", () => {
    // "your home is unresolvable" and "the scan could not run here" call for
    // different responses, so they must not share a sentence.
    const distinct = new Set(CODES.map(describeMetricsError));
    expect(distinct.size).toBe(CODES.length);
  });
});

describe("formatScopeCoverage", () => {
  it("names the scope the report ACTUALLY covers", () => {
    expect(formatScopeCoverage("all", false)).toBe("All projects on this machine");
    expect(formatScopeCoverage("project", false)).toBe("This project only");
  });

  it("says so out loud when the answer is WIDER than the question", () => {
    // The honest replacement for an earlier error. Asking for one project without naming
    // one used to return `scan-failed` and the panel read "Could not read your
    // sessions"; now the report covers everything and SAYS that it did. Silence would be
    // the other failure mode — a report whose scope differs from the request without
    // admitting it is worse than an error, because it looks correct.
    expect(formatScopeCoverage("project", true)).toBe(
      "All projects — this project was requested, but no project is selected",
    );
    // The flag wins regardless of the scope it arrives with, because it describes what
    // the scan DID, not what was asked.
    expect(formatScopeCoverage("all", true)).toBe(
      "All projects — this project was requested, but no project is selected",
    );
  });
});

describe("turnLabel — the last-resort fallback", () => {
  it("uses the session HANDLE when even the project label is empty", () => {
    // Reachable: a transcript whose `cwd` yields no basename (a root path, a blank field
    // in an older CLI's line). Then project · time has no project, and the only honest
    // identifier left is a truncated session id. Never a blank cell, never invented text.
    expect(turnLabel(turn({ label: null, projectLabel: "" }))).toBe("0000dddd…");
    expect(turnLabel(turn({ label: "  ", projectLabel: "   " }))).toBe("0000dddd…");
  });
});

describe("the empty window says WHERE it looked", () => {
  it("distinguishes 'no sessions on this machine' from 'none in this folder'", () => {
    // An earlier version could only ever say the second, because project was the only
    // scope. They are different facts and only one of them is actionable, which is the
    // whole reason the empty state takes the scope as an argument.
    expect(formatEmptyTitle("all", "last_24h")).toBe(
      "No Claude sessions found on this machine in the last 24 h.",
    );
    expect(formatEmptyTitle("project", "last_24h")).toBe(
      "No Claude sessions found for this project in the last 24 h.",
    );
    expect(formatEmptyTitle("all", "last_7d")).toBe(
      "No Claude sessions found on this machine in the last 7 d.",
    );
  });

  it("points at the toggle when narrowing is what hid the sessions", () => {
    // In project scope "nothing here" has an actionable cause, so the note names it
    // rather than leaving the user to discover that a scope toggle exists.
    expect(formatEmptyNote("project", 163)).toBe(
      "163 transcripts checked. Sessions run in another folder are counted there — switch to All projects to see them.",
    );
    expect(formatEmptyNote("all", 163)).toBe(
      "163 transcripts checked. Every project folder on this machine was included.",
    );
    // Singular, because "1 transcripts" is the kind of thing that makes a user distrust
    // every other number on the screen.
    expect(formatEmptyNote("all", 1)).toBe(
      "1 transcript checked. Every project folder on this machine was included.",
    );
  });
});
