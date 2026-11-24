/**
 * EpochTool — the Tools rail's epoch ⇄ date converter.
 *
 * ── How this file is written, and why ────────────────────────────────────────
 * **The real component over the real engine.** Nothing here is `vi.mock`ed: test the
 * layer the user touches — a dialog can ship visibly broken with every test green when
 * every test sits a layer below the screen. A converter's deliverable IS the screen, so
 * the tests render it and read the strings a person would read.
 *
 * **Arrived at the way a user arrives**: every input is TYPED with
 * `userEvent`, never pushed into state. The now-row test clicks the now row. The clear
 * test clicks the ×.
 *
 * **Literal expectations**. Every date, every epoch and every sentence
 * below is written out by hand, cross-checked against an INDEPENDENT oracle (`date -u -r
 * …` / `date -u -j -f …` on the host) rather than derived by calling the engine. An
 * expectation computed from the code under test can only ever catch plumbing.
 *
 * **Hermetic**: `clock` and `timeZone` are pinned in every test, so nothing
 * depends on when or where the suite runs. `Europe/Paris` is the default zone here
 * because its offset is non-zero AND seasonal — a hard-coded `+00:00`, or a formatter that
 * quietly used UTC for the "local" line, cannot pass. One case pins `"UTC"` so the
 * zero-offset rendering is real too.
 *
 * ── Falsification (every change must move a test) ────────────────────────────
 * Six load-bearing lines were mutated, the run watched, and the line restored. The
 * failures below are the ones those runs printed (sample values since updated), not
 * predictions:
 *
 *  1. Dropped `<p className="epoch-because">{epoch.chosen.because}</p>` — **3 red**:
 *     `AssertionError: expected '' to be '10 digits — 11 or fewer digits reads …' //
 *     Object.is equality`, and the same for the 19-digit and the explicit-suffix cases.
 *     The required explanation is pinned in all three shapes, not just the happy one.
 *  2. Swapped the UTC row's value for `view.local` — **8 red**, e.g.
 *     `- "UTC": "Tue, 14 Nov 2023 · 22:13:20 UTC"` / `+ "UTC": "Tue, 14 Nov 2023 ·
 *     23:13:20"`. `Europe/Paris` is what makes this visible at all; under a UTC-only
 *     suite the mutant survives, which is why the zone is what it is.
 *  3. Collapsed `parse.readings.map(…)` to `readings[0]` — **1 red**:
 *     `AssertionError: expected …(1) to have a length of 2 but got 1`.
 *  4. Deleted the `return () => clearInterval(id)` cleanup — **1 red**:
 *     `AssertionError: expected 1 to be +0 // Object.is equality`.
 *  5. Deleted the `setInterval` itself (leaving the cleanup) — **2 red**:
 *     `AssertionError: expected +0 to be 1` plus the relative-line test. Both directions
 *     of the timer claim fail, so the assertion is two-sided rather than a
 *     count that happens to be right.
 *  6. Forced `alternative` to `null` — **2 red**: the row map lost
 *     `"Or, read in Europe/Paris — seconds": "1706137200"`, and the copy test lost its
 *     button.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EpochTool, hostTimeZone } from "./EpochTool";

/** 2027-01-15T08:00:00Z. Deliberately unrelated to every value typed below, so the
 *  now-row's own digits can never be mistaken for a converted answer. */
const NOW = 1_800_000_000_000;
const PARIS = "Europe/Paris";

const clockAt =
  (ms: number): (() => number) =>
  () =>
    ms;

afterEach(cleanup);

function mount(timeZone = PARIS, now = NOW) {
  const user = userEvent.setup();
  render(<EpochTool clock={clockAt(now)} timeZone={timeZone} />);
  return user;
}

const box = (): HTMLInputElement =>
  screen.getByLabelText("Epoch or date to convert") as HTMLInputElement;

/** The live now row's value control — the thing that fills the box when clicked. */
const nowButton = (seconds: string): HTMLElement =>
  screen.getByRole("button", { name: `Use the current epoch ${seconds}` });

const one = (selector: string, root: ParentNode = document): string =>
  root.querySelector(selector)?.textContent ?? "";

/** Every label-above-value row under `root`, as `label -> value`. */
function rows(root: ParentNode = document): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of root.querySelectorAll(".epoch-row, .epoch-alt")) {
    out[one(".epoch-row__label", row)] = one(".epoch-row__value", row);
  }
  return out;
}

/**
 * Replace whatever `navigator.clipboard` currently is with a spy.
 *
 * Must be called AFTER `userEvent.setup()`, which installs a clipboard stub of its own —
 * a spy defined before it is thrown away, and the copy assertions then see zero calls.
 */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

