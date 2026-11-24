/**
 * The City's clouds (render/clouds.ts) — a cloudy day used to show only two clouds.
 * The weather sets how much of the sky is covered (a cloudy sky follows the live cloud cover), the
 * clouds fill the whole sky in view — past the world's ends and above its top — world-locked, drifting
 * row by row with the wind, and the work is bounded by the view, never by the world.
 */

import { describe, expect, it } from "vitest";

import { TILE, type WeatherKind } from "../villageTypes";
import { ABOVE, BANK_W, CELL_H, CELL_W, CLOUD_COVER, cloudCover, cloudHeight, cloudIn, cloudUnit, LOW, MIN_BAND, paintClouds, rowDrift } from "./clouds";
import type { Camera } from "./camera";
import { recorder } from "./testRecorder";

const COLOR = { body: "#aaaaaa", under: "#888888" };
/** A reference city: its sky is 976 px tall (the street's top), its world 104 tiles wide. */
const HORIZON = 976;
const WORLD_W = 104 * TILE;
const cam0: Camera = { zoom: 1, ox: 0, oy: 0 };
/** A wide view of the reference sky: past both ends of the world, and above its top. */
const WIDE = { x0: -1600, x1: WORLD_W + 1600, y0: -300, y1: HORIZON };

interface R {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}

function paint(
  weather: WeatherKind,
  o: { intensity?: number; t?: number; wind?: number; cam?: Camera; span?: typeof WIDE; horizon?: number } = {},
): R[] {
  const ctx = recorder();
  paintClouds(ctx, o.cam ?? cam0, o.span ?? WIDE, o.horizon ?? HORIZON, weather, o.intensity ?? 0.6, o.t ?? 0, o.wind ?? 0, COLOR);
  return ctx.of("fillRect").map((c) => ({ x: c.args[0] as number, y: c.args[1] as number, w: c.args[2] as number, h: c.args[3] as number, style: c.fillStyle }));
}
/** One underside per cloud. */
const unders = (rs: R[]) => rs.filter((r) => r.style === COLOR.under);

/** The share of the sky's points (every 8 px over x 0..WORLD_W, from the world's top to the lowest row) under a cloud's body. */
function covered(rs: R[]): number {
  const bodies = rs.filter((r) => r.style === COLOR.body);
  let n = 0;
  let hit = 0;
  for (let y = 0; y < HORIZON - LOW - CELL_H; y += 8)
    for (let x = 0; x < WORLD_W; x += 8) {
      n++;
      if (bodies.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)) hit++;
    }
  return hit / n;
}

describe("how much sky the weather covers", () => {
  it("a cloudy sky follows the live cloud cover (Open-Meteo's cloud_cover): more clouds and wider ones under a fuller cover", () => {
    expect(cloudCover("cloudy", 0)).toEqual({ share: 0.35, scale: 1 });
    expect(cloudCover("cloudy", 1)).toEqual({ share: 0.95, scale: 1.5 });
    expect(cloudCover("cloudy", 0.5).share).toBeCloseTo(0.65, 9);
    expect(cloudCover("cloudy", 0.5).scale).toBeCloseTo(1.25, 9);
    // Out of range or not a number: clamped, or the thinnest cover.
    expect(cloudCover("cloudy", 3)).toEqual(cloudCover("cloudy", 1));
    expect(cloudCover("cloudy", -1)).toEqual(cloudCover("cloudy", 0));
    expect(cloudCover("cloudy", Number.NaN)).toEqual(cloudCover("cloudy", 0));
    // Every other weather's cover is fixed — its intensity is rain or snow, not cloud.
    for (const w of ["clear", "fog", "drizzle", "rain", "snow", "storm"] as const) {
      expect(cloudCover(w, 0)).toEqual(cloudCover(w, 1));
      expect(cloudCover(w, 1).scale).toBe(1);
    }
  });

  it("a clear sky keeps a few small fair clouds, a cloudy one is mostly cloud, fog has none", () => {
    const clear = paint("clear");
    const partly = paint("cloudy", { intensity: 0.2 });
    const overcast = paint("cloudy", { intensity: 1 });
    expect(paint("fog")).toEqual([]);
    expect(unders(clear).length).toBeGreaterThan(0);
    expect(unders(partly).length).toBeGreaterThan(3 * unders(clear).length);
    expect(unders(overcast).length).toBeGreaterThan(unders(partly).length);
    // Measured on the reference sky: clear under 1 %, partly cloudy (a 20 % cover) 17 %, overcast 61 %.
    expect(covered(clear)).toBeLessThan(0.06);
    expect(covered(partly)).toBeGreaterThan(0.12);
    expect(covered(overcast)).toBeGreaterThan(0.45);
    expect(covered(overcast)).toBeGreaterThan(covered(partly) + 0.15);
    // The two a cloudy afternoon used to show were the whole of it; now the world's width holds dozens.
    expect(unders(paint("cloudy", { span: { x0: 0, x1: WORLD_W, y0: 0, y1: HORIZON } })).length).toBeGreaterThan(20);
    // Rain, snow and storm skies are at least as heavy as an ordinary cloudy one (measured:
    // drizzle and snow 42 %, rain 55 %, storm 65 %; a cloudy sky with no live reading 35 %).
    const plain = covered(paint("cloudy"));
    for (const w of ["drizzle", "rain", "snow", "storm"] as const) expect(covered(paint(w))).toBeGreaterThan(plain);
    expect(covered(paint("rain"))).toBeGreaterThan(0.45);
    expect(covered(paint("storm"))).toBeGreaterThan(0.55);
  });

  it("gives each weather its shade (the colours are the sky's — render/city.ts picks them by this)", () => {
    expect(CLOUD_COVER.clear.shade).toBe("light");
    expect(CLOUD_COVER.cloudy.shade).toBe("grey");
    expect(CLOUD_COVER.rain.shade).toBe("dark");
    expect(CLOUD_COVER.storm.shade).toBe("storm");
  });
});

