/** Only `./usageStore` is mocked (it owns the IPC seam and a live poll); `./usageFormat` is pure
 * and real, so assertions are on the string a user reads. Fixture times avoid bucket boundaries. */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeUsageError } from "./usageFormat";
import type { UsageErrorCode, UsageSnapshot, UsageWindow } from "./usageTypes";
import { UsageLimits } from "./UsageLimits";

/* ── the store double ─────────────────────────────────────────────────────── */

interface FakeState {
  snapshot: UsageSnapshot | null;
  error: UsageErrorCode | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const mocks = vi.hoisted(() => {
  const stop = vi.fn();
  const refresh = vi.fn(() => Promise.resolve());
  const startUsagePolling = vi.fn(() => stop);
  return { stop, refresh, startUsagePolling, state: {} as FakeState };
});

vi.mock("./usageStore", () => ({
  USAGE_POLL_MS: 5000,
  // Selector semantics only — the component never needs reactivity from the
  // store itself (the fixtures are set before render).
  useUsageStore: (select: (s: FakeState) => unknown) => select(mocks.state),
  startUsagePolling: mocks.startUsagePolling,
}));

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A window with sane defaults; override only what a test is about. */
function win(over: Partial<UsageWindow> = {}): UsageWindow {
  return { key: "five_hour", label: "Current session", usedPct: 24, resetsAtMs: null, ...over };
}

function snap(windows: UsageWindow[], fetchedAtMs = Date.now()): UsageSnapshot {
  return { windows, fetchedAtMs };
}

/** The three windows a real account reports, in Rust's order. Reset times carry a +30 s cushion
 * (load-bearing): the countdown truncates, so a time exactly on a boundary flakes. */
function threeWindows(now = Date.now()): UsageWindow[] {
  return [
    win({ key: "five_hour", label: "Current session", usedPct: 24, resetsAtMs: now + 4 * HOUR + 34 * MINUTE + 30_000 }),
    win({ key: "seven_day", label: "All models", usedPct: 63, resetsAtMs: now + 3 * HOUR + 30_000 }),
    win({ key: "seven_day_fable", label: "Fable", usedPct: 96, resetsAtMs: null }),
  ];
}

const chips = () => screen.getAllByTestId("usage-chip");
const rows = () => screen.getAllByTestId("usage-row");
const labelsInOrder = () => rows().map((r) => r.querySelector(".usage__label")?.textContent);
const refreshButton = () => screen.getByRole("button", { name: "Refresh usage limits" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { snapshot: null, error: null, loading: false, refresh: mocks.refresh };
});

// Only the clock tests install fake timers; this makes leaking them impossible.
afterEach(() => {
  vi.useRealTimers();
});

/* ── polling lifecycle ────────────────────────────────────────────────────── */

describe("UsageLimits — auto-refresh lifecycle", () => {
  it("starts the store's polling on mount and stops it on unmount", () => {
    const { unmount } = render(<UsageLimits />);
    expect(mocks.startUsagePolling).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();

    unmount();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    // Mount does not re-arm the poller behind the store's back.
    expect(mocks.startUsagePolling).toHaveBeenCalledTimes(1);
  });

  it("owns no FETCH timer of its own — only the display clock", () => {
    vi.useFakeTimers();
    mocks.state.snapshot = snap(threeWindows());
    const { unmount } = render(<UsageLimits />);

    // Exactly one: the 30s clock tick. The data cadence belongs to the (mocked)
    // store, so if this ever becomes 2 the component has grown its own poller.
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("advances its display clock, so the relative times stay true on screen", () => {
    vi.useFakeTimers();
    const now = Date.now();
    mocks.state.snapshot = snap(threeWindows(now), now);
    render(<UsageLimits />);

    // Focus (not hover — userEvent and fake timers do not mix) opens the tooltip.
    act(() => chips()[0].focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 34 min");
    expect(screen.getByTestId("usage-updated")).toHaveTextContent("Updated just now");

    // One tick later both strings have moved, without any new snapshot arriving.
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByTestId("usage-updated")).toHaveTextContent("Updated 30s ago");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 34 min");

    // …and the countdown itself ticks down once a whole minute has passed.
    act(() => void vi.advanceTimersByTime(2 * MINUTE));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 32 min");
    expect(screen.getByTestId("usage-updated")).toHaveTextContent("Updated 2 min ago");
  });
});

/* ── rows ─────────────────────────────────────────────────────────────────── */

describe("UsageLimits — rows", () => {
  it("renders one row per window, in the order given, with the labels from the data", () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    expect(rows()).toHaveLength(3);
    expect(labelsInOrder()).toEqual(["Current session", "All models", "Fable"]);
    expect(rows().map((r) => r.getAttribute("data-usage-key"))).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
    expect(chips().map((c) => c.textContent)).toEqual(["24% used", "63% used", "96% used"]);
  });

  it("renders whatever windows arrive — not three, and not a known key set", () => {
    mocks.state.snapshot = snap([
      win({ key: "seven_day_sonnet_9", label: "Sonnet 9", usedPct: 7, resetsAtMs: null }),
      win({ key: "five_hour", label: "Current session", usedPct: 12, resetsAtMs: null }),
    ]);
    render(<UsageLimits />);

    // Two rows, weekly-first because that is the order the data came in.
    expect(rows()).toHaveLength(2);
    expect(labelsInOrder()).toEqual(["Sonnet 9", "Current session"]);
    expect(screen.getByText("7% used")).toBeInTheDocument();
  });
});

/* ── tone bands ───────────────────────────────────────────────────────────── */

describe("UsageLimits — tone bands (thresholds: <60 ok, 60+ warn, 90+ danger)", () => {
  it.each([
    [0, "ok"],
    [24, "ok"],
    [59.9, "ok"],
    [60, "warn"],
    [75, "warn"],
    [89.9, "warn"],
    [90, "danger"],
    [100, "danger"],
  ])("paints %s%% as %s", (usedPct, tone) => {
    mocks.state.snapshot = snap([win({ usedPct })]);
    render(<UsageLimits />);
    expect(chips()[0]).toHaveAttribute("data-tone", tone);
  });

  it("takes the tone from the exact value, not the rounded label", () => {
    // 89.9 rounds to "90% used" for the eye, but has NOT crossed the 90 line —
    // so it stays amber. Pinned deliberately: the colour must follow the real
    // number, and this is the one place the two can visibly disagree.
    mocks.state.snapshot = snap([win({ usedPct: 89.9 })]);
    render(<UsageLimits />);
    expect(chips()[0]).toHaveTextContent("90% used");
    expect(chips()[0]).toHaveAttribute("data-tone", "warn");
  });

  it("gives each band its own chip, so three windows can differ at once", () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);
    expect(chips().map((c) => c.getAttribute("data-tone"))).toEqual(["ok", "warn", "danger"]);
  });

  it("renders no progress bar (the number is the only signal)", () => {
    mocks.state.snapshot = snap(threeWindows());
    const { container } = render(<UsageLimits />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    expect(container.querySelector('[class*="bar"]')).toBeNull();
  });
});

/* ── the refresh button ───────────────────────────────────────────────────── */

describe("UsageLimits — refresh button", () => {
  it("calls the store's refresh() on click", async () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    expect(refreshButton()).toBeEnabled();
    await userEvent.setup().click(refreshButton());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("is disabled and spinning while a fetch is in flight, and recovers after", () => {
    mocks.state.loading = true;
    const { rerender } = render(<UsageLimits />);

    const busy = refreshButton();
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.className).toContain("usage__refresh--busy");

    mocks.state.loading = false;
    rerender(<UsageLimits />);
    expect(refreshButton()).toBeEnabled();
    expect(refreshButton()).toHaveAttribute("aria-busy", "false");
    expect(refreshButton().className).not.toContain("usage__refresh--busy");
  });

  it("is reachable by its accessible name in every state (including the error state)", () => {
    mocks.state.error = "cli-failed";
    render(<UsageLimits />);
    expect(refreshButton()).toBeInTheDocument();
  });
});

/* ── the four states ──────────────────────────────────────────────────────── */

describe("UsageLimits — states", () => {
  it("no snapshot yet: a placeholder, never a zero", () => {
    mocks.state.loading = true;
    render(<UsageLimits />);

    expect(screen.getByTestId("usage-placeholder")).toHaveTextContent("Reading usage…");
    expect(screen.queryAllByTestId("usage-row")).toEqual([]);
    expect(screen.queryByText(/0% used/)).toBeNull();
    expect(screen.queryByTestId("usage-updated")).toBeNull();
    expect(screen.queryByTestId("usage-stale")).toBeNull();
  });

  // Routing, not wording: expected and actual share a source, so this pins only that the panel
  // renders the code it was given; the sentences are pinned as literals in `usageFormat.test.ts`.
  it("no snapshot + error: the actionable sentence for that code, and no numbers", () => {
    mocks.state.error = "not-signed-in";
    render(<UsageLimits />);

    expect(screen.getByTestId("usage-error")).toHaveTextContent(describeUsageError("not-signed-in"));
    // Not a generic string — the sentence names the CLI and the exact command that
    // fixes it, which is the whole next move (the IDE cannot sign anyone in).
    expect(screen.getByRole("status")).toHaveTextContent(/claude CLI/);
    expect(screen.getByRole("status")).toHaveTextContent(/claude auth login/);
    expect(screen.queryAllByTestId("usage-row")).toEqual([]);
    expect(screen.queryByTestId("usage-placeholder")).toBeNull();
  });

  it("passes the store's code through, so a different failure reads differently", () => {
    mocks.state.error = "timeout";
    const { rerender } = render(<UsageLimits />);
    const timedOut = screen.getByTestId("usage-error").textContent;
    expect(timedOut).toBe(describeUsageError("timeout"));

    mocks.state.error = "cli-missing";
    rerender(<UsageLimits />);
    expect(screen.getByTestId("usage-error").textContent).toBe(describeUsageError("cli-missing"));
    expect(screen.getByTestId("usage-error").textContent).not.toBe(timedOut);
  });

  it("snapshot + error: keeps the numbers AND marks them stale", () => {
    mocks.state.snapshot = snap(threeWindows());
    mocks.state.error = "cli-failed";
    render(<UsageLimits />);

    // The numbers survive a failed refresh.
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("24% used")).toBeInTheDocument();

    // …but they are not passed off as live.
    const stale = screen.getByTestId("usage-stale");
    expect(stale).toHaveTextContent("stale");
    expect(screen.getByLabelText("Last refresh failed — showing the last good reading")).toBe(stale);
    expect(screen.getByTestId("usage-panel").className).toContain("usage--stale");
    expect(screen.queryByTestId("usage-updated")).toBeNull();
    // And it is a marker, not an error state — the error sentence stays away.
    expect(screen.queryByTestId("usage-error")).toBeNull();
  });

  it("snapshot only: shows the freshness of the reading, no stale marker", () => {
    mocks.state.snapshot = snap(threeWindows(), Date.now() - 3 * MINUTE);
    render(<UsageLimits />);

    expect(screen.getByTestId("usage-updated")).toHaveTextContent("Updated 3 min ago");
    expect(screen.queryByTestId("usage-stale")).toBeNull();
    expect(screen.getByTestId("usage-panel").className).not.toContain("usage--stale");
  });

  it("a just-taken reading reads as fresh", () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);
    expect(screen.getByTestId("usage-updated")).toHaveTextContent("Updated just now");
  });
});