/** One "also reads as" entry — its two lines, or its out-of-range note. */
function other(unit: string): { utc: string; iso: string; void: string } {
  const li = document.querySelector(`.epoch-other[data-unit="${unit}"]`);
  if (li === null) throw new Error(`no “also reads as” entry for ${unit}`);
  return {
    utc: one(".epoch-other__utc", li),
    iso: one(".epoch-other__iso", li),
    void: one(".epoch-other__void", li),
  };
}

describe("EpochTool — the empty state", () => {
  it("shows the live now row and a hint naming real shapes, with nothing red", () => {
    mount();

    expect(rows()).toEqual({});
    expect(nowButton("1800000000")).toHaveTextContent("1800000000");
    expect(one(".epoch-hint")).toBe(
      "Type an epoch (1700000000), an ISO timestamp (2023-11-14T22:13:20Z), a plain date (2024/01/25 or 25 Jan 2024), or “now”. Which way to convert is decided from what you type, and what was decided is shown.",
    );
    // Not an error: no alert, and no result block.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("epoch-result")).toBeNull();
    // Nothing to clear yet.
    expect(screen.queryByLabelText("Clear the input")).toBeNull();
  });
});

describe("EpochTool — a number was typed", () => {
  it("a bare number: the chosen unit, the printed reason, and UTC first", async () => {
    const user = mount();
    await user.type(box(), "1700000000");

    expect(one(".epoch-verdict strong")).toBe("seconds");
    expect(one(".epoch-verdict__how")).toBe("guessed from the digit count");
    expect(one(".epoch-because")).toBe(
      "10 digits — 11 or fewer digits reads as seconds; every boundary sits at the year 5138.",
    );

    expect(rows()).toEqual({
      UTC: "Tue, 14 Nov 2023 · 22:13:20 UTC",
      "ISO 8601": "2023-11-14T22:13:20.000Z",
      "Local · Europe/Paris": "Tue, 14 Nov 2023 · 23:13:20 · UTC+01:00",
      Relative: "3 years ago",
    });

    // UTC really is first — it is a requirement, so its position is pinned, not implied.
    const labels = Array.from(document.querySelectorAll(".epoch-row__label")).map(
      (n) => n.textContent,
    );
    expect(labels).toEqual([
      "Now — seconds",
      "UTC",
      "ISO 8601",
      "Local · Europe/Paris",
      "Relative",
    ]);
  });

  it("shows the other three unit readings, so a ms-for-s misread is one glance away", async () => {
    const user = mount();
    await user.type(box(), "1700000000");

    expect(document.querySelectorAll(".epoch-other")).toHaveLength(3);
    expect(other("ms")).toEqual({
      utc: "Tue, 20 Jan 1970 · 16:13:20 UTC",
      iso: "1970-01-20T16:13:20.000Z",
      void: "",
    });
    expect(other("us")).toEqual({
      utc: "Thu, 01 Jan 1970 · 00:28:20 UTC",
      iso: "1970-01-01T00:28:20.000Z",
      void: "",
    });
    expect(other("ns")).toEqual({
      utc: "Thu, 01 Jan 1970 · 00:00:01 UTC",
      iso: "1970-01-01T00:00:01.700Z",
      void: "",
    });
    // The chosen unit is never repeated in the alternatives.
    expect(document.querySelector('.epoch-other[data-unit="s"]')).toBeNull();
  });

  it("a 19-digit nanosecond stamp survives Number()'s 2^53 ceiling", async () => {
    const user = mount();
    await user.type(box(), "1700000000123456789");

    expect(one(".epoch-verdict strong")).toBe("nanoseconds");
    expect(one(".epoch-because")).toBe(
      "19 digits — 18 or more digits reads as nanoseconds; every boundary sits at the year 5138.",
    );
    expect(rows()["ISO 8601"]).toBe("2023-11-14T22:13:20.123456789Z");
    expect(rows().UTC).toBe("Tue, 14 Nov 2023 · 22:13:20 UTC");
  });

  it("an explicit suffix says so, and an unrepresentable reading says out of range", async () => {
    const user = mount();
    await user.type(box(), "1700000000123456789s");

    expect(one(".epoch-verdict strong")).toBe("seconds");
    expect(one(".epoch-verdict__how")).toBe("from the suffix you typed");
    expect(one(".epoch-because")).toBe(
      "The “s” suffix says seconds, so nothing was guessed.",
    );
    // The chosen reading itself is out of range — a normal state, not an error.
    expect(one(".epoch-void")).toBe("Out of the range a calendar can represent.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()).toEqual({});

    // …and so is one of the alternatives, while two others still resolve.
    expect(other("ms").void).toBe("Out of the range a calendar can represent.");
    expect(other("ms").utc).toBe("");
    expect(other("ns")).toEqual({
      utc: "Tue, 14 Nov 2023 · 22:13:20 UTC",
      iso: "2023-11-14T22:13:20.123456789Z",
      void: "",
    });
    expect(other("us").utc).not.toBe("");
  });

  it("a zero-offset zone renders the local line honestly rather than hiding it", async () => {
    const user = mount("UTC");
    await user.type(box(), "1700000000");

    expect(rows()["Local · UTC"]).toBe("Tue, 14 Nov 2023 · 22:13:20 · UTC");
  });
});

describe("EpochTool — a date string was typed", () => {
  it("2024/01/25: four epochs, the format, the assumption, the own-zone offer", async () => {
    const user = mount();
    await user.type(box(), "2024/01/25");

    expect(one(".epoch-verdict strong")).toBe("Year-first date (Y/M/D)");
    expect(one(".epoch-because")).toBe(
      "No time of day was given, so 00:00:00 is assumed, and no zone was given, so it is read as UTC.",
    );
    expect(rows()).toEqual({
      seconds: "1706140800",
      milliseconds: "1706140800000",
      microseconds: "1706140800000000",
      nanoseconds: "1706140800000000000",
      UTC: "Thu, 25 Jan 2024 · 00:00:00 UTC",
      "ISO 8601": "2024-01-25T00:00:00.000Z",
      "Local · Europe/Paris": "Thu, 25 Jan 2024 · 01:00:00 · UTC+01:00",
      Relative: "2 years ago",
      // Paris was on CET (+01:00) that January, so midnight there is an hour earlier.
      "Or, read in Europe/Paris — seconds": "1706137200",
    });
  });

  it("a string that carries its own offset gets no own-zone offer and no assumption", async () => {
    const user = mount();
    await user.type(box(), "2026-06-15T07:12:34Z");

    expect(one(".epoch-verdict strong")).toBe("ISO 8601 date and time");
    expect(one(".epoch-because")).toBe("");
    expect(screen.queryByTestId("epoch-alt")).toBeNull();
    expect(rows().seconds).toBe("1781507554");
    expect(rows().UTC).toBe("Mon, 15 Jun 2026 · 07:12:34 UTC");
    expect(rows().Relative).toBe("7 months ago");
  });

  it("the own-zone offer is skipped when the platform cannot resolve the zone", async () => {
    const user = mount("Not/AZone");
    await user.type(box(), "2024/01/25");

    // The reading itself still lands (viewInstant degrades to UTC)…
    expect(rows().seconds).toBe("1706140800");
    expect(rows()["Local · UTC"]).toBe("Thu, 25 Jan 2024 · 00:00:00 · UTC");
    // …but there is no alternative to offer, so none is invented.
    expect(screen.queryByTestId("epoch-alt")).toBeNull();
  });

  it("“now” resolves against the injected clock, and says what it assumed", async () => {
    const user = mount();
    await user.type(box(), "now");

    expect(one(".epoch-verdict strong")).toBe("Keyword “now”");
    expect(one(".epoch-because")).toBe(
      "“now” is the clock this window was given, not anything in the text; an instant is the same instant in every zone, so no zone was assumed.",
    );
    expect(rows().seconds).toBe("1800000000");
    expect(rows().UTC).toBe("Fri, 15 Jan 2027 · 08:00:00 UTC");
    expect(rows().Relative).toBe("just now");
    expect(screen.queryByTestId("epoch-alt")).toBeNull();
  });

  it("an ambiguous date renders BOTH readings with equal weight, and says why", async () => {
    const user = mount();
    await user.type(box(), "05/06/2010");

    expect(one(".epoch-ambiguity")).toBe(
      "Nothing in “05/06/2010” says whether 5 is the day or the month, so both readings are shown — day-first first, because most of the world writes it that way.",
    );

    const readings = document.querySelectorAll(".epoch-reading");
    expect(readings).toHaveLength(2);

    expect(one(".epoch-verdict strong", readings[0])).toBe("Day-first date (D/M/Y)");
    expect(rows(readings[0]).seconds).toBe("1275696000");
    expect(rows(readings[0]).UTC).toBe("Sat, 05 Jun 2010 · 00:00:00 UTC");

    expect(one(".epoch-verdict strong", readings[1])).toBe("Month-first date (M/D/Y)");
    expect(rows(readings[1]).seconds).toBe("1273104000");
    expect(rows(readings[1]).UTC).toBe("Thu, 06 May 2010 · 00:00:00 UTC");

    // Equal weight means the same rows in both, not a headline plus a footnote.
    expect(Object.keys(rows(readings[0]))).toEqual(Object.keys(rows(readings[1])));
  });
});

describe("EpochTool — input it cannot read", () => {
  it("says what WOULD have worked, calmly, in an alert", async () => {
    const user = mount();
    await user.type(box(), "hello");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Not a number, and not a date shape I know. Try an epoch (1700000000), an ISO timestamp (2023-11-14T22:13:20Z), a plain date (2024/01/25 or 25 Jan 2024), or “now”.",
    );
    expect(screen.queryByTestId("epoch-result")).toBeNull();
  });

  it("a date-SHAPED string that is not a real date gets its own reason", async () => {
    const user = mount();
    await user.type(box(), "2010-02-30");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "February 2010 has 28 days, and this says 30.",
    );
  });
});

