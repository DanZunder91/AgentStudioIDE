/**
 * Context-window formatting and geometry — every string and every proportion the
 * "Context window" card renders, and nothing else.
 *
 * Pure, for the same reasons as `usageFormat.ts` and `metricsFormat.ts`: no clock (the
 * relative "measured 3 min ago" takes `nowMs` as a parameter), no locale (no
 * `toLocaleString`), no DOM. The card's two drawings — the stacked bar and the
 * `/context`-style grid — are computed HERE as plain numbers and arrays, so their
 * proportions are pinned by jsdom tests with literal expectations instead of only by
 * a screenshot. The browser tier then checks the one thing jsdom cannot: that the
 * real layout engine honours those numbers.
 */

import type { ContextError } from "./contextIpc";
import type { ContextCategory, ContextUsage } from "./contextTypes";

/** What a number we cannot read honestly renders as — the dashboard's own em dash. */
export const UNKNOWN = "—";

/* ── numbers ────────────────────────────────────────────────────────────────── */

/**
 * Tokens in the CLI's own short form: `717`, `2.3k`, `290.7k`, `33k`, `1m`, `1.2m`.
 *
 * Deliberately NOT `metricsFormat.formatTokens`, which renders `33.0k` / `1.0M`: this
 * card sits beside the user's memory of `/context`, which prints `33k` and `1m`, and
 * two spellings of the same reading is how a user starts wondering which is right. So
 * the trailing `.0` is dropped and the million suffix is a lower-case `m`, exactly as
 * the CLI prints them.
 *
 * Rounds to one decimal of the unit, and the unit is chosen AFTER rounding — so
 * 999,950 is `1m`, never `1000k`.
 */
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

/**
 * A category's share of the window: `0.2%`, `25.8%`, `29%`.
 *
 * One decimal at most, matching the CLI (which prints `0.2%` for the system prompt —
 * rounding that to `0%` would claim the system prompt costs nothing). Clamped to
 * 0..=100 and `NaN` → `0%`, for the reason `usageFormat.clampPct` gives: across an IPC
 * seam "in practice" is not a guarantee, and `-3%` or `NaN%` reads as a broken app.
 */
export function formatContextPct(pct: number): string {
  return `${trimZero(clampPct(pct))}%`;
}

function clampPct(pct: number): number {
  if (Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** Fill severity of the window, painted on the header chip via `data-tone`. */
export type ContextTone = "ok" | "warn" | "danger";

/**
 * Green below 50%, amber from 50% to 80%, red above 80%.
 *
 * Not `usageTone`'s 60/90: a usage window that is 60% spent is a budget, while a
 * context window that is 80% full is a few turns from compaction, and compaction is
 * the event the user is watching for. 80 itself is still amber ("> 80%" is the red
 * band); 50 is already amber.
 */
export function contextTone(pct: number): ContextTone {
  const p = clampPct(pct);
  if (p > 80) return "danger";
  if (p >= 50) return "warn";
  return "ok";
}

/**
 * `"measured just now"` / `"measured 3 min ago"` / `"measured 2 h ago"` / `"measured 1 d ago"`.
 *
 * Under a minute — and a reading timestamped AFTER the caller's tick, which happens
 * whenever a refresh lands between two 30 s clock ticks — reads "just now": the panel's
 * clock is the stale one there, not the reading.
 */
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

/**
 * The header's summary: `"290.7k of 1m · compacts at 967k"`.
 *
 * "compacts at" is `window − autocompact buffer` — the point the bar's thin marker sits
 * at. When the CLI printed no buffer row (autocompact off), there is no compaction point
 * to name, so the clause is dropped rather than shown as "compacts at 1m", which would
 * be a claim about an event that will not happen.
 */
export function formatContextSummary(usage: ContextUsage): string {
  const head = `${formatContextTokens(usage.usedTokens)} of ${formatContextTokens(usage.windowTokens)}`;
  const buffer = usage.categories.find((c) => c.key === BUFFER_KEY);
  if (!buffer) return head;
  return `${head} · compacts at ${formatContextTokens(usage.windowTokens - buffer.tokens)}`;
}

/* ── colours ────────────────────────────────────────────────────────────────── */

/**
 * The categories with a fixed colour, mapped to their CSS variable in `context.css`.
 * `agents` and `custom-agents` are one colour: the CLI has printed both labels for the
 * same row across versions, and the row should not change colour on a CLI upgrade.
 */
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

/**
 * The colour of a category, as a `var(...)` reference.
 *
 * A key the CLI adds tomorrow still gets a colour — and the SAME colour on every
 * render, every refresh and every machine, because the slot is a hash of the key
 * rather than its position (a position-based fallback would repaint every unknown
 * row whenever a row above it appeared or vanished).
 */
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

/**
 * `context.css`'s palette as hex, by variable. A canvas cannot read a CSS variable, and the
 * Village's Seats hall (its seats are the `/context` grid's cells) dresses each seated
 * character in its category's colour — the same one the card paints.
 * `contextFormat.test.ts` reads `context.css` and holds every entry here equal to it, so the
 * two can never drift apart.
 */
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

/**
 * Lay the categories out along the bar, widths ∝ tokens / window, in printed order.
 *
 * Widths come from TOKENS, not from the printed percent: the percent is rounded to one
 * decimal by the CLI, so 0.07% prints as `0.1%` and eight rounded percents can sum to
 * 100.2. Tokens are what the user's eye should be measuring.
 *
 * The marker's position is the buffer segment's own left edge, computed by the same
 * running sum — so the marker and the hatched segment can never visibly disagree, even
 * when the categories do not sum exactly to the window. A zero window (a reading we
 * cannot scale) yields zero widths rather than `NaN%`, which a browser drops silently
 * and would leave every segment at its content width.
 */
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

/**
 * The grid, cell by cell: the category key each of the 200 cells is painted with.
 *
 * - A used category with ANY tokens gets at least one cell. 717 tokens is 0.14 of a
 *   cell; rounding it to zero would make a row that is in the legend vanish from the
 *   picture, and "it's in the list but not the grid" reads as a bug.
 * - The autocompact buffer is counted like a used category (it is reserved space).
 * - Free space is the REMAINDER, not its own rounded count, so the grid always has
 *   exactly 200 cells no matter how the others round. It is drawn where the CLI prints
 *   it (before the buffer); if the CLI printed no free-space row, the remainder is
 *   still drawn, just before the buffer — the cells exist whether or not they are named.
 * - An overfull reading (more than the window, which the CLI should never print) is
 *   cut at 200: the grid is the window, and nothing past it can be drawn.
 */
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

/**
 * One short, TRUE sentence per code — what happened and the next move. Same rules as
 * `describeUsageError`: never blame the user, never invent a cause we did not observe,
 * and never point at a retry that cannot help (`parse`, `bad-session`).
 *
 * `no-session` is not a failure at all — a freshly spawned agent simply has no
 * conversation to measure yet — so its sentence says what WILL happen, and the card
 * renders it in the calm (not the warning) colour.
 */
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
