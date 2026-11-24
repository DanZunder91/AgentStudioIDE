/**
 * capacityModel — the seat estimate (the City lounge card's yardstick), the lounge's bench count
 * and assignment (free / busy, everyone seated), the Seats HALL in both views (in the Village and
 * the City alike — the selected agent's `/context` window as 200 seats: taken / reserved / free, its
 * board and its card in every state), the City's Lounge board and card, the memory, usage and
 * context mappings (0 / 50 / 100 % / unknown), the captions and the hover cards' words, every
 * missing-data state included.
 *
 * Every expected value below is a literal worked out by hand, never read back from the code under test: a
 * reference reading (`REFERENCE`, a realistic `/context` reading) is seated cell by cell in `REFERENCE_CELLS`,
 * counted from `round(tokens / 1m × 200)` with at least one seat per used category.
 */

import { describe, expect, it } from "vitest";

import type { ContextEntry } from "../context/contextStore";
import type { ContextUsage } from "../context/contextTypes";
import type { UsageSnapshot, UsageWindow } from "../usage/usageTypes";
import {
  agentBytes,
  assignDesks,
  capacityCard,
  capacityFrame,
  capacityLayout,
  CONTEXT_STALE_MS,
  contextLine,
  contextMeters,
  estimateSeats,
  formatBytes,
  HALL_SEATS,
  hallCaption,
  hallCounts,
  hallFrame,
  LOUNGE_SEATS,
  loungeSeats,
  memoryShares,
  seatHolders,
  sessionWindow,
  usageMeter,
  usedBytes,
  weekWindow,
  type CapacityInputs,
  type HallAgent,
} from "./capacityModel";
import type { HallFrame, MachineCapacityWire, SeatHolder, VillageAgent } from "./villageTypes";
import { LOUNGE_ROW_SEATS } from "./engine/city";

const GB = 1024 ** 3;

function machine(over: Partial<MachineCapacityWire> = {}): MachineCapacityWire {
  return {
    logicalCpus: 12,
    totalMemBytes: 32 * GB,
    availableMemBytes: 12 * GB,
    agents: { sessions: 3, claudeProcesses: 5, claudeRssBytes: 1.5 * GB, toolProcesses: 9, toolRssBytes: 0.5 * GB },
    sampledAtMs: 1_000,
    ...over,
  };
}

function agent(key: string, over: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: key,
    folder: "proj",
    activity: "typing",
    tool: null,
    ideAgentId: `id-${key}`,
    lastActivityAt: null,
    ...over,
  };
}

function win(key: string, usedPct: number, resetsAtMs: number | null = null): UsageWindow {
  return { key, label: key, usedPct, resetsAtMs };
}

function snapshot(windows: UsageWindow[], fetchedAtMs = 0): UsageSnapshot {
  return { windows, fetchedAtMs };
}

function ctx(usedPercent: number, over: Partial<NonNullable<ContextEntry["data"]>> = {}): ContextEntry {
  return {
    data: {
      model: "m",
      usedTokens: 290_700,
      windowTokens: 1_000_000,
      usedPercent,
      categories: [],
      measuredAtMs: 0,
      ...over,
    },
    error: null,
    loading: false,
  };
}

function inputs(over: Partial<CapacityInputs> = {}): CapacityInputs {
  return {
    machine: machine(),
    machineError: null,
    agents: [],
    includesOutside: true,
    usage: null,
    usageError: null,
    context: {},
    nowMs: 0,
    ...over,
  };
}

const h = (key: string, activity: SeatHolder["activity"] = "typing", parentKey: string | null = null): SeatHolder => ({
  key,
  activity,
  parentKey,
});

/** `n` live agents a0..a(n-1). */
const many = (n: number): VillageAgent[] => Array.from({ length: n }, (_, i) => agent(`a${i}`));

/** The wall clock the hall's readings are aged against. */
const NOW = 1_785_200_000_000;

/**
 * A realistic `/context` reading: claude-opus-5-5,
 * 109.9k / 1m tokens (11%), read three minutes before NOW.
 */
