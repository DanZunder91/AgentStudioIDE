import { describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, buildWorld, planCity, planHouses } from "../engine";
import { crossingOf } from "../engine/streetTheme";
import { TILE, type Ambience, type DrawItem, type VillageAgent, type World } from "../villageTypes";
import { SKY } from "./ambience";
import type { Camera } from "./camera";
import { CROSSING, paintCrossing } from "./crossing";
import { renderFrame } from "./frame";
import { paintGround } from "./ground";
import type { SpriteImage } from "./renderTypes";
import { recorder, type DrawCall, type RecordingTarget } from "./testRecorder";
import { drawTile, ROAD } from "./tiles";

function agent(key: string, folder: string, over: Partial<VillageAgent> = {}): VillageAgent {
  return { key, parentKey: null, origin: "ide", title: key, folder, activity: "idle", tool: null, ideAgentId: null, lastActivityAt: null, ...over };
}
/** `n` projects (one root each, in its own folder) and the capacity HQ — or none (`hq` false). */
const city = (n: number, hq = true): World =>
  buildCityWorld(planCity(Array.from({ length: n }, (_, i) => agent(`r${i}`, `p${i}`))).plans, hq ? { seats: 6 } : undefined);

const AT_1: Camera = { zoom: 1, ox: 0, oy: 0 };
const BIG = { w: 4000, h: 2000 };

/** The crossing's fills of a recording: the stripes and the dash blank. */
const ours = (ctx: RecordingTarget): DrawCall[] => ctx.of("fillRect").filter((c) => c.fillStyle === CROSSING.paint || c.fillStyle === CROSSING.asphalt);
const box = (c: DrawCall) => c.args as [number, number, number, number];

/** Zoom-1 fills as pixels: y → (x → colour), later fills over earlier ones. */
function pixels(calls: DrawCall[]): Map<number, Map<number, string>> {
  const rows = new Map<number, Map<number, string>>();
  for (const c of calls) {
    const [x, y, w, h] = box(c);
    for (let yy = y; yy < y + h; yy++) {
      if (!rows.has(yy)) rows.set(yy, new Map());
      for (let xx = x; xx < x + w; xx++) rows.get(yy)!.set(xx, c.fillStyle);
    }
  }
  return rows;
}

