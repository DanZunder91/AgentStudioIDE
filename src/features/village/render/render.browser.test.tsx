/**
 * Layer 5 — the village renderer against a REAL 2D context in Chromium.
 *
 * The jsdom suite proves draw order and source rects through a recording fake;
 * only a real canvas can prove the vendored PNGs actually decode through Vite's
 * asset URLs, that the recolour pipeline (OffscreenCanvas getImageData /
 * putImageData) really produces pixels, and that a character lands where its
 * feet say. Assertions read back pixels with getImageData.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/render.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, buildWorld, computeAmbience, planCity, planHouses, VillageSim } from "../engine";
import { VillageView } from "../villageView";
import { METER_TONE, RACK } from "./capacity";
import { asciiWorld } from "../engine/testWorld";
import type {
  Ambience,
  CharacterView,
  DrawItem,
  WeatherParticle,
} from "../villageTypes";
import { MIN_FIT_ZOOM } from "./camera";
import { fitCamera, loadSprites, renderFrame, type Camera } from "./index";

const ZOOM = 4;

function makeCanvas(
  w = 256,
  h = 256,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return { canvas, ctx };
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** RGBA at a screen pixel. */
function px(ctx: CanvasRenderingContext2D, x: number, y: number): number[] {
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

/** Count opaque pixels in a screen rect. */
function opaque(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const d = ctx.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}

const character = (over: Partial<CharacterView> = {}): CharacterView => ({
  key: "a",
  x: 24,
  y: 40,
  dir: "down",
  anim: "idle",
  frame: 0,
  palette: 0,
  hueShift: 0,
  seated: false,
  origin: "ide",
  isSubagent: false,
  activity: "idle",
  label: "a",
  tool: null,
  bubble: null,
  bubbleAlpha: 0,
  fx: null,
  ...over,
});

const cam: Camera = { zoom: ZOOM, ox: 0, oy: 0 };

describe("village renderer in a real canvas", () => {
  it("loads every vendored PNG (not the fallback bank)", async () => {
    const bank = await loadSprites();
    expect(bank.fallback).toBe(false);
  });

  it("paints procedural grass, a vendored floor tile and a character sprite", async () => {
    const bank = await loadSprites();
    const { ctx } = makeCanvas();
    const items: DrawItem[] = [
      { t: "tile", col: 0, row: 0, kind: "grass", variant: 1 },
      { t: "tile", col: 2, row: 0, kind: "floor", variant: 3 },
      { t: "character", c: character() },
    ];
    renderFrame(ctx, items, cam, bank, { w: 256, h: 256 });

    // Grass tile (0,0): fully opaque and green-dominant.
    expect(opaque(ctx, 0, 0, 64, 64)).toBe(64 * 64);
    const [r, g, b] = px(ctx, 2, 2);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);

    // Floor tile (2,0) at screen x 128..191: fully opaque (colourised art decoded).
    expect(opaque(ctx, 128, 0, 64, 64)).toBe(64 * 64);

    // Character: feet at world (24, 40) → frame world (16, 9)..(32, 41) → screen (64, 36)..(128, 164).
    const body = opaque(ctx, 64, 36 + 4 * ZOOM, 64, 20 * 4);
    expect(body).toBeGreaterThan(64 * 80 * 0.25);
    // Nothing to the right of the sprite on the empty canvas row band.
    expect(opaque(ctx, 200, 100, 40, 40)).toBe(0);
  });

  it("smoothing stays off: a zoomed sprite has only hard, unblended edges against grass", async () => {
    const bank = await loadSprites();
    const { ctx } = makeCanvas(64, 64);
    renderFrame(
      ctx,
      [{ t: "tile", col: 0, row: 0, kind: "floor", variant: 0 }],
      cam,
      bank,
      { w: 64, h: 64 },
    );
    // Every 4×4 screen block (one art pixel at zoom 4) is a single colour.
    const d = ctx.getImageData(0, 0, 64, 64).data;
    for (let y = 0; y < 64; y += 4) {
      for (let x = 0; x < 64; x += 4) {
        const base = (y * 64 + x) * 4;
        const far = ((y + 3) * 64 + (x + 3)) * 4;
        expect(Array.from(d.slice(far, far + 4))).toEqual(
          Array.from(d.slice(base, base + 4)),
        );
      }
    }
  });

  it("a hue shift really recolours the sheet", async () => {
    const bank = await loadSprites();
    const plain = makeCanvas(128, 160).ctx;
    const shifted = makeCanvas(128, 160).ctx;
    renderFrame(plain, [{ t: "character", c: character() }], cam, bank, {
      w: 128,
      h: 160,
    });
    renderFrame(
      shifted,
      [{ t: "character", c: character({ hueShift: 150 }) }],
      cam,
      bank,
      { w: 128, h: 160 },
    );
    const a = plain.getImageData(64, 40, 64, 100).data;
    const b = shifted.getImageData(64, 40, 64, 100).data;
    let differ = 0;
    for (let i = 0; i < a.length; i += 4)
      if (a[i + 3] > 0 && (a[i] !== b[i] || a[i + 1] !== b[i + 1])) differ++;
    expect(differ).toBeGreaterThan(50);
  });

  it("the spawn effect reveals all 32 rows by t=1 — the legs included", async () => {
    const bank = await loadSprites();
    const { ctx } = makeCanvas(128, 200);
    renderFrame(
      ctx,
      [{ t: "character", c: character({ fx: { kind: "spawn", t: 1 } }) }],
      cam,
      bank,
      {
        w: 128,
        h: 200,
      },
    );
    // Rows 24..31 of the frame (the legs) → screen y 36 + 24*4 .. 36 + 32*4.
    expect(opaque(ctx, 64, 36 + 24 * ZOOM, 64, 6 * ZOOM)).toBeGreaterThan(0);
  });

  it("the fallback bank still paints a visible village", async () => {
    const { ctx } = makeCanvas(128, 128);
    renderFrame(
      ctx,
      [
        { t: "tile", col: 0, row: 0, kind: "floor", variant: 0 },
        { t: "character", c: character({ x: 8, y: 30 }) },
      ],
      fitCamera(32, 32, 128, 128),
      null,
      { w: 128, h: 128 },
    );
    expect(opaque(ctx, 0, 0, 64, 64)).toBeGreaterThan(0);
  });

  it("labels render as real text at screen scale", async () => {
    const { ctx } = makeCanvas(200, 60);
    renderFrame(
      ctx,
      [{ t: "label", x: 25, y: 10, text: "agentstudio", tone: "house" }],
      cam,
      null,
      { w: 200, h: 60 },
    );
    expect(opaque(ctx, 30, 20, 140, 20)).toBeGreaterThan(100);
  });

  it("a rainy afternoon grades and wets the outdoors, while a house interior stays exactly as lit and dry", () => {
    // 4×4 tiles at zoom 4: grass everywhere except a 2×2 house interior at tiles (2..3, 0..1).
    const world = asciiWorld(["..__", "..__", "....", "...."], {
      houses: [
        {
          key: "repo",
          label: "repo",
          col: 2,
          row: 0,
          w: 2,
          h: 2,
          doorCol: 2,
          doorRow: 2,
          hasIde: false,
        },
      ],
    });
    const items: DrawItem[] = world.tiles.map((kind, i) => ({
      t: "tile",
      col: i % 4,
      row: Math.floor(i / 4),
      kind,
      variant: 0,
    }));
    const afternoonRain: Ambience = {
      phase: "afternoon",
      daylight: 0.75,
      tint: { color: "#ffb070", alpha: 0.18 },
      weather: "rain",
      intensity: 0.7,
      wind: 0.4,
      lightsOn: false,
      campfireLit: false,
      stayIndoors: true,
    };
    const rain: WeatherParticle[] = [];
    for (let i = 0; i < 24; i++)
      rain.push({
        kind: "rain",
        x: 2 + ((i * 7) % 60),
        y: 10 + ((i * 13) % 50),
        size: 7,
        alpha: 0.8,
      });
    const draw = (view: Record<string, unknown>) => {
      const { ctx } = makeCanvas(256, 256);
      renderFrame(ctx, items, cam, null, { w: 256, h: 256, ...view });
      return ctx;
    };
    const plain = draw({});
    const graded = draw({ ambience: afternoonRain, world });
    const wet = draw({ ambience: afternoonRain, world, particles: rain });

    // Outdoors (grass at tile (0, 3)) is tinted.
    expect(px(graded, 10, 3 * 64 + 10)).not.toEqual(px(plain, 10, 3 * 64 + 10));
    // Inside the house (tile (3, 1)) the pixels are byte-identical — no grade, no rain.
    const inside = (ctx: CanvasRenderingContext2D) =>
      Array.from(ctx.getImageData(128, 0, 128, 128).data);
    expect(inside(graded)).toEqual(inside(plain));
    expect(inside(wet)).toEqual(inside(plain));
    // Rain streaks exist outdoors: pixels where the wet frame is brighter-blue than the graded one.
    const a = graded.getImageData(0, 0, 128, 256).data;
    const b = wet.getImageData(0, 0, 128, 256).data;
    let streak = 0;
    for (let i = 0; i < a.length; i += 4)
      if (b[i + 2] > a[i + 2] + 20) streak++;
    expect(streak).toBeGreaterThan(50);
  });
});

