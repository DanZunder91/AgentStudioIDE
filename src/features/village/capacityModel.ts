/**
 * Capacity — the pure model behind the Seats, Memory and Usage buildings and the
 * context bars over the agents' desks. Both the Village and the City show the agents' seats — the
 * available ones, and of the reserved ones how many are in use — and the memory available to
 * agents, since more agents are called when there is room.
 *
 * Inputs, all read-only and none of them a new poller:
 *   - the machine sample (`machine_capacity`, src-tauri/src/capacity.rs): CPUs, RAM, and the
 *     `claude` sessions' resident memory;
 *   - the village model's agents (roots + sub-agents) — who holds a seat;
 *   - the usage strip's last reading (`usageStore`): the 5-hour and weekly windows;
 *   - the context card's readings (`contextStore`), per IDE agent.
 *
 * THE SEATS ARE THE CONTEXT WINDOW (`/context`'s grid is what the seats mean, shown as characters
 * in both views, the Village and the City). The Village's Seats house and the City HQ's Seats floor are one hall of
 * `/context`'s own 200 seats (20 × 10, one seat = 0.5% of the window) for the agent selected in the
 * rail: a character in its category's colour on every taken seat, an empty seat for free space, a
 * reserved one for the autocompact buffer (`hallFrame`, cell by cell from the Context card's
 * `gridCells`). The reading is the Context card's (`contextStore`).
 *
 * THE ESTIMATE IS A YARDSTICK, not a limit. Claude Code does not publish how many agents a machine
 * may run at once. What it has is a per-workflow concurrent-agent gate
 * (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, default `min(16, max(2, CPUs − 2))`, read off the
 * installed CLI): how many `agent()` calls ONE workflow run lets go at once. The City's lounge card
 * measures every live agent against it. The formula and the words that say so live together here,
 * so the figure is never presented as a fact about the CLI.
 *
 * THE CITY HAS A LOUNGE (an area under the street where agents just wait to be called, and the
 * busy ones go to the building that needs them): a waiting room under the street with a FIXED
 * `LOUNGE_SEATS` benches, whatever the machine. Its board reads "Lounge 34/64" (who holds a bench /
 * the benches) — not "Seats", since the Seats are the context window. Past 64 holders it grows a whole bench row
 * (`LOUNGE_ROW_SEATS`) at a time — so it still seats everyone — and the board counts against the
 * benches it has ("Lounge 70/80"). The estimate stays a yardstick on its hover card.
 *
 * Every missing input is its own state, said in words: no sample yet, the read failed, this OS does
 * not report it. A missing figure is never drawn as a zero.
 */

import type { ContextEntry } from "../context/contextStore";
import {
  BUFFER_KEY,
  FREE_KEY,
  GRID_CELLS,
  contextTone,
  describeContextError,
  formatContextPct,
  formatContextTokens,
  formatMeasuredAt,
  gridCells,
} from "../context/contextFormat";
import { describeUsageError, formatFetchedAt, formatPct, formatResetsAt, usageTone } from "../usage/usageFormat";
import type { UsageErrorCode, UsageSnapshot, UsageWindow } from "../usage/usageTypes";
import type {
  CapacityFrame,
  CapacityKind,
  CapacityLayout,
  HallFrame,
  MachineCapacityWire,
  Meter,
  SeatHolder,
  VillageActivity,
  VillageAgent,
} from "./villageTypes";
import { LOUNGE_ROW_SEATS } from "./engine/city";

/** The seat estimate's bounds and the CPUs it leaves to everything else. */
export const SEAT_MIN = 2;
export const SEAT_MAX = 16;
export const SEAT_RESERVED_CPUS = 2;

/**
 * Claude Code's workflow concurrency rule: `min(16, max(2, CPUs − 2))`. null when the CPU count is
 * unknown (or not a usable number) — never a guessed default.
 */
export function estimateSeats(cpus: number | null): number | null {
  if (cpus === null || !Number.isFinite(cpus) || cpus < 1) return null;
  return Math.min(SEAT_MAX, Math.max(SEAT_MIN, Math.floor(cpus) - SEAT_RESERVED_CPUS));
}

/** The City's lounge: its fixed seats (always 64). */
export const LOUNGE_SEATS = 64;

/**
 * Seats in the City's lounge for `holders` seat holders: `LOUNGE_SEATS` while they fit, else the
 * holders rounded UP to whole bench rows — so everyone has a seat, and the lounge does not rebuild
 * each time one more agent appears. The machine has no say: the lounge is not the estimate.
 */
