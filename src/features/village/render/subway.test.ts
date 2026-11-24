/**
 * The City's subway, painted (render/subway.ts): the tunnel across the whole view, the station, the
 * stairwell, the train on its timetable, the street entrance — and their night lights — read back from a
 * recording target (jsdom has no canvas; the pixels are subway.browser.test.tsx's). Plus the wiring:
 * the backdrop, the lights pass and the `metro` prop dispatch them.
 */

import { describe, expect, it } from "vitest";

import { computeAmbience } from "../engine/ambience";
import { buildCityWorld } from "../engine/city";
import { buildWorld } from "../engine/world";
import { BRAKE_MS, CAR_GAP, CAR_LEN, CRUISE_MS, DOOR_MS, DOOR_WAIT_MS, stationStop, SUBWAY_CYCLE_MS, TRAIN_CARS, TRAIN_LEN, trainAt } from "../engine/subway";
import { TILE, type Prop, type World } from "../villageTypes";
import { paintAmbience } from "./ambience";
import type { Camera } from "./camera";
import { CITY, DUG as CITY_DUG, paintCityBackdrop } from "./city";
import { renderFrame } from "./frame";
import { drawProp } from "./props";
import {
  BEAM,
  CAR_DOORS,
  CAR_H,
  CAR_WINDOWS,
  CEILING,
  DETAIL_ZOOM,
  drawMetroEntrance,
  DUG,
  FLIGHT,
  GLOW,
  LAMP_PITCH,
  LAMP_REACH,
  LINE,
  LINE_LETTER,
  METRO,
  METRO_RISE,
  metroGlow,
  metroGlowBox,
  paintSubway,
  paintSubwayLights,
  PLATFORM_H,
  RING,
  riderIn,
  SHELL,
  SLEEPER_PITCH,
  STAIRS,
  STATION,
  STATION_NAME,
  subwayGeometry,
  TRAIN,
  TUNNEL,
} from "./subway";
import { recorder, type RecordingTarget } from "./testRecorder";

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/** The reference city: gazelle (seven floors of 26 seats) left of the HQ, a small Agent Studio right of it, a 64-seat lounge. */
const referenceCity = buildCityWorld(
  [
    { key: "Agent Studio", label: "Agent Studio", team: 2, hasIde: true, floors: floorsOf("a", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);
const sub = referenceCity.city!.subway!;
const W = referenceCity.cols * TILE;
const H = referenceCity.rows * TILE;
/** World px: the tunnel's top, its rail line, its bottom. */
const TOP = sub.top * TILE;
const RAIL = (sub.rail + 1) * TILE;
const BOTTOM = (sub.bottom + 1) * TILE;
const ST0 = sub.station.col0 * TILE;
const ST1 = sub.station.col1 * TILE;
const STAIRS_X = sub.entrance.col * TILE;
const SIDEWALK_BOTTOM = (sub.entrance.row + 1) * TILE;

const ARRIVE = CRUISE_MS + BRAKE_MS;
/** A moment the train stands at the station with its doors wide open (eastbound), and one between runs. */
const DWELL = ARRIVE + DOOR_WAIT_MS + DOOR_MS + 500;
const NONE = 60_000;

const cam1: Camera = { zoom: 1, ox: 0, oy: 0 };
const whole = { w: W, h: H };

type Fill = { x: number; y: number; w: number; h: number; style: string; alpha: number };
const fills = (ctx: RecordingTarget): Fill[] =>
  ctx.of("fillRect").map((c) => {
    const [x, y, w, h] = c.args as number[];
    return { x, y, w, h, style: c.fillStyle, alpha: c.alpha };
  });
const of = (ctx: RecordingTarget, style: string) => fills(ctx).filter((f) => f.style === style);
const styles = (ctx: RecordingTarget) => new Set(fills(ctx).map((f) => f.style));
const allTrain = Object.values(TRAIN) as string[];

function paint(timeMs: number, cam: Camera = cam1, view = whole, world: World = referenceCity): RecordingTarget {
  const ctx = recorder();
  paintSubway(ctx, cam, world, view, timeMs);
  return ctx;
}
function lights(timeMs: number, cam: Camera = cam1, view = whole, world: World = referenceCity): RecordingTarget {
  const ctx = recorder();
  paintSubwayLights(ctx, cam, world, view, timeMs);
  return ctx;
}

describe("subwayGeometry — the World's subway in world px, once per World", () => {
  it("is the tunnel's rows, the station's span, the stairwell from the sidewalk to the platform, and the entrance", () => {
    const g = subwayGeometry(referenceCity)!;
    expect(g.sub).toBe(sub);
    expect([g.top, g.rail, g.bottom]).toEqual([TOP, RAIL, BOTTOM]);
    expect(g.station).toEqual({ x0: ST0, x1: ST1 });
    expect(g.stairs).toEqual({ x: STAIRS_X, y: SIDEWALK_BOTTOM, w: 2 * TILE, h: RAIL - PLATFORM_H - SIDEWALK_BOTTOM });
    expect(g.entrance).toEqual({ x: STAIRS_X, bottom: SIDEWALK_BOTTOM });
    // The rail is the train's: the tunnel's rows are its 5, the rail line the bottom of the 4th.
    expect(BOTTOM - TOP).toBe(5 * TILE);
    expect(RAIL).toBe(BOTTOM - TILE);
    // Built once: the same object every frame.
    expect(subwayGeometry(referenceCity)).toBe(g);
  });

  it("is null — and nothing is painted — in a world without a subway (the Village; a city without capacity)", () => {
    const village = buildWorld([]);
    const bare = buildCityWorld([{ key: "a", label: "a", team: 2, hasIde: true, floors: floorsOf("a", 1) }]);
    for (const w of [village, bare]) {
      expect(subwayGeometry(w)).toBeNull();
      expect(subwayGeometry(w)).toBeNull();
      expect(paint(DWELL, cam1, whole, w).calls).toEqual([]);
      expect(lights(DWELL, cam1, whole, w).calls).toEqual([]);
    }
  });
});

describe("paintSubway — the tunnel", () => {
  it("runs across the WHOLE view, past the world's ends: its bands span the view at the tunnel's rows", () => {
    // A camera showing 300 px of street past the world's left end.
    const cam: Camera = { zoom: 1, ox: 300, oy: 0 };
    const view = { w: W + 600, h: H };
    const ctx = paint(NONE, cam, view);
    const at = (style: string) => of(ctx, style).filter((f) => f.x === 0 && f.w === view.w).map((f) => [f.y, f.h]);
    expect(at(TUNNEL.dug)).toEqual([
      [TOP - DUG, DUG],
      [BOTTOM, DUG],
    ]);
    expect(at(TUNNEL.lining)).toEqual([
      [TOP, SHELL],
      [BOTTOM - SHELL, SHELL],
    ]);
    expect(at(TUNNEL.wall)).toEqual([[TOP + SHELL, RAIL - TOP - SHELL]]);
    expect(at(TUNNEL.walkway)).toEqual([[RAIL - 8, 8]]);
    expect(at(TUNNEL.tray)).toEqual([[TOP + SHELL + 6, 1]]);
    expect(at(TUNNEL.liningEdge)).toEqual([
      [TOP, 1],
      [BOTTOM - 1, 1],
    ]);
    expect(at(TUNNEL.ballast)).toEqual([[RAIL, BOTTOM - SHELL - RAIL]]);
    // The rails on the rail line: the near one the wheels stand on, the far one just behind it.
    expect(at(TUNNEL.rail)).toEqual([[RAIL, 2]]);
    expect(at(TUNNEL.railShine)).toEqual([[RAIL, 1]]);
    expect(at(TUNNEL.railFar)).toEqual([[RAIL - 3, 1]]);
    // Every band stays in the tunnel's rows (and its dug soil).
    for (const f of fills(ctx).filter((f) => f.x === 0 && f.w === view.w)) {
      expect(f.y).toBeGreaterThanOrEqual(TOP - DUG);
      expect(f.y + f.h).toBeLessThanOrEqual(BOTTOM + DUG);
    }
  });

  it("is WORLD-LOCKED: a joint every RING, a lamp every LAMP_PITCH and a sleeper every SLEEPER_PITCH at fixed world x, whatever the camera — none of the joints or lamps in the station", () => {
    /** World x of each joint, lamp bulb and sleeper a camera draws (its screen x back to world x). */
    const seen = (cam: Camera, view: { w: number; h: number }) => {
      const ctx = paint(NONE, cam, view);
      const wx = (f: Fill) => (f.x - Math.round(cam.ox)) / cam.zoom + 0;
      return {
        joints: of(ctx, TUNNEL.joint).map(wx),
        bulbs: of(ctx, TUNNEL.bulb).map((f) => wx(f) + 1),
        sleepers: of(ctx, TUNNEL.sleeper).map(wx),
        x0: -Math.round(cam.ox) / cam.zoom,
        x1: (view.w - Math.round(cam.ox)) / cam.zoom,
      };
    };
    for (const cam of [cam1, { zoom: 1, ox: -77, oy: 0 }, { zoom: 2, ox: -1500, oy: -1200 }, { zoom: 3, ox: 413, oy: -2500 }]) {
      const s = seen(cam, { w: 1280, h: 4000 });
      // Every joint at a multiple of RING across the view, but never in the station.
      const joints: number[] = [];
      for (let x = Math.floor(s.x0 / RING) * RING; x < s.x1; x += RING) if (x + 1 <= ST0 || x >= ST1) joints.push(x + 0);
      expect(s.joints).toEqual(joints);
      // A lamp half way between two pitch marks, its light kept LAMP_REACH clear of the station.
      const bulbs: number[] = [];
      for (let k = -100; k < 200; k++) {
        const x = (k + 0.5) * LAMP_PITCH;
        if (x + LAMP_REACH > s.x0 && x - LAMP_REACH < s.x1 && (x + LAMP_REACH <= ST0 || x - LAMP_REACH >= ST1)) bulbs.push(x);
      }
      expect(s.bulbs).toEqual(bulbs);
      expect(s.sleepers).toEqual(
        Array.from({ length: Math.ceil(s.x1 / SLEEPER_PITCH) - Math.floor(s.x0 / SLEEPER_PITCH) }, (_, i) => (Math.floor(s.x0 / SLEEPER_PITCH) + i) * SLEEPER_PITCH + 0),
      );
      expect(s.bulbs.length).toBeGreaterThan(0);
    }
    // The reference station is not on a lamp's pitch by chance: a lamp stands near each of its ends, none in it.
    const all = seen(cam1, whole).bulbs;
    expect(all.some((x) => x < ST0 && x > ST0 - LAMP_PITCH)).toBe(true);
    expect(all.some((x) => x > ST1 && x < ST1 + LAMP_PITCH)).toBe(true);
    expect(all.some((x) => x + LAMP_REACH > ST0 && x - LAMP_REACH < ST1)).toBe(false);
  });

  it("each lamp has its housing under the shell, its bulb, and a pool of light down the wall that ends above the walkway", () => {
    const ctx = paint(NONE);
    const bulbs = of(ctx, TUNNEL.bulb);
    expect(bulbs.every((b) => b.y === TOP + SHELL + 5 && b.w === 3)).toBe(true);
    expect(of(ctx, TUNNEL.housing)).toHaveLength(2 * bulbs.length);
    const pools = of(ctx, TUNNEL.pool);
    expect(pools).toHaveLength(3 * bulbs.length);
    expect(pools.every((p) => p.y >= TOP + SHELL && p.y + p.h <= RAIL - 8)).toBe(true);
  });

  it("zoomed out below DETAIL_ZOOM leaves out the 1-px details — joints, sleepers' ends (one band instead), the rail's shine, grout, handrails", () => {
    const fine = paint(NONE, { zoom: DETAIL_ZOOM, ox: 0, oy: 0 }, { w: W, h: H });
    const coarse = paint(NONE, { zoom: 0.5, ox: 0, oy: 0 }, { w: W, h: H });
    for (const style of [TUNNEL.joint, TUNNEL.railShine, STATION.grout, STAIRS.rail]) {
      expect(of(fine, style).length).toBeGreaterThan(0);
      expect(of(coarse, style)).toEqual([]);
    }
    expect(of(fine, TUNNEL.sleeper).length).toBeGreaterThan(10);
    // At DETAIL_ZOOM a 1-px joint can snap to nothing: every detail keeps at least a pixel.
    expect(fills(fine).every((f) => f.w >= 1 && f.h >= 1)).toBe(true);
    const [a, b] = [Math.floor((RAIL + 2) * 0.5), Math.floor((RAIL + 5) * 0.5)];
    expect(of(coarse, TUNNEL.sleeper)).toEqual([{ x: 0, y: a, w: W, h: b - a, style: TUNNEL.sleeper, alpha: 1 }]);
  });

  it("zoomed right out (⅛) still paints every band at least a pixel tall — none vanishes between two rows", () => {
    const ctx = paint(DWELL, { zoom: 1 / 8, ox: 0, oy: 0 }, { w: 400, h: 400 });
    const bands = fills(ctx).filter((f) => f.x === 0 && f.w === 400);
    expect(bands.length).toBeGreaterThanOrEqual(12);
    expect(bands.every((f) => f.h >= 1)).toBe(true);
    expect(fills(ctx).every((f) => f.w >= 1 && f.h >= 1)).toBe(true);
  });

  it("paints none of the tunnel, the station or the train when its rows are off screen (the stairwell's top may still show)", () => {
    // The view ends just above the tunnel's dug soil.
    const view = { w: W, h: TOP - DUG };
    const ctx = paint(DWELL, cam1, view);
    const s = styles(ctx);
    for (const c of [TUNNEL.wall, TUNNEL.lining, TUNNEL.rail, STATION.wall, ...allTrain]) expect(s.has(c)).toBe(false);
    expect(s.has(STAIRS.back)).toBe(true);
    // …and nothing at all with the whole subway below the view.
    expect(paint(DWELL, cam1, { w: W, h: SIDEWALK_BOTTOM }).calls).toEqual([]);
    // With the view below it all, nothing either.
    expect(paint(DWELL, { zoom: 1, ox: 0, oy: -(BOTTOM + DUG) }, { w: W, h: 100 }).calls).toEqual([]);
  });
});

describe("paintSubway — the station", () => {
  const ctx = paint(NONE);

  it("is a tiled hall over its columns: ceiling, wall, a pillar at each end, the platform with its yellow edge over the track", () => {
    const floor = RAIL - PLATFORM_H;
    expect(of(ctx, STATION.ceiling)).toEqual([{ x: ST0, y: TOP + SHELL, w: ST1 - ST0, h: CEILING, style: STATION.ceiling, alpha: 1 }]);
    expect(of(ctx, STATION.wall).map((f) => [f.x, f.w, f.y, f.y + f.h])).toEqual([[ST0, ST1 - ST0, TOP + SHELL + CEILING, floor]]);
    expect(of(ctx, STATION.pillar).map((f) => f.x)).toEqual([ST0, ST1 - 3]);
    expect(of(ctx, STATION.floor).map((f) => [f.x, f.w, f.y])).toEqual([[ST0, ST1 - ST0, floor]]);
    expect(of(ctx, STATION.edge).map((f) => [f.x, f.w, f.h])).toEqual([[ST0, ST1 - ST0, 1]]);
    const face = of(ctx, STATION.face)[0];
    expect(face.y + face.h).toBe(RAIL);
    // Grout lines down the wall, a fluorescent tube in the ceiling every 32 px.
    expect(of(ctx, STATION.grout).length).toBeGreaterThan(4);
    const tubes = of(ctx, STATION.tube).map((f) => f.x);
    expect(tubes[0]).toBe(ST0 + 9);
    expect(tubes.slice(1).map((x, k) => x - tubes[k])).toEqual(tubes.slice(1).map(() => 32));
    // All along the platform (34 tiles under the reference city: 17 tubes), the last one clear of the
    // east pillar with no room for another before it.
    expect(tubes).toHaveLength(17);
    expect(tubes[tubes.length - 1] + 14).toBeLessThanOrEqual(ST1 - 3);
    expect(tubes[tubes.length - 1] + 32 + 14).toBeGreaterThan(ST1 - 3);
    // Nothing of the station outside its columns.
    for (const c of Object.values(STATION)) for (const f of of(ctx, c)) expect(f.x >= ST0 && f.x + f.w <= ST1).toBe(true);
  });

  it("hangs its name plate RIGHT of the stairs and over a standing train's roof, the line's stripe at the roof line, the bench LEFT of the stairs", () => {
    const roof = RAIL - CAR_H;
    const plate = of(ctx, STATION.plateFrame)[0];
    expect(plate.x).toBeGreaterThanOrEqual(STAIRS_X + 2 * TILE);
    expect(plate.x + plate.w).toBeLessThanOrEqual(ST1 - 3);
    expect(plate.y).toBe(TOP + SHELL + CEILING);
    expect(plate.y + plate.h).toBeLessThanOrEqual(roof);
    const stripe = of(ctx, LINE).find((f) => f.w === ST1 - ST0)!;
    expect(stripe.y + stripe.h).toBeLessThanOrEqual(roof);
    expect(stripe.y + stripe.h).toBeGreaterThan(roof - 3);
    const benches = of(ctx, STATION.bench);
    expect(benches).toHaveLength(2);
    expect(benches.every((b) => b.x >= ST0 + 3 && b.x + b.w <= STAIRS_X)).toBe(true);
    expect(of(ctx, STATION.benchLeg).every((l) => l.y + l.h === RAIL - PLATFORM_H)).toBe(true);
  });

  it("names the station: the line's badge (a teal disc, a white one in it, its letter) and the name in letters", () => {
    const plate = of(ctx, STATION.plateFrame)[0];
    const inPlate = (f: Fill) => f.x >= plate.x && f.x + f.w <= plate.x + plate.w && f.y >= plate.y && f.y + f.h <= plate.y + plate.h;
    // The badge: a 9-px disc of the line's colour (rows of 5, 7, 9 … 7, 5 px) with a 7-px white one in it.
    const badge = of(ctx, LINE).filter(inPlate);
    expect(badge.slice(0, 9).map((f) => f.w)).toEqual([5, 7, 9, 9, 9, 9, 9, 7, 5]);
    expect(of(ctx, STATION.plate).filter((f) => f.h === 1).map((f) => f.w)).toEqual([3, 5, 7, 7, 7, 5, 3]);
    // The letter in the badge ("A", 3 × 5), then the name, one 4-px glyph every 5 px: "H" and "Q".
    expect(LINE_LETTER).toBe("A");
    expect(badge.slice(9).map((f) => [f.x - plate.x, f.y - plate.y, f.w])).toEqual([
      [6, 4, 1],
      [5, 5, 1],
      [7, 5, 1],
      [5, 6, 3],
      [5, 7, 1],
      [7, 7, 1],
      [5, 8, 1],
      [7, 8, 1],
    ]);
    expect(STATION_NAME.join("")).toBe("HQ");
    const letters = of(ctx, STATION.letter).map((f) => [f.x - plate.x, f.y - plate.y, f.w]);
    expect(letters).toEqual([
      // H
      [13, 4, 1], [16, 4, 1], [13, 5, 1], [16, 5, 1], [13, 6, 4], [13, 7, 1], [16, 7, 1], [13, 8, 1], [16, 8, 1],
      // Q
      [19, 4, 2], [18, 5, 1], [21, 5, 1], [18, 6, 1], [21, 6, 1], [18, 7, 1], [20, 7, 1], [19, 8, 1], [21, 8, 1],
    ]);
  });
});

describe("paintSubway — the stairwell", () => {
  const ctx = paint(NONE);
  const box = subwayGeometry(referenceCity)!.stairs;

  it("goes down from the entrance's sidewalk to the platform under the entrance's two tiles, dug in down to the tunnel", () => {
    expect(of(ctx, STAIRS.lining)).toEqual([{ x: STAIRS_X, y: SIDEWALK_BOTTOM, w: 2 * TILE, h: RAIL - PLATFORM_H - SIDEWALK_BOTTOM, style: STAIRS.lining, alpha: 1 }]);
    expect(of(ctx, STAIRS.back).map((f) => [f.x, f.w])).toEqual([[STAIRS_X + 2, 2 * TILE - 4]]);
    const dug = of(ctx, TUNNEL.dug).find((f) => f.w !== W)!;
    expect([dug.x, dug.y, dug.w, dug.y + dug.h]).toEqual([STAIRS_X - DUG, SIDEWALK_BOTTOM, 2 * TILE + 2 * DUG, TOP - DUG]);
    // Beside the lounge, not in it: clear of its dug soil (three columns of earth between).
    const lounge = referenceCity.houses.find((h) => h.capacity === "seats")!;
    expect(STAIRS_X + 2 * TILE + DUG).toBeLessThan((lounge.col - 1) * TILE - DUG);
  });

  it("switches back flight by flight from the platform up — four steps of 4 px down each — alternating sides, none below the platform", () => {
    const flights = Math.floor(box.h / FLIGHT);
    const steps = of(ctx, STAIRS.step);
    expect(steps).toHaveLength(4 * flights);
    // Drawn from the top flight down: the last four are the lowest flight, coming down to the LEFT onto the platform.
    const lowest = steps.slice(-4);
    expect(lowest.map((f) => f.x - STAIRS_X)).toEqual([22, 16, 10, 4]);
    expect(lowest.map((f) => RAIL - PLATFORM_H - f.y)).toEqual([13, 9, 5, 1]);
    // The flight above it comes down to the RIGHT, ending over where the lowest one starts.
    expect(steps.slice(-8, -4).map((f) => f.x - STAIRS_X)).toEqual([4, 10, 16, 22]);
    expect(steps.every((f) => f.y >= SIDEWALK_BOTTOM && f.y < RAIL - PLATFORM_H)).toBe(true);
    // The slabs under the steps never reach into the platform.
    expect(of(ctx, STAIRS.riser).every((f) => f.y + f.h <= RAIL - PLATFORM_H)).toBe(true);
    // A handrail over every step; a lamp every fourth flight.
    expect(of(ctx, STAIRS.rail)).toHaveLength(4 * flights);
    expect(of(ctx, STAIRS.lamp)).toHaveLength(Math.floor((flights + 1) / 4));
    expect(flights).toBeGreaterThan(8);
  });
});

describe("paintSubway — the train", () => {
  /** The cars' left x, the train's middle at x. */
  const cars = (x: number) => Array.from({ length: TRAIN_CARS }, (_, i) => x - TRAIN_LEN / 2 + i * (CAR_LEN + CAR_GAP));

  it("stands at the station between runs' ends — its cars' bodies along the platform, its wheels on the rail line", () => {
    const ctx = paint(DWELL);
    const stop = stationStop(sub);
    expect(of(ctx, TRAIN.body).map((f) => [f.x, f.w, f.y, f.y + f.h])).toEqual(cars(stop).map((c) => [c, CAR_LEN, RAIL - CAR_H + 1, RAIL - 5]));
    expect(cars(stop)[0]).toBeGreaterThanOrEqual(ST0);
    expect(cars(stop)[TRAIN_CARS - 1] + CAR_LEN).toBeLessThanOrEqual(ST1);
    const wheels = of(ctx, TRAIN.wheel);
    expect(wheels).toHaveLength(4 * TRAIN_CARS);
    expect(wheels.every((f) => f.y + f.h === RAIL)).toBe(true);
    expect(of(ctx, TRAIN.gangway)).toHaveLength(TRAIN_CARS - 1);
    // Taller than a character (32 px) and clear of the lamps under the shell.
    expect(CAR_H).toBeGreaterThan(32);
    expect(RAIL - CAR_H).toBeGreaterThan(TOP + SHELL + 6);
    // Its windows, a rider in about half of them (by the run's seed).
    const t = trainAt(sub, referenceCity.cols, DWELL)!;
    let riders = 0;
    for (let i = 0; i < TRAIN_CARS; i++) for (let w = 0; w < CAR_WINDOWS.length; w++) if (riderIn(t.riders, i, w)) riders++;
    expect(of(ctx, TRAIN.window).filter((f) => f.w === 5)).toHaveLength(TRAIN_CARS * CAR_WINDOWS.length);
    expect(of(ctx, TRAIN.rider)).toHaveLength(2 * riders);
    expect(riders).toBeGreaterThan(0);
    expect(riders).toBeLessThan(TRAIN_CARS * CAR_WINDOWS.length);
  });

  it("opens its doors at the station: the lit inside through each doorway, the leaves slid away — shut, the leaves meet at a seam", () => {
    const open = paint(DWELL);
    expect(of(open, TRAIN.inside)).toHaveLength(TRAIN_CARS * CAR_DOORS.length);
    expect(of(open, TRAIN.door)).toEqual([]);
    const shut = paint(ARRIVE + 100);
    expect(of(shut, TRAIN.inside)).toEqual([]);
    expect(of(shut, TRAIN.door).map((f) => f.w)).toEqual(Array.from({ length: TRAIN_CARS * CAR_DOORS.length }, () => 8));
    // The two shut leaves meet at a seam down the middle of each doorway.
    const left = stationStop(sub) - TRAIN_LEN / 2;
    const seams = of(shut, TRAIN.doorFrame).filter((f) => f.w === 1);
    expect(seams.map((f) => f.x)).toEqual(
      Array.from({ length: TRAIN_CARS }, (_, i) => CAR_DOORS.map((dx) => left + i * (CAR_LEN + CAR_GAP) + dx + 4)).flat(),
    );
    expect(of(open, TRAIN.doorFrame).filter((f) => f.w === 1)).toEqual([]);
    // Half open: each leaf shows the half still in its doorway.
    const half = paint(ARRIVE + DOOR_WAIT_MS + DOOR_MS / 2);
    const leaves = of(half, TRAIN.door);
    expect(leaves.map((f) => f.w)).toEqual(Array.from({ length: 2 * TRAIN_CARS * CAR_DOORS.length }, () => 2));
    const c0 = stationStop(sub) - TRAIN_LEN / 2;
    expect(leaves.slice(0, 2).map((f) => f.x - c0)).toEqual([CAR_DOORS[0], CAR_DOORS[0] + 6]);
  });

  it("leads with its head lamp and trails its red tail lamp: east end first eastbound, west end first westbound", () => {
    const east = paint(DWELL);
    const c0 = stationStop(sub) - TRAIN_LEN / 2;
    expect(of(east, TRAIN.head).map((f) => f.x)).toEqual([c0 + TRAIN_LEN - 2]);
    expect(of(east, TRAIN.tail).map((f) => f.x)).toEqual([c0]);
    const west = paint(SUBWAY_CYCLE_MS / 2 + DWELL);
    expect(of(west, TRAIN.head).map((f) => f.x)).toEqual([c0]);
    expect(of(west, TRAIN.tail).map((f) => f.x)).toEqual([c0 + TRAIN_LEN - 2]);
    // A windscreen at both ends.
    expect(of(east, TRAIN.windscreen).map((f) => f.x)).toEqual([c0, c0 + TRAIN_LEN - 3]);
  });

  it("changes its riders at the station: other windows hold riders after it than before it", () => {
    const riders = (t: number) => of(paint(t), TRAIN.rider).map((f) => `${f.x},${f.y}`).join(" ");
    expect(riders(ARRIVE + 100)).toBe(riders(ARRIVE + DOOR_WAIT_MS));
    expect(riders(ARRIVE + 100)).not.toBe(riders(ARRIVE + 7_900));
    // The westbound run carries others again.
    expect(riders(SUBWAY_CYCLE_MS / 2 + ARRIVE + 100)).not.toBe(riders(ARRIVE + 100));
  });

  it("is nowhere between runs, and a car off screen is not painted", () => {
    const none = styles(paint(NONE));
    for (const c of allTrain) expect(none.has(c)).toBe(false);
    // A view holding only the first car (and the gangway after it is the second car's, off screen).
    const c0 = stationStop(sub) - TRAIN_LEN / 2;
    const ctx = paint(DWELL, { zoom: 1, ox: -Math.round(c0), oy: 0 }, { w: CAR_LEN, h: H });
    expect(of(ctx, TRAIN.body)).toHaveLength(1);
    expect(of(ctx, TRAIN.gangway)).toEqual([]);
    // Coming in fast from the west, only the cars already on screen.
    const t = trainAt(sub, referenceCity.cols, CRUISE_MS + 1500)!;
    const lead = t.x + TRAIN_LEN / 2;
    const entering = paint(CRUISE_MS + 1500, { zoom: 1, ox: -Math.round(lead - CAR_LEN / 2), oy: 0 }, { w: 400, h: H });
    expect(of(entering, TRAIN.body)).toHaveLength(1);
  });
});

describe("paintSubwayLights — the subway at night", () => {
  it("lights the same lamps the day shows — a halo each over the roof line — and its bulbs again over the grade", () => {
    const day = of(paint(NONE), TUNNEL.bulb).map((f) => f.x);
    const ctx = lights(NONE);
    expect(of(ctx, TUNNEL.bulb).map((f) => f.x)).toEqual(day);
    const halos = of(ctx, GLOW.lamp);
    expect(halos).toHaveLength(3 * day.length);
    // Never on a passing train: every halo ends above its roof.
    expect(halos.every((f) => f.y + f.h <= RAIL - CAR_H)).toBe(true);
  });

  it("lights the station's tubes and its hall — but not over a train standing in it (it is lit by its own windows)", () => {
    const empty = lights(NONE);
    expect(of(empty, STATION.tube).map((f) => f.x)).toEqual(of(paint(NONE), STATION.tube).map((f) => f.x));
    expect(of(empty, GLOW.station).map((f) => [f.x, f.w, f.y, f.y + f.h])).toEqual([
      [ST0, ST1 - ST0, TOP + SHELL, RAIL - CAR_H],
      [ST0, ST1 - ST0, RAIL - CAR_H, RAIL],
    ]);
    const stop = stationStop(sub);
    const [l, r] = [stop - TRAIN_LEN / 2, stop + TRAIN_LEN / 2];
    const full = of(lights(DWELL), GLOW.station).filter((f) => f.y >= RAIL - CAR_H);
    expect(full.map((f) => [f.x, f.x + f.w])).toEqual([
      [ST0, l],
      [r, ST1],
    ]);
    // Half in the station (still braking in from the west): the hall is lit beyond its head only.
    const t = trainAt(sub, referenceCity.cols, ARRIVE - 3000)!;
    const head = Math.round(t.x + TRAIN_LEN / 2);
    expect(head).toBeGreaterThan(ST0);
    const half = of(lights(ARRIVE - 3000), GLOW.station).filter((f) => f.y >= RAIL - CAR_H);
    expect(half.map((f) => [f.x, f.x + f.w])).toEqual([[head, ST1]]);
    // Clear of the station entirely (still far away), the whole hall.
    expect(of(lights(1000), GLOW.station)).toHaveLength(2);
  });

  it("lights the train: a glow round each window, the windows (their riders) over the grade, open doorways; the head lamp's beam ahead, the tail's red behind", () => {
    const ctx = lights(DWELL);
    const n = TRAIN_CARS * CAR_WINDOWS.length;
    expect(of(ctx, GLOW.window)).toHaveLength(n);
    expect(of(ctx, TRAIN.window)).toHaveLength(n);
    expect(of(ctx, TRAIN.rider)).toHaveLength(of(paint(DWELL), TRAIN.rider).length);
    const doorways = of(ctx, TRAIN.inside);
    expect(doorways).toHaveLength(TRAIN_CARS * CAR_DOORS.length);
    expect(doorways.every((f) => f.w === 8)).toBe(true);
    const stop = stationStop(sub);
    const east = of(ctx, GLOW.beam);
    expect(east.map((f) => [f.x, f.w])).toEqual([1, 2, 3].map((k) => [stop + TRAIN_LEN / 2, Math.round((BEAM * k) / 3)]));
    expect(of(ctx, GLOW.tail).map((f) => f.x)).toEqual([stop - TRAIN_LEN / 2 - 6]);
    const west = lights(SUBWAY_CYCLE_MS / 2 + DWELL);
    expect(of(west, GLOW.beam).map((f) => [f.x + f.w])).toEqual([1, 2, 3].map(() => [stop - TRAIN_LEN / 2]));
    expect(of(west, GLOW.tail).map((f) => f.x)).toEqual([stop + TRAIN_LEN / 2 - 6]);
    // Doors shut: no doorway is lit.
    expect(of(lights(ARRIVE + 100), TRAIN.inside)).toEqual([]);
    // Between runs: none of it.
    const none = lights(NONE);
    for (const c of [GLOW.window, GLOW.beam, GLOW.tail, TRAIN.window]) expect(of(none, c)).toEqual([]);
  });

  it("culls what is off screen: the train's lights, its beam, its tail; the tunnel's with its rows off screen — the entrance's and the stairwell's still on", () => {
    // A view of only the train's east end, eastbound (from 7 px into its last car): the head's beam is
    // there, the tail is not, and of the cars only the last one's windows.
    const stop = stationStop(sub);
    const ctx = lights(DWELL, { zoom: 1, ox: -(stop + TRAIN_LEN / 2 - CAR_LEN + 7), oy: 0 }, { w: 120, h: H });
    expect(of(ctx, GLOW.beam)).toHaveLength(3);
    expect(of(ctx, GLOW.tail)).toEqual([]);
    expect(of(ctx, GLOW.window)).toHaveLength(CAR_WINDOWS.length);
    // A view ending at the train's tail: its red glow, no beam (the head is far off), no car.
    const behind = lights(DWELL, { zoom: 1, ox: -(stop - TRAIN_LEN / 2 - 150), oy: 0 }, { w: 149, h: H });
    expect(of(behind, GLOW.tail)).toHaveLength(1);
    expect(of(behind, GLOW.beam)).toEqual([]);
    expect(of(behind, GLOW.window)).toEqual([]);
    // Westbound, a view of only the track ahead of its head: the beam there, nothing of the train.
    const west = lights(SUBWAY_CYCLE_MS / 2 + DWELL, { zoom: 1, ox: -(stop - TRAIN_LEN / 2 - 60), oy: 0 }, { w: 59, h: H });
    expect(of(west, GLOW.beam)).toHaveLength(3);
    expect(of(west, GLOW.window)).toEqual([]);
    // A view of the tunnel well clear of the station: none of the station's lights.
    const away = lights(NONE, { zoom: 1, ox: -(ST1 + 300), oy: 0 }, { w: 300, h: H });
    expect(of(away, GLOW.lamp).length).toBeGreaterThan(0);
    expect(of(away, GLOW.station)).toEqual([]);
    expect(of(away, STATION.tube)).toEqual([]);
    // The tunnel's rows below the view: only the entrance and the stairwell.
    const above = lights(DWELL, cam1, { w: W, h: TOP - 1 });
    expect([...styles(above)].sort()).toEqual([GLOW.mouth, GLOW.sign, GLOW.stairs].sort());
    // Everything below the view: nothing.
    expect(lights(DWELL, cam1, { w: W, h: 100 }).calls).toEqual([]);
    // The view below the tunnel: the stairwell's glow is off screen too.
    expect(lights(DWELL, { zoom: 1, ox: 0, oy: -BOTTOM }, { w: W, h: 100 }).calls).toEqual([]);
  });

  it("lights the stairwell and glows round the entrance's sign and mouth", () => {
    const ctx = lights(NONE);
    expect(of(ctx, GLOW.stairs).map((f) => [f.x, f.y, f.w, f.y + f.h])).toEqual([[STAIRS_X + 2, SIDEWALK_BOTTOM, 2 * TILE - 4, RAIL - PLATFORM_H]]);
    const r = recorder();
    metroGlow(r, cam1, STAIRS_X, SIDEWALK_BOTTOM);
    expect(fills(ctx).filter((f) => f.style === GLOW.sign || f.style === GLOW.mouth)).toEqual(fills(r));
    const [bx, by, bw, bh] = metroGlowBox(STAIRS_X, SIDEWALK_BOTTOM);
    for (const f of fills(r)) expect(f.x >= bx && f.y >= by && f.x + f.w <= bx + bw && f.y + f.h <= by + bh).toBe(true);
    // The sign's glow is round the sign, the mouth's over the stairwell's mouth.
    expect(fills(r).find((f) => f.style === GLOW.sign)!.y).toBe(SIDEWALK_BOTTOM - METRO_RISE - 4);
  });
});

describe("drawMetroEntrance — the street entrance (the `metro` prop)", () => {
  const x0 = 100;
  const bottom = 200;

  it("is a dark stairwell mouth with its top steps going down, a green railing round it, and our 'M' sign on a pole — all inside its two tiles and METRO_RISE over them", () => {
    const ctx = recorder();
    drawMetroEntrance(ctx, cam1, x0, bottom, false);
    expect(of(ctx, METRO.mouth)).toEqual([{ x: x0 + 2, y: bottom - 13, w: 25, h: 12, style: METRO.mouth, alpha: 1 }]);
    // The nosings: lighter at the top, darker further down.
    expect(METRO.nosing.map((c) => of(ctx, c)[0].y)).toEqual([0, 1, 2, 3].map((i) => bottom - 12 + 3 * i));
    expect(of(ctx, METRO.railing).length).toBeGreaterThanOrEqual(5);
    expect(of(ctx, METRO.pole)).toHaveLength(1);
    // The sign: a rounded square of the line's teal, the "M" in white.
    expect(of(ctx, METRO.sign).map((f) => [f.w, f.h])).toEqual([
      [7, 9],
      [9, 7],
    ]);
    const m = of(ctx, METRO.letter).map((f) => [f.x - (x0 + 25), f.y - (bottom - METRO_RISE + 2), f.w]);
    expect(m).toEqual([
      [0, 0, 1], [4, 0, 1], [0, 1, 2], [3, 1, 2], [0, 2, 1], [2, 2, 1], [4, 2, 1], [0, 3, 1], [4, 3, 1], [0, 4, 1], [4, 4, 1],
    ]);
    for (const f of fills(ctx)) {
      expect(f.x).toBeGreaterThanOrEqual(x0);
      expect(f.x + f.w).toBeLessThanOrEqual(x0 + 2 * TILE);
      expect(f.y).toBeGreaterThanOrEqual(bottom - METRO_RISE);
      expect(f.y + f.h).toBeLessThanOrEqual(bottom);
    }
    // Within the frame's prop cull: a tile above its footprint.
    expect(METRO_RISE).toBeLessThanOrEqual(2 * TILE);
  });

  it("lights its sign when the night lights are on", () => {
    const ctx = recorder();
    drawMetroEntrance(ctx, cam1, x0, bottom, true);
    expect(of(ctx, METRO.sign)).toEqual([]);
    expect(of(ctx, METRO.signLit)).toHaveLength(2);
    expect(of(ctx, METRO.letterLit)).toHaveLength(11);
    expect(METRO.sign).toBe(LINE);
  });
});

describe("the wiring — the backdrop, the lights pass and the prop dispatch the subway", () => {
  const metro = referenceCity.props.find((p) => p.kind === "metro") as Prop;

  it("digs in like the lounge: the same freshly dug soil round the tunnel and the stairwell", () => {
    expect(TUNNEL.dug).toBe(CITY.dug);
    expect(DUG).toBe(CITY_DUG);
  });

  it("the City's backdrop paints it under the world (and a city without one paints none)", () => {
    const ctx = recorder();
    paintCityBackdrop(ctx, undefined, referenceCity, cam1, whole, DWELL);
    const s = styles(ctx);
    for (const c of [TUNNEL.wall, STATION.wall, STAIRS.back, TRAIN.body]) expect(s.has(c)).toBe(true);
    // Over the soil it is dug into, not under it.
    const order = fills(ctx).map((f) => f.style);
    expect(order.lastIndexOf(CITY.soil[CITY.soil.length - 1])).toBeLessThan(order.indexOf(TUNNEL.wall));
    expect(order.lastIndexOf(CITY.pebble)).toBeLessThan(order.indexOf(TUNNEL.wall));
    const bare = buildCityWorld([{ key: "a", label: "a", team: 2, hasIde: true, floors: floorsOf("a", 1) }]);
    const none = recorder();
    paintCityBackdrop(none, undefined, bare, cam1, { w: bare.cols * TILE, h: bare.rows * TILE + 200 }, DWELL);
    expect(styles(none).has(TUNNEL.wall)).toBe(false);
  });

  it("the lights pass lights it with the night lights on — and not by day", () => {
    const night = computeAmbience(new Date(2026, 9, 26, 23, 0), null, { weather: "clear", phase: "auto" });
    const noon = computeAmbience(new Date(2026, 9, 26, 12, 0), null, { weather: "clear", phase: "auto" });
    expect(night.lightsOn).toBe(true);
    expect(noon.lightsOn).toBe(false);
    const lit = recorder();
    paintAmbience(lit, night, [], 0, referenceCity, cam1, whole, DWELL);
    expect(styles(lit).has(GLOW.window)).toBe(true);
    expect(styles(lit).has(GLOW.lamp)).toBe(true);
    const day = recorder();
    paintAmbience(day, noon, [], 0, referenceCity, cam1, whole, DWELL);
    expect(styles(day).has(GLOW.lamp)).toBe(false);
  });

  it("the `metro` prop is drawn as the entrance, its sign lit by the night lights", () => {
    const night = computeAmbience(new Date(2026, 9, 26, 23, 0), null, { weather: "clear", phase: "auto" });
    const x0 = metro.col * TILE;
    const bottom = (metro.row + 1) * TILE;
    const ref = recorder();
    drawMetroEntrance(ref, cam1, x0, bottom, false);
    const day = recorder();
    drawProp(day, cam1, { prop: metro, on: false, frame: 0 }, null, 0);
    expect(fills(day)).toEqual(fills(ref));
    const lit = recorder();
    drawProp(lit, cam1, { prop: metro, on: false, frame: 0 }, null, 0, night);
    expect(of(lit, METRO.signLit)).toHaveLength(2);
  });

  it("a whole City frame carries it: the tunnel under the world, the entrance in the scene", () => {
    const ctx = recorder();
    renderFrame(ctx, [{ t: "prop", prop: metro, on: false, frame: 0 }], cam1, null, { w: W, h: H, timeMs: DWELL, world: referenceCity });
    const s = styles(ctx);
    for (const c of [TUNNEL.wall, TRAIN.body, METRO.sign]) expect(s.has(c)).toBe(true);
    // The tunnel goes down before the entrance (it is under the world; the entrance in the scene).
    const order = fills(ctx).map((f) => f.style);
    expect(order.indexOf(TUNNEL.wall)).toBeLessThan(order.indexOf(METRO.sign));
  });
});