describe("the city in a real canvas", () => {
  /** A small city: a two-floor building (a leader with a team, a console), and an outside agent's. */
  const roster = planCity([
    { key: "lead", parentKey: null, origin: "ide", title: "lead", folder: "gazelle", activity: "typing", tool: "Edit", ideAgentId: "lead", lastActivityAt: null },
    { key: "s0", parentKey: "lead", origin: "ide", title: "s0", folder: "gazelle", activity: "typing", tool: "Edit", ideAgentId: "s0", lastActivityAt: null },
    { key: "s1", parentKey: "lead", origin: "ide", title: "s1", folder: "gazelle", activity: "reading", tool: "Read", ideAgentId: "s1", lastActivityAt: null },
    { key: "term:1", parentKey: null, origin: "ide", title: "zsh", folder: "gazelle", activity: "idle", tool: null, ideAgentId: null, lastActivityAt: null, consoleId: "1" },
    { key: "ext:1", parentKey: null, origin: "external", title: "far", folder: "demo", activity: "thinking", tool: null, ideAgentId: null, lastActivityAt: null },
  ]);
  const world = buildCityWorld(roster.plans);
  const W = world.cols * 16 * 2;
  const H = world.rows * 16 * 2 + 64;
  const cityCam: Camera = { zoom: 2, ox: 0, oy: 64 };

  /** The settled draw list: everyone seated, spawn effects over. */
  function settled(): DrawItem[] {
    const sim = new VillageSim({ seed: 2, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    return buildDrawList(world, sim.characters(), (id) => sim.pcOn(id), sim.time);
  }

  const day = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });
  const rainyNight = computeAmbience(new Date(2026, 9, 15, 23, 0), null, { weather: "rain", phase: "auto" });

  /** The settled city under `amb` (and these particles), in a fresh real canvas. */
  async function frame(amb: Ambience, particles: WeatherParticle[] = []): Promise<CanvasRenderingContext2D> {
    const { ctx } = makeCanvas(W, H);
    renderFrame(ctx, settled(), cityCam, await loadSprites(), { w: W, h: H, timeMs: 1000, ambience: amb, particles, world });
    return ctx;
  }

  /** Screen rect of a world-tile rect at the city camera. */
  const box = (col: number, row: number, w: number, h: number) => ({ x: col * 32, y: 64 + row * 32, w: w * 32, h: h * 32 });
  const luminance = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => {
    const d = ctx.getImageData(b.x, b.y, b.w, b.h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  };

  it("paints a sky over the roofs, a street under the buildings, and every floor furnished and staffed", async () => {
    const ctx = await frame(day);
    // Above the world: day sky, blue-dominant, on every column.
    for (const x of [4, W / 2, W - 4]) {
      const [r, g, b] = px(ctx, x, 10);
      expect(b).toBeGreaterThan(r);
      expect(b).toBeGreaterThan(g);
    }
    // The road band: dark grey asphalt.
    const street = world.city!.street;
    const [r, g, b] = px(ctx, 6, 64 + (street + 1) * 32 + 16);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
    expect(r).toBeLessThan(110);
    // Every floor is drawn in (opaque, many colours — furniture, people, the floor).
    for (const h of world.houses) {
      const room = box(h.col, h.row, h.w, h.h);
      expect(opaque(ctx, room.x, room.y, room.w, room.h)).toBe(room.w * room.h);
      const colours = new Set<number>();
      const d = ctx.getImageData(room.x, room.y, room.w, room.h).data;
      for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      expect(colours.size).toBeGreaterThan(30);
    }
  });

  it("a city too tall for zoom 1 at dpr 1 is fitted below 1 (10/16) — its top floor, its sign and its street all painted on screen", async () => {
    const tall = planCity(
      Array.from({ length: 12 }, (_, i) => ({
        key: `f${i}`, parentKey: null, origin: "ide" as const, title: `f${i}`, folder: "gazelle",
        activity: "typing" as const, tool: null, ideAgentId: `f${i}`, lastActivityAt: null,
      })),
    );
    const big = buildCityWorld(tall.plans);
    const [VW, VH] = [1200, 700];
    const cam = fitCamera(big.cols * 16, big.rows * 16, VW, VH, MIN_FIT_ZOOM); // the city's floor (VillageView)
    // The largest whole sixteenth that fits (before, only halvings: ½).
    expect(cam.zoom).toBe(10 / 16);
    const sim = new VillageSim({ seed: 2, stayPut: true });
    sim.setWorld(big);
    sim.setAgents(tall.agents);
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const { ctx } = makeCanvas(VW, VH);
    const items = buildDrawList(big, sim.characters(), (id) => sim.pcOn(id), sim.time);
    renderFrame(ctx, items, cam, await loadSprites(), { w: VW, h: VH, timeMs: 1000, ambience: day, particles: [], world: big });
    const at = (col: number, row: number, w: number, h: number) => ({
      x: cam.ox + Math.floor(col * 16 * cam.zoom), y: cam.oy + Math.floor(row * 16 * cam.zoom), w: w * 16 * cam.zoom, h: h * 16 * cam.zoom,
    });
    // The TOP floor (the last house) is on screen, furnished and staffed.
    const top = big.houses[big.houses.length - 1];
    const room = at(top.col, top.row, top.w, top.h);
    expect(room.y).toBeGreaterThanOrEqual(0);
    const d = ctx.getImageData(room.x, room.y, room.w, room.h).data;
    const colours = new Set<number>();
    for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    expect(colours.size).toBeGreaterThan(20);
    // The roof (the building's top row) is inside the canvas, under open sky.
    const b = big.city!.buildings[0];
    expect(at(b.col, b.row, 1, 1).y).toBeGreaterThan(0);
    // The road, below every floor, is still on screen: dark grey asphalt.
    const road = at(2, big.city!.street + 1, 1, 1);
    expect(road.y + road.h).toBeLessThanOrEqual(VH);
    const [r, g, bl] = px(ctx, road.x + 2, road.y + 4);
    expect(Math.max(r, g, bl) - Math.min(r, g, bl)).toBeLessThan(20);
    expect(r).toBeLessThan(110);
  });

  it("a rainy night darkens the sky and the facades, rains outdoors, and leaves every floor exactly as lit and dry", async () => {
    const lit = await frame(day);
    const unlit = await frame(rainyNight);
    const rain: WeatherParticle[] = [];
    for (let i = 0; i < 60; i++) rain.push({ kind: "rain", x: 4 + ((i * 37) % (W / 2 - 8)), y: 12 + ((i * 53) % 40), size: 8, alpha: 0.9 });
    const wet = await frame(rainyNight, rain);
    // The sky (top strip) and a building's facade go dark.
    const sky = { x: 0, y: 0, w: W, h: 48 };
    expect(luminance(unlit, sky)).toBeLessThan(luminance(lit, sky) * 0.7);
    const b = world.city!.buildings[0];
    const front = box(b.col, b.row + b.h - 1, 1, 1);
    expect(luminance(unlit, front)).toBeLessThan(luminance(lit, front));
    // Every floor's room is byte-identical: no grade, no rain inside.
    for (const h of world.houses) {
      const room = box(h.col, h.row, h.w, h.h);
      const pixels = (ctx: CanvasRenderingContext2D) => Array.from(ctx.getImageData(room.x, room.y, room.w, room.h).data);
      expect(pixels(unlit)).toEqual(pixels(lit));
      expect(pixels(wet)).toEqual(pixels(lit));
    }
    // Rain streaks in the night sky: brighter-blue pixels the dry night does not have.
    const a = unlit.getImageData(0, 0, W, 64 + 4 * 32).data;
    const c = wet.getImageData(0, 0, W, 64 + 4 * 32).data;
    let streak = 0;
    for (let i = 0; i < a.length; i += 4) if (c[i + 2] > a[i + 2] + 20) streak++;
    expect(streak).toBeGreaterThan(50);
  });
});

/**
 * The Fit zoom of the 720 × 520 city below: the largest sixteenth that shows its buildings, street,
 * lounge and the Seats hall under it (down to the subway — the world's bottom). By hand: the fit
 * target is 64 × 48 tiles (1024 × 768 px); 720 / 1024 = 0.703 → 11/16 across, 520 / 768 = 0.677 →
 * 10/16 down — the hall's 12 rows made it the height that binds (it was 11/16).
 */
const ZOOM_720 = 10 / 16;

describe("capacity buildings in a real canvas", () => {
  const day = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "auto", phase: "auto" });
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const agentOf = (key: string, folder: string) => ({
    key, parentKey: null, origin: "ide" as const, title: key, folder,
    activity: "typing" as const, tool: null, ideAgentId: key, lastActivityAt: null,
  });

  it("lights the racks, the gauges and an agent's context bar in their colours; the Seats hall with no reading is grey chairs", async () => {
    const agents = [agentOf("a", "gazelle")];
    const world = buildWorld(planHouses(agents), { seats: 4 });
    const sim = new VillageSim({ seed: 1 });
    sim.setWorld(world);
    sim.setAgents(agents);
    for (let i = 0; i < 10; i++) sim.tick(0.1);
    const frame = {
      desks: [], // the Village has no desks: its Seats are the context hall (render/hall.ts)
      hall: { cells: null, usedPct: null, tone: "unknown" as const },
      memory: { agents: 1, used: 1 },
      usage: { session: { fill: 1, tone: "ok" as const }, week: null },
      context: { a: { fill: 1, tone: "danger" as const } },
      captions: { seats: "Seats ?", memory: "Memory 1.0 GB", usage: "Usage 100% · ?", lounge: "" },
      gaugeCaptions: ["5h 100%", "week ?"] as [string, string],
    };
    const items = buildDrawList(world, sim.characters(), (id) => sim.pcOn(id), sim.time, null, { frame, seatOf: (k) => sim.seatFor(k) });
    const [VW, VH] = [world.cols * 16 * 2, world.rows * 16 * 2];
    const cam: Camera = { zoom: 2, ox: 0, oy: 0 };
    const { ctx } = makeCanvas(VW, VH);
    renderFrame(ctx, items, cam, await loadSprites(), { w: VW, h: VH, timeMs: 0, ambience: day, particles: [], world });
    const at = (wx: number, wy: number) => px(ctx, wx * 2 + 1, wy * 2 + 1).slice(0, 3);
    // Rack 0's bottom unit LED (drawRack: x0 + 5.., bottom − 6).
    const rack = world.props.find((p) => p.kind === "rack" && p.index === 0)!;
    expect(at(rack.col * 16 + 6, (rack.row + 1) * 16 - 6)).toEqual(hex(RACK.agents));
    // Gauge 0 (the 5-hour window, 100 % "ok"): its bottom band; gauge 1 (no reading): not green.
    const g0 = world.props.find((p) => p.kind === "gauge" && p.index === 0)!;
    const g1 = world.props.find((p) => p.kind === "gauge" && p.index === 1)!;
    expect(at(g0.col * 16 + 12, (g0.row + 1) * 16 - 8)).toEqual(hex(METER_TONE.ok));
    expect(at(g1.col * 16 + 12, (g1.row + 1) * 16 - 8)).not.toEqual(hex(METER_TONE.ok));
    // The context bar over a's desk: full, red.
    const meter = items.find((i) => i.t === "meter")!;
    expect(meter.t === "meter" && at(meter.x + 7, meter.y)).toEqual(hex(METER_TONE.danger));
    // The Seats hall without a reading: seat 0 (8 px in, 16 px under the hall's top) is a grey chair,
    // its cushion's middle 4 px across and 8 px down — not the velvet of an empty one.
    const hall = world.props.find((p) => p.kind === "hall")!;
    expect(at(hall.col * 16 + 12, hall.row * 16 + 24)).toEqual(hex("#4a505c"));
  });

  it("a city with the HQ in a ~720 px pane is fitted at ZOOM_720 (not ½): every building, the HQ in the middle, its lounge under the street and the Seats hall under that on screen", async () => {
    const roster = planCity([agentOf("a", "gazelle"), agentOf("b", "Agent Studio"), agentOf("c", "zeta")]);
    const view = new VillageView(1, () => null, "city");
    view.setWorld(buildCityWorld(roster.plans, { seats: 64 }));
    view.setAgents(roster.agents);
    // Three agents hold a seat; the other 61 seats are free — a waiter on each.
    const agents = ["a", "b", "c"].map((k) => agentOf(k, "x"));
    view.setCapacity({ machine: null, machineError: null, agents, includesOutside: true, usage: null, usageError: null, context: {}, nowMs: 0, lounge: true });
    view.setBank(await loadSprites());
    view.resize(720, 520, 1);
    expect(view.camera.zoom).toBe(ZOOM_720);
    const { ctx } = makeCanvas(720, 520);
    view.frame(0, ctx);
    const bs = view.world.city!.buildings;
    const { zoom, ox, oy } = view.camera;
    // The HQ stands in the middle of the street: a project on either side of it.
    const hq = bs.findIndex((b) => b.hq);
    expect(hq).toBeGreaterThan(0);
    expect(hq).toBeLessThan(bs.length - 1);
    expect(ox + bs[0].col * 16 * zoom).toBeGreaterThanOrEqual(0);
    const last = bs[bs.length - 1];
    expect(ox + (last.col + last.w) * 16 * zoom).toBeLessThanOrEqual(720);
    // The lounge, walls included, is on screen too — under the HQ.
    const lounge = view.world.houses.find((h) => h.capacity === "lounge")!;
    expect(ox + (lounge.col - 1) * 16 * zoom).toBeGreaterThanOrEqual(0);
    expect(ox + (lounge.col + lounge.w + 1) * 16 * zoom).toBeLessThanOrEqual(720);
    expect(oy + (lounge.row + lounge.h + 1) * 16 * zoom).toBeLessThanOrEqual(520);
    // The Seats hall under the lounge, walls included, too.
    const hall = view.world.houses.find((h) => h.capacity === "seats")!;
    expect(hall.row).toBeGreaterThan(lounge.row + lounge.h);
    expect(ox + (hall.col - 1) * 16 * zoom).toBeGreaterThanOrEqual(0);
    expect(ox + (hall.col + hall.w + 1) * 16 * zoom).toBeLessThanOrEqual(720);
    expect(oy + (hall.row + hall.h + 1) * 16 * zoom).toBeLessThanOrEqual(520);
    // Its waiting agents are painted: the hall holds many colours (sprites, benches, plants), not a flat fill.
    const [lx, ly] = [Math.round(ox + lounge.col * 16 * zoom), Math.round(oy + (lounge.row + 2) * 16 * zoom)];
    const d = ctx.getImageData(lx, ly, Math.round(lounge.w * 16 * zoom), Math.round(2 * 16 * zoom)).data;
    const colours = new Set<number>();
    for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    expect(colours.size).toBeGreaterThan(30);
    // The fit target is at least half the pane wide: framed, not a sliver in empty ground.
    expect(view.fitTarget().w * zoom).toBeGreaterThan(360);
  });
});