const REFERENCE: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 109_900,
  windowTokens: 1_000_000,
  usedPercent: 11,
  categories: [
    { key: "system-prompt", label: "System prompt", tokens: 4_200, percent: 0.4 },
    { key: "system-tools", label: "System tools", tokens: 20_200, percent: 2.0 },
    { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
    { key: "memory-files", label: "Memory files", tokens: 2_100, percent: 0.2 },
    { key: "skills", label: "Skills", tokens: 6_800, percent: 0.7 },
    { key: "messages", label: "Messages", tokens: 75_900, percent: 7.6 },
    { key: "free-space", label: "Free space", tokens: 857_100, percent: 85.7 },
    { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
  ],
  measuredAtMs: NOW - 3 * 60_000,
};

/**
 * REFERENCE seated by hand, one seat = 5,000 tokens: system prompt 0.84 → 1; system tools 4.04 → 4;
 * MCP instructions 0.14 → 0, but a used row always gets 1; memory files 0.42 → 0 → 1; skills
 * 1.36 → 1; messages 15.18 → 15 — 23 taken. The buffer 6.6 → 7 reserved. Free = 200 − 23 − 7 = 170,
 * drawn where the CLI prints it (before the buffer).
 */
const REFERENCE_CELLS: string[] = [
  "system-prompt",
  ...Array<string>(4).fill("system-tools"),
  "mcp-server-instructions",
  "memory-files",
  "skills",
  ...Array<string>(15).fill("messages"),
  ...Array<string>(170).fill("free-space"),
  ...Array<string>(7).fill("autocompact-buffer"),
];

/** The rail's selection as the hall sees it. */
const ROOT: HallAgent = { kind: "ready", agentId: "root-a", label: "gazelle" };
const SUB: HallAgent = { kind: "sub-agent", label: "fix-tests" };
const NONE: HallAgent = { kind: "none" };

/** A context-store entry. */
const entry = (data: ContextUsage | null, error: ContextEntry["error"] = null, loading = false): ContextEntry => ({ data, error, loading });

/** A Village frame's inputs with `who` selected and `context` read. */
const hallInputs = (who: HallAgent | undefined, context: Record<string, ContextEntry> = {}, over: Partial<CapacityInputs> = {}) =>
  inputs({ hallAgent: who, context, nowMs: NOW, ...over });

/** The hall with no reading: every seat unknown, never empty. */
const UNKNOWN_HALL: HallFrame = { cells: null, usedPct: null, tone: "unknown" };

describe("estimateSeats — Claude Code's workflow rule min(16, max(2, CPUs − 2))", () => {
  it("leaves two CPUs, never below 2 seats, never above 16", () => {
    expect([1, 2, 3, 4, 5, 8, 12, 18, 19, 64].map(estimateSeats)).toEqual([2, 2, 2, 2, 3, 6, 10, 16, 16, 16]);
  });

  it("a fractional count is floored before the rule", () => {
    expect(estimateSeats(7.9)).toBe(5);
  });

  it("is unknown (null) without a usable CPU count — never a guessed default", () => {
    for (const bad of [null, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(estimateSeats(bad)).toBeNull();
  });
});

describe("capacityLayout — what the capacity buildings must have room for", () => {
  it("the Village: always 0 — its Seats hall is /context's fixed 200 seats, however many agents there are", () => {
    expect(capacityLayout([])).toEqual({ seats: 0 });
    expect(capacityLayout(many(3))).toEqual({ seats: 0 });
    expect(capacityLayout(many(3), false)).toEqual({ seats: 0 });
    expect(capacityLayout(many(100))).toEqual({ seats: 0 });
  });

  it("the City: the lounge's 64, then whole bench rows of 16 — finished agents and consoles hold no seat", () => {
    expect(capacityLayout([], true)).toEqual({ seats: 64 });
    expect(capacityLayout(many(3), true)).toEqual({ seats: 64 });
    expect(capacityLayout(many(64), true)).toEqual({ seats: 64 });
    expect(capacityLayout(many(65), true)).toEqual({ seats: 80 });
    const extra = [agent("d", { activity: "done" }), agent("e", { activity: "error" }), agent("term:1", { consoleId: "t1" })];
    expect(capacityLayout([...many(64), ...extra], true)).toEqual({ seats: 64 });
  });
});

describe("seatHolders — who holds a seat", () => {
  it("every live agent, roots and sub-agents, in order; finished ones and consoles do not", () => {
    const agents = [
      agent("a"),
      agent("s", { parentKey: "a", activity: "reading" }),
      agent("i", { activity: "idle" }),
      agent("w", { activity: "waiting" }),
      agent("d", { activity: "done" }),
      agent("e", { activity: "error" }),
      agent("term:1", { consoleId: "t1", activity: "typing" }),
    ];
    expect(seatHolders(agents)).toEqual([h("a"), h("s", "reading", "a"), h("i", "idle"), h("w", "waiting")]);
  });
});

describe("assignDesks — free and busy desks", () => {
  it("fills desks in order and leaves the rest free", () => {
    expect(assignDesks(null, [h("a"), h("b")], 4)).toEqual({ desks: [h("a"), h("b"), null, null] });
  });

  it("is sticky: a holder keeps its desk, with its new activity, whatever the input order", () => {
    const first = assignDesks(null, [h("a"), h("b"), h("c")], 3);
    const next = assignDesks(first, [h("c", "idle"), h("b"), h("a")], 3);
    expect(next.desks).toEqual([h("a"), h("b"), h("c", "idle")]);
  });

  it("a freed desk goes to the next newcomer, in the order given; nobody else moves", () => {
    const first = assignDesks(null, [h("a"), h("b"), h("c")], 4);
    const next = assignDesks(first, [h("n1"), h("c"), h("n2"), h("b")], 4);
    expect(next.desks).toEqual([h("n1"), h("b"), h("c"), h("n2")]);
  });

  it("a desk that no longer exists (the room shrank) moves its holder to the first free desk", () => {
    const first = assignDesks(null, [h("a"), h("b"), h("c"), h("d"), h("e")], 8);
    // a, b and c finished; the room is back to 4 desks: e keeps nothing past it and takes desk 0.
    const next = assignDesks(first, [h("d"), h("e")], 4);
    expect(next.desks).toEqual([h("e"), null, null, h("d")]);
  });

  it("zero (or negative) seats: no desks", () => {
    expect(assignDesks(null, [], 0)).toEqual({ desks: [] });
    expect(assignDesks(null, [], -1)).toEqual({ desks: [] });
  });
});

describe("memory", () => {
  it("agent bytes are the CLI's plus its tools' resident memory; unknown without a process table", () => {
    expect(agentBytes(machine())).toBe(2 * GB);
    expect(agentBytes(machine({ agents: null }))).toBeNull();
    expect(agentBytes(null)).toBeNull();
  });

  it("used bytes = total − available, unknown when either is missing, never negative", () => {
    expect(usedBytes(machine())).toBe(20 * GB);
    expect(usedBytes(machine({ availableMemBytes: null }))).toBeNull();
    expect(usedBytes(machine({ totalMemBytes: null }))).toBeNull();
    expect(usedBytes(null)).toBeNull();
    expect(usedBytes(machine({ availableMemBytes: 40 * GB }))).toBe(0);
  });

  it("maps to shares of RAM: 0, 50 and 100 %", () => {
    const at = (agents: number, avail: number) =>
      memoryShares(machine({ agents: { ...machine().agents!, claudeRssBytes: agents, toolRssBytes: 0 }, availableMemBytes: avail }));
    expect(at(0, 32 * GB)).toEqual({ agents: 0, used: 0 });
    expect(at(16 * GB, 16 * GB)).toEqual({ agents: 0.5, used: 0.5 });
    expect(at(32 * GB, 0)).toEqual({ agents: 1, used: 1 });
    // Summed RSS counts shared pages twice: it can exceed the RAM, and is clamped.
    expect(at(64 * GB, 0).agents).toBe(1);
  });

  it("is unknown piece by piece: no total, no process table, no available figure", () => {
    expect(memoryShares(null)).toEqual({ agents: null, used: null });
    expect(memoryShares(machine({ totalMemBytes: null }))).toEqual({ agents: null, used: null });
    expect(memoryShares(machine({ totalMemBytes: 0 }))).toEqual({ agents: null, used: null });
    expect(memoryShares(machine({ agents: null })).agents).toBeNull();
    expect(memoryShares(machine({ availableMemBytes: null })).used).toBeNull();
  });

  it("formats bytes: MB under a gigabyte, one decimal GB above", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(2.14 * GB)).toBe("2.1 GB");
    expect(formatBytes(GB)).toBe("1.0 GB");
  });
});

describe("usage — the usage strip's reading, reused", () => {
  const snap = snapshot([win("current-session", 41), win("current-week-all-models", 58), win("current-week-fable", 76)]);

  it("picks the 5-hour session and the all-models week", () => {
    expect(sessionWindow(snap)?.usedPct).toBe(41);
    expect(weekWindow(snap)?.usedPct).toBe(58);
  });

  it("falls back to the first weekly row when there is no all-models one; null without a snapshot", () => {
    expect(weekWindow(snapshot([win("current-week-fable", 76)]))?.usedPct).toBe(76);
    expect(weekWindow(snapshot([win("current-session", 1)]))).toBeNull();
    expect(sessionWindow(null)).toBeNull();
    expect(weekWindow(null)).toBeNull();
  });

  it("maps 0 / 50 / 100 % onto the strip's bands (60 / 90), and no window onto no meter", () => {
    expect(usageMeter(win("x", 0))).toEqual({ fill: 0, tone: "ok" });
    expect(usageMeter(win("x", 50))).toEqual({ fill: 0.5, tone: "ok" });
    expect(usageMeter(win("x", 60))).toEqual({ fill: 0.6, tone: "warn" });
    expect(usageMeter(win("x", 100))).toEqual({ fill: 1, tone: "danger" });
    expect(usageMeter(win("x", Number.NaN))).toEqual({ fill: 0, tone: "ok" });
    expect(usageMeter(null)).toBeNull();
  });
});

describe("context — the context card's readings, reused", () => {
  it("maps 0 / 50 / 100 % onto the card's bands (50 / 80), only for agents with a reading", () => {
    const agents = [agent("a"), agent("b"), agent("c"), agent("none"), agent("ext", { origin: "external", ideAgentId: null })];
    const entries = {
      "id-a": ctx(0),
      "id-b": ctx(50),
      "id-c": ctx(100),
      "id-none": { data: null, error: "timeout", loading: false } as ContextEntry,
    };
    expect(contextMeters(agents, entries, 0)).toEqual({
      a: { fill: 0, tone: "ok" },
      b: { fill: 0.5, tone: "warn" },
      c: { fill: 1, tone: "danger" },
    });
  });

  it("an old reading keeps its fill but loses its colour: grey ('unknown') past CONTEXT_STALE_MS", () => {
    const entries = { "id-a": ctx(90, { measuredAtMs: 1_000 }) };
    expect(contextMeters([agent("a")], entries, 1_000 + CONTEXT_STALE_MS)).toEqual({ a: { fill: 0.9, tone: "danger" } });
    expect(contextMeters([agent("a")], entries, 1_000 + CONTEXT_STALE_MS + 1)).toEqual({ a: { fill: 0.9, tone: "unknown" } });
    // A frame passes its clock through.
    const f = capacityFrame(inputs({ agents: [agent("a")], context: entries, nowMs: 1_000 + CONTEXT_STALE_MS + 1 }), null);
    expect(f.context).toEqual({ a: { fill: 0.9, tone: "unknown" } });
  });

  it("an agent's card line: percent, tokens and age — or null without a reading (then nothing is said)", () => {
    const entries = { "id-a": ctx(29, { measuredAtMs: 0 }) };
    expect(contextLine(agent("a"), entries, 3 * 60_000)).toBe("Context 29% · 290.7k / 1m · measured 3 min ago");
    expect(contextLine(agent("b"), entries, 0)).toBeNull();
    expect(contextLine(agent("x", { ideAgentId: null }), entries, 0)).toBeNull();
  });
});

describe("capacityFrame — what the buildings show", () => {
  it("puts it all together in the Village: no desks, the hall, and the other buildings' figures", () => {
    const f = capacityFrame(
      inputs({
        machine: machine({ logicalCpus: 4 }),
        agents: [agent("a"), agent("b", { activity: "idle" }), agent("c")],
        usage: snapshot([win("current-session", 41), win("current-week-all-models", 58)]),
        context: { "id-a": ctx(29) },
      }),
      null,
    );
    // Three live agents, but the Village seats nobody at desks any more: its Seats are the hall.
    expect(f.desks).toEqual([]);
    // Nothing selected in the rail: the hall has no reading — unknown, never empty.
    expect(f.hall).toEqual(UNKNOWN_HALL);
    expect(f.memory).toEqual({ agents: 2 / 32, used: 20 / 32 });
    expect(f.usage).toEqual({ session: { fill: 0.41, tone: "ok" }, week: { fill: 0.58, tone: "ok" } });
    // The context bars over the agents are still there, per agent with a reading.
    expect(f.context).toEqual({ a: { fill: 0.29, tone: "ok" } });
    // The Village has no lounge: its lounge caption is empty (the panel does not print it there).
    expect(f.captions).toEqual({ seats: "Seats ?", memory: "Memory 2.0 GB", usage: "Usage 41% · 58%", lounge: "" });
    expect(f.gaugeCaptions).toEqual(["5h 41%", "week 58%"]);
  });

  it("says '?' for every figure it does not have — never a zero", () => {
    const f = capacityFrame(inputs({ machine: null, agents: [agent("a")] }), null);
    expect(f.desks).toEqual([]);
    expect(f.hall).toEqual(UNKNOWN_HALL);
    expect(f.memory).toEqual({ agents: null, used: null });
    expect(f.usage).toEqual({ session: null, week: null });
    expect(f.captions).toEqual({ seats: "Seats ?", memory: "Memory ?", usage: "Usage ? · ?", lounge: "" });
    expect(f.gaugeCaptions).toEqual(["5h ?", "week ?"]);
    // RAM known but no process table: the agents' memory is still "?".
    expect(capacityFrame(inputs({ machine: machine({ agents: null }) }), null).captions.memory).toBe("Memory ?");
    expect(capacityFrame(inputs({ machine: machine({ totalMemBytes: null }) }), null).captions.memory).toBe("Memory ?");
  });

  it("the Village vs the City, from the same inputs (the hall is in both): the same hall in both — and the City's lounge's 64 benches too", () => {
    const same = { agents: [agent("a"), agent("b", { activity: "idle" })], hallAgent: ROOT, context: { "root-a": entry(REFERENCE) }, nowMs: NOW };
    const village = capacityFrame(inputs(same), null);
    expect(village.desks).toEqual([]);
    expect(village.hall).toEqual({ cells: REFERENCE_CELLS, usedPct: 11, tone: "ok" });
    expect(village.captions.seats).toBe("Seats 23/200");
    expect(village.captions.lounge).toBe("");
    // The City seats the SAME selection's window in its hall under the lounge…
    const city = capacityFrame(inputs({ ...same, lounge: true }), null);
    expect(city.hall).toEqual({ cells: REFERENCE_CELLS, usedPct: 11, tone: "ok" });
    expect(city.captions.seats).toBe("Seats 23/200");
    // …and has its lounge's benches as well: the two live agents on the first two, 62 free.
    expect(city.desks).toHaveLength(64);
    expect(city.desks.slice(0, 3)).toEqual([h("a"), h("b", "idle"), null]);
    expect(city.desks.filter((d) => d === null)).toHaveLength(62);
    expect(city.captions.lounge).toBe("Lounge 2/64");
    // Everything else is the same picture in both.
    expect([city.memory, city.usage, city.context, city.gaugeCaptions]).toEqual([village.memory, village.usage, village.context, village.gaugeCaptions]);
  });

  it("the captions in both views, from the same inputs: 'Seats 23/200' in both, 'Lounge 3/64' in the City only", () => {
    const same = {
      machine: machine(),
      agents: [agent("a"), agent("b", { activity: "idle" }), agent("c", { activity: "waiting" })],
      usage: snapshot([win("current-session", 41), win("current-week-all-models", 58)]),
      hallAgent: ROOT,
      context: { "root-a": entry(REFERENCE) },
      nowMs: NOW,
    };
    expect(capacityFrame(inputs(same), null).captions).toEqual({
      seats: "Seats 23/200",
      memory: "Memory 2.0 GB",
      usage: "Usage 41% · 58%",
      lounge: "",
    });
    expect(capacityFrame(inputs({ ...same, lounge: true }), null).captions).toEqual({
      seats: "Seats 23/200",
      memory: "Memory 2.0 GB",
      usage: "Usage 41% · 58%",
      lounge: "Lounge 3/64",
    });
    // `lounge: false` is the Village.
    expect(capacityFrame(inputs({ ...same, lounge: false }), null).captions.lounge).toBe("");
    // Nothing selected, in the City: the hall has no reading ('Seats ?'), the lounge still counts.
    expect(capacityFrame(inputs({ ...same, hallAgent: NONE, lounge: true }), null).captions).toEqual({
      seats: "Seats ?",
      memory: "Memory 2.0 GB",
      usage: "Usage 41% · 58%",
      lounge: "Lounge 3/64",
    });
  });

  it("a City frame has the hall in every selection state — unknown, never absent — beside its lounge's desks", () => {
    const at = (who: HallAgent | undefined, context: Record<string, ContextEntry> = {}) =>
      capacityFrame(inputs({ lounge: true, agents: [agent("a")], hallAgent: who, context, nowMs: NOW }), null);
    for (const who of [undefined, NONE, SUB, ROOT]) {
      const f = at(who);
      expect(f.hall, JSON.stringify(who)).toEqual(UNKNOWN_HALL);
      expect(f.desks, JSON.stringify(who)).toHaveLength(64);
      expect(f.captions.seats, JSON.stringify(who)).toBe("Seats ?");
      expect(f.captions.lounge, JSON.stringify(who)).toBe("Lounge 1/64");
    }
    expect(at(ROOT, { "root-a": entry(REFERENCE) }).hall.cells).toEqual(REFERENCE_CELLS);
  });

  it("a Village frame ignores the `prev` desks it is handed (there are none to keep)", () => {
    const lounge = capacityFrame(inputs({ lounge: true, agents: [agent("a")] }), null);
    expect(capacityFrame(inputs({ agents: [agent("a")] }), lounge).desks).toEqual([]);
  });
});

describe("the Seats hall, both views (the seats are /context's grid, in the Village and the City)", () => {
  it("has /context's own 200 seats", () => {
    expect(HALL_SEATS).toBe(200);
  });

  it("hallFrame seats the reference reading cell by cell: 23 taken, 170 free, 7 reserved — in the CLI's order", () => {
    const hall = hallFrame(hallInputs(ROOT, { "root-a": entry(REFERENCE) }));
    expect(hall).toEqual({ cells: REFERENCE_CELLS, usedPct: 11, tone: "ok" });
    const cells = hall.cells!;
    expect(cells).toHaveLength(200);
    // Front row first: the system prompt's one seat, the MCP instructions' one seat (717 tokens is
    // 0.14 of a seat — still a character), the last message, then free seats up to the buffer.
    expect([cells[0], cells[5], cells[22], cells[23], cells[192], cells[193], cells[199]]).toEqual([
      "system-prompt",
      "mcp-server-instructions",
      "messages",
      "free-space",
      "free-space",
      "autocompact-buffer",
      "autocompact-buffer",
    ]);
  });

  it("hallFrame is in the Context card's tone (50 / 80) for the reading's percent", () => {
    const at = (usedPercent: number) => hallFrame(hallInputs(ROOT, { "root-a": entry({ ...REFERENCE, usedPercent }) }));
    expect([at(11).tone, at(49.9).tone, at(50).tone, at(80).tone, at(80.1).tone]).toEqual(["ok", "ok", "warn", "warn", "danger"]);
    expect(at(92.4).usedPct).toBe(92.4);
  });

  it("hallFrame has no reading — unknown seats, never empty ones — for every selection that cannot be measured", () => {
    const theirs = { "root-a": entry(REFERENCE) };
    // No hall agent at all, nothing selected, a sub-agent (even with its root's reading in the store).
    expect(hallFrame(hallInputs(undefined, theirs))).toEqual(UNKNOWN_HALL);
    expect(hallFrame(hallInputs(NONE, theirs))).toEqual(UNKNOWN_HALL);
    expect(hallFrame(hallInputs(SUB, theirs))).toEqual(UNKNOWN_HALL);
    // A root not read yet, being read, or whose read failed with nothing before it.
    expect(hallFrame(hallInputs(ROOT))).toEqual(UNKNOWN_HALL);
    expect(hallFrame(hallInputs(ROOT, { "root-a": entry(null, null, true) }))).toEqual(UNKNOWN_HALL);
    expect(hallFrame(hallInputs(ROOT, { "root-a": entry(null, "timeout") }))).toEqual(UNKNOWN_HALL);
  });

  it("hallFrame reads the SELECTED agent's window — never another agent's reading", () => {
    expect(hallFrame(hallInputs(ROOT, { "root-b": entry(REFERENCE) }))).toEqual(UNKNOWN_HALL);
    const other = { ...REFERENCE, usedTokens: 500_000, usedPercent: 50 };
    const both = { "root-b": entry(other), "root-a": entry(REFERENCE) };
    expect(hallFrame(hallInputs(ROOT, both)).usedPct).toBe(11);
    expect(hallFrame(hallInputs({ kind: "ready", agentId: "root-b", label: "b" }, both)).usedPct).toBe(50);
  });

  it("hallFrame keeps the last good reading through a failed refresh (stale-but-true beats nothing)", () => {
    expect(hallFrame(hallInputs(ROOT, { "root-a": entry(REFERENCE, "cli-failed") })).cells).toEqual(REFERENCE_CELLS);
  });

  it("hallCounts: a category's seat is taken, a buffer seat is reserved, a free-space seat is free", () => {
    expect(hallCounts(REFERENCE_CELLS)).toEqual({ taken: 23, reserved: 7, free: 170 });
    expect(hallCounts([])).toEqual({ taken: 0, reserved: 0, free: 0 });
    expect(hallCounts(["messages", "free-space", "autocompact-buffer", "skills", "free-space"])).toEqual({ taken: 2, reserved: 1, free: 2 });
    // A category the CLI adds tomorrow is still somebody in a seat.
    expect(hallCounts(["brand-new-category"])).toEqual({ taken: 1, reserved: 0, free: 0 });
    expect(hallCounts(Array<string>(200).fill("free-space"))).toEqual({ taken: 0, reserved: 0, free: 200 });
  });

  it("hallCaption: taken of all the seats — 0 is a reading, '?' is none", () => {
    expect(hallCaption({ cells: REFERENCE_CELLS, usedPct: 11, tone: "ok" })).toBe("Seats 23/200");
    expect(hallCaption({ cells: Array<string>(200).fill("messages"), usedPct: 100, tone: "danger" })).toBe("Seats 200/200");
    expect(hallCaption({ cells: Array<string>(200).fill("free-space"), usedPct: 0, tone: "ok" })).toBe("Seats 0/200");
    expect(hallCaption(UNKNOWN_HALL)).toBe("Seats ?");
  });
});

describe("capacityCard — the hover cards", () => {
  const frameOf = (i: CapacityInputs) => capacityFrame(i, null);
  const seatsCard = (i: CapacityInputs, nowMs = NOW) => capacityCard("seats", i, frameOf(i), nowMs);
  const HALL_SOURCE =
    "claude /context for the agent selected in the rail (the Context card's reading): the CLI's own estimate by category — a character on every taken seat, an empty seat for free space, a reserved one for the autocompact buffer";

  it("the Village's seats card, with a reading: whose window, taken / reserved / free, the model, every category, a seat's worth and the age", () => {
    const card = seatsCard(hallInputs(ROOT, { "root-a": entry(REFERENCE) }));
    expect([card.kind, card.title, card.estimate]).toEqual(["seats", "Seats — gazelle's context window", true]);
    expect(card.rows).toEqual([
      "23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free",
      "claude-opus-5-5 · 109.9k / 1m tokens (11%)",
      "System prompt: 4.2k tokens (0.4%)",
      "System tools: 20.2k tokens (2%)",
      "MCP server instructions: 717 tokens (0.1%)",
      "Memory files: 2.1k tokens (0.2%)",
      "Skills: 6.8k tokens (0.7%)",
      "Messages: 75.9k tokens (7.6%)",
      "Free space: 857.1k tokens (85.7%)",
      "Autocompact buffer: 33k tokens (3.3%)",
      "One seat = 1/200 of the window (5k tokens) · measured 3 min ago",
    ]);
    expect(card.source).toBe(HALL_SOURCE);
  });

  it("the card ages the reading on the clock it is handed, and a seat's worth follows the window", () => {
    const small = { ...REFERENCE, windowTokens: 200_000, usedTokens: 109_900, usedPercent: 55 };
    const rows = seatsCard(hallInputs(ROOT, { "root-a": entry(small) }), REFERENCE.measuredAtMs + 2 * 3_600_000).rows;
    expect(rows.at(-1)).toBe("One seat = 1/200 of the window (1k tokens) · measured 2 h ago");
    expect(rows[1]).toBe("claude-opus-5-5 · 109.9k / 200k tokens (55%)");
  });

  it("with a reading and a failed refresh: the reading, then that the last refresh failed", () => {
    const rows = seatsCard(hallInputs(ROOT, { "root-a": entry(REFERENCE, "timeout") })).rows;
    expect(rows[0]).toBe("23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free");
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)).toBe("Last refresh failed — showing the previous reading");
  });

  it("nothing selected: says to select one", () => {
    for (const who of [undefined, NONE]) {
      const card = seatsCard(hallInputs(who));
      expect([card.kind, card.title, card.estimate]).toEqual(["seats", "Seats — context window", true]);
      expect(card.rows).toEqual(["No agent selected — select one in the agent rail to seat its context window here"]);
      expect(card.source).toBe(HALL_SOURCE);
    }
  });

  it("a sub-agent: /context has no reading of its own — select its root", () => {
    const card = seatsCard(hallInputs(SUB, { "root-a": entry(REFERENCE) }));
    expect(card.title).toBe("Seats — fix-tests's context window");
    expect(card.rows).toEqual(["fix-tests is a sub-agent: /context has no reading of its own for it — select its root agent"]);
  });

  it("a root not read yet, or being read: 'Reading …'", () => {
    const notYet: Record<string, ContextEntry>[] = [{}, { "root-a": entry(null, null, true) }];
    for (const context of notYet) {
      const card = seatsCard(hallInputs(ROOT, context));
      expect(card.title).toBe("Seats — gazelle's context window");
      expect(card.rows).toEqual(["Reading gazelle's context window…"]);
    }
  });

  it("a root whose read failed with no reading before it: the Context card's own words for the failure", () => {
    expect(seatsCard(hallInputs(ROOT, { "root-a": entry(null, "timeout") })).rows).toEqual([
      "The claude CLI did not answer in time — retry in a moment.",
    ]);
    expect(seatsCard(hallInputs(ROOT, { "root-a": entry(null, "no-session") })).rows).toEqual([
      "This agent hasn't had a conversation yet — its context appears after the first prompt.",
    ]);
    // A read that failed and is being retried still says why it failed.
    expect(seatsCard(hallInputs(ROOT, { "root-a": entry(null, "cli-missing", true) })).rows).toEqual([
      "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry.",
    ]);
  });

  it("the Village's seats card owes nothing to the machine or the HUD toggle: no estimate, no CPU, no counting row", () => {
    for (const over of [{ machine: null }, { machine: null, machineError: "unknown" }, { machine: machine({ logicalCpus: null }) }, { includesOutside: false }]) {
      const card = seatsCard(hallInputs(ROOT, { "root-a": entry(REFERENCE) }, over));
      expect(card.rows[0]).toBe("23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free");
      expect(card.rows.join("\n")).not.toMatch(/Estimate|CPU|machine|Counting/);
    }
  });

  it("memory: the agents' resident memory and the machine's, with the double-count caveat", () => {
    const i = inputs();
    const card = capacityCard("memory", i, frameOf(i), 0);
    expect(card.estimate).toBe(false);
    expect(card.rows).toEqual([
      "Agents: 2.0 GB resident — 3 sessions, 5 claude processes, 9 tool processes",
      "In use (everything): 20.0 GB of 32.0 GB · 12.0 GB available",
    ]);
    expect(card.source).toMatch(/shared pages count twice/);
  });

  it("memory: no process table, no RAM figures, no sample", () => {
    const none = inputs({ machine: machine({ agents: null, totalMemBytes: null }) });
    expect(capacityCard("memory", none, frameOf(none), 0).rows).toEqual([
      "Agents: unknown — this OS has no process table to read",
      "RAM: unknown — this OS did not report it",
    ]);
    const wait = inputs({ machine: null });
    expect(capacityCard("memory", wait, frameOf(wait), 0).rows).toEqual(["Reading this machine…"]);
  });

  it("usage: both windows with their resets and the reading's age", () => {
    const now = 1_000_000;
    const i = inputs({
      usage: snapshot([win("current-session", 41, now + 2 * 3_600_000), win("current-week-all-models", 58)], now - 3 * 60_000),
    });
    const card = capacityCard("usage", i, frameOf(i), now);
    expect(card.rows).toEqual(["5-hour session: 41% used · Resets in 2 hr", "Week (all models): 58% used"]);
    expect(card.source).toBe("claude /usage, the usage strip's reading · Updated 3 min ago");
  });

  it("usage: a missing window, a stale reading after a failure, a failure with no reading, no reading yet", () => {
    const partial = inputs({ usage: snapshot([win("current-session", 5)]), usageError: "timeout" });
    expect(capacityCard("usage", partial, frameOf(partial), 0).rows).toEqual([
      "5-hour session: 5% used",
      "Week (all models): no reading",
      "Last refresh failed — showing the previous reading",
    ]);
    const failed = inputs({ usageError: "not-signed-in" });
    const card = capacityCard("usage", failed, frameOf(failed), 0);
    expect(card.rows[0]).toMatch(/signed out/);
    expect(card.source).toBe("claude /usage, the usage strip's reading");
    const none = inputs();
    expect(capacityCard("usage", none, frameOf(none), 0).rows).toEqual([
      "No usage reading yet — the usage strip in the left rail takes it",
    ]);
  });
});

