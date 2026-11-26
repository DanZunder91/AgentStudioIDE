/** ⌘F find for Agent Logs, pure. Unlike the filter it NAVIGATES (rows stay, matches marked). It
 * searches drawn text per row part, every output line folded or not (not Time/Level/Source);
 * non-overlapping occurrences (`editor/find/findModel.ts` rule), empty matches skipped. */

import { COLLAPSED_OUTPUT_LINES, oneLine, type Segment } from "./agentLogsFormat";
import type { Stream, StreamEntry } from "./agentLogsStream";

/* ───────────────────────────── the query ───────────────────────────── */

export interface FindSpec {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

export type CompiledFind = { ok: true; re: RegExp | null } | { ok: false; error: string };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spec as ONE global RegExp (`re: null` = nothing to find). No `u` flag, like the filter:
 * `u` rejects habitual escapes (`\-`, `\ `) the filter box accepts. */
export function compileFind(spec: FindSpec): CompiledFind {
  if (spec.query === "") return { ok: true, re: null };
  const flags = spec.caseSensitive ? "g" : "gi";
  if (!spec.regex) return { ok: true, re: new RegExp(escapeRegExp(spec.query), flags) };
  try {
    return { ok: true, re: new RegExp(spec.query, flags) };
  } catch (e) {
    // `new RegExp` only ever throws a SyntaxError.
    return { ok: false, error: (e as SyntaxError).message };
  }
}

export interface Range {
  from: number;
  to: number;
}

/** Every non-empty, non-overlapping match of `re` (a `g` RegExp) in `text`, in order. */
export function rangesIn(text: string, re: RegExp): Range[] {
  const out: Range[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0] === "") {
      // A zero-width match would loop forever at the same index; step past it.
      re.lastIndex += 1;
      continue;
    }
    out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/* ───────────────────────────── matches in the stream ───────────────────────────── */

type BlockEntry = Extract<StreamEntry, { kind: "block" }>;

/** Which drawn text of an entry a match is in. */
export type FindPart =
  | { kind: "text" }
  | { kind: "desc" }
  | { kind: "label" }
  | { kind: "out"; index: number };

export interface FindMatch extends Range {
  /** Index into `stream.entries` — stable between a stream and its find-expanded rebuild. */
  entry: number;
  part: FindPart;
}

/** The lookup key of one drawn text, shared by the matcher and the rows that paint it. */
export function partKey(e: StreamEntry, part: FindPart): string {
  if (e.kind !== "block") return `l:${e.line.id}`;
  if (part.kind === "desc") return `d:${e.block.key}`;
  if (part.kind === "out") return `o:${e.block.key}:${part.index}`;
  return `h:${e.block.key}`;
}

/** Every match in the stream, in reading order. */
export function findInStream(stream: Stream, re: RegExp): FindMatch[] {
  const out: FindMatch[] = [];
  const add = (entry: number, part: FindPart, text: string): void => {
    for (const r of rangesIn(text, re)) out.push({ entry, part, ...r });
  };
  stream.entries.forEach((e, entry) => {
    if (e.kind !== "block") {
      add(entry, { kind: "text" }, oneLine(e.line.text));
      return;
    }
    const { header, output } = e.block;
    if (header.description !== null) add(entry, { kind: "desc" }, oneLine(header.description));
    add(entry, { kind: "label" }, oneLine(header.label));
    output.forEach((text, index) => add(entry, { kind: "out", index }, text));
  });
  return out;
}

/** Blocks find must expand (a match behind the fold), minus `touched` ones folded by hand
 * while the bar is open, or "show less" would be dead. */
export function findExpansions(
  stream: Stream,
  matches: readonly FindMatch[],
  touched: Readonly<Record<string, true>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of matches) {
    if (m.part.kind !== "out" || m.part.index < COLLAPSED_OUTPUT_LINES) continue;
    // Only a block has output parts.
    const e = stream.entries[m.entry] as BlockEntry;
    if (touched[e.block.key] === undefined) out[e.block.key] = true;
  }
  return out;
}