describe("a LAN cable and its packets in a real canvas", () => {
  /** |ΔR| + |ΔG| + |ΔB| of pixel (x, y) between two same-sized RGBA buffers `w` px wide. */
  const dist = (a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  };

  it("a cable reads on every room floor and the door threshold, at 1 and at the ½ Fit floor; both packet kinds show on it, the team one louder", async () => {
    const { HOUSE_FLOORS, THRESHOLD_FLOOR } = await import("../engine/drawList");
    const { CABLE } = await import("./lan");
    const bank = await loadSprites();
    const variants = [...new Set<number>([...HOUSE_FLOORS, THRESHOLD_FLOOR])];
    const W = variants.length * 16;
    const floor: DrawItem[] = variants.map((variant, col) => ({ t: "tile", col, row: 0, kind: "floor", variant }));
    const run = (y: number): DrawItem => ({ t: "cable", x0: 1, y0: y, x1: W - 1, y1: y });
    const shot = (items: DrawItem[], zoom: number): Uint8ClampedArray => {
      const [w, h] = [W * zoom, 16 * zoom];
      const { ctx } = makeCanvas(w, h);
      renderFrame(ctx, items, { zoom, ox: 0, oy: 0 }, bank, { w, h });
      return ctx.getImageData(0, 0, w, h).data;
    };

    // Zoom 1: both of the cable's rows (7 = lit edge, 8 = core) differ clearly from the bare
    // floor in every column, over every room floor variant and the door threshold.
    const bare = shot(floor, 1);
    const wired = shot([...floor, run(8)], 1);
    const rowDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray, row: number) => Array.from({ length: W }, (_, x) => dist(a, b, W, x, row));
    expect(Math.min(...rowDiff(bare, wired, 7)), "lit edge vs floor").toBeGreaterThanOrEqual(50);
    expect(Math.min(...rowDiff(bare, wired, 8)), "core vs floor").toBeGreaterThanOrEqual(80);
    // Off the cable, nothing changed.
    for (const row of [3, 6, 9]) expect(Math.max(...rowDiff(bare, wired, row)), `row ${row}`).toBe(0);

    // ½: rows 8 and 9 share screen row 4 — and it is the core that shows, in every column.
    const half = W / 2;
    const wiredHalf = shot([...floor, run(9)], 0.5);
    const core = [1, 3, 5].map((i) => parseInt(CABLE.core.slice(i, i + 2), 16));
    for (let x = 0; x < half; x++) expect(Array.from(wiredHalf.slice((4 * half + x) * 4, (4 * half + x) * 4 + 3)), `½, column ${x}`).toEqual(core);

    // Packets on the cable, one per floor variant at its tile's centre: each shows against the
    // cable under it and the floor round it, and the team one is louder than the uplink.
    const centres = variants.map((_, i) => i * 16 + 8);
    const packets = (kind: "team" | "uplink") =>
      shot([...floor, run(8), ...centres.map((x): DrawItem => ({ t: "packet", x, y: 8, kind, hue: 200 }))], 1);
    const team = packets("team");
    const up = packets("uplink");
    for (const x of centres) {
      expect(dist(team, wired, W, x, 8), `team on the cable at ${x}`).toBeGreaterThanOrEqual(150);
      expect(dist(team, bare, W, x, 8), `team vs the floor at ${x}`).toBeGreaterThanOrEqual(100);
      expect(dist(up, wired, W, x, 8), `uplink on the cable at ${x}`).toBeGreaterThanOrEqual(100);
      expect(dist(up, bare, W, x, 8), `uplink vs the floor at ${x}`).toBeGreaterThanOrEqual(30);
    }
    let [teamN, upN, teamSum, upSum] = [0, 0, 0, 0];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < W; x++) {
        const t = dist(team, wired, W, x, y);
        const u = dist(up, wired, W, x, y);
        teamN += t > 0 ? 1 : 0;
        upN += u > 0 ? 1 : 0;
        teamSum += t;
        upSum += u;
      }
    expect(teamN).toBe(centres.length * 25); // 5×5 each: the body and its rim
    expect(upN).toBe(centres.length * 4); // 2×2 each
    expect(teamSum).toBeGreaterThan(2 * upSum);
  });
});

