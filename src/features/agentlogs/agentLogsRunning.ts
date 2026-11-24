/**
 * Agent Logs → the Sources sidebar, the pure half (the logs of running apps must be easy to
 * find, and which apps are running must be easy to see; one log stream per
 * thing — the Running strip grew into a sidebar grouped Services / Terminals / Agents / Mac
 * apps).
 *
 * Everything here is derived from the log lines alone — no fleet store, no extra IPC — so
 * the sidebar can never disagree with the stream under it. One entry per SOURCE label (the
 * same key the Source picker and the row's source cell use), because "show only that
 * source" is what a click on a row does.
 *
 * What makes a source live, by the wire texts Rust emits (they are the contract):
 *   - background task — `system` `background task started · <program> (<id>)` → running,
 *     `background task stopped · <program> (<id>) — <reason>` → stopped with that reason
 *     (`logstream/tasks.rs` `STARTED_PREFIX`/`STOPPED_PREFIX`). `task` lines with no start
 *     seen (it scrolled out of the ring, or was cleared) still mean it is running.
 *   - IDE terminal — `terminal opened · …` → running, `terminal exited …` /
 *     `terminal closed` → stopped. A source seen with `output` and no lifecycle is running.
 *   - agent — `agent started · …` / `sub-agent started…` → running; `agent exited …`,
 *     `agent session ended`, `sub-agent finished|failed` → stopped. Tool calls with no
 *     lifecycle seen mean it is running.
 *   - Mac app — a `machine` source, listed only while the system-apps stream is on.
 *   - dev app's log — `system` `app log started · <source>` → running, `app log stopped ·
 *     <source> — <reason>` → stopped (`logstream/apps.rs` `APP_STARTED_PREFIX`/`APP_STOPPED_PREFIX`).
 *     `app` lines with no start seen mean it is running. Listed whatever the system-apps switch
 *     says: the user started this stream by hand from an app's card.
 *
 * A root agent and its terminal share one label (`claude · gazelle`), so they are one
 * chip; the LAST lifecycle event decides whether it is running. Output after a stop never
 * flips it back — only an explicit start does (a stopped task's final flush lands just
 * before its closing line, and a late byte must not resurrect it).
 */

import type { AppPickerItem } from "../../components/AppPicker";
import { APPS_TITLE } from "../procs/procsFormat";
import { compileQuery, contentFilterActive, displayName, filterLines, type LogFilter } from "./agentLogsFormat";
import { sourceLabel } from "./agentLogsTitles";
import type { LogLine } from "./agentLogsTypes";

const NO_RENAMES: ReadonlyMap<string, string> = new Map();

export const TASK_STARTED_PREFIX = "background task started · ";
export const TASK_STOPPED_PREFIX = "background task stopped · ";
/** A dev app's tail opened / closed (`logstream/apps.rs`). Wire text. */
export const APP_STARTED_PREFIX = "app log started · ";
export const APP_STOPPED_PREFIX = "app log stopped · ";

/**
 * What a source IS — and, one to one, which sidebar group it sits in: `task` →
 * Services (a background task and the file it redirects to, e.g. `gazelle`), `terminal` →
 * Terminals, `agent` → Agents (root + sub-agents), `machine` → Mac apps / System apps,
 * `app` → a dev app's log stream, listed by the sidebar UNDER its app in the **Apps** group
 * (`agentLogsApps.ts` does the placing).
 */
export type RunningKind = "task" | "agent" | "terminal" | "machine" | "app";

export interface RunningSource {
  source: string;
  kind: RunningKind;
  running: boolean;
  /** Every line of this source in the ring. */
  lines: number;
  /** Its `error`-level lines. */
  errors: number;
  /** First line seen (ms). */
  firstMs: number;
  /** When the last start was seen, else the first line (ms). */
  sinceMs: number;
  /** When it stopped (ms); null while running. */
  stoppedMs: number | null;
  /** Why it stopped, in words — e.g. "no output for 10 min", "exited (code 3)". */
  reason: string | null;
  /** The highest line id of this source — the dismiss watermark. */
  lastId: number;
  /** A background task's command (first line of its announce `detail`). */
  command: string | null;
}

