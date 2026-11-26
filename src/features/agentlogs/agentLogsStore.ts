/** The UI's copy of the Rust log ring plus view state; module-level so it survives remounts.
 * Ingest: subscribe FIRST, hold batches until `logstream_snapshot` resolves, then replay keeping
 * ids `> lastId`. `lastId` survives Clear (Rust ids keep rising, so nothing resurrects). */

import { create } from "zustand";

import { resetProcsStore } from "../procs/procsStore";

import {
  LOG_CAP,
  SYSLOG_POLL_MS,
  type LogLevel,
  type LogLine,
  type RunningApp,
  type SyslogFilter,
  type SyslogStatus,
} from "./agentLogsTypes";
import { applySourcePick, type LogFilter } from "./agentLogsFormat";
import { stepCursor } from "./agentLogsFind";
import {
  logstreamClear,
  logstreamSnapshot,
  onLogstreamLines,
  syslogApps,
  syslogSet,
  syslogStatus,
} from "./logstreamIpc";

/** Sources sidebar width: default wide enough for `probe.mjs · project` + its tag; clamped. */
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 560;
export function clampSidebarWidth(w: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w)));
}

export type ConnStatus = "idle" | "loading" | "ready" | "error";

/** The ⌘F bar; lives here, not in `findBars`, because it reads and writes this store's folds.
 * `null` IS the closed state: Esc forgets the query, as every house bar does. */
export interface LogsFind {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** The current match's ordinal — clamped by the panel against the live match list. */
  cursor: number;
  /** What is searched: the stream, or the detail drawer (⌘F pressed inside the drawer). */
  scope: "list" | "detail";
  /** Blocks folded/unfolded by hand while the bar is open: find stops overriding them. */
  touched: Record<string, true>;
  /** Bumped only by gestures that should scroll to the current match (query, toggle, step), so
   * new lines never yank the list back to a match the reader left. */
  seq: number;
}

export interface AgentLogsState {
  lines: LogLine[];
  /** Highest id ever ingested this app run (never reset by Clear). */
  lastId: number;
  paused: boolean;
  /** Lines that arrived while paused — shown on resume. */
  pending: LogLine[];
  status: ConnStatus;
  /** Why the stream could not be read (snapshot / subscribe failure). */
  error: string | null;
  /** Why the last Clear failed. */
  clearError: string | null;
  filter: LogFilter;
  follow: boolean;
  /** `lastId` at the moment follow was switched off — rows above it are "new". */
  followMark: number;
  expandedId: number | null;

  /* ── system apps ── */
  /** The last `syslog_status` / `syslog_set` answer; null until the first one lands. */
  syslog: SyslogStatus | null;
  /** The filter SENT and not yet answered, shown so a click reads as taken while Rust restarts
   * `log stream`. Null when nothing is in flight. */
  syslogPending: SyslogFilter | null;
  /** Why the last status read failed (cleared by the next successful read). */
  syslogError: string | null;
  /** Why the last `syslog_set` failed; apart from `syslogError` so the 2 s poll cannot wipe it. */
  applyError: string | null;
  /** `syslog_apps` — what the app picker offers. */
  apps: RunningApp[];
  appsLoading: boolean;
  appsError: string | null;
  /** The one-time "All apps is high volume" note is showing. */
  volumeNotice: boolean;

  /* ── the Sources sidebar ── */
  /** The sidebar is open (default) — remembered across tab switches. */
  sidebarOpen: boolean;
  /** The Sources sidebar width in px (drag its edge; app names are long). */
  sidebarWidth: number;
  /** Stopped sources the user dismissed → their last line id then; a newer line brings it back. */
  runningDismissed: Record<string, number>;

  /* ── command blocks ── */
  /** Explicit expand/collapse per block key (`toolUseId`); absent = automatic (collapsed unless a
   * query hits hidden output). In the store so tab switches and pane moves keep it. */
  expandedBlocks: Record<string, boolean>;

  /* ── error navigation ── */
  /** A sidebar error badge click (or ↑/↓); the panel, which knows row offsets, resolves it. */
  jumpRequest: { source: string; step: "first" | "next" | "prev"; seq: number } | null;
  /** The error row the last jump landed on: highlighted, and the base for ↑/↓. */
  errorCursor: { source: string; lineId: number } | null;

