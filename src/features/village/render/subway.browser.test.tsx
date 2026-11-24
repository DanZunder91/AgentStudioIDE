/**
 * Layer 5 — the City's subway against a REAL 2D context in Chromium (render/subway.ts): the tunnel runs
 * on past the world's ends, the train stands in the station with nothing of the world over it (it is
 * underground: the ground layer and the scene leave its rows open), the station's plate reads over a
 * standing train's roof, the stairwell goes down beside the lounge, the entrance stands on the far
 * sidewalk — and at night the train's windows shine over the grade. Plus the frame cost, measured for
 * the reference city at Fit and zoomed, by day and at night.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/subway.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, computeAmbience, planCity } from "../engine";
import { BRAKE_MS, CRUISE_MS, DOOR_MS, DOOR_WAIT_MS, stationStop, TRAIN_LEN } from "../engine/subway";
import { TILE, type Ambience, type VillageAgent } from "../villageTypes";
import { VillageView } from "../villageView";
import type { Camera } from "./camera";
import { loadSprites, renderFrame } from "./index";
import { CAR_WINDOWS, LAMP_PITCH, METRO, METRO_RISE, paintSubway, paintSubwayLights, RING, STAIRS, STATION, TRAIN, TUNNEL } from "./subway";

afterEach(() => {
  document.body.innerHTML = "";
});

const agentOf = (key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
  key,
  parentKey: null,
  origin: "ide",
  title: key,
  folder,
  activity: "typing",
  tool: null,
  ideAgentId: key,
  lastActivityAt: null,
  ...extra,
});
/** The reference city: a seven-floor gazelle (26 sub-agents on its ground floor), the HQ, a small Agent Studio. */
const agents: VillageAgent[] = [
  ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle")),
  ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0" })),
  agentOf("a0", "Agent Studio"),
];
const roster = planCity(agents);
const world = buildCityWorld(roster.plans, { seats: 64 });
const sub = world.city!.subway!;
const RAIL = (sub.rail + 1) * TILE;
const TOP = sub.top * TILE;
const STOP = stationStop(sub);
/** The train standing at the station, doors wide open (eastbound); and a moment between runs. */
const DWELL = CRUISE_MS + BRAKE_MS + DOOR_WAIT_MS + DOOR_MS + 500;
const NONE = 60_000;
const day = computeAmbience(new Date(2026, 9, 26, 12, 0), null, { weather: "clear", phase: "auto" }, "Asia/Tokyo");
const night = computeAmbience(new Date(2026, 9, 26, 23, 0), null, { weather: "clear", phase: "auto" }, "Asia/Tokyo");
const rain = computeAmbience(new Date(2026, 9, 26, 16, 0), null, { weather: "rain", phase: "auto" }, "Asia/Tokyo");

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** A City view of the reference city at `w × h` CSS px and `dpr`, its real sprites, and its canvas. */
async function cityView(w: number, h: number, dpr: number, amb: Ambience | null) {
  const view = new VillageView(1, () => null, "city");
  view.setWorld(world);
  view.setAgents(roster.agents);
  view.setCapacity({ machine: null, machineError: null, agents: roster.agents.slice(0, 5), includesOutside: true, usage: null, usageError: null, context: {}, nowMs: 0, lounge: true });
  view.setBank(await loadSprites());
  if (amb) view.setAmbience(amb);
  const size = view.resize(w, h, dpr);
  const c = document.createElement("canvas");
  c.width = size.w;
  c.height = size.h;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  return { view, ctx, size };
}

/** Zoom the view (at a pixel ratio of 1) in `steps` around the station's middle and pan it to the view's centre. */
function onStation(view: VillageView, steps: number): void {
  for (let i = 0; i < steps; i++) {
    const c = view.camera;
    view.zoomBy(1, { x: c.ox + STOP * c.zoom, y: c.oy + (TOP + 2 * TILE) * c.zoom });
  }
  const c = view.camera;
  view.pan(view.view.w / 2 - (c.ox + STOP * c.zoom), view.view.h / 2 - (c.oy + (TOP + 2 * TILE) * c.zoom));
}