type Event = { kind: RunningKind; start: boolean; reason: string | null } | null;

/** What a `system` line says about its source's life, or null for anything else. */
export function lifecycleOf(text: string): Event {
  if (text.startsWith(TASK_STARTED_PREFIX)) return { kind: "task", start: true, reason: null };
  if (text.startsWith(TASK_STOPPED_PREFIX)) {
    const cut = text.indexOf(" — ", TASK_STOPPED_PREFIX.length);
    return { kind: "task", start: false, reason: cut < 0 ? null : text.slice(cut + 3) };
  }
  if (text.startsWith(APP_STARTED_PREFIX)) return { kind: "app", start: true, reason: null };
  if (text.startsWith(APP_STOPPED_PREFIX)) {
    const cut = text.indexOf(" — ", APP_STOPPED_PREFIX.length);
    return { kind: "app", start: false, reason: cut < 0 ? null : text.slice(cut + 3) };
  }
  if (text.startsWith("terminal opened")) return { kind: "terminal", start: true, reason: null };
  if (text.startsWith("terminal exited") || text === "terminal closed") {
    return { kind: "terminal", start: false, reason: text.slice("terminal ".length) };
  }
  if (text.startsWith("agent started") || text.startsWith("sub-agent started")) {
    return { kind: "agent", start: true, reason: null };
  }
  if (text.startsWith("agent exited")) return { kind: "agent", start: false, reason: text.slice("agent ".length) };
  if (text === "agent session ended") return { kind: "agent", start: false, reason: "session ended" };
  if (text === "sub-agent finished" || text === "sub-agent failed") {
    return { kind: "agent", start: false, reason: text.slice("sub-agent ".length) };
  }
  return null;
}

/** Which kind a non-lifecycle line is evidence of; null = not evidence of a live source. */
function evidenceOf(line: LogLine): RunningKind | null {
  if (line.kind === "task") return "task";
  if (line.kind === "output") return "terminal";
  if (line.kind === "tool" || line.kind === "tool-result") return "agent";
  if (line.kind === "machine") return "machine";
  if (line.kind === "app") return "app";
  return null;
}

/** When two kinds claim one label, the more specific wins (an agent's terminal is the agent). */
const RANK: Record<RunningKind, number> = { app: 4, task: 3, agent: 2, terminal: 1, machine: 0 };

interface Acc {
  src: RunningSource;
  /** A lifecycle line or evidence was seen — a bare `logs` warning is neither. */
  live: boolean;
}

/**
 * Derive the strip. `machineStreaming` says whether the system-apps stream is on right
 * now; without it Mac-app sources are left out (their lines are history, not "running").
 * Order: running first (by when they were first seen — chips do not jump as lines
 * arrive), then stopped (most recently stopped first).
 */
export function deriveRunning(lines: readonly LogLine[], machineStreaming: boolean): RunningSource[] {
  const by = new Map<string, Acc>();
  for (const line of lines) {
    let acc = by.get(line.source);
    if (!acc) {
      acc = {
        live: false,
        src: {
          source: line.source,
          kind: "terminal",
          running: true,
          lines: 0,
          errors: 0,
          firstMs: line.tsMs,
          sinceMs: line.tsMs,
          stoppedMs: null,
          reason: null,
          lastId: line.id,
          command: null,
        },
      };
      by.set(line.source, acc);
    }
    const src = acc.src;
    src.lines += 1;
    if (line.level === "error") src.errors += 1;
    src.lastId = Math.max(src.lastId, line.id);

    const ev = line.kind === "system" ? lifecycleOf(line.text) : null;
    const kind = ev?.kind ?? evidenceOf(line);
    if (kind === null) continue;
    if (!acc.live || RANK[kind] > RANK[src.kind]) src.kind = kind;
    acc.live = true;
    if (ev === null) continue;
    if (ev.start) {
      src.running = true;
      src.sinceMs = line.tsMs;
      src.stoppedMs = null;
      src.reason = null;
      if (ev.kind === "task" && line.detail !== null) src.command = line.detail.split("\n")[0];
    } else {
      src.running = false;
      src.stoppedMs = line.tsMs;
      src.reason = ev.reason;
    }
  }

  const out: RunningSource[] = [];
  for (const { src, live } of by.values()) {
    if (!live) continue;
    if (src.kind === "machine" && !machineStreaming) continue;
    out.push(src);
  }
  const running = out.filter((s) => s.running).sort((a, b) => a.firstMs - b.firstMs);
  const stopped = out
    .filter((s) => !s.running)
    .sort((a, b) => (b.stoppedMs as number) - (a.stoppedMs as number));
  return [...running, ...stopped];
}

