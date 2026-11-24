/**
 * The backdrop styles wired into the City's sky (render/city.ts, render/backdrop.ts) — with each module's
 * layer replaced by a recording stand-in, so what is proved here is the WIRING, not the art:
 *
 *   - each style paints its own layers and no other, at their depths — a HIGH layer after the clouds
 *     and before the towers and the haze, a MID layer after the haze and before the temples;
 *   - at night they light up in the same order (HIGH, the landmarks' lights, the haze's windows, MID),
 *     and each light is cut by what stands in front of its layer: the haze and any MID face for a HIGH
 *     layer, the temples, the street's trees and lamps, and this frame's street sprites;
 *   - no star, moon or haze window shows through a layer's face;
 *   - the frame hands the night pass the boxes of the agents, passers-by and vehicles it drew.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { citySky } from "../engine/ambience";
import { dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type CharacterView, type DrawItem, type VehicleView } from "../villageTypes";
import { airSpans, inAir, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { CITY, forEachSkylineBlock, paintCityBackdrop, paintCityNight, skylineFaceAt } from "./city";
import { renderFrame } from "./frame";
import { ART_H, vehicleBox } from "./vehicles";
import { landmarkMask, landmarksFor, placeLandmarks } from "./landmarks";
import { recorder, type RecordingTarget } from "./testRecorder";

const h = vi.hoisted(() => {
  const log: { what: string; at: number }[] = [];
  const faces: Record<string, ((s: { horizon: number }, x: number) => number) | null> = {};
  const lights: Record<string, { scene: unknown }[]> = {};
  const scenes: Record<string, unknown[]> = {};
  const layer = (name: string) => ({
    paint: (s: { ctx: { calls: unknown[] } }) => {
      log.push({ what: `${name}:paint`, at: s.ctx.calls.length });
      (scenes[name] ??= []).push(s);
    },
    paintLights: (s: { ctx: { calls: unknown[] } }) => {
      log.push({ what: `${name}:lights`, at: s.ctx.calls.length });
      (lights[name] ??= []).push({ scene: s });
    },
    faceAt: (s: { horizon: number }, x: number) => faces[name]?.(s, x) ?? s.horizon,
  });
  return { log, faces, lights, scenes, layer };
});

vi.mock("./backdropTowers", () => ({ TOWERS: h.layer("towers") }));
vi.mock("./backdropShops", () => ({ SHOPS: h.layer("shops") }));
vi.mock("./backdropCanyon", () => ({ CANYON: h.layer("canyon") }));
vi.mock("./backdropApartments", () => ({ APARTMENTS: h.layer("apartments") }));
vi.mock("./landmarks", async (orig) => {
  const real = await orig<typeof import("./landmarks")>();
  const logged =
    <A extends unknown[]>(what: string, fn: (...a: A) => void) =>
    (...a: A) => {
      h.log.push({ what, at: (a[0] as { calls: unknown[] }).calls.length });
      fn(...a);
    };
  return {
    ...real,
    paintLandmarks: logged("landmarks:tower", real.paintLandmarks),
    paintNearLandmarks: logged("landmarks:near", real.paintNearLandmarks),
    paintLandmarkLights: logged("landmarks:lights", real.paintLandmarkLights),
  };
});

beforeEach(() => {
  h.log.length = 0;
  for (const k of Object.keys(h.faces)) delete h.faces[k];
  for (const k of Object.keys(h.lights)) delete h.lights[k];
  for (const k of Object.keys(h.scenes)) delete h.scenes[k];
});

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/** A Tokyo city with a temple or two in its gaps: three projects round the HQ. */
const world = dressWorld(
  buildCityWorld(
    [
      { key: "a", label: "a", team: 6, hasIde: true, floors: floorsOf("a", 3) },
      { key: "b", label: "b", team: 4, hasIde: true, floors: floorsOf("b", 2) },
      { key: "c", label: "c", team: 2, hasIde: true, floors: floorsOf("c", 1) },
    ],
    { seats: 64 },
  ),
  "Asia/Tokyo",
);
const horizon = world.city!.street * TILE;
const cam = { zoom: 1, ox: 0, oy: 0 };
const view = { w: world.cols * TILE, h: world.rows * TILE };
const at = (hour: number, weather: "clear" | "rain" = "clear"): Ambience =>
  computeAmbience(new Date(2026, 9, 27, hour, 0), null, { weather, phase: "auto" }, "Asia/Tokyo");