describe("EpochTool — the controls", () => {
  it("clicking the now row fills the box and converts it", async () => {
    const user = mount();

    await user.click(nowButton("1800000000"));

    expect(box().value).toBe("1800000000");
    expect(rows().UTC).toBe("Fri, 15 Jan 2027 · 08:00:00 UTC");
    expect(rows().Relative).toBe("just now");
  });

  it("the clear button appears with input, empties it, and disappears again", async () => {
    const user = mount();
    await user.type(box(), "1700000000");
    expect(screen.getByTestId("epoch-result")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Clear the input"));

    expect(box().value).toBe("");
    expect(screen.queryByTestId("epoch-result")).toBeNull();
    expect(screen.queryByLabelText("Clear the input")).toBeNull();
    expect(one(".epoch-hint")).not.toBe("");
  });

  it("copies each value under its own aria-label", async () => {
    const user = mount();
    // AFTER `mount`: `userEvent.setup()` installs its own `navigator.clipboard` stub, so a
    // spy defined before it is silently replaced (this test failed exactly that way once).
    const writeText = stubClipboard();
    await user.type(box(), "2024/01/25");

    await user.click(screen.getByLabelText("Copy UTC"));
    expect(writeText).toHaveBeenLastCalledWith("Thu, 25 Jan 2024 · 00:00:00 UTC");

    await user.click(screen.getByLabelText("Copy seconds"));
    expect(writeText).toHaveBeenLastCalledWith("1706140800");

    await user.click(screen.getByLabelText("Copy seconds read in Europe/Paris"));
    expect(writeText).toHaveBeenLastCalledWith("1706137200");

    await user.click(screen.getByLabelText("Copy the current epoch"));
    expect(writeText).toHaveBeenLastCalledWith("1800000000");
  });

  it("swallows a clipboard rejection — a copy never throws out of the click", async () => {
    const user = mount();
    const writeText = stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));

    await user.click(screen.getByLabelText("Copy the current epoch"));

    await expect(writeText.mock.results[0].value).rejects.toThrow("denied");
  });

  it("copying is a no-op when the platform has no clipboard", async () => {
    const user = mount();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    await expect(
      user.click(screen.getByLabelText("Copy the current epoch")),
    ).resolves.toBeUndefined();
    expect(nowButton("1800000000")).toBeInTheDocument();
  });
});

