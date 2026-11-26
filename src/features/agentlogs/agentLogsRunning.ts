/** Sources sidebar, the pure half: derived from log lines alone (no store, no IPC), one entry per
 * SOURCE label. Liveness reads Rust's lifecycle texts (contract: `logstream/tasks.rs`, `apps.rs`);
 * the LAST lifecycle event wins, and output after a stop never revives a source. */

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

/** What a source is, one-to-one with its sidebar group: `task` → Services, `terminal`, `agent`
 * (root + sub-agents), `machine` → Mac/System apps, `app` → under its app (`agentLogsApps.ts`). */
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

/** Derive the sources. Without `machineStreaming`, Mac-app sources are left out (their lines are
 * history). Running first by first-seen (chips don't jump), then most recently stopped. */
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

/** Sidebar group order: Apps, then what the agents run, where they run, who runs. */
export const GROUP_ORDER: readonly RunningKind[] = ["app", "task", "terminal", "agent", "machine"];

/** Group headings: machine follows the backend ("Mac apps" / "System apps"); dev apps use the
 * procs heading ("Apps") so the picker sublabel and sidebar heading match. */
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

/** Header above a solo stream (`gazelle · service · ● running · 26 lines · 1 error`); it, not
 * the Source column, announces the selection. */
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

/** Header for `source`: kind/state from the sidebar derivation with Mac apps always included (a
 * toolbar solo can name one while off); counts are the source's own lines. */
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

/** Picker rows in sidebar group order (`AppPicker` has no headings: order IS grouping, `sublabel`
 * names the group); underived sources (hub warnings only) go last. Ids stay wire labels. */
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

/** Per-source line counts kept by the content filter (query, level off), with the source pick
 * lifted; the sidebar shows them instead of totals. Null when no content filter is active. */
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