  ingest(batch: readonly LogLine[]): void;
  setQuery(query: string): void;
  toggleLevel(level: LogLevel): void;
  setIde(on: boolean): void;
  /** Apply an `AppPicker` change over the sources seen so far. */
  setSourcePick(sources: readonly string[], next: string[] | null): void;
  setFollow(on: boolean): void;
  setPaused(on: boolean): void;
  toggleExpanded(id: number): void;
  /** Close the detail drawer (Esc, ✕, or its row leaving the filtered view). */
  closeDetail(): void;
  clear(): Promise<void>;
  /** Merge `patch` over the active filter and send it with `syslog_set`. */
  setSyslogFilter(patch: Partial<SyslogFilter>): Promise<void>;
  refreshSyslogStatus(): Promise<void>;
  refreshApps(): Promise<void>;
  dismissVolumeNotice(): void;
  setSidebarOpen(open: boolean): void;
  setSidebarWidth(width: number): void;
  dismissRunning(source: string, lastId: number): void;
  /** Sidebar row click: show ONLY `source`, or all sources if it already is the only one. */
  toggleOnlySource(source: string): void;
  /** Show ONLY `source` (a block header's stream link). Not `setSourcePick(sources, [source])`:
   * with two sources that becomes an exclusion, not a solo. */
  soloSource(source: string): void;
  /** Show ONLY these sources (a dev app's row). An EMPTY list is kept: it shows nothing, as an
   * app with no stream yet must. */
  soloSources(sources: readonly string[]): void;
  /** "show N more" / "show less" on a block. */
  setBlockExpanded(key: string, expanded: boolean): void;
  /** Jump to `source`'s first error or step from the cursor: narrows to that source, turns Error
   * on, stops follow; the panel scrolls after re-render. */
  requestErrorJump(source: string, step: "first" | "next" | "prev"): void;
  /** The panel landed (or found nothing to land on): record the cursor, drop the request. */
  resolveErrorJump(cursor: { source: string; lineId: number } | null): void;

  /* ── ⌘F find ── */
  find: LogsFind | null;
  /** ⌘F: open the bar in `scope` or refocus it. A CHANGED `seed` (selection) replaces the query at
   * match 0; null or the same text keeps query and place. A scope change restarts at 0. */
  openFind(scope: "list" | "detail", seed: string | null): void;
  setFindQuery(query: string): void;
  toggleFindCase(): void;
  toggleFindRegex(): void;
  /** ▲▼ / Enter / Shift+Enter over `total` matches, wrapping. */
  stepFind(delta: number, total: number): void;
  closeFind(): void;
}

export const defaultFilter = (): LogFilter => ({
  query: "",
  levels: { error: true, warn: true, info: true, debug: true },
  ide: true,
  hiddenSources: [],
  onlySources: null,
});

const initialData = () => ({
  lines: [] as LogLine[],
  lastId: 0,
  paused: false,
  pending: [] as LogLine[],
  status: "idle" as ConnStatus,
  error: null as string | null,
  clearError: null as string | null,
  filter: defaultFilter(),
  follow: true,
  followMark: 0,
  expandedId: null as number | null,
  syslog: null as SyslogStatus | null,
  syslogPending: null as SyslogFilter | null,
  syslogError: null as string | null,
  applyError: null as string | null,
  apps: [] as RunningApp[],
  appsLoading: false,
  appsError: null as string | null,
  volumeNotice: false,
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  runningDismissed: {} as Record<string, number>,
  expandedBlocks: {} as Record<string, boolean>,
  jumpRequest: null as AgentLogsState["jumpRequest"],
  errorCursor: null as AgentLogsState["errorCursor"],
  find: null as LogsFind | null,
});

/* Status requests take tickets; an answer older than the newest shown is dropped, so a poll
 * answering just after a click cannot snap the controls back. */
let syslogTicket = 0;
let syslogShown = 0;
/** Applies only: the newest one owns `syslogPending` and `applyError`. */
let applySeq = 0;
/** The "All apps is high volume" note shows once per app run, not once per click. */
let volumeWarned = false;
/** Every error jump is a fresh request, even to the same source and step. */
let jumpSeq = 0;
/** Every reveal-worthy find gesture gets a fresh number (`LogsFind.seq`). */
let findSeq = 0;

/** True when `f` streams every app on the machine. */
const isAllApps = (f: SyslogFilter): boolean => f.enabled && f.apps === null;

/** Keep the newest `LOG_CAP` lines. */
const capped = (lines: LogLine[]): LogLine[] =>
  lines.length > LOG_CAP ? lines.slice(lines.length - LOG_CAP) : lines;

