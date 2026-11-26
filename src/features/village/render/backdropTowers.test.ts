/** A recording fake stands in for the canvas (jsdom has none). Expectations are hand-written (sizes
 * from the design, colours from the palette), never read back off the painter under test; real
 * pixels are backdropTowers.browser.test.tsx's. */

import { describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { citySky, CITY_DAY } from "../engine/ambience";
import { TILE, type Ambience, type DayPhase, type WeatherKind, type World } from "../villageTypes";
import { airSpans, roofLimit, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { CHUNK, CLEAR, envelope, forEachTower, rowRuns, TOWER, TOWER_KINDS, TOWER_LIT, TOWERS, type Tower } from "./backdropTowers";
import type { Camera } from "./camera";
import { AVIATION, BLINK_MS, landmarksFor, placeLandmarks } from "./landmarks";
import { skylineMax } from "./skyline";
import { recorder, type DrawCall, type RecordingTarget } from "./testRecorder";

// ───────────────────────────── cities, skies, scenes ─────────────────────────────

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
const plan = (i: number, floors: number, team = 2) => ({ key: `p${i}`, label: `p${i}`, team, hasIde: true, floors: floorsOf(`p${i}`, floors) });
/** The reference city: a seven-floor gazelle left of the HQ, a one-floor project right of it (a sky of 976 px). */
const reference = buildCityWorld(
  [
    { key: "chat-server", label: "chat-server", team: 2, hasIde: true, floors: floorsOf("t", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);
/** A low city: the HQ and two one-floor projects (a sky of 240 px). */
const low = buildCityWorld([plan(0, 1), plan(1, 1)], { seats: 64 });
/** A real-shaped city: Agent Studio (1 floor), the HQ, gazelle (5 floors, the tallest), workspace (1 floor). */
const real = buildCityWorld(
  [
    { key: "gazelle", label: "gazelle", team: 12, hasIde: true, floors: floorsOf("g", 5) },
    { key: "Agent Studio", label: "Agent Studio", team: 16, hasIde: true, floors: floorsOf("a", 1) },
    { key: "workspace", label: "workspace", team: 2, hasIde: true, floors: floorsOf("w", 1) },
  ],
  { seats: 64 },
);
/** Cities of 1–12 floors, narrow and wide, with the HQ and without. */
const SWEEP: World[] = [reference, low];
for (const floors of [[1], [3], [6], [12], [2, 5], [5, 1], [9, 1], [4, 4, 4], [12, 1, 7], [1, 1, 1, 1]])
  for (const team of [2, 26]) {
    SWEEP.push(buildCityWorld(floors.map((f, i) => plan(i, f, i === 0 ? team : 2)), { seats: 64 }));
    SWEEP.push(buildCityWorld(floors.map((f, i) => plan(i, f, i === 0 ? team : 2))));
  }

const horizonOf = (w: World) => w.city!.street * TILE;

/** A forced sky in Tokyo (or another zone): phases night | dawn | morning | noon | afternoon | evening | dusk. */
const sky = (phase: DayPhase, weather: WeatherKind = "clear", zone = "Asia/Tokyo"): Ambience =>
  computeAmbience(new Date(2026, 9, 27, 13, 0), null, { weather, phase }, zone);
const noon = sky("noon");
const night = sky("night");

/** Fit at 1280×800 @2x: zoom 1, the view x −448 … 2112, the whole sky. */
/** A 1280×800 @2x pane at zoom 1, the sky shown 1000 px over the world's top: the tallest towers rise past it. */
const FIT: Camera = { zoom: 1, ox: 448, oy: 1000 };
const VIEW = { w: 2560, h: 2000 };

type Scene = BackdropScene & { ctx: RecordingTarget };

function sceneOf(world: World, amb: Ambience | undefined, cam: Camera = FIT, view = VIEW, timeMs = 0): Scene {
  return {
    ctx: recorder(),
    cam,
    world,
    view,
    amb,
    horizon: horizonOf(world),
    timeMs,
    x0: (0 - Math.round(cam.ox)) / cam.zoom,
    x1: (view.w - Math.round(cam.ox)) / cam.zoom,
  };
}

interface Light {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
}

/** A night scene whose `fillLit` records each light (in world px) instead of painting it. */
function lightsOf(s: Scene, amb: Ambience, lit: number, dark: number): { lights: Light[]; scene: BackdropLightScene } {
  const lights: Light[] = [];
  const scene: BackdropLightScene = {
    ...s,
    amb,
    lit,
    dark,
    fillLit: (x, y, w, h) => lights.push({ x, y, w, h, color: String(s.ctx.fillStyle), alpha: s.ctx.globalAlpha }),
    hidden: () => false,
  };
  TOWERS.paintLights(scene);
  return { lights, scene };
}

/** Every tower over [x0, x1) of `world` under `amb`. */
function towersOf(world: World, amb: Ambience | undefined, x0 = -3000, x1 = 6000): Tower[] {
  const out: Tower[] = [];
  forEachTower(sceneOf(world, amb), x0, x1, (t) => out.push(t));
  return out;
}

/** A fill as a world-px box under camera `cam` (whole zoom, so edges are exact). */
function box(c: DrawCall, cam: Camera) {
  const [x, y, w, h] = c.args as number[];
  return { x: (x - Math.round(cam.ox)) / cam.zoom, y: (y - Math.round(cam.oy)) / cam.zoom, w: w / cam.zoom, h: h / cam.zoom, color: c.fillStyle, alpha: c.alpha };
}
const boxesOf = (s: Scene) => s.ctx.of("fillRect").map((c) => box(c, s.cam));
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const wallsOf = (w: World) =>
  w.city!.buildings.map((b) => ({ x: b.col * TILE, y: b.row * TILE, w: b.w * TILE, h: horizonOf(w) - b.row * TILE }));

/** The signature skyscraper's span, by hand: centred behind the tallest building, 0.55 of its width (never under 5 tiles). */
function signatureSpan(world: World): [number, number] {
  const b = world.city!.buildings.reduce((p, q) => (q.row < p.row ? q : p));
  const w = Math.max(5 * TILE, Math.round(0.55 * b.w * TILE));
  const x = Math.round((b.col + b.w / 2) * TILE - w / 2);
  return [x, x + w];
}
const isSignature = (world: World, t: Tower) => t.x === signatureSpan(world)[0] && t.x + t.w === signatureSpan(world)[1];
/** The cluster towers over [x0, x1) — all but the signature skyscraper. */
const clustersOf = (world: World, amb: Ambience | undefined, x0 = -3000, x1 = 6000) => towersOf(world, amb, x0, x1).filter((t) => !isSignature(world, t));
/** The height of the world's tallest building over the street. */
const tallestOf = (world: World) => horizonOf(world) - Math.min(...world.city!.buildings.map((b) => b.row * TILE));

/** World pixels painted by a scene, last fill wins: "x,y" → colour. */
function raster(s: Scene): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of boxesOf(s)) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) out.set(`${x},${y}`, b.color);
  return out;
}

/** A tower with no other overlapping it, nothing in front of it (its cover the street, all across): alone in a view of its own width. */
const alone = (t: Tower, all: readonly Tower[], world: World) =>
  t.cover.length === 1 && t.cover[0][2] === horizonOf(world) && all.every((u) => u === t || u.x >= t.x + t.w || u.x + u.w <= t.x);
/** A tower wholly behind the haze: none of it stands in the open sky between the backdrop's clusters. */
const hazed = (t: Tower) => airSpans(t.x, t.x + t.w).length === 0;
/** Is [x0, x1) wholly in the open sky? */
const open = (x0: number, x1: number) => airSpans(x0, x1).some(([a, b]) => a <= x0 && b >= x1);

const DAY_COLOURS = new Set<string>([...TOWER.tints.flatMap((t) => [t.frame, t.glass, t.edge, t.crown]), TOWER.mast, TOWER.tank, TOWER.pad, TOWER.panel]);

// ───────────────────────────── the layout ─────────────────────────────

describe("the outline", () => {
  it("is the highest top over every column, as disjoint parts left to right — equal neighbours merged, gaps kept", () => {
    expect(
      envelope([
        [0, 10, 50],
        [2, 6, 40],
        [8, 12, 45],
      ]),
    ).toEqual([
      [0, 2, 50],
      [2, 6, 40],
      [6, 8, 50],
      [8, 12, 45],
    ]);
    expect(
      envelope([
        [0, 4, 10],
        [4, 8, 10],
      ]),
    ).toEqual([[0, 8, 10]]);
    expect(
      envelope([
        [0, 2, 5],
        [4, 6, 5],
      ]),
    ).toEqual([
      [0, 2, 5],
      [4, 6, 5],
    ]);
  });

  it("walks a row's runs: where nothing in front reaches above its bottom; for glass, the glass starts at or above its top; below the haze's top, only in the open sky", () => {
    const cells = [
      [0, 4, 10, 50, false],
      [4, 8, 10, 30, false],
      [8, 12, 20, 50, true],
      [12, 16, 10, 50, false],
    ] as const;
    const runs = (top: number, bottom: number, glass: boolean, a = 0, b = 16, deep = Infinity) => {
      const out: [number, number][] = [];
      rowRuns(cells, top, bottom, glass, deep, a, b, (x0, x1) => out.push([x0, x1]));
      return out;
    };
    expect(runs(10, 30, true)).toEqual([[0, 8], [12, 16]]); // the cover's top is the row's bottom: it shows; no glass at 8 … 12 yet
    expect(runs(10, 31, true)).toEqual([[0, 4], [12, 16]]);
    expect(runs(20, 30, true)).toEqual([[0, 16]]);
    expect(runs(10, 30, false)).toEqual([[0, 16]]);
    expect(runs(10, 30, false, 2, 6)).toEqual([[2, 6]]); // clipped to [a, b)
    expect(runs(10, 31, false, 5, 7)).toEqual([]); // nothing of it shows
    // The haze's top at 25: a row ending at it shows; one ending past it, only in the open sky (8 … 12).
    expect(runs(20, 25, true, 0, 16, 25)).toEqual([[0, 16]]);
    expect(runs(20, 26, true, 0, 16, 25)).toEqual([[8, 12]]);
  });
});

describe("the layout", () => {
  it("is world-locked: a span's towers are the same whatever span is asked for — and the same objects, frame after frame", () => {
    const wide = towersOf(reference, noon, -3000, 6000);
    const narrow = towersOf(reference, noon, 437, 1203);
    expect(narrow.length).toBeGreaterThan(2);
    for (const t of narrow) expect(wide).toContain(t);
    expect(towersOf(reference, noon, 437, 1203)).toEqual(narrow);
    narrow.forEach((t, i) => expect(towersOf(reference, noon, 437, 1203)[i]).toBe(t));
  });

  it("is rebuilt for another horizon or another zone (and only then)", () => {
    const a = towersOf(reference, noon);
    expect(towersOf(reference, sky("night"))[0]).toBe(a[0]); // the same zone: the same towers
    // A sky a tile taller (the same zone): taller towers.
    const s = { ...sceneOf(reference, noon), horizon: horizonOf(reference) + TILE };
    const higher: Tower[] = [];
    forEachTower(s, -3000, 6000, (t) => higher.push(t));
    expect(higher[0].x).toBe(a[0].x);
    expect(higher[0].roof).not.toBe(a[0].roof);
    expect(s.horizon - higher[0].roof).toBeGreaterThan(horizonOf(reference) - a[0].roof);
    // Another zone (no Fuji): rebuilt.
    const utc = towersOf(reference, sky("noon", "clear", "UTC"));
    expect(utc[0]).not.toBe(a[0]);
    expect(utc[0]).toEqual(towersOf(reference, undefined)[0]); // as with no zone at all
  });

  it("stands one loose cluster in each 26-tile chunk, 2 tiles in from both ends — sky between clusters; some chunks hold none, some two", () => {
    expect(CHUNK).toBe(26 * TILE);
    const perChunk = new Map<number, number>();
    for (let k = -40; k < 40; k++) perChunk.set(k, 0);
    for (const t of clustersOf(reference, undefined, -40 * CHUNK, 40 * CHUNK)) {
      const k = Math.floor(t.x / CHUNK);
      expect(t.x).toBeGreaterThanOrEqual(k * CHUNK + 2 * TILE);
      expect(t.x + t.w).toBeLessThanOrEqual((k + 1) * CHUNK - 2 * TILE);
      perChunk.set(k, perChunk.get(k)! + 1);
    }
    // …starting anywhere in its chunk's open stretch, not always at its margin.
    const starts = new Set(clustersOf(reference, undefined, -40 * CHUNK, 40 * CHUNK).map((t) => Math.min(...clustersOf(reference, undefined, Math.floor(t.x / CHUNK) * CHUNK, Math.floor(t.x / CHUNK) * CHUNK + CHUNK).map((u) => u.x)) - Math.floor(t.x / CHUNK) * CHUNK));
    expect(starts.size).toBeGreaterThan(15);
    expect(Math.max(...starts)).toBeGreaterThan(8 * TILE);
    // A few big ones: most chunks hold one or none, a few two.
    const counts = [...perChunk.values()];
    expect(Math.max(...counts)).toBe(2);
    expect(counts.filter((n) => n === 0).length).toBeGreaterThan(10);
    expect(counts.reduce((p, q) => p + q, 0) / counts.length).toBeLessThan(1.2);
  });

  it("stands a cluster's towers side by side as designed: 2–8 px of sky between two, or one in front of the other by 8–22 px", () => {
    for (const world of [reference, low]) {
      const all = clustersOf(world, undefined, -160 * CHUNK, 160 * CHUNK);
      const byChunk = new Map<number, Tower[]>();
      for (const t of all) byChunk.set(Math.floor(t.x / CHUNK), [...(byChunk.get(Math.floor(t.x / CHUNK)) ?? []), t]);
      const gaps = new Set<number>();
      for (const ts of byChunk.values()) {
        ts.sort((a, b) => a.x - b.x);
        for (let i = 1; i < ts.length; i++) gaps.add(ts[i].x - (ts[i - 1].x + ts[i - 1].w));
      }
      expect(gaps).toEqual(new Set([-22, -14, -8, 2, 3, 5, 8]));
    }
  });

  it("stands no tower — its mast or tank included — taller than 0.9× the Skytree, in cities of 1–12 floors: drawn down under it, the tallest near it, no flat roofline; the signature min(1.8× its building, that)", () => {
    // No high-rise stands taller than the Skytree, Japan's tallest structure.
    const tokyo = sky("noon");
    let drawn = 0;
    let shrunk = 0;
    for (const world of [reference, low, real, ...SWEEP]) {
      const horizon = horizonOf(world);
      const skytree = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).placed.find((p) => p.spec.kind === "skytree")!;
      const cap = Math.floor(0.9 * skytree.h);
      const free = towersOf(world, undefined, -40 * CHUNK, 40 * CHUNK);
      const kept = towersOf(world, tokyo, -40 * CHUNK, 40 * CHUNK);
      for (const t of kept) expect(horizon - t.peak).toBeLessThanOrEqual(cap);
      // Drawn down, not clipped: the tallest reach up near it (within 0.85 of it), the rest spread below.
      const tall = kept.filter((t) => !isSignature(world, t) && roofLimit(world, tokyo, horizon, t.x, t.x + t.w, ["far"]) === -Infinity);
      if (tall.length >= 8 && free.some((t) => horizon - t.peak > cap)) {
        expect(Math.max(...tall.map((t) => horizon - t.peak))).toBeGreaterThanOrEqual(0.85 * cap);
        drawn++;
      }
      // …and its bottom kept: no tower sinks under the rule's lowest (0.806 × the tallest building), or 0.85 of the
      // cap where that is lower.
      const base = horizon - Math.min(...world.city!.buildings.map((x) => x.row * TILE));
      for (const t of tall) expect(horizon - t.roof).toBeGreaterThanOrEqual(Math.min(Math.floor(0.806 * base), Math.floor(0.85 * cap)) - 1);
      // Under a Skytree drawn smaller (no clear spot for it at full size), the range reaches down toward 0.85 of the
      // cap — seen on the flat-topped ones (a mast's tip lowers its roof under the range, whichever its bottom).
      const flat = tall.filter((t) => t.peak === t.roof);
      if (0.85 * cap < 0.806 * base && flat.length >= 8) {
        expect(Math.min(...flat.map((t) => horizon - t.roof))).toBeLessThan(Math.floor(0.806 * base));
        shrunk++;
      }
      // No flat roofline: never a quarter of them at the top height.
      const tips = kept.filter((t) => !isSignature(world, t)).map((t) => horizon - t.peak);
      if (tips.length >= 8) expect(tips.filter((h) => h === Math.max(...tips)).length / tips.length).toBeLessThan(0.25);
    // The signature: min(1.8× its building, 0.9× the Skytree) — a twin's or a setback's roof is its tip.
      const b = world.city!.buildings.reduce((p, q) => (q.row < p.row ? q : p));
      const sig = kept.find((t) => isSignature(world, t))!;
      if (sig.kind !== "mast" && roofLimit(world, tokyo, horizon, sig.x, sig.x + sig.w, ["far"]) === -Infinity)
        expect(horizon - sig.roof).toBe(Math.min(Math.round(1.8 * (horizon - b.row * TILE)), cap));
    }
    expect(drawn).toBeGreaterThan(5);
    expect(shrunk).toBeGreaterThan(0);
    // With no Skytree (no landmarks), the rule as before: some of the reference city's towers stand over that cap.
    const skytree = placeLandmarks(reference, horizonOf(reference), landmarksFor("Asia/Tokyo")).placed.find((p) => p.spec.kind === "skytree")!;
    expect(towersOf(reference, undefined, -40 * CHUNK, 40 * CHUNK).some((t) => horizonOf(reference) - t.peak > 0.9 * skytree.h)).toBe(true);
    // In the real-shaped city: the signature clearly over gazelle's roof, under the Skytree.
    const g = real.city!.buildings.find((x) => x.key === "gazelle")!;
    const sig = towersOf(real, tokyo).find((t) => isSignature(real, t))!;
    expect(g.row * TILE - sig.peak).toBeGreaterThan(80);
  });

  it("stands a signature skyscraper behind the tallest building: centred on it, over half its width, 1.8× its height — a twin, a setback or a mast, crowned faintly at night, sky either side", () => {
    // A bigger building of this kind stands behind the tallest building (gazelle).
    const utc = sky("night", "clear", "UTC");
    let checked = 0;
    for (const world of [reference, low, ...SWEEP]) {
      const horizon = horizonOf(world);
      const b = world.city!.buildings.reduce((p, q) => (q.row < p.row ? q : p));
      const towers = towersOf(world, utc, -40 * CHUNK, 40 * CHUNK);
      const sigs = towers.filter((t) => isSignature(world, t));
      expect(sigs).toHaveLength(1);
      const [sig] = sigs;
      expect(Math.abs(sig.x + sig.w / 2 - (b.col + b.w / 2) * TILE)).toBeLessThanOrEqual(1);
      expect(sig.w).toBeGreaterThan((b.w * TILE) / 2);
      expect(horizon - sig.roof).toBe(Math.round(1.8 * (horizon - b.row * TILE)));
      expect(["twin", "setback", "mast"]).toContain(sig.kind);
      // Sky either side: no cluster tower within 4 tiles of it.
      for (const t of towers) if (t !== sig) expect(t.x >= sig.x + sig.w + 4 * TILE || t.x + t.w <= sig.x - 4 * TILE).toBe(true);
      checked++;
    }
    expect(checked).toBe(SWEEP.length + 2);
    // A function of the World alone: the same towers from any span, and from a twin World of the same buildings.
    const [a, b] = signatureSpan(reference);
    expect(towersOf(reference, utc, a, b)[0]).toBe(towersOf(reference, utc, -9000, 9000)[0]);
    const twin = { ...reference, city: { ...reference.city!, buildings: [...reference.city!.buildings] } } as World;
    expect(towersOf(twin, utc, a, b)[0]).toEqual(towersOf(reference, utc, a, b)[0]);
    // Crowned at night — faintly — in every city whose signature has a crown band (a mast's antenna is its crown).
    let crowned = 0;
    for (const world of [reference, low, ...SWEEP]) {
      const [x0, x1] = signatureSpan(world);
      const sig = towersOf(world, utc, x0, x1).find((t) => isSignature(world, t))!;
      if (sig.kind === "mast") continue;
      const s = sceneOf(world, utc, { zoom: 1, ox: -x0, oy: 2000 }, { w: x1 - x0, h: 2000 + horizonOf(world) });
      const crowns = lightsOf(s, utc, 0, 1).lights.filter((l) => (TOWER_LIT.crown as readonly string[]).includes(l.color));
      expect(crowns.length).toBeGreaterThan(0);
      for (const l of crowns) expect(l.alpha).toBe(0.3);
      crowned++;
    }
    expect(crowned).toBeGreaterThan(5);
    // Never under 5 tiles wide, however narrow its building (a team of none: 8 tiles).
    const narrow = buildCityWorld([plan(0, 6, 0)]);
    const nb = narrow.city!.buildings[0];
    expect(Math.round(0.55 * nb.w * TILE)).toBeLessThan(5 * TILE);
    const [n0, n1] = signatureSpan(narrow);
    expect(n1 - n0).toBe(5 * TILE);
    expect(towersOf(narrow, utc, n0, n1).some((t) => isSignature(narrow, t))).toBe(true);
    // …and walked only where it stands.
    expect(towersOf(reference, utc, 100_000, 101_000).some((t) => isSignature(reference, t))).toBe(false);
  });

  it("stands its towers against half the sky in a city with no building — and no signature skyscraper", () => {
    const empty = buildCityWorld([]);
    expect(empty.city!.buildings).toHaveLength(0);
    const horizon = horizonOf(empty);
    const towers = towersOf(empty, undefined, -40 * CHUNK, 40 * CHUNK);
    expect(towers.length).toBeGreaterThan(10);
    for (const t of towers) {
      expect(horizon - t.roof).toBeGreaterThanOrEqual(Math.floor(1.3 * 0.62 * ((horizon - TILE) / 2)));
      expect(horizon - t.roof).toBeLessThanOrEqual(Math.round(1.8 * ((horizon - TILE) / 2)));
      // Every one a cluster's: within its chunk's margins.
      const k = Math.floor(t.x / CHUNK);
      expect(t.x + t.w).toBeLessThanOrEqual((k + 1) * CHUNK - 2 * TILE);
    }
    const s = sceneOf(empty, noon);
    TOWERS.paint(s);
    expect(s.ctx.of("fillRect").length).toBeGreaterThan(100);
    expect(TOWERS.faceAt(s, towers[0].x)).toBeLessThan(horizon);
  });

  it("sizes a cluster's towers against the world's tallest building — its tallest 1.3–1.8× as tall, the rest ≥ 62 % of that, all ≥ 2 tiles over the haze; widths 5–10 tiles, never wider than 0.6 of the height", () => {
    // Without a zone (no landmarks), so no tower is lowered under Fuji.
    for (const world of [reference, low]) {
      const horizon = horizonOf(world);
      const tallest = tallestOf(world);
      const towers = clustersOf(world, undefined, -40 * CHUNK, 40 * CHUNK);
      for (const t of towers) {
        const h = horizon - t.roof;
        expect(h).toBeGreaterThanOrEqual(Math.max(skylineMax(horizon) + 2 * TILE, Math.floor(1.3 * 0.62 * tallest)));
        expect(h).toBeLessThanOrEqual(Math.round(1.8 * tallest));
        expect(t.w).toBeGreaterThanOrEqual(Math.min(5 * TILE, Math.round(0.6 * h)));
        expect(t.w).toBeLessThanOrEqual(10 * TILE + 8);
        expect(t.w).toBeLessThanOrEqual(Math.round(0.6 * h));
      }
      // Big buildings behind: the tallest rise well over the tallest building's roof.
      expect(Math.max(...towers.map((t) => horizon - t.roof))).toBeGreaterThan(1.7 * tallest);
    }
    // Under a sky so low that the tallest building is 36 px tall, the haze's clearance holds every tower up:
    // 2 tiles over the haze's tallest block (48 px), never less.
    expect(CLEAR).toBe(2 * TILE);
    const sunk = { ...sceneOf(low, undefined), horizon: low.city!.buildings.reduce((p, q) => (q.row < p.row ? q : p)).row * TILE + 36 };
    const held: number[] = [];
    forEachTower(sunk, -20 * CHUNK, 20 * CHUNK, (t) => {
      if (!isSignature(low, t)) held.push(sunk.horizon - t.roof); // (the signature keeps no clearance: behind its building)
    });
    expect(held.length).toBeGreaterThan(10);
    expect(new Set(held)).toEqual(new Set([skylineMax(sunk.horizon) + 2 * TILE]));
  });

  it("builds all six silhouettes, each as designed", () => {
    const all = towersOf(reference, undefined, -60 * CHUNK, 60 * CHUNK);
    expect(new Set(all.map((t) => t.kind))).toEqual(new Set(TOWER_KINDS));
    const of = (kind: Tower["kind"]) => all.filter((t) => t.kind === kind);
    const tops = (t: Tower) => t.parts.map((p) => p[2]);
    for (const t of of("slab")) {
      // A flat roof the whole width, and a box (a tank or a plant room) standing on it.
      expect(t.parts.some(([a, b, top]) => a === t.x && b - a >= 2 && top === t.roof)).toBe(true);
      expect(t.peak).toBeLessThan(t.roof);
      expect(t.peak).toBeGreaterThanOrEqual(t.roof - 7);
    }
    expect(new Set(of("slab").map((t) => t.roof - t.peak))).toEqual(new Set([4, 7])); // plant rooms and tanks
    for (const t of of("setback")) {
      // Steps up to the roof from both walls, symmetric: the outline rises to the middle and falls again.
      const ys = tops(t);
      const mid = ys.indexOf(t.roof);
      expect(ys.length).toBeGreaterThanOrEqual(5);
      for (let i = 1; i <= mid; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
      for (let i = mid + 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
      expect(ys).toEqual([...ys].reverse());
    }
    for (const t of of("twin")) {
      // Two tops at the roof, a lower notch between them.
      expect(tops(t)).toHaveLength(3);
      expect(tops(t)[0]).toBe(t.roof);
      expect(tops(t)[2]).toBe(t.roof);
      expect(tops(t)[1]).toBeGreaterThan(t.roof);
      expect(t.glass[1][2]).toBe(tops(t)[1] + 2); // …glass under the notch's parapet, none over it
    }
    const slants = of("slant");
    for (const t of slants) {
      // A roof falling one way, a 2-px step at a time.
      const ys = tops(t);
      const rising = ys[0] > ys[ys.length - 1];
      for (let i = 1; i < ys.length; i++) expect(rising ? ys[i] <= ys[i - 1] : ys[i] >= ys[i - 1]).toBe(true);
      for (const [a, b] of t.parts.slice(0, -1)) expect(b - a).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(slants.map((t) => t.parts[0][2] > t.parts[t.parts.length - 1][2]))).toEqual(new Set([true, false]));
    for (const t of of("helipad")) {
      // A deck a px in from both walls, 2 px over the roof's edge.
      expect(t.parts).toEqual([
        [t.x, t.x + 1, t.roof + 2],
        [t.x + 1, t.x + t.w - 1, t.roof],
        [t.x + t.w - 1, t.x + t.w, t.roof + 2],
      ]);
    }
    for (const t of of("mast")) {
      // A 1-px mast standing on a 3-px foot, a light at its tip.
      const i = t.parts.findIndex(([, , top]) => top === t.peak);
      const [mx, mx1] = t.parts[i];
      expect(mx1 - mx).toBe(1);
      expect([t.parts[i - 1][0], t.parts[i + 1][1]]).toEqual([mx - 1, mx + 2]);
      expect([t.parts[i - 1][2], t.parts[i + 1][2]]).toEqual([t.roof - 4, t.roof - 4]);
      expect(t.beacons).toContainEqual([mx, t.peak]);
    }
  });

  it("keeps every roof — masts and tanks too — out of Fuji's snow cap, in cities of 1–12 floors; lowering, or leaving out, a tower that would rise into it", () => {
    let lowered = 0;
    let left = 0;
    const tokyo = sky("noon");
    for (const world of SWEEP) {
      const horizon = horizonOf(world);
      const free = towersOf(world, sky("noon", "clear", "UTC"));
      const kept = towersOf(world, tokyo);
      for (const t of kept) {
        const limit = roofLimit(world, tokyo, horizon, t.x, t.x + t.w, ["far"]);
        expect(t.peak).toBeGreaterThanOrEqual(limit);
        // …never lowered into the haze: a cluster's tower stands 2 tiles over its tallest block.
        if (!isSignature(world, t)) expect(horizon - t.roof).toBeGreaterThanOrEqual(skylineMax(horizon) + 2 * TILE);
        // Lowered right under the cap: a setback (no mast, no tank), its roof at the limit.
        if (t.roof === limit) {
          expect(t.kind).toBe("setback");
          lowered++;
        }
      }
      // Left out where even that would rise into the cap: a chunk never holds more towers in Tokyo than with no landmarks.
      const per = (ts: Tower[]) => {
        const m = new Map<number, number>();
        for (const t of ts) if (!isSignature(world, t)) m.set(Math.floor(t.x / CHUNK), (m.get(Math.floor(t.x / CHUNK)) ?? 0) + 1);
        return m;
      };
      const [pf, pk] = [per(free), per(kept)];
      for (const [k, n] of pf) {
        expect(pk.get(k) ?? 0).toBeLessThanOrEqual(n);
        left += n - (pk.get(k) ?? 0);
      }
    }
    // Both happen in the sweep: the rule is not vacuous.
    expect(lowered).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
  });
});

// ───────────────────────────── each silhouette, up close ─────────────────────────────

/** The grid styles, by hand: [pane pitch, floor pitch, floor line] — a fine grid, vertical fins, ribbon windows. */
const GRID_SPEC = [
  [3, 6, 1],
  [3, 8, 1],
  [9, 6, 2],
] as const;

describe("each silhouette, up close", () => {
  // Every tower of a wide stretch of the reference city's sky, with no zone: none lowered under Fuji.
  const all = towersOf(reference, undefined, -60 * CHUNK, 60 * CHUNK);
  const lone = all.filter((t) => alone(t, all, reference) && hazed(t));
  const horizon = horizonOf(reference);
  const tall = (t: Tower) => horizon - t.roof;
  const of = (kind: Tower["kind"]) => all.filter((t) => t.kind === kind);

  it("crowns a setback, a twin and a slanted roof with 12 % of the height — a slant falling 1 or 1½ of that; a setback in 2 or 3 steps", () => {
    for (const t of of("setback")) expect(t.parts[0][2] - t.roof).toBe(Math.round(tall(t) * 0.12)); // its shoulder, under the steps
    for (const t of of("twin")) expect(t.parts[1][2] - t.roof).toBe(Math.round(tall(t) * 0.12)); // the notch
    expect(new Set(of("setback").map((t) => (t.parts.length - 1) / 2))).toEqual(new Set([2, 3]));
    const falls = of("slant").map((t) => (Math.max(...t.parts.map((p) => p[2])) - t.roof) / Math.round(tall(t) * 0.12));
    for (const f of falls) expect(f < 1.05 ? f > 0.85 : f > 1.3 && f < 1.55).toBe(true);
    expect(falls.some((f) => f < 1.05)).toBe(true);
    expect(falls.some((f) => f > 1.3)).toBe(true);
  });

  it("stands a mast 8–13 % of the height on the roof's middle stretch, and a tank or a plant room on a slab", () => {
    for (const t of of("mast")) {
      expect((t.roof - t.peak) / tall(t)).toBeGreaterThanOrEqual(0.075);
      expect((t.roof - t.peak) / tall(t)).toBeLessThanOrEqual(0.135);
      const mx = t.parts.find((p) => p[2] === t.peak)![0];
      expect(mx).toBeGreaterThanOrEqual(t.x + Math.round(t.w * 0.3));
      expect(mx).toBeLessThanOrEqual(t.x + Math.round(t.w * 0.7));
    }
  });

  it("starts the glass under a 2-px parapet (a slab, a mast), under the deck and its rail (a helipad), under the steps (a setback), in both twin tops, and 1 px under a slanted roof", () => {
    for (const t of all) {
      const [x, x1] = [t.x, t.x + t.w];
      if (t.kind === "slab" || t.kind === "mast") expect(t.glass).toEqual([[x, x1, t.roof + 2]]);
      if (t.kind === "helipad") expect(t.glass).toEqual([[x, x1, t.roof + 4]]);
      if (t.kind === "setback") expect(t.glass).toEqual([[x, x1, t.parts[0][2] + 2]]);
      if (t.kind === "twin") expect(t.glass.map((g) => g[2])).toEqual([t.roof + 3, t.parts[1][2] + 2, t.roof + 3]);
      if (t.kind === "slant") expect(t.glass).toEqual(t.parts.map(([a, b, top]) => [a, b, top + 1]));
      expect(t.top).toBe(Math.min(...t.glass.map((g) => g[2])));
    }
  });

  it("puts the aviation lights 2 px in from a roof's ends — on a setback's top step, on each twin top, at a slanted roof's high end, on a mast's tip — and a crown band on all but the masts", () => {
    for (const t of all) {
      const [x, x1] = [t.x, t.x + t.w];
      const top = t.parts.filter((p) => p[2] === t.roof);
      if (t.kind === "slab" || t.kind === "helipad") expect(t.beacons).toEqual([[x + 2, t.roof], [x1 - 3, t.roof]]);
      if (t.kind === "mast") expect(t.beacons).toEqual([[x + 2, t.roof], [x1 - 3, t.roof], [t.parts.find((p) => p[2] === t.peak)![0], t.peak]]);
      if (t.kind === "setback") expect(t.beacons).toEqual([[top[0][0] + 2, t.roof], [top[0][1] - 3, t.roof]]);
      if (t.kind === "twin") expect(t.beacons).toEqual(top.map(([a, b]) => [a + ((b - a) >> 1), t.roof]));
      if (t.kind === "slant") expect(t.beacons).toEqual([top[0][0] === x ? [x + 2, t.roof] : [x1 - 3, t.roof]]);
      expect(t.crown === null).toBe(t.kind === "mast");
    }
  });

  it("paints a lone tower as designed: the parapet, a frame mullion between pane columns, a floor line every floor, the crown's inks, the H", () => {
    const seen = new Set<string>();
    for (const t of lone) {
      if (seen.has(`${t.kind}${t.grid}`)) continue;
      seen.add(`${t.kind}${t.grid}`);
      const s = sceneOf(reference, undefined, { zoom: 1, ox: -(t.x - 8), oy: -(t.peak - 4) }, { w: t.w + 16, h: horizon - t.peak + 4 });
      TOWERS.paint(s);
      const px = raster(s);
      const ink = TOWER.tints[t.tint];
      const [col, floor, line] = GRID_SPEC[t.grid];
      const n = Math.floor((t.w - 1) / col);
      const off = 1 + ((t.w - 1 - n * col) >> 1);
      const lineY = horizon - skylineMax(horizon);
      const mid = t.x + off + col * (n >> 1); // a pane column in the middle
      const glassAt = (x: number) => t.glass.find(([a, b]) => x >= a && x < b)![2];
      // (A helipad's "H" panel hangs over the middle of its crown.)
      const g = Math.max(glassAt(mid), glassAt(mid - 1), t.kind === "helipad" ? t.roof + 11 : -Infinity);
      // Down the middle pane column: a frame line every floor, glass between, from the glass's top to the haze's.
      for (let y = g; y < lineY - floor; y++) {
        const k = (y - t.top) % floor;
        expect(px.get(`${mid},${y}`)).toBe(k >= floor - line ? ink.frame : ink.glass);
      }
      // The mullion left of it: frame all the way down to the haze's shortest block — glass under that.
      const floorY = horizon - Math.round(skylineMax(horizon) * 0.35);
      for (let y = g + 1; y < floorY; y += 7) expect(px.get(`${mid - 1},${y}`)).toBe(ink.frame);
      expect(px.get(`${mid - 1},${floorY}`)).toBe(ink.glass);
      if (t.kind === "slab" || t.kind === "mast") for (let x = t.x + 1; x < t.x + t.w - 1; x += 5) expect([px.get(`${x},${t.roof}`), px.get(`${x},${t.roof + 1}`)]).toEqual([ink.frame, ink.frame]);
      if (t.kind === "setback") expect(px.get(`${t.x + (t.w >> 1)},${t.roof}`)).toBe(ink.crown);
      if (t.kind === "helipad") {
        const hx = t.x + (t.w >> 1) - 3;
        for (let y = t.roof + 5; y < t.roof + 10; y++) expect([px.get(`${hx},${y}`), px.get(`${hx + 4},${y}`)]).toEqual([TOWER.pad, TOWER.pad]);
        expect([1, 2, 3].map((d) => px.get(`${hx + d},${t.roof + 7}`))).toEqual([TOWER.pad, TOWER.pad, TOWER.pad]);
        expect([px.get(`${hx + 2},${t.roof + 5}`), px.get(`${hx - 1},${t.roof + 4}`)]).toEqual([TOWER.panel, TOWER.panel]);
        expect(px.get(`${hx},${t.roof}`)).toBe(TOWER.pad); // the deck
      }
      if (t.kind === "mast") expect(px.get(`${t.parts.find((p) => p[2] === t.peak)![0]},${t.peak}`)).toBe(TOWER.mast);
      // The sun-side edge (left with no sun), down to the haze's shortest block — no further.
      expect(px.get(`${t.x},${floorY - 1}`)).toBe(ink.edge);
      expect(px.get(`${t.x},${floorY}`)).toBe(ink.glass);
    }
    expect(new Set([...seen].map((k) => k.slice(0, -1)))).toEqual(new Set(TOWER_KINDS));
  });

  it("shows all of a tower in the open sky between the clusters (no haze in front): its mullions, floor lines and lit floors reach the street there, and stop at the haze behind it", () => {
    // Lone towers standing partly in the open sky, partly behind the haze.
    const both = all.filter((t) => alone(t, all, reference) && !hazed(t) && !open(t.x, t.x + t.w));
    expect(both.length).toBeGreaterThan(3);
    const lineY = horizon - skylineMax(horizon);
    const floorY = horizon - Math.round(skylineMax(horizon) * 0.35);
    for (const t of both.slice(0, 4)) {
      const s = sceneOf(reference, undefined, { zoom: 1, ox: -t.x, oy: -(t.peak - 4) }, { w: t.w, h: horizon - t.peak + 4 });
      TOWERS.paint(s);
      const px = raster(s);
      const ink = TOWER.tints[t.tint];
      // Every column's lowest frame pixel: down at the street in the open, at the haze behind it.
      for (let x = t.x + 1; x < t.x + t.w - 1; x++) {
        let low = -1;
        for (let y = horizon - 1; y > t.top; y--)
          if (px.get(`${x},${y}`) === ink.frame) {
            low = y;
            break;
          }
        if (open(x, x + 1)) expect(low).toBeGreaterThan(horizon - 8);
        else expect(low).toBeLessThan(floorY);
      }
      // The sun-side edge (the left, with no sun) the same: to the street in the open, the haze's floor behind it.
      let edge = -1;
      for (let y = t.top; y < horizon; y++) if (px.get(`${t.x},${y}`) === ink.edge) edge = y;
      expect(edge).toBe(open(t.x, t.x + 1) ? horizon - 1 : floorY - 1);
      // Lit (every floor), the floors below the haze's top are in the open sky alone — and there are some.
      const utc = sky("night", "clear", "UTC"); // no Fuji: the same towers as with no zone
      const s2 = sceneOf(reference, utc, { zoom: 1, ox: -t.x, oy: -(t.peak - 4) }, { w: t.w, h: horizon - t.peak + 4 });
      const low = lightsOf(s2, utc, 1, 0).lights.filter((l) => l.y + l.h > lineY);
      expect(low.length).toBeGreaterThan(0);
      for (const l of low) expect(open(l.x, l.x + l.w)).toBe(true);
    }
  });

  it("gives every cluster its tallest tower at the district's height — 1.3 to 1.8× the tallest building's, a whole percent", () => {
    const building = tallestOf(reference);
    const districts = new Set(Array.from({ length: 51 }, (_, j) => Math.round(((130 + j) / 100) * building)));
    const clusters = new Map<number, number>();
    for (const t of all.filter((u) => !isSignature(reference, u))) clusters.set(Math.floor(t.x / CHUNK), Math.max(clusters.get(Math.floor(t.x / CHUNK)) ?? 0, tall(t)));
    for (const h of clusters.values()) expect(districts.has(h)).toBe(true);
    expect(Math.min(...clusters.values())).toBeLessThan(Math.round(1.4 * building)); // …and districts of every height
    expect(Math.max(...clusters.values())).toBeGreaterThan(Math.round(1.7 * building));
  });

  it("paints a cluster's nearer towers in front, a shade darker: never a farther (lightest) one over a nearer — and both darker tints occur", () => {
    let pairs = 0;
    all.forEach((back, i) =>
      all.slice(i + 1).forEach((front) => {
        if (front.x >= back.x + back.w || back.x >= front.x + front.w) return;
        pairs++;
        expect(back.tint > 0 && front.tint === 0).toBe(false);
      }),
    );
    expect(pairs).toBeGreaterThan(10);
    expect(new Set(all.map((t) => t.tint))).toEqual(new Set([0, 1, 2]));
  });
});

// ───────────────────────────── by day ─────────────────────────────

describe("by day", () => {
  it("paints nothing off the view — and nothing at all with the view under the street", () => {
    for (const cam of [{ zoom: 1, ox: 448, oy: 300 }, { zoom: 2, ox: -900, oy: -1100 }, { zoom: 0.5, ox: 300, oy: 40 }]) {
      const s = sceneOf(reference, noon, cam, { w: 1280, h: 800 });
      TOWERS.paint(s);
      expect(s.ctx.of("fillRect").length).toBeGreaterThan(20);
      for (const c of s.ctx.of("fillRect")) {
        const [x, y, w, h] = c.args as number[];
        expect(x < 1280 && x + w > 0 && y < 800 && y + h > 0).toBe(true);
      }
    }
    // A view whose left edge cuts through a tower and whose bottom cuts across it, zoomed out: still
    // nothing off it, and every fill at least a whole px.
    const t = towersOf(reference, noon, -448, 2112).find((u) => u.cover.length === 1)!;
    for (const zoom of [1, 0.5]) {
      const s = sceneOf(reference, noon, { zoom, ox: -(t.x + 5) * zoom, oy: -(t.peak - 20) * zoom }, { w: 600, h: Math.round((t.roof + 80 - t.peak) * zoom) });
      TOWERS.paint(s);
      expect(s.ctx.of("fillRect").length).toBeGreaterThan(10);
      for (const c of s.ctx.of("fillRect")) {
        const [x, y, w, h] = c.args as number[];
        expect(x >= 0 && x < 600 && y >= 0 && y < s.view.h).toBe(true);
        expect(Math.min(w, h)).toBeGreaterThanOrEqual(1);
      }
    }
    // Zoomed in on the lounge, the street's top above the view: no tower stands there.
    const under = sceneOf(reference, noon, { zoom: 2, ox: -500, oy: -2 * horizonOf(reference) - 10 }, { w: 1280, h: 800 });
    TOWERS.paint(under);
    expect(under.ctx.calls).toHaveLength(0);
  });

  it("paints the DAY colours at noon, at the alpha the landmarks' towers have in each weather", () => {
    const s = sceneOf(reference, noon);
    TOWERS.paint(s);
    for (const c of s.ctx.of("fillRect")) {
      expect(DAY_COLOURS.has(c.fillStyle)).toBe(true);
      expect(c.alpha).toBe(1);
    }
    for (const [weather, alpha] of [
      ["clear", 1],
      ["cloudy", 1],
      ["drizzle", 0.9],
      ["snow", 0.85],
      ["rain", 0.8],
      ["storm", 0.7],
      ["fog", 0.5],
    ] as const) {
      const w = sceneOf(reference, sky("noon", weather));
      TOWERS.paint(w);
      expect(new Set(w.ctx.of("fillRect").map((c) => c.alpha))).toEqual(new Set([alpha]));
      expect(w.ctx.globalAlpha).toBe(1); // left as it was found
    }
    // No sky at all (the plain day): the DAY colours too.
    const plain = sceneOf(reference, undefined);
    TOWERS.paint(plain);
    for (const c of plain.ctx.of("fillRect")) expect(DAY_COLOURS.has(c.fillStyle)).toBe(true);
  });

  it("turns its colours through the day as the haze's own colour turns: each channel by the haze's ratio to its day colour", () => {
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    for (const phase of ["night", "dusk", "evening"] as const) {
      const amb = sky(phase);
      const haze = rgb(citySky(amb).skyline.block);
      const day = rgb(CITY_DAY.skyline);
      const turn = (c: string) => `#${rgb(c).map((v, i) => Math.min(255, Math.round((v * haze[i]) / day[i])).toString(16).padStart(2, "0")).join("")}`;
      const s = sceneOf(reference, amb);
      TOWERS.paint(s);
      const want = new Set([...DAY_COLOURS].map(turn));
      const got = new Set(s.ctx.of("fillRect").map((c) => c.fillStyle));
      for (const c of got) expect(want.has(c)).toBe(true);
      expect(got.has(turn(TOWER.tints[0].glass))).toBe(true);
      // Darker than by day at night: the haze's navy.
      if (phase === "night") expect(rgb(turn(TOWER.tints[0].glass))[0]).toBeLessThan(rgb(TOWER.tints[0].glass)[0] / 2);
    }
  });

  it("paints its face exactly: the topmost painted pixel of every column is `faceAt`, opaque down to the street — the street's top where nothing stands", () => {
    // Left of the low city, where no building stands in front: the whole face shows, its sky 400 px over the world's top.
    const cam: Camera = { zoom: 1, ox: 2400, oy: 400 };
    const horizon = horizonOf(low);
    const s = sceneOf(low, noon, cam, { w: 2560, h: 400 + horizon });
    TOWERS.paint(s);
    const px = raster(s);
    let standing = 0;
    for (let x = -2400; x < 0; x++) {
      const face = TOWERS.faceAt(s, x);
      let top = horizon;
      for (let y = -400; y < horizon; y++)
        if (px.has(`${x},${y}`)) {
          top = y;
          break;
        }
      expect(top).toBe(face);
      // Opaque down to the street (in the open sky) or the haze's floor, where the mullions end and the glass reaches on.
      for (let y = face; y < horizon; y++) expect(px.has(`${x},${y}`)).toBe(true);
      if (face < horizon) standing++;
    }
    expect(standing).toBeGreaterThan(400); // towers do stand there
  });

  it("is world-locked: a pan moves it by exactly the pan, a zoom keeps every world pixel its colour", () => {
    // The low city, its sky shown 400 px over the world's top: every tower whole.
    const a = sceneOf(low, noon, { zoom: 1, ox: 448, oy: 400 }, { w: 2560, h: 700 });
    const b = sceneOf(low, noon, { zoom: 1, ox: 411, oy: 387 }, { w: 2560, h: 700 });
    const c = sceneOf(low, noon, { zoom: 2, ox: -600, oy: 800 }, { w: 2560, h: 1400 });
    for (const s of [a, b, c]) TOWERS.paint(s);
    const [pa, pb, pc] = [raster(a), raster(b), raster(c)];
    let shared = 0;
    for (const [k, color] of pb)
      if (pa.has(k)) {
        expect(pa.get(k)).toBe(color);
        shared++;
      }
    for (const [k, color] of pc)
      if (pa.has(k)) {
        expect(pa.get(k)).toBe(color);
        shared++;
      }
    expect(shared).toBeGreaterThan(50_000);
    // A view whose bottom and left edges run through the towers paints exactly the whole view's pixels there.
    for (const [ox, bottom] of [
      [448 - 301, 100],
      [448 - 517, 17],
    ]) {
      const d = sceneOf(low, noon, { zoom: 1, ox, oy: 400 }, { w: 2560 - (448 - ox), h: 400 + bottom });
      TOWERS.paint(d);
      const pd = raster(d);
      for (const [k, color] of pa) {
        const [x, y] = k.split(",").map(Number);
        if (y < bottom && x >= -ox) expect(pd.get(k)).toBe(color);
      }
      expect(pd.size).toBeLessThanOrEqual(pa.size);
    }
  });

  it("paints nothing behind the world's buildings, nor a farther tower behind a nearer one", () => {
    const s = sceneOf(reference, noon);
    TOWERS.paint(s);
    const walls = wallsOf(reference);
    const boxes = boxesOf(s);
    for (const b of boxes) for (const w of walls) expect(overlaps(b, w)).toBe(false);
    // Towers do stand behind gazelle — wholly, or partly: their outlines stop at its roof.
    const gazelle = walls.reduce((p, q) => (q.h > p.h ? q : p));
    const behind = towersOf(reference, noon).filter((t) => t.x < gazelle.x + gazelle.w && t.x + t.w > gazelle.x);
    expect(behind.length).toBeGreaterThan(0);
    // A cluster's overlapping towers: the farther one's rects stop at the nearer one's outline.
    const all = towersOf(reference, noon, -40 * CHUNK, 40 * CHUNK);
    let pairs = 0;
    all.forEach((far, i) =>
      all.slice(i + 1).forEach((near) => {
        if (near.x >= far.x + far.w || far.x >= near.x + near.w) return;
        pairs++;
        for (const [a, b2, top] of near.parts)
          if (a < far.x + far.w && b2 > far.x) expect(far.cover.some(([p, q, o]) => p < b2 && q > a && o <= top)).toBe(true);
      }),
    );
    expect(pairs).toBeGreaterThan(0);
  });

  it("cuts a detail exactly where a building's roof crosses it: a parapet half under a roof keeps its upper row", () => {
    // A slab, a mast or a helipad whose parapet or deck (its roof's top 2 rows) a building's roof would cut in two.
    // (Lower than the tallest building, which stays: its height sizes the towers, the signature stands behind it.)
    const city = low.city!;
    const tallest = city.buildings.reduce((p, q) => (q.row < p.row ? q : p));
    const all = towersOf(low, undefined, -200 * CHUNK, 200 * CHUNK);
    const t = all.find((u) => (u.kind === "slab" || u.kind === "mast" || u.kind === "helipad") && u.roof + 1 > tallest.row * TILE && alone(u, all, low))!;
    expect(t).toBeDefined();
    // (A roof between tile rows: a cover is only ever a world y.)
    const wall = { ...city.buildings[0], col: Math.floor(t.x / TILE) - 1, w: Math.ceil(t.w / TILE) + 2, row: (t.roof + 1) / TILE };
    const cut = { ...low, city: { ...city, buildings: [tallest, wall] } } as World;
    const s = sceneOf(cut, undefined, { zoom: 1, ox: -(t.x - 20), oy: 0 }, { w: t.w + 40, h: horizonOf(low) });
    TOWERS.paint(s);
    const px = raster(s);
    const marks = new Set([TOWER.tints[t.tint].frame, TOWER.mast, TOWER.tank, TOWER.pad, TOWER.tints[t.tint].crown]);
    for (let x = t.x + 1; x < t.x + t.w - 1; x++) {
      expect(marks.has(px.get(`${x},${t.roof}`)!)).toBe(true); // the parapet's upper row (or what stands on it)
      expect(px.has(`${x},${t.roof + 1}`)).toBe(false); // under the building's roof: nothing
    }
  });

  it("hides only what the world's buildings cover: outside them, the towers are pixel for pixel what they are with no building at all", () => {
    // The low city with its tallest building alone (its height sizes the towers; the signature stands behind it)…
    const city = low.city!;
    const tallest = city.buildings.reduce((p, q) => (q.row < p.row ? q : p));
    const bare = { ...low, city: { ...city, buildings: [tallest] } } as World;
    const cam: Camera = { zoom: 1, ox: 448, oy: 400 };
    const view = { w: 2560, h: 700 };
    const [built, open] = [sceneOf(low, undefined, cam, view), sceneOf(bare, undefined, cam, view)];
    TOWERS.paint(built);
    TOWERS.paint(open);
    // …against the others, which stand in front of the towers.
    const walls = wallsOf(low).filter((w) => w.x !== tallest.col * TILE);
    const a = raster(built);
    const b = raster(open);
    // Nothing the built city paints differs from the open one…
    for (const [k, color] of a) expect(b.get(k)).toBe(color);
    // …it paints nothing in a building's box, and all the rest — but for a floor line straddling a roof, dropped (≤ 1 px over it).
    let hidden = 0;
    for (const k of b.keys()) {
      const [x, y] = k.split(",").map(Number);
      const wall = walls.find((w) => x >= w.x && x < w.x + w.w && y >= w.y - 1);
      if (!wall) expect(a.has(k)).toBe(true);
      else if (y >= wall.y) hidden++;
    }
    expect(hidden).toBeGreaterThan(1_000);
    // …and its lights the same: every light of the open city clear of the buildings is lit in the built one.
    const utc = sky("night", "clear", "UTC");
    const key = (l: Light) => `${l.x},${l.y},${l.w},${l.h},${l.color}`;
    const lit = new Set(lightsOf(sceneOf(low, utc, cam, view), utc, 0.4, 1).lights.map(key));
    let clear = 0;
    for (const l of lightsOf(sceneOf(bare, utc, cam, view), utc, 0.4, 1).lights)
      if (!walls.some((w) => overlaps(l, w))) {
        clear++;
        expect(lit.has(key(l))).toBe(true);
      }
    expect(clear).toBeGreaterThan(50);
  }, 30_000);

  it("paints a whole #rrggbb colour at every minute of the day, in every weather (no channel ever past ff)", () => {
    for (const weather of ["clear", "cloudy", "rain", "fog", "snow", "storm", "drizzle"] as const)
      for (let m = 0; m < 24 * 60; m += 20) {
        const amb = computeAmbience(new Date(2026, 9, 27, Math.floor(m / 60), m % 60), null, { weather, phase: "auto" }, "Asia/Tokyo");
        const s = sceneOf(low, amb, { zoom: 1, ox: 3000, oy: 0 }, { w: 2560, h: horizonOf(low) });
        TOWERS.paint(s);
        for (const c of s.ctx.of("fillRect")) expect(c.fillStyle).toMatch(/^#[0-9a-f]{6}$/);
      }
  });

  it("lays a mullion between every two pane columns — zoomed out (below ¾), at the walls only — and floor lines across, every other one zoomed out", () => {
    // One tower alone in a view exactly its width, sky above it to the haze's top.
    const all = towersOf(low, undefined, -20000, 20000);
    const t = all.find((u) => u.kind === "slab" && alone(u, all, low))!;
    const horizon = horizonOf(low);
    const count = (zoom: number) => {
      const s = sceneOf(low, undefined, { zoom, ox: -(t.x - 40) * zoom, oy: -(t.peak - 4) * zoom }, { w: (t.w + 80) * zoom, h: (horizon - t.peak + 4) * zoom });
      TOWERS.paint(s);
      // Its own (zoomed out, a world x maps back to the even px under it).
      const mine = (c: DrawCall) => box(c, s.cam).x >= t.x - 1 && box(c, s.cam).x < t.x + t.w;
      const frame = s.ctx.of("fillRect").filter((c) => c.fillStyle === TOWER.tints[t.tint].frame && mine(c));
      // The floor lines: wide, low, under the parapet.
      const lines = frame.filter((c) => (c.args[2] as number) > 1 && (c.args[3] as number) <= Math.max(1, 2 * zoom) && box(c, s.cam).y > t.roof + 1);
      return { mullions: frame.filter((c) => (c.args[2] as number) <= 1).length, lines: lines.length };
    };
    const [col, floor] = [[3, 6], [3, 8], [9, 6]][t.grid];
    const n = Math.floor((t.w - 1) / col);
    const glassRows = horizon - skylineMax(horizon) - (t.roof + 2);
    const fine = count(1);
    expect(fine.mullions).toBe(n + 1);
    expect(fine.lines).toBeGreaterThanOrEqual(Math.floor(glassRows / floor) - 1);
    expect(fine.lines).toBeLessThanOrEqual(Math.ceil(glassRows / floor) + 1);
    expect(count(0.75).mullions).toBe(n + 1); // ¾ is fine enough for panes (render/city.ts's PANE_ZOOM)
    const coarse = count(0.5);
    expect(coarse.mullions).toBe(2);
    expect(Math.abs(coarse.lines - fine.lines / 2)).toBeLessThanOrEqual(1);
  });

  it("lights the sun's side: the left wall while the sun climbs, the right from noon — the left with no sun", () => {
    const edges = (amb: Ambience | undefined) => {
      const s = sceneOf(reference, amb);
      TOWERS.paint(s);
      const edgeColours = new Set(TOWER.tints.map((tt) => tt.edge));
      return new Set(s.ctx.of("fillRect").filter((c) => edgeColours.has(c.fillStyle) && (c.args[2] as number) === 1).map((c) => box(c, s.cam).x));
    };
    const towers = towersOf(reference, noon, -448, 2112);
    const noArc: Ambience = { ...noon };
    delete noArc.arc;
    const morning = { ...noon, arc: { body: "sun" as const, t: 0.3 } };
    const afternoon = { ...noon, arc: { body: "sun" as const, t: 0.7 } };
    const left = edges(morning);
    const right = edges(afternoon);
    expect(towers.filter((t) => left.has(t.x)).length).toBeGreaterThan(3);
    expect(towers.filter((t) => right.has(t.x + t.w - 1)).length).toBeGreaterThan(3);
    for (const t of towers) {
      expect(left.has(t.x + t.w - 1)).toBe(false);
      expect(right.has(t.x)).toBe(false);
    }
    expect(edges(noArc)).toEqual(left);
    expect(edges({ ...noon, arc: { body: "sun", t: 0.5 } })).toEqual(right); // from noon on
    expect(edges({ ...noon, arc: { body: "moon", t: 0.7 } })).toEqual(left);
  });
});

// ───────────────────────────── by night ─────────────────────────────

describe("by night", () => {
  it("lights nothing by day (noon) — and from golden hour, before dark, office floors only", () => {
    const s = sceneOf(reference, noon);
    const { lights } = lightsOf(s, noon, 0, 0);
    expect(lights).toHaveLength(0);
    expect(s.ctx.calls).toHaveLength(0);
    const golden = lightsOf(sceneOf(reference, sky("evening")), sky("evening"), 0.12, 0).lights;
    expect(golden.length).toBeGreaterThan(0);
    expect(new Set(golden.map((l) => l.color))).toEqual(new Set([TOWER_LIT.cool, TOWER_LIT.warm]));
  });

  it("puts every light through fillLit — never a fill of its own — and leaves the alpha as it found it", () => {
    const s = sceneOf(reference, night);
    const { lights } = lightsOf(s, night, 0.4, 1);
    expect(lights.length).toBeGreaterThan(100);
    expect(s.ctx.of("fillRect")).toHaveLength(0);
    expect(s.ctx.globalAlpha).toBe(1);
  });

  it("lights the same floors first every evening: the floors lit at a lower share are all still lit at a higher one", () => {
    const at = (lit: number) =>
      new Set(
        lightsOf(sceneOf(reference, night), night, lit, 1)
          .lights.filter((l) => l.color === TOWER_LIT.cool || l.color === TOWER_LIT.warm)
          .map((l) => `${l.x},${l.y},${l.w}`),
      );
    const few = at(0.1);
    const more = at(0.25);
    const most = at(0.4);
    expect(few.size).toBeGreaterThan(10);
    expect(more.size).toBeGreaterThan(few.size);
    expect(most.size).toBeGreaterThan(more.size);
    for (const k of few) expect(more.has(k)).toBe(true);
    for (const k of more) expect(most.has(k)).toBe(true);
  });

  it("lights single windows, dim — a warm mostly, some cool white — only on glass that shows, never on a building in front", () => {
    const s = sceneOf(reference, night);
    const windows = lightsOf(s, night, 0.4, 1).lights.filter((l) => l.color === TOWER_LIT.cool || l.color === TOWER_LIT.warm);
    expect(windows.length).toBeGreaterThan(200);
    const cool = windows.filter((l) => l.color === TOWER_LIT.cool).length;
    expect(cool / windows.length).toBeGreaterThan(0.15);
    expect(cool / windows.length).toBeLessThan(0.35);
    const towers = towersOf(reference, night, -448, 2112);
    /** On the glass of tower `t`, under nothing in front of it. */
    const onGlass = (t: Tower, l: Light) => l.x >= t.x && l.x + l.w <= t.x + t.w && t.cells.every(([a, b, g, o]) => a >= l.x + l.w || b <= l.x || (g <= l.y && o >= l.y + l.h));
    for (const l of windows) {
      expect(Math.max(l.w, l.h)).toBeLessThanOrEqual(2); // one window — never a floor-wide bar
      expect(towers.some((t) => onGlass(t, l))).toBe(true);
      for (const w of wallsOf(reference)) expect(overlaps(l, w)).toBe(false);
      // Dim: the farthest layer, under the apartments, the canyon and the shops (0.9).
      expect(l.alpha).toBeGreaterThanOrEqual(0.35);
      expect(l.alpha).toBeLessThanOrEqual(0.55);
      // Below the haze's tallest block, only in the open sky: behind the haze, its own windows are lit there.
      if (l.y + l.h > horizonOf(reference) - skylineMax(horizonOf(reference))) expect(open(l.x, l.x + l.w)).toBe(true);
    }
    // …each at a brightness of its own, across that range.
    const alphas = windows.map((l) => l.alpha);
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.15);
    expect(new Set(alphas).size).toBeGreaterThan(10);
  });

  it("lights an eighth of its windows at full night — a 2×2 light in every third pane, one a floor — some floors dark, some busy", () => {
    // Lone towers across 60 chunks (no zone: none lowered), their floors under every crown.
    const span = 60 * CHUNK;
    const utc = sky("night", "clear", "UTC");
    const s = sceneOf(low, utc, { zoom: 1, ox: span / 2, oy: 600 }, { w: span, h: 600 + horizonOf(low) });
    const all = towersOf(low, utc, -span / 2, span / 2);
    const { lights } = lightsOf(s, utc, 0.4, 0); // full night's windows, no beacon nor crown
    const lineY = horizonOf(low) - skylineMax(horizonOf(low));
    let [lit, windows] = [0, 0];
    const perFloor: number[] = [];
    // (Its rows over the haze's top: lit alike behind the haze and in the open sky.)
    for (const t of all.filter((u) => alone(u, all, low))) {
      const [col, floor] = GRID_SPEC[t.grid];
      const n = Math.floor((t.w - 1) / col);
      const first = t.x + 1 + ((t.w - 1 - n * col) >> 1); // the first pane's left edge
      const across = Math.floor((n * col - 3) / 9) + 1; // its windows on a floor, every 9 px
      const below = Math.max(...t.glass.map((g) => g[2]));
      for (let y = t.top + 1; y + 2 <= lineY; y += floor) {
        if (y < below) continue;
        const mine = lights.filter((l) => l.y === y && l.x >= t.x && l.x < t.x + t.w);
        for (const l of mine) {
          expect([l.w, l.h]).toEqual([2, 2]);
          expect((l.x - first) % 9).toBe(0);
          expect(l.x + 2).toBeLessThanOrEqual(first + n * col - 1); // inside the panes, never on the wall's mullion
        }
        lit += mine.length;
        windows += across;
        perFloor.push(mine.length / across);
      }
    }
    expect(windows).toBeGreaterThan(1000);
    // Big towers, many windows: few lit, the night calm (0.3 of `lit`, 0.4 at full night).
    expect(lit / windows).toBeGreaterThan(0.08);
    expect(lit / windows).toBeLessThan(0.16);
    // Scattered, not in columns: no window lit on most of a tower's floors.
    for (const t of all.filter((u) => alone(u, all, low))) {
      const mine = lights.filter((l) => l.x >= t.x && l.x < t.x + t.w && l.y + 2 <= lineY);
      const floors = new Set(mine.map((l) => l.y)).size;
      const perColumn = new Map<number, number>();
      for (const l of mine) perColumn.set(l.x, (perColumn.get(l.x) ?? 0) + 1);
      if (floors >= 15) for (const n of perColumn.values()) expect(n).toBeLessThan(0.65 * floors);
    }
    // Floors dark and floors busy: not a uniform sprinkle.
    expect(perFloor.filter((f) => f === 0).length / perFloor.length).toBeGreaterThan(0.3);
    expect(perFloor.filter((f) => f >= 0.2).length / perFloor.length).toBeGreaterThan(0.08);
  });

  it("lights the very same windows at every zoom: ×1 and ×2 light the same world px", () => {
    const all = towersOf(reference, night, -3000, 6000);
    const t = all.find((u) => alone(u, all, reference) && hazed(u) && u.w >= 96)!;
    const lit = (zoom: number) => lightsOf(sceneOf(reference, night, { zoom, ox: -t.x * zoom, oy: -(t.top - 1) * zoom }, { w: t.w * zoom, h: 300 * zoom }), night, 0.4, 0).lights;
    expect(lit(1).length).toBeGreaterThan(10);
    expect(lit(2)).toEqual(lit(1));
  });

  it("is world-locked: a view cut through a tower lights the very pixels a whole view lights there", () => {
    const whole = lightsOf(sceneOf(reference, night), night, 0.4, 1).lights;
    // Views whose top edge runs through floors, crowns and glows at every height (the tallest crowns ≈ 900 px
    // over the world's top), their left 290 px in.
    for (let top = -901; top < 760; top += 7) {
      const cut = lightsOf(sceneOf(reference, night, { zoom: 1, ox: 448 - 290, oy: -top }, { w: 2560 - 290, h: 1600 - top }), night, 0.4, 1).lights;
      const clip = (l: Light) => {
        const [x, y] = [Math.max(l.x, -158), Math.max(l.y, top)];
        return { ...l, x, y, w: l.x + l.w - x, h: l.y + l.h - y };
      };
      expect(cut).toEqual(whole.map(clip).filter((l) => l.w > 0 && l.h > 0));
    }
    // …and views whose bottom edge runs across the haze's top, every window lit: a window straddling it is
    // dark in the cut view as in the whole (behind the haze, none reaches below its top).
    // (Across 40,000 px of sky: dozens of towers, some with a floor of windows right across that row.)
    const lineY = horizonOf(reference) - skylineMax(horizonOf(reference));
    const wide: Camera = { zoom: 1, ox: 20_000, oy: 1000 };
    const all = lightsOf(sceneOf(reference, night, wide, { w: 40_000, h: 2000 }), night, 1, 0).lights;
    for (let bottom = lineY - 3; bottom <= lineY + 3; bottom++) {
      const cut = lightsOf(sceneOf(reference, night, wide, { w: 40_000, h: wide.oy + bottom }), night, 1, 0).lights;
      const clip = (l: Light) => ({ ...l, h: Math.min(l.y + l.h, bottom) - l.y });
      expect(cut).toEqual(all.map(clip).filter((l) => l.h > 0));
    }
    // Windows behind the haze whose rows would cross its top are there to be left dark.
    const towers = towersOf(reference, night, -20_000, 20_000).filter((t) => hazed(t) && t.cover.length === 1);
    expect(towers.some((t) => (lineY - 2 - t.top) % GRID_SPEC[t.grid][1] === 0)).toBe(true);
  });

  it("comes on with the dark: the beacons and crowns at twice the dark's measure, full from half-dark — a quarter of the towers crowned, faintly, in both colours", () => {
    const at = (dark: number) => lightsOf(sceneOf(reference, night), night, 0, dark).lights;
    const cores = (dark: number) => at(dark).filter((l) => l.color === AVIATION.core);
    expect(new Set(cores(0.25).map((l) => l.alpha))).toEqual(new Set([0.5]));
    expect(new Set(cores(0.5).map((l) => l.alpha))).toEqual(new Set([1]));
    expect(new Set(cores(1).map((l) => l.alpha))).toEqual(new Set([1]));
    // Crowns across 120 chunks: a quarter of the towers that have a crown band (all but the masts), cool white and pale blue, faint.
    const span = 120 * CHUNK;
    const s = sceneOf(low, night, { zoom: 1, ox: span / 2, oy: 600 }, { w: span, h: 600 + horizonOf(low) });
    const all = towersOf(low, night, -span / 2, span / 2);
    const crowns = lightsOf(s, night, 0, 1).lights.filter((l) => (TOWER_LIT.crown as readonly string[]).includes(l.color));
    const lone = all.filter((t) => alone(t, all, low) && t.crown);
    const crowned = lone.filter((t) => crowns.some((l) => l.x >= t.x && l.x < t.x + t.w));
    expect(crowned.length / lone.length).toBeGreaterThan(0.17);
    expect(crowned.length / lone.length).toBeLessThan(0.33);
    expect(new Set(crowns.map((l) => l.color))).toEqual(new Set(TOWER_LIT.crown));
    for (const l of crowns) expect(l.alpha).toBe(0.3);
  });

  it("blinks red aviation lights on the roofs and masts, each on its own phase, and lights some of the crowns — once it is dark", () => {
    const beaconsAt = (timeMs: number) =>
      lightsOf(sceneOf(reference, night, FIT, VIEW, timeMs), night, 0, 1)
        .lights.filter((l) => l.color === AVIATION.core)
        .map((l) => `${l.x},${l.y}`);
    const seen = new Set<string>();
    const counts: number[] = [];
    for (let t = 0; t < BLINK_MS; t += 100) {
      const on = beaconsAt(t);
      on.forEach((k) => seen.add(k));
      counts.push(on.length);
    }
    // Every light is on half the time, on its own phase: never all at once, never none.
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThan(seen.size);
    // Every beacon nothing stands in front of comes on: two on a roof, one on a slanted one's high end, one on a mast's tip.
    const towers = towersOf(reference, night, -448, 2112);
    let open = 0;
    for (const t of towers) {
      expect(t.beacons.length).toBe({ slab: 2, setback: 2, twin: 2, slant: 1, helipad: 2, mast: 3 }[t.kind]);
      for (const [bx, by] of t.beacons)
        if (t.cover.every(([a, b, o]) => a >= bx + 3 || b <= bx - 1 || o >= by + 2)) {
          open++;
          expect(seen.has(`${bx},${by - 1}`)).toBe(true);
        }
    }
    expect(open).toBeGreaterThan(towers.length);
    // Each a 2×2 red core in a 4×4 glow.
    const { lights } = lightsOf(sceneOf(reference, night), night, 0, 1);
    const glows = lights.filter((l) => l.color === AVIATION.glow);
    const cores = lights.filter((l) => l.color === AVIATION.core && l.w === 2 && l.h === 2);
    expect(cores.length).toBeGreaterThan(5);
    for (const c of cores) expect(glows).toContainEqual({ ...c, x: c.x - 1, y: c.y - 1, w: 4, h: 4, color: AVIATION.glow });
    // The crown bands: cool white or pale blue, on about a third of the towers.
    const crowns = lights.filter((l) => (TOWER_LIT.crown as readonly string[]).includes(l.color));
    const crowned = towers.filter((t) => crowns.some((l) => l.x >= t.x && l.x < t.x + t.w));
    expect(crowned.length).toBeGreaterThan(0);
    expect(crowned.length).toBeLessThan(towers.length);
    // Before dark (golden hour), none of it.
    expect(lightsOf(sceneOf(reference, sky("evening")), sky("evening"), 0, 0).lights).toHaveLength(0);
  });

  it("dims its lights with the weather, never under 0.6 — and lights nothing off the view", () => {
    const fog = sky("night", "fog");
    const misty = lightsOf(sceneOf(reference, fog), fog, 0.4, 1).lights;
    for (const l of misty) expect(l.alpha).toBeLessThanOrEqual(0.6);
    expect(Math.max(...misty.map((l) => l.alpha))).toBe(0.6); // the beacons, at full strength: 0.6 of the dark
    const cam: Camera = { zoom: 2, ox: -1500, oy: -900 };
    const s = sceneOf(reference, night, cam, { w: 1280, h: 800 });
    const { lights } = lightsOf(s, night, 0.4, 1);
    expect(lights.length).toBeGreaterThan(5);
    const x0 = 1500 / 2;
    const y0 = 900 / 2;
    for (const l of lights) expect(overlaps(l, { x: x0, y: y0, w: 640, h: 400 })).toBe(true);
    // A view of the sky above every roof (the towers' beacons and crowns all below it): no light at all.
    const towers = towersOf(reference, night, -448, 2112);
    const above = Math.min(...towers.map((t) => t.peak)) - 3;
    expect(lightsOf(sceneOf(reference, night, FIT, { w: 2560, h: above + FIT.oy }), night, 0.4, 1).lights).toHaveLength(0);
  });
});

describe("faceAt", () => {
  it("is the street's top where no tower stands, a tower's outline where one does — in every chunk", () => {
    const s = sceneOf(reference, noon);
    const horizon = horizonOf(reference);
    const all = towersOf(reference, noon, -40 * CHUNK, 40 * CHUNK);
    // (Overlapping towers among them: the face is the higher of the two outlines.)
    expect(all.some((t, i) => all.some((u, j) => j > i && u.x < t.x + t.w && t.x < u.x + u.w))).toBe(true);
    for (const t of all)
      for (const [a, b, top] of t.parts) {
        expect(TOWERS.faceAt(s, a)).toBeLessThanOrEqual(top);
        expect(TOWERS.faceAt(s, b - 1)).toBeLessThanOrEqual(top);
      }
    // A chunk's first 2 tiles never hold a cluster's tower (the signature skyscraper stands where its building does).
    const [sx0, sx1] = signatureSpan(reference);
    for (let k = -5; k < 5; k++) for (let x = k * CHUNK; x < k * CHUNK + 2 * TILE; x += 7) if (x < sx0 || x >= sx1) expect(TOWERS.faceAt(s, x)).toBe(horizon);
  });
});