describe("a project room's Wi-Fi router and pulses in a real canvas", () => {
  // Self-contained: its own helpers and dynamic imports, independent of the other blocks in this file.
  const Z = 4;
  const noonClear = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  /** |ΔR| + |ΔG| + |ΔB|. */
  const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  type Agent = Parameters<typeof planHouses>[0][number];
  const ag = (key: string, folder: string, parentKey: string | null = null): Agent => ({
    key, parentKey, origin: "ide", title: key, folder, activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null,
  });
  /** In `folder`: a project house with team tables (5 sub-agents, two tables), and a city floor with a 12-sub team. */
  const worlds = (folder = "gazelle") =>
    [
      ["village", buildWorld(planHouses([ag("boss", folder), ...Array.from({ length: 5 }, (_, i) => ag(`s${i}`, folder, "boss"))]))],
      ["city", buildCityWorld(planCity([ag("lead", folder), ...Array.from({ length: 12 }, (_, i) => ag(`t${i}`, folder, "lead"))]).plans)],
    ] as const;

  /**
   * The world's real draw list (nobody in it) plus `extra` items, through `renderFrame` at zoom 4 in a
   * 128×64 world px window with the router's tile at (56, 24). The router PROP item is taken out and the
   * router painted by `drawRouter` itself (`on`, `frame`): the prop dispatch is props.ts's, tested with
   * props.ts — this block proves the art reads in place, and the pulses through the real frame.
   * `at` reads the pixel under a world px.
   */
  async function scene(world: ReturnType<typeof buildWorld>, opts: { on?: boolean; frame?: number; extra?: (x0: number, top: number) => DrawItem[] } = {}) {
    const { drawRouter } = await import("./router");
    const r = world.props.find((p) => p.kind === "router")!;
    const items = buildDrawList(world, [], () => false, 0).filter((i) => !(i.t === "prop" && i.prop === r));
    const [x0, top] = [r.col * 16, r.row * 16];
    const [wx0, wy0] = [x0 - 56, top - 24];
    const cam: Camera = { zoom: Z, ox: -wx0 * Z, oy: -wy0 * Z };
    const [W, H] = [128 * Z, 64 * Z];
    const { ctx } = makeCanvas(W, H);
    renderFrame(ctx, [...items, ...(opts.extra?.(x0, top) ?? [])], cam, await loadSprites(), { w: W, h: H, timeMs: 0, ambience: noonClear, particles: [], world });
    drawRouter(ctx, cam, x0, top + 16, opts.on ?? false, opts.frame ?? 0);
    const at = (wx: number, wy: number) => px(ctx, (wx - wx0) * Z + 1, (wy - wy0) * Z + 1).slice(0, 3);
    return { x0, top, bottom: top + 16, at };
  }

  it("hangs on the back wall of a project room in both views: a white box in a dark outline that reads against the floor and the wall", async () => {
    const { ROUTER } = await import("./router");
    for (const [view, world] of worlds()) {
      const { x0, top, bottom, at } = await scene(world);
      expect(at(x0 + 8, top + 3), `${view}: white top`).toEqual(hex(ROUTER.top));
      expect(at(x0 + 7, top + 6), `${view}: LED window, between two LEDs`).toEqual(hex(ROUTER.window));
      expect(at(x0 + 1, top + 4), `${view}: outline`).toEqual(hex(ROUTER.outline));
      expect(at(x0 + 5, top + 8), `${view}: outline's bottom edge`).toEqual(hex(ROUTER.outline));
      // The antennas rise over the wall's foot, light-tipped.
      expect(at(x0 + 2, top - 4), `${view}: left tip`).toEqual(hex(ROUTER.tip));
      expect(at(x0 + 13, top - 3), `${view}: right antenna`).toEqual(hex(ROUTER.antenna));
      // Sample points nothing else draws on: the wall left of the router, under the house board / floor
      // plate and above the wall's dark foot line; the floor at the tile's bottom-left, left of the team
      // LAN's trunk (it leaves the port at the tile centre, x0 + 7..8) and below its tray (bottom − 9..7).
      const wall = at(x0 - 4, top - 4);
      const floor = at(x0 + 3, bottom - 3);
      const outline = hex(ROUTER.outline);
      expect(lum(wall) - lum(outline), `${view}: outline vs wall`).toBeGreaterThan(60);
      expect(lum(floor) - lum(outline), `${view}: outline vs floor`).toBeGreaterThan(60);
      expect(lum(hex(ROUTER.top)) - lum(floor), `${view}: a white box on the floor`).toBeGreaterThan(30);
    }
  });

  it("its activity LEDs: dim when off, lit with one flashing per frame when on — the power LED lit either way — in both views", async () => {
    const { ROUTER } = await import("./router");
    const expected = [
      [ROUTER.ledBlink, ROUTER.ledOn, ROUTER.ledOn],
      [ROUTER.ledOn, ROUTER.ledOn, ROUTER.ledBlink],
      [ROUTER.ledOn, ROUTER.ledBlink, ROUTER.ledOn],
    ];
    for (const [view, world] of worlds())
      for (const frame of [0, 1, 2])
        for (const on of [true, false]) {
          const { x0, top, at } = await scene(world, { on, frame });
          const leds = [0, 1, 2].map((i) => at(x0 + 6 + 2 * i, top + 6));
          expect(leds, `${view}, frame ${frame}, ${on ? "on" : "off"}`).toEqual((on ? expected[frame] : [ROUTER.ledOff, ROUTER.ledOff, ROUTER.ledOff]).map(hex));
          expect(at(x0 + 4, top + 6), `${view}: power`).toEqual(hex(ROUTER.power));
        }
  });

  it("a Wi-Fi pulse reads on the back wall of every house hue, in both views, whatever the team's hue", async () => {
    const { wifiRadius } = await import("./lan");
    const { HOUSE_HUES, houseStyles } = await import("../engine/drawList");
    const r = wifiRadius(0.3);
    // One folder per house hue (a house's hue is its key's: houseStyles), so every wall colour is met.
    const folders = HOUSE_HUES.map((h) => Array.from({ length: 400 }, (_, i) => `p${i}`).find((n) => houseStyles([n]).get(n)!.hue === h)!);
    expect(new Set(folders).size).toBe(HOUSE_HUES.length);
    for (const folder of folders)
      for (const [view, world] of worlds(folder)) {
        // On the wall face 1.5 tiles left of the router — clear of the board / plate, the antennas, tall
        // furniture and the wall's foot line: every cell the pulse covers is one plain wall colour.
        const bare = await scene(world);
        const [cx, cy] = [bare.x0 - 24, bare.top - 9];
        const plain = new Set<string>();
        for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) plain.add(String(bare.at(cx + dx, cy + dy)));
        expect(plain.size, `${view} ${folder}: plain wall under the pulse`).toBe(1);
        for (let hue = 0; hue < 360; hue += 45) {
          const lit = await scene(world, { extra: () => [{ t: "wifi", x: cx, y: cy, phase: 0.3, hue }] });
          for (const [ux, uy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            const d = (k: number) => dist(bare.at(cx + ux * k, cy + uy * k), lit.at(cx + ux * k, cy + uy * k));
            expect(Math.max(d(r), d(r + 1)), `${view} ${folder}, hue ${hue}, (${ux}, ${uy})`).toBeGreaterThanOrEqual(100);
          }
        }
      }
  });

  it("a Wi-Fi pulse reads on every project room floor whatever the team's hue — and fades as it spreads", async () => {
    const { wifiRadius } = await import("./lan");
    const { HOUSE_FLOORS } = await import("../engine/drawList");
    const bank = await loadSprites();
    const shot = (items: DrawItem[], w: number, h: number) => {
      const { ctx } = makeCanvas(w, h);
      renderFrame(ctx, items, { zoom: 1, ox: 0, oy: 0 }, bank, { w, h });
      return ctx;
    };
    // One tile of each room floor in a row, a pulse centred on each (radius 5: inside its tile).
    const r = wifiRadius(0.3);
    const W = HOUSE_FLOORS.length * 16;
    const floor: DrawItem[] = HOUSE_FLOORS.map((variant, col) => ({ t: "tile", col, row: 0, kind: "floor", variant }));
    const bare = shot(floor, W, 16);
    for (let hue = 0; hue < 360; hue += 15) {
      const lit = shot([...floor, ...HOUSE_FLOORS.map((_, i): DrawItem => ({ t: "wifi", x: i * 16 + 8, y: 8, phase: 0.3, hue }))], W, 16);
      HOUSE_FLOORS.forEach((variant, i) => {
        for (const [ux, uy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const at = (k: number) => [i * 16 + 8 + ux * k, 8 + uy * k] as const;
          const d = (k: number) => dist(px(bare, ...at(k)), px(lit, ...at(k)));
          expect(Math.max(d(r), d(r + 1)), `floor ${variant}, hue ${hue}, (${ux}, ${uy})`).toBeGreaterThanOrEqual(100);
        }
      });
    }
    // Fading: on a 3×3 patch of one floor, the most a pulse changes any pixel drops as its phase grows.
    const patch: DrawItem[] = Array.from({ length: 9 }, (_, i) => ({ t: "tile", col: i % 3, row: Math.floor(i / 3), kind: "floor", variant: HOUSE_FLOORS[0] }));
    const base = shot(patch, 48, 48).getImageData(0, 0, 48, 48).data;
    const strength = (phase: number) => {
      const d = shot([...patch, { t: "wifi", x: 24, y: 24, phase, hue: 200 }], 48, 48).getImageData(0, 0, 48, 48).data;
      let most = 0;
      for (let i = 0; i < d.length; i += 4) most = Math.max(most, dist([base[i], base[i + 1], base[i + 2]], [d[i], d[i + 1], d[i + 2]]));
      return most;
    };
    const [early, mid, late] = [0.1, 0.5, 0.9].map(strength);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
    expect(strength(1)).toBe(0);
  });
});

describe("the Tokyo street props in a real canvas", () => {
  // Self-contained: its own helpers and a dynamic import, independent of the other blocks in this file.
  // The painters are called directly (the props.ts dispatch is tested with props.ts), each over the
  // ground it really stands on: the village's grass, the city's sky and sidewalk.
  const Z = 4;
  const zcam: Camera = { zoom: Z, ox: 0, oy: 0 };
  const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const lumOf = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const gap = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  /** Pink: red strongest, green weakest, and bright — what neither grass, sky, asphalt nor a facade is. */
  const pink = ([r, g, b]: number[]) => r > 170 && r > g + 40 && b > g;
  const noon = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });

  /** A field of grass `cols`×`rows` tiles at zoom 4, `paint` drawn over it; `at` reads the pixel under a world px. */
  async function onGrass(cols: number, rows: number, paint: (ctx: CanvasRenderingContext2D) => void) {
    const [W, H] = [cols * 16 * Z, rows * 16 * Z];
    const { ctx } = makeCanvas(W, H);
    const tiles: DrawItem[] = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) tiles.push({ t: "tile", col: c, row: r, kind: "grass", variant: (c + 2 * r) & 3 });
    renderFrame(ctx, tiles, zcam, await loadSprites(), { w: W, h: H });
    paint(ctx);
    return { ctx, at: (wx: number, wy: number) => px(ctx, wx * Z + 1, wy * Z + 1).slice(0, 3) };
  }

  it("a sakura's canopy reads pink against the grass, on a dark trunk — and its petals fall over the grass", async () => {
    const { drawSakura, sakuraPetals, SAKURA } = await import("./tokyoProps");
    const [x0, b] = [16, 64];
    const t = 1.1;
    const { at } = await onGrass(4, 4, (ctx) => drawSakura(ctx, zcam, x0, b, t));
    const grass = at(x0 + 40, b - 30); // right of the tree's art: bare grass
    expect(grass[1]).toBeGreaterThan(grass[0]);
    for (const [dx, dy] of [[16, 30], [4, 26], [26, 24], [14, 36]]) {
      const c = at(x0 + dx, b - dy);
      expect(pink(c), `canopy at (${dx}, -${dy}): ${c}`).toBe(true);
      expect(gap(c, grass), `canopy vs grass at (${dx}, -${dy})`).toBeGreaterThan(200);
    }
    expect(at(x0 + 16, b - 6)).toEqual(rgbOf(SAKURA.trunk));
    expect(lumOf(rgbOf(SAKURA.trunk))).toBeLessThan(lumOf(grass) - 30);
    // The petals below the canopy (clear of the trunk) land on the canvas in their colours, over grass.
    const below = sakuraPetals(x0, b, t).filter((p) => p.y > b - 16 && (p.x + p.w <= x0 + 13 || p.x >= x0 + 20));
    expect(below.length).toBeGreaterThan(0);
    for (const p of below) {
      expect(at(p.x, p.y), `petal at (${p.x}, ${p.y})`).toEqual(rgbOf(p.color));
      expect(gap(rgbOf(p.color), grass)).toBeGreaterThan(200);
    }
  });

  it("the petals are visible and moving: pink pixels below the canopy, different half a second later", async () => {
    const { drawSakura } = await import("./tokyoProps");
    const [x0, b] = [16, 64];
    /** Pink pixels in the band between the canopy's underside and the ground, outside the trunk and its shadow. */
    const petalsIn = (ctx: CanvasRenderingContext2D) => {
      const out: number[] = [];
      const [y0, y1] = [(b - 15) * Z, (b - 4) * Z];
      const d = ctx.getImageData(0, y0, 4 * 16 * Z, y1 - y0).data;
      for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % (4 * 16 * Z);
        if (x >= (x0 + 12) * Z && x < (x0 + 21) * Z) continue;
        if (pink([d[i], d[i + 1], d[i + 2]])) out.push(i);
      }
      return out;
    };
    const shots = await Promise.all([0.3, 0.8, 1.9, 3.1].map(async (t) => petalsIn((await onGrass(4, 4, (ctx) => drawSakura(ctx, zcam, x0, b, t))).ctx)));
    expect(shots.filter((s) => s.length > 0).length).toBeGreaterThanOrEqual(3);
    expect(shots[1]).not.toEqual(shots[0]);
    expect(shots[3]).not.toEqual(shots[2]);
  });

  it("in the city, a street sakura's canopy reads pink against the day sky and the far skyline behind it", async () => {
    const { drawSakura } = await import("./tokyoProps");
    const world = buildCityWorld([]);
    const street = world.city!.street;
    const [W, H] = [12 * 16 * Z, (street + 4) * 16 * Z];
    const { ctx } = makeCanvas(W, H);
    renderFrame(ctx, buildDrawList(world, [], () => false, 0), zcam, await loadSprites(), { w: W, h: H, timeMs: 0, ambience: noon, particles: [], world });
    // A gap between the street's first lamps (4 and 12): the tree on the sidewalk, the backdrop behind its canopy.
    const [x0, b] = [7 * 16, (street + 1) * 16];
    const at = (wx: number, wy: number) => px(ctx, wx * Z + 1, wy * Z + 1).slice(0, 3);
    const spots = [[16, 30], [4, 26], [26, 24], [14, 36], [1, 25], [30, 25]];
    const behind = spots.map(([dx, dy]) => at(x0 + dx, b - dy));
    const above = at(x0 + 16, b - 44);
    drawSakura(ctx, zcam, x0, b, 0.5);
    spots.forEach(([dx, dy], i) => {
      const [bg, c] = [behind[i], at(x0 + dx, b - dy)];
      // The backdrop there is blue-leaning (sky, or the far skyline); the canopy over it is pink.
      expect(bg[2], `backdrop at (${dx}, -${dy}): ${bg}`).toBeGreaterThan(bg[0]);
      expect(pink(c), `canopy at (${dx}, -${dy}): ${c}`).toBe(true);
      expect(c[0] - bg[0], `canopy redder than the backdrop at (${dx}, -${dy})`).toBeGreaterThan(60);
      expect(gap(c, bg), `canopy vs backdrop at (${dx}, -${dy})`).toBeGreaterThan(80);
    });
    expect(at(x0 + 16, b - 44)).toEqual(above); // and nothing above the art
  });

  it("a vending machine: its lit window stands out from the blue or red body, brighter at night; the pickup slot is dark", async () => {
    const { drawVending, VENDING } = await import("./tokyoProps");
    const [x0, b] = [16, 48];
    const glassAt = (at: (x: number, y: number) => number[]) => at(x0 + 12, b - 27); // the window's clear top-right corner
    const lum: Record<string, number> = {};
    for (const v of [0, 1] as const)
      for (const night of [false, true]) {
        const { at } = await onGrass(3, 3, (ctx) => drawVending(ctx, zcam, x0, b, v, night));
        const body = at(x0 + 13, b - 20);
        const glass = glassAt(at);
        expect(body, `variant ${v} body`).toEqual(rgbOf(VENDING.body[v].base));
        expect(glass, `variant ${v} glass`).toEqual(rgbOf(night ? VENDING.glassNight : VENDING.glassDay));
        expect(lumOf(glass) - lumOf(body), `variant ${v}: window over body`).toBeGreaterThan(80);
        if (v === 0) expect(body[2]).toBeGreaterThan(body[0] + 60);
        else expect(body[0]).toBeGreaterThan(body[2] + 60);
        // A bottle in the window, and the slot near the bottom: darker than everything round it.
        expect(gap(at(x0 + 3, b - 25), glass)).toBeGreaterThan(60);
        expect(lumOf(at(x0 + 7, b - 4))).toBeLessThan(40);
        lum[`${v}${night}`] = lumOf(glass);
      }
    expect(lum["0true"]).toBeGreaterThan(lum["0false"]);
    expect(lum["1true"]).toBeGreaterThan(lum["1false"]);
  });

  it("a torii: vermilion pillars and a black kasagi with upturned ends, standing out on the grass", async () => {
    const { drawTorii, TORII } = await import("./tokyoProps");
    const [x0, b] = [8, 64];
    const { at } = await onGrass(4, 4, (ctx) => drawTorii(ctx, zcam, x0, b));
    const grass = at(x0 + 24, b - 12); // between the pillars, under the nuki: you see the grass through the gate
    expect(grass[1]).toBeGreaterThan(grass[0]);
    expect(at(x0 + 10, b - 20)).toEqual(rgbOf(TORII.vermilion));
    expect(at(x0 + 36, b - 20)).toEqual(rgbOf(TORII.vermilion));
    expect(at(x0 + 24, b - 40)).toEqual(rgbOf(TORII.black));
    expect(at(x0 + 1, b - 42)).toEqual(rgbOf(TORII.black));
    expect(at(x0 + 46, b - 42)).toEqual(rgbOf(TORII.black));
    expect(gap(rgbOf(TORII.vermilion), grass)).toBeGreaterThan(200);
  });

  it("the vending glow brightens the night round the machine, and only there", async () => {
    const { vendingGlow, vendingGlowBox } = await import("./tokyoProps");
    const [x0, b] = [32, 64];
    const dark = (ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = "#101820";
      ctx.fillRect(0, 0, 6 * 16 * Z, 5 * 16 * Z);
    };
    const { ctx: plain } = makeCanvas(6 * 16 * Z, 5 * 16 * Z);
    dark(plain);
    const { ctx: lit } = makeCanvas(6 * 16 * Z, 5 * 16 * Z);
    dark(lit);
    vendingGlow(lit, zcam, x0, b);
    const at = (ctx: CanvasRenderingContext2D, wx: number, wy: number) => px(ctx, wx * Z + 1, wy * Z + 1).slice(0, 3);
    expect(lumOf(at(lit, x0 + 7, b - 21))).toBeGreaterThan(lumOf(at(plain, x0 + 7, b - 21)) + 25);
    const [gx, gy, gw, gh] = vendingGlowBox(x0, b);
    for (const [wx, wy] of [[gx - 2, gy + 4], [gx + gw + 2, gy + 4], [gx + 4, gy - 2], [gx + gw / 2, gy + gh + 2]])
      expect(at(lit, wx, wy), `outside the box at (${wx}, ${wy})`).toEqual(at(plain, wx, wy));
  });
});

