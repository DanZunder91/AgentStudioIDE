/**
 * The City's apartments (render/backdropApartments.ts) — buildings behind the open stretches of sky
 * between the neon clusters, with randomly lit windows like occupied and vacant apartments, because
 * otherwise the city looks unfinished.
 *
 * The layout — every quiet stretch filled edge to edge, nothing outside one, world-locked, as tall as the
 * haze's top and no taller than a share of the sky, never two danchi side by side, never over a crown, no
 * taller than the haze in front of a tower's foot (a sweep of cities); the day pass — hazed DAY colours,
 * veiled at night, a raster a building at a whole zoom and rects below, the face `faceAt` reports exactly
 * what is painted and opaque under it; and the night pass — every light through `fillLit`, none at noon,
 * a quarter of the homes vacant and never lit, each window at its own fixed threshold, TVs flickering by
 * the clock, nothing lit in a temple's box or off the view.
 *
 * A recording fake stands in for the canvas (jsdom has none), and a fake OffscreenCanvas for the rasters:
 * fills are rastered here into world pixels at zoom 1. Expectations are written by hand:
 * sizes from the design, never read back off the painter under test. Real pixels are
 * backdropApartments.browser.test.tsx's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { citySky } from "../engine/ambience";
import type { CityPlan } from "../engine/city";
import { TILE, type Ambience, type DayPhase, type VillageAgent, type WeatherKind, type World } from "../villageTypes";
import { AIR_CHUNK, airSpans, citySpan, quietSpans, roofLimit, type BackdropLightScene, type BackdropScene } from "./backdrop";
import {
  AERIAL,
  APARTMENT_DAY,
  APARTMENT_LIT,
  APARTMENTS,
  apartmentsIn,
  HAZE,
  KINDS,
  LIGHT_SEEN,
  MAX_RASTERS,
  NIGHT,
  PAD,
  RISE,
  SLIVER,
  seenThrough,
  STOREY,
  tvGlow,
  VACANT,
  VEIL,
  WEATHER_MIX,
  type Apartment,
} from "./backdropApartments";
import type { Box } from "./backdropLights";
import type { Camera } from "./camera";
import { landmarksFor, placeLandmarks } from "./landmarks";
import { skylineMax } from "./skyline";
import { recorder, type RecordingTarget } from "./testRecorder";

// The contract's stretches of open sky, counted (the face is a lookup: once laid out, it looks none up again),
// and its crowns' limit, which one test lowers over buildings of its choosing (the real one by default).
vi.mock("./backdrop", async (orig) => {
  const real = await orig<typeof import("./backdrop")>();
  return { ...real, airSpans: vi.fn(real.airSpans), roofLimit: vi.fn(real.roofLimit) };
});

// ───────────────────────────── cities, skies, scenes ─────────────────────────────

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
/** The reference city: a seven-floor gazelle, the HQ, Agent Studio, payments and website (a sky of 960 px). */
const reference = buildCityWorld(
  planCity([
    ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
    ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
    agentOf("a0", "Agent Studio", { language: "typescript" }),
    agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
    agentOf("p0", "payments", { language: "python" }),
    agentOf("w0", "website", { language: "typescript" }),
  ]).plans,
  { seats: 64 },
);
const plan = (i: number, floors: number, team = 2): CityPlan => ({
  key: `p${i}`,
  label: `p${i}`,
  team,
  hasIde: true,
  floors: Array.from({ length: floors }, (_, f) => ({ key: `floor:${i}:${f}`, label: `a${i}.${f}`, ide: true })),
});
/** A city of projects of `floors` floors each, beside the capacity HQ. */
const city = (floors: number[], team = 2, seats?: number): World => buildCityWorld(floors.map((f, i) => plan(i, f, i === 0 ? team : 2)), seats ? { seats } : undefined);
/** The lowest city there is: the HQ and two one-floor projects. */
const low = city([1, 1]);
/**
 * Cities of 1–12 floors, narrow and wide, with the lounge and without — among them low ones where a tower's
 * crown comes down to an older block's roof, leaving no room for its tank (found by a search of cities).
 */
const SWEEP: World[] = [reference, low, city([1, 1], 26, 64), city([1, 1], 9, 64), city([10, 1]), city([1], 26, 16), city([1, 1], 4, 16), city([1, 1], 6, 16), city([1, 1], 18, 16), city([1], 13), city([1, 1, 1, 1], 9, 16)];
for (const floors of [[1], [3], [6], [12], [2, 5], [9, 1], [4, 4, 4], [12, 1, 7], [1, 1, 1, 1]])
  for (const team of [2, 26]) SWEEP.push(city(floors, team, 64), city(floors, team));

/** The reference city built afresh: the same layout, none of its rasters made yet. */
const fresh = (): World =>
  buildCityWorld(
    planCity([
      ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
      ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
      agentOf("a0", "Agent Studio", { language: "typescript" }),
      agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
      agentOf("p0", "payments", { language: "python" }),
      agentOf("w0", "website", { language: "typescript" }),
    ]).plans,
    { seats: 64 },
  );

const horizonOf = (w: World): number => w.city!.street * TILE;
const H = horizonOf(reference);

/** The sky in `phase` and `weather`, in Tokyo unless `zone` says otherwise. */
const sky = (phase: DayPhase, weather: WeatherKind = "clear", zone = "Asia/Tokyo"): Ambience =>
  computeAmbience(new Date(2026, 9, 27, 15, 0), null, { weather, phase }, zone);
const noon = sky("noon");
const night = sky("night");

/** Fit at 1280×800 @2x: zoom 1, the view x −448 … 2112, the whole sky. */
const FIT: Camera = { zoom: 1, ox: 448, oy: 0 };
const VIEW = { w: 2560, h: 1600 };

type Scene = BackdropScene & { ctx: RecordingTarget };

/** The day pass's scene for `cam` over `view`, as render/city.ts builds it. */
function sceneOf(world: World, amb: Ambience | undefined, cam: Camera = FIT, view = VIEW, timeMs = 0): Scene {
  const ox = Math.round(cam.ox);
  return { ctx: recorder(), cam, world, view, amb, horizon: horizonOf(world), timeMs, x0: -ox / cam.zoom, x1: (view.w - ox) / cam.zoom };
}

interface Lit {
  x: number;
  y: number;
  w: number;
  h: number;
  style: unknown;
  alpha: number;
}

/** The night pass's scene: its `fillLit` records each light, with the style and alpha it was given. */
function lightScene(world: World, amb: Ambience, lit: number, cam: Camera = FIT, view = VIEW, timeMs = 0): BackdropLightScene & { ctx: RecordingTarget; lights: Lit[] } {
  const s = sceneOf(world, amb, cam, view, timeMs);
  const lights: Lit[] = [];
  return {
    ...s,
    amb,
    dark: Math.min(1, Math.max(0, (0.6 - amb.daylight) / 0.45)),
    lit,
    lights,
    fillLit: (x, y, w, h) => lights.push({ x, y, w, h, style: s.ctx.fillStyle, alpha: s.ctx.globalAlpha }),
    hidden: () => false,
  };
}

/**
 * The quiet stretches of [x0, x1) chained as the apartments lay them out: two less than 48 px apart are one
 * (no canyon building fits between them).
 */
function chained(world: World, x0: number, x1: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of quietSpans(world, x0, x1)) {
    const last = out[out.length - 1];
    if (last && a - last[1] < 48) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}
/** The chained quiet stretches of `world` over a span far wider than any view. */
const quietOf = (world: World): [number, number][] => chained(world, -4000, world.cols * TILE + 4000);
/** Every building over the quiet stretches of [-3000, width + 3000). */
const allOf = (world: World, amb: Ambience | undefined = noon): Apartment[] => apartmentsIn(world, amb, horizonOf(world), -3000, world.cols * TILE + 3000);
/** The reference city's street far along both ways: hundreds of stretches of sky, no landmark over any. */
const STREET = apartmentsIn(reference, sky("noon", "clear", "UTC"), H, -60_000, 60_000);
/** Is world column x inside a quiet stretch, padded `PAD` either side? */
const inPadded = (world: World, x: number): boolean => quietOf(world).some(([a, b]) => x >= a - 2 && x < b + 2);
/** The world's buildings as [x0, x1, top]: what stands in front of every apartment. */
const wallsOf = (w: World) => w.city!.buildings.map((b) => [b.col * TILE, (b.col + b.w) * TILE, b.row * TILE] as const);
const behindWall = (w: World, x: number, y: number) => wallsOf(w).some(([a, b, top]) => x >= a && x < b && y >= top);