export function loungeSeats(holders: number): number {
  return Math.max(LOUNGE_SEATS, Math.ceil(holders / LOUNGE_ROW_SEATS) * LOUNGE_ROW_SEATS);
}

/**
 * What the capacity buildings must have room for: in the City's `lounge` a seat for every live agent,
 * at least its fixed 64 (`loungeSeats`). The Village's Seats hall is always `/context`'s 200 seats,
 * so its layout never changes as agents come and go (0: the world ignores it).
 */
export function capacityLayout(agents: readonly VillageAgent[], lounge = false): CapacityLayout {
  return { seats: lounge ? loungeSeats(seatHolders(agents).length) : 0 };
}

/** Mid-turn — the HUD's "active" set (villageView `countAgents`), so the two never disagree. */
const ACTIVE: ReadonlySet<VillageActivity> = new Set(["typing", "reading", "thinking", "waiting"]);

/** A context reading older than this is drawn grey: its fill, but no claim that it is current. */
export const CONTEXT_STALE_MS = 10 * 60_000;

/** A finished agent (done / error) has given its seat back; a console is not an agent. */
const FINISHED: ReadonlySet<VillageActivity> = new Set(["done", "error"]);

/** Who holds a seat: every live agent, root or sub-agent, in the order given. */
export function seatHolders(agents: readonly VillageAgent[]): SeatHolder[] {
  return agents
    .filter((a) => !a.consoleId && !FINISHED.has(a.activity))
    .map((a) => ({ key: a.key, activity: a.activity, parentKey: a.parentKey }));
}

/** Who sits at which desk. */
export interface DeskAssignment {
  desks: (SeatHolder | null)[];
}

/**
 * Seat `holders` at `seats` desks, STICKY to `prev`: whoever held a desk keeps it (so a desk never
 * swaps people between two frames); a newcomer, or someone whose desk is gone (the room shrank),
 * takes the first free desk, in the order given. `capacityLayout` gives at least one desk per
 * holder, so everyone sits.
 */
export function assignDesks(prev: DeskAssignment | null, holders: readonly SeatHolder[], seats: number): DeskAssignment {
  const live = new Map(holders.map((h) => [h.key, h]));
  const desks: (SeatHolder | null)[] = new Array<SeatHolder | null>(Math.max(0, seats)).fill(null);
  const placed = new Set<string>();
  prev?.desks.forEach((h, i) => {
    const now = h && live.get(h.key);
    if (now && i < desks.length) {
      desks[i] = now;
      placed.add(now.key);
    }
  });
  const waiting: SeatHolder[] = [];
  for (const h of live.values()) if (!placed.has(h.key)) waiting.push(h);
  for (let i = 0; i < desks.length && waiting.length > 0; i++) if (!desks[i]) desks[i] = waiting.shift() as SeatHolder;
  return { desks };
}

/** 0..1, NaN → 0. */
function clamp01(x: number): number {
  return Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x));
}

/** The agents' resident memory in bytes (CLI + the tools it started), or null when this OS has no process table. */
export function agentBytes(machine: MachineCapacityWire | null): number | null {
  const a = machine?.agents;
  return a ? a.claudeRssBytes + a.toolRssBytes : null;
}

/** RAM in use by everything, bytes, or null when the OS gave neither figure. */
export function usedBytes(machine: MachineCapacityWire | null): number | null {
  if (machine?.totalMemBytes == null || machine.availableMemBytes == null) return null;
  return Math.max(0, machine.totalMemBytes - machine.availableMemBytes);
}

/** Shares of physical RAM: held by the agents, and in use by everything. null = unknown. */
export function memoryShares(machine: MachineCapacityWire | null): CapacityFrame["memory"] {
  const total = machine?.totalMemBytes ?? null;
  if (total === null || total <= 0) return { agents: null, used: null };
  const agents = agentBytes(machine);
  const used = usedBytes(machine);
  return {
    agents: agents === null ? null : clamp01(agents / total),
    used: used === null ? null : clamp01(used / total),
  };
}

/** The 5-hour window: the CLI's "Current session" row. */
export function sessionWindow(snapshot: UsageSnapshot | null): UsageWindow | null {
  return snapshot?.windows.find((w) => w.key === "current-session") ?? null;
}

/** The weekly window: "Current week (all models)", else the first weekly row the CLI printed. */
export function weekWindow(snapshot: UsageSnapshot | null): UsageWindow | null {
  const windows = snapshot?.windows ?? [];
  return windows.find((w) => w.key === "current-week-all-models") ?? windows.find((w) => w.key.startsWith("current-week")) ?? null;
}

/** A usage window as a meter, on the usage strip's own bands (60 / 90). */
export function usageMeter(w: UsageWindow | null): Meter | null {
  return w ? { fill: clamp01(w.usedPct / 100), tone: usageTone(w.usedPct) } : null;
}