describe("the field — the whole sky in view, and only what is in view", () => {
  it("fills the sky past the world's ends and above its top, never below the horizon", () => {
    const rs = paint("cloudy", { intensity: 1 });
    expect(rs.some((r) => r.x + r.w < 0)).toBe(true);
    expect(rs.some((r) => r.x > WORLD_W)).toBe(true);
    expect(rs.some((r) => r.y < 0)).toBe(true);
    expect(rs.every((r) => r.y + r.h <= HORIZON)).toBe(true);
    // It runs on ABOVE over the world's top (a row's height more at most): beyond that the sky is plain.
    expect(rs.every((r) => r.y >= -ABOVE - CELL_H)).toBe(true);
    expect(paint("cloudy", { intensity: 1, span: { x0: 0, x1: WORLD_W, y0: -3000, y1: -ABOVE - 2 * CELL_H } })).toEqual([]);
  });

  it("is MIN_BAND tall at least, so a low city's tall view is not bare above its small sky", () => {
    const low = 20 * TILE;
    const rs = paint("cloudy", { intensity: 1, horizon: low, span: { x0: 0, x1: 1600, y0: -800, y1: low } });
    expect(Math.min(...rs.map((r) => r.y))).toBeLessThan(low - LOW - MIN_BAND + 2 * CELL_H);
  });

  it("draws only the clouds that reach into the view, and their number is bounded by the view's size", () => {
    const span = { x0: 300, x1: 1100, y0: 200, y1: 700 };
    const rs = paint("storm", { span });
    const bases = rs.filter((r) => r.style === COLOR.body && unders(rs).some((u) => u.x === r.x + 1 && u.w === r.w - 2));
    expect(bases.length).toBe(unders(rs).length);
    for (const b of bases) expect(b.x < span.x1 && b.x + b.w > span.x0).toBe(true);
    // At most one cloud per cell: the cells across the view (and a cloud's width either side) × the rows it reaches.
    const cols = Math.ceil((span.x1 - span.x0) / CELL_W) + 3;
    const rows = Math.ceil((span.y1 - span.y0) / CELL_H) + 4;
    expect(unders(rs).length).toBeLessThanOrEqual(cols * rows);
    // A whole sky's worth of view is still only its own cells: the world's width does not enter into it.
    expect(paint("storm", { span: { x0: 0, x1: 400, y0: 0, y1: HORIZON } }).length).toBeLessThan(paint("storm", { span: { x0: 0, x1: 4000, y0: 0, y1: HORIZON } }).length);
  });

  it("is world-locked: a pan moves every cloud by exactly the pan, a zoom scales it about the camera", () => {
    const span = { x0: 0, x1: 900, y0: 100, y1: 900 };
    const at = paint("cloudy", { span });
    const panned = paint("cloudy", { span, cam: { zoom: 1, ox: -250, oy: 40 } });
    expect(panned).toEqual(at.map((r) => ({ ...r, x: r.x - 250, y: r.y + 40 })));
    const zoomed = paint("cloudy", { span, cam: { zoom: 2, ox: 0, oy: 0 } });
    expect(zoomed.map((r) => [r.x, r.y])).toEqual(at.map((r) => [2 * r.x, 2 * r.y]));
  });
});

