/** Stream model, pure: filtered lines → `raw` / `divider` / `block` (a `tool` call + its result,
 * folded to 3 lines). Every row is exactly ROW_H, so windowing is arithmetic and jsdom-testable.
 * Pairs by `toolUseId`; an id-less result answers its agent's OLDEST unanswered call. */

import {
  COLLAPSED_OUTPUT_LINES,
  formatLineForCopy,
  formatTime,
  levelBadge,
  oneLine,
  resultOutput,
  resultToolName,
  toolHeader,
  type ToolHeader,
} from "./agentLogsFormat";
import type { LogLine } from "./agentLogsTypes";

/* ───────────────────────────── pairing ───────────────────────────── */

export interface Pairing {
  /** tool line id → its result line. */
  resultOf: ReadonlyMap<number, LogLine>;
  /** result line id → its tool line. */
  toolOf: ReadonlyMap<number, LogLine>;
}

/** The transcript-tail identity of a line's agent: its agent id, else its source label. */
const agentKey = (l: LogLine): string => l.agentId ?? `source:${l.source}`;

/** Pair every `tool-result` with its `tool` line over the WHOLE ring, so a filter that hides
 * one half of a pair still renders the block from the other. */
export function pairToolLines(lines: readonly LogLine[]): Pairing {
  const resultOf = new Map<number, LogLine>();
  const toolOf = new Map<number, LogLine>();
  const byUseId = new Map<string, LogLine>();
  /** Per agent, the unanswered tool lines in order — the queue the id-less fallback takes from. */
  const pending = new Map<string, LogLine[]>();
  for (const line of lines) {
    if (line.kind === "tool") {
      const id = line.toolUseId ?? null;
      if (id !== null) byUseId.set(id, line);
      const stack = pending.get(agentKey(line));
      if (stack) stack.push(line);
      else pending.set(agentKey(line), [line]);
      continue;
    }
    if (line.kind !== "tool-result") continue;
    const id = line.toolUseId ?? null;
    let tool: LogLine | undefined;
    if (id !== null) {
      tool = byUseId.get(id);
      // Rust dedupes results by id, so a second result for one call is a rewrite replay:
      // the first answer stands.
      if (tool !== undefined && resultOf.has(tool.id)) tool = undefined;
    } else {
      const queue = pending.get(agentKey(line)) ?? [];
      // Oldest preceding call that is still unanswered (an id-paired one is skipped).
      while (queue.length > 0) {
        const oldest = queue.shift() as LogLine;
        if (!resultOf.has(oldest.id)) {
          tool = oldest;
          break;
        }
      }
    }
    if (tool === undefined) continue;
    resultOf.set(tool.id, line);
    toolOf.set(line.id, tool);
  }
  return { resultOf, toolOf };
}

/* ───────────────────────────── blocks ───────────────────────────── */

export interface ToolBlock {
  /** Expand/collapse identity: `toolUseId`, else `t<id>` (the call), else `r<id>` (orphan). */
  key: string;
  /** The call; null for an orphan result (its call scrolled out of the ring or was cleared). */
  tool: LogLine | null;
  /** The answer; null while the call is still running. */
  result: LogLine | null;
  /** The line the block stands at in the stream: the call, else the orphan result. */
  anchor: LogLine;
  header: ToolHeader;
  /** The result's output, one entry per line; empty while pending. */
  output: readonly string[];
  /** The result reported `is_error`: the header goes red. */
  error: boolean;
}

/** Split results are cached per line object: a batch re-render must not re-split 10 000 details. */
const outputCache = new WeakMap<LogLine, readonly string[]>();

function outputOf(result: LogLine): readonly string[] {
  let out = outputCache.get(result);
  if (out === undefined) {
    out = resultOutput(result);
    outputCache.set(result, out);
  }
  return out;
}

