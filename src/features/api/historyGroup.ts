/**
 * historyGroup — the pure shaping logic behind the API History panel's
 * "first N flat, then day groups, and a search that ignores both" behaviour.
 *
 * The history of executed requests looked short. Entries after the first 10 are
 * grouped into expandable days, and a search finds them; search results are not
 * grouped by day, only sorted by day.
 *
 * The log itself is uncapped and persisted (`recordApiHistory` in the store,
 * `history_store.rs` on disk) — nothing here drops an entry. This module only
 * decides what the panel *shows first*: the newest slice stays flat so the panel
 * still reads at a glance, and everything older collapses into per-day
 * disclosures the user opens on demand.
 *
 * Two invariants this file exists to hold:
 *
 * 1. **`now` is injected, never `Date.now()`.** A "Today" label that reads the
 *    wall clock is untestable by construction — the test would have to compute
 *    its own expectation the same way the code does or flake at
 *    midnight. Every caller passes the clock in.
 * 2. **Days are LOCAL calendar days.** A key sliced off `toISOString()` is UTC,
 *    which files a 23:30 request under tomorrow for anyone west of Greenwich.
 *    `getFullYear/getMonth/getDate` is the only correct source.
 *
 * Every label is also **locale-free and deterministic** — the house rule stated
 * at `features/sessions/sessionModel.ts`: `toLocaleString`/`toLocaleDateString`
 * output varies with the machine's ICU build and locale, so text formatted
 * through them can only be asserted by a test that formats it the same way,
 * which is no assertion at all. The month/weekday tables below are the same
 * shape `formatSessionDate` uses; they are copied rather than imported so the
 * API feature does not take a dependency on the sessions feature.
 *
 * Ordering is newest-first (by `at`) everywhere, with ties left in their
 * original relative order — the sort is stable, so two requests stamped in the
 * same millisecond keep the order the caller handed them in. The store keeps
 * the log in APPEND order (oldest first), so a caller wanting the newest of a
 * millisecond tie first should hand these functions the reversed log.
 */

import type { HistoryEntry } from "./historyIpc";

/** One local calendar day's worth of entries, newest first. */
export interface DayGroup {
  /** Local calendar day, `"YYYY-MM-DD"` — the stable identity for expansion state. */
  key: string;
  /** Human label for the disclosure header (`"Today"`, `"Mon, Aug 18"`, …). */
  label: string;
  entries: HistoryEntry[];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The LOCAL calendar day an epoch-ms timestamp falls on, as `"YYYY-MM-DD"`.
 *
 * Deliberately not `new Date(at).toISOString().slice(0, 10)`: that is UTC, and
 * a late-evening request in a negative-offset zone would be filed under the
 * next day (and an early-morning one in a positive-offset zone under the
 * previous day).
 */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Whole days between two LOCAL calendar days (b - a), ignoring clock time.
 *
 * The local Y/M/D parts are re-projected through `Date.UTC` purely to get a
 * DST-free arithmetic space: subtracting two local midnights directly is off by
 * an hour across a DST transition, which would make a 23-hour "yesterday" round
 * to 0 and label itself "Today".
 */
function calendarDaysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return (dayB - dayA) / 86_400_000;
}

/**
 * The disclosure header's label for a day, relative to `now`:
 * `"Today"`, `"Yesterday"`, `"Mon, Aug 18"` (same calendar year), or
 * `"Aug 18, 2025"` (any other year).
 *
 * Fixed English month/weekday names rather than `toLocaleDateString`: the
 * label is asserted verbatim in tests, and a locale-dependent string would make
 * those assertions depend on the machine's ICU data.
 */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const delta = calendarDaysBetween(d, today);
  if (delta === 0) return "Today";
  if (delta === 1) return "Yesterday";
  const month = MONTHS[d.getMonth()];
  if (d.getFullYear() === today.getFullYear()) {
    return `${WEEKDAYS[d.getDay()]}, ${month} ${d.getDate()}`;
  }
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * A row's timestamp: `"Aug 25, 14:02"`, gaining the year only when it is not
 * `now`'s (`"Aug 18 2025, 14:02"`).
 *
 * Same shape as the session picker's `formatSessionDate`, and locale-free for
 * the same reason: this replaced a bare `toLocaleString()`, whose output no
 * test could assert without re-deriving it.
 */
export function timeLabel(at: number, now: number): string {
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${hh}:${mm}`;
}

/**
 * Does this entry match the user's search box?
 *
 * Case-insensitive substring, over — and this list IS the contract a user's
 * expectations rest on:
 *
 * - `url`
 * - `method`
 * - `status` (as typed: `"404"` finds a 404; a null status matches nothing here)
 * - `statusText`
 * - `error`
 * - `grpcService`
 * - `body`
 * - every header **name** and every header **value**
 *
 * A blank or whitespace-only query matches everything (an empty box is not a
 * filter). Note that header values keep their literal `{{VAR}}` placeholders
 * so searching finds the template, never a resolved secret.
 */
export function matchesQuery(entry: HistoryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const fields: (string | null | undefined)[] = [
    entry.url,
    entry.method,
    entry.status === null ? null : String(entry.status),
    entry.statusText,
    entry.error,
    entry.grpcService,
    entry.body,
  ];
  for (const f of fields) {
    if (typeof f === "string" && f.toLowerCase().includes(needle)) return true;
  }
  for (const h of entry.headers) {
    if (h.name.toLowerCase().includes(needle)) return true;
    if (h.value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Newest first; ties keep their input order (Array#sort is stable). */
function newestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.at - a.at);
}

/**
 * The SEARCH view: every match, newest first, flat.
 *
 * No day grouping and no "recent" split — search results are sorted by day but
 * not grouped by it. When you are hunting for one request,
 * a disclosure you have to open first is an obstacle, not structure.
 */
export function searchHistory(
  entries: HistoryEntry[],
  query: string,
): HistoryEntry[] {
  return newestFirst(entries.filter((e) => matchesQuery(e, query)));
}

/**
 * The DEFAULT view: the newest `recentCount` entries flat (the panel still
 * looks the way it always did at a glance), everything older bucketed into
 * local-calendar-day groups, newest day first.
 *
 * A day that is *partly* consumed by the flat block still gets a group — one
 * holding only its **remaining** entries, with a count that says so. No entry
 * ever appears both flat and in a group; the split is exactly at index
 * `recentCount` of the newest-first order. With `entries.length <= recentCount`
 * there are no groups at all.
 */
export function partitionHistory(
  entries: HistoryEntry[],
  recentCount: number,
  now: number,
): { recent: HistoryEntry[]; groups: DayGroup[] } {
  const ordered = newestFirst(entries);
  const cut = Math.max(0, recentCount);
  const recent = ordered.slice(0, cut);
  const rest = ordered.slice(cut);

  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const e of rest) {
    const key = dayKey(e.at);
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, label: dayLabel(e.at, now), entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(e);
  }
  // `rest` is already newest-first, so first-seen order IS newest-day-first.
  return { recent, groups };
}
