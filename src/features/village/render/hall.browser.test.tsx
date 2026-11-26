/** The Seats hall against a real 2D context, read back at zoom 4 and at zoom 1 (the audience must
 * still read at Fit), in the Village and the City.
 * Run with `npx vitest run --config vitest.browser.config.ts <this file>`. */

import { afterEach, describe, expect, it } from "vitest";

import { capacityFrame, type CapacityInputs } from "../capacityModel";
import type { ContextUsage } from "../../context/contextTypes";
import { buildCityWorld, buildDrawList, buildWorld, computeAmbience, planCity, planHouses } from "../engine";
import type { VillageAgent } from "../villageTypes";
import { seatOrigin } from "./hall";
import { loadSprites, renderFrame, type Camera } from "./index";

afterEach(() => {
  document.body.innerHTML = "";
});

const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const hexOf = ([r, g, b]: number[]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const agentOf = (key: string): VillageAgent => ({
  key, parentKey: null, origin: "ide", title: key, folder: "gazelle", activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null,
});

/** A realistic `/context` reading: 109.9k of 1m, 11 %. */
const reading: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 109_900,
  windowTokens: 1_000_000,
  usedPercent: 11,
  measuredAtMs: 0,
  categories: [
    { key: "system-prompt", label: "System prompt", tokens: 4_200, percent: 0.4 },
    { key: "system-tools", label: "System tools", tokens: 20_200, percent: 2 },
    { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
    { key: "memory-files", label: "Memory files", tokens: 2_100, percent: 0.2 },
    { key: "skills", label: "Skills", tokens: 6_800, percent: 0.7 },
    { key: "messages", label: "Messages", tokens: 75_900, percent: 7.6 },
    { key: "free-space", label: "Free space", tokens: 857_100, percent: 85.7 },
    { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
  ],
};

/** By hand from the reading (one seat = 5,000 tokens, any use ≥ one seat): 23 taken, 170 free,
 * then the buffer's 7 reserved at the back. */
const SHIRTS = [
  "#a1a1aa",
  "#71717a", "#71717a", "#71717a", "#71717a",
  "#138a9c",
  "#d97430",
  "#d4b83a",
  ...new Array(15).fill("#a371f7"),
];
const CUSHION = "#8b2e3c";
const CARD = "#d9dde4";
const CROSS = "#5b6472";
const UNKNOWN_CUSHION = "#4a505c";
const CATEGORY_HEX = [
  "#a1a1aa", "#71717a", "#52525b", "#22b8cf", "#138a9c", "#d97430", "#d4b83a", "#4cae6b", "#a371f7",
  "#f778ba", "#79c0ff", "#ffa198", "#7ee787", "#d2a8ff", "#e3b341",
];

const world = buildWorld(planHouses([agentOf("a")]), { seats: 0 });
const hallProp = world.props.find((p) => p.kind === "hall")!;
const noon = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });

function inputs(withReading: boolean): CapacityInputs {
  return {
    machine: null,
    machineError: null,
    agents: [agentOf("a")],
    includesOutside: false,
    usage: null,
    usageError: null,
    context: withReading ? { a: { data: reading, error: null, loading: false } } : {},
    nowMs: 0,
    hallAgent: { kind: "ready", agentId: "a", label: "Agent Studio" },
  };
}

/** The draw list painted round the hall at zoom `z`. `at(wx, wy)` = RGB mid world px; `seat(i)` =
 * seat i's shirt spot (the sitter's back, an empty cushion, or a reserved card). */
async function paint(withReading: boolean, z: number, timeMs = 0) {
  const frame = capacityFrame(inputs(withReading), null);
  const items = buildDrawList(world, [], () => false, timeMs / 1000, null, { frame, seatOf: () => null });
  const x0 = hallProp.col * 16;
  const top = hallProp.row * 16;
  const wx0 = x0 - 16;
  const wy0 = top - 32;
  const W = (13 * 16 + 32) * z;
  const H = (9 * 16 + 48) * z;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const cam: Camera = { zoom: z, ox: -wx0 * z, oy: -wy0 * z };
  renderFrame(ctx, items, cam, await loadSprites(), { w: W, h: H, timeMs, ambience: noon, particles: [], world });
  const off = Math.floor(z / 2);
  const at = (wx: number, wy: number) => Array.from(ctx.getImageData((wx - wx0) * z + off, (wy - wy0) * z + off, 1, 1).data.slice(0, 3));
  const seat = (i: number) => {
    const o = seatOrigin(i);
    return at(x0 + o.x + 4, top + o.y + 8);
  };
  /** Every distinct colour inside the hall's footprint, as hex. */
  const hallColours = () => {
    const d = ctx.getImageData((x0 - wx0) * z, (top - wy0) * z, 13 * 16 * z, 9 * 16 * z).data;
    const set = new Set<string>();
    for (let i = 0; i < d.length; i += 4) set.add(hexOf([d[i], d[i + 1], d[i + 2]]));
    return set;
  };
  return { at, seat, x0, top, hallColours };
}