/**
 * Context-window fill per agent key, on the context card's bands (50 / 80) — only for agents the
 * card has a reading for. An agent without one gets no bar at all, never an empty one.
 */
export function contextMeters(
  agents: readonly VillageAgent[],
  entries: Readonly<Record<string, ContextEntry>>,
  nowMs: number,
): Record<string, Meter> {
  const out: Record<string, Meter> = {};
  for (const a of agents) {
    const data = a.ideAgentId ? entries[a.ideAgentId]?.data : null;
    if (!data) continue;
    // There is no context poller (by design): an old reading keeps its fill but goes grey.
    const stale = nowMs - data.measuredAtMs > CONTEXT_STALE_MS;
    out[a.key] = { fill: clamp01(data.usedPercent / 100), tone: stale ? "unknown" : contextTone(data.usedPercent) };
  }
  return out;
}

/** "512 MB", "2.1 GB". */
export function formatBytes(n: number): string {
  const GB = 1024 ** 3;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** "41%", or "?" without a reading. */
function pctOr(w: UsageWindow | null): string {
  return w ? formatPct(w.usedPct) : "?";
}

/** Everything the capacity buildings are made from. */
export interface CapacityInputs {
  /** The last machine sample; null = none yet (or the read failed: `machineError`). */
  machine: MachineCapacityWire | null;
  machineError: string | null;
  /** The village model's agents (roots + sub-agents; consoles are skipped). */
  agents: readonly VillageAgent[];
  /** Whether `agents` includes the outside-the-IDE ones (the HUD toggle) — the seats card says which. */
  includesOutside: boolean;
  usage: UsageSnapshot | null;
  usageError: UsageErrorCode | null;
  /** The context card's readings, by IDE agent id. */
  context: Readonly<Record<string, ContextEntry>>;
  /** The wall clock (unix ms) the context readings are aged against. */
  nowMs: number;
  /**
   * The City: it has the lounge under the street — `loungeSeats` benches, and a board and card that
   * count against them. Absent / false: the Village, which has no lounge.
   */
  lounge?: boolean;
  /** The Seats hall (both views): whose context window it seats — the agent selected in the rail. */
  hallAgent?: HallAgent;
}

/**
 * Whose context the Seats hall shows: the rail's selection, when it can be measured. A
 * reading exists only for a ROOT agent the IDE runs (`context_usage` resumes its session); a
 * sub-agent has none of its own — the Context card's own rule (`ContextBar.targetOf`).
 */
export type HallAgent =
  | { kind: "none" }
  | { kind: "sub-agent"; label: string }
  | { kind: "ready"; agentId: string; label: string };

/** This frame's capacity picture. `prev` keeps the lounge's bench holders in place (see `assignDesks`). */
export function capacityFrame(input: CapacityInputs, prev: DeskAssignment | null): CapacityFrame {
  const holders = seatHolders(input.agents);
  const desks = input.lounge ? assignDesks(prev, holders, loungeSeats(holders.length)).desks : [];
  const hall = hallFrame(input);
  const agents = agentBytes(input.machine);
  const total = input.machine?.totalMemBytes ?? null;
  const session = sessionWindow(input.usage);
  const week = weekWindow(input.usage);
  return {
    desks,
    hall,
    memory: memoryShares(input.machine),
    usage: { session: usageMeter(session), week: usageMeter(week) },
    context: contextMeters(input.agents, input.context, input.nowMs),
    captions: {
      seats: hallCaption(hall),
      memory: agents !== null && total !== null ? `Memory ${formatBytes(agents)}` : "Memory ?",
      usage: `Usage ${pctOr(session)} · ${pctOr(week)}`,
      lounge: input.lounge ? `Lounge ${desks.filter(Boolean).length}/${desks.length}` : "",
    },
    gaugeCaptions: [`5h ${pctOr(session)}`, `week ${pctOr(week)}`],
  };
}

// ───────────────────────────── the Seats hall ─────────────────────────────

/** Seats in the hall: `/context`'s own grid, one seat per 0.5% of the window. */
export const HALL_SEATS = GRID_CELLS;

/** The hall agent's last successful reading, or null (nothing measurable selected, or not read yet). */
function hallReading(input: CapacityInputs): ContextEntry["data"] {
  const who = input.hallAgent;
  return who?.kind === "ready" ? (input.context[who.agentId]?.data ?? null) : null;
}

/** The Seats hall: the selected agent's context window, seat by seat (`gridCells`). */
export function hallFrame(input: CapacityInputs): HallFrame {
  const data = hallReading(input);
  if (!data) return { cells: null, usedPct: null, tone: "unknown" };
  return { cells: gridCells(data), usedPct: data.usedPercent, tone: contextTone(data.usedPercent) };
}

/** A hall's seats, counted: taken (a category's tokens), reserved (the autocompact buffer) and free. */
export function hallCounts(cells: readonly string[]): { taken: number; reserved: number; free: number } {
  let reserved = 0;
  let free = 0;
  for (const c of cells) {
    if (c === FREE_KEY) free++;
    else if (c === BUFFER_KEY) reserved++;
  }
  return { taken: cells.length - reserved - free, reserved, free };
}

/** The hall's board: "Seats 23/200" — taken of all its seats — or "Seats ?" without a reading. */
export function hallCaption(hall: HallFrame): string {
  return hall.cells ? `Seats ${hallCounts(hall.cells).taken}/${hall.cells.length}` : "Seats ?";
}

// ───────────────────────────── hover cards ─────────────────────────────

/** A capacity building's hover card: exact numbers, where they come from, and whether it is an estimate. */
export interface CapacityCard {
  kind: CapacityKind;
  title: string;
  rows: string[];
  source: string;
  /** true when the headline figure is an estimate (the seats). */
  estimate: boolean;
}

/** Why the machine figures are missing, in words; null when there is a sample. */
function machineGap(input: CapacityInputs): string | null {
  if (input.machine) return null;
  return input.machineError ? `Couldn't read this machine (${input.machineError})` : "Reading this machine…";
}

/** The seats card's last row: whose agents are counted (the HUD's outside-agents toggle). */
function countingRow(input: CapacityInputs): string {
  return input.includesOutside ? "Counting IDE and outside agents" : "Counting IDE agents only — outside agents are hidden (HUD toggle)";
}

/** The estimate as a yardstick for `held` holders: why there is none, or how far past it they are and the formula. */
function yardstick(input: CapacityInputs, held: number): string[] {
  const gap = machineGap(input);
  if (gap) return [gap];
  const cpus = input.machine?.logicalCpus ?? null;
  const estimate = estimateSeats(cpus);
  if (estimate === null) return ["This OS did not report a CPU count, so there is no estimate to measure against"];
  return [
    ...(held > estimate ? [`${held - estimate} past the estimate — all running`] : []),
    `Estimate: min(${SEAT_MAX}, max(${SEAT_MIN}, ${cpus} CPUs − ${SEAT_RESERVED_CPUS})) = ${estimate}`,
  ];
}

/**
 * The City's Seats card: the lounge's seats taken and free (its board's figure), how far past its 64
 * when it has grown, then the estimate as a yardstick — there even before a machine sample, since the
 * lounge does not depend on one.
 */
function loungeCard(input: CapacityInputs, frame: CapacityFrame): CapacityCard {
  const benches = frame.desks.length;
  const held = frame.desks.filter(Boolean) as SeatHolder[];
  const active = held.filter((h) => ACTIVE.has(h.activity)).length;
  return {
    kind: "lounge",
    title: "Lounge — agents at once",
    rows: [
      `${held.length} of ${benches} benches taken · ${active} active · ${benches - held.length} free`,
      ...(held.length > LOUNGE_SEATS
        ? [`${held.length - LOUNGE_SEATS} past the lounge's ${LOUNGE_SEATS} — it adds a row of ${LOUNGE_ROW_SEATS} benches whenever it fills`]
        : []),
      ...yardstick(input, held.length),
      countingRow(input),
    ],
    source: `A fixed lounge of ${LOUNGE_SEATS} benches, not a limit: a bench is taken by every live agent shown here, roots and sub-agents; the figures on the free benches stand for free benches, not for running processes. The estimate is a yardstick: Claude Code's per-workflow concurrent-agent gate (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS), not a limit on the machine`,
    estimate: true,
  };
}

/**
 * The Seats card (both views): whose context window the hall seats, the seats taken / reserved / free,
 * the CLI's model and tokens, and its "Estimated usage by category" table row by row — or, without a
 * reading, why not, in the Context card's own words.
 */
function hallCard(input: CapacityInputs, frame: CapacityFrame, nowMs: number): CapacityCard {
  const who = input.hallAgent ?? { kind: "none" };
  const entry = who.kind === "ready" ? input.context[who.agentId] : undefined;
  const data = entry?.data ?? null;
  const cells = frame.hall?.cells ?? null;
  let rows: string[];
  if (who.kind === "none") rows = ["No agent selected — select one in the agent rail to seat its context window here"];
  else if (who.kind === "sub-agent")
    rows = [`${who.label} is a sub-agent: /context has no reading of its own for it — select its root agent`];
  else if (!data || !cells)
    rows = [entry?.error ? describeContextError(entry.error) : `Reading ${who.label}'s context window…`];
  else {
    const { taken, reserved, free } = hallCounts(cells);
    rows = [
      `${taken} of ${cells.length} seats taken · ${reserved} reserved (autocompact buffer) · ${free} free`,
      `${data.model} · ${formatContextTokens(data.usedTokens)} / ${formatContextTokens(data.windowTokens)} tokens (${formatContextPct(data.usedPercent)})`,
      ...data.categories.map((c) => `${c.label}: ${formatContextTokens(c.tokens)} tokens (${formatContextPct(c.percent)})`),
      `One seat = 1/${HALL_SEATS} of the window (${formatContextTokens(data.windowTokens / HALL_SEATS)} tokens) · ${formatMeasuredAt(data.measuredAtMs, nowMs)}`,
      ...(entry?.error ? ["Last refresh failed — showing the previous reading"] : []),
    ];
  }
  return {
    kind: "seats",
    title: who.kind === "none" ? "Seats — context window" : `Seats — ${who.label}'s context window`,
    rows,
    source:
      "claude /context for the agent selected in the rail (the Context card's reading): the CLI's own estimate by category — a character on every taken seat, an empty seat for free space, a reserved one for the autocompact buffer",
    estimate: true,
  };
}

function memoryCard(input: CapacityInputs): CapacityCard {
  const m = input.machine;
  const rows: string[] = [];
  if (!m) rows.push(machineGap(input) as string);
  else {
    const a = m.agents;
    rows.push(
      a
        ? `Agents: ${formatBytes(a.claudeRssBytes + a.toolRssBytes)} resident — ${a.sessions} sessions, ${a.claudeProcesses} claude processes, ${a.toolProcesses} tool processes`
        : "Agents: unknown — this OS has no process table to read",
    );
    const used = usedBytes(m);
    rows.push(
      used !== null
        ? `In use (everything): ${formatBytes(used)} of ${formatBytes(m.totalMemBytes as number)} · ${formatBytes(m.availableMemBytes as number)} available`
        : "RAM: unknown — this OS did not report it",
    );
  }
  return {
    kind: "memory",
    title: "Memory — what the agents hold",
    rows,
    source: "machine_capacity: resident memory summed per process (shared pages count twice)",
    estimate: false,
  };
}

function usageCard(input: CapacityInputs, nowMs: number): CapacityCard {
  const snap = input.usage;
  const rows: string[] = [];
  const line = (name: string, w: UsageWindow | null): string => {
    if (!w) return `${name}: no reading`;
    const resets = formatResetsAt(w.resetsAtMs, nowMs);
    return `${name}: ${formatPct(w.usedPct)} used${resets ? ` · ${resets}` : ""}`;
  };
  if (snap) {
    rows.push(line("5-hour session", sessionWindow(snap)), line("Week (all models)", weekWindow(snap)));
    if (input.usageError) rows.push(`Last refresh failed — showing the previous reading`);
  } else if (input.usageError) rows.push(describeUsageError(input.usageError));
  else rows.push("No usage reading yet — the usage strip in the left rail takes it");
  return {
    kind: "usage",
    title: "Usage — your plan's limits",
    rows,
    source: snap ? `claude /usage, the usage strip's reading · ${formatFetchedAt(snap.fetchedAtMs, nowMs)}` : "claude /usage, the usage strip's reading",
    estimate: false,
  };
}

/** The hover card of one capacity building. */
export function capacityCard(kind: CapacityKind, input: CapacityInputs, frame: CapacityFrame, nowMs: number): CapacityCard {
  if (kind === "seats") return hallCard(input, frame, nowMs);
  if (kind === "lounge") return loungeCard(input, frame);
  if (kind === "memory") return memoryCard(input);
  return usageCard(input, nowMs);
}

/**
 * An agent's context line for its own hover card: "Context 29% · 290.7k / 1m · measured 3 min ago",
 * or null when the context card has no reading for it (then the card says nothing about context).
 */
export function contextLine(agent: VillageAgent, entries: Readonly<Record<string, ContextEntry>>, nowMs: number): string | null {
  const data = agent.ideAgentId ? entries[agent.ideAgentId]?.data : null;
  if (!data) return null;
  return `Context ${formatContextPct(data.usedPercent)} · ${formatContextTokens(data.usedTokens)} / ${formatContextTokens(data.windowTokens)} · ${formatMeasuredAt(data.measuredAtMs, nowMs)}`;
}
