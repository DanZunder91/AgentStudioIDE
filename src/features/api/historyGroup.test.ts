/**
 * historyGroup — the pure shaping logic behind the History panel's
 * recent/day-group split and its search.
 *
 * Two deliberate test-construction rules here, both so no expectation is derived from
 * the code under test:
 *
 * - **Timestamps are built with `new Date(y, m, d, h, min).getTime()`, never a
 *   hard-coded epoch integer.** A literal epoch pins a UTC instant, so the
 *   local calendar day it lands on — the thing under test — would change with
 *   the machine's timezone. Constructing from local parts makes "23:55 on
 *   Aug 24, wherever you are" mean exactly that everywhere.
 * - **Expected labels are written out literally** (`"Mon, Aug 24"`), never
 *   derived by calling a formatter. An expectation computed the way the code
 *   computes it proves only plumbing, never values.
 *
 * `now` is injected into every label assertion, so nothing here depends on the
 * wall clock and "Today" cannot flake at midnight.
 */

import { describe, expect, it } from "vitest";

import {
  dayKey,
  dayLabel,
  matchesQuery,
  partitionHistory,
  searchHistory,
  timeLabel,
} from "./historyGroup";
import type { HistoryEntry } from "./historyIpc";

/** Local wall-clock instant → epoch ms. Month is 0-based, as `Date` wants. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

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
  at: at(2026, 8, 25, 10, 0),
  ...over,
});

/** `n` entries, one minute apart, descending from `start` — newest is index 0. */
const series = (n: number, start: number, prefix = "e"): HistoryEntry[] =>
  Array.from({ length: n }, (_, i) =>
    entry({ id: `${prefix}${i}`, at: start - i * 60_000 }),
  );

describe("dayKey", () => {
  it("uses the LOCAL calendar day, so a late-evening request stays on its own day", () => {
    // 23:55 and 00:05 straddle local midnight — different days, always.
    expect(dayKey(at(2026, 8, 24, 23, 55))).toBe("2026-08-24");
    expect(dayKey(at(2026, 8, 25, 0, 5))).toBe("2026-08-25");
  });

  it("zero-pads month and day", () => {
    expect(dayKey(at(2026, 1, 3, 9, 0))).toBe("2026-01-03");
    expect(dayKey(at(2026, 12, 31, 9, 0))).toBe("2026-12-31");
  });

  it("gives every instant within one local day the same key", () => {
    expect(dayKey(at(2026, 8, 18, 0, 0))).toBe("2026-08-18");
    expect(dayKey(at(2026, 8, 18, 23, 59))).toBe("2026-08-18");
  });
});

describe("dayLabel", () => {
  const now = at(2026, 8, 25, 14, 30); // Tue Aug 25 2026, mid-afternoon.

  it("labels the current calendar day Today, even at either edge of it", () => {
    expect(dayLabel(at(2026, 8, 25, 0, 1), now)).toBe("Today");
    expect(dayLabel(at(2026, 8, 25, 23, 59), now)).toBe("Today");
  });

  it("labels the previous calendar day Yesterday — a clock-hours diff would not", () => {
    // 20 minutes earlier than `now` in clock time, but the day before it.
    expect(dayLabel(at(2026, 8, 24, 14, 10), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 8, 24, 23, 59), now)).toBe("Yesterday");
  });

  it("uses weekday + month + date for an older day in the same year", () => {
    expect(dayLabel(at(2026, 8, 24, 12, 0), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 8, 20, 12, 0), now)).toBe("Thu, Aug 20");
    expect(dayLabel(at(2026, 8, 18, 12, 0), now)).toBe("Tue, Aug 18");
    expect(dayLabel(at(2026, 1, 3, 12, 0), now)).toBe("Sat, Jan 3");
  });

  it("adds the year — and drops the weekday — for a different year", () => {
    expect(dayLabel(at(2025, 8, 18, 12, 0), now)).toBe("Aug 18, 2025");
    expect(dayLabel(at(2024, 12, 31, 12, 0), now)).toBe("Dec 31, 2024");
  });

  it("labels a FUTURE-stamped entry by date, never Yesterday", () => {
    // A clock-skewed machine can stamp an entry ahead of `now`; the delta is
    // then negative and must not fall through into the relative labels.
    expect(dayLabel(at(2026, 8, 26, 9, 0), now)).toBe("Wed, Aug 26");
  });

  it("is driven entirely by the injected now — the same instant relabels", () => {
    const t = at(2026, 8, 18, 12, 0);
    expect(dayLabel(t, at(2026, 8, 18, 23, 0))).toBe("Today");
    expect(dayLabel(t, at(2026, 8, 19, 1, 0))).toBe("Yesterday");
    expect(dayLabel(t, at(2026, 8, 25, 1, 0))).toBe("Tue, Aug 18");
  });
});

