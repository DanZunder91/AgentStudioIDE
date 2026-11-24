/**
 * HistoryPanel — the right rail's API request history (M6 follow-on).
 *
 * `historyIpc` is mocked at the module boundary (the load crosses Tauri). What's
 * under test is the panel — hydrate-on-mount (+ skip/cancelled guards), the empty
 * state, newest-first rendering, the two-step Clear confirmation, and that clicking
 * an entry OPENS it (mint a request, populate it from the entry, open a tab) WITHOUT
 * sending it.
 *
 * Extended (entries after the first 10 are grouped into expandable days, and
 * there is a search) with the navigation layer: the flat/grouped
 * split, the collapsed-by-default day disclosures, and the search view that drops
 * grouping entirely. The shaping itself is pure and pinned exhaustively in
 * `historyGroup.test.ts`; what these tests own is the SEAM — that the
 * panel actually renders what the pure functions return, that a hidden entry is
 * genuinely absent from the DOM and genuinely appears on expand (two-sided),
 * and that search does not quietly re-scope the destructive Clear action.
 *
 * Timestamps are built from the CURRENT local calendar day (`dayAt`) rather than
 * from literal epoch integers: the panel buckets by local day against the real
 * clock, so a fixture pinned to a UTC instant would land on a different day
 * depending on the machine's timezone.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("./historyIpc", () => historyIpc);
// `execute` is mocked only to prove clicking a row does NOT send.
const execute = vi.hoisted(() => ({ executeHttpRequest: vi.fn() }));
vi.mock("./execute", () => execute);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { CLOCK_TICK_MS, HistoryPanel, RECENT_COUNT } from "./HistoryPanel";
import type { HistoryEntry, HistoryStore } from "./historyIpc";

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "h1",
  method: "GET",
  url: "https://api.test/user",
  headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
  body: "",
  status: 200,
  statusText: "OK",
  durationMs: 5,
  sizeBytes: 9,
  error: null,
  at: 1_700_000_000_000,
  ...over,
});

const emptyLog: HistoryStore = { entries: [] };

/**
 * An instant `daysAgo` local calendar days before today, at a local wall-clock
 * time. Built from local Y/M/D parts so it means the same calendar day in every
 * timezone, and so `Date` normalises the day arithmetic across DST.
 */
const dayAt = (daysAgo: number, hour: number, minute = 0): number => {
  const n = new Date();
  return new Date(
    n.getFullYear(),
    n.getMonth(),
    n.getDate() - daysAgo,
    hour,
    minute,
  ).getTime();
};

/**
 * A log of `n` entries on one day, newest first (`<prefix>0` is newest), handed
 * back in the STORE's order — oldest first, the way `recordApiHistory` appends.
 */
const dayLog = (n: number, daysAgo: number, prefix: string): HistoryEntry[] =>
  Array.from({ length: n }, (_, i) =>
    entry({
      id: `${prefix}${i}`,
      url: `https://api.test/${prefix}${i}`,
      at: dayAt(daysAgo, 0, n - i),
    }),
  ).reverse();

/** 15 entries today + 10 yesterday, in store (oldest-first) order. */
const twentyFive = (): HistoryEntry[] => [
  ...dayLog(10, 1, "y"),
  ...dayLog(15, 0, "t"),
];

const urls = () =>
  screen.getAllByTestId("history-run").map((b) => b.querySelector(".history-item__url")?.textContent);

const renderWithLog = async (entries: HistoryEntry[]) => {
  historyIpc.loadApiHistory.mockResolvedValue({ entries });
  await act(async () => {
    render(<HistoryPanel />);
  });
};

beforeEach(() => {
  resetStore();
  historyIpc.loadApiHistory.mockReset().mockResolvedValue(emptyLog);
  historyIpc.saveApiHistory.mockReset().mockResolvedValue(undefined);
  execute.executeHttpRequest.mockReset();
});

afterEach(() => cleanup());

