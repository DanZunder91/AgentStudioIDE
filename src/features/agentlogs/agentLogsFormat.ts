/**
 * Agent Logs — the pure half: formatting, the filter, the os_log highlighter, and the
 * row-window arithmetic. No React, no store, no IPC — everything here is table-tested
 * in `agentLogsFormat.test.ts` with expectations written out by hand.
 */

import type { AppPickerItem } from "../../components/AppPicker";
import type { LogLevel, LogLine, RunningApp, SyslogBackend } from "./agentLogsTypes";

/* ───────────────────────────── time + level ───────────────────────────── */

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** `HH:MM:SS.mmm` in local time — the `log stream --style compact` column. */
export function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

const BADGE: Record<LogLevel, string> = { error: "E", warn: "W", info: "I", debug: "D" };

/** One-letter level badge, os_log style. */
export function levelBadge(level: LogLevel): string {
  return BADGE[level];
}

/** A row's text on one line — a stray newline must not break the one-row-one-line grid. */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, " ⏎ ");
}

/** "Copy visible": plain text, one line per row, same columns as the view. */
export function formatLineForCopy(line: LogLine): string {
  return `${formatTime(line.tsMs)} ${levelBadge(line.level)} ${line.source}  ${oneLine(line.text)}`;
}

/* ───────────────────────────── display names ─────────────────────────── */

/**
 * Rust labels a background task's stream `<program> · bg` (`logstream/tasks.rs`). `gazelle · bg`
 * was hard to find in the sidebar — the suffix reads as part of the name, not as a
 * kind — so the UI shows `gazelle` with a small `service` tag instead. The
 * wire label stays the KEY everywhere (`data-source`, the filter, the picker's ids, Copy
 * visible): only what the eye reads changes.
 */
export const SERVICE_SUFFIX = " · bg";

/**
 * What a source is called on screen. Exactly one trailing ` · bg` is dropped: the suffix is
 * appended once by Rust, so a label that happens to end in two is a program literally named
 * `x · bg`, and it keeps one. A label that is nothing but the suffix is shown as is — an empty
 * name is a worse bug than an odd one.
 */
export function displayName(source: string): string {
  if (!source.endsWith(SERVICE_SUFFIX)) return source;
  const bare = source.slice(0, -SERVICE_SUFFIX.length);
  return bare === "" ? source : bare;
}

/** The small kind tag shown beside a display name: `service` for a background task's stream. */
export function sourceTag(source: string): "service" | null {
  return displayName(source) === source ? null : "service";
}

/* ───────────────────────────── source colour ──────────────────────────── */

/** How many source colours `agentLogs.css` declares (`--alog-src-0` … `-7`). */
export const SOURCE_PALETTE_SIZE = 8;

/**
 * Stable palette slot for a source label (FNV-1a, 32-bit). Stable across runs and
 * machines, so "claude · gazelle" is always the same colour — the property that lets a
 * reader track one source by colour alone.
 */
export function sourceColorIndex(source: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SOURCE_PALETTE_SIZE;
}

/* ───────────────────────────── tool rows ──────────────────────────────── */

/**
 * Split a `tool` line into `{ name, rest }`: `"Bash: ls -la"` → `Bash` + `": ls -la"`.
 * A bare tool (`"TodoWrite"`) is all name. Anything that does not look like a tool
 * prefix (a space before the colon, or no colon in prose) gets `name: null`.
 */
export function toolParts(text: string): { name: string | null; rest: string } {
  const m = /^([A-Za-z_][\w.-]*)(: [\s\S]*)?$/.exec(text);
  if (!m) return { name: null, rest: text };
  return { name: m[1], rest: m[2] ?? "" };
}

/* ───────────────────────────── command blocks ───────────────────── */