export const useAgentLogsStore = create<AgentLogsState>()((set, get) => ({
  ...initialData(),

  ingest: (batch) => {
    // Sorted copy, then a strictly-increasing walk from `lastId`: that one pass is the
    // dedupe (a replayed line, a duplicate inside the batch, a snapshot overlapping
    // an event) and the ordering guarantee both.
    const sorted = [...batch].sort((a, b) => a.id - b.id);
    let last = get().lastId;
    const fresh: LogLine[] = [];
    for (const line of sorted) {
      if (line.id <= last) continue;
      fresh.push(line);
      last = line.id;
    }
    if (fresh.length === 0) return;
    set((s) =>
      s.paused
        ? { lastId: last, pending: capped([...s.pending, ...fresh]) }
        : { lastId: last, lines: capped([...s.lines, ...fresh]) },
    );
  },

  setQuery: (query) => set((s) => ({ filter: { ...s.filter, query } })),
  toggleLevel: (level) =>
    set((s) => ({
      filter: { ...s.filter, levels: { ...s.filter.levels, [level]: !s.filter.levels[level] } },
    })),
  setIde: (on) => set((s) => ({ filter: { ...s.filter, ide: on } })),
  setSourcePick: (sources, next) =>
    set((s) => ({ filter: { ...s.filter, ...applySourcePick(s.filter, sources, next) } })),

  setFollow: (on) => set((s) => (on ? { follow: true } : { follow: false, followMark: s.lastId })),

  setPaused: (on) =>
    set((s) => {
      if (on) return { paused: true };
      return { paused: false, pending: [], lines: capped([...s.lines, ...s.pending]) };
    }),

  toggleExpanded: (id) => set((s) => ({ expandedId: s.expandedId === id ? null : id })),
  closeDetail: () => set({ expandedId: null }),

  clear: async () => {
    // Everything ingested up to NOW is what the user asked to clear; a batch that lands
    // while the command is in flight is newer than the click and must survive it.
    const mark = get().lastId;
    try {
      await logstreamClear();
    } catch (e) {
      set({ clearError: `Could not clear the log: ${String(e)}` });
      return;
    }
    set((s) => ({
      lines: s.lines.filter((l) => l.id > mark),
      pending: s.pending.filter((l) => l.id > mark),
      expandedId: null,
      clearError: null,
      followMark: Math.max(s.followMark, mark),
    }));
  },

  setSyslogFilter: async (patch) => {
    const s = get();
    if (s.syslog === null) return;
    // Compose over what was last SENT, so two quick changes do not undo each other.
    const base = s.syslogPending ?? s.syslog.filter;
    const next: SyslogFilter = { ...base, ...patch };
    const warn = !volumeWarned && isAllApps(next) && !isAllApps(base);
    if (warn) volumeWarned = true;
    const ticket = ++syslogTicket;
    const apply = ++applySeq;
    set(warn ? { syslogPending: next, volumeNotice: true } : { syslogPending: next });
    try {
      const status = await syslogSet(next);
      const fresh = ticket > syslogShown;
      if (fresh) syslogShown = ticket;
      set({
        ...(fresh ? { syslog: status } : {}),
        ...(apply === applySeq ? { syslogPending: null, applyError: null } : {}),
      });
    } catch (e) {
      // Only the newest apply speaks: an older failure is superseded by what was sent after it.
      if (apply !== applySeq) return;
      set({ syslogPending: null, applyError: `Could not apply the log sources: ${String(e)}` });
    }
  },

  refreshSyslogStatus: async () => {
    const ticket = ++syslogTicket;
    try {
      const status = await syslogStatus();
      if (ticket < syslogShown) return;
      syslogShown = ticket;
      set({ syslog: status, syslogError: null });
    } catch (e) {
      set({ syslogError: `Could not read the system log status: ${String(e)}` });
    }
  },

  refreshApps: async () => {
    set({ appsLoading: true });
    try {
      set({ apps: await syslogApps(), appsLoading: false, appsError: null });
    } catch (e) {
      set({ appsLoading: false, appsError: `Could not list running apps: ${String(e)}` });
    }
  },

  dismissVolumeNotice: () => set({ volumeNotice: false }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (w) => set({ sidebarWidth: clampSidebarWidth(w) }),
  dismissRunning: (source, lastId) =>
    set((s) => ({ runningDismissed: { ...s.runningDismissed, [source]: lastId } })),
  toggleOnlySource: (source) =>
    set((s) => {
      const only = s.filter.onlySources;
      const solo = only !== null && only.length === 1 && only[0] === source;
      return {
        filter: { ...s.filter, hiddenSources: [], onlySources: solo ? null : [source] },
      };
    }),
  soloSource: (source) => set((s) => ({ filter: { ...s.filter, hiddenSources: [], onlySources: [source] } })),
  soloSources: (sources) => set((s) => ({ filter: { ...s.filter, hiddenSources: [], onlySources: [...sources] } })),
  setBlockExpanded: (key, expanded) =>
    set((s) => ({
      expandedBlocks: { ...s.expandedBlocks, [key]: expanded },
      // A hand fold while the bar is open is the user's call, not find's (see `LogsFind.touched`).
      ...(s.find === null ? {} : { find: { ...s.find, touched: { ...s.find.touched, [key]: true as const } } }),
    })),
  requestErrorJump: (source, step) =>
    set((s) => ({
      filter: {
        ...s.filter,
        levels: { ...s.filter.levels, error: true },
        hiddenSources: [],
        onlySources: [source],
      },
      follow: false,
      followMark: s.lastId,
      jumpRequest: { source, step, seq: ++jumpSeq },
    })),
  resolveErrorJump: (cursor) => set({ jumpRequest: null, errorCursor: cursor }),

  openFind: (scope, seed) =>
    set((s) => {
      const f = s.find;
      if (f === null) {
        return {
          find: { query: seed ?? "", caseSensitive: false, regex: false, cursor: 0, scope, touched: {}, seq: ++findSeq },
        };
      }
      const query = seed ?? f.query;
      if (query === f.query && scope === f.scope) return {};
      return { find: { ...f, query, scope, cursor: 0, seq: ++findSeq } };
    }),
  setFindQuery: (query) =>
    set((s) => (s.find === null ? {} : { find: { ...s.find, query, cursor: 0, seq: ++findSeq } })),
  toggleFindCase: () =>
    set((s) => (s.find === null ? {} : { find: { ...s.find, caseSensitive: !s.find.caseSensitive, cursor: 0, seq: ++findSeq } })),
  toggleFindRegex: () =>
    set((s) => (s.find === null ? {} : { find: { ...s.find, regex: !s.find.regex, cursor: 0, seq: ++findSeq } })),
  stepFind: (delta, total) =>
    set((s) =>
      s.find === null || total === 0
        ? {}
        : { find: { ...s.find, cursor: stepCursor(s.find.cursor, delta, total), seq: ++findSeq } },
    ),
  closeFind: () => set({ find: null }),
}));

/* ───────────────────────── the subscription ───────────────────────── */

let refs = 0;
let disconnect: (() => void) | null = null;

/** One connection: subscribe, then snapshot, then replay what arrived in between. */
function connect(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let early: LogLine[][] | null = [];
  const { ingest } = useAgentLogsStore.getState();

  const flushEarly = () => {
    for (const b of early as LogLine[][]) ingest(b);
    early = null;
  };

  useAgentLogsStore.setState({ status: "loading", error: null });
  onLogstreamLines((batch) => {
    if (disposed) return;
    if (early) early.push(batch);
    else ingest(batch);
  })
    .then((un) => {
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      return logstreamSnapshot().then((snap) => {
        if (disposed) return;
        ingest(snap);
        flushEarly();
        useAgentLogsStore.setState({ status: "ready" });
      });
    })
    .catch((e: unknown) => {
      if (disposed) return;
      // A failed snapshot still leaves a live subscription when `listen` worked, so
      // whatever arrived meanwhile is shown rather than held forever.
      flushEarly();
      useAgentLogsStore.setState({
        status: "error",
        error: `Could not read the log stream: ${String(e)}`,
      });
    });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Start (or join) the live stream; ref-counted. Returns an idempotent release (the last one
 * unsubscribes). */
export function startLogstream(): () => void {
  refs += 1;
  if (refs === 1) disconnect = connect();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs -= 1;
    if (refs === 0) {
      (disconnect as () => void)();
      disconnect = null;
    }
  };
}

/** Re-connect after a failure (the error banner's Retry). A no-op with no subscriber. */
export function retryLogstream(): void {
  if (!disconnect) return;
  disconnect();
  disconnect = connect();
}

/* ───────────────────────── the status poll ───────────────────────── */

let pollRefs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Poll `syslog_status` every `SYSLOG_POLL_MS` while a panel is mounted (rate, running, reason).
 * Ref-counted like `startLogstream`; the last release stops the timer. */
export function startSyslogPoll(): () => void {
  pollRefs += 1;
  if (pollRefs === 1) {
    const tick = () => void useAgentLogsStore.getState().refreshSyslogStatus();
    tick();
    pollTimer = setInterval(tick, SYSLOG_POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pollRefs -= 1;
    if (pollRefs === 0) {
      clearInterval(pollTimer as ReturnType<typeof setInterval>);
      pollTimer = null;
    }
  };
}

/** Test-only: drop all state and any live connection. */
export function resetAgentLogsForTests(): void {
  disconnect?.();
  disconnect = null;
  refs = 0;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  pollRefs = 0;
  syslogTicket = 0;
  syslogShown = 0;
  applySeq = 0;
  volumeWarned = false;
  jumpSeq = 0;
  findSeq = 0;
  useAgentLogsStore.setState(initialData());
  // The Logs view hosts the dev-apps section and card, so its reset forgets their store
  // (and their poll) too — every Logs test starts from "no app selected, nothing polled".
  resetProcsStore();
}