describe("the drift — row by row, the wind's way", () => {
  it("moves each row 2–4 world px a second, rows at their own speeds, leftward in a west-going wind", () => {
    const speeds = Array.from({ length: 13 }, (_, r) => rowDrift(r, 1000, 0.3));
    for (const s of speeds) expect([2, 3, 4]).toContain(s);
    expect(new Set(speeds).size).toBeGreaterThan(1);
    for (let r = 0; r < 13; r++) {
      expect(rowDrift(r, 10_000, -0.4)).toBe(-rowDrift(r, 10_000, 0.4));
      expect(rowDrift(r, 0, 1)).toBe(0);
    }
  });

  it("carries the painted clouds with it: ten seconds on, each has moved 20–40 px, to the right in an east-going wind", () => {
    const span = { x0: -400, x1: 2400, y0: 0, y1: HORIZON };
    const key = (r: R) => `${r.y}:${r.w}`;
    const shifts = (wind: number) => {
      const a = unders(paint("cloudy", { span, wind }));
      const b = unders(paint("cloudy", { span, wind, t: 10_000 }));
      const once = (rs: R[]) => new Map(rs.filter((r) => rs.filter((s) => key(s) === key(r)).length === 1).map((r) => [key(r), r.x]));
      const [ma, mb] = [once(a), once(b)];
      return [...ma].filter(([k, x]) => mb.has(k) && x > 0 && x < 2000).map(([k, x]) => mb.get(k)! - x);
    };
    const east = shifts(0.5);
    expect(east.length).toBeGreaterThan(10);
    for (const d of east) expect(d >= 19 && d <= 41).toBe(true);
    for (const d of shifts(-0.5)) expect(d >= -41 && d <= -19).toBe(true);
  });
});

describe("a cloud", () => {
  it("is deterministic per cell, its width in the weather's range (grown with the cover), in its cell", () => {
    const cover = cloudCover("cloudy", 1);
    let some = 0;
    for (let k = -20; k < 20; k++)
      for (let r = 0; r < 12; r++) {
        const c = cloudIn(k, r, "cloudy", cover);
        expect(cloudIn(k, r, "cloudy", cover)).toEqual(c);
        if (!c) continue;
        some++;
        expect(c.w).toBeGreaterThanOrEqual(Math.round(8 * TILE * 1.5));
        expect(c.w).toBeLessThanOrEqual(Math.round(18 * TILE * 1.5));
        expect(c.dx).toBeGreaterThanOrEqual(k * CELL_W);
        expect(c.dx).toBeLessThan((k + 1) * CELL_W);
        expect(c.dy).toBeGreaterThanOrEqual(0);
        expect(c.dy).toBeLessThan(CELL_H / 2);
      }
    expect(some).toBeGreaterThan(0.85 * 40 * 12);
    // No cell holds one at a share of 0; every cell does at 1.
    for (let k = 0; k < 50; k++) {
      expect(cloudIn(k, 3, "cloudy", { share: 0, scale: 1 })).toBeNull();
      expect(cloudIn(k, 3, "cloudy", { share: 1, scale: 1 })).not.toBeNull();
    }
  });

  it("small and fair is the City's old 10-px cloud: a base, two puffs, its underside", () => {
    expect(cloudUnit(3 * TILE)).toBe(2);
    expect(cloudHeight(3 * TILE)).toBe(10);
    const rs = paint("clear", { span: { x0: -4000, x1: 8000, y0: -300, y1: HORIZON } });
    const u = unders(rs)[0];
    const i = rs.indexOf(u);
    const [base, puff, puff2] = rs.slice(i - 3, i);
    const x = base.x;
    const w = base.w;
    expect(w).toBeLessThan(BANK_W);
    const y = puff.y;
    expect([base.y, base.h]).toEqual([y + 4, 6]);
    expect([puff.x, puff.w, puff.h]).toEqual([x + Math.round(w * 0.15), Math.round(w * 0.45), 6]);
    expect([puff2.x, puff2.y, puff2.w, puff2.h]).toEqual([x + Math.round(w * 0.5), y + 1, Math.round(w * 0.35), 5]);
    expect([u.x, u.y, u.w, u.h]).toEqual([x + 1, y + 8, w - 2, 2]);
  });

  it("wide is a BANK: taller with its width, a crown over its puffs", () => {
    expect(cloudUnit(12 * TILE)).toBe(8);
    expect(cloudHeight(12 * TILE)).toBe(48);
    const rs = paint("cloudy", { intensity: 0 });
    const u = unders(rs).find((r) => r.w + 2 >= BANK_W)!;
    const i = rs.indexOf(u);
    const [crown, base] = rs.slice(i - 4, i - 2);
    const w = base.w;
    const unit = cloudUnit(w);
    expect(crown.x).toBe(base.x + Math.round(w * 0.25));
    expect(crown.h).toBe(2 * unit);
    // From the crown's top to the underside's bottom: the cloud's height.
    expect(u.y + u.h - crown.y).toBe(cloudHeight(w));
  });
});