/** Drop the stopped sources the user dismissed — until a newer line of theirs arrives. */
export function visibleRunning(
  all: readonly RunningSource[],
  dismissed: Readonly<Record<string, number>>,
): RunningSource[] {
  return all.filter((s) => s.running || !(s.source in dismissed) || s.lastId > dismissed[s.source]);
}

/** "just now", "42s ago", "3 min ago", "2 h ago", "4 d ago". */
export function agoText(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** The sidebar's word for a kind — the group name's singular ("Services" → "Service"). */
const KIND_WORD: Record<RunningKind, string> = {
  task: "Service",
  agent: "Agent",
  terminal: "Terminal",
  machine: "App on this computer",
  app: "Dev app log",
};

/** `["N lines"]` / `["1 line"]`, plus `"E errors"` when there are any. */
export function countParts(lines: number, errors: number): string[] {
  const out = [`${lines} ${lines === 1 ? "line" : "lines"}`];
  if (errors > 0) out.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  return out;
}

/** The row's tooltip: what it is, whether it runs, since/ago, why it stopped, the command. */
export function chipTitle(s: RunningSource, nowMs: number, machineLabel: string): string {
  const what = s.kind === "machine" ? `${machineLabel} source` : KIND_WORD[s.kind];
  const state = s.running
    ? `running — started ${agoText(s.sinceMs, nowMs)}`
    : `stopped ${agoText(s.stoppedMs as number, nowMs)}${s.reason === null ? "" : ` — ${s.reason}`}`;
  const parts = [`${displayName(s.source)} · ${what}, ${state}`, countParts(s.lines, s.errors).join(", ")];
  if (s.command !== null) parts.push(s.command);
  parts.push("Click to show only this source");
  return parts.join("\n");
}

/* ───────────────────────────── the sidebar's groups ───────────────────────────── */

/**
 * The sidebar's order: the apps first (a top group **Apps**, above Services — it replaced an
 * older group at the bottom), then what the agents run,
 * then where they run, then who runs.
 */
export const GROUP_ORDER: readonly RunningKind[] = ["app", "task", "terminal", "agent", "machine"];

/**
 * The group headings; the machine one follows the backend ("Mac apps" / "System apps"), the
 * dev-app one is the procs section's own heading ("Apps") so the toolbar picker's sublabel and
 * the sidebar heading read the same.
 */
export function groupLabel(kind: RunningKind, machineLabel: string): string {
  if (kind === "task") return "Services";
  if (kind === "terminal") return "Terminals";
  if (kind === "agent") return "Agents";
  if (kind === "app") return APPS_TITLE;
  return machineLabel;
}

export interface SourceGroup {
  kind: RunningKind;
  /** In `deriveRunning`'s order: running first (by first appearance), then stopped. */
  sources: RunningSource[];
}

/** Partition the visible sources into the sidebar's groups; an empty group is left out. */
export function groupSources(sources: readonly RunningSource[]): SourceGroup[] {
  return GROUP_ORDER.map((kind) => ({ kind, sources: sources.filter((s) => s.kind === kind) })).filter(
    (g) => g.sources.length > 0,
  );
}

/** One of a group: `service` · `terminal` · `agent` · `Mac app` / `System app`. */
export function groupSingular(kind: RunningKind, machineLabel: string): string {
  if (kind === "task") return "service";
  if (kind === "terminal") return "terminal";
  if (kind === "agent") return "agent";
  if (kind === "app") return "app log";
  // "Mac apps" → "Mac app", "System apps" → "System app".
  return machineLabel.replace(/s$/, "");
}

/* ───────────────────────────── the stream header ───────────────────────────── */

/**
 * What the header above a solo stream says. The Source column no longer disappears on a
 * solo (its coming and going read as a new, empty column), so the header is
 * where the selection is announced: `gazelle · service · ● running · 26 lines · 1 error`.
 */
export interface StreamHeader {
  /** The wire label — the key the "All sources" link and the row click share. */
  source: string;
  name: string;
  /** The group's singular, or null for a source the sidebar does not list (no live evidence). */
  kind: string | null;
  /** Null with `kind`: an unlisted source has no state to report. */
  running: boolean | null;
  lines: number;
  errors: number;
  /** The whole line as read out: name · kind · state · counts. */
  text: string;
}

/**
 * The header for `source` over the ring. Kind and state come from the same derivation as the
 * sidebar, with Mac apps always included (a solo picked through the toolbar can name one while
 * the stream is off); the counts are the source's own lines, so they are right even for a
 * source the derivation leaves out.
 */
export function streamHeader(
  source: string,
  lines: readonly LogLine[],
  machineLabel: string,
  renamed: ReadonlyMap<string, string> = NO_RENAMES,
): StreamHeader {
  let count = 0;
  let errors = 0;
  for (const l of lines) {
    if (l.source !== source) continue;
    count += 1;
    if (l.level === "error") errors += 1;
  }
  const live = deriveRunning(lines, true).find((s) => s.source === source) ?? null;
  // A renamed terminal is headed by its live title (`gazelle`), not its spawn label.
  const name = sourceLabel(source, renamed);
  const kind = live === null ? null : groupSingular(live.kind, machineLabel);
  const running = live === null ? null : live.running;
  const parts = [name];
  if (kind !== null) parts.push(kind);
  if (running !== null) parts.push(running ? "● running" : "○ stopped");
  parts.push(...countParts(count, errors));
  return { source, name, kind, running, lines: count, errors, text: parts.join(" · ") };
}

/* ───────────────────────────── the toolbar's source picker ───────────────────────────── */

/**
 * The picker's rows, grouped like the sidebar: Apps (their log streams) first, then Services, Terminals, Agents, Mac
 * apps — each row's `sublabel` is its group (the shared `AppPicker` has no headings; it
 * renders rows in the order given, so the order IS the grouping). Within a group the
 * sidebar's order (running first, by first appearance). A source the derivation does not
 * list — one whose only lines are a hub warning — goes last, ungrouped, so it can still be
 * picked. Ids stay the wire labels (they are the filter's keys); labels are display names.
 */
export function sourcePickerItems(
  sources: readonly string[],
  running: readonly RunningSource[],
  machineLabel: string,
  renamed: ReadonlyMap<string, string> = NO_RENAMES,
): AppPickerItem[] {
  const out: AppPickerItem[] = [];
  const seen = new Set<string>();
  for (const g of groupSources(running)) {
    for (const s of g.sources) {
      seen.add(s.source);
      out.push({ id: s.source, label: sourceLabel(s.source, renamed), sublabel: groupLabel(g.kind, machineLabel) });
    }
  }
  for (const s of sources) if (!seen.has(s)) out.push({ id: s, label: sourceLabel(s, renamed) });
  return out;
}

/**
 * While the toolbar narrows the stream by content (a query, a level off), how many lines
 * of EACH source it keeps — the count the sidebar shows in place of the line total
 * (search is global, results are per source). The source pick is lifted for the
 * count, so a source you are not looking at still says how much it would show. Null when
 * no content filter is active.
 */
export function matchCountsBySource(lines: readonly LogLine[], filter: LogFilter): ReadonlyMap<string, number> | null {
  if (!contentFilterActive(filter)) return null;
  const global: LogFilter = { ...filter, hiddenSources: [], onlySources: null };
  const counts = new Map<string, number>();
  for (const l of filterLines(lines, global).rows) counts.set(l.source, (counts.get(l.source) ?? 0) + 1);
  return counts;
}

/** The compiled query for the stream's in-place hits, or null when there is no (valid) one. */
export function queryMatcher(query: string): ((s: string) => boolean) | null {
  const m = compileQuery(query);
  return m.ok ? m.test : null;
}