describe("the Village's Seats hall in a real canvas", () => {
  it("fills the Seats house under its decor row: the whole 13-tile interior, 9 tiles deep", () => {
    const house = world.houses.find((h) => h.capacity === "seats")!;
    expect(hallProp).toBeDefined();
    expect([hallProp.col, hallProp.row, hallProp.w, hallProp.h]).toEqual([house.col, house.row + 1, 13, 9]);
  });

  it("the reference reading: the system prompt's grey on seat 0, the messages' purple, a free cushion, a reserved card", async () => {
    const { seat, at, x0, top } = await paint(true, 4);
    expect(seat(0)).toEqual(rgbOf("#a1a1aa"));
    expect(seat(1)).toEqual(rgbOf("#71717a"));
    expect(seat(8)).toEqual(rgbOf("#a371f7"));
    expect(seat(10)).toEqual(rgbOf("#a371f7")); // right of the aisle
    expect(seat(22)).toEqual(rgbOf("#a371f7")); // the second row
    expect(seat(23)).toEqual(rgbOf(CUSHION)); // the first free seat
    expect(seat(100)).toEqual(rgbOf(CUSHION));
    // The buffer's seats, at the back right: a white card with the ✕ crossing at its centre.
    const o = seatOrigin(196);
    expect(seat(196)).toEqual(rgbOf(CARD));
    expect(at(x0 + o.x + 4, top + o.y + 7)).toEqual(rgbOf(CROSS));
    expect(at(x0 + o.x + 3, top + o.y + 6)).toEqual(rgbOf(CROSS));
    expect(at(x0 + o.x + 4, top + o.y + 6)).toEqual(rgbOf(CARD));
    // The aisle's carpet between seat 9 and seat 10.
    expect(at(x0 + 8 + 90 + 6, top + 40)).toEqual(rgbOf("#4a1e28"));
  });

  it("every seat, sampled: 23 taken in /context's order, 170 free, 7 reserved at the back", async () => {
    const { seat } = await paint(true, 4);
    const got = Array.from({ length: 200 }, (_, i) => hexOf(seat(i)));
    expect(got.slice(0, 23)).toEqual(SHIRTS);
    expect(got.slice(23, 193)).toEqual(new Array(170).fill(CUSHION));
    expect(got.slice(193)).toEqual(new Array(7).fill(CARD));
    expect(got.filter((c) => c !== CUSHION && c !== CARD)).toHaveLength(23);
  });

  it("the screen: a swatch per category in seat order and an 11 % fill bar (12 of 110 px) in the card's green", async () => {
    const { at, x0, top } = await paint(true, 4);
    const sx = x0 + 44;
    expect([0, 1, 2, 3, 4, 5].map((k) => hexOf(at(sx + 4 + k * 8 + 2, top + 4)))).toEqual([
      "#a1a1aa", "#71717a", "#138a9c", "#d97430", "#d4b83a", "#a371f7",
    ]);
    expect(hexOf(at(sx + 4 + 6 * 8 + 2, top + 4))).toBe("#0f1420"); // no seventh swatch: the dark face
    expect(hexOf(at(sx + 4, top + 8))).toBe("#4cc38a");
    expect(hexOf(at(sx + 4 + 11, top + 9))).toBe("#4cc38a");
    expect(hexOf(at(sx + 4 + 12, top + 8))).toBe("#232b38");
    expect(hexOf(at(sx + 4 + 109, top + 8))).toBe("#232b38");
  });

  it("with no reading: every chair grey, a '?' on the screen, and no category colour anywhere in the hall", async () => {
    const { seat, at, x0, top, hallColours } = await paint(false, 4);
    for (let i = 0; i < 200; i++) expect(hexOf(seat(i)), `seat ${i}`).toBe(UNKNOWN_CUSHION);
    const colours = hallColours();
    for (const hex of [...CATEGORY_HEX, CUSHION, CARD]) expect(colours.has(hex), hex).toBe(false);
    // The "?": its top stroke and its dot, light on the dark face.
    const sx = x0 + 44;
    expect(hexOf(at(sx + 58, top + 3))).toBe("#8b93a3");
    expect(hexOf(at(sx + 59, top + 9))).toBe("#8b93a3");
    expect(hexOf(at(sx + 59, top + 8))).toBe("#0f1420");
  });

  it("the audience shifts in its seats over time, but a sitter's shirt stays its category's colour", async () => {
    for (const t of [0, 2_750, 6_100, 11_400]) {
      const { seat } = await paint(true, 4, t);
      expect(Array.from({ length: 23 }, (_, i) => hexOf(seat(i))), `t = ${t}`).toEqual(SHIRTS);
    }
  });

  it("legible at Fit: at zoom 1 every sitter's shirt is its exact colour and far from the free cushion", async () => {
    const { seat } = await paint(true, 1);
    const got = Array.from({ length: 200 }, (_, i) => hexOf(seat(i)));
    expect(got.slice(0, 23)).toEqual(SHIRTS);
    expect(got.slice(23, 193)).toEqual(new Array(170).fill(CUSHION));
    expect(got.slice(193)).toEqual(new Array(7).fill(CARD));
    for (const shirt of new Set(SHIRTS)) expect(dist(rgbOf(shirt), rgbOf(CUSHION)), shirt).toBeGreaterThan(80);
  });
});