const noon = at(12);
const night = at(22);
/** The same sky in a city with no street theme: the haze alone, and no landmarks either. */
const utc = (hour: number): Ambience => computeAmbience(new Date(2026, 9, 27, hour, 0), null, { weather: "clear", phase: "auto" }, "UTC");

const when = (what: string) => h.log.find((e) => e.what === what)?.at ?? NaN;
const firstFill = (ctx: RecordingTarget, color: string) => ctx.calls.findIndex((c) => c.op === "fillRect" && c.fillStyle === color);
const lastFill = (ctx: RecordingTarget, color: string) => ctx.calls.map((c) => c.op === "fillRect" && c.fillStyle === color).lastIndexOf(true);
const count = (ctx: RecordingTarget, color: string) => ctx.of("fillRect").filter((c) => c.fillStyle === color).length;
const lightScene = (name: string) => h.lights[name][0].scene as BackdropLightScene;

/** A pixel of a temple standing in the street (one the near-landmark mask covers). */
function templePixel(): { x: number; y: number } {
  const hit = landmarkMask(cam, world, view, night, horizon, ["near"])!;
  for (const p of placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).placed.filter((q) => q.spec.layer === "near"))
    for (let y = horizon - p.h; y < horizon; y++) for (let x = p.x - p.hw; x <= p.x + p.hw; x++) if (hit(x, y)) return { x, y };
  throw new Error("no temple in this city");
}

/** A block of the haze, and a world pixel on its face. */
function hazePixel(): { x: number; y: number } {
  let found: { x: number; y: number } | null = null;
  forEachSkylineBlock(0, view.w, horizon, (x, w, bh) => {
    found ??= bh > 10 && w > 4 && !inAir(x, x + w) ? { x: x + 1, y: horizon - 2 } : null;
  });
  return found!;
}

describe("the day pass", () => {
  it("paints Tokyo's layers — the towers, the apartments, the canyon, the shops — and none in any other city, or with no sky", () => {
    paintCityBackdrop(recorder(), noon, world, cam, view, 0);
    expect(h.log.filter((e) => !e.what.startsWith("landmarks")).map((e) => e.what)).toEqual(["towers:paint", "apartments:paint", "canyon:paint", "shops:paint"]);
    h.log.length = 0;
    paintCityBackdrop(recorder(), utc(12), world, cam, view, 0);
    paintCityBackdrop(recorder(), undefined, world, cam, view, 0);
    expect(h.log.filter((e) => !e.what.startsWith("landmarks"))).toEqual([]);
  });

  it("stands HIGH behind the towers and the haze, in front of the clouds; MID in front of the haze, behind the temples", () => {
    const ctx = recorder();
    paintCityBackdrop(ctx, noon, world, cam, view, 0);
    const clouds = lastFill(ctx, CITY.cloud.light);
    const haze = firstFill(ctx, CITY.skyline);
    expect(clouds).toBeGreaterThan(0);
    expect(when("towers:paint")).toBeGreaterThan(clouds);
    expect(when("towers:paint")).toBeLessThanOrEqual(when("landmarks:tower"));
    expect(when("landmarks:tower")).toBeLessThanOrEqual(haze);
    expect(haze).toBeLessThan(when("apartments:paint"));
    expect(when("apartments:paint")).toBeLessThanOrEqual(when("canyon:paint"));
    expect(when("canyon:paint")).toBeLessThanOrEqual(when("shops:paint"));
    expect(when("shops:paint")).toBeLessThanOrEqual(when("landmarks:near"));
  });

  it("hands a layer the frame: its context, camera, world, sky, horizon, clock and the view's world span", () => {
    const ctx = recorder();
    const panned = { zoom: 2, ox: -300, oy: 0 };
    paintCityBackdrop(ctx, noon, world, panned, view, 1234);
    const s = h.scenes.canyon[0] as BackdropScene;
    expect(s).toMatchObject({ ctx, cam: panned, world, view, amb: noon, horizon, timeMs: 1234 });
    expect([s.x0, s.x1]).toEqual([150, 150 + view.w / 2]);
  });
});