describe("the City's sky through the day in a real canvas", () => {
  // Self-contained: its own helpers and dynamic imports, independent of the other blocks in this file.
  // Tokyo on 2026-10-19: sunrise 05:52, sunset 17:05 — so 16:19 is Evening.
  const tokyo = (h: number, m = 0, kind: "clear" | "rain" = "clear") =>
    computeAmbience(
      new Date(2026, 9, 19, h, m),
      {
        kind,
        intensity: kind === "clear" ? 0 : 0.8,
        temperatureC: 24,
        wind: 0,
        sunriseMs: new Date(2026, 9, 19, 5, 52).getTime(),
        sunsetMs: new Date(2026, 9, 19, 17, 5).getTime(),
        place: "Tokyo",
        fetchedAtMs: 0,
      },
      { weather: "auto", phase: "auto" },
    );
  const hue = ([r, g, b]: number[]) => {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  // An EMPTY street (no buildings), so nothing stands between the camera and the open sky but the far
  // skyline (≤ 3 tiles tall) and the street's lamps.
  const world = buildCityWorld(planCity([]).plans);
  const horizon = world.city!.street * 16;
  const cam: Camera = { zoom: 1, ox: 0, oy: 40 };
  const [W, H] = [world.cols * 16, world.rows * 16 + 40];

  async function frame(amb: Ambience): Promise<CanvasRenderingContext2D> {
    const { ctx } = makeCanvas(W, H);
    renderFrame(ctx, buildDrawList(world, [], () => false, 0), cam, await loadSprites(), { w: W, h: H, timeMs: 0, ambience: amb, particles: [], world });
    return ctx;
  }
  /** The pixel at world (wx, wy). */
  const at = (ctx: CanvasRenderingContext2D, wx: number, wy: number) => px(ctx, wx, wy + 40).slice(0, 3);
  /** Low sky: 4 px above the tallest the far skyline gets (3 tiles), in the street's left margin — open sky, always. */
  const LOW: [number, number] = [20, horizon - 3 * 16 - 4];
  const HIGH: [number, number] = [20, 8];

  it("noon is a blue sky; 16:19 is golden hour — warm low, still blue high; 16:55 a sunset; 21:00 a navy night", async () => {
    const noon = await frame(tokyo(12));
    const golden = await frame(tokyo(16, 19));
    const sunset = await frame(tokyo(16, 55));
    const night = await frame(tokyo(21));
    for (const [x, y] of [HIGH, LOW]) {
      const [r, , b] = at(noon, x, y);
      expect(b, "noon is blue").toBeGreaterThan(r + 20);
    }
    const g = at(golden, ...LOW);
    expect(g[0] - g[2], `golden low sky ${g}`).toBeGreaterThan(60);
    expect(hue(g)).toBeGreaterThanOrEqual(20);
    expect(hue(g)).toBeLessThanOrEqual(55);
    const gh = at(golden, ...HIGH);
    expect(gh[2], `golden high sky ${gh}`).toBeGreaterThan(gh[0] + 40);
    const s = at(sunset, ...LOW);
    expect(s[0], `sunset low sky ${s}`).toBeGreaterThan(s[2] + 40);
    expect(hue(s) <= 40 || hue(s) >= 320).toBe(true);
    const sh = at(sunset, ...HIGH);
    expect(sh[2], `sunset high sky ${sh}`).toBeGreaterThan(sh[0]);
    expect(lum(sh)).toBeLessThan(lum(gh));
    for (const p of [HIGH, LOW]) expect(lum(at(night, ...p))).toBeLessThan(60);
  });

  /**
   * A world x on row `wy` that no cloud covers in this frame (render/clouds.ts — they fill the whole sky
   * now), so a sample there is the open sky's: the same field painted into a
   * recorder, world-locked, at the frame's clock (0).
   */
  async function openX(amb: Ambience, wy: number): Promise<number> {
    const { paintClouds } = await import("./clouds");
    const { recorder } = await import("./testRecorder");
    const rec = recorder();
    paintClouds(rec, { zoom: 1, ox: 0, oy: 0 }, { x0: 0, x1: W, y0: -40, y1: horizon }, horizon, amb.weather, amb.intensity, 0, amb.wind, { body: "#000001", under: "#000002" });
    const rects = rec.of("fillRect").map((c) => c.args as number[]);
    for (let x = 20; x < W - 20; x += 4) if (!rects.some(([rx, ry, rw, rh]) => x >= rx - 2 && x < rx + rw + 2 && wy >= ry - 2 && wy < ry + rh + 2)) return x;
    throw new Error(`no open sky on row ${wy} (${amb.weather})`);
  }

  it("the grade lands on the sky once: every open-sky pixel is the colour the band was MEANT to be (as near as the grade allows)", async () => {
    const { citySky, gradeColor } = await import("../engine/ambience");
    for (const amb of [tokyo(16, 19), tokyo(16, 55), tokyo(17, 20), tokyo(21), tokyo(16, 55, "rain")]) {
      expect(amb.tint.alpha).toBeGreaterThan(0.1); // a grade strong enough that tinting twice would show
      const ctx = await frame(amb);
      const { seen } = citySky(amb);
      // What any pixel under this grade can become at all: from black graded to white graded.
      const lo = rgbOf(gradeColor(amb, "#000000"));
      const hi = rgbOf(gradeColor(amb, "#ffffff"));
      for (let i = 0; i < seen.length - 4; i++) {
        const y = Math.round((horizon * (i + 0.5)) / seen.length);
        const meant = rgbOf(seen[i]).map((v, c) => Math.min(hi[c], Math.max(lo[c], v)));
        const got = at(ctx, await openX(amb, y), y);
        for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - meant[c]), `${amb.phase} band ${i}: ${got} vs ${meant}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("the sun is yellow at noon, and bigger and orange low in the golden-hour sky", async () => {
    const { bodyCenter } = await import("./city");
    const sunAt = async (amb: Ambience) => {
      const ctx = await frame(amb);
      const c = bodyCenter(world, amb.arc!.t);
      // Its width: the run of sun-coloured pixels along its centre row (bright, warm, opaque).
      const row = ctx.getImageData(0, c.y + 40, W, 1).data;
      let n = 0;
      for (let x = c.x - 16; x <= c.x + 16; x++) {
        const p = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]];
        if (p[0] > 200 && p[0] > p[2] + 60) n++;
      }
      return { color: at(ctx, c.x + 2, c.y + 2), width: n };
    };
    const noon = await sunAt(tokyo(12));
    const low = await sunAt(tokyo(16, 19));
    expect(hue(noon.color), `noon sun ${noon.color}`).toBeGreaterThan(42);
    expect(hue(low.color), `16:19 sun ${low.color}`).toBeLessThan(40);
    expect(low.width).toBeGreaterThan(noon.width);
  });

  it("far windows: panes by day, none lit; a few lit at 16:19, more at sunset, the most at night — bright on the dark sky", async () => {
    const { CITY } = await import("./city");
    const win = rgbOf(CITY.window);
    const pane = rgbOf(CITY.skylinePane);
    /** Pixels exactly of `c` in the skyline band. */
    const count = (ctx: CanvasRenderingContext2D, c: number[]) => {
      const d = ctx.getImageData(0, horizon - 3 * 16 + 40, W, 3 * 16).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2]) n++;
      return n;
    };
    const noon = await frame(tokyo(12));
    expect(count(noon, pane)).toBeGreaterThan(100);
    const lit = [];
    for (const [h, m] of [[12, 0], [15, 30], [16, 19], [16, 55], [17, 20], [21, 0]]) lit.push(count(await frame(tokyo(h, m)), win));
    expect(lit[0]).toBe(0);
    expect(lit[1]).toBe(0);
    expect(lit[2]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < lit.length; i++) expect(lit[i], `lit ${lit}`).toBeGreaterThanOrEqual(lit[i - 1]);
    expect(lit[5]).toBeGreaterThan(lit[2] * 4);
  });

  it("the village is graded exactly as before: its grass at 16:19 is the grass under the evening's warm tint, nothing more", async () => {
    const village = buildWorld(planHouses([]));
    const draw = async (amb?: Ambience) => {
      const { ctx } = makeCanvas(128, 128);
      renderFrame(ctx, buildDrawList(village, [], () => false, 0), { zoom: 1, ox: 0, oy: 0 }, await loadSprites(), {
        w: 128, h: 128, timeMs: 0, ambience: amb, particles: [], world: village,
      });
      return ctx;
    };
    const amb = tokyo(16, 19);
    expect(amb.tint).toEqual({ color: "#ff8e42", alpha: 0.188 });
    const plain = await draw();
    const graded = await draw(amb);
    const tint = rgbOf(amb.tint.color);
    for (const [x, y] of [[5, 5], [60, 9], [100, 100]]) {
      const p = px(plain, x, y);
      const want = p.slice(0, 3).map((v, i) => v * (1 - 0.188) + tint[i] * 0.188);
      const got = px(graded, x, y).slice(0, 3);
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]), `(${x},${y}) ${got} vs ${want}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("the Tokyo landmarks in a real canvas", () => {
  // Self-contained: its own fixtures and dynamic imports, independent of the other blocks in this file.
  /** |ΔR| + |ΔG| + |ΔB| of two pixels. */
  const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const plan = (i: number, floors: number) => ({
    key: `p${i}`, label: `p${i}`, team: 2, hasIde: true,
    floors: Array.from({ length: floors }, (_, f) => ({ key: `floor:${i}:${f}`, label: `a${i}.${f}`, ide: true })),
  });
  /**
   * The capacity HQ in the middle of the street, a five-floor project right of it and a three-floor one
   * left: the HQ stands between the towers (the towers stand apart) — the Tower
   * in the gap left of it, the Skytree in the gap right of it — and Fuji over the HQ, its snow cap clear
   * of every roof, wide enough (288 px tall) to stand behind both. The five floors give the sky (496 px)
   * that puts both towers' sampled bodies above the far skyline's band. (The shortest city, the HQ's own
   * 240-px sky, has neither: its Tower is lit only from 41 % of its height.)
   */
  const world = buildCityWorld([plan(0, 5), plan(1, 3)], { seats: 6 });
  const H = world.city!.street * 16;
  const tokyo = (phase: "noon" | "night") => computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase }, "Asia/Tokyo");

  /**
   * The sky backdrop (render/city.ts) at `zoom`, the camera centred on what Fit frames, the whole sky in
   * view — up to the Skytree's tip, which rises past the world's top (it stands up to 1.5× the tallest
   * roof) — with `layers` of landmarks over it: "none" = the open sky alone, "far" = + Fuji, "all" = +
   * Fuji and the towers (the real order). Returns the canvas and where each stands (in the world:
   * they scroll and zoom with the street).
   */
  async function scene(zoom: number, layers: "none" | "far" | "all" = "all") {
    const L = await import("./landmarks");
    const { paintCityBackdrop } = await import("./city");
    const layout = L.placeLandmarks(world, H, L.landmarksFor("Asia/Tokyo"));
    /** World px of the tallest tip past the world's top (0 when none rises past it). */
    const over = Math.max(0, ...layout.placed.map((p) => p.h - H));
    const W = Math.ceil(world.cols * 16 * zoom) + 40;
    const VH = Math.ceil((H + 80 + over) * zoom) + 40;
    const cam: Camera = { zoom, ox: Math.round(W / 2 - ((layout.span[0] + layout.span[1]) / 2) * zoom), oy: 40 + Math.ceil(over * zoom) };
    const view = { w: W, h: VH };
    const { ctx } = makeCanvas(W, VH);
    ctx.imageSmoothingEnabled = false;
    // The backdrop of a FOGGY noon (the day's sky, but no clouds: fog has its own bands, painted with
    // the grade, not here) in a city with NO zone. The backdrop paints a landmark city's landmarks
    // itself (city.ts → paintFarLandmarks / paintLandmarks), and in Tokyo the "sky behind the Tower"
    // was that Tower, faded by the fog. Without a zone it is the sky alone; the
    // landmarks go over it below, explicitly, in the clear noon. (The sky ignores the zone.)
    paintCityBackdrop(ctx, { ...tokyo("noon"), weather: "fog", zone: undefined }, world, cam, view, 0, null);
    if (layers !== "none") L.paintFarLandmarks(ctx, cam, world, view, tokyo("noon"), H);
    if (layers === "all") L.paintLandmarks(ctx, cam, world, view, tokyo("noon"), H, 0);
    const at = Object.fromEntries(layout.placed.map((p) => [p.spec.kind, { x: p.x, h: p.h }]));
    /** Screen px of world (wx, wy). */
    const sc = (wx: number, wy: number) => [Math.round(cam.ox) + Math.floor(wx * zoom), Math.round(cam.oy) + Math.floor(wy * zoom)] as const;
    return { ctx, at, sc, W, VH };
  }

  it("each one stands out from what is behind it — the pale Skytree and the orange Tower from the sky and from Fuji, Fuji's snow and blue flank from the sky — at 1 and at ½", async () => {
    const hq = world.city!.buildings.find((b) => b.hq)!;
    for (const zoom of [1, 0.5]) {
      const { ctx, at, sc } = await scene(zoom);
      // The HQ between the towers.
      expect([at["tokyo-tower"].x < hq.col * 16, at.skytree.x > (hq.col + hq.w) * 16]).toEqual([true, true]);
      const { ctx: far } = await scene(zoom, "far");
      const { ctx: sky } = await scene(zoom, "none");
      const rgb = (c: CanvasRenderingContext2D, [wx, wy]: readonly [number, number]) => px(c, ...sc(wx, wy)).slice(0, 3);
      /**
       * The open sky at world `p` — PROVEN open, not assumed: above the far skyline's tallest block
       * (3 tiles; in the real frame the blocks stand in front of a tower's foot), and the colour of
       * its whole row at the canvas's left edge (a sky band runs the full width; a landmark, the sun,
       * a cloud or a skyline block painted there would differ).
       */
      const openSky = (p: readonly [number, number], what: string) => {
        expect(p[1], `${zoom}: ${what} is above the far skyline`).toBeLessThan(H - 3 * 16);
        const s = rgb(sky, p);
        expect(s, `${zoom}: ${what} is open sky`).toEqual(px(sky, 0, sc(...p)[1]).slice(0, 3));
        return s;
      };
      /** What the backdrop has behind a tower at `p` (Fuji, painted before the towers) — proven to be Fuji, not the sky. */
      const fujiBehind = (p: readonly [number, number], s: number[], what: string) => {
        const f = rgb(far, p);
        expect(dist(f, s), `${zoom}: Fuji stands behind ${what}`).toBeGreaterThan(0);
        return f;
      };
      const on = (kind: string, f: number, dx: number) => [at[kind].x + dx, H - Math.round(f * at[kind].h)] as const;
      // Skytree: its pale body a fifth of the way up (above the far skyline) — against the pale sky low
      // over the horizon, and against Fuji's flank, which stands behind it there.
      const skAt = on("skytree", 0.2, -2);
      const body = rgb(ctx, skAt);
      const skyBehind = openSky(skAt, "the sky behind the Skytree");
      expect(dist(body, skyBehind), `${zoom}: Skytree body vs the sky`).toBeGreaterThanOrEqual(60);
      expect(dist(body, fujiBehind(skAt, skyBehind, "the Skytree")), `${zoom}: Skytree body vs Fuji`).toBeGreaterThanOrEqual(60);
      // Its Tembo Deck (0.532–0.572 of its height) has a dark glass band: the darkest pixel down its middle.
      const deck = [];
      for (let f = 0.532; f <= 0.572; f += 0.5 / at.skytree.h) deck.push(rgb(ctx, on("skytree", f, 0)));
      expect(Math.min(...deck.map((c) => c[0] + c[1] + c[2])), `${zoom}: Skytree deck glass`).toBeLessThan(330);
      // Tokyo Tower: international orange (red-dominant) where the sky behind it is blue-dominant —
      // its lower body, above the far skyline (0.25 was inside the skyline's 3-tile band, where a block
      // can stand in front of it in the real frame).
      const ttAt = on("tokyo-tower", 0.35, -2);
      const orange = rgb(ctx, ttAt);
      const behind = openSky(ttAt, "the sky behind the Tower");
      expect(orange[0], `${zoom}: Tower orange`).toBeGreaterThan(orange[2] + 80);
      expect(behind[2], `${zoom}: the sky behind it`).toBeGreaterThan(behind[0]);
      expect(dist(orange, behind), `${zoom}: Tower vs the sky`).toBeGreaterThanOrEqual(200);
      expect(dist(orange, fujiBehind(ttAt, behind, "the Tower")), `${zoom}: Tower vs Fuji`).toBeGreaterThanOrEqual(200);
      // Fuji: its snow just under the peak, and its blue flank. Each sample is Fuji's own pixel — the
      // towers, painted after it, left it exactly as the far layer painted it.
      const fuji = at.fuji;
      for (const [p, what, min] of [
        [[fuji.x - 3, H - fuji.h + 4], "Fuji's snow", 100],
        [[fuji.x - Math.round(fuji.h * 0.9), H - Math.round(fuji.h * 0.45)], "Fuji's flank", 60],
      ] as const) {
        const own = rgb(ctx, p);
        expect(own, `${zoom}: no tower in front of ${what}`).toEqual(rgb(far, p));
        expect(dist(own, openSky(p, `the sky behind ${what}`)), `${zoom}: ${what} vs the sky`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("paints nothing outside the landmarks: the sky far from them is exactly the backdrop's", async () => {
    const bare = await scene(1, "none");
    const { ctx, at, sc, W } = await scene(1);
    const a = bare.ctx.getImageData(0, 0, W, 30).data;
    const b = ctx.getImageData(0, 0, W, 30).data;
    // The top 30 screen rows are above every landmark's tip (the scene shows the Skytree's tip 40 px down).
    expect(sc(at.skytree.x, H - at.skytree.h)[1]).toBeGreaterThan(30);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("at night the Tower glows warm orange, the Skytree pale blue, and the red aviation light on the Tower's tip blinks", async () => {
    const L = await import("./landmarks");
    const { skylineMax } = await import("./skyline");
    const layout = L.placeLandmarks(world, H, L.landmarksFor("Asia/Tokyo"));
    const W = world.cols * 16 + 40;
    const VH = H + 120;
    const cam: Camera = { zoom: 1, ox: Math.round(W / 2 - (layout.span[0] + layout.span[1]) / 2), oy: 40 };
    const shot = (t: number) => {
      const { ctx } = makeCanvas(W, VH);
      ctx.fillStyle = "#0b1640"; // a night sky
      ctx.fillRect(0, 0, W, VH);
      L.paintLandmarkLights(ctx, cam, world, { w: W, h: VH }, tokyo("night"), H, t);
      return ctx;
    };
    const on = shot(0);
    const off = shot(L.BLINK_MS / 2);
    const where = (kind: string) => layout.placed.find((p) => p.spec.kind === kind)!;
    const tower = where("tokyo-tower");
    const skytree = where("skytree");
    const x = (p: { x: number }) => cam.ox + p.x;
    const glow = px(on, x(tower) - 2, cam.oy + H - Math.round(tower.h * 0.3)).slice(0, 3);
    expect(glow[0]).toBeGreaterThan(200);
    expect(glow[0]).toBeGreaterThan(glow[1] + 40);
    expect(glow[1]).toBeGreaterThan(glow[2] + 40);
    const iki = px(on, x(skytree) - 2, cam.oy + H - Math.round(skytree.h * 0.35)).slice(0, 3);
    expect(iki[2]).toBeGreaterThan(iki[0] + 60);
    expect(iki[2]).toBeGreaterThan(180);
    // The tip: red on, back to the night sky (or the dim antenna) half a blink later.
    const tip = [x(tower) - 1, cam.oy + H - tower.h - 1] as const;
    const red = px(on, ...tip).slice(0, 3);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[1]).toBeLessThan(90);
    expect(px(off, ...tip)[0]).toBeLessThan(120);
    // Nothing lit below the far skyline's haze (it and the street stand there): on the Tower's left
    // leg 10 px up (left of the arch between its legs), still the night sky's own colour — while
    // the same leg above the haze is lit.
    const leg = x(tower) - Math.round(tower.h * 0.1);
    expect(px(on, leg, cam.oy + H - 10).slice(0, 3)).toEqual([0x0b, 0x16, 0x40]);
    expect(px(on, x(tower) - 4, cam.oy + H - skylineMax(H) - 6)[0]).toBeGreaterThan(200);
  });
});

describe("the Tokyo temples in a real canvas", () => {
  // Self-contained: its own fixtures and dynamic imports, independent of the other blocks in this file.
  /** |ΔR| + |ΔG| + |ΔB| of two pixels. */
  const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const plan = (i: number, floors: number) => ({
    key: `p${i}`, label: `p${i}`, team: 2, hasIde: true,
    floors: Array.from({ length: floors }, (_, f) => ({ key: `floor:${i}:${f}`, label: `a${i}.${f}`, ide: true })),
  });
  /** The typical city: the capacity HQ in the middle, a one-floor project right of it, a two-floor one left of it —
   * the HQ stands between the towers: the Tower in the gap left of it (the shrine in front of its foot), Fuji and the
   * pagoda in the gap right of it, the Skytree over the one-floor project. */
  const world = buildCityWorld([plan(0, 1), plan(1, 2)], { seats: 6 });
  const H = world.city!.street * 16;
  const tokyo = (phase: "noon" | "night") => computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase }, "Asia/Tokyo");

  /** The camera at `zoom`, centred on what Fit frames; a canvas size that holds it all. */
  async function setup(zoom: number) {
    const L = await import("./landmarks");
    const layout = L.placeLandmarks(world, H, L.landmarksFor("Asia/Tokyo"));
    const W = Math.ceil(world.cols * 16 * zoom) + 80;
    const VH = Math.ceil((H + 80) * zoom) + 40;
    const cam: Camera = { zoom, ox: Math.round(W / 2 - ((layout.span[0] + layout.span[1]) / 2) * zoom), oy: 40 };
    const at = (kind: string) => layout.placed.find((p) => p.spec.kind === kind)!;
    /** Screen px of world (wx, wy). */
    const sc = (wx: number, wy: number) => [Math.round(cam.ox) + Math.floor(wx * zoom), Math.round(cam.oy) + Math.floor(wy * zoom)] as const;
    return { L, layout, W, VH, cam, view: { w: W, h: VH }, at, sc };
  }
  /** A canvas's RGB at screen (x, y), from its whole-image data. */
  const rgb = (d: Uint8ClampedArray, W: number, x: number, y: number) => {
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };

  /**
   * The city's sky backdrop alone — a FOGGY noon (the day's sky and far skyline, no clouds) in a city with
   * NO zone, so render/city.ts paints none of the landmarks itself — and the same backdrop with the
   * temples painted over it, as the city paints them (after the skyline's blocks), in Tokyo's clear noon.
   */
  async function day(zoom: number) {
    const s = await setup(zoom);
    const { paintCityBackdrop } = await import("./city");
    const paint = (temples: boolean) => {
      const { ctx } = makeCanvas(s.W, s.VH);
      ctx.imageSmoothingEnabled = false;
      paintCityBackdrop(ctx, { ...tokyo("noon"), weather: "fog", zone: undefined }, world, s.cam, s.view, 0, null);
      if (temples) s.L.paintNearLandmarks(ctx, s.cam, world, s.view, tokyo("noon"), H, 0);
      return ctx.getImageData(0, 0, s.W, s.VH).data;
    };
    return { ...s, bare: paint(false), withTemples: paint(true) };
  }

  it("each temple stands out from what is behind it: dark roofs and vermilion walls against the open sky and against the far skyline's haze — at 1 and at ½", async () => {
    const { CITY } = await import("./city");
    // The far skyline's colours by day (its blocks, their top edges and panes) — used only to tell
    // which pixels of the bare backdrop are that haze.
    const HAZE = [CITY.skyline, CITY.skylineEdge, CITY.skylinePane].map(rgbOf);
    const isHaze = (c: number[]) => HAZE.some((h) => dist(h, c) === 0);
    for (const zoom of [1, 0.5]) {
      const { bare, withTemples, at, sc, W } = await day(zoom);
      for (const kind of ["pagoda", "shrine"]) {
        const p = at(kind);
        const [x0, y0] = sc(p.x - p.h, H - p.h);
        const [x1, y1] = sc(p.x + p.h, H);
        const changed: { t: number[]; b: number[]; y: number }[] = [];
        for (let y = y0; y < y1; y++)
          for (let x = Math.max(0, x0); x < x1; x++) {
            const t = rgb(withTemples, W, x, y);
            const b = rgb(bare, W, x, y);
            if (dist(t, b) > 0) changed.push({ t, b, y });
          }
        const where = `${zoom}: ${kind}`;
        expect(changed.length, `${where}: painted`).toBeGreaterThan(p.h * p.h * zoom * zoom * 0.1);
        const dark = changed.filter((c) => lum(c.t) < 85);
        const red = changed.filter((c) => c.t[0] > c.t[1] + 70 && c.t[0] > c.t[2] + 70);
        // The roofs are dark grey to black and they are most of a temple (the reference look: tiers of
        // dark curved roofs; a wide dark roof over the hall).
        expect(dark.length / changed.length, `${where}: dark roofs`).toBeGreaterThanOrEqual(0.35);
        expect(red.length, `${where}: vermilion`).toBeGreaterThan(p.h * zoom * zoom * 0.5);
        // Behind them both: the open sky (blue) and the far skyline's haze — and each of their dark
        // and vermilion pixels is far from whichever it covers.
        const skyline = sc(0, H - 3 * 16)[1];
        expect(dark.some((c) => isHaze(c.b)), `${where}: a roof over the haze`).toBe(true);
        if (kind === "pagoda") expect(dark.some((c) => c.y < skyline && !isHaze(c.b) && c.b[2] > c.b[0]), `${where}: a roof against the sky`).toBe(true);
        for (const c of [...dark, ...red]) expect(dist(c.t, c.b), `${where}: ${c.t} over ${c.b}`).toBeGreaterThanOrEqual(110);
      }
    }
  });

  it("paints nothing outside the temples: away from them the backdrop is exactly as it was", async () => {
    const { bare, withTemples, at, sc, W, VH } = await day(1);
    const boxes = ["pagoda", "shrine"].map((kind) => {
      const p = at(kind);
      const hw = Math.ceil(p.h * 0.65);
      return [sc(p.x - hw, 0)[0], sc(0, H - p.h)[1], sc(p.x + hw, 0)[0], sc(0, H)[1]];
    });
    let outside = 0;
    for (let y = 0; y < VH; y++)
      for (let x = 0; x < W; x++) {
        if (boxes.some(([a, b, c, d]) => x >= a && x < c && y >= b && y < d)) continue;
        outside++;
        if (dist(rgb(withTemples, W, x, y), rgb(bare, W, x, y)) !== 0) throw new Error(`painted outside the temples at (${x}, ${y})`);
      }
    expect(outside).toBeGreaterThan(W * VH * 0.9);
  });

  /**
   * A night: a navy sky with the towers and the temples painted in day colours and a dark veil over
   * all of it (standing in for the grade), then — what the test is about — the landmarks' lights.
   * Returns the canvas before and after the lights.
   */
  async function night() {
    const s = await setup(1);
    const { ctx } = makeCanvas(s.W, s.VH);
    ctx.fillStyle = "#0b1640";
    ctx.fillRect(0, 0, s.W, s.VH);
    s.L.paintLandmarks(ctx, s.cam, world, s.view, tokyo("noon"), H, 0);
    s.L.paintNearLandmarks(ctx, s.cam, world, s.view, tokyo("noon"), H, 0);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = "#050818";
    ctx.fillRect(0, 0, s.W, s.VH);
    ctx.globalAlpha = 1;
    const before = ctx.getImageData(0, 0, s.W, s.VH).data;
    s.L.paintLandmarkLights(ctx, s.cam, world, s.view, tokyo("night"), H, 0);
    const after = ctx.getImageData(0, 0, s.W, s.VH).data;
    return { ...s, before, after };
  }

  it("at night the pagoda's storeys glow warm and the shrine's lanterns burn — but nothing lights the street's lamps and trees standing in front of them", async () => {
    const { artBox } = await import("../engine/streetTheme");
    const { before, after, at, sc, W, cam } = await night();
    const lit = (x: number, y: number) => dist(rgb(after, W, x, y), rgb(before, W, x, y)) > 0;
    for (const kind of ["pagoda", "shrine"]) {
      const p = at(kind);
      const warm: number[][] = [];
      // Across the temple's own width: the Skytree's pale blue stands just beyond the pagoda's eaves.
      for (let y = sc(0, H - p.h)[1]; y < sc(0, H)[1]; y++)
        for (let x = sc(p.x - p.hw, 0)[0]; x < sc(p.x + p.hw, 0)[0]; x++) if (lit(x, y)) warm.push(rgb(after, W, x, y));
      expect(warm.length, kind).toBeGreaterThan(20);
      for (const c of warm) expect(c[0] >= c[1] && c[1] > c[2] && c[0] > c[2] + 15, `${kind}: ${c} is warm`).toBe(true);
      if (kind === "shrine") expect(warm.filter(([r, g, b]) => r > 220 && g > 170 && b < 170).length, "lantern fires").toBeGreaterThanOrEqual(4);
    }
    // The street's props across the temples (the tree in the pagoda's gap, the lamp and the tree in the
    // shrine's) — what stands above the horizon; the Seats lounge's benches under the street are below
    // it: not one of their pixels changed.
    const temples = ["pagoda", "shrine"].map(at);
    const front = world.props.filter((p) => temples.some((t) => p.col * 16 < t.x + t.hw && (p.col + p.w) * 16 > t.x - t.hw) && artBox(p).row * 16 < H);
    expect(front.map((p) => p.kind).sort()).toEqual(["lamp", "tree", "tree"]);
    for (const p of front) {
      const b = artBox(p);
      for (let y = cam.oy + b.row * 16; y < cam.oy + (b.row + b.h) * 16; y++)
        for (let x = cam.ox + b.col * 16; x < cam.ox + (b.col + b.w) * 16; x++)
          if (lit(x, y)) throw new Error(`a light on the ${p.kind} at (${x}, ${y})`);
    }
  });
});

describe("no building ever covers a crown — the reference city at Fit and zoomed in, in a real canvas", () => {
  // Self-contained: its own fixtures and dynamic imports, independent of the other blocks in this file.
  const ag = (key: string, folder: string, parentKey: string | null = null) => ({
    key, parentKey, origin: "ide" as const, title: key, folder, activity: "typing" as const, tool: "Edit", ideAgentId: key, lastActivityAt: 0,
  });
  /**
   * The reference city: `gazelle` — 7 floors, each a leader and 25 sub-agents, two
   * desk rows a floor: 57 rows, 912 px tall — left of the centred HQ, and `chat-server`, one floor, right.
   * The Skytree used to slide behind gazelle as soon as the view zoomed in on it.
   */
  const agents = [
    ...Array.from({ length: 7 }, (_, f) => [ag(`g${f}`, "gazelle"), ...Array.from({ length: 25 }, (_, s) => ag(`g${f}s${s}`, "gazelle", `g${f}`))]).flat(),
    ag("t0", "chat-server"),
  ];
  const roster = planCity(agents);
  const world = buildCityWorld(roster.plans, { seats: 64 });
  const noon = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "noon" }, "Asia/Tokyo");
  const W = 1280;
  const VH = 800;

  /**
   * The City as the panel shows it — Fit, or zoomed notch by notch on `on`'s right wall near its roof
   * until it reaches `on.zoom` — and, with the same camera, the backdrop alone (sky, landmarks, far skyline, street: no
   * building, prop, agent or label) in Tokyo and with no zone (no landmarks). Where the two backdrops
   * differ inside a crown's box is that crown, as seen; the full frame must show exactly those pixels.
   */
  async function shots(on?: { key: string; zoom: number }) {
    const bank = await loadSprites();
    const v = new VillageView(1, () => null, "city");
    v.setWorld(world);
    v.setAgents(roster.agents);
    v.setAmbience(noon);
    v.setBank(bank);
    v.resize(W, VH, 1);
    v.setInset(117);
    const fit = v.camera.zoom;
    if (on) {
      const b = world.city!.buildings.find((x) => x.key === on.key)!;
      const at = { x: v.camera.ox + (b.col + b.w) * 16 * v.camera.zoom, y: v.camera.oy + (b.row + 2) * 16 * v.camera.zoom };
      for (let i = 0; i < 12 && v.camera.zoom < on.zoom; i++) v.zoomBy(1, at);
    }
    const full = makeCanvas(W, VH).ctx;
    v.frame(0, full);
    const backdrop = (zone: string | undefined) => {
      const { ctx } = makeCanvas(W, VH);
      renderFrame(ctx, [], v.camera, bank, { w: W, h: VH, timeMs: 0, ambience: { ...noon, zone }, particles: [], world, pixelRatio: 1 });
      return ctx.getImageData(0, 0, W, VH).data;
    };
    return { v, fit, full: full.getImageData(0, 0, W, VH).data, sky: backdrop("Asia/Tokyo"), bare: backdrop(undefined) };
  }
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) => a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2];

  it("at Fit and zoomed 2–3× on gazelle and on the HQ, every crown pixel on screen shows", async () => {
    let zoomedIn = 0;
    // Fit is below 1 here (7/16 since the towers grew); zoomed in to 2, and to 3.
    for (const on of [undefined, { key: "gazelle", zoom: 2 }, { key: "gazelle", zoom: 3 }, { key: "cap/hq", zoom: 2 }, { key: "cap/hq", zoom: 3 }]) {
      const { v, fit, full, sky, bare } = await shots(on);
      const where = on ? `zoom ${v.camera.zoom} on ${on.key}` : `Fit (${fit})`;
      if (on) {
        expect(v.camera.zoom, where).toBeGreaterThanOrEqual(2);
        expect(v.camera.zoom, where).toBeLessThanOrEqual(3);
      }
      const boxes = v.landmarkBoxes();
      // At Fit all three are on screen, whole.
      if (!on) expect(boxes.map((b) => b.kind), where).toEqual(["fuji", "skytree", "tokyo-tower"]);
      for (const b of boxes) {
        let crown = 0;
        for (let y = b.y; y < b.y + b.h; y++)
          for (let x = b.x; x < b.x + b.w; x++) {
            const i = (y * W + x) * 4;
            if (same(sky, bare, i)) continue; // no landmark pixel here (open sky beside a tower, a cloud over Fuji)
            crown++;
            if (!same(full, sky, i)) throw new Error(`${where}: the ${b.kind}'s crown is covered at (${x}, ${y})`);
          }
        if (!on) expect(crown, `${where}: ${b.kind}`).toBeGreaterThan(100);
        else if (crown > 100) zoomedIn++;
      }
    }
    // Zoomed in, crowns still stand on screen beside the buildings.
    expect(zoomedIn).toBeGreaterThanOrEqual(2);
  });

  it("a landmark zooms exactly with the street: its crown lands where the street's camera maps it, at Fit and zoomed in", async () => {
    const L = await import("./landmarks");
    const H = world.city!.street * 16;
    const tower = L.placeLandmarks(world, H, L.landmarksFor("Asia/Tokyo")).placed.find((p) => p.spec.kind === "tokyo-tower")!;
    const c = L.landmarkCrown(tower);
    const zooms = new Set<number>();
    for (const on of [undefined, { key: "cap/hq", zoom: 2 }, { key: "cap/hq", zoom: 3 }]) {
      const { v } = await shots(on);
      const cam = v.camera;
      zooms.add(cam.zoom);
      // The towers alone on a clear canvas, through the very camera the panel draws the street with.
      const { ctx } = makeCanvas(W, VH);
      L.paintLandmarks(ctx, cam, world, { w: W, h: VH }, noon, H, 0);
      // The deck's last screen row as the street's camera maps it: its bottom edge less a px (below zoom 1 the
      // screen row of its last world row may be the body's, where that row rounds into the next one).
      const row = Math.round(cam.oy) + Math.floor(c.bottom * cam.zoom) - 1;
      const left = Math.round(cam.ox) + Math.floor(c.x0 * cam.zoom);
      const right = Math.round(cam.ox) + Math.floor(c.x1 * cam.zoom);
      expect(left, `zoom ${cam.zoom}`).toBeGreaterThan(20);
      expect(right, `zoom ${cam.zoom}`).toBeLessThan(W - 20);
      // Its lowest deck row: painted from exactly the street's x for the crown's left edge to its right edge
      // (below zoom 1 the last world px may round up to a whole screen px of its own).
      const d = ctx.getImageData(left - 20, row, right - left + 40, 1).data;
      const opaque = Array.from({ length: right - left + 40 }, (_, k) => d[k * 4 + 3] > 0);
      expect(opaque.indexOf(true) + left - 20, `zoom ${cam.zoom}: left`).toBe(left);
      expect(opaque.lastIndexOf(true) + left - 20, `zoom ${cam.zoom}: right`).toBe(Math.max(right - 1, Math.round(cam.ox) + Math.floor((c.x1 - 1) * cam.zoom)));
    }
    expect(zooms.size).toBe(3);
  });
});
