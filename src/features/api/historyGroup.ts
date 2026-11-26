/** Shapes what the History panel shows first; the log itself is uncapped. now is injected, days
 * are LOCAL calendar days, labels are locale-free (rule in sessions/sessionModel.ts). Newest first,
 * stable on ties; the store keeps append order, so pass it reversed for newest-first ties. */

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

/** Not toISOString(): that is UTC and files a late-evening request under the wrong day. */
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

/** Local Y/M/D re-projected via Date.UTC for DST-free arithmetic; otherwise a 23-hour
 * "yesterday" rounds to 0 and reads "Today". */
function calendarDaysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return (dayB - dayA) / 86_400_000;
}

/** "Today", "Yesterday", "Mon, Aug 18" (same year) or "Aug 18, 2025". Fixed English names, so
 * tests can assert the label verbatim. */
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

/** "Aug 25, 14:02", with the year only when not now's ("Aug 18 2025, 14:02"). Locale-free. */
export function timeLabel(at: number, now: number): string {
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${hh}:${mm}`;
}

/** Case-insensitive substring over url, method, status (as typed), statusText, error, grpcService,
 * body and every header name and value: the user-facing contract. A blank query matches all;
 * header values keep literal {{VAR}}, so search never finds a resolved secret. */
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

/** Search view: every match, newest first, flat (no day groups, no recent split). */
export function searchHistory(
  entries: HistoryEntry[],
  query: string,
): HistoryEntry[] {
  return newestFirst(entries.filter((e) => matchesQuery(e, query)));
}

/** Default view: the newest recentCount flat, the rest in local-day groups, newest first. A day
 * split by the flat block gets a group of only its remaining entries; no entry appears twice. */
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