describe("timeLabel", () => {
  const now = at(2026, 8, 25, 14, 30);

  it("shows month, date and a zero-padded 24h clock for the current year", () => {
    expect(timeLabel(at(2026, 8, 25, 14, 2), now)).toBe("Aug 25, 14:02");
    expect(timeLabel(at(2026, 1, 3, 9, 5), now)).toBe("Jan 3, 09:05");
    expect(timeLabel(at(2026, 12, 31, 23, 59), now)).toBe("Dec 31, 23:59");
  });

  it("adds the year only when it is not now's", () => {
    expect(timeLabel(at(2025, 8, 18, 14, 2), now)).toBe("Aug 18 2025, 14:02");
    expect(timeLabel(at(2027, 2, 1, 0, 0), now)).toBe("Feb 1 2027, 00:00");
  });
});

describe("matchesQuery", () => {
  const e = entry({
    method: "POST",
    url: "https://api.test/orders",
    headers: [
      { name: "X-Trace", value: "abc-123" },
      { name: "Content-Type", value: "application/json" },
    ],
    body: '{"sku":"WIDGET-9"}',
    status: 404,
    statusText: "Not Found",
    error: null,
  });

  it("matches on the url", () => {
    expect(matchesQuery(e, "orders")).toBe(true);
  });

  it("matches on the method", () => {
    expect(matchesQuery(e, "post")).toBe(true);
  });

  it("matches on the status typed as digits", () => {
    expect(matchesQuery(e, "404")).toBe(true);
    expect(matchesQuery(e, "500")).toBe(false);
  });

  it("matches on the status text", () => {
    expect(matchesQuery(e, "not found")).toBe(true);
  });

  it("matches on the error message of a failed entry", () => {
    const failed = entry({ status: null, error: "dns error: nope", statusText: null });
    expect(matchesQuery(failed, "dns")).toBe(true);
  });

  it("matches on the gRPC service FQN", () => {
    const grpc = entry({
      protocol: "grpc",
      grpcService: "helloworld.Greeter",
      method: "SayHello",
    });
    expect(matchesQuery(grpc, "greeter")).toBe(true);
  });

  it("matches on the body", () => {
    expect(matchesQuery(e, "widget-9")).toBe(true);
  });

  it("matches on a header NAME", () => {
    expect(matchesQuery(e, "x-trace")).toBe(true);
  });

  it("matches on a header VALUE", () => {
    expect(matchesQuery(e, "abc-123")).toBe(true);
  });

  it("is case-insensitive in both directions", () => {
    expect(matchesQuery(e, "ORDERS")).toBe(true);
    expect(matchesQuery(e, "Content-TYPE")).toBe(true);
  });

  it("treats a blank or whitespace-only query as no filter at all", () => {
    expect(matchesQuery(e, "")).toBe(true);
    expect(matchesQuery(e, "   ")).toBe(true);
  });

  it("trims the query before matching", () => {
    expect(matchesQuery(e, "  orders  ")).toBe(true);
  });

  it("returns false when nothing contains the needle", () => {
    expect(matchesQuery(e, "zzzz-nope")).toBe(false);
  });

  it("does not match a null status against the string 'null'", () => {
    const failed = entry({ status: null, statusText: null, error: "boom" });
    expect(matchesQuery(failed, "null")).toBe(false);
  });
});