/* ── the reset tooltip ────────────────────────────────────────────────────── */

describe("UsageLimits — reset time on hover/focus", () => {
  it("reveals the reset time on hover and hides it again on leave", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(chips()[0]);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Resets in 4 hr 34 min");
    // Linked, so a screen reader gets it as the chip's description.
    expect(chips()[0]).toHaveAttribute("aria-describedby", tip.id);

    await user.unhover(chips()[0]);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(chips()[0]).not.toHaveAttribute("aria-describedby");
  });

  it("shows only one tooltip at a time when the pointer moves between chips", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    await user.hover(chips()[0]);
    await user.hover(chips()[1]);
    const open = screen.getAllByRole("tooltip");
    expect(open).toHaveLength(1);
    expect(open[0]).toHaveTextContent("Resets in 3 hr");
  });

  it("is keyboard reachable: Tab focuses a chip and reveals its reset time", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    await user.tab(); // the refresh button
    expect(refreshButton()).toHaveFocus();
    await user.tab(); // the first chip
    expect(chips()[0]).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 34 min");
  });

  it("hides the tooltip on blur", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    await user.tab();
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 34 min");

    await user.tab(); // on to the next chip — the first one blurs
    expect(chips()[1]).toHaveFocus();
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 3 hr");
  });

  it("dismisses the tooltip with Escape without losing focus", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    await user.tab();
    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(chips()[0]).toHaveFocus();
  });

  it("leaves the tooltip open for any other key", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    await user.tab();
    await user.tab();
    await user.keyboard("a");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resets in 4 hr 34 min");
  });

  it("a window with no reset time gets no tooltip and no tab stop", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snap([win({ key: "seven_day", label: "All models", usedPct: 63, resetsAtMs: null })]);
    render(<UsageLimits />);

    const chip = chips()[0];
    // Nothing to reveal → no focus stop that would reveal nothing.
    expect(chip).not.toHaveAttribute("tabindex");
    expect(chip).not.toHaveAttribute("aria-describedby");

    await user.hover(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The number itself is unaffected.
    expect(chip).toHaveTextContent("63% used");

    await user.tab();
    expect(refreshButton()).toHaveFocus();
    await user.tab();
    expect(chip).not.toHaveFocus();
  });
});

/* ── accessible names ─────────────────────────────────────────────────────── */

describe("UsageLimits — accessible names", () => {
  it("names the panel, each chip (with its window) and the button", () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);

    expect(screen.getByRole("region", { name: "Usage limits" })).toBe(screen.getByTestId("usage-panel"));
    // The chip carries its window's name, so tabbing straight to it still says
    // WHICH limit the number belongs to.
    expect(screen.getByLabelText("Current session: 24% used")).toBe(chips()[0]);
    expect(screen.getByLabelText("All models: 63% used")).toBe(chips()[1]);
    expect(screen.getByLabelText("Fable: 96% used")).toBe(chips()[2]);
    expect(refreshButton()).toHaveAttribute("aria-label", "Refresh usage limits");
  });

  it("keeps the visible chip text short — the aria-label carries the context", () => {
    mocks.state.snapshot = snap(threeWindows());
    render(<UsageLimits />);
    expect(chips()[0].textContent).toBe("24% used");
  });
});