describe("HistoryPanel", () => {
  it("loads the history once on mount and shows the empty state when there is none", async () => {
    await act(async () => {
      render(<HistoryPanel />);
    });
    expect(historyIpc.loadApiHistory).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().apiHistoryLoaded).toBe(true);
    expect(screen.getByTestId("history-empty")).toBeInTheDocument();
  });

  it("skips the load when history is already hydrated", async () => {
    act(() => useAppStore.getState().apiActions.hydrateApiHistory(emptyLog));
    render(<HistoryPanel />);
    await act(async () => {});
    expect(historyIpc.loadApiHistory).not.toHaveBeenCalled();
  });

  it("renders entries newest-first with method, status, and url", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({
      entries: [
        entry({ id: "old", url: "https://api.test/first" }),
        entry({ id: "new", method: "POST", url: "https://api.test/second", status: 201 }),
      ],
    });
    await act(async () => {
      render(<HistoryPanel />);
    });
    const runs = screen.getAllByTestId("history-run");
    expect(runs).toHaveLength(2);
    // Newest (appended last) is rendered first.
    expect(runs[0].textContent).toContain("https://api.test/second");
    expect(runs[0].textContent).toContain("POST");
    expect(runs[1].textContent).toContain("https://api.test/first");
  });

  it("shows the error label for a failed entry", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({
      entries: [entry({ status: null, error: "dns error: nope" })],
    });
    await act(async () => {
      render(<HistoryPanel />);
    });
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("dns error: nope")).toBeInTheDocument();
  });

  it("OPENS a clicked entry (populates a request tab) WITHOUT sending it", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({
      entries: [entry({ id: "h1", method: "POST", url: "https://api.test/replay", body: "x" })],
    });
    await act(async () => {
      render(<HistoryPanel />);
    });

    act(() => {
      fireEvent.click(screen.getByTestId("history-run"));
    });

    // A new api-request tab was opened, populated from the entry...
    const tabs = Object.values(useAppStore.getState().tabs);
    const apiTab = tabs.find((t) => t.ref.kind === "api-request");
    expect(apiTab).toBeDefined();
    const requestId =
      apiTab && apiTab.ref.kind === "api-request" ? apiTab.ref.requestId : "";
    const req = useAppStore.getState().apiRequests[requestId];
    expect(req).toMatchObject({ method: "POST", url: "https://api.test/replay", body: "x" });
    expect(req.headers[0]).toMatchObject({ name: "Authorization", value: "Bearer {{TOKEN}}" });
    // ...but NOT sent — clicking history shows the request, it doesn't re-fire it.
    expect(execute.executeHttpRequest).not.toHaveBeenCalled();
  });

  it("clears the history only after a confirmation step (never on the first click)", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({
      entries: [entry({ id: "a" }), entry({ id: "b" })],
    });
    await act(async () => {
      render(<HistoryPanel />);
    });
    expect(screen.getAllByTestId("history-run")).toHaveLength(2);

    // First click asks to confirm — it does NOT clear yet.
    act(() => {
      fireEvent.click(screen.getByTestId("history-clear"));
    });
    const confirm = screen.getByTestId("history-clear-confirm");
    expect(confirm).toBeInTheDocument();
    expect(confirm.textContent).toContain("Clear all 2 requests?"); // plural
    expect(useAppStore.getState().apiHistory).toHaveLength(2); // still there

    // Cancel backs out, leaving history intact.
    act(() => {
      fireEvent.click(screen.getByTestId("history-clear-cancel"));
    });
    expect(useAppStore.getState().apiHistory).toHaveLength(2);
    expect(screen.getByTestId("history-clear")).toBeInTheDocument();

    // Confirm actually clears.
    act(() => {
      fireEvent.click(screen.getByTestId("history-clear"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("history-clear-confirm-yes"));
    });
    expect(useAppStore.getState().apiHistory).toEqual([]);
    expect(screen.getByTestId("history-empty")).toBeInTheDocument();
  });

  it("uses the singular in the confirm prompt for a single entry", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({ entries: [entry()] });
    await act(async () => {
      render(<HistoryPanel />);
    });
    act(() => {
      fireEvent.click(screen.getByTestId("history-clear"));
    });
    expect(screen.getByTestId("history-clear-confirm").textContent).toContain(
      "Clear all 1 request?",
    );
  });

  it("renders a deterministic, locale-free row timestamp", async () => {
    // A fixed local wall-clock instant in a year that is not the current one, so
    // the year branch is exercised and the expectation can be written literally
    // (a `toLocaleString` label could only be asserted by re-deriving it).
    await renderWithLog([entry({ at: new Date(2020, 0, 3, 9, 5).getTime() })]);
    expect(screen.getByText("Jan 3 2020, 09:05")).toBeInTheDocument();
  });

  describe("first 10 flat, then collapsed day groups", () => {
    it("keeps the flat block at the required size", () => {
      // Written literally, not derived from the constant: the
      // number 10 is the requirement, so silently changing it must go red.
      expect(RECENT_COUNT).toBe(10);
    });

    it("shows only the newest 10 flat and keeps the rest OUT of the DOM until expanded", async () => {
      await renderWithLog(twentyFive());

      // Exactly 10 rows, and they are the 10 newest.
      expect(screen.getAllByTestId("history-run")).toHaveLength(10);
      expect(urls()).toEqual([
        "https://api.test/t0",
        "https://api.test/t1",
        "https://api.test/t2",
        "https://api.test/t3",
        "https://api.test/t4",
        "https://api.test/t5",
        "https://api.test/t6",
        "https://api.test/t7",
        "https://api.test/t8",
        "https://api.test/t9",
      ]);

      // The remaining 15 are behind two collapsed day headers, and the partly
      // consumed day counts only what is left of it (15 today - 10 flat = 5).
      const days = screen.getAllByTestId("history-day");
      expect(days).toHaveLength(2);
      expect(days[0].textContent).toContain("Today · 5");
      expect(days[1].textContent).toContain("Yesterday · 10");
      expect(days[0]).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("history-day-body")).not.toBeInTheDocument();

      // Two-sided: absent BEFORE...
      expect(screen.queryByText("https://api.test/t10")).not.toBeInTheDocument();
      expect(screen.queryByText("https://api.test/y0")).not.toBeInTheDocument();

      // ...and present AFTER clicking that day's header — and only that day's.
      act(() => {
        fireEvent.click(days[0]);
      });
      expect(screen.getByText("https://api.test/t10")).toBeInTheDocument();
      expect(screen.getByText("https://api.test/t14")).toBeInTheDocument();
      expect(screen.getAllByTestId("history-run")).toHaveLength(15);
      expect(screen.getAllByTestId("history-day")[0]).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      // The OTHER day stayed shut — expansion is per day, not global.
      expect(screen.queryByText("https://api.test/y0")).not.toBeInTheDocument();

      // Clicking again collapses it back.
      act(() => {
        fireEvent.click(screen.getAllByTestId("history-day")[0]);
      });
      expect(screen.queryByText("https://api.test/t10")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("history-run")).toHaveLength(10);
    });

    it("expands a second day independently of the first", async () => {
      await renderWithLog(twentyFive());
      act(() => {
        fireEvent.click(screen.getAllByTestId("history-day")[1]);
      });
      expect(screen.getByText("https://api.test/y0")).toBeInTheDocument();
      expect(screen.queryByText("https://api.test/t10")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("history-run")).toHaveLength(20);
    });

    it("shows no day headers at all when the whole log fits in the flat block", async () => {
      await renderWithLog(dayLog(9, 0, "t"));
      expect(screen.getAllByTestId("history-run")).toHaveLength(9);
      expect(screen.queryAllByTestId("history-day")).toHaveLength(0);
    });

    it("OPENS a row that lives inside an expanded day group", async () => {
      await renderWithLog(twentyFive());
      act(() => {
        fireEvent.click(screen.getAllByTestId("history-day")[1]);
      });
      const grouped = screen
        .getAllByTestId("history-run")
        .find((b) => b.textContent?.includes("https://api.test/y3"));
      expect(grouped).toBeDefined();
      act(() => {
        fireEvent.click(grouped as HTMLElement);
      });

      const apiTab = Object.values(useAppStore.getState().tabs).find(
        (t) => t.ref.kind === "api-request",
      );
      expect(apiTab).toBeDefined();
      const requestId =
        apiTab && apiTab.ref.kind === "api-request" ? apiTab.ref.requestId : "";
      expect(useAppStore.getState().apiRequests[requestId].url).toBe(
        "https://api.test/y3",
      );
      expect(execute.executeHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    const search = () => screen.getByTestId("history-search");
    const type = (value: string) => {
      act(() => {
        fireEvent.change(search(), { target: { value } });
      });
    };

    it("flattens to matches only — no day headers, no 10-entry split", async () => {
      await renderWithLog(twentyFive());
      type("y1"); // matches y1 and y10..y19 — here only y1 exists.

      expect(screen.queryAllByTestId("history-day")).toHaveLength(0);
      expect(screen.getByTestId("history-search-count").textContent).toBe("1 match");
      expect(urls()).toEqual(["https://api.test/y1"]);
    });

    it("reaches entries that the default view had hidden behind a collapsed day", async () => {
      await renderWithLog(twentyFive());
      // y0 is 20 entries deep and collapsed by default...
      expect(screen.queryByText("https://api.test/y0")).not.toBeInTheDocument();
      type("y0");
      // ...and search finds it with no expanding at all.
      expect(screen.getByText("https://api.test/y0")).toBeInTheDocument();
    });

    it("counts matches, with the plural, the singular, and the empty case", async () => {
      await renderWithLog(twentyFive());

      type("api.test/t1"); // t1, t10..t14 → 6
      expect(screen.getByTestId("history-search-count").textContent).toBe("6 matches");

      type("api.test/t14");
      expect(screen.getByTestId("history-search-count").textContent).toBe("1 match");

      type("zzz-no-such-request");
      expect(screen.getByTestId("history-search-count").textContent).toBe("No matches");
      expect(screen.queryAllByTestId("history-run")).toHaveLength(0);
      // A filtered-to-nothing view is NOT the empty-log state.
      expect(screen.queryByTestId("history-empty")).not.toBeInTheDocument();
    });

    it("sorts matches newest-first across days", async () => {
      await renderWithLog([
        entry({ id: "a", url: "https://api.test/orders/1", at: dayAt(3, 9) }),
        entry({ id: "b", url: "https://api.test/users", at: dayAt(2, 9) }),
        entry({ id: "c", url: "https://api.test/orders/2", at: dayAt(1, 9) }),
      ]);
      type("orders");
      expect(urls()).toEqual([
        "https://api.test/orders/2",
        "https://api.test/orders/1",
      ]);
    });

    it("matches a header value, not just the url", async () => {
      await renderWithLog([
        entry({ id: "a", url: "https://api.test/one" }),
        entry({
          id: "b",
          url: "https://api.test/two",
          headers: [{ name: "X-Trace", value: "abc-123" }],
        }),
      ]);
      type("abc-123");
      expect(urls()).toEqual(["https://api.test/two"]);
    });

    it("restores the grouped view when the search is cleared with the clear button", async () => {
      await renderWithLog(twentyFive());
      expect(screen.queryByTestId("history-search-clear")).not.toBeInTheDocument();

      type("api.test/t14");
      expect(screen.queryAllByTestId("history-day")).toHaveLength(0);

      act(() => {
        fireEvent.click(screen.getByTestId("history-search-clear"));
      });
      expect((search() as HTMLInputElement).value).toBe("");
      expect(screen.queryByTestId("history-search-count")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("history-run")).toHaveLength(10);
      expect(screen.getAllByTestId("history-day")).toHaveLength(2);
    });

    it("treats a whitespace-only query as no search at all", async () => {
      await renderWithLog(twentyFive());
      type("   ");
      expect(screen.queryByTestId("history-search-count")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("history-day")).toHaveLength(2);
    });

    it("keeps the Clear-history confirm scoped to the WHOLE log while a search is active", async () => {
      await renderWithLog(twentyFive());
      type("api.test/t14"); // one match on screen...
      expect(screen.getAllByTestId("history-run")).toHaveLength(1);

      act(() => {
        fireEvent.click(screen.getByTestId("history-clear"));
      });
      // ...but Clear all is not scoped by the search box.
      expect(screen.getByTestId("history-clear-confirm").textContent).toContain(
        "Clear all 25 requests?",
      );
      act(() => {
        fireEvent.click(screen.getByTestId("history-clear-confirm-yes"));
      });
      expect(useAppStore.getState().apiHistory).toEqual([]);
      expect(screen.getByTestId("history-empty")).toBeInTheDocument();
    });
  });

  it("re-reads the clock, so a panel left open across midnight relabels its days", async () => {
    // The one place the panel's own clock is observable. Fake timers move
    // `Date.now()` AND fire the tick, so a single advance reproduces "the app was
    // left open past midnight" exactly — 23:59 + 2 minutes = 00:01 the next day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 25, 23, 59));
      // 12 entries on Aug 25 → 10 flat + a 2-entry day group, which is the only
      // thing on screen that carries a day LABEL.
      const at = (minute: number) => new Date(2026, 7, 25, 10, minute).getTime();
      historyIpc.loadApiHistory.mockResolvedValue({
        entries: Array.from({ length: 12 }, (_, i) =>
          entry({ id: `e${i}`, url: `https://api.test/e${i}`, at: at(i) }),
        ),
      });
      await act(async () => {
        render(<HistoryPanel />);
      });
      expect(screen.getByTestId("history-day").textContent).toContain("Today · 2");

      await act(async () => {
        vi.advanceTimersByTime(2 * CLOCK_TICK_MS);
      });
      expect(screen.getByTestId("history-day").textContent).toContain("Yesterday · 2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a late load resolve after unmount (cancelled guard)", async () => {
    let resolveLoad: (s: HistoryStore) => void = () => {};
    historyIpc.loadApiHistory.mockReturnValue(
      new Promise<HistoryStore>((r) => {
        resolveLoad = r;
      }),
    );
    const { unmount } = render(<HistoryPanel />);
    unmount();
    await act(async () => {
      resolveLoad({ entries: [entry()] });
    });
    // The resolve landed after unmount → it must NOT hydrate the store.
    expect(useAppStore.getState().apiHistoryLoaded).toBe(false);
  });
});