describe("the night pass", () => {
  const street: [number, number, number, number][] = [
    [-180, horizon - 30, 10, 32], // a passer-by on the far sidewalk past the city's end, its head above the street
    [80, horizon + 4, 10, 10], // a car wholly on the road: never in front of the backdrop
  ];

  it("lights the layers back to front: HIGH, the landmarks' lights, the haze's windows, MID", () => {
    const ctx = recorder();
    paintCityNight(ctx, night, world, cam, view, 0, street);
    const windows = firstFill(ctx, CITY.window);
    expect(windows).toBeGreaterThan(0);
    expect(when("towers:lights")).toBeLessThanOrEqual(when("landmarks:lights"));
    expect(when("landmarks:lights")).toBeLessThanOrEqual(windows);
    expect(windows).toBeLessThan(when("shops:lights"));
  });

  it("lights Tokyo's layers and no other city's, MID ones even when the haze has no window lit", () => {
    paintCityNight(recorder(), utc(22), world, cam, view, 0, street);
    expect(h.log.map((e) => e.what)).toEqual(["landmarks:lights"]);
    h.log.length = 0;
    paintCityNight(recorder(), at(12, "rain"), world, cam, view, 0, street);
    expect(h.log.map((e) => e.what)).toEqual(["towers:lights", "landmarks:lights", "apartments:lights", "canyon:lights", "shops:lights"]);
  });

  it("hands a light the measure of the dark: the stars' darkness and the skyline's lit share", () => {
    paintCityNight(recorder(), night, world, cam, view, 0, street);
    const s = lightScene("towers");
    expect(s.amb).toBe(night);
    expect(s.dark).toBeCloseTo(1, 9);
    expect(s.lit).toBe(citySky(night).lit);
    expect(s.lit).toBeGreaterThan(0);
  });

  it("cuts a MID light round the temples, the street's trees and lamps, and the sprites above the street — no more", () => {
    // The nearest MID layer (the shops): the canyon behind it is cut at the shops' face too.
    paintCityNight(recorder(), night, world, cam, view, 0, street);
    const s = lightScene("shops");
    const temple = templePixel();
    expect(s.hidden(temple.x, temple.y)).toBe(true);
    expect(s.hidden(-175, horizon - 20)).toBe(true);
    // The car on the road is left out of the list, and nothing else stands at the street's edge there.
    expect(s.hidden(85, horizon + 6)).toBe(false);
    // The haze is BEHIND a MID layer.
    const haze = hazePixel();
    expect(s.hidden(haze.x, haze.y)).toBe(false);
    // Open sky, far above everything.
    expect(s.hidden(-400, 4)).toBe(false);
  });

  it("never cuts round a sprite inside a building — the open-sky clip already keeps the light out of it", () => {
    const b = world.city!.buildings[0];
    const desk: [number, number, number, number] = [b.col * TILE + 20, (b.row + 1) * TILE, 16, 32];
    const half: [number, number, number, number] = [b.col * TILE - 8, (b.row + 1) * TILE, 16, 32];
    // Flush with the building's right wall: still wholly inside it.
    const flush: [number, number, number, number] = [(b.col + b.w) * TILE - 16, (b.row + 1) * TILE, 16, 32];
    paintCityNight(recorder(), night, world, cam, view, 0, [desk, half, flush]);
    const s = lightScene("shops");
    expect(s.hidden(desk[0] + 4, desk[1] + 4)).toBe(false);
    expect(s.hidden(flush[0] + 15, flush[1] + 4)).toBe(false);
    // One standing in the doorway, half out of the building, is still cut round.
    expect(s.hidden(half[0] + 4, half[1] + 4)).toBe(true);
  });

  it("cuts a HIGH light at the haze, and at a MID layer's face in front of it too", () => {
    h.faces.shops = (sc, x) => (x >= -200 && x < -100 ? sc.horizon - 100 : sc.horizon);
    paintCityNight(recorder(), night, world, cam, view, 0, street);
    const s = lightScene("towers");
    const haze = hazePixel();
    expect(s.hidden(haze.x, haze.y)).toBe(true);
    expect(s.hidden(-150, horizon - 50)).toBe(true);
    expect(s.hidden(-150, horizon - 150)).toBe(false);
    expect(s.hidden(-175, horizon - 20)).toBe(true);
    const temple = templePixel();
    expect(s.hidden(temple.x, temple.y)).toBe(true);
  });

  it("paints a cut light: a layer's `fillLit` leaves out the sprite in front of it", () => {
    paintCityNight(recorder(), night, world, cam, view, 0, street);
    const s = lightScene("shops");
    const ctx = s.ctx as RecordingTarget;
    const n = ctx.calls.length;
    // A strip of light 30 px wide across the passer-by's 10-px box: 20 columns of it are lit.
    s.fillLit(-190, horizon - 25, 30, 10);
    const painted = ctx.calls.slice(n).map((c) => c.args as number[]);
    expect(painted.reduce((sum, [, , w, hh]) => sum + w * hh, 0)).toBe(20 * 10);
    for (const [x, , w] of painted) expect(x + w <= -180 || x >= -170).toBe(true);
  });

  it("keeps the stars and the moon behind a layer's face, and the haze's windows behind a MID one", () => {
    const base = recorder();
    paintCityNight(base, night, world, cam, view, 0, street);
    expect(night.arc?.body).toBe("moon");
    expect(count(base, CITY.star)).toBeGreaterThan(0);
    expect(count(base, CITY.moon)).toBeGreaterThan(0);
    expect(count(base, CITY.window)).toBeGreaterThan(0);
    // A HIGH layer as tall as the sky: no star, no moon — and the haze's windows are in front of it.
    h.faces.towers = () => -1e9;
    const walled = recorder();
    paintCityNight(walled, night, world, cam, view, 0, street);
    expect(count(walled, CITY.star)).toBe(0);
    expect(count(walled, CITY.moon)).toBe(0);
    expect(count(walled, CITY.window)).toBe(count(base, CITY.window));
    // A MID layer covering the haze: none of its windows.
    delete h.faces.towers;
    h.faces.shops = () => -1e9;
    const hidden = recorder();
    paintCityNight(hidden, night, world, cam, view, 0, street);
    expect(count(hidden, CITY.window)).toBe(0);
  });

  it("cuts round no landmark where none is on screen — off past the city's end", () => {
    const away = { zoom: 1, ox: 5000, oy: 0 };
    paintCityNight(recorder(), night, world, away, view, 0, street);
    expect(lightScene("shops").hidden(-4500, horizon - 5)).toBe(false);
    expect(lightScene("towers").hidden(-4500, 4)).toBe(false);
    // A city with no landmarks has no backdrop layers to light either.
    h.log.length = 0;
    paintCityNight(recorder(), utc(22), world, cam, view, 0, street);
    expect(h.log.map((e) => e.what)).toEqual(["landmarks:lights"]);
  });

  it("hides a haze window whose lower pixel is behind a MID face, and keeps one wholly above it", () => {
    const base = recorder();
    paintCityNight(base, night, world, cam, view, 0);
    const lit = new Set(base.of("fillRect").filter((c) => c.fillStyle === CITY.window).map((c) => `${c.args[0]},${c.args[1]}`));
    // A lit window: its column's face set to its lower pixel (y + 1) hides it; one row lower (y + 2) does not.
    const [wx, wy] = [...lit][0].split(",").map(Number);
    for (const [face, shown] of [
      [wy + 1, false],
      [wy + 2, true],
    ] as const) {
      h.faces.shops = (sc, x) => (x === wx ? face : sc.horizon);
      const ctx = recorder();
      paintCityNight(ctx, night, world, cam, view, 0);
      expect(ctx.of("fillRect").some((c) => c.fillStyle === CITY.window && c.args[0] === wx && c.args[1] === wy)).toBe(shown);
    }
  });

  it("cuts a HIGH light behind a tower a row at a time: rows cut alike are one rect", () => {
    const tower = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).placed.find((p) => p.spec.kind === "tokyo-tower")!;
    paintCityNight(recorder(), night, world, cam, view, 0);
    const s = lightScene("towers");
    const ctx = s.ctx as RecordingTarget;
    const n = ctx.calls.length;
    // A band 40 rows tall across the tower's mast, high above the haze: the mast's width changes little.
    const top = horizon - tower.h + 4;
    s.fillLit(tower.x - 30, top, 60, 40);
    const rects = ctx.calls.slice(n).filter((c) => c.op === "fillRect");
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThan(40);
    for (const c of rects) {
      const [x, y, w] = c.args as number[];
      for (let k = 0; k < w; k++) expect(s.hidden(x + k, y)).toBe(false);
    }
  });

  it("lights two MID layers back to front, the farther one cut at the nearer one's face — and never the nearer one", () => {
    h.faces.shops = (sc, x) => (x >= -200 && x < -100 ? sc.horizon - 60 : sc.horizon);
    paintCityNight(recorder(), night, world, cam, view, 0, street);
    expect(h.log.filter((e) => !e.what.startsWith("landmarks")).map((e) => e.what)).toEqual(["towers:lights", "apartments:lights", "canyon:lights", "shops:lights"]);
    // The farthest MID layer (the apartments) is behind both nearer ones.
    expect(lightScene("apartments").hidden(-150, horizon - 30)).toBe(true);
    const canyon = lightScene("canyon");
    expect(canyon.hidden(-150, horizon - 30)).toBe(true);
    expect(canyon.hidden(-150, horizon - 90)).toBe(false);
    expect(canyon.hidden(-50, horizon - 30)).toBe(false);
    // The nearest layer is cut by nothing of its own depth.
    expect(lightScene("shops").hidden(-150, horizon - 30)).toBe(false);
    // …and a HIGH layer is behind them all.
    expect(lightScene("towers").hidden(-150, horizon - 30)).toBe(true);
  });

  it("the open sky between the clusters: no haze there — painted, lit, or standing in front of a star or a HIGH layer's light", () => {
    const [a, b] = airSpans(0, view.w).find(([p, q]) => {
      let tall = false;
      forEachSkylineBlock(p, q, horizon, (_x, _w, bh) => (tall ||= bh > 12));
      return tall;
    })!;
    const inside = (a + b) >> 1;
    expect(skylineFaceAt(inside, horizon)).toBeLessThan(horizon);
    // By day the haze is painted through a clip that leaves the open stretches out.
    const day = recorder();
    paintCityBackdrop(day, noon, world, cam, view, 0);
    const rects = day.calls.filter((c) => c.op === "rect").map((c) => c.args);
    expect(rects).toContainEqual([a, 0, b - a, horizon]);
    const classic = recorder();
    paintCityBackdrop(classic, utc(12), world, cam, view, 0);
    expect(classic.of("clip").length).toBeLessThan(day.of("clip").length);
    // At night: no lit haze window in the open sky, and a HIGH layer's light is not cut by haze there.
    const dark = recorder();
    paintCityNight(dark, night, world, cam, view, 0, street);
    const lit = dark.of("fillRect").filter((c) => c.fillStyle === CITY.window).map((c) => c.args[0] as number);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.some((x) => x >= a && x < b)).toBe(false);
    const withHaze = recorder();
    paintCityNight(withHaze, utc(22), world, cam, view, 0, street);
    expect(withHaze.of("fillRect").some((c) => c.fillStyle === CITY.window && (c.args[0] as number) >= a && (c.args[0] as number) < b)).toBe(true);
    const towers = lightScene("towers");
    expect(towers.hidden(inside, horizon - 4)).toBe(false);
    // The stars come down into the open sky, where the haze would hide them (every layer's own face is
    // the street's top here, so only the haze stands in their way).
    // Over a wide street (many open stretches): stars below the haze's top, inside an open stretch.
    const wide = { w: 8000, h: view.h };
    const far = { zoom: 1, ox: 3000, oy: 0 };
    const inHaze = (amb: Ambience) => {
      const ctx = recorder();
      paintCityNight(ctx, amb, world, far, wide, 0, street);
      return ctx.of("fillRect").filter((c) => {
        const [sxp, y] = c.args as number[];
        const x = sxp - far.ox;
        return c.fillStyle === CITY.star && inAir(x, x + 1) && y >= skylineFaceAt(x, horizon);
      }).length;
    };
    expect(inHaze(night)).toBeGreaterThan(0);
    expect(inHaze(utc(22))).toBe(0);
  });

  it("a MID face only hides the windows behind it", () => {
    const base = recorder();
    paintCityNight(base, night, world, cam, view, 0);
    const all = count(base, CITY.window);
    // A MID layer up to the haze's lowest window row over the left half: some windows go, not all.
    h.faces.shops = (sc, x) => (x < view.w / 2 ? sc.horizon - 12 : sc.horizon);
    const half = recorder();
    paintCityNight(half, night, world, cam, view, 0);
    const n = count(half, CITY.window);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(all);
    expect(skylineFaceAt(0, horizon)).toBeLessThan(horizon);
  });
});