/** RGB at a WORLD point through the view's camera. */
function rgbAt(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number): number[] {
  const x = Math.round(cam.ox) + Math.floor(wx * cam.zoom);
  const y = Math.round(cam.oy) + Math.floor(wy * cam.zoom);
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}

describe("the subway, painted in the whole City frame", () => {
  it("the train stands in the station with nothing of the world over it — its window, the plate over its roof, the stairwell beside the lounge, the entrance on the sidewalk", async () => {
    // No sky: every colour is the art's own (nothing grades it).
    const { view, ctx } = await cityView(1280, 800, 1, null);
    onStation(view, 3);
    view.frame(DWELL, ctx);
    const cam = view.camera;
    expect(cam.zoom).toBe(2);
    // Car 0's first window, its top-left (a rider's head stays lower): the lit inside — so neither the
    // ground layer nor any item of the scene covers the tunnel's rows.
    const c0 = STOP - TRAIN_LEN / 2;
    expect(rgbAt(ctx, cam, c0 + CAR_WINDOWS[0] + 1, RAIL - 30)).toEqual(hex(TRAIN.window));
    // Its body between the doors (under the stripe, over the skirt), and its wheel on the rail.
    expect(rgbAt(ctx, cam, c0 + 30, RAIL - 12)).toEqual(hex(TRAIN.body));
    expect(rgbAt(ctx, cam, c0 + 8, RAIL - 4)).toEqual(hex(TRAIN.wheel));
    // The station's plate, white over the roof of the train standing under it.
    const plateX = Math.round((sub.entrance.col * TILE + 2 * TILE + sub.station.col1 * TILE) / 2) - 13;
    expect(rgbAt(ctx, cam, plateX + 1, TOP + 4 + 5 + 1)).toEqual(hex(STATION.plate));
    // The stairwell's lit back wall, beside the lounge (the left edge of its back, clear of every step).
    expect(rgbAt(ctx, cam, sub.entrance.col * TILE + 2, TOP - 40)).toEqual(hex(STAIRS.back));
    // The tunnel's wall just past the station's east end, midway between two lamps' pools and between
    // two ring joints — looked at there, since the eight-car train's platform runs past this view's edge.
    const wallX = Math.ceil((sub.station.col1 * TILE) / LAMP_PITCH) * LAMP_PITCH + RING / 2;
    view.pan(view.view.w / 2 - (view.camera.ox + wallX * view.camera.zoom), 0);
    view.frame(DWELL, ctx);
    expect(rgbAt(ctx, view.camera, wallX, RAIL - 30)).toEqual(hex(TUNNEL.wall));
  });

  it("the entrance stands on the far sidewalk: its sign over it, its mouth in the sidewalk, the stairwell going down under it", async () => {
    // The scene without anyone on the street (the passers-by are random): the world and its props.
    const cam: Camera = { zoom: 3, ox: -Math.round((sub.entrance.col - 4) * TILE * 3), oy: -Math.round((sub.entrance.row - 4) * TILE * 3) };
    const size = { w: 640, h: 400 };
    const c = document.createElement("canvas");
    c.width = size.w;
    c.height = size.h;
    document.body.appendChild(c);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    renderFrame(ctx, buildDrawList(world, [], () => false, 0), cam, await loadSprites(), { ...size, timeMs: NONE, world });
    const x0 = sub.entrance.col * TILE;
    const bottom = (sub.entrance.row + 1) * TILE;
    // The sign's teal (its left column, clear of the "M"), the mouth's dark.
    expect(rgbAt(ctx, cam, x0 + 23, bottom - METRO_RISE + 4)).toEqual(hex(METRO.sign));
    expect(rgbAt(ctx, cam, x0 + 3, bottom - 2)).toEqual(hex(METRO.mouth));
    // Right under the sidewalk, the stairwell's lit back wall, where the turf would be.
    expect(rgbAt(ctx, cam, x0 + 2, bottom + 1)).toEqual(hex(STAIRS.back));
    expect(rgbAt(ctx, cam, x0 - 20, bottom + 1)).not.toEqual(hex(STAIRS.back));
  });

  it("runs the tunnel on past the world's ends, world-locked: a pan moves it exactly with the street", async () => {
    const { view, ctx, size } = await cityView(1280, 800, 1, null);
    onStation(view, 2);
    // Pan so the world's left end is in the middle of the view.
    const c = view.camera;
    view.pan(size.w / 2 - c.ox, 0);
    view.frame(NONE, ctx);
    const a = view.camera;
    // Past the world's left end: the tunnel's wall and rail, as inside it.
    // (−240: between the lamps at −192 and −320 and their pools, between two ring joints.)
    expect(rgbAt(ctx, a, -240, RAIL - 30)).toEqual(hex(TUNNEL.wall));
    expect(rgbAt(ctx, a, -240, RAIL)).toEqual(hex(TUNNEL.railShine));
    expect(rgbAt(ctx, a, -240, RAIL + 1)).toEqual(hex(TUNNEL.rail));
    // Pan 37 px: the same world strip has the same pixels.
    const strip = (cam: Camera) => {
      const out: number[] = [];
      for (let wx = -300; wx < 300; wx += 3) for (const wy of [TOP + 2, TOP + 12, RAIL - 30, RAIL - 6, RAIL + 3]) out.push(...rgbAt(ctx, cam, wx, wy));
      return out;
    };
    const before = strip(a);
    view.pan(37, 0);
    view.frame(NONE, ctx);
    expect(strip(view.camera)).toEqual(before);
  });

  it("at night the train's windows shine over the grade while its body is darkened; the tunnel's wall is graded too", async () => {
    const { view, ctx } = await cityView(1280, 800, 1, night);
    onStation(view, 3);
    view.frame(DWELL, ctx);
    const cam = view.camera;
    const c0 = STOP - TRAIN_LEN / 2;
    expect(rgbAt(ctx, cam, c0 + CAR_WINDOWS[0] + 1, RAIL - 30)).toEqual(hex(TRAIN.window));
    const body = rgbAt(ctx, cam, c0 + 30, RAIL - 12);
    const lum = (p: number[]) => p[0] + p[1] + p[2];
    expect(lum(body)).toBeLessThan(lum(hex(TRAIN.body)) - 60);
    expect(lum(rgbAt(ctx, cam, sub.station.col1 * TILE + 100, RAIL - 30))).toBeLessThan(lum(hex(TUNNEL.wall)));
  });
});