/** A block from its tool line (and the pairing), or from an orphan result. */
export function blockFor(anchor: LogLine, pairing: Pairing): ToolBlock {
  if (anchor.kind === "tool") {
    const result = pairing.resultOf.get(anchor.id) ?? null;
    return {
      key: anchor.toolUseId ?? `t${anchor.id}`,
      tool: anchor,
      result,
      anchor,
      header: toolHeader(anchor),
      output: result === null ? [] : outputOf(result),
      error: result !== null && result.level === "error",
    };
  }
  const name = resultToolName(anchor.text);
  return {
    key: anchor.toolUseId ?? `r${anchor.id}`,
    tool: null,
    result: anchor,
    anchor,
    header: { name, label: name ?? anchor.text, description: null, full: null },
    output: outputOf(anchor),
    error: anchor.level === "error",
  };
}

/** Rows a block occupies: header + shown output + one "more"/"less" row when it folds. */
export function blockHeight(outputLines: number, expanded: boolean): number {
  if (outputLines <= COLLAPSED_OUTPUT_LINES) return 1 + outputLines;
  return 1 + (expanded ? outputLines : COLLAPSED_OUTPUT_LINES) + 1;
}

/* ───────────────────────────── the stream ───────────────────────────── */

export type StreamEntry =
  | { kind: "raw"; line: LogLine; offset: number; height: 1 }
  | { kind: "divider"; line: LogLine; offset: number; height: 1 }
  | {
      kind: "block";
      line: LogLine;
      block: ToolBlock;
      expanded: boolean;
      /** Output line indices the active query hits (empty with no query). */
      hits: readonly number[];
      offset: number;
      height: number;
    };

export interface Stream {
  entries: readonly StreamEntry[];
  /** Rows in total — what the scroll box's height is made of. */
  total: number;
  /** Every line the stream shows, by id — a block contributes both its halves. */
  shown: ReadonlyMap<number, LogLine>;
}

export interface StreamOptions {
  /** Explicit per-block choice (true = expanded). Absent = automatic: expanded when the query
   * hits output past the fold, else collapsed. */
  expanded: Readonly<Record<string, boolean>>;
  /** The compiled text query, or null: decides `hits` and the automatic expansion. */
  query: ((s: string) => boolean) | null;
}

/** Build from the FILTERED rows. A block appears once at its call's position, or at the
 * result's when only it was kept (the call pulled from the pairing for the header). */
export function buildStream(rows: readonly LogLine[], pairing: Pairing, opts: StreamOptions): Stream {
  const entries: StreamEntry[] = [];
  const shown = new Map<number, LogLine>();
  const emitted = new Set<number>();
  let offset = 0;
  for (const line of rows) {
    if (line.kind === "system") {
      entries.push({ kind: "divider", line, offset, height: 1 });
      shown.set(line.id, line);
      offset += 1;
      continue;
    }
    if (line.kind !== "tool" && line.kind !== "tool-result") {
      entries.push({ kind: "raw", line, offset, height: 1 });
      shown.set(line.id, line);
      offset += 1;
      continue;
    }
    let anchor = line;
    if (line.kind === "tool-result") {
      const tool = pairing.toolOf.get(line.id);
      if (tool !== undefined) {
        // A result only ever pairs with a call that PRECEDES it (both pairing routes look
        // backwards), so if the call is in the rows it has already been emitted: skip the
        // result. Otherwise the filter dropped the call and the block stands here, at the result.
        if (emitted.has(tool.id)) continue;
        anchor = tool;
      }
    }
    emitted.add(anchor.id);
    const block = blockFor(anchor, pairing);
    const hits: number[] = [];
    if (opts.query !== null) {
      block.output.forEach((text, i) => {
        if ((opts.query as (s: string) => boolean)(text)) hits.push(i);
      });
    }
    const choice = opts.expanded[block.key];
    const expanded = choice ?? hits.some((i) => i >= COLLAPSED_OUTPUT_LINES);
    const height = blockHeight(block.output.length, expanded);
    entries.push({ kind: "block", line: anchor, block, expanded, hits, offset, height });
    if (block.tool) shown.set(block.tool.id, block.tool);
    if (block.result) shown.set(block.result.id, block.result);
    offset += height;
  }
  return { entries, total: offset, shown };
}

/* ───────────────────────────── visual rows ───────────────────────────── */

