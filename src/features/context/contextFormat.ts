/** Every string and proportion the Context window card renders. Pure (no clock, locale or DOM), so
 * jsdom tests pin the geometry with literals; the browser tier checks the real layout. */

import type { ContextError } from "./contextIpc";
import type { ContextCategory, ContextUsage } from "./contextTypes";

/** What a number we cannot read honestly renders as — the dashboard's own em dash. */
export const UNKNOWN = "—";

/* ── numbers ────────────────────────────────────────────────────────────────── */

/** The CLI's own short form (717, 2.3k, 33k, 1m), not metricsFormat's 33.0k / 1.0M: users compare
 * it with /context. The unit is chosen AFTER rounding, so 999,950 is 1m, never 1000k. */
export function formatContextTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1_000) return `${Math.round(n)}`;
  const k = Math.round(n / 100) / 10;
  if (k < 1_000) return `${trimZero(k)}k`;
  return `${trimZero(Math.round(n / 100_000) / 10)}m`;
}

/** `33` → `"33"`, `290.7` → `"290.7"` — one decimal at most, never a trailing `.0`. */
function trimZero(x: number): string {
  return `${Number(x.toFixed(1))}`;
}

/** At most one decimal, like the CLI (0.2% must not round to 0%). Clamped, NaN to 0%: values
 * across IPC are not guaranteed. */
export function formatContextPct(pct: number): string {
  return `${trimZero(clampPct(pct))}%`;
}