describe("the frame", () => {
  const walker: DrawItem = {
    t: "walker",
    id: 1,
    x: 60,
    y: horizon + 12,
    dir: "right",
    anim: "walk",
    frame: 0,
    palette: 0,
    hueShift: 0,
    sink: 0,
    umbrella: 0,
    canopy: 0,
    vend: null,
    drink: null,
  };
  const agent: CharacterView = {
    key: "a",
    x: 200,
    y: horizon + 12,
    dir: "right",
    anim: "walk",
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
  };
  const bus: DrawItem = {
    t: "vehicle",
    v: { kind: "bus", x: 300, w: 60, y: horizon + 2 * TILE, dir: 1, livery: 0, odo: 0, braking: false, seed: 1, speed: 0 },
  };

  it("never needs to cut a light round a vehicle: none rises above the street's top, even a bus on the far lane", () => {
    // The far lane is the street's second row: a vehicle's wheels stand on its bottom, two tiles down.
    expect(vehicleBox((bus as { v: VehicleView }).v)[1]).toBeGreaterThanOrEqual(horizon);
    expect(ART_H).toBeLessThanOrEqual(2 * TILE);
  });

  it("hands the night pass the backdrop and the box of every agent and passer-by it drew", () => {
    renderFrame(recorder(), [walker, { t: "character", c: agent }, bus], cam, null, {
      w: view.w,
      h: view.h,
      world,
      ambience: night,
    });
    const s = lightScene("shops");
    expect(s.hidden(60, horizon - 10)).toBe(true);
    expect(s.hidden(200, horizon - 10)).toBe(true);
    expect(s.hidden(130, horizon - 10)).toBe(false);
  });

  it("paints the haze alone in a city with no street theme", () => {
    renderFrame(recorder(), [], cam, null, { w: view.w, h: view.h, world, ambience: utc(22) });
    expect(h.log.some((e) => !e.what.startsWith("landmarks"))).toBe(false);
  });
});
