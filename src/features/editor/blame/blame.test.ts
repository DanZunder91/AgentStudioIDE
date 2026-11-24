/**
 * `blame.ts` — the pure logic behind the annotate gutter: labels,
 * run collapsing, line clamping, the popover model, and the calm error note.
 * All locale-sensitive assertions pass an explicit "en-US" so they don't depend
 * on the runner's locale; timestamps are built with the LOCAL-time Date
 * constructor so they don't depend on the runner's timezone either.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  blameErrorNote,
  commitForLine,
  firstOfRunFlags,
  fullBlameDate,
  gutterLabel,
  lastNameOf,
  popoverModel,
  shortBlameDate,
  UNCOMMITTED_LABEL,
} from "./blame";
import type { BlameCommit, FileBlame } from "./blameIpc";

/** Local 2026-05-27 12:00 — the date is 5/27/26 in every timezone. */
const MAY_27 = new Date(2026, 4, 27, 12, 0, 0).getTime();

const commit = (over: Partial<BlameCommit> = {}): BlameCommit => ({
  id: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
  author: "Max Turing",
  email: "max@example.com",
  timeMs: MAY_27,
  summary: "feat: add blame gutter",
  message: "feat: add blame gutter\n\nIntelliJ-style annotate.\n",
  ...over,
});

describe("lastNameOf", () => {
  it("takes the last whitespace-separated token", () => {
    expect(lastNameOf("Max Turing")).toBe("Turing");
    expect(lastNameOf("Ada King Lovelace")).toBe("Lovelace");
  });

  it("returns a single-word author as-is", () => {
    expect(lastNameOf("dependabot")).toBe("dependabot");
  });

  it("tolerates extra/trailing whitespace and keeps hyphenated names intact", () => {
    expect(lastNameOf("  Grace   Murray-Hopper  ")).toBe("Murray-Hopper");
  });

  it("returns '' for an empty or whitespace-only author", () => {
    expect(lastNameOf("")).toBe("");
    expect(lastNameOf("   ")).toBe("");
  });
});

describe("dates", () => {
  it("shortBlameDate is the IntelliJ-style short local date", () => {
    expect(shortBlameDate(MAY_27, "en-US")).toBe("5/27/26");
  });

  it("fullBlameDate carries date AND time for the popover", () => {
    const s = fullBlameDate(new Date(2026, 4, 27, 15, 41, 22).getTime(), "en-US");
    expect(s).toContain("May 27, 2026");
    expect(s).toContain("3:41:22"); // separator/AM-space vary by ICU; digits don't
    expect(s).toMatch(/PM/i);
  });
});

describe("firstOfRunFlags", () => {
  it("labels only the first line of a consecutive same-commit run", () => {
    //            line: 1    2  3  4    5     6     7
    expect(firstOfRunFlags([0, 0, 1, 0, null, null, 0])).toEqual([
      true, // 1 — starts the file
      false, // 2 — same commit as 1 → blank
      true, // 3 — different commit
      true, // 4 — back to commit 0, but NOT consecutive with lines 1–2
      true, // 5 — uncommitted after a commit
      false, // 6 — still uncommitted
      true, // 7 — committed again
    ]);
  });

  it("is empty for an empty file and false-first for a leading uncommitted line", () => {
    expect(firstOfRunFlags([])).toEqual([]);
    expect(firstOfRunFlags([null, 0])).toEqual([false, true]);
  });

  const linesArb = fc.array(fc.option(fc.nat(4), { nil: null }), { maxLength: 60 });

  it("property: preserves length, flags[0] ⇔ line 0 committed", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const flags = firstOfRunFlags(lines);
        expect(flags).toHaveLength(lines.length);
        if (lines.length > 0) expect(flags[0]).toBe(lines[0] !== null);
      }),
    );
  });

  it("property: a flag is true iff the value differs from its predecessor", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const flags = firstOfRunFlags(lines);
        for (let i = 1; i < lines.length; i++) {
          expect(flags[i]).toBe(lines[i] !== lines[i - 1]);
        }
      }),
    );
  });
});

describe("commitForLine (clamping)", () => {
  const blame: FileBlame = {
    relPath: "src/a.ts",
    commits: [commit()],
    lines: [0, null, 0],
  };

  it("maps a 1-based line to its commit, and null for an uncommitted line", () => {
    expect(commitForLine(blame, 1)).toBe(blame.commits[0]);
    expect(commitForLine(blame, 2)).toBeNull();
  });

  it("clamps a line beyond the blame (doc longer than the on-disk file)", () => {
    expect(commitForLine(blame, 4)).toBeNull();
    expect(commitForLine(blame, 999)).toBeNull();
  });

  it("clamps a commit index outside `commits` (malformed/stale payload)", () => {
    const bad: FileBlame = { relPath: "a", commits: [commit()], lines: [7] };
    expect(commitForLine(bad, 1)).toBeNull();
  });

  it("property: never throws, whatever the line number and lines array", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.integer({ min: -3, max: 9 }), { nil: null }), { maxLength: 30 }),
        fc.integer({ min: -5, max: 50 }),
        (lines, lineNumber) => {
          const b: FileBlame = { relPath: "x", commits: [commit()], lines };
          const got = commitForLine(b, lineNumber);
          expect(got === null || got === b.commits[0]).toBe(true);
        },
      ),
    );
  });
});

describe("gutterLabel", () => {
  it("renders 'shortDate LastName' on the first line of a run", () => {
    expect(gutterLabel(commit(), true, "en-US")).toBe("5/27/26 Turing");
  });

  it("renders blank on a run's continuation lines (IntelliJ collapsing)", () => {
    expect(gutterLabel(commit(), false, "en-US")).toBe("");
  });

  it("renders the dimmed placeholder for an uncommitted line, first-of-run or not", () => {
    expect(gutterLabel(null, true)).toBe(UNCOMMITTED_LABEL);
    expect(gutterLabel(null, false)).toBe(UNCOMMITTED_LABEL);
  });
});

describe("popoverModel", () => {
  it("builds the full-commit view: hash, author <email>, date+time, path, message", () => {
    const m = popoverModel(commit(), "src/features/editor/blame/blame.ts", "en-US");
    expect(m.hash).toBe("8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49");
    expect(m.author).toBe("Max Turing <max@example.com>");
    expect(m.date).toContain("May 27, 2026");
    expect(m.path).toBe("src/features/editor/blame/blame.ts");
  });

  it("keeps the FULL multi-line message, trimming only trailing whitespace", () => {
    const m = popoverModel(commit(), "src/a.ts", "en-US");
    expect(m.message).toBe("feat: add blame gutter\n\nIntelliJ-style annotate.");
  });

  it("falls back to the summary when the message is empty", () => {
    const m = popoverModel(commit({ message: "\n" }), "src/a.ts", "en-US");
    expect(m.message).toBe("feat: add blame gutter");
  });
});

describe("blameErrorNote", () => {
  it("maps the not-a-repo rejection to 'No git history'", () => {
    expect(blameErrorNote("/tmp/x.ts is not in a git repository")).toBe("No git history");
    expect(blameErrorNote(new Error("path Not In A Git Repository"))).toBe("No git history");
  });

  it("maps any other rejection (scope error, IPC failure) to a generic calm note", () => {
    expect(blameErrorNote("path is outside the workspace scope")).toBe("Blame unavailable");
    expect(blameErrorNote(undefined)).toBe("Blame unavailable");
    expect(blameErrorNote(new Error("boom"))).toBe("Blame unavailable");
  });
});
