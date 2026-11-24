import { describe, expect, it } from "vitest";

import { computeAmbience } from "../engine/ambience";
import { buildCityWorld } from "../engine/city";
import { SPEC } from "../engine/traffic";
import { TILE, type DrawItem, type VehicleKind, type VehicleView, type WeatherKind } from "../villageTypes";
import { paintAmbience } from "./ambience";
import type { Camera } from "./camera";
import { renderFrame } from "./frame";
import { recorder, type DrawCall } from "./testRecorder";
import {
  ART_H,
  BEAM,
  BEAM_FADE,
  BEAM_SLICES,
  BEAM_STEP,
  BUS_DOORS,
  BUS_WINDOWS,
  COMMON,
  LIGHTS,
  PAINTS,
  SPRAY_SPEED,
  WHEEL_STEP,
  busRider,
  drawVehicle,
  lightsBox,
  paintVehicleLights,
  shapeOf,
  vehicleBox,
  wheelFrame,
} from "./vehicles";

const CAM: Camera = { zoom: 1, ox: 0, oy: 0 };
const VIEW = { w: 4000, h: 4000 };
const KINDS: readonly VehicleKind[] = ["car", "kei", "taxi", "bus"];

const vehicle = (extra: Partial<VehicleView> = {}): VehicleView => {
  const kind = extra.kind ?? "car";
  return { kind, x: 1000, w: SPEC[kind].len, y: 2000, dir: 1, livery: 0, odo: 0, braking: false, seed: 7, speed: 90, ...extra };
};

/** The rects painted in `color`, as world boxes (zoom 1, no offset). */
const rects = (calls: DrawCall[], color: string) =>
  calls.filter((c) => c.op === "fillRect" && c.fillStyle === color).map((c) => c.args as [number, number, number, number]);

function drawn(v: VehicleView, wet = false) {
  const ctx = recorder();
  drawVehicle(ctx, CAM, v, wet);
  return ctx.of("fillRect");
}
function lit(v: VehicleView) {
  const ctx = recorder();
  paintVehicleLights(ctx, CAM, VIEW, [v]);
  return ctx.of("fillRect");
}

/** Every vehicle variant: each kind × each of its liveries × both ways × braking or not. */
const ALL: VehicleView[] = KINDS.flatMap((kind) =>
  PAINTS[kind].flatMap((_, livery) => [1, -1].flatMap((dir) => [false, true].map((braking) => vehicle({ kind, livery, dir: dir as 1 | -1, braking })))),
);

describe("the art — sizes and paints", () => {
  it("one paint per livery the engine picks from, and every kind's art exactly its engine length long, no taller than ART_H", () => {
    for (const kind of KINDS) {
      expect(PAINTS[kind]).toHaveLength(SPEC[kind].liveries);
      for (let livery = 0; livery < SPEC[kind].liveries; livery++) {
        const parts = shapeOf({ kind, livery });
        expect(Math.min(...parts.map(([, lx]) => lx))).toBe(0);
        expect(Math.max(...parts.map(([, lx, , w]) => lx + w))).toBe(SPEC[kind].len);
        expect(Math.max(...parts.map(([, , y]) => y))).toBeLessThanOrEqual(ART_H);
      }
    }
    expect(Math.max(...shapeOf({ kind: "bus", livery: 0 }).map(([, , y]) => y))).toBe(ART_H);
  });

  it("taxis: livery 0 is the tall wagon with its lantern, the others the classic sedan with a roof sign", () => {
    const lamp = (livery: number) => shapeOf({ kind: "taxi", livery }).find(([role]) => role === "lamp")!;
    expect(lamp(0)[2]).toBe(23);
    for (const livery of [1, 2, 3]) expect(lamp(livery)[2]).toBe(22);
    expect(shapeOf({ kind: "car", livery: 0 }).some(([role]) => role === "lamp")).toBe(false);
    expect(shapeOf({ kind: "kei", livery: 0 })).not.toBe(shapeOf({ kind: "car", livery: 0 }));
    // The classic taxi is the sedan with a sign and a stripe.
    expect(shapeOf({ kind: "taxi", livery: 2 })).toEqual(expect.arrayContaining([...shapeOf({ kind: "car", livery: 0 })]));
  });

  it("every rect it paints lies in vehicleBox, every light in lightsBox", () => {
    for (const v of ALL) {
      const [bx, by, bw, bh] = vehicleBox(v);
      for (const { args } of drawn({ ...v, speed: SPRAY_SPEED + 10 }, true)) {
        const [x, y, w, h] = args as number[];
        expect(x).toBeGreaterThanOrEqual(bx);
        expect(y).toBeGreaterThanOrEqual(by);
        expect(x + w).toBeLessThanOrEqual(bx + bw);
        expect(y + h).toBeLessThanOrEqual(by + bh);
      }
      const [lx, ly, lw, lh] = lightsBox(v);
      for (const { args } of lit(v)) {
        const [x, y, w, h] = args as number[];
        expect(x).toBeGreaterThanOrEqual(lx);
        expect(y).toBeGreaterThanOrEqual(ly);
        expect(x + w).toBeLessThanOrEqual(lx + lw);
        expect(y + h).toBeLessThanOrEqual(ly + lh);
      }
    }
  });
});

