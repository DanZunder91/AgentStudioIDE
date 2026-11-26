/** Diagnostics log in its own zustand store, so the bridge appends via `getState()` without
 * touching app reducers. A ring buffer capped at {@link LOG_CAP}; `filterEntries` defines
 * "visible" for both the panel and Copy. */

import { create } from "zustand";

import type { AgentEvent } from "../../app/types";

/** Severity of a log line — drives the level chip + the level filter. */
export type LogLevel = "info" | "event" | "warn" | "error";

/** The level filter's value: a specific level, or "all" (no level narrowing). */
export type LevelFilter = LogLevel | "all";

/** One diagnostics-log line. `id` is monotonic; `ts` is `Date.now()` at append. */
export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
}

/** Hard cap on retained entries — the ring buffer drops the oldest past this. */
export const LOG_CAP = 1000;

interface LogStore {
  entries: LogEntry[];
  visible: boolean;
  levelFilter: LevelFilter;
  textFilter: string;
  /** The next id to stamp — monotonic across the session (survives `clear`). */
  nextId: number;

  append: (entry: Omit<LogEntry, "id" | "ts">) => void;
  clear: () => void;
  show: () => void;
  hide: () => void;
  toggle: () => void;
  setLevelFilter: (level: LevelFilter) => void;
  setTextFilter: (text: string) => void;
}

export const useLogStore = create<LogStore>()((set) => ({
  entries: [],
  visible: false,
  levelFilter: "all",
  textFilter: "",
  nextId: 0,

  append: (entry) =>
    set((s) => {
      const id = s.nextId;
      const next = [...s.entries, { ...entry, id, ts: Date.now() }];
      // Ring buffer: drop the oldest once we pass the cap.
      if (next.length > LOG_CAP) next.splice(0, next.length - LOG_CAP);
      return { entries: next, nextId: id + 1 };
    }),

  clear: () => set({ entries: [] }),
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
  toggle: () => set((s) => ({ visible: !s.visible })),
  setLevelFilter: (level) => set({ levelFilter: level }),
  setTextFilter: (text) => set({ textFilter: text }),
}));

/** Level + case-insensitive text filter over source/message/detail; the panel and "Copy" both
 * use it, so they never diverge. */
export function filterEntries(
  entries: LogEntry[],
  level: LevelFilter,
  text: string,
): LogEntry[] {
  const q = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (level !== "all" && e.level !== level) return false;
    if (q && !`${e.source} ${e.message} ${e.detail ?? ""}`.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

/* ── module-level convenience API ─────────────────────────────────────────────
   So non-React code (the bridge) can log without hooks — `getState().append`. */

const appendAt =
  (level: LogLevel) =>
  (source: string, message: string, detail?: string): void =>
    useLogStore.getState().append({ level, source, message, detail });

export const logInfo = appendAt("info");
export const logEvent = appendAt("event");
export const logWarn = appendAt("warn");
export const logError = appendAt("error");

/** One telemetry event as a log line, so the status stream is visible. Status and lifecycle lines
 * are `event`; activity/title are `info`. Keyed by agent id (stable across renames), not name. */
export function logAgentEvent(e: AgentEvent): void {
  switch (e.t) {
    case "agent_started":
      logEvent("agent", `${e.agentId} started`, `title="${e.title}" cwd=${e.cwd} runtime=${e.runtime}`);
      return;
    case "subagent_spawned":
      logEvent("agent", `${e.childAgentId} spawned under ${e.parentId}`, `title="${e.title}" cwd=${e.cwd}`);
      return;
    case "status":
      logEvent("agent", `${e.agentId} → ${e.status}`);
      return;
    case "exited":
      logEvent("agent", `${e.agentId} exited`, `code=${e.code}`);
      return;
    case "activity":
      logInfo("agent", `${e.agentId} activity`, `at=${e.at}`);
      return;
    case "title":
      logInfo("agent", `${e.agentId} title → ${e.title}`);
      return;
  }
}

/** Format a timestamp as `HH:MM:SS.mmm` for the log row + the copied text. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, len = 2): string => String(n).padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One entry as a single text line, used by "Copy" (and readable in a diff). */
export function formatEntry(e: LogEntry): string {
  const head = `${formatTime(e.ts)} [${e.level.toUpperCase()}] ${e.source} ${e.message}`;
  return e.detail ? `${head} — ${e.detail}` : head;
}