describe("paintCrossing — a zebra crossing from the lounge's kiosk to the HQ's door", () => {
  it.each([0, 1, 2, 5])("HQ + %i: four white bars along the road, 4 px tall with 4-px gaps, across both lanes — 44 px of the three tiles centred on the lift", (n) => {
    const w = city(n);
    const { street, lounge } = w.city!;
    const lift = lounge!.lift.col;
    const ctx = recorder();
    paintCrossing(ctx, AT_1, w, BIG);
    const lane = (street + 1) * TILE; // the first lane's top px: its kerb line
    const bars = ctx.of("fillRect").filter((c) => c.fillStyle === CROSSING.paint).map(box);
    expect(bars).toEqual([0, 1, 2, 3].map((k) => [(lift - 1) * TILE + 2, lane + 2 + 8 * k, 44, 4]));
    // Centred on the lift's column, inside the two lanes: below the kerb line, above the far sidewalk.
    for (const [x, y, bw, bh] of bars) {
      expect(x + bw / 2).toBe((lift + 0.5) * TILE);
      expect(y).toBeGreaterThan(lane);
      expect(y + bh).toBeLessThanOrEqual(lane + 2 * TILE);
    }
    expect(CROSSING.paint).not.toBe(ROAD.asphalt);
  });

  it("over the road tiles: the bars alternate with asphalt down the crossing's middle, the kerb line stays, and the centre dashes stop at it", () => {
    const w = city(2);
    const x = crossingOf(w)!;
    const ctx = recorder();
    // The road under it as the ground paints it (the dashes on the even columns' second lane), then the crossing.
    for (let r = x.row + 1; r <= x.row + 2; r++)
      for (let c = x.col - 2; c < x.col + x.w + 2; c++) drawTile(ctx, AT_1, { col: c, row: r, kind: "road", variant: 0 }, null, 0);
    paintCrossing(ctx, AT_1, w, BIG);
    const px = pixels(ctx.of("fillRect"));
    const lane = (x.row + 1) * TILE;
    const mid = (x.col + 1.5) * TILE;
    // Down the middle column, from the kerb to the far sidewalk: kerb, 1 asphalt, then 4 bar / 4 asphalt ×4, 2 asphalt left over.
    const down = Array.from({ length: 2 * TILE }, (_, k) => px.get(lane + k)!.get(mid));
    const bar = (k: number) => k >= 2 && k < 30 && (k - 2) % 8 < 4;
    down.forEach((c, k) => {
      if (k === 0) expect(c, "the kerb line").toBe(ROAD.edge);
      else if (bar(k)) expect(c, `px ${k}`).toBe(CROSSING.paint);
      else expect([ROAD.asphalt, ROAD.grit], `px ${k}`).toContain(c);
    });
    // No yellow left anywhere across the crossing's columns; the dashes just outside it are still there.
    const line = px.get(lane + TILE)!;
    for (let xx = x.col * TILE; xx < (x.col + x.w) * TILE; xx++) expect(line.get(xx), `x ${xx}`).not.toBe(ROAD.line);
    const outside = [...line].filter(([xx, c]) => c === ROAD.line && (xx < x.col * TILE || xx >= (x.col + x.w) * TILE));
    expect(outside.length).toBeGreaterThan(0);
  });

  it.each([
    [0.5, 2, 2],
    [0.75, 3, 1],
    [1, 4, 4],
    [2, 8, 8],
    [3, 12, 12],
  ])("readable at zoom %s: four separate bars, each ≥ %i screen px tall, gaps ≥ %i", (zoom, tall, gap) => {
    const w = city(1);
    const ctx = recorder();
    paintCrossing(ctx, { zoom, ox: 0, oy: 0 }, w, BIG);
    const bars = ctx.of("fillRect").filter((c) => c.fillStyle === CROSSING.paint).map(box);
    expect(bars).toHaveLength(4);
    bars.forEach(([, y, bw, bh], i) => {
      expect(bh).toBeGreaterThanOrEqual(tall);
      expect(bw).toBeGreaterThanOrEqual(Math.floor(44 * zoom));
      if (i > 0) expect(y - (bars[i - 1][1] + bars[i - 1][3])).toBeGreaterThanOrEqual(gap);
    });
  });

  it("paints nothing without a lounge: a city built without the capacity layout, an empty street, the village", () => {
    for (const w of [city(3, false), buildCityWorld([]), buildWorld(planHouses([agent("a", "p")]), { seats: 4 })]) {
      const ctx = recorder();
      paintCrossing(ctx, AT_1, w, BIG);
      expect(ctx.calls).toEqual([]);
    }
  });

  it("is culled: nothing when it is off screen, all of it when only a corner shows", () => {
    const w = city(2);
    const x = crossingOf(w)!;
    const view = { w: 200, h: 200 };
    const left = x.col * TILE;
    const top = (x.row + 1) * TILE;
    const at = (ox: number, oy: number) => {
      const ctx = recorder();
      paintCrossing(ctx, { zoom: 1, ox, oy }, w, view);
      return ours(ctx).length;
    };
    // Its right edge one px short of the view's left edge, its left edge on the view's right edge, above, below.
    expect(at(-(left + 3 * TILE), -top)).toBe(0);
    expect(at(view.w - left, -top)).toBe(0);
    expect(at(-left, view.h - top)).toBe(0);
    expect(at(-left, -(top + 2 * TILE))).toBe(0);
    // One px of it in view (its bottom-right corner at the view's top-left): every rect is painted.
    expect(at(-(left + 3 * TILE - 1), -(top + 2 * TILE - 1))).toBe(5);
  });
});