describe("drawVehicle", () => {
  it("faces its way: the headlamps at the front (right end driving right, left end driving left), the tail lights behind", () => {
    const right = drawn(vehicle({ dir: 1 }));
    const left = drawn(vehicle({ dir: -1 }));
    expect(rects(right, COMMON.head)).toEqual([[1036, 1988, 2, 2]]);
    expect(rects(right, COMMON.tail)).toEqual([[1000, 1988, 2, 2]]);
    expect(rects(left, COMMON.head)).toEqual([[1000, 1988, 2, 2]]);
    expect(rects(left, COMMON.tail)).toEqual([[1036, 1988, 2, 2]]);
    // A mirror image: the same rects, reflected about its middle.
    const mirror = (a: number[]) => [2 * 1000 + 38 - a[0] - a[2], a[1], a[2], a[3]];
    const key = (a: number[]) => a.join(",");
    expect(right.map((c) => key(mirror(c.args as number[]))).sort()).toEqual(left.map((c) => key(c.args as number[])).sort());
  });

  it("stands on the road: its shadow and wheels end on `y`, nothing below it", () => {
    for (const v of ALL) {
      const calls = drawn(v);
      expect(Math.max(...calls.map((c) => (c.args[1] as number) + (c.args[3] as number)))).toBe(v.y);
      expect(rects(calls, COMMON.shadow)).toEqual([[v.x + 1, v.y - 1, v.w - 2, 1]]);
      expect(rects(calls, COMMON.tyre).some(([, y, , h]) => y + h === v.y)).toBe(true);
    }
  });

  it("in its own paint: body and cabin colours from its livery", () => {
    for (const v of ALL) {
      const p = PAINTS[v.kind][v.livery];
      const calls = drawn(v);
      expect(rects(calls, p.body).length).toBeGreaterThan(0);
      if (v.kind !== "bus") expect(rects(calls, p.cabin).length).toBeGreaterThan(0);
    }
    // The classic taxis are two-tone: a white top over a coloured body.
    expect(PAINTS.taxi[2].cabin).not.toBe(PAINTS.taxi[2].body);
    expect(rects(drawn(vehicle({ kind: "taxi", livery: 2 })), PAINTS.taxi[2].cabin).length).toBeGreaterThan(0);
  });

  it("brake lights: the tail lights turn bright red while braking", () => {
    expect(rects(drawn(vehicle({ braking: true })), COMMON.brake)).toEqual([[1000, 1988, 2, 2]]);
    expect(rects(drawn(vehicle({ braking: true })), COMMON.tail)).toEqual([]);
    expect(rects(drawn(vehicle({ braking: false })), COMMON.brake)).toEqual([]);
  });

  it("the wheels turn: a light spot steps round each hub every WHEEL_STEP px — top, front, bottom, back", () => {
    expect([0, 1, 2, 3, 4, 7].map((k) => wheelFrame(k * WHEEL_STEP))).toEqual([0, 1, 2, 3, 0, 3]);
    expect(wheelFrame(WHEEL_STEP - 0.01)).toBe(0);
    expect(wheelFrame(-5)).toBe(0);
    const spots = (v: VehicleView) => rects(drawn(v), COMMON.spoke);
    // The car's rear wheel: centre lx 8, its middle row 4 px up the road (y − 4).
    expect(spots(vehicle({ odo: 0 }))[0]).toEqual([1008, 1995, 1, 1]);
    expect(spots(vehicle({ odo: WHEEL_STEP }))[0]).toEqual([1009, 1996, 1, 1]);
    expect(spots(vehicle({ odo: 2 * WHEEL_STEP }))[0]).toEqual([1008, 1997, 1, 1]);
    expect(spots(vehicle({ odo: 3 * WHEEL_STEP }))[0]).toEqual([1007, 1996, 1, 1]);
    // Driving left, its front is on the left: the spot rolls the other way round.
    expect(spots(vehicle({ dir: -1, odo: WHEEL_STEP }))[0][0]).toBe(1000 + 38 - 9 - 1);
    // Two wheels, each with a hub; a bus's are bigger.
    expect(rects(drawn(vehicle()), COMMON.hub)).toHaveLength(2);
    const tyreH = (kind: VehicleKind) => Math.max(...rects(drawn(vehicle({ kind })), COMMON.tyre).map(([, , , h]) => h));
    expect(tyreH("car")).toBe(7);
    expect(tyreH("bus")).toBe(9);
  });

  it("a bus: seven windows, passengers at some (stable per bus), a destination board — and its doors on the kerb side only", () => {
    const bus = vehicle({ kind: "bus", seed: 99 });
    const calls = drawn(bus);
    expect(rects(calls, COMMON.glassHi)).toHaveLength(BUS_WINDOWS.length);
    const riders = BUS_WINDOWS.filter((_, k) => busRider(99, k) !== null).length;
    expect(riders).toBeGreaterThan(0);
    expect(riders).toBeLessThan(BUS_WINDOWS.length);
    expect(rects(calls, COMMON.rider)).toHaveLength(2 * riders);
    expect(rects(calls, COMMON.boardText)).toHaveLength(8);
    // Driving right we see its off side: no doors. Driving left (the near lane), its kerb side: two.
    expect(rects(calls, COMMON.door)).toEqual([]);
    expect(rects(drawn({ ...bus, dir: -1 }), COMMON.door)).toHaveLength(BUS_DOORS.length);
    // Riders are a function of the bus's seed and the window: the same every frame, different between buses.
    expect(BUS_WINDOWS.map((_, k) => busRider(99, k))).toEqual(BUS_WINDOWS.map((_, k) => busRider(99, k)));
    const seats = (seed: number) => BUS_WINDOWS.map((_, k) => busRider(seed, k)).join();
    expect(new Set([1, 2, 3, 4, 5, 6].map(seats)).size).toBeGreaterThan(1);
    // Each passenger sits inside its window (heads and shoulders, never on the pillars).
    const windows = rects(calls, COMMON.glass).filter(([, , w]) => w === 7);
    expect(windows).toHaveLength(BUS_WINDOWS.length);
    for (const [x, y, w, h] of rects(calls, COMMON.rider))
      expect(windows.some(([wx, wy, ww, wh]) => x >= wx && x + w <= wx + ww && y >= wy && y + h <= wy + wh)).toBe(true);
    // No passengers in a car.
    expect(rects(drawn(vehicle()), COMMON.rider)).toEqual([]);
  });

  it("a wet road sprays behind a moving vehicle — not a dry one, nor one standing", () => {
    const spray = (v: VehicleView, wet: boolean) => rects(drawn(v, wet), COMMON.spray);
    expect(spray(vehicle({ speed: 90 }), true)).toHaveLength(3);
    expect(spray(vehicle({ speed: 90 }), false)).toEqual([]);
    expect(spray(vehicle({ speed: SPRAY_SPEED }), true)).toEqual([]);
    // Behind it: left of a car driving right, right of one driving left.
    for (const [x] of spray(vehicle({ speed: 90 }), true)) expect(x).toBeLessThan(1005);
    for (const [x] of spray(vehicle({ speed: 90, dir: -1 }), true)) expect(x).toBeGreaterThan(1033);
    // It flickers with the wheel.
    expect(spray(vehicle({ speed: 90, odo: 0 }), true)).not.toEqual(spray(vehicle({ speed: 90, odo: WHEEL_STEP }), true));
  });
});