describe("EpochTool — the live clock", () => {
  it("re-reads the clock once a second, and clears the interval on unmount", () => {
    vi.useFakeTimers();
    try {
      let ms = NOW;
      const { unmount } = render(<EpochTool clock={() => ms} timeZone={PARIS} />);

      expect(nowButton("1800000000")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);

      ms = NOW + 5_000;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(nowButton("1800000005")).toBeInTheDocument();

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the relative line moves with the clock, so it is never stale", () => {
    vi.useFakeTimers();
    try {
      let ms = 1_700_000_000_000;
      render(<EpochTool clock={() => ms} timeZone={PARIS} />);
      act(() => {
        nowButton("1700000000").click();
      });
      expect(rows().Relative).toBe("just now");

      ms += 3 * 3_600_000;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(rows().Relative).toBe("3 hours ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hostTimeZone", () => {
  it("returns the platform's own IANA id when it has one", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Tokyo",
    } as Intl.ResolvedDateTimeFormatOptions);

    expect(hostTimeZone()).toBe("Asia/Tokyo");
    vi.restoreAllMocks();
  });

  it("falls back to UTC when the platform will not name a zone", () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");

    resolved.mockReturnValue({
      timeZone: undefined,
    } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(hostTimeZone()).toBe("UTC");

    resolved.mockReturnValue({ timeZone: "" } as Intl.ResolvedDateTimeFormatOptions);
    expect(hostTimeZone()).toBe("UTC");

    vi.restoreAllMocks();
  });
});