describe("searchHistory", () => {
  it("returns every match, newest first, regardless of input order", () => {
    const a = entry({ id: "a", url: "https://api.test/orders", at: at(2026, 8, 18, 9, 0) });
    const b = entry({ id: "b", url: "https://api.test/orders", at: at(2026, 8, 25, 9, 0) });
    const c = entry({ id: "c", url: "https://api.test/users", at: at(2026, 8, 20, 9, 0) });
    expect(searchHistory([a, b, c], "orders").map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("ignores the 10-recent split entirely — a match 30 entries deep is returned", () => {
    const bulk = series(30, at(2026, 8, 25, 12, 0));
    const buried = entry({ id: "needle", url: "https://api.test/deep", at: at(2020, 1, 1, 9, 0) });
    const found = searchHistory([...bulk, buried], "deep");
    expect(found.map((e) => e.id)).toEqual(["needle"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchHistory(series(5, at(2026, 8, 25, 12, 0)), "zzzz-nope")).toEqual([]);
  });

  it("returns everything, newest first, for a blank query", () => {
    const all = series(4, at(2026, 8, 25, 12, 0));
    expect(searchHistory(all, "").map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3"]);
  });

  it("does not mutate the input array's order", () => {
    const input = [
      entry({ id: "old", at: at(2026, 8, 18, 9, 0) }),
      entry({ id: "new", at: at(2026, 8, 25, 9, 0) }),
    ];
    searchHistory(input, "");
    expect(input.map((e) => e.id)).toEqual(["old", "new"]);
  });

  it("breaks a same-millisecond tie by keeping input order (a stable sort)", () => {
    const t = at(2026, 8, 25, 9, 0);
    const tied = [entry({ id: "first", at: t }), entry({ id: "second", at: t })];
    expect(searchHistory(tied, "").map((e) => e.id)).toEqual(["first", "second"]);
  });
});

describe("partitionHistory", () => {
  const now = at(2026, 8, 25, 18, 0);

  it("keeps everything flat, with no groups at all, below the recent count", () => {
    const { recent, groups } = partitionHistory(series(9, at(2026, 8, 25, 12, 0)), 10, now);
    expect(recent).toHaveLength(9);
    expect(groups).toEqual([]);
  });

  it("keeps exactly the recent count flat and groups the 11th onward", () => {
    // 25 entries on the hour, walking back from 18:00 on Aug 25. `Date`
    // normalises the negative hours, so e0..e18 land on Aug 25 (18:00 → 00:00,
    // 19 entries) and e19..e24 on Aug 24 (23:00 → 18:00, 6 entries).
    const all = Array.from({ length: 25 }, (_, i) =>
      entry({ id: `e${i}`, at: at(2026, 8, 25, 18 - i, 0) }),
    );
    const { recent, groups } = partitionHistory(all, 10, now);

    expect(recent.map((e) => e.id)).toEqual([
      "e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9",
    ]);
    // Aug 25 is PARTLY consumed by the flat block: 19 on the day, 10 flat →
    // the group holds only the remaining 9, and its count says 9, not 19.
    expect(groups.map((g) => ({ key: g.key, label: g.label, n: g.entries.length }))).toEqual([
      { key: "2026-08-25", label: "Today", n: 9 },
      { key: "2026-08-24", label: "Yesterday", n: 6 },
    ]);
    expect(groups[0].entries.map((e) => e.id)).toEqual([
      "e10", "e11", "e12", "e13", "e14", "e15", "e16", "e17", "e18",
    ]);
    expect(groups[1].entries.map((e) => e.id)).toEqual([
      "e19", "e20", "e21", "e22", "e23", "e24",
    ]);
  });

  it("never lists an entry both flat and in a group, and never loses one", () => {
    const all = series(25, at(2026, 8, 25, 12, 0), "x");
    const { recent, groups } = partitionHistory(all, 10, now);
    const flatIds = recent.map((e) => e.id);
    const groupedIds = groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(flatIds.filter((id) => groupedIds.includes(id))).toEqual([]);
    expect(new Set([...flatIds, ...groupedIds]).size).toBe(25);
  });

  it("orders groups newest-day-first and each group's entries newest-first", () => {
    const all = [
      entry({ id: "aug18a", at: at(2026, 8, 18, 9, 0) }),
      entry({ id: "aug18b", at: at(2026, 8, 18, 17, 0) }),
      entry({ id: "aug20", at: at(2026, 8, 20, 9, 0) }),
      entry({ id: "aug24", at: at(2026, 8, 24, 9, 0) }),
    ];
    const { recent, groups } = partitionHistory(all, 0, now);
    expect(recent).toEqual([]);
    expect(groups.map((g) => g.key)).toEqual(["2026-08-24", "2026-08-20", "2026-08-18"]);
    expect(groups[2].entries.map((e) => e.id)).toEqual(["aug18b", "aug18a"]);
  });

  it("splits a local-midnight boundary into two days", () => {
    const all = [
      entry({ id: "late", at: at(2026, 8, 24, 23, 55) }),
      entry({ id: "early", at: at(2026, 8, 25, 0, 5) }),
    ];
    const { groups } = partitionHistory(all, 0, now);
    expect(groups.map((g) => [g.key, g.entries.map((e) => e.id)])).toEqual([
      ["2026-08-25", ["early"]],
      ["2026-08-24", ["late"]],
    ]);
  });

  it("sorts by timestamp, not by input order", () => {
    const all = [
      entry({ id: "middle", at: at(2026, 8, 20, 9, 0) }),
      entry({ id: "newest", at: at(2026, 8, 25, 9, 0) }),
      entry({ id: "oldest", at: at(2026, 8, 18, 9, 0) }),
    ];
    const { recent } = partitionHistory(all, 3, now);
    expect(recent.map((e) => e.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("labels groups off the injected now, so the same log relabels on another day", () => {
    const all = [entry({ id: "a", at: at(2026, 8, 18, 9, 0) })];
    expect(partitionHistory(all, 0, at(2026, 8, 18, 20, 0)).groups[0].label).toBe("Today");
    expect(partitionHistory(all, 0, at(2026, 8, 19, 8, 0)).groups[0].label).toBe("Yesterday");
    expect(partitionHistory(all, 0, at(2026, 8, 25, 8, 0)).groups[0].label).toBe("Tue, Aug 18");
  });

  it("handles an empty log", () => {
    expect(partitionHistory([], 10, now)).toEqual({ recent: [], groups: [] });
  });

  it("treats a negative recent count as zero rather than slicing from the end", () => {
    const all = series(3, at(2026, 8, 25, 12, 0));
    const { recent, groups } = partitionHistory(all, -2, now);
    expect(recent).toEqual([]);
    expect(groups[0].entries).toHaveLength(3);
  });

  it("does not mutate the input array's order", () => {
    const input = [
      entry({ id: "old", at: at(2026, 8, 18, 9, 0) }),
      entry({ id: "new", at: at(2026, 8, 25, 9, 0) }),
    ];
    partitionHistory(input, 1, now);
    expect(input.map((e) => e.id)).toEqual(["old", "new"]);
  });
});