describe("paintVehicleLights — the night", () => {
  it("headlamps lit and a beam ahead — a stepped cone, brightest by the lamp, and a pool on the road — never behind", () => {
    for (const dir of [1, -1] as const) {
      const v = vehicle({ dir });
      const calls = lit(v);
      expect(rects(calls, LIGHTS.head)).toEqual([[dir > 0 ? 1036 : 1000, 1988, 2, 2]]);
      for (let k = 0; k < BEAM_SLICES; k++) {
        const slices = rects(calls, BEAM_FADE[k]);
        expect(slices).toHaveLength(2); // the cone's slice and the pool's
        for (const [x, , w] of slices) {
          if (dir > 0) expect(x).toBeGreaterThanOrEqual(v.x + v.w);
          else expect(x + w).toBeLessThanOrEqual(v.x);
        }
        // The cone widens (a px taller above and below per slice) and reaches further out.
        const [cone] = slices;
        expect(cone[3]).toBe(2 + 2 * k);
        expect(Math.abs(cone[0] - (dir > 0 ? 1038 : 1000 - BEAM_STEP))).toBe(BEAM_STEP * k);
      }
      // The pool lies on the road: its bottom on the road line.
      expect(rects(calls, BEAM_FADE[0])[1][1] + 3).toBe(v.y);
    }
    // Brightest by the lamp: the fade only fades.
    const alpha = (c: string) => Number(/, ([\d.]+)\)$/.exec(c)![1]);
    for (let k = 1; k < BEAM_SLICES; k++) expect(alpha(BEAM_FADE[k])).toBeLessThan(alpha(BEAM_FADE[k - 1]));
    expect(BEAM_STEP * BEAM_SLICES + 2).toBeLessThanOrEqual(BEAM);
  });

  it("tail lights glow behind it, round the lamp — wider when braking", () => {
    const calm = lit(vehicle());
    expect(rects(calm, LIGHTS.tail)).toEqual([[1000, 1988, 2, 2]]);
    expect(rects(calm, LIGHTS.tailGlow)).toEqual([[997, 1987, 3, 4]]);
    expect(rects(calm, LIGHTS.brakeGlow)).toEqual([]);
    expect(rects(lit(vehicle({ braking: true })), LIGHTS.brakeGlow)).toEqual([[994, 1986, 6, 6]]);
    expect(rects(lit(vehicle({ dir: -1 })), LIGHTS.tailGlow)).toEqual([[1038, 1987, 3, 4]]);
  });

  it("a taxi's roof lamp is lit, with a glow; a car has none", () => {
    const wagon = lit(vehicle({ kind: "taxi", livery: 0 }));
    expect(rects(wagon, LIGHTS.lamp)).toEqual([[1016, 1977, 6, 2]]);
    expect(rects(wagon, LIGHTS.lampGlow)).toEqual([[1014, 1975, 10, 6]]);
    expect(rects(lit(vehicle()), LIGHTS.lamp)).toEqual([]);
  });

  it("a bus's windows are lit, its passengers dark against them, and its board glows", () => {
    const calls = lit(vehicle({ kind: "bus", seed: 99 }));
    expect(rects(calls, LIGHTS.window)).toHaveLength(BUS_WINDOWS.length);
    expect(rects(calls, LIGHTS.rider)).toHaveLength(2 * BUS_WINDOWS.filter((_, k) => busRider(99, k) !== null).length);
    expect(rects(calls, LIGHTS.board)).toHaveLength(8);
    // Painted after the windows, so they show against them.
    const i = calls.findIndex((c) => c.fillStyle === LIGHTS.rider);
    const j = calls.findIndex((c) => c.fillStyle === LIGHTS.window);
    expect(j).toBeLessThan(i);
    expect(rects(lit(vehicle()), LIGHTS.window)).toEqual([]);
  });

  it("a vehicle off screen lights nothing", () => {
    const ctx = recorder();
    paintVehicleLights(ctx, CAM, { w: 500, h: 500 }, [vehicle()]);
    expect(ctx.calls).toEqual([]);
  });
});