/** The visual row a match is drawn on; one folded away by hand lands on its "show N more" row. */
export function matchRow(stream: Stream, m: FindMatch): number {
  const e = stream.entries[m.entry];
  if (m.part.kind !== "out") return e.offset;
  // Only a block has output parts. The first COLLAPSED lines always show; the rest only unfolded.
  const shown = (e as BlockEntry).expanded || m.part.index < COLLAPSED_OUTPUT_LINES;
  return e.offset + 1 + (shown ? m.part.index : COLLAPSED_OUTPUT_LINES);
}

/** One painted match: its range and its ordinal in the whole match list. */
export interface Mark extends Range {
  ord: number;
}

/** The marks of every drawn text, by `partKey` — built once per match list, looked up per row. */
export function marksByPart(stream: Stream, matches: readonly FindMatch[]): ReadonlyMap<string, readonly Mark[]> {
  const out = new Map<string, Mark[]>();
  matches.forEach((m, ord) => {
    const key = partKey(stream.entries[m.entry], m.part);
    const mark = { from: m.from, to: m.to, ord };
    const list = out.get(key);
    if (list) list.push(mark);
    else out.set(key, [mark]);
  });
  return out;
}

/* ───────────────────────────── the drawer ───────────────────────────── */

/** A drawer text block: the line's text, its detail, the paired result. */
export interface DetailPart {
  id: string;
  text: string;
}

export interface DetailMatch extends Range {
  part: string;
}

/** Every match in the drawer's texts, top to bottom. */
export function findInDetail(parts: readonly DetailPart[], re: RegExp): DetailMatch[] {
  return parts.flatMap((p) => rangesIn(p.text, re).map((r) => ({ part: p.id, ...r })));
}

/* ───────────────────────────── cursor + reveal ───────────────────────────── */

/** The stored ordinal, clamped into the CURRENT match list (lines arrive, the ring drops some). */
export function clampCursor(cursor: number, total: number): number {
  return total === 0 ? 0 : Math.min(Math.max(cursor, 0), total - 1);
}

/** `cursor` stepped by `delta`, wrapping at both ends. */
export function stepCursor(cursor: number, delta: number, total: number): number {
  if (total === 0) return 0;
  return (((clampCursor(cursor, total) + delta) % total) + total) % total;
}

/** `scrollTop` revealing visual row `row`, or null if visible. Index arithmetic (the row may
 * not be in the DOM); row i sits at `(i + 1) · rowH`, and an out-of-view row is centred. */
export function revealScrollTop(row: number, scrollTop: number, viewport: number, rowH: number): number | null {
  const top = (row + 1) * rowH;
  if (top >= scrollTop + rowH && top + rowH <= scrollTop + viewport) return null;
  const centred = top - rowH - Math.floor((viewport - rowH) / rowH / 2) * rowH;
  return Math.max(centred, 0);
}

/* ───────────────────────────── painting ───────────────────────────── */

/** A run of text with the highlight kind it came from and the match (ordinal) covering it. */
export interface Piece {
  kind: Segment["kind"];
  text: string;
  /** The ordinal of the match covering this run, or null. */
  ord: number | null;
}

/** Split highlight segments at match boundaries (both range over the SAME text), so each
 * character lands in one piece with its colour and mark. */
export function markSegments(segs: readonly Segment[], marks: readonly Mark[]): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  let mi = 0;
  for (const seg of segs) {
    const end = pos + seg.text.length;
    let at = pos;
    while (at < end) {
      while (mi < marks.length && marks[mi].to <= at) mi++;
      const m = marks[mi];
      if (m === undefined || m.from >= end) {
        out.push({ kind: seg.kind, text: seg.text.slice(at - pos), ord: null });
        break;
      }
      if (m.from > at) {
        out.push({ kind: seg.kind, text: seg.text.slice(at - pos, m.from - pos), ord: null });
        at = m.from;
      }
      const stop = Math.min(m.to, end);
      out.push({ kind: seg.kind, text: seg.text.slice(at - pos, stop - pos), ord: m.ord });
      at = stop;
    }
    pos = end;
  }
  return out;
}