describe("the City's Seats hall under the lounge in a real canvas (the hall is in both views)", () => {
  const agents = [agentOf("a"), agentOf("b"), agentOf("c")];
  /** Three projects, the HQ, its 64-bench lounge and the Seats hall under it. */
  const city = buildCityWorld(planCity(agents).plans, { seats: 64 });
  const lounge = city.houses.find((h) => h.capacity === "lounge")!;
  const seatsHouse = city.houses.find((h) => h.capacity === "seats")!;
  const cityHall = city.props.find((p) => p.kind === "hall")!;
  const bench = (i: number) => city.props.find((p) => p.kind === "bench" && p.index === i)!;
  const WOOD = "#b07a45";

  /** The City's frame: a, b and c on the first three benches, a selected — the reference reading. */
  const frame = capacityFrame(
    {
      machine: null,
      machineError: null,
      agents,
      includesOutside: false,
      usage: null,
      usageError: null,
      context: { a: { data: reading, error: null, loading: false } },
      nowMs: 0,
      lounge: true,
      hallAgent: { kind: "ready", agentId: "a", label: "gazelle" },
    },
    null,
  );

  /** The lounge and the hall under it, painted at zoom `z` from the City's whole draw list. */
  async function paintCity(z: number) {
    const items = buildDrawList(city, [], () => false, 0, null, { frame, seatOf: () => null });
    const wx0 = (lounge.col - 1) * 16;
    const wy0 = (lounge.row - 1) * 16;
    const W = (lounge.w + 2) * 16 * z;
    const H = (seatsHouse.row + seatsHouse.h + 2 - (lounge.row - 1)) * 16 * z;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const cam: Camera = { zoom: z, ox: -wx0 * z, oy: -wy0 * z };
    renderFrame(ctx, items, cam, await loadSprites(), { w: W, h: H, timeMs: 0, ambience: noon, particles: [], world: city });
    const off = Math.floor(z / 2);
    const at = (wx: number, wy: number) => Array.from(ctx.getImageData((wx - wx0) * z + off, (wy - wy0) * z + off, 1, 1).data.slice(0, 3));
    const x0 = cityHall.col * 16;
    const top = cityHall.row * 16;
    const seat = (i: number) => {
      const o = seatOrigin(i);
      return at(x0 + o.x + 4, top + o.y + 8);
    };
    return { at, seat, x0, top };
  }

  it("the frame seats the reference reading in the City's hall, beside the lounge's 64 benches", () => {
    expect(frame.hall.usedPct).toBe(11);
    expect(frame.hall.cells).toHaveLength(200);
    expect(frame.desks).toHaveLength(64);
    expect(frame.captions.seats).toBe("Seats 23/200");
    expect(frame.captions.lounge).toBe("Lounge 3/64");
  });

  it("is dug in under the lounge: a row of earth below its floor, centred under the lift, the Village's 13 × 9", () => {
    expect([seatsHouse.key, seatsHouse.label]).toEqual(["cap/seats", "Seats"]);
    // The lounge's floor wall is row lounge.row + lounge.h; one row of earth; then the hall's top wall.
    expect(seatsHouse.row).toBe(lounge.row + lounge.h + 2);
    expect([cityHall.col, cityHall.row, cityHall.w, cityHall.h]).toEqual([seatsHouse.col, seatsHouse.row + 1, 13, 9]);
    expect(cityHall.col + 6).toBe(city.city!.lounge!.lift.col);
    // Every bench row is above the hall's top wall.
    for (let i = 0; i < 64; i++) expect(bench(i).row, `bench ${i}`).toBeLessThan(seatsHouse.row);
  });

  it("the reference reading: seat 0 the system prompt's grey, the messages' purple, a free cushion, a reserved card", async () => {
    const { seat, at, x0, top } = await paintCity(4);
    expect(hexOf(seat(0))).toBe("#a1a1aa");
    expect(hexOf(seat(1))).toBe("#71717a");
    expect(hexOf(seat(10))).toBe("#a371f7"); // right of the aisle
    expect(hexOf(seat(22))).toBe("#a371f7"); // the last message, second row
    expect(hexOf(seat(23))).toBe(CUSHION);
    expect(hexOf(seat(196))).toBe(CARD);
    const o = seatOrigin(196);
    expect(hexOf(at(x0 + o.x + 4, top + o.y + 7))).toBe(CROSS);
    // A 13-tile hall: the screen 44 px in, its legend in seat order and the 11 % bar in green.
    expect([0, 1, 2, 3, 4, 5].map((k) => hexOf(at(x0 + 44 + 4 + k * 8 + 2, top + 4)))).toEqual([
      "#a1a1aa", "#71717a", "#138a9c", "#d97430", "#d4b83a", "#a371f7",
    ]);
    expect(hexOf(at(x0 + 44 + 4 + 11, top + 9))).toBe("#4cc38a");
    expect(hexOf(at(x0 + 44 + 4 + 12, top + 8))).toBe("#232b38");
  });

  it("every seat, sampled: 23 taken in /context's order, 170 free, 7 reserved — at zoom 4 and at zoom 1", async () => {
    for (const z of [4, 1]) {
      const { seat } = await paintCity(z);
      const got = Array.from({ length: 200 }, (_, i) => hexOf(seat(i)));
      expect(got.slice(0, 23), `zoom ${z}`).toEqual(SHIRTS);
      expect(got.slice(23, 193), `zoom ${z}`).toEqual(new Array(170).fill(CUSHION));
      expect(got.slice(193), `zoom ${z}`).toEqual(new Array(7).fill(CARD));
      expect(got.filter((c) => c !== CUSHION && c !== CARD), `zoom ${z}`).toHaveLength(23);
    }
  });

  it("its back row (seats 180–199: the 7 reserved ones among them) shows — the floor wall under the hall does not cover it", async () => {
    const { seat } = await paintCity(4);
    expect(Array.from({ length: 20 }, (_, k) => hexOf(seat(180 + k)))).toEqual([...new Array(13).fill(CUSHION), ...new Array(7).fill(CARD)]);
  });

  it("the lounge's benches are still drawn above it: a held bench's seat in its wood, a waiter over a free one", async () => {
    const { at } = await paintCity(4);
    for (const i of [0, 1, 2]) {
      const b = bench(i);
      expect(hexOf(at(b.col * 16 + 8, (b.row + 1) * 16 - 8)), `held bench ${i}`).toBe(WOOD);
      expect(hexOf(at(b.col * 16 + 8, (b.row + 1) * 16 - 14)), `held bench ${i} slat`).toBe(WOOD);
    }
    // The same spot on a bench with a waiter on it is the waiter, not the bare wood.
    for (const i of [3, 20, 63]) {
      const b = bench(i);
      expect(hexOf(at(b.col * 16 + 8, b.row * 16 - 6)), `free bench ${i}`).not.toBe(hexOf(at(bench(0).col * 16 + 8, bench(0).row * 16 - 6)));
    }
  });
});