describe("in a frame (render/frame.ts, render/ambience.ts)", () => {
  const floors = (k: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${k}${i}`, label: `${k}${i}`, ide: true }));
  const world = buildCityWorld([{ key: "g", label: "g", team: 2, hasIde: true, floors: floors("g", 1) }], { seats: 16 });
  const street = world.city!.street;
  const amb = (hour: number, weather: WeatherKind = "clear") => computeAmbience(new Date(2026, 9, 26, hour, 0), null, { weather, phase: "auto" });
  const view = { w: world.cols * TILE, h: world.rows * TILE };
  const onRoad = vehicle({ x: 100, y: (street + 2) * TILE });

  function frame(vs: VehicleView[], hour: number, weather: WeatherKind = "clear") {
    const ctx = recorder();
    const items: DrawItem[] = vs.map((v) => ({ t: "vehicle", v }));
    renderFrame(ctx, items, CAM, null, { w: view.w, h: view.h, timeMs: 0, world, ambience: amb(hour, weather), particles: [], flash: 0 });
    return ctx.of("fillRect");
  }

  it("a vehicle on screen is drawn; one off screen is not", () => {
    expect(rects(frame([onRoad], 12), COMMON.tyre).length).toBeGreaterThan(0);
    expect(rects(frame([{ ...onRoad, x: view.w + 50 }], 12), COMMON.tyre)).toEqual([]);
    expect(rects(frame([{ ...onRoad, x: -onRoad.w - 10 }], 12), COMMON.tyre)).toEqual([]);
  });

  it("…and handed to the night-lights pass: lamps on at night, off by day; and only the ones drawn", () => {
    expect(rects(frame([onRoad], 23), LIGHTS.head)).toHaveLength(1);
    expect(rects(frame([onRoad], 12), LIGHTS.head)).toEqual([]);
    // The lights come after the vehicle's own art (they are light on it, after the grade).
    const night = frame([onRoad], 23);
    expect(night.findIndex((c) => c.fillStyle === LIGHTS.head)).toBeGreaterThan(night.findIndex((c) => c.fillStyle === COMMON.head));
    // Just off the view's right edge, its beam would reach in — but it was not drawn, so nothing is lit.
    expect(rects(frame([{ ...onRoad, x: view.w + 5, dir: -1 }], 23), LIGHTS.head)).toEqual([]);
  });

  it("a wet road sprays behind it: in the rain, not on a clear day", () => {
    expect(rects(frame([onRoad], 12, "rain"), COMMON.spray)).toHaveLength(3);
    expect(rects(frame([onRoad], 12, "clear"), COMMON.spray)).toEqual([]);
  });

  it("paintAmbience without vehicles lights none (its default)", () => {
    const ctx = recorder();
    paintAmbience(ctx, amb(23), [], 0, world, CAM, view, 0);
    expect(rects(ctx.of("fillRect"), LIGHTS.head)).toEqual([]);
    const ctx2 = recorder();
    paintAmbience(ctx2, amb(23), [], 0, world, CAM, view, 0, [onRoad]);
    expect(rects(ctx2.of("fillRect"), LIGHTS.head)).toHaveLength(1);
  });
});