describe("in the frame — after the ground, before everything standing on the street", () => {
  const rain: Ambience = {
    phase: "afternoon",
    daylight: 0.8,
    tint: { color: "#ffc890", alpha: 0.2 },
    weather: "rain",
    intensity: 0.5,
    wind: 0,
    lightsOn: true,
    campfireLit: false,
    stayIndoors: true,
  };
  const world = city(2);
  const items = buildDrawList(world, [], () => false, 0);
  /** Index of the first fill of the crossing's paint; of the last call of the ground; of the first call after it. */
  const firstStripe = (ctx: RecordingTarget) => ctx.calls.findIndex((c) => c.op === "fillRect" && c.fillStyle === CROSSING.paint);
  const stripes = (ctx: RecordingTarget) => ctx.calls.filter((c) => c.op === "fillRect" && c.fillStyle === CROSSING.paint).length;

  it("with a cached ground layer: once, right after the layer's blit and before the first wall, prop or puddle", () => {
    const ground = { image: { ground: true } as unknown as SpriteImage, w: world.cols * TILE, h: world.rows * TILE };
    const ctx = recorder();
    renderFrame(ctx, items, AT_1, null, { w: world.cols * TILE, h: world.rows * TILE, world, ground, ambience: rain, timeMs: 0 });
    expect(stripes(ctx)).toBe(4);
    const blit = ctx.calls.findIndex((c) => c.op === "drawImage" && c.args[0] === ground.image && c.args[5] === 0);
    expect(blit).toBeGreaterThanOrEqual(0);
    expect(firstStripe(ctx)).toBeGreaterThan(blit);
    // The puddles (it rains) and the street's props come after it.
    const puddle = ctx.calls.findIndex((c) => c.op === "fillRect" && c.fillStyle === SKY.puddle);
    expect(puddle).toBeGreaterThan(firstStripe(ctx));
  });

  it("without one: right after the last ground tile, before the first thing that is not ground; a village frame never", () => {
    const tiles = items.filter((i) => i.t === "tile");
    const view = { w: world.cols * TILE, h: world.rows * TILE, world, timeMs: 0 };
    // A frame of nothing but ground still gets it, once — its five fills close the frame.
    const ground = recorder();
    renderFrame(ground, tiles, AT_1, null, view);
    const n = ground.calls.length;
    expect(ground.calls.slice(n - 5).map((c) => c.fillStyle)).toEqual([CROSSING.asphalt, ...Array<string>(4).fill(CROSSING.paint)]);
    expect(stripes(ground)).toBe(4);
    // With something standing on the street after the ground: the same calls first, then that thing's.
    const marker: DrawItem = { t: "prop", prop: { id: "m", kind: "bin", col: 1, row: 1, w: 1, h: 1 }, on: false, frame: 0 };
    const ctx = recorder();
    renderFrame(ctx, [...tiles, marker], AT_1, null, view);
    expect(ctx.calls.slice(0, n)).toEqual(ground.calls);
    expect(ctx.calls.length).toBeGreaterThan(n);
    expect(stripes(ctx)).toBe(4);
    const village = buildWorld(planHouses([agent("a", "p")]), { seats: 4 });
    const v = recorder();
    renderFrame(v, buildDrawList(village, [], () => false, 0), AT_1, null, { w: 800, h: 800, world: village, timeMs: 0 });
    expect(stripes(v)).toBe(0);
  });

  it("is not in the cached ground layer — the backdrop copies that layer's street beside the world, and a crossing in it would repeat there", () => {
    const layer = recorder();
    const g = paintGround(() => ({ image: {} as SpriteImage, ctx: layer }), items, world.cols, world.rows, null);
    expect(g).not.toBeNull();
    expect(layer.of("fillRect").length).toBeGreaterThan(100);
    expect(layer.of("fillRect").filter((c) => c.fillStyle === CROSSING.paint)).toEqual([]);
  });
});
