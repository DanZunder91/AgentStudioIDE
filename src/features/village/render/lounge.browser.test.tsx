/**
 * The City's lounge against a REAL 2D context in Chromium: the benches read
 * against the hall, a waiter sits on every free seat and none on a held one, the hall keeps its own
 * light at night, and the ground it is dug into — turf, soil, the street's copies beside the world
 * carrying the street only. Assertions read pixels back with getImageData.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/lounge.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, computeAmbience, planCity } from "../engine";
import type { Ambience, CapacityFrame, DrawItem, VillageAgent } from "../villageTypes";
import { CITY } from "./city";
import { BENCH, LOUNGE } from "./lounge";
import { defaultMakeLayer, loadSprites, paintGround, renderFrame, type Camera } from "./index";

afterEach(() => {
  document.body.innerHTML = "";
});

const Z = 4;
const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const agentOf = (key: string): VillageAgent => ({
  key, parentKey: null, origin: "ide", title: key, folder: "gazelle", activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null,
});

/** One project, the HQ and its 64-bench lounge (the Seats hall under it is hall.browser.test's). */
const world = buildCityWorld(planCity([agentOf("a")]).plans, { seats: 64 });
const lounge = world.houses.find((h) => h.capacity === "lounge")!;
const bench = (i: number) => world.props.find((p) => p.kind === "bench" && p.index === i)!;
const noon = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });
const night = computeAmbience(new Date(2026, 9, 15, 23, 0), null, { weather: "clear", phase: "auto" });

function frameOf(held: readonly number[]): CapacityFrame {
  return {
    desks: Array.from({ length: 64 }, (_, i) => (held.includes(i) ? { key: `h${i}`, activity: "typing" as const, parentKey: null } : null)),
    hall: { cells: null, usedPct: null, tone: "unknown" }, // the Seats hall under the lounge, with no reading
    memory: { agents: null, used: null },
    usage: { session: null, week: null },
    context: {},
    captions: { seats: "Seats ?", memory: "Memory ?", usage: "Usage ? · ?", lounge: `Lounge ${held.length}/64` },
    gaugeCaptions: ["5h ?", "week ?"],
  };
}

/**
 * The lounge's region painted at zoom Z: the whole draw list of `world` for a frame where `held`
 * seats are held, under `amb`. `at(wx, wy)` = the RGB under a world px; `data` = the region's pixels.
 */
async function paint(held: readonly number[], amb: Ambience) {
  // The lift's own art is render/lift.ts's (tested in lift.browser.test.tsx): left out, so this block tests only the lounge.
  const items = buildDrawList(world, [], () => false, 3, null, { frame: frameOf(held), seatOf: () => null }).filter(
    (i: DrawItem) => !(i.t === "prop" && i.prop.kind === "lift"),
  );
  const wx0 = (lounge.col - 2) * 16;
  const wy0 = (lounge.row - 2) * 16;
  const W = (lounge.w + 4) * 16 * Z;
  const H = (lounge.h + 5) * 16 * Z;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const cam: Camera = { zoom: Z, ox: -wx0 * Z, oy: -wy0 * Z };
  renderFrame(ctx, items, cam, await loadSprites(), { w: W, h: H, timeMs: 0, ambience: amb, particles: [], world });
  const at = (wx: number, wy: number) => Array.from(ctx.getImageData((wx - wx0) * Z + 1, (wy - wy0) * Z + 1, 1, 1).data.slice(0, 3));
  /** Distinct colours in a world-px rect. */
  const colours = (wx: number, wy: number, w: number, h: number) => {
    const d = ctx.getImageData((wx - wx0) * Z, (wy - wy0) * Z, w * Z, h * Z).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  };
  const room = () => Array.from(ctx.getImageData((lounge.col - wx0 / 16) * 16 * Z, (lounge.row + 1 - wy0 / 16) * 16 * Z, lounge.w * 16 * Z, (lounge.h - 1) * 16 * Z).data);
  return { at, colours, room };
}