export type VisualRow =
  | { kind: "raw"; line: LogLine }
  | { kind: "divider"; line: LogLine }
  | { kind: "head"; block: ToolBlock; expanded: boolean }
  | { kind: "out"; block: ToolBlock; index: number; text: string; hit: boolean }
  | { kind: "more"; block: ToolBlock; expanded: boolean; hidden: number };

/** The rows of one entry, top to bottom. */
function rowsOfEntry(e: StreamEntry): VisualRow[] {
  if (e.kind === "raw") return [{ kind: "raw", line: e.line }];
  if (e.kind === "divider") return [{ kind: "divider", line: e.line }];
  const { block, expanded, hits } = e;
  const out: VisualRow[] = [{ kind: "head", block, expanded }];
  const folds = block.output.length > COLLAPSED_OUTPUT_LINES;
  const count = folds && !expanded ? COLLAPSED_OUTPUT_LINES : block.output.length;
  for (let i = 0; i < count; i++) {
    out.push({ kind: "out", block, index: i, text: block.output[i], hit: hits.includes(i) });
  }
  if (folds) out.push({ kind: "more", block, expanded, hidden: block.output.length - COLLAPSED_OUTPUT_LINES });
  return out;
}

/** The first entry that reaches row `row` (binary search on the cumulative offsets). */
function entryAt(entries: readonly StreamEntry[], row: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].offset + entries[mid].height <= row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The rows in `[start, end)`, materialised — the only allocation that scales with the window. */
export function visualRowsIn(stream: Stream, start: number, end: number): VisualRow[] {
  const out: VisualRow[] = [];
  if (end <= start || stream.entries.length === 0) return out;
  for (let i = entryAt(stream.entries, start); i < stream.entries.length; i++) {
    const e = stream.entries[i];
    if (e.offset >= end) break;
    const rows = rowsOfEntry(e);
    const from = Math.max(start - e.offset, 0);
    const to = Math.min(end - e.offset, rows.length);
    for (let r = from; r < to; r++) out.push(rows[r]);
  }
  return out;
}

/** A stable React key for a visual row. */
export function visualRowKey(row: VisualRow): string {
  if (row.kind === "raw" || row.kind === "divider") return String(row.line.id);
  if (row.kind === "head") return `b:${row.block.key}`;
  if (row.kind === "out") return `b:${row.block.key}:${row.index}`;
  return `b:${row.block.key}:more`;
}

/* ───────────────────────────── error navigation ───────────────────────────── */

export interface ErrorTarget {
  /** The line to highlight: the raw/divider line, or the block's anchor. */
  lineId: number;
  /** The row the entry starts at. */
  offset: number;
}

/** The error rows of one source, in stream order: a block counts when its result failed. */
export function errorTargets(stream: Stream, source: string): ErrorTarget[] {
  const out: ErrorTarget[] = [];
  for (const e of stream.entries) {
    const isError = e.kind === "block" ? e.block.error : e.line.level === "error";
    if (isError && e.line.source === source) out.push({ lineId: e.line.id, offset: e.offset });
  }
  return out;
}

/* ───────────────────────────── copy ───────────────────────────── */

/** "Copy visible" text per visual row: divider `── text ──`, block header then output indented
 * 4 spaces, plus `… N more lines` if folded. The "show less" control returns null (skipped). */
export function formatVisualRowForCopy(row: VisualRow): string | null {
  if (row.kind === "raw") return formatLineForCopy(row.line);
  if (row.kind === "divider") return `${formatTime(row.line.tsMs)} ${levelBadge(row.line.level)} ${row.line.source}  ── ${oneLine(row.line.text)} ──`;
  if (row.kind === "head") {
    const a = row.block.anchor;
    const desc = row.block.header.description === null ? "" : `  # ${row.block.header.description}`;
    return `${formatTime(a.tsMs)} ${levelBadge(row.block.error ? "error" : a.level)} ${a.source}  ${row.block.header.label}${desc}`;
  }
  if (row.kind === "out") return `    ${row.text}`;
  return row.expanded ? null : `    … ${row.hidden} more ${row.hidden === 1 ? "line" : "lines"}`;
}