/** What a command block's header row shows, derived from the `tool` line. */
export interface ToolHeader {
  /** The tool's name, or null when the line has no `Name: ` prefix (rendered verbatim). */
  name: string | null;
  /**
   * The header text: `$ cargo test --lib` (Bash), `Read /work/x.rs`, `Grep "fn parse"`,
   * a bare `TodoWrite`, or the raw text when it has no tool prefix.
   */
  label: string;
  /** A Bash call's one-line `description`, shown dimmed after the command. */
  description: string | null;
  /** The whole multi-line command/value when the row only showed its first line. */
  full: string | null;
}

/**
 * Rust's `tool` line shapes (`agent/claude.rs::summarize_tool_use`): text is
 * `Name: <first line>` with ` …` appended when the value spans lines; `detail` is the Bash
 * `description`, and for a multi-line value the whole value — `description\n\nvalue` when
 * both exist. This inverts that: the description and the full value are told apart by
 * whether the text after the (optional) blank line starts with the row's own first line.
 */
export function toolHeader(line: Pick<LogLine, "text" | "detail">): ToolHeader {
  const { name, rest } = toolParts(line.text);
  if (name === null) return { name: null, label: line.text, description: null, full: null };
  const arg = rest.startsWith(": ") ? rest.slice(2) : "";
  const first = arg.endsWith(" …") ? arg.slice(0, -2) : arg;
  let description: string | null = null;
  let full: string | null = null;
  const d = line.detail;
  if (d !== null) {
    if (first !== "" && d.startsWith(first)) full = d;
    else if (name !== "Bash") full = d;
    else {
      // Only Bash carries a description; `description\n\ncommand` when the command spans lines.
      const cut = d.indexOf("\n\n");
      if (cut >= 0 && first !== "" && d.slice(cut + 2).startsWith(first)) {
        description = d.slice(0, cut);
        full = d.slice(cut + 2);
      } else description = d;
    }
  }
  let label: string;
  if (arg === "") label = name;
  else if (name === "Bash") label = `$ ${arg}`;
  else if (name === "Grep" || name === "Glob") label = `${name} "${arg}"`;
  else label = `${name} ${arg}`;
  return { name, label, description, full };
}

/** Lines of a block that is collapsed: the first three, then "show N more". */
export const COLLAPSED_OUTPUT_LINES = 3;

const RESULT_ARROW = " → ";

/** The tool a `tool-result` line answers, from its `Name → …` prefix — null for a bare result. */
export function resultToolName(text: string): string | null {
  const i = text.indexOf(RESULT_ARROW);
  if (i <= 0) return null;
  const name = text.slice(0, i);
  return /^[A-Za-z_][\w.-]*$/.test(name) ? name : null;
}

/**
 * The invocation line Rust puts first in a result's `detail`: `$ <full command>` for Bash,
 * `<Tool>: <summary>` for every other tool — then a blank line, then the output. The block's
 * header already shows the call, so the output
 * drops it; the shape is checked (not just "the first line") so a result from an older build,
 * or an orphan whose call Rust could not name, keeps its first line.
 */
const INVOCATION = /^(?:\$ |[A-Za-z_][\w.-]*(?::\s|$))/;

/**
 * A result's output, one entry per line, for the block's nested rows. The full text is
 * `detail` when Rust sent one (the invocation line, a blank, then the first 40 lines with a
 * `… (N more lines)` note last), else the one line after the arrow. Blank output is Rust's
 * own `(no output)`; an empty text is no rows.
 */
export function resultOutput(line: Pick<LogLine, "text" | "detail">): string[] {
  let body: string | null = null;
  if (line.detail !== null) {
    body = line.detail;
    const nl = body.indexOf("\n");
    const first = nl < 0 ? body : body.slice(0, nl);
    if (INVOCATION.test(first) && (nl < 0 || body.startsWith("\n", nl + 1))) {
      body = nl < 0 ? null : body.slice(nl + 2);
    }
  }
  if (body === null || body === "") {
    const i = line.text.indexOf(RESULT_ARROW);
    body = i < 0 ? line.text : line.text.slice(i + RESULT_ARROW.length);
  }
  return body === "" ? [] : body.split("\n");
}

/* ───────────────────────────── os_log highlight ───────────────────────── */