// ───────────────────────────── a fake raster host ─────────────────────────────

interface FakePattern {
  raster: FakeRaster;
  transform: DOMMatrix2DInit | null;
  setTransform(t: DOMMatrix2DInit): void;
}

/** An OffscreenCanvas standing in for the browser's: a recording context that can make a pattern. */
class FakeRaster {
  static made: FakeRaster[] = [];
  readonly ctx: RecordingTarget & { createPattern(image: unknown, repeat: string): FakePattern };
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ctx = Object.assign(recorder(), {
      createPattern: (_image: unknown, repeat: string): FakePattern => {
        expect(repeat).toBe("no-repeat");
        return {
          raster: this,
          transform: null,
          setTransform(t) {
            this.transform = t;
          },
        };
      },
    });
    FakeRaster.made.push(this);
  }
  getContext(): RecordingTarget {
    return this.ctx;
  }
}

/** No canvas host at all, as jsdom has none of its own. */
function noCanvas(): void {
  vi.stubGlobal("OffscreenCanvas", undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

beforeEach(() => {
  FakeRaster.made = [];
  vi.stubGlobal("OffscreenCanvas", FakeRaster);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** The raster's fills since its last clear (a raster painted again is cleared first). */
function rasterFills(r: FakeRaster): Fill[] {
  const calls = r.ctx.calls;
  const from = calls.map((c) => c.op).lastIndexOf("clearRect") + 1;
  return calls.slice(from).flatMap((c) => (c.op === "fillRect" ? [{ x: c.args[0] as number, y: c.args[1] as number, w: c.args[2] as number, h: c.args[3] as number, color: c.fillStyle }] : []));
}

/** What a day pass painted, as WORLD rects (zoom 1): its own fills, and each raster it blitted laid out where it landed. */
function painting(s: Scene): Fill[] {
  const { cam } = s;
  const ox = Math.round(cam.ox);
  const oy = Math.round(cam.oy);
  return s.ctx.calls.flatMap((c) => {
    if (c.op === "fillRect") {
      const [x, y, w, h] = c.args as number[];
      return [{ x: (x - ox) / cam.zoom, y: (y - oy) / cam.zoom, w: w / cam.zoom, h: h / cam.zoom, color: c.fillStyle }];
    }
    if (c.op !== "drawImage") return [];
    const [image, , , sw, , dx, dy, dw] = c.args as [FakeRaster, number, number, number, number, number, number, number];
    expect(dw / sw).toBe(cam.zoom);
    return rasterFills(image).map((f) => ({ ...f, x: f.x + (dx - ox) / cam.zoom, y: f.y + (dy - oy) / cam.zoom }));
  });
}

/** World pixels painted (of world columns [x0, x1) only, when given: a view's), last fill wins: "x,y" → colour. */
function pixels(fills: Fill[], x0 = -Infinity, x1 = Infinity): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fills)
    for (let y = f.y; y < f.y + f.h; y++) for (let x = Math.max(f.x, x0); x < Math.min(f.x + f.w, x1); x++) out.set(`${x},${y}`, f.color);
  return out;
}

/** Two pixel maps are the same — compared key by key (a failing `toEqual` on a map of 100k pixels takes minutes to diff). */
function expectSame(a: Map<string, string>, b: Map<string, string>): void {
  const differ = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  expect(differ.slice(0, 5).map((k) => `${k}: ${a.get(k)} ≠ ${b.get(k)}`)).toEqual([]);
}

/** The world rects a night pass lit through its light rasters (each fill of a pattern laid out at its transform) and directly (the TVs). */
function litRects(s: ReturnType<typeof lightScene>): Fill[] {
  const ox = Math.round(s.cam.ox);
  const oy = Math.round(s.cam.oy);
  return s.lights.flatMap((l) => {
    const p = l.style as FakePattern | string;
    if (typeof p === "string") return [{ x: l.x, y: l.y, w: l.w, h: l.h, color: p }];
    const t = p.transform as DOMMatrix2DInit;
    const bx = ((t.e as number) - ox) / s.cam.zoom;
    const by = ((t.f as number) - oy) / s.cam.zoom;
    // What of the raster's fills the light's rect lets through.
    return rasterFills(p.raster).flatMap((f) => {
      const x0 = Math.max(f.x + bx, l.x);
      const x1 = Math.min(f.x + bx + f.w, l.x + l.w);
      const y0 = Math.max(f.y + by, l.y);
      const y1 = Math.min(f.y + by + f.h, l.y + l.h);
      return x1 > x0 && y1 > y0 ? [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0, color: f.color }] : [];
    });
  });
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: readonly number[]) =>
  a.x < b[0] + b[2] && b[0] < a.x + a.w && a.y < b[1] + b[3] && b[1] < a.y + a.h;

// ───────────────────────────── the layout ─────────────────────────────

describe("the apartments' layout", () => {
  it("fills every quiet stretch edge to edge — shoulder to shoulder from 2 px before it to 2 px past it, two less than 48 px apart as one — and stands nowhere else", () => {
    expect(PAD).toBe(2);
    for (const world of SWEEP) {
      const quiet = quietOf(world).filter(([a, b]) => a > -3000 && b < world.cols * TILE + 3000);
      const all = allOf(world);
      for (const [a, b] of quiet) {
        const row = all.filter((p) => p.x >= a - 2 && p.x + p.w <= b + 2);
        expect(row[0].x, `${a}`).toBe(a - 2);
        for (let i = 1; i < row.length; i++) expect(row[i].x).toBe(row[i - 1].x + row[i - 1].w);
        expect(row[row.length - 1].x + row[row.length - 1].w).toBe(b + 2);
      }
      // …and every building is in one of them; and its face stands over every column of them, whatever is asked.
      for (const p of all) expect(quietOf(world).some(([a, b]) => p.x >= a - 2 && p.x + p.w <= b + 2), `${p.x}`).toBe(true);
      const t = sceneOf(world, noon);
      for (const [a, b] of quiet) for (let x = a; x < b; x++) expect(APARTMENTS.faceAt(t, x), `${x}`).toBeLessThan(horizonOf(world));
    }
  });

  it("covers the city's span from wall to wall, merged with the open sky it touches — and on over the 17 px to the next stretch of sky — however little of it is asked about", () => {
    const [a, b] = citySpan(reference)!;
    // The reference city: gazelle's left wall at 48, website's right wall at 1568, and a stretch of sky [1, 68)
    // merged in; the next stretch of sky starts 17 px on, at 1585, and runs to 1671: one row from 1 to 1671.
    expect([a, b]).toEqual([48, 1568]);
    expect(quietSpans(reference, 0, 1700)).toEqual([
      [1, 1568],
      [1585, 1671],
    ]);
    const row = apartmentsIn(reference, noon, H, 600, 601);
    expect(row[0].x).toBe(1 - 2);
    expect(row[row.length - 1].x + row[row.length - 1].w).toBe(1671 + 2);
    // Asked about its last column, its first, or the sliver between, it is the same row.
    for (const [x0, x1] of [
      [1672, 1673],
      [1, 2],
      [1570, 1580],
    ])
      expect(apartmentsIn(reference, noon, H, x0, x1)).toEqual(row);
    // A city's span from 224 whose air chunk (0) has its stretch of sky far to the left, at [1, 68): asked about
    // one column of it there, it is still the city's row.
    const other = city([1, 1, 1, 1], 9, 16);
    expect(quietSpans(other, 0, 288)).toEqual([
      [1, 68],
      [224, 1576],
    ]);
    expect(apartmentsIn(other, noon, horizonOf(other), 230, 231).some((p) => p.x <= 230 && p.x + p.w > 230)).toBe(true);
  });

  it("is world-locked: a building is the same whatever span is asked about, in a world built afresh too", () => {
    const summary = (p: Apartment) => [p.kind, p.x, p.w, p.floors, p.roof, p.tone, p.parts, p.homes.map((h) => h.vacant)];
    const wide = allOf(reference).map(summary);
    for (const [x0, x1] of [
      [-500, -400],
      [0, 50],
      [700, 1300],
      [1580, 1700],
      [1900, 2300],
    ]) {
      const here = apartmentsIn(reference, noon, H, x0, x1).map(summary);
      expect(here.length).toBeGreaterThan(0);
      for (const p of here) expect(wide).toContainEqual(p);
    }
    expect(allOf(fresh()).map(summary)).toEqual(wide);
  });

  it("rises to the haze's top and no higher than 1.45× it, never into a third of the sky: 11–15 storeys of 13 px in the reference city", () => {
    expect([STOREY, RISE]).toEqual([13, 1.45]);
    // The reference city's haze tops out at 144 px (0.15 of a 960-px sky): 11 storeys and the parapet (145 px) reach it,
    // and 1.45 × 144 = 209 px allows 15 (197 px).
    expect(skylineMax(H)).toBe(144);
    const seen = new Set<number>();
    for (const p of allOf(reference)) {
      expect(p.roof).toBe(H - p.floors * 13 - 2);
      expect(p.floors).toBeGreaterThanOrEqual(11);
      expect(p.floors).toBeLessThanOrEqual(15);
      seen.add(p.floors);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15]);
    // In every city: at least the haze's top (unless a crown lowers it), at most 1.45× it (or the storey that
    // reaches it) — and nothing it stands, tank or mast, past 0.35 of the sky (less a tile): the sky open above.
    for (const world of SWEEP) {
      const h = horizonOf(world);
      const least = skylineMax(h);
      const most = Math.max(least + 12, Math.round(1.45 * least));
      for (const p of allOf(world)) {
        const limit = roofLimit(world, noon, h, p.x, p.x + p.w, ["far", "tower"]);
        if (limit === -Infinity) expect(h - p.roof).toBeGreaterThanOrEqual(least);
        expect(h - p.roof).toBeLessThanOrEqual(most);
        for (const [, , top] of p.parts) expect(h - top).toBeLessThanOrEqual(0.35 * (h - TILE));
      }
    }
  });

  it("is the three kinds — danchi 76–136 px long, mansions 36–62, older blocks 28–44, the last of a row taking up to 27 px more — never two danchi side by side, far along the street too", () => {
    expect(KINDS).toEqual(["danchi", "mansion", "older"]);
    const widths: Record<string, [number, number]> = { danchi: [76, 136], mansion: [36, 62], older: [28, 44] };
    const seen: Record<string, Set<number>> = { danchi: new Set(), mansion: new Set(), older: new Set() };
    for (const all of [...SWEEP.map((w) => allOf(w)), STREET]) {
      for (let i = 0; i < all.length; i++) {
        const p = all[i];
        const next = all[i + 1];
        const last = !next || next.x !== p.x + p.w;
        if (!last) expect([p.kind, next.kind], `${p.x}`).not.toEqual(["danchi", "danchi"]);
        const [lo, hi] = widths[p.kind];
        expect(p.w, `${p.kind} at ${p.x}`).toBeGreaterThanOrEqual(lo);
        expect(p.w, `${p.kind} at ${p.x}`).toBeLessThanOrEqual(last ? hi + 27 : hi);
        if (!last) seen[p.kind].add(p.w);
      }
    }
    // Every kind in many widths, by its hash.
    for (const k of KINDS) expect(seen[k].size, k).toBeGreaterThan(12);
    const kinds = allOf(reference).map((p) => p.kind);
    for (const k of KINDS) expect(kinds).toContain(k);
  });

  it("wears its kind's tones — every one of them along the street", () => {
    for (const k of KINDS) {
      const tones = new Set(STREET.filter((p) => p.kind === k).map((p) => p.tone));
      expect([...tones].sort((a, b) => a.wall.localeCompare(b.wall))).toEqual([...APARTMENT_DAY[k]].sort((a, b) => a.wall.localeCompare(b.wall)));
    }
  });

  it("stands on its roof only what its kind does: a danchi's core (8 px wide, 10 over the roof) and maybe a tank (12 wide, 8 over); a mansion's machine room (16, 8 over) or mast (1, 9 over); an older block's tank (≤ 12, 8 over) or mast (1, 10 over)", () => {
    const allowed: Record<string, string[]> = { danchi: ["8×10", "12×8"], mansion: ["16×8", "1×9"], older: ["12×8", "1×10"] };
    const seen = new Set<string>();
    for (const p of STREET) {
      expect(p.parts[0]).toEqual([p.x, p.x + p.w, p.roof]);
      for (const [a, b, top] of p.parts.slice(1)) {
        const part = `${b - a}×${p.roof - top}`;
        expect(allowed[p.kind], `${p.kind} at ${p.x}`).toContain(part);
        expect(a).toBeGreaterThanOrEqual(p.x);
        expect(b).toBeLessThanOrEqual(p.x + p.w);
        seen.add(`${p.kind} ${part}`);
      }
      if (p.kind === "danchi") expect(p.parts[1][1] - p.parts[1][0]).toBe(8);
    }
    expect(seen.size).toBe(6);
  });

  it("lays its homes out storey by storey across its face: a danchi's kitchen windows 5×4, a mansion's two rooms 6 px tall wall to wall, an older block's windows 4 px tall in bays of about 10, 4 px of tile apart", () => {
    for (const p of STREET) {
      const storeyOf = (y: number) => Math.floor((y - p.roof - 2) / 13);
      const rows = new Map<number, Box[]>();
      for (const h of p.homes) {
        expect(new Set(h.windows.map((w) => storeyOf(w[1]))).size).toBe(1);
        for (const w of h.windows) rows.set(storeyOf(w[1]), [...(rows.get(storeyOf(w[1])) ?? []), w]);
      }
      expect(rows.size).toBe(p.floors);
      for (const [s, wins] of rows) {
        const y = p.roof + 2 + s * 13;
        wins.sort((a, b) => a[0] - b[0]);
        if (p.kind === "danchi") {
          expect(p.homes.every((h) => h.windows.length === 1)).toBe(true);
          expect(wins.length).toBe(Math.round((p.w - 4) / 26));
          expect(wins[0][0]).toBe(p.x + 2 + 10);
          for (const w of wins) expect([w[1] - y, w[2], w[3]]).toEqual([1, 5, 4]);
        } else if (p.kind === "mansion") {
          expect(p.homes.every((h) => h.windows.length === 2)).toBe(true);
          expect(wins[0][0]).toBe(p.x + 4);
          expect(wins[wins.length - 1][0] + wins[wins.length - 1][2]).toBe(p.x + p.w - 3);
          for (let i = 1; i < wins.length; i++) expect(wins[i][0]).toBe(wins[i - 1][0] + wins[i - 1][2] + 1);
          for (const w of wins) expect([w[1] - y, w[3]]).toEqual([2, 6]);
        } else {
          expect(wins[0][0]).toBe(p.x + 5);
          expect(wins[wins.length - 1][0] + wins[wins.length - 1][2]).toBe(p.x + p.w - 5);
          for (let i = 1; i < wins.length; i++) expect(wins[i][0]).toBe(wins[i - 1][0] + wins[i - 1][2] + 4);
          for (const w of wins) {
            expect([w[1] - y, w[3]]).toEqual([4, 4]);
            expect(w[2]).toBeGreaterThanOrEqual(4);
            expect(w[2]).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });

  it("stands no taller than the haze in front of a tower's foot (Tokyo Tower, the Skytree): their legs are no more hidden than the haze hides them elsewhere", () => {
    const feet = placeLandmarks(reference, H, landmarksFor("Asia/Tokyo"))
      .placed.filter((p) => p.spec.layer === "tower")
      .map((p) => [p.x - p.hw, p.x + p.hw + 1]);
    expect(feet.length).toBe(2);
    let n = 0;
    for (const p of allOf(reference))
      if (feet.some(([a, b]) => a < p.x + p.w && b > p.x)) {
        expect(p.floors).toBe(11);
        n++;
      }
    expect(n).toBeGreaterThanOrEqual(3);
    // In a zone with no landmarks, nothing is held down.
    expect(allOf(reference, sky("noon", "clear", "UTC")).some((p) => p.floors > 11 && feet.some(([a, b]) => a < p.x + p.w && b > p.x))).toBe(true);
  });

  it("never covers a crown: nothing it stands — roof, core, tank, machine room, mast — rises past `roofLimit` over its building (a sweep of cities)", () => {
    let lowered = 0;
    for (const world of SWEEP) {
      const h = horizonOf(world);
      for (const p of allOf(world)) {
        const limit = roofLimit(world, noon, h, p.x, p.x + p.w, ["far", "tower"]);
        for (const [, , top] of p.parts) expect(top, `${p.x}`).toBeGreaterThanOrEqual(limit);
        if (limit > -Infinity && limit > h - skylineMax(h) * RISE) lowered++;
      }
    }
    // Some buildings did stand under a crown low enough to lower them.
    expect(lowered).toBeGreaterThan(0);
  });

  it("is found by any column of a row asked about — its first building by its first column, its last by its last, across an air chunk's edge too", () => {
    const rows = chained(reference, -60_000, 60_000).slice(1, -1);
    for (const [a, b] of rows) {
      expect(apartmentsIn(reference, noon, H, a - 2, a - 1)[0]?.x, `${a}`).toBe(a - 2);
      const end = apartmentsIn(reference, noon, H, b + 1, b + 2);
      expect(end.some((p) => p.x + p.w === b + 2), `${b}`).toBe(true);
    }
    // A stretch whose padding reaches over its chunk's end into the next: asked about the next chunk's first column, it is there.
    let edges = 0;
    for (const [, b] of rows)
      if (Math.floor((b + 1) / AIR_CHUNK) > Math.floor((b - 1) / AIR_CHUNK)) {
        const c = Math.floor((b + 1) / AIR_CHUNK) * AIR_CHUNK;
        expect(apartmentsIn(reference, noon, H, c, c + 1).some((p) => p.x + p.w === b + 2)).toBe(true);
        edges++;
      }
    expect(edges).toBeGreaterThan(0);
  });

  it("in a world with no buildings has no city's stretch — only the open sky's", () => {
    const bare: World = { ...reference, city: { ...reference.city!, buildings: [] } };
    expect(citySpan(bare)).toBeNull();
    const all = apartmentsIn(bare, noon, H, -600, 2200);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) expect(airSpans(p.x + 2, p.x + p.w - 2).length).toBe(1);
    expect(APARTMENTS.faceAt(sceneOf(bare, noon), 600)).toBe(H);
  });

  it("under a crown just over its roof gives up everything it stands there — core, tank, machine room, mast — of every kind (a crown placed by hand)", async () => {
    const actual = await vi.importActual<typeof import("./backdrop")>("./backdrop");
    const utc = sky("noon", "clear", "UTC");
    // Far along the street, a building of each kind with what it stands on its roof.
    const far = apartmentsIn(fresh(), utc, H, 20_000, 60_000).filter((p) => p.parts.length > 1);
    const picks = KINDS.map((k) => far.find((p) => p.kind === k && (k !== "older" || p.parts.some(([, , t]) => p.roof - t === 8)))!);
    for (const p of picks) expect(p, "a building of each kind with something on its roof").toBeTruthy();
    // A crown 4 px over each one's roof: nothing on it may stand taller than that.
    const low = new Map(picks.map((p) => [p.x, p.roof - 4]));
    vi.mocked(roofLimit).mockImplementation((world, amb, horizon, x0, x1, layers) => low.get(x0) ?? actual.roofLimit(world, amb, horizon, x0, x1, layers));
    try {
      const again = apartmentsIn(fresh(), utc, H, 20_000, 60_000);
      for (const p of picks) {
        const q = again.find((b) => b.x === p.x)!;
        expect(q.roof, p.kind).toBe(p.roof);
        expect(q.parts.map(([, , t]) => t >= p.roof - 4), p.kind).toEqual(q.parts.map(() => true));
        // Only a danchi's core is left, flush with its roof.
        expect(q.parts.length, p.kind).toBe(p.kind === "danchi" ? 2 : 1);
      }
    } finally {
      vi.mocked(roofLimit).mockImplementation(actual.roofLimit);
    }
  });

  it("leaves a quarter of the homes vacant", () => {
    const homes = allOf(reference).flatMap((p) => p.homes);
    expect(VACANT).toBe(4);
    expect(homes.length).toBeGreaterThan(1000);
    const share = homes.filter((h) => h.vacant).length / homes.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.28);
  });
});

// ───────────────────────────── the day pass ─────────────────────────────

describe("the apartments by day", () => {
  it("leans every DAY colour towards the haze — more in rain and fog — and veils it towards the night", () => {
    expect([HAZE, AERIAL, NIGHT, VEIL]).toEqual(["#93abc6", 0.36, "#1e2438", 0.6]);
    // #ded5bf (a danchi's cream) 0.36 of the way to #93abc6: (222·0.64 + 147·0.36, 213·0.64 + 171·0.36, 191·0.64 + 198·0.36).
    expect(seenThrough("#ded5bf", "clear", 0)).toBe("#c3c6c2");
    // Fog adds 0.4 more: 0.76 of the way — (165, 181.08, 196.32).
    expect(WEATHER_MIX.fog).toBe(0.4);
    expect(seenThrough("#ded5bf", "fog", 0)).toBe("#a5b5c4");
    // At full night (16 of 16 steps) 0.6 of the way on from #c3c6c2 to #1e2438: (195·0.4 + 30·0.6, 198·0.4 + 36·0.6, 194·0.4 + 56·0.6).
    expect(seenThrough("#ded5bf", "clear", 16)).toBe("#60656f");
    // Each weather fades it more than a clear day does, rain and fog the most.
    for (const w of ["cloudy", "drizzle", "snow", "rain", "storm", "fog"] as const) expect(WEATHER_MIX[w]).toBeGreaterThan(0);
    expect(WEATHER_MIX.fog).toBeGreaterThan(WEATHER_MIX.rain);
  });

  it("paints its plain day colours with no ambience at all (no zone, no clock)", () => {
    noCanvas();
    const s = sceneOf(reference, undefined);
    APARTMENTS.paint(s);
    const colors = new Set(painting(s).map((f) => f.color));
    expect(colors.has(seenThrough(APARTMENT_DAY.tank, "clear", 0))).toBe(true);
    const plain = sceneOf(reference, noon);
    APARTMENTS.paint(plain);
    expect(new Set(painting(plain).map((f) => f.color))).toEqual(colors);
  });

  it("paints only in the quiet stretches and in view, in opaque hazed colours of its palette", () => {
    const day = new Set<string>();
    const add = (v: unknown): void => {
      if (typeof v === "string") day.add(seenThrough(v, "clear", 0));
      else if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === "object") Object.values(v).forEach(add);
    };
    add(APARTMENT_DAY);
    noCanvas();
    const s = sceneOf(reference, noon);
    APARTMENTS.paint(s);
    const fills = painting(s);
    expect(fills.length).toBeGreaterThan(500);
    for (const f of fills) {
      expect(f.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(day.has(f.color), f.color).toBe(true);
      expect(inPadded(reference, f.x) && inPadded(reference, f.x + f.w - 1), `${f.x}`).toBe(true);
      expect(f.x + f.w > s.x0 && f.x < s.x1).toBe(true);
      expect(f.y + f.h).toBeLessThanOrEqual(H);
    }
  });

  it("is a raster a building at a whole zoom — pixel for pixel its rects — painted once per weather and dark step", () => {
    /** The pixels of the rects alone, painted with no canvas host (in a world of its own: no raster made yet). */
    const rectsOf = (amb: Ambience) => {
      noCanvas();
      const t = sceneOf(fresh(), amb);
      APARTMENTS.paint(t);
      vi.restoreAllMocks();
      vi.stubGlobal("OffscreenCanvas", FakeRaster);
      expect(t.ctx.of("drawImage")).toEqual([]);
      return pixels(painting(t), t.x0, t.x1);
    };
    const world = fresh();
    const s = sceneOf(world, noon);
    APARTMENTS.paint(s);
    expect(s.ctx.of("fillRect")).toEqual([]);
    expect(s.ctx.of("drawImage").length).toBeGreaterThan(10);
    // (A raster is blitted whole: what of it falls off the view, the canvas drops.)
    expectSame(pixels(painting(s), s.x0, s.x1), rectsOf(noon));
    // Painted again: no new raster, nothing painted into one again.
    const made = FakeRaster.made.length;
    const calls = FakeRaster.made.map((r) => r.ctx.calls.length);
    APARTMENTS.paint(sceneOf(world, noon));
    expect(FakeRaster.made.length).toBe(made);
    expect(FakeRaster.made.map((r) => r.ctx.calls.length)).toEqual(calls);
    // In the rain, or at night, each is painted again — in the same raster, cleared first.
    for (const amb of [sky("noon", "rain"), night]) {
      const t = sceneOf(world, amb);
      APARTMENTS.paint(t);
      expect(FakeRaster.made.length).toBe(made);
      for (const r of FakeRaster.made) expect(r.ctx.of("clearRect").length).toBeGreaterThan(0);
      expectSame(pixels(painting(t), t.x0, t.x1), rectsOf(amb));
    }
  });

  it("reports as its face exactly the top of what it paints, and paints every pixel under it down to the street", () => {
    noCanvas();
    for (const cam of [FIT, { zoom: 1, ox: 448 - 1500, oy: 0 }]) {
      const s = sceneOf(reference, noon, cam);
      APARTMENTS.paint(s);
      const px = pixels(painting(s));
      const top = new Map<number, number>();
      for (const key of px.keys()) {
        const [x, y] = key.split(",").map(Number);
        top.set(x, Math.min(top.get(x) ?? Infinity, y));
      }
      let columns = 0;
      for (let x = Math.ceil(s.x0); x < s.x1; x++) {
        const face = APARTMENTS.faceAt(s, x);
        if (!inPadded(reference, x)) {
          expect(face, `${x}`).toBe(H);
          continue;
        }
        expect(face).toBeLessThan(H);
        // A world building covers this column from its roof down: what shows of it is above that.
        const wall = wallsOf(reference).find(([a, b]) => x >= a && x < b);
        if (wall && wall[2] <= face) continue;
        columns++;
        expect(top.get(x), `${x}`).toBe(face);
        for (let y = face; y < (wall ? wall[2] : H); y++) expect(px.has(`${x},${y}`), `${x},${y}`).toBe(true);
      }
      expect(columns).toBeGreaterThan(cam === FIT ? 600 : 200);
    }
  });

  it("veils its facades by the stars' measure of the dark: none by day, half-way at dusk (9 of 16 steps), all of it at night and darker", () => {
    // This sky's clock: dusk's daylight is 0.35 — (0.6 − 0.35) / 0.45 = 0.56 of the dark, 9 steps of 16; night's 0.15, all 16.
    expect([sky("dusk").daylight, night.daylight].map((d) => Math.round(d * 100))).toEqual([35, 15]);
    const day = new Set<string>();
    const add = (v: unknown): void => {
      if (typeof v === "string") day.add(v);
      else if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === "object") Object.values(v).forEach(add);
    };
    add(APARTMENT_DAY);
    for (const [amb, step] of [
      [noon, 0],
      [sky("dusk"), 9],
      [night, 16],
      [{ ...night, daylight: 0.02 }, 16],
    ] as const) {
      noCanvas();
      const s = sceneOf(reference, amb);
      APARTMENTS.paint(s);
      const veiled = new Set([...day].map((c) => seenThrough(c, "clear", step)));
      const colors = new Set(painting(s).map((f) => f.color));
      expect(colors.size).toBeGreaterThan(20);
      for (const c of colors) expect(veiled.has(c), `${c} at step ${step}`).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("draws each kind as designed, storey by storey (pixels at zoom 1, far along the street)", () => {
    noCanvas();
    const X0 = 20_000;
    const s = sceneOf(reference, noon, { zoom: 1, ox: -X0, oy: 0 }, { w: 2000, h: H + 20 });
    APARTMENTS.paint(s);
    const px = pixels(painting(s));
    const seen = { danchi: 0, mansion: 0, older: 0 };
    for (const p of apartmentsIn(reference, noon, H, X0 + 50, X0 + 1950)) {
      if (p.x < X0 || p.x + p.w > X0 + 2000) continue;
      const c = (k: keyof typeof p.tone) => seenThrough(p.tone[k], "clear", 0);
      const at = (x: number, y: number) => px.get(`${x},${y}`);
      seen[p.kind]++;
      // The parapet's cap along the roof, the end walls down the sides.
      expect(at(p.x, p.roof)).toBe(c("cap"));
      for (const h of p.homes) {
        const w = h.windows[0];
        const y = p.roof + 2 + Math.floor((w[1] - p.roof - 2) / 13) * 13;
        if (p.kind === "danchi") {
          const hx = w[0] - 10;
          expect([at(p.x, y + 3), at(p.x + p.w - 1, y + 3)]).toEqual([c("wall"), c("wall")]);
          // Ceiling shadow, then the corridor (a door, a frosted window in it), then the parapet band, its top lit.
          expect([at(hx + 8, y), at(hx + 8, y + 3), at(hx + 4, y + 3), at(hx + 11, y + 3), at(hx + 8, y + 6), at(hx + 8, y + 9)]).toEqual([
            c("deep"),
            c("shade"),
            c("trim"),
            c("glass"),
            c("cap"),
            c("wall"),
          ]);
        } else if (p.kind === "mansion") {
          const [a, b] = h.windows;
          const [hx, end] = [a[0] - 1, b[0] + b[2]];
          expect([at(p.x + 1, y + 5), at(p.x + p.w - 2, y + 5)]).toEqual([c("wall"), c("wall")]);
          // The slab's shadow, the glass, a mullion down the middle, a partition at the home's left (but the first),
          // the rail and the slab line at its foot.
          expect([at(end - 1, y), at(end - 1, y + 5), at(b[0] - 1, y + 2), at(end - 1, y + 9), at(end - 1, y + 12)]).toEqual([c("deep"), c("glass"), c("trim"), c("cap"), c("shade")]);
          expect(at(hx, y + 5)).toBe(hx === p.x + 3 ? c("glass") : c("trim"));
        } else
          for (const win of h.windows) {
            // Tile, the window (glass), the sill, tile again — and tile between two windows.
            expect([at(win[0], y + 1), at(win[0], y + 5), at(win[0], y + 9), at(win[0], y + 11), at(win[0] - 1, y + 5)]).toEqual([c("wall"), c("glass"), c("trim"), c("wall"), c("wall")]);
          }
      }
    }
    for (const k of KINDS) expect(seen[k], k).toBeGreaterThan(0);
    // Zoomed out to 9/16, the rects of every zoom are still there — a danchi's doors and bands, a mansion's rails —
    // and none of a pixel's lines (a danchi's ceiling shadow).
    const z = 9 / 16;
    const coarse = sceneOf(reference, noon, { zoom: z, ox: -X0 * z, oy: 0 }, { w: 1125, h: Math.ceil((H + 20) * z) });
    APARTMENTS.paint(coarse);
    const fills = coarse.ctx.of("fillRect").map((f) => ({ x: f.args[0] as number, w: f.args[2] as number, h: f.args[3] as number, color: f.fillStyle }));
    for (const f of fills) expect(f.w >= 1 && f.h >= 1).toBe(true);
    for (const p of apartmentsIn(reference, noon, H, X0 + 50, X0 + 1950)) {
      if (p.x < X0 || p.x + p.w > X0 + 2000) continue;
      const mine = fills.filter((f) => f.x >= Math.floor((p.x - X0) * z) && f.x < Math.ceil((p.x + p.w - X0) * z));
      const wide = (color: string) => mine.filter((f) => f.color === seenThrough(color, "clear", 0) && f.w >= Math.floor((p.w - 4) * z));
      if (p.kind === "danchi") {
        expect(mine.some((f) => f.color === seenThrough(p.tone.trim, "clear", 0))).toBe(true);
        expect(wide(p.tone.wall).length).toBe(p.floors);
        expect(wide(p.tone.deep).length).toBe(0);
        // Its roof's cap (the parapets' lit tops, of a pixel, are not painted).
        expect(wide(p.tone.cap).length).toBe(1);
      } else if (p.kind === "mansion") expect(wide(p.tone.cap).length).toBe(p.floors + 1);
      else expect(wide(p.tone.wall).length).toBeGreaterThanOrEqual(p.floors);
    }
  });

  it("paints nothing a world building covers, and none of its 1-px details below PANE_ZOOM", () => {
    noCanvas();
    const s = sceneOf(reference, noon);
    APARTMENTS.paint(s);
    for (const f of painting(s)) for (const [a, b, top] of wallsOf(reference)) expect(f.x >= a && f.x + f.w <= b && f.y >= top, `${f.x},${f.y}`).toBe(false);
    // Zoomed out to 9/16 the same buildings are painted with fewer fills — none of a pixel's details: laundry, an
    // air conditioner, a tank's seam (from 3/4 on, all of them).
    const coarse = sceneOf(reference, noon, { zoom: 9 / 16, ox: 252, oy: 0 }, { w: 1440, h: 900 });
    const fine = sceneOf(reference, noon, { zoom: 3 / 4, ox: 336, oy: 0 }, { w: 1920, h: 1200 });
    APARTMENTS.paint(coarse);
    APARTMENTS.paint(fine);
    expect(coarse.ctx.of("drawImage")).toEqual([]);
    expect(fine.ctx.of("drawImage")).toEqual([]);
    const n = (t: Scene) => t.ctx.of("fillRect").length;
    expect(n(coarse)).toBeLessThan(n(fine) * 0.7);
    const details = new Set([...APARTMENT_DAY.laundry, APARTMENT_DAY.futon, APARTMENT_DAY.ac, APARTMENT_DAY.tankBand].map((c) => seenThrough(c, "clear", 0)));
    const of = (t: Scene) => t.ctx.of("fillRect").filter((c) => details.has(c.fillStyle)).length;
    expect(of(coarse)).toBe(0);
    expect(of(fine)).toBeGreaterThan(20);
    // Every rect snapped like `rect`: never under a screen px, a 1-px line at 3/4 included.
    for (const c of [...coarse.ctx.of("fillRect"), ...fine.ctx.of("fillRect")]) expect((c.args[2] as number) >= 1 && (c.args[3] as number) >= 1).toBe(true);
  });

  it("paints nothing with its band off the view — zoomed in above it, or under the street — nor anything wholly off the view", () => {
    for (const cam of [
      { zoom: 2, ox: -1000, oy: -2 * (H - 900) },
      { zoom: 2, ox: -1000, oy: -2 * H - 10 },
    ]) {
      const s = sceneOf(reference, noon, cam, { w: 1280, h: 800 });
      APARTMENTS.paint(s);
      expect(s.ctx.calls.filter((c) => c.op === "fillRect" || c.op === "drawImage")).toEqual([]);
    }
    // A view of the street just left of gazelle: what stands wholly out of it (behind gazelle, or past it) is not painted.
    const cam = { zoom: 2, ox: -2 * -100, oy: -2 * (H - 300) };
    const s = sceneOf(reference, noon, cam, { w: 400, h: 600 });
    APARTMENTS.paint(s);
    expect(s.ctx.of("drawImage").length).toBeGreaterThan(0);
    for (const c of s.ctx.of("drawImage")) {
      const [, , , sw, sh, dx, dy] = c.args as number[];
      expect(dx < 400 && dx + 2 * sw > 0 && dy < 600 && dy + 2 * sh > 0).toBe(true);
    }
    // …each blitted at the zoom (2 screen px a world px), every pixel where its rects would be.
    noCanvas();
    const rects = sceneOf(fresh(), noon, cam, { w: 400, h: 600 });
    APARTMENTS.paint(rects);
    expectSame(pixels(painting(s), s.x0, s.x1), pixels(painting(rects), s.x0, s.x1));
  });
});

// ───────────────────────────── the night pass ─────────────────────────────

describe("the apartments at night", () => {
  it("lights nothing at noon, nor below the first step of the lit share — nor with its band off the view", () => {
    expect(citySky(noon).lit).toBe(0);
    for (const lit of [0, 1 / 32 - 0.001]) {
      const s = lightScene(reference, noon, lit);
      APARTMENTS.paintLights(s);
      expect(s.lights).toEqual([]);
    }
    const off = lightScene(reference, night, 0.4, { zoom: 2, ox: -1000, oy: -2 * (H - 900) }, { w: 1280, h: 800 });
    APARTMENTS.paintLights(off);
    expect(off.lights).toEqual([]);
    expect(off.ctx.calls.filter((c) => c.op === "fillRect")).toEqual([]);
  });

  it("lights every window through `fillLit` — never a fill of its own — and nothing without a canvas but the TVs", () => {
    const s = lightScene(reference, night, 0.4);
    APARTMENTS.paintLights(s);
    expect(s.ctx.of("fillRect")).toEqual([]);
    expect(s.lights.length).toBeGreaterThan(10);
    expect(s.ctx.globalAlpha).toBe(1);
    noCanvas();
    const t = lightScene(fresh(), night, 0.4);
    APARTMENTS.paintLights(t);
    expect(t.lights.length).toBeGreaterThan(0);
    for (const l of t.lights) expect(APARTMENT_LIT.tv).toContain(l.style);
  });

  it("never lights a vacant home; at a full share, every window of every other home", () => {
    const s = lightScene(reference, night, 1);
    APARTMENTS.paintLights(s);
    const lit = litRects(s);
    const homes = apartmentsIn(reference, night, H, s.x0, s.x1).flatMap((p) => p.homes);
    let vacant = 0;
    let full = 0;
    for (const home of homes)
      for (const win of home.windows) {
        if (behindWall(reference, win[0], win[1]) || win[0] < s.x0 || win[0] + win[2] > s.x1) continue;
        const on = lit.filter((f) => overlaps(f, win));
        if (home.vacant) {
          expect(on, `${win}`).toEqual([]);
          vacant++;
        } else if (on.length > 0) full++;
      }
    expect(vacant).toBeGreaterThan(100);
    expect(full).toBeGreaterThan(300);
  });

  it("lights each window at its own fixed threshold: the lit set only grows with the share — 20–35 % of all windows at full night", () => {
    const at = (lit: number) => {
      const s = lightScene(reference, night, lit);
      APARTMENTS.paintLights(s);
      return pixels(litRects(s).filter((f) => !APARTMENT_LIT.tv.includes(f.color)));
    };
    const shares = [0.04, 0.12, 0.25, 0.4];
    const sets = shares.map(at);
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i].size).toBeGreaterThan(sets[i - 1].size);
      for (const key of sets[i - 1].keys()) expect(sets[i].has(key), key).toBe(true);
    }
    // At full night (the haze's share, 0.4: the step 12/32) about 0.375 of the occupied homes' windows — a quarter of
    // all of them, the TVs and what stands behind a temple aside.
    expect(citySky(night).lit).toBe(0.4);
    const homes = apartmentsIn(reference, night, H, -448, 2112).flatMap((p) => p.homes);
    const windows = homes.flatMap((h) => h.windows).filter((w) => !behindWall(reference, w[0], w[1]) && w[0] >= -448 && w[0] + w[2] <= 2112);
    const lit = windows.filter((w) => sets[3].has(`${w[0] + 1},${w[1] + 1}`)).length;
    expect(lit / windows.length).toBeGreaterThan(0.2);
    expect(lit / windows.length).toBeLessThan(0.35);
    // At the first step (1/32, early in golden hour) a window in 32 of the occupied homes: about 2 % of them all.
    const first = windows.filter((w) => sets[0].has(`${w[0] + 1},${w[1] + 1}`)).length;
    expect(first / windows.length).toBeGreaterThan(0.01);
    expect(first / windows.length).toBeLessThan(0.035);
  });

  it("lights homes in a dim warm white mostly, some cool, some behind a curtain; a danchi's corridor as a faint dotted row", () => {
    const s = lightScene(reference, night, 0.4);
    APARTMENTS.paintLights(s);
    const count = new Map<string, number>();
    for (const f of litRects(s)) count.set(f.color, (count.get(f.color) ?? 0) + 1);
    const { warm, cool, curtain, corridor, stair } = APARTMENT_LIT;
    expect(warm).toBe("rgba(230, 207, 152, 0.85)");
    expect(count.get(warm)!).toBeGreaterThan(count.get(cool)!);
    expect(count.get(warm)!).toBeGreaterThan(count.get(curtain)!);
    expect(count.get(cool)!).toBeGreaterThan(20);
    expect(count.get(curtain)!).toBeGreaterThan(20);
    // The corridors' ceiling lights: 1×1 dots, every home along every storey of every danchi in view.
    const dots = litRects(s).filter((f) => f.color === corridor);
    expect(dots.length).toBeGreaterThan(100);
    for (const d of dots) expect([d.w, d.h]).toEqual([1, 1]);
    expect(count.get(stair)!).toBeGreaterThan(20);
    // Nothing glaring: every light is translucent.
    for (const c of [warm, cool, curtain, corridor, stair]) expect(Number(c.match(/([\d.]+)\)$/)![1])).toBeLessThan(0.9);
  });

  it("dims the lights in rain and fog, and a little at golden hour", () => {
    const alphaOf = (amb: Ambience, dark: number) => {
      const s = { ...lightScene(reference, amb, 0.4), dark };
      APARTMENTS.paintLights(s);
      return s.lights.filter((l) => typeof l.style !== "string")[0].alpha;
    };
    expect(alphaOf(night, 1)).toBe(1);
    expect(LIGHT_SEEN.rain).toBe(0.8);
    expect(alphaOf(sky("night", "rain"), 1)).toBeCloseTo(0.8, 6);
    expect(alphaOf(sky("night", "fog"), 1)).toBeCloseTo(0.6, 6);
    expect(alphaOf(night, 0)).toBeCloseTo(0.55, 6);
  });

  it("flickers a TV in one lit home in 25 — blue, deterministic, by the clock — and never in a vacant home", () => {
    const tvs = (timeMs: number) => {
      const s = lightScene(reference, night, 0.4, FIT, VIEW, timeMs);
      APARTMENTS.paintLights(s);
      return s.lights.filter((l) => typeof l.style === "string");
    };
    const a = tvs(1000);
    expect(a.length).toBeGreaterThan(3);
    expect(tvs(1000)).toEqual(a);
    for (const t of a) {
      expect(APARTMENT_LIT.tv).toContain(t.style);
      expect(t.alpha).toBeGreaterThanOrEqual(0.35);
      expect(t.alpha).toBeLessThanOrEqual(0.8);
    }
    // A second and a half later the same TVs are on, their pictures changed.
    const later = tvs(2500);
    expect(later.map((t) => [t.x, t.y])).toEqual(a.map((t) => [t.x, t.y]));
    expect(later.filter((t, i) => t.style !== a[i].style || t.alpha !== a[i].alpha).length).toBeGreaterThan(a.length / 2);
    const homes = apartmentsIn(reference, night, H, -448, 2112).flatMap((p) => p.homes);
    for (const t of a) for (const w of homes.filter((h) => h.vacant).flatMap((h) => h.windows)) expect(overlaps(t, w)).toBe(false);
    // One TV a home, in its first window.
    for (const h of homes) {
      const on = h.windows.map((w) => a.filter((t) => overlaps(t, w)).length);
      expect(on.slice(1).every((n) => n === 0)).toBe(true);
    }
    // A TV's glow: one of four blues at 0.35–0.8, each TV holding a picture 150–400 ms (its own pace).
    const g = tvGlow(12345, 0);
    expect(tvGlow(12345, 0)).toEqual(g);
    const paces = new Set<number>();
    for (const seed of [12345, 999, 4242, 77777, 31337, 2024]) {
      const colors = new Set<string>();
      const alphas = new Set<number>();
      let held = 0;
      const holds: number[] = [];
      for (let t = 0; t < 20_000; t++) {
        const a = tvGlow(seed, t);
        const b = tvGlow(seed, t + 1);
        colors.add(a.color);
        alphas.add(a.alpha);
        held++;
        if (a.color !== b.color || a.alpha !== b.alpha) {
          holds.push(held);
          held = 0;
        }
      }
      expect([...colors].sort()).toEqual([...APARTMENT_LIT.tv].sort());
      expect(alphas.size).toBeGreaterThan(20);
      for (const a of alphas) expect(a >= 0.35 && a <= 0.8).toBe(true);
      // Whole holds (not the first, cut by t = 0): one pace each, 150–400 ms.
      const pace = Math.min(...holds.slice(1));
      expect(pace).toBeGreaterThanOrEqual(150);
      expect(pace).toBeLessThanOrEqual(400);
      paces.add(pace);
    }
    expect(paces.size).toBeGreaterThan(3);
    // Two TVs of one pace (seeds 5000 and 15040: 381 ms each) cut at moments of their own.
    const cut = (seed: number) => {
      let t = 1;
      while (tvGlow(seed, t).color === tvGlow(seed, t - 1).color && tvGlow(seed, t).alpha === tvGlow(seed, t - 1).alpha) t++;
      return t % 381;
    };
    expect(cut(5000)).not.toBe(cut(15040));
  });

  it("lights a TV only in a home lit at the share, dimmed like the rest in rain", () => {
    const tvs = (lit: number, amb = night) => {
      const s = lightScene(reference, amb, lit, FIT, VIEW, 5000);
      APARTMENTS.paintLights(s);
      return s.lights.filter((l) => typeof l.style === "string");
    };
    const all = tvs(1);
    expect(all.length).toBeGreaterThan(12);
    expect(tvs(1 / 32).length).toBeLessThan(all.length / 6);
    const rain = tvs(1, sky("night", "rain"));
    expect(rain.map((t) => t.alpha.toFixed(6))).toEqual(all.map((t) => (0.8 * t.alpha).toFixed(6)));
  });

  it("lights nothing in a temple's box, nor off the view", () => {
    const temples = placeLandmarks(reference, H, landmarksFor("Asia/Tokyo"))
      .placed.filter((p) => p.spec.layer === "near")
      .map((p) => [p.x - p.hw, H - p.h - 2, 2 * p.hw + 1, p.h + 2]);
    expect(temples.length).toBe(2);
    // At Fit, and zoomed ×2 on the gaps with the view's bottom 100 px above the street (it cuts the homes).
    for (const cam of [FIT, { zoom: 2, ox: -2 * 600, oy: -2 * (H - 300) }]) {
      const view = cam === FIT ? VIEW : { w: 1280, h: 400 };
      const s = lightScene(reference, night, 1, cam, view);
      APARTMENTS.paintLights(s);
      const top = -Math.round(cam.oy) / cam.zoom;
      const bottom = (view.h - Math.round(cam.oy)) / cam.zoom;
      for (const l of s.lights) {
        if (typeof l.style !== "string") for (const t of temples) expect(overlaps(l, t), `${l.x},${l.y}`).toBe(false);
        expect(l.x >= s.x0 - 1 && l.x + l.w <= s.x1 + 1 && l.y >= top && l.y + l.h <= bottom, `${l.x},${l.y}`).toBe(true);
      }
    }
  });

  it("paints a building's lights once per step of the share (again in the same raster), and keeps rasters for at most MAX_RASTERS buildings", () => {
    const world = fresh();
    APARTMENTS.paintLights(lightScene(world, night, 0.4));
    const made = FakeRaster.made.length;
    expect(made).toBeGreaterThan(10);
    const calls = FakeRaster.made.map((r) => r.ctx.calls.length);
    // 0.39 and 0.4 are the same step (12/32): nothing is painted again.
    APARTMENTS.paintLights(lightScene(world, night, 0.39));
    expect(FakeRaster.made.map((r) => r.ctx.calls.length)).toEqual(calls);
    // 0.3 is another (9/32): each is cleared and painted again, in the same raster — and fewer windows are lit.
    const before = FakeRaster.made.map((r) => rasterFills(r).length);
    APARTMENTS.paintLights(lightScene(world, night, 0.3));
    expect(FakeRaster.made.length).toBe(made);
    const after = FakeRaster.made.map((r) => rasterFills(r).length);
    expect(after.reduce((p, q) => p + q)).toBeLessThan(before.reduce((p, q) => p + q));
    // Painted again and again while the view pans far away, a building keeps its raster: the LEAST recently
    // painted lose theirs, not the first made.
    const rastersMade = (interleaved: boolean) => {
      const kept = city([1, 1, 1], 2, 64);
      const keep = (x: number) => APARTMENTS.paintLights(lightScene(kept, night, 0.4, { zoom: 1, ox: -x, oy: 0 }, { w: 800, h: 1600 }));
      const before = FakeRaster.made.length;
      keep(0);
      for (let x = 800; x < 40_000; x += 800) {
        keep(x);
        if (interleaved) keep(0);
      }
      return FakeRaster.made.length - before;
    };
    // Coming back to the start between every two passes makes not one raster more than never coming back.
    expect(rastersMade(true)).toBe(rastersMade(false));
    // Panning along a long street, the earliest buildings lose theirs: back at the start, they are made again.
    expect(MAX_RASTERS).toBe(64);
    const street = city([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 2, 64);
    const at = (x: number) => ({ zoom: 1, ox: -x, oy: 0 });
    const pass = (x: number) => APARTMENTS.paintLights(lightScene(street, night, 0.4, at(x), { w: 800, h: 1600 }));
    pass(0);
    const first = FakeRaster.made.length;
    pass(0);
    expect(FakeRaster.made.length).toBe(first);
    for (let x = 800; x < 40_000; x += 800) pass(x);
    const all = FakeRaster.made.length;
    pass(0);
    expect(FakeRaster.made.length).toBeGreaterThan(all);
  });
});

// ───────────────────────────── the face ─────────────────────────────

describe("the apartments' face", () => {
  it("is the street's top outside the quiet stretches and on either side of them, and the top of what stands where they are — across air chunks' edges too", () => {
    const s = sceneOf(reference, noon);
    for (const [a, b] of chained(reference, -3 * AIR_CHUNK, 8 * AIR_CHUNK).slice(1, -1)) {
      expect(APARTMENTS.faceAt(s, a - 3)).toBe(H);
      expect(APARTMENTS.faceAt(s, a - 2)).toBeLessThan(H);
      expect(APARTMENTS.faceAt(s, b + 1)).toBeLessThan(H);
      expect(APARTMENTS.faceAt(s, b + 2)).toBe(H);
      // Fractions of a px are the px they fall in.
      expect(APARTMENTS.faceAt(s, a - 1.5)).toBe(APARTMENTS.faceAt(s, a - 2));
    }
    // A row reaching across an air chunk's edge (its padding in the next chunk, or the one before).
    let edges = 0;
    for (const [a, b] of chained(reference, -200 * AIR_CHUNK, 200 * AIR_CHUNK)) {
      if (Math.floor((a - 2) / AIR_CHUNK) < Math.floor(a / AIR_CHUNK)) {
        edges++;
        expect(APARTMENTS.faceAt(s, a - 2)).toBeLessThan(H);
        expect(APARTMENTS.faceAt(s, a - 3)).toBe(H);
      }
      if (Math.floor((b + 1) / AIR_CHUNK) > Math.floor((b - 1) / AIR_CHUNK)) {
        edges++;
        expect(APARTMENTS.faceAt(s, b + 1)).toBeLessThan(H);
        expect(APARTMENTS.faceAt(s, b + 2)).toBe(H);
      }
    }
    expect(edges).toBeGreaterThan(0);
  });

  it("leaves no sliver of haze or sky between two quiet stretches less than 48 px apart — and leaves one 48 px or wider alone", () => {
    expect(SLIVER).toBe(48);
    const s = sceneOf(reference, noon);
    /** Is there a building standing over world column x? */
    const stands = (x: number) => apartmentsIn(reference, noon, H, x, x + 1).some((p) => x >= p.x && x < p.x + p.w);
    // Hand-picked (a search of the air chunks): the reference city's 17 px right of website; stretches 2–3 px apart;
    // 46 and 47 px apart (filled); 48 and 49 px apart (left alone).
    for (const [b, a] of [
      [1568, 1585],
      [-1723950721, -1723950719],
      [-1723578912, -1723578909],
      [-552124, -552078],
      [-327194, -327147],
    ])
      for (let x = b; x < a; x++) {
        expect(APARTMENTS.faceAt(s, x), `${x}`).toBeLessThan(H);
        expect(stands(x), `${x}`).toBe(true);
      }
    for (const [b, a] of [
      [-359427, -359379],
      [-534249, -534200],
    ])
      for (let x = b + 2; x < a - 2; x++) {
        expect(APARTMENTS.faceAt(s, x), `${x}`).toBe(H);
        expect(stands(x), `${x}`).toBe(false);
      }
    // A stretch of sky 28 px left of a city's walls, and one 9 px right of another's (found by a search of cities): one row each.
    for (const [world, b, a] of [
      [city([1], 13), 68, 96],
      [city([1, 1, 1, 1], 9, 16), 1576, 1585],
    ] as const) {
      const t = sceneOf(world, noon);
      expect(quietSpans(world, b - 1, a + 1).map(([, e]) => e)).toContain(b);
      for (let x = b; x < a; x++) expect(APARTMENTS.faceAt(t, x), `${x}`).toBeLessThan(horizonOf(world));
    }
    // Two stretches that touch (found by a search), and chains of three — a city's span 9 px from a stretch of
    // sky that is itself 47 (or 46) px from another, either side (the city's walls placed there by hand): each
    // one row, its buildings shoulder to shoulder from 2 px before its first stretch to 2 px past its last.
    const walled = (x0: number, x1: number): World => ({ ...reference, city: { ...reference.city!, buildings: [{ ...reference.city!.buildings[0], col: x0 / TILE, w: (x1 - x0) / TILE }] } });
    for (const [world, a, b] of [
      [reference, -857582882, -857582704],
      [walled(-327056, -326656), -327310, -326656],
      [walled(-552624, -552224), -552624, -551978],
    ] as const) {
      const row = apartmentsIn(world, noon, H, a, b).filter((p) => p.x < b + 2 && p.x + p.w > a - 2);
      expect(row[0].x, `${a}`).toBe(a - 2);
      for (let i = 1; i < row.length; i++) expect(row[i].x, `${row[i].x}`).toBe(row[i - 1].x + row[i - 1].w);
      expect(row[row.length - 1].x + row[row.length - 1].w).toBe(b + 2);
    }
    // Asked first about a column deep in the right one of two (touching, or 47 px apart), in a world laid out
    // afresh: the row is still the pair's, from the left one's start — the chain is walked left too.
    for (const [a, x] of [
      [-857582882, -857582720],
      [-327310, -327100],
    ]) {
      const row = apartmentsIn(fresh(), noon, H, x, x + 1);
      expect(row[0].x, `${x}`).toBe(a - 2);
    }
    // …and so along the whole street: every gap between two stretches under 48 px is filled, every other is open sky.
    let filled = 0;
    let open = 0;
    const spans = quietSpans(reference, -100 * AIR_CHUNK, 100 * AIR_CHUNK);
    for (let i = 1; i < spans.length; i++) {
      const [b, a] = [spans[i - 1][1], spans[i][0]];
      const mid = (a + b) >> 1;
      if (a - b < 48) {
        expect(APARTMENTS.faceAt(s, mid), `${b}..${a}`).toBeLessThan(H);
        filled++;
      } else {
        expect(APARTMENTS.faceAt(s, mid), `${b}..${a}`).toBe(H);
        open++;
      }
    }
    expect(filled).toBeGreaterThan(3);
    expect(open).toBeGreaterThan(100);
  });

  it("is a lookup, not a walk: asked again over columns it has answered, it looks up no stretch of sky (the night pass asks ≈ 5,000 times a frame)", () => {
    const s = sceneOf(reference, night);
    const ask = () => {
      let sum = 0;
      for (let x = -700; x < 2300; x += 3) sum += APARTMENTS.faceAt(s, x);
      return sum;
    };
    const first = ask();
    vi.mocked(airSpans).mockClear();
    expect(ask()).toBe(first);
    expect(airSpans).not.toHaveBeenCalled();
  });

  it("is laid out afresh for a new horizon, or another city's landmarks", () => {
    const s = sceneOf(reference, noon);
    const tokyo = allOf(reference).map((p) => p.floors);
    const plain = allOf(reference, sky("noon", "clear", "UTC")).map((p) => p.floors);
    expect(plain).not.toEqual(tokyo);
    // Under a horizon 40 px lower, the haze's top is 6 px taller: the roofs rise to it from the new street.
    const raised = { ...s, horizon: H + 40 };
    expect(skylineMax(H + 40)).toBe(150);
    for (let x = 0; x < 1568; x += 7) expect(H + 40 - APARTMENTS.faceAt(raised, x)).toBeGreaterThanOrEqual(150);
    expect(allOf(reference).map((p) => p.floors)).toEqual(tokyo);
  });
});