describe("the lounge in a real canvas", () => {
  it("is the City's lounge house — 'cap/lounge', 'Lounge' — with its 64 benches", () => {
    expect([lounge.key, lounge.label, lounge.capacity]).toEqual(["cap/lounge", "Lounge", "lounge"]);
    expect(world.props.filter((p) => p.kind === "bench" && p.capacity === "lounge")).toHaveLength(64);
    expect(world.city!.lounge!.key).toBe("cap/lounge");
  });

  it("an empty bench reads on the hall: its seat and slats in their wood, far from the tiles and the wainscot behind them", async () => {
    const all = Array.from({ length: 64 }, (_, i) => i);
    const { at } = await paint(all, noon);
    const b = bench(5);
    const x0 = b.col * 16;
    const bottom = (b.row + 1) * 16;
    expect(at(x0 + 8, bottom - 8)).toEqual(rgbOf(BENCH.wood)); // the seat
    expect(at(x0 + 8, bottom - 6)).toEqual(rgbOf(BENCH.woodDark)); // its front edge
    expect(at(x0 + 8, bottom - 14)).toEqual(rgbOf(BENCH.wood)); // a backrest slat
    // Between the bench's slats: the wainscot (dark station green), and above it the hall's cream tiles.
    expect(at(x0 + 8, bottom - 10)).toEqual(rgbOf(LOUNGE.panel));
    const tiles = at(x0 + 8, bottom - 24);
    expect(lum(tiles) - lum(rgbOf(BENCH.wood))).toBeGreaterThan(40);
    expect(lum(rgbOf(BENCH.wood)) - lum(rgbOf(LOUNGE.panel))).toBeGreaterThan(40);
  });

  it("a waiter on every free seat — head and shoulders over the bench — and none on a held one", async () => {
    const held = [0, 1, 2, 3];
    const { colours, at } = await paint(held, noon);
    const empty = await paint(Array.from({ length: 64 }, (_, i) => i), noon);
    for (const i of [4, 9, 20, 63]) {
      const b = bench(i);
      // The tile above the seat (the sitter's head) changed from the empty hall and holds a sprite's many colours.
      expect(colours(b.col * 16, (b.row - 1) * 16 + 4, 16, 12), `seat ${i}`).toBeGreaterThan(6);
      expect(at(b.col * 16 + 8, b.row * 16 - 6), `seat ${i}`).not.toEqual(empty.at(b.col * 16 + 8, b.row * 16 - 6));
    }
    for (const i of held) {
      const b = bench(i);
      expect(at(b.col * 16 + 8, b.row * 16 - 6), `held ${i}`).toEqual(empty.at(b.col * 16 + 8, b.row * 16 - 6));
      expect(at(b.col * 16 + 8, (b.row + 1) * 16 - 8), `held ${i}`).toEqual(rgbOf(BENCH.wood));
    }
  });

  it("the hall keeps its own light at night — byte for byte when nobody waits — while the soil around it goes dark", async () => {
    const all = Array.from({ length: 64 }, (_, i) => i);
    const day = await paint(all, noon);
    const dark = await paint(all, night);
    expect(dark.room()).toEqual(day.room());
    const soil = [(lounge.col - 2) * 16 + 4, (lounge.row + lounge.h + 2) * 16 + 4] as const;
    expect(lum(dark.at(...soil))).toBeLessThan(lum(day.at(...soil)) * 0.7);
    // At noon the soil is its own colour (no tint at noon).
    expect(noon.tint.alpha).toBe(0);
  });

  it("the ground: turf under the far sidewalk, soil below it; beside the world the street's copies carry the street only — never the lounge", async () => {
    const bank = await loadSprites();
    const items = buildDrawList(world, [], () => false, 0).filter((i: DrawItem) => !(i.t === "prop" && i.prop.kind === "lift"));
    const ground = paintGround(defaultMakeLayer, items, world.cols, world.rows, bank)!;
    const W = 1600;
    const H = 900;
    const street = world.city!.street;
    // Zoom 1, the world's right end in the middle of the canvas, the lounge's rows on screen.
    const cam: Camera = { zoom: 1, ox: W / 2 - world.cols * 16, oy: Math.round(H / 2 - (lounge.row + 2) * 16) };
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    renderFrame(ctx, items, cam, bank, { w: W, h: H, timeMs: 0, ground, ambience: noon, particles: [], world });
    const at = (wx: number, wy: number) => Array.from(ctx.getImageData(cam.ox + wx, cam.oy + wy, 1, 1).data.slice(0, 3));
    const soil = (CITY.soil as readonly string[]).map(rgbOf);
    // Right of the world, where a copy of the world would put its lounge: the street ran on, then turf, then soil.
    const beyond = world.cols * 16 + lounge.col * 16 + 40;
    expect(at(beyond + 3, (street + 4) * 16 + 1)).toEqual(rgbOf(CITY.verge));
    for (const r of [lounge.row, lounge.row + 3, lounge.row + lounge.h]) expect(soil, `row ${r}`).toContainEqual(at(beyond + 5, r * 16 + 9));
    // The street itself was copied: its far sidewalk there is the world's own (cobbles, not the flat band).
    expect(at(beyond + 5, (street + 3) * 16 + 4)).toEqual(at(lounge.col * 16 + 40 + 5, (street + 3) * 16 + 4));
    // In the world itself, the lounge is there.
    expect(soil).not.toContainEqual(at(lounge.col * 16 + 40, (lounge.row + 3) * 16 + 9));
  });
});