function clampPct(pct: number): number {
  if (Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** Fill severity of the window, painted on the header chip via `data-tone`. */
export type ContextTone = "ok" | "warn" | "danger";

/** Green below 50, amber 50 to 80 inclusive, red above 80. Stricter than usageTone's 60/90: a
 * context window 80% full is a few turns from compaction. */
export function contextTone(pct: number): ContextTone {
  const p = clampPct(pct);
  if (p > 80) return "danger";
  if (p >= 50) return "warn";
  return "ok";
}

/** Under a minute, or a reading newer than the caller's tick (a refresh between 30 s ticks),
 * reads "just now". */
export function formatMeasuredAt(measuredAtMs: number, nowMs: number): string {
  const delta = nowMs - measuredAtMs;
  if (!(delta >= 60_000)) return "measured just now";
  if (delta < 3_600_000) return `measured ${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `measured ${Math.floor(delta / 3_600_000)} h ago`;
  return `measured ${Math.floor(delta / 86_400_000)} d ago`;
}

/* ── the two special categories ─────────────────────────────────────────────── */

/** The CLI's "Free space" row: the dark track in the bar, outlined cells in the grid. */
export const FREE_KEY = "free-space";
/** The CLI's "Autocompact buffer" row: hatched in the bar, crossed in the grid. */
export const BUFFER_KEY = "autocompact-buffer";

/** "290.7k of 1m · compacts at 967k" (window minus buffer, where the marker sits). With no buffer
 * row (autocompact off) the clause is dropped: there is no compaction point. */
export function formatContextSummary(usage: ContextUsage): string {
  const head = `${formatContextTokens(usage.usedTokens)} of ${formatContextTokens(usage.windowTokens)}`;
  const buffer = usage.categories.find((c) => c.key === BUFFER_KEY);
  if (!buffer) return head;
  return `${head} · compacts at ${formatContextTokens(usage.windowTokens - buffer.tokens)}`;
}

/* ── colours ────────────────────────────────────────────────────────────────── */

/** agents and custom-agents share a colour: the CLI has printed both labels for one row. */
const KNOWN_COLOURS: Readonly<Record<string, string>> = {
  "system-prompt": "--context-system-prompt",
  "system-tools": "--context-system-tools",
  "system-tools-deferred": "--context-system-tools-deferred",
  "mcp-tools": "--context-mcp-tools",
  "mcp-server-instructions": "--context-mcp-server-instructions",
  "memory-files": "--context-memory-files",
  skills: "--context-skills",
  "custom-agents": "--context-agents",
  agents: "--context-agents",
  messages: "--context-messages",
  [FREE_KEY]: "--context-free-space",
  [BUFFER_KEY]: "--context-autocompact-buffer",
};

/** How many `--context-extra-N` slots `context.css` declares for unknown keys. */
export const EXTRA_COLOURS = 6;

/** Unknown keys get a hashed slot, not a positional one, so their colour is stable everywhere. */
export function contextColour(key: string): string {
  return `var(${contextVar(key)})`;
}

/** The CSS variable a category is painted with (see {@link contextColour}). */
function contextVar(key: string): string {
  // `Object.hasOwn`, not a bare index: a key the CLI slugged to `constructor` or
  // `to-string`-alikes must not find `Object.prototype`'s members and paint `var(function…)`.
  if (Object.hasOwn(KNOWN_COLOURS, key)) return KNOWN_COLOURS[key];
  return `--context-extra-${hashKey(key) % EXTRA_COLOURS}`;
}

/** context.css's palette as hex, for canvas (the Village's Seats hall). contextFormat.test.ts holds
 * it equal to context.css. */
export const CONTEXT_HEX: Readonly<Record<string, string>> = {
  "--context-system-prompt": "#a1a1aa",
  "--context-system-tools": "#71717a",
  "--context-system-tools-deferred": "#52525b",
  "--context-mcp-tools": "#22b8cf",
  "--context-mcp-server-instructions": "#138a9c",
  "--context-memory-files": "#d97430",
  "--context-skills": "#d4b83a",
  "--context-agents": "#4cae6b",
  "--context-messages": "#a371f7",
  "--context-free-space": "#262c36",
  "--context-autocompact-buffer": "#5b6472",
  "--context-extra-0": "#f778ba",
  "--context-extra-1": "#79c0ff",
  "--context-extra-2": "#ffa198",
  "--context-extra-3": "#7ee787",
  "--context-extra-4": "#d2a8ff",
  "--context-extra-5": "#e3b341",
};

/** A category's colour as hex, for a canvas — the same colour {@link contextColour} names. */
export function contextHex(key: string): string {
  return CONTEXT_HEX[contextVar(key)];
}

/** djb2 — tiny, stable, and good enough to spread a handful of slugs over six slots. */
function hashKey(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h;
}

/* ── geometry: the stacked bar ──────────────────────────────────────────────── */

/** One bar segment: its row, and where it sits as a percent of the window. */
export interface BarSegment {
  category: ContextCategory;
  /** Left edge, percent of the window. */
  startPct: number;
  /** Width, percent of the window. */
  widthPct: number;
}

/** The whole bar: segments in printed order, and the compaction marker's position. */
export interface BarLayout {
  segments: BarSegment[];
  /** Left edge of the autocompact buffer, percent — `null` when there is none. */
  compactAtPct: number | null;
}

/** Widths come from tokens, not the CLI's rounded percents (which can sum past 100). The marker is
 * the buffer segment's left edge from the same running sum, so they never disagree. A zero window
 * yields zero widths, not NaN% (which browsers drop silently). */
export function barLayout(usage: ContextUsage): BarLayout {
  const capacity = usage.windowTokens > 0 ? usage.windowTokens : 0;
  let cursor = 0;
  let compactAtPct: number | null = null;
  const segments = usage.categories.map((category) => {
    const widthPct = capacity === 0 ? 0 : (Math.max(0, category.tokens) / capacity) * 100;
    const startPct = cursor;
    if (category.key === BUFFER_KEY) compactAtPct = startPct;
    cursor += widthPct;
    return { category, startPct, widthPct };
  });
  return { segments, compactAtPct };
}

/* ── geometry: the /context grid ────────────────────────────────────────────── */

export const GRID_COLUMNS = 20;
export const GRID_ROWS = 10;
/** 200 cells, so each cell is 0.5% of the window — `/context`'s own resolution. */
export const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;

/** 200 cells. Any used category (the buffer included) gets at least one cell; free space is the
 * remainder, drawn before the buffer even if unnamed, so the total is always 200. An overfull
 * reading is cut at 200. */
export function gridCells(usage: ContextUsage): string[] {
  const capacity = usage.windowTokens;
  const count = (c: ContextCategory): number => {
    if (capacity <= 0 || c.tokens <= 0) return 0;
    return Math.max(1, Math.round((c.tokens / capacity) * GRID_CELLS));
  };
  const occupied = usage.categories
    .filter((c) => c.key !== FREE_KEY)
    .reduce((sum, c) => sum + count(c), 0);
  const free = Math.max(0, GRID_CELLS - occupied);

  const cells: string[] = [];
  let freeDrawn = false;
  const drawFree = (): void => {
    if (freeDrawn) return;
    freeDrawn = true;
    for (let i = 0; i < free; i++) cells.push(FREE_KEY);
  };
  for (const c of usage.categories) {
    if (c.key === FREE_KEY) {
      drawFree();
      continue;
    }
    if (c.key === BUFFER_KEY) drawFree();
    for (let i = 0; i < count(c); i++) cells.push(c.key);
  }
  drawFree();
  return cells.slice(0, GRID_CELLS);
}

/* ── errors ─────────────────────────────────────────────────────────────────── */

/** One true sentence per code: never blame the user, invent a cause, or offer a useless retry.
 * no-session is not a failure (a fresh agent), so the card shows it in the calm colour. */
export function describeContextError(code: ContextError): string {
  switch (code) {
    case "no-session":
      return "This agent hasn't had a conversation yet — its context appears after the first prompt.";
    case "cli-missing":
      return "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry.";
    case "bad-session":
      return "This agent isn't a live root session the app can read — its context can't be measured.";
    case "cli-failed":
      return "The claude CLI ran but exited with an error — retry, or run /context in the agent's terminal to see what it reports.";
    case "timeout":
      return "The claude CLI did not answer in time — retry in a moment.";
    case "parse":
      return "The claude CLI answered, but not with a table this card can read — its wording has probably changed, so retrying will not help.";
    case "unknown":
      return "The context read failed for an unrecognized reason — retrying may help.";
  }
}

/** True for the codes that are a calm state rather than something going wrong. */
export function isCalmError(code: ContextError): boolean {
  return code === "no-session";
}