describe("the City's lounge (a fixed 64 seats) — and its Seats hall", () => {
  const city = (over: Partial<CapacityInputs> = {}) => inputs({ lounge: true, ...over });

  it("loungeSeats: a fixed 64 up to 64 holders, then whole bench rows of 16 — never the machine's estimate", () => {
    expect([LOUNGE_SEATS, LOUNGE_ROW_SEATS]).toEqual([64, 16]);
    expect([0, 1, 34, 63, 64, 65, 80, 81, 200].map(loungeSeats)).toEqual([64, 64, 64, 64, 64, 80, 80, 96, 208]);
  });

  it("the frame: 64 benches, the holders first in order; the board reads 'Lounge N/64' — past 64, 'Lounge N/<benches>'", () => {
    const f = capacityFrame(city({ machine: machine({ logicalCpus: 4 }), agents: [agent("a"), agent("b", { activity: "idle" })] }), null);
    expect(f.desks).toHaveLength(64);
    expect(f.desks.slice(0, 3)).toEqual([h("a"), h("b", "idle"), null]);
    // Nothing selected: the City's Seats hall is there, with no reading.
    expect(f.hall).toEqual(UNKNOWN_HALL);
    // An estimate of 2, two holders: the lounge counts against its 64, never against the estimate.
    expect(f.captions.lounge).toBe("Lounge 2/64");
    // The Seats board is the hall's, never the lounge's count.
    expect(f.captions.seats).toBe("Seats ?");
    expect(capacityFrame(city({ agents: many(34) }), null).captions.lounge).toBe("Lounge 34/64");
    expect(capacityFrame(city({ agents: many(64) }), null).captions.lounge).toBe("Lounge 64/64");
    const grown = capacityFrame(city({ agents: many(70) }), null);
    expect([grown.desks.length, grown.captions.lounge]).toEqual([80, "Lounge 70/80"]);
    // No sample at all: still the lounge's own figure — never "?" (it does not depend on the machine).
    expect(capacityFrame(city({ machine: null }), null).captions.lounge).toBe("Lounge 0/64");
    // Every board, by hand: the hall's, the machine's, the usage strip's and the lounge's.
    expect(capacityFrame(city(), null).captions).toEqual({ seats: "Seats ?", memory: "Memory 2.0 GB", usage: "Usage ? · ?", lounge: "Lounge 0/64" });
  });

  it("keeps a holder on its seat across frames (prev)", () => {
    const one = capacityFrame(city({ agents: [agent("a"), agent("b")] }), null);
    const two = capacityFrame(city({ agents: [agent("b"), agent("a")] }), one);
    expect(two.desks.slice(0, 2).map((d) => d?.key)).toEqual(["a", "b"]);
  });

  /** The lounge's card for `i`, on its own frame. */
  const loungeCard = (i: CapacityInputs) => capacityCard("lounge", i, capacityFrame(i, null), 0);
  const LOUNGE_SOURCE =
    "A fixed lounge of 64 benches, not a limit: a bench is taken by every live agent shown here, roots and sub-agents; the figures on the free benches stand for free benches, not for running processes. The estimate is a yardstick: Claude Code's per-workflow concurrent-agent gate (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS), not a limit on the machine";

  it("the lounge's card: benches taken and free, the estimate as a yardstick — and what the figures on the free benches are", () => {
    const i = city({
      machine: machine({ logicalCpus: 4 }),
      agents: [agent("a"), agent("b", { activity: "idle" }), agent("c", { activity: "waiting" })],
    });
    const card = loungeCard(i);
    expect([card.kind, card.title, card.estimate]).toEqual(["lounge", "Lounge — agents at once", true]);
    expect(card.rows).toEqual([
      "3 of 64 benches taken · 2 active · 61 free",
      "1 past the estimate — all running",
      "Estimate: min(16, max(2, 4 CPUs − 2)) = 2",
      "Counting IDE and outside agents",
    ]);
    expect(card.source).toBe(LOUNGE_SOURCE);
    // At the estimate exactly: not past it.
    const at = city({ machine: machine({ logicalCpus: 4 }), agents: [agent("a"), agent("b")] });
    expect(loungeCard(at).rows).toEqual([
      "2 of 64 benches taken · 2 active · 62 free",
      "Estimate: min(16, max(2, 4 CPUs − 2)) = 2",
      "Counting IDE and outside agents",
    ]);
    // Within the estimate: no "past" row; the outside-agents toggle is said.
    const calm = city({ agents: [agent("a")], includesOutside: false });
    expect(loungeCard(calm).rows).toEqual([
      "1 of 64 benches taken · 1 active · 63 free",
      "Estimate: min(16, max(2, 12 CPUs − 2)) = 10",
      "Counting IDE agents only — outside agents are hidden (HUD toggle)",
    ]);
  });

  it("the lounge's card past 64: how far past the lounge's 64 it has grown, a row of 16 benches at a time", () => {
    const i = city({ machine: machine({ logicalCpus: 16 }), agents: many(70) });
    const card = loungeCard(i);
    expect([card.kind, card.title, card.estimate]).toEqual(["lounge", "Lounge — agents at once", true]);
    expect(card.rows).toEqual([
      "70 of 80 benches taken · 70 active · 10 free",
      "6 past the lounge's 64 — it adds a row of 16 benches whenever it fills",
      "56 past the estimate — all running",
      "Estimate: min(16, max(2, 16 CPUs − 2)) = 14",
      "Counting IDE and outside agents",
    ]);
    expect(card.source).toBe(LOUNGE_SOURCE);
    // Exactly 64: full, not grown.
    const full = city({ agents: many(64) });
    expect(loungeCard(full).rows).toEqual([
      "64 of 64 benches taken · 64 active · 0 free",
      "54 past the estimate — all running",
      "Estimate: min(16, max(2, 12 CPUs − 2)) = 10",
      "Counting IDE and outside agents",
    ]);
    // One past it: the first grown row.
    const one = city({ agents: many(65) });
    expect(loungeCard(one).rows.slice(0, 2)).toEqual([
      "65 of 80 benches taken · 65 active · 15 free",
      "1 past the lounge's 64 — it adds a row of 16 benches whenever it fills",
    ]);
  });

  it("the lounge's card without a sample, after a failed read, without a CPU count: the lounge's figure, then why there is no yardstick", () => {
    const rows = (i: CapacityInputs) => loungeCard(i).rows;
    const one = [agent("a")];
    expect(rows(city({ machine: null, agents: one }))).toEqual(["1 of 64 benches taken · 1 active · 63 free", "Reading this machine…", "Counting IDE and outside agents"]);
    expect(rows(city({ machine: null, machineError: "unknown", agents: one }))).toEqual([
      "1 of 64 benches taken · 1 active · 63 free",
      "Couldn't read this machine (unknown)",
      "Counting IDE and outside agents",
    ]);
    expect(rows(city({ machine: machine({ logicalCpus: null }), agents: one }))).toEqual([
      "1 of 64 benches taken · 1 active · 63 free",
      "This OS did not report a CPU count, so there is no estimate to measure against",
      "Counting IDE and outside agents",
    ]);
    // An empty lounge: every bench free.
    expect(rows(city({ includesOutside: false }))).toEqual([
      "0 of 64 benches taken · 0 active · 64 free",
      "Estimate: min(16, max(2, 12 CPUs − 2)) = 10",
      "Counting IDE agents only — outside agents are hidden (HUD toggle)",
    ]);
  });

  it("the City's Seats card is the hall's — the selected agent's context window, word for word the Village's", () => {
    const i = city({ machine: machine({ logicalCpus: 4 }), agents: many(3), hallAgent: ROOT, context: { "root-a": entry(REFERENCE) }, nowMs: NOW });
    const card = capacityCard("seats", i, capacityFrame(i, null), NOW);
    expect([card.kind, card.title, card.estimate]).toEqual(["seats", "Seats — gazelle's context window", true]);
    expect(card.rows).toEqual([
      "23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free",
      "claude-opus-5-5 · 109.9k / 1m tokens (11%)",
      "System prompt: 4.2k tokens (0.4%)",
      "System tools: 20.2k tokens (2%)",
      "MCP server instructions: 717 tokens (0.1%)",
      "Memory files: 2.1k tokens (0.2%)",
      "Skills: 6.8k tokens (0.7%)",
      "Messages: 75.9k tokens (7.6%)",
      "Free space: 857.1k tokens (85.7%)",
      "Autocompact buffer: 33k tokens (3.3%)",
      "One seat = 1/200 of the window (5k tokens) · measured 3 min ago",
    ]);
    expect(card.source).toBe(
      "claude /context for the agent selected in the rail (the Context card's reading): the CLI's own estimate by category — a character on every taken seat, an empty seat for free space, a reserved one for the autocompact buffer",
    );
    // Nothing about benches, the lounge, the machine or the HUD toggle on it.
    expect(card.rows.join("\n")).not.toMatch(/bench|lounge|Estimate|CPU|Counting/);
    // Nothing selected, in the City: the hall card's own words.
    const none = city({ agents: many(3), nowMs: NOW });
    const empty = capacityCard("seats", none, capacityFrame(none, null), NOW);
    expect([empty.kind, empty.title, empty.rows]).toEqual([
      "seats",
      "Seats — context window",
      ["No agent selected — select one in the agent rail to seat its context window here"],
    ]);
  });

  it("the Memory and Usage cards are the Village's", () => {
    for (const kind of ["memory", "usage"] as const) {
      const v = inputs();
      const c = city();
      expect(capacityCard(kind, c, capacityFrame(c, null), 0)).toEqual(capacityCard(kind, v, capacityFrame(v, null), 0));
    }
  });
});