export type SegmentKind = "plain" | "process" | "subsystem";
export interface Segment {
  kind: SegmentKind;
  text: string;
}

/**
 * `Name[pid]` / `Name[pid:tid]` (process) or `[com.dotted.id]` / `[com.dotted.id:category]`
 * (subsystem). The subsystem arm demands at least one dot so a plain `[42]` or `[x]` is
 * never mistaken for one.
 */
const OSLOG = /([A-Za-z_][\w.-]*)\[\d+(?::[0-9A-Fa-fx]+)?\]|\[[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?::[^\]\s]*)?\]/g;

/**
 * Lightweight os_log highlighting as data, never HTML: the panel renders each segment
 * as a text node inside a span, so a log line can never inject markup.
 */
export function highlightOsLog(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(OSLOG)) {
    const at = m.index;
    if (at > last) out.push({ kind: "plain", text: text.slice(last, at) });
    out.push({ kind: m[1] === undefined ? "subsystem" : "process", text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}

/**
 * A system-app (`machine`) row: its leading `[subsystem:category]` is highlighted as a
 * subsystem whatever its shape (journald units and dot-less subsystems included — the
 * position, not the dots, says what it is); the rest gets the ordinary os_log pass.
 */
export function highlightMachine(text: string): Segment[] {
  const m = /^\[[^\]\n]+\]/.exec(text);
  if (!m) return highlightOsLog(text);
  const rest = text.slice(m[0].length);
  return [{ kind: "subsystem", text: m[0] }, ...(rest === "" ? [] : highlightOsLog(rest))];
}

/* ───────────────────────────── the filter ─────────────────────────────── */

/**
 * The filter has no kind toggles any more: the old Output / Tools / System / Tasks /
 * Mac-apps chips sliced one firehose by wire kind, and the Sources sidebar's grouping
 * (Services / Terminals / Agents / Mac apps) is what replaced them. The kinds still exist
 * on the wire and still decide HOW a line renders (raw, block, divider).
 */
export interface LogFilter {
  query: string;
  levels: Record<LogLevel, boolean>;
  /**
   * The Sources control's "IDE terminals & agents" switch. Off hides every line that is
   * not `machine` — terminal output, tool calls and results, lifecycle — client-side.
   */
  ide: boolean;
  /** Sources the user unticked. An exclusion list, so a NEW source shows by default. */
  hiddenSources: readonly string[];
  /**
   * A positive pick ("Only zsh"), or null. When set it wins over `hiddenSources`, and a
   * NEW source stays hidden — with every Mac app streaming, "only this one" has to mean it.
   */
  onlySources: readonly string[] | null;
}

export type TextMatcher =
  | { ok: true; test: ((s: string) => boolean) | null }
  | { ok: false; error: string };

/**
 * Compile the text box. `/pattern/flags` is a regex; anything else is a case-insensitive
 * substring. An invalid regex is returned as an error for the toolbar to show — it never
 * throws out of a keystroke. `g`/`y` are dropped: they make `RegExp.test` stateful, which
 * would make every other row match.
 */
export function compileQuery(query: string): TextMatcher {
  const q = query.trim();
  if (q === "") return { ok: true, test: null };
  const rx = /^\/(.+)\/([a-z]*)$/s.exec(q);
  if (rx) {
    try {
      const re = new RegExp(rx[1], rx[2].replace(/[gy]/g, ""));
      return { ok: true, test: (s) => re.test(s) };
    } catch (e) {
      // `new RegExp` only ever throws a SyntaxError.
      return { ok: false, error: (e as SyntaxError).message };
    }
  }
  const needle = q.toLowerCase();
  return { ok: true, test: (s) => s.toLowerCase().includes(needle) };
}

export interface FilterResult {
  rows: LogLine[];
  /** Set when the query is an invalid regex; `rows` then ignores the query. */
  error: string | null;
  /**
   * Ids of rows the query matched ONLY in their `detail` (the row's own text and source do
   * not contain it) — the panel marks them, so a hit you cannot see on the row still reads
   * as a hit. Empty with no query.
   */
  viaDetail: ReadonlySet<number>;
}

/**
 * Apply the toolbar. The text query matches a line's text, its source label, OR its
 * `detail` (the bug: a /health call an agent ran could not be found — a multi-line
 * Bash command keeps everything after its first line in `detail`).
 * An invalid regex does not blank the view — the other filters still apply and the error
 * is reported beside the box.
 */
export function filterLines(lines: readonly LogLine[], f: LogFilter): FilterResult {
  const m = compileQuery(f.query);
  const test = m.ok ? m.test : null;
  const hidden = f.hiddenSources.length > 0 ? new Set(f.hiddenSources) : null;
  const only = f.onlySources === null ? null : new Set(f.onlySources);
  const viaDetail = new Set<number>();
  const matches = (l: LogLine): boolean => {
    if (test === null || test(l.text) || test(l.source)) return true;
    if (l.detail !== null && test(l.detail)) {
      viaDetail.add(l.id);
      return true;
    }
    return false;
  };
  const rows = lines.filter(
    (l) =>
      f.levels[l.level] &&
      // The "IDE terminals & agents" switch hides IDE content only: a Mac app's line and a dev
      // app's stream (the user started it from the app's card) stay.
      (f.ide || l.kind === "machine" || l.kind === "app") &&
      (only === null ? !(hidden?.has(l.source) ?? false) : only.has(l.source)) &&
      matches(l),
  );
  return { rows, error: m.ok ? null : m.error, viaDetail };
}

/**
 * True while the toolbar narrows the stream by content — a (valid) text query or a level
 * switched off. That is when the sidebar swaps its line counts for match counts.
 * The source pick is deliberately not a "filter" here: it chooses the stream, it does not
 * search it.
 */
export function contentFilterActive(f: LogFilter): boolean {
  const q = compileQuery(f.query);
  if (q.ok && q.test !== null) return true;
  return Object.values(f.levels).some((on) => !on);
}

/** Distinct sources, sorted case-insensitively — the multi-select's options. */
export function sourcesOf(lines: readonly LogLine[]): string[] {
  return [...new Set(lines.map((l) => l.source))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/* ───────────────────────── the source picker ─────────────────────────── */

export type SourcePick = Pick<LogFilter, "hiddenSources" | "onlySources">;

/** What the shared `AppPicker` shows as selected: `null` (all) or the visible sources. */
export function sourceSelection(f: SourcePick, sources: readonly string[]): string[] | null {
  if (f.onlySources !== null) return [...f.onlySources];
  if (f.hiddenSources.length === 0) return null;
  return sources.filter((s) => !f.hiddenSources.includes(s));
}

/**
 * Translate an `AppPicker` change back into the filter. From "all except …", unticking
 * or re-ticking ONE source edits the exclusion list (so sources that appear later still
 * show — the view's original rule); anything else ("Only", or ticking from nothing) is a
 * positive pick. From a pick, every change stays a pick.
 */
export function applySourcePick(
  f: SourcePick,
  sources: readonly string[],
  next: string[] | null,
): SourcePick {
  if (next === null) return { hiddenSources: [], onlySources: null };
  if (f.onlySources === null) {
    const shown = sources.filter((s) => !f.hiddenSources.includes(s));
    const removed = shown.filter((s) => !next.includes(s));
    const added = next.filter((s) => !shown.includes(s));
    if (added.length === 0 && removed.length === 1 && next.length > 0) {
      return { hiddenSources: [...f.hiddenSources, removed[0]], onlySources: null };
    }
    if (removed.length === 0 && added.length === 1) {
      return { hiddenSources: f.hiddenSources.filter((h) => h !== added[0]), onlySources: null };
    }
  }
  return { hiddenSources: [], onlySources: [...next] };
}

/* ───────────────────────────── system apps ────────────────────────────── */

/** "Mac apps" where the backend is the macOS unified log, "System apps" everywhere else. */
export function appsLabel(backend: SyslogBackend | null | undefined): string {
  return backend === "macos-unified-log" ? "Mac apps" : "System apps";
}

/** What the system-apps controls call things on one backend. */
export interface SyslogTexts {
  /** The picker's plural noun ("All apps", "3 Event Log sources", "Search apps…"). */
  noun: string;
  /** The picker trigger's accessible name. */
  picker: string;
  /** The refresh button's accessible name and tooltip. */
  refreshLabel: string;
  refreshTitle: string;
  /** The `subsystem` box. */
  subsystemLabel: string;
  subsystemPlaceholder: string;
  /** "All apps" earns the high-volume notice (macOS/Linux: 150–500 lines/s; the Event Log writes a few a minute). */
  highVolume: boolean;
}

const MAC_TEXTS: SyslogTexts = {
  noun: "apps",
  picker: "Choose mac apps",
  refreshLabel: "Refresh the app list",
  refreshTitle: "Re-read the running processes",
  subsystemLabel: "Subsystem",
  subsystemPlaceholder: "Subsystem prefix, e.g. com.example.app",
  highVolume: true,
};
const LINUX_TEXTS: SyslogTexts = {
  ...MAC_TEXTS,
  picker: "Choose system apps",
  subsystemLabel: "Systemd unit",
  subsystemPlaceholder: "Systemd unit, e.g. nginx.service",
};
/** Windows lists Event Log providers (the Event Viewer "Source"), not processes; `subsystem` is one extra channel. */
const WINDOWS_TEXTS: SyslogTexts = {
  noun: "Event Log sources",
  picker: "Choose event log sources",
  refreshLabel: "Refresh the source list",
  refreshTitle: "Re-read the Event Log sources that wrote to Application and System recently",
  subsystemLabel: "Extra channel",
  subsystemPlaceholder: "Also read a channel, e.g. Microsoft-Windows-PowerShell/Operational",
  highVolume: false,
};

/** Per-backend wording. Exhaustive over `SyslogBackend`: a new backend fails to compile here until it is given its words. */
export function syslogTexts(backend: SyslogBackend | null | undefined): SyslogTexts {
  switch (backend) {
    case "macos-unified-log":
      return MAC_TEXTS;
    case "windows-eventlog":
      return WINDOWS_TEXTS;
    case "linux-journald":
    case null:
    case undefined:
      return LINUX_TEXTS;
  }
}

/**
 * `syslog_apps` → picker rows: `.app` bundles first (stable), path as sublabel, pid count.
 * A row with no pids (a Windows Event Log provider is not a process) shows no count.
 */
export function appPickerItems(apps: readonly RunningApp[]): AppPickerItem[] {
  const ordered = [...apps.filter((a) => a.isApp), ...apps.filter((a) => !a.isApp)];
  return ordered.map((a) => ({
    id: a.name,
    label: a.name,
    ...(a.path === null ? {} : { sublabel: a.path }),
    ...(a.pids.length === 0 ? {} : { count: a.pids.length }),
  }));
}

/** A comma-separated name box → a list; blank means ALL (`null`). Trims, drops empties, dedupes. */
export function parseNameList(text: string): string[] | null {
  const names = [...new Set(text.split(",").map((n) => n.trim()).filter((n) => n !== ""))];
  return names.length === 0 ? null : names;
}

/** The inverse of `parseNameList` for showing the active value in the box. */
export function formatNameList(names: readonly string[] | null): string {
  return names === null ? "" : names.join(", ");
}

/* ───────────────────────────── windowing ──────────────────────────────── */

export interface RowWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** Fixed-height row windowing (the `ResultsGrid` shape). `end` is exclusive. */
export function rowWindow(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  total: number,
  overscan = 10,
): RowWindow {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const maxScroll = Math.max(total * rowHeight - viewport, 0);
  const top = Math.min(Math.max(scrollTop, 0), maxScroll);
  const first = Math.floor(top / rowHeight);
  const start = Math.max(first - overscan, 0);
  const end = Math.min(first + Math.ceil(viewport / rowHeight) + 1 + overscan, total);
  return { start, end, padTop: start * rowHeight, padBottom: (total - end) * rowHeight };
}