describe("the subway's frame cost (the reference city)", () => {
  it("is bounded at Fit and zoomed, by day and at night", async () => {
    const results: string[] = [];
    const time = (label: string, ctx: CanvasRenderingContext2D, cam: Camera, size: { w: number; h: number }, t: number, amb: Ambience) => {
      const runs: number[] = [];
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 40; i++) {
          paintSubway(ctx, cam, world, size, t + i * 16);
          if (amb.lightsOn) paintSubwayLights(ctx, cam, world, size, t + i * 16);
        }
        runs.push((performance.now() - t0) / 40);
      }
      runs.sort((a, b) => a - b);
      const ms = runs[3];
      results.push(`${label}: ${ms.toFixed(3)} ms`);
      return ms;
    };
    for (const [name, amb] of [
      ["day", day],
      ["night", night],
    ] as const) {
      for (const [w, h, dpr] of [
        [1280, 800, 2],
        [1280, 800, 1],
      ] as const) {
        const { view, ctx, size } = await cityView(w, h, dpr, amb);
        expect(time(`${name} Fit ${w}x${h}@${dpr} (zoom ${view.camera.zoom})`, ctx, view.camera, size, DWELL, amb)).toBeLessThan(3);
      }
      for (const steps of [2, 3, 4]) {
        const { view, ctx, size } = await cityView(1280, 800, 1, amb);
        onStation(view, steps);
        expect(time(`${name} zoom ${view.camera.zoom} on the station`, ctx, view.camera, size, DWELL, amb)).toBeLessThan(3);
      }
    }
    // The rain changes nothing underground (the drops end at the far sidewalk).
    const { view, ctx, size } = await cityView(1280, 800, 2, rain);
    expect(time(`rain Fit 1280x800@2 (zoom ${view.camera.zoom})`, ctx, view.camera, size, CRUISE_MS + 2000, rain)).toBeLessThan(3);
    console.log(`[subway frame cost]\n${results.join("\n")}`);
  });
});

