/** Calm homes in the backdrop's QUIET stretches, the farthest MID layer: no signs, no neon, filled
 * edge to edge, roofs from the haze's top to `RISE` × it, under landmark crowns. World-locked;
 * lights go through `fillLit` as one raster pattern per building (the canyon's idiom). */

import { TILE, type Ambience, type CityInfo, type WeatherKind, type World } from "../villageTypes";
import { CITY_DAY } from "../engine/ambience";
import { AIR_CHUNK, airSpans, citySpan, quietSpans, roofLimit, type BackdropLayer, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { subtract, type Box } from "./backdropLights";
import { defaultMakeLayer } from "./ground";
import { landmarksFor, placeLandmarks, type LandmarkSpec } from "./landmarks";
import { hash, onScreen, sx, sy } from "./paint";
import type { DrawTarget, SpriteImage } from "./renderTypes";
import { skylineMax } from "./skyline";

// ───────────────────────────── geometry ─────────────────────────────

/** World px of a storey: smaller than the canyon's 20 (it is nearer), larger than the haze's 5-px floors. */
export const STOREY = 13;
/** World px of the parapet over the top storey. */
const PARAPET = 2;
/** World px a stretch's buildings run past each of its ends, under the canyon or the shops in front: no slit of sky at a seam. */
export const PAD = 2;
/** Stretches closer than this are one row: no canyon building (≥ 48 px) fits between, so the haze
 * or sky would show as a sliver. A shop may still stand there, in front. */
export const SLIVER = 48;
/** Tallest roof as a multiple of the haze's top, so the sky stays open above the homes (≈ 0.22 of a
 * tall city's sky). */
export const RISE = 1.45;
/** The three kinds of building, and the narrowest of each (world px). */
export const KINDS = ["danchi", "mansion", "older"] as const;
export type ApartmentKind = (typeof KINDS)[number];
const MIN_W: Record<ApartmentKind, number> = { danchi: 76, mansion: 36, older: 28 };
/** Each kind's width by a hash: its narrowest plus up to this much more. */
const MORE_W: Record<ApartmentKind, number> = { danchi: 60, mansion: 26, older: 16 };
/** The world px of a home along a danchi's corridor, a mansion's balcony, and a pair of an older block's bays. */
const UNIT: Record<ApartmentKind, number> = { danchi: 26, mansion: 20, older: 20 };
/** World px a danchi's core and a mansion's machine room stand over the roof. */
const CORE_RISE = 10;
const MACHINE_H = 8;
/** Below this zoom a 1-px detail is under ¾ of a screen px (render/city.ts's PANE_ZOOM). */
const PANE_ZOOM = 0.75;
/** A quarter of the homes are vacant: never lit. */
export const VACANT = 4;
/** The lit share is stepped this finely: a building's light raster is painted again per step, not per frame. */
const LIT_STEPS = 32;
/** Rasters are kept for at most this many buildings (or every building in a wider view, and a few more). */
export const MAX_RASTERS = 64;

// ───────────────────────────── colours ─────────────────────────────

/** A building's tones (DAY): wall, its cap and shade, the corridor or glass, its trim. */
export interface Tone {
  wall: string;
  cap: string;
  shade: string;
  deep: string;
  glass: string;
  trim: string;
}

/** DAY colours, exported for tests, before the air (`AERIAL`); the grade does dusk and night. */
export const APARTMENT_DAY = {
  danchi: [
    { wall: "#ded5bf", cap: "#ebe4d3", shade: "#999da1", deep: "#878b91", glass: "#c3cad0", trim: "#717e8e" }, // cream, steel doors
    { wall: "#cfd1cc", cap: "#dfe0dc", shade: "#94999d", deep: "#82878c", glass: "#bec6cc", trim: "#7d7366" }, // pale grey, brown doors
    { wall: "#cdd6c9", cap: "#dde4d9", shade: "#949c99", deep: "#828a88", glass: "#c0c9c8", trim: "#6f7f86" }, // pale mint
  ] as readonly Tone[],
  mansion: [
    { wall: "#d6c3a3", cap: "#e4d8c2", shade: "#b4a993", deep: "#5b6673", glass: "#6b7886", trim: "#e6e3dc" }, // beige tile
    { wall: "#dedbd3", cap: "#ebe9e3", shade: "#c0bdb5", deep: "#5d6875", glass: "#6e7b89", trim: "#f1efea" }, // white tile
    { wall: "#a8896e", cap: "#bca690", shade: "#8f7b67", deep: "#525c68", glass: "#647180", trim: "#d8d2c8" }, // brown tile
    { wall: "#b9bbb8", cap: "#cbccca", shade: "#9fa19e", deep: "#56616c", glass: "#687583", trim: "#e2e2de" }, // grey
  ] as readonly Tone[],
  older: [
    { wall: "#9a7860", cap: "#ad8f78", shade: "#856650", deep: "#4f5966", glass: "#5a6573", trim: "#c9c3b8" }, // brown tile
    { wall: "#b09a77", cap: "#bfab8b", shade: "#9a8564", deep: "#535d69", glass: "#5e6977", trim: "#d3cdbf" }, // ochre tile
    { wall: "#b8a294", cap: "#c6b3a6", shade: "#a18b7e", deep: "#535c68", glass: "#5f6a78", trim: "#d7d0c6" }, // rose beige
  ] as readonly Tone[],
  /** A water tank (panels of pale FRP), its seams, and the steel base it stands on; a mast. */
  tank: "#cfd8de",
  tankBand: "#aeb9c2",
  steel: "#7f8790",
  mast: "#6c747c",
  /** An air conditioner's outdoor unit. */
  ac: "#e4e4de",
  /** Laundry on the line (white, sky blue, pink, yellow, mint) and a futon over the rail. */
  laundry: ["#f3f1ea", "#bcd3ea", "#efc4c9", "#efe2a6", "#cfe3c4"] as readonly string[],
  futon: "#f1ebdf",
} as const;

/** The air between the street and the apartments: a day colour seen through it leans towards the haze's (engine/ambience.ts `CITY_DAY.skyline`). */
export const HAZE = CITY_DAY.skyline;
/** How far towards the haze the day colours lean: farther than the canyon (0.1) and the shops (0.15). */
export const AERIAL = 0.36;
/** …and how much more in each weather: far things fade first in rain and fog (render/landmarks.ts `SEEN`). */
export const WEATHER_MIX: Record<WeatherKind, number> = { clear: 0, cloudy: 0.06, drizzle: 0.12, snow: 0.18, rain: 0.2, storm: 0.18, fog: 0.4 };
/** At night facades sink `VEIL` of the way to `NIGHT` (before the grade), by the stars' measure of
 * dark in `DARK_STEPS` (a day raster is repainted per step): darker than the canyon's walls. */
export const NIGHT = "#1e2438";
export const VEIL = 0.6;
const DARK_STEPS = 16;
/** How much of the lights shows through each weather. */
export const LIGHT_SEEN: Record<WeatherKind, number> = { clear: 1, cloudy: 1, drizzle: 0.9, snow: 0.85, rain: 0.8, storm: 0.75, fog: 0.6 };

/** Lights, painted after the grade (never hazed) and dim: warm windows, some cool or curtained, a
 * danchi's corridor and stairwell, a TV's blues. */
export const APARTMENT_LIT = {
  warm: "rgba(230, 207, 152, 0.85)",
  cool: "rgba(211, 224, 236, 0.8)",
  curtain: "rgba(217, 160, 102, 0.6)",
  corridor: "rgba(223, 230, 226, 0.6)",
  stair: "rgba(223, 230, 226, 0.3)",
  tv: ["#7ea4ff", "#a8c0ff", "#5b80e6", "#c6d4ff"] as readonly string[],
} as const;

/** `#rrggbb` mixed `t` of the way towards `to`. No zero-padding needed: every mix here keeps red
 * over 0x10. */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16)}`;
}

const tints = new Map<string, Map<string, string>>();
/** A DAY colour as painted in `weather` at dark step `step` (0 day .. `DARK_STEPS` night): through
 * the air (more in rain and fog), then veiled. Cached. */
export function seenThrough(color: string, weather: WeatherKind, step: number): string {
  const key = weather + step;
  let m = tints.get(key);
  if (!m) tints.set(key, (m = new Map()));
  let c = m.get(color);
  if (c === undefined) m.set(color, (c = mix(mix(color, HAZE, AERIAL + WEATHER_MIX[weather]), NIGHT, (VEIL * step) / DARK_STEPS)));
  return c;
}

/** How dark it is now in `DARK_STEPS` (render/city.ts's measure for the stars: 0 by day, all of them at night). */
function darkStep(amb: Ambience | undefined): number {
  return amb ? Math.round(Math.min(1, Math.max(0, (0.6 - amb.daylight) / 0.45)) * DARK_STEPS) : 0;
}

// ───────────────────────────── the layout ─────────────────────────────

/** When a piece of day art is painted: at every zoom, or only from `PANE_ZOOM` (a detail of a pixel). */
const ALL = false;
const FINE = true;

/** A run of rects of one colour and detail, in paint order: flat [x, y, w, h, …] world px. */
interface Batch {
  color: string;
  fine: boolean;
  rects: number[];
}

/** A home: its windows (world boxes) and whether it is vacant — for the tests. */
export interface Home {
  vacant: boolean;
  windows: Box[];
}

/** A building as it stands (for the tests): its kind, span, storeys, roof, and its highest point. */
export interface Apartment {
  kind: ApartmentKind;
  x: number;
  w: number;
  floors: number;
  /** World y of its parapet's top. */
  roof: number;
  /** Its colours (DAY): one of its kind's in `APARTMENT_DAY`. */
  tone: Tone;
  /** What stands where: [x0, x1, top] — its body, then what stands on its roof (core, machine room, tank, mast). */
  parts: [number, number, number][];
  homes: Home[];
}

/** A building's rasters, made when first painted: its day art (in a weather), and its lights at a lit step. */
interface Rasters {
  day: { image: SpriteImage; g: DrawTarget; key: string } | null;
  light: { pattern: CanvasPattern; image: SpriteImage; g: DrawTarget; level: number } | null;
}

/** A building, laid out and compiled. */
interface Building extends Apartment {
  /** Its day art in paint order, and the box it falls in (null: all of it behind the world's buildings). */
  day: Batch[];
  dayBox: Box | null;
  /** Its lights by colour: flat [threshold ‰, x, y, w, h, …]; the box they fall in. */
  lights: Map<string, number[]>;
  lightBox: Box | null;
  /** Its TVs: flat [threshold ‰, x, y, w, h, seed, …]. */
  tvs: number[];
  rasters: Rasters;
}

/** One quiet stretch's buildings: its padded span [x0, x1) and its face there, per column. */
interface Row {
  x0: number;
  x1: number;
  face: Int16Array;
  buildings: Building[];
}

/** The apartments of one World, for one horizon and one city's landmarks. */
interface Layout {
  world: World;
  amb: Ambience | undefined;
  horizon: number;
  specs: readonly LandmarkSpec[];
  /** The haze's top, and the most storeys a building has (where no crown or tower's foot holds it lower). */
  least: number;
  most: number;
  /** The world's buildings, as boxes down to the street: what one covers is never painted. */
  walls: Box[];
  /** The temples' boxes, as render/city.ts `frontShapes` boxes them: no light is lit inside them. */
  temples: Box[];
  /** The towers' feet (Tokyo Tower, the Skytree), [x0, x1): a building in front of one stands no taller than the haze. */
  feet: [number, number][];
  /** The city's stretch — its span from wall to wall, merged with the open sky it overlaps — and its row; null with no buildings. */
  city: [number, number] | null;
  cityRow: Row | null;
  /** Each quiet stretch's row (by the stretch's start): its chain of stretches less than `SLIVER` apart, laid out on first use. */
  rows: Map<number, Row>;
  /** The face over each air chunk's columns (every row reaching into it), made on first use: `faceAt` is one lookup. */
  faces: Map<number, Int16Array>;
}

const LAYOUTS = new WeakMap<World, Layout>();

/** The apartments of `world` — laid out afresh for a new horizon or city's landmarks. */
function layoutOf(world: World, amb: Ambience | undefined, horizon: number): Layout {
  const specs = landmarksFor(amb?.zone);
  const hit = LAYOUTS.get(world);
  if (hit && hit.horizon === horizon && hit.specs === specs) return hit;
  const least = skylineMax(horizon);
  const placed = placeLandmarks(world, horizon, specs).placed;
  const m: Layout = {
    world,
    amb,
    horizon,
    specs,
    least,
    most: Math.max(Math.ceil((least - PARAPET) / STOREY), Math.floor((Math.round(RISE * least) - PARAPET) / STOREY)),
    walls: (world.city as CityInfo).buildings.map((b): Box => [b.col * TILE, b.row * TILE, b.w * TILE, horizon - b.row * TILE]),
    temples: placed.filter((p) => p.spec.layer === "near").map((p): Box => [p.x - p.hw, horizon - p.h - 2, 2 * p.hw + 1, p.h + 2]),
    feet: placed.filter((p) => p.spec.layer === "tower").map((p): [number, number] => [p.x - p.hw, p.x + p.hw + 1]),
    city: null,
    cityRow: null,
    rows: new Map(),
    faces: new Map(),
  };
  // The city's stretch, merged with the open sky it overlaps: asked over the city's span, `quietSpans` has
  // only it (every stretch of sky it finds there overlaps the city). Its row is laid out first, so every
  // stretch chained to it is known before any other row is walked (see `rowOf`).
  const span = citySpan(world);
  if (span) {
    m.city = quietSpans(world, span[0], span[1])[0];
    m.cityRow = rowOf(m, m.city);
  }
  LAYOUTS.set(world, m);
  return m;
}

/** Air chunk `c`'s quiet stretch: its stretch of open sky — or the city's, where that holds it. */
function stretchOf(m: Layout, c: number): [number, number] {
  const s = airSpans(c * AIR_CHUNK, (c + 1) * AIR_CHUNK)[0];
  const city = m.city;
  return city && s[0] >= city[0] && s[1] <= city[1] ? city : s;
}

/** The open-sky stretch starting in [b, b + `SLIVER`), or null; at most one, since every stretch is
 * wider than `SLIVER`. Not the city's (`layoutOf` chains that). */
function after(m: Layout, b: number): [number, number] | null {
  for (let c = Math.floor(b / AIR_CHUNK); c * AIR_CHUNK < b + SLIVER; c++) {
    const s = stretchOf(m, c);
    if (s[0] >= b && s[0] < b + SLIVER) return s;
  }
  return null;
}

/** The stretch of open sky ending in (a − `SLIVER`, a], or null (one at most, as for `after`). */
function before(m: Layout, a: number): [number, number] | null {
  for (let c = Math.floor((a - SLIVER) / AIR_CHUNK); c * AIR_CHUNK < a; c++) {
    const s = stretchOf(m, c);
    if (s[1] <= a && s[1] > a - SLIVER) return s;
  }
  return null;
}

/** Stretch `s`'s row: its CHAIN of stretches under `SLIVER` apart, walked out both ways regardless
 * of the span asked (so world-locked), laid out from the chain's start and shared by every stretch
 * in it. The city's chain is laid out with the layout. */
function rowOf(m: Layout, s: [number, number]): Row {
  let row = m.rows.get(s[0]);
  if (!row) {
    const chain = [s];
    for (let p = before(m, s[0]); p; p = before(m, p[0])) chain.unshift(p);
    for (let n = after(m, s[1]); n; n = after(m, n[1])) chain.push(n);
    row = layoutRow(m, chain[0][0], chain[chain.length - 1][1]);
    for (const [a] of chain) m.rows.set(a, row);
  }
  return row;
}

/** Rows over [x0, x1): the city's and those of the air chunks there (plus padding either side). */
function rowsIn(m: Layout, x0: number, x1: number): Row[] {
  const out = new Set<Row>();
  if (m.cityRow) out.add(m.cityRow);
  for (let c = Math.floor((x0 - PAD) / AIR_CHUNK); c * AIR_CHUNK < x1 + PAD; c++) out.add(rowOf(m, stretchOf(m, c)));
  return [...out].filter((r) => r.x1 > x0 && r.x0 < x1);
}

/** The kind a building `w` px wide takes, given the one its hash picked: the next narrower one that fits. */
function kindFor(w: number, picked: ApartmentKind): ApartmentKind {
  const at = KINDS.indexOf(picked);
  return KINDS.slice(at).find((k) => w >= MIN_W[k]) as ApartmentKind;
}

/** Lay out stretch [a, b): buildings shoulder to shoulder from `PAD` before to `PAD` past it, kind
 * and width hashed, never two danchi side by side; the last takes what is left. Then compiled. */
function layoutRow(m: Layout, a: number, b: number): Row {
  const x0 = a - PAD;
  const x1 = b + PAD;
  const face = new Int16Array(x1 - x0).fill(m.horizon);
  const buildings: Building[] = [];
  for (let i = 0, x = x0; x < x1; i++) {
    const hh = hash(a, i, 401);
    const after = buildings[buildings.length - 1]?.kind === "danchi" ? 1 : 0;
    const picked = KINDS[Math.max(after, hh % 5 < 2 ? 0 : hh % 5 < 4 ? 1 : 2)];
    let w = MIN_W[picked] + ((hh >>> 4) % (MORE_W[picked] + 1));
    if (x1 - x - w < MIN_W.older) w = x1 - x;
    const made = building(m, kindFor(w, picked), x, w, hash(x, i, 409));
    // Each part stands higher than any before it over its columns (the body, then what stands on its roof): it is the face there.
    for (const [p0, p1, top] of made.parts) face.fill(top, p0 - x0, p1 - x0);
    buildings.push(made);
    x += w;
  }
  return { x0, x1, face, buildings };
}

/** `n` homes across `inner` px from x: each home's [x, w], the leftover px spread one each from the left. */
function homesAcross(x: number, inner: number, unit: number): [number, number][] {
  const n = Math.max(1, Math.round(inner / unit));
  return Array.from({ length: n }, (_, i): [number, number] => {
    const a = Math.floor((i * inner) / n);
    return [x + a, Math.floor(((i + 1) * inner) / n) - a];
  });
}

/** Collects a building's art and lights — less what a world building covers — and what stands where. */
class Compiler {
  readonly day: Batch[] = [];
  readonly lights = new Map<string, number[]>();
  readonly tvs: number[] = [];
  readonly parts: [number, number, number][] = [];
  readonly homes: Home[] = [];
  constructor(private readonly walls: readonly Box[]) {}

  /** What of a world rect no world building covers. */
  private seen(r: Box): Box[] {
    let pieces: Box[] = [r];
    for (const wall of this.walls) pieces = pieces.flatMap((p) => subtract(p, wall));
    return pieces;
  }

  /** A rect of day art in a DAY colour (a run of one colour and detail is one batch). */
  art(fine: boolean, color: string, x: number, y: number, w: number, h: number): void {
    const pieces = this.seen([x, y, w, h]);
    if (pieces.length === 0) return;
    let last = this.day[this.day.length - 1];
    if (!last || last.color !== color || last.fine !== fine) this.day.push((last = { color, fine, rects: [] }));
    for (const p of pieces) last.rects.push(...p);
  }

  /** Something opaque stands up to world y `top` over columns [x0, x1): the face. */
  stand(x0: number, x1: number, top: number): void {
    this.parts.push([x0, x1, top]);
  }

  /** A light of `color` lit once the lit share passes `thr` ‰. */
  light(color: string, thr: number, x: number, y: number, w: number, h: number): void {
    const pieces = this.seen([x, y, w, h]);
    if (pieces.length === 0) return;
    let list = this.lights.get(color);
    if (!list) this.lights.set(color, (list = []));
    for (const p of pieces) list.push(thr, ...p);
  }

  /** A home's windows: vacant one time in `VACANT` (never lit); else each window at its own
   * threshold, and one home in 25 has a flickering TV. */
  home(windows: Box[]): void {
    const [hx, hy] = windows[0];
    const hh = hash(hx, hy, 211);
    const vacant = hh % VACANT === 0;
    this.homes.push({ vacant, windows });
    if (vacant) return;
    windows.forEach((win, k) => {
      const wh = hash(win[0], win[1], 223);
      const thr = wh % 1000;
      if (k === 0 && (hh >>> 8) % 25 === 0) {
        for (const p of this.seen(win)) this.tvs.push(thr, ...p, hh);
        return;
      }
      const tint = (wh >>> 10) % 10;
      this.light(tint < 5 ? APARTMENT_LIT.warm : tint < 7 ? APARTMENT_LIT.cool : APARTMENT_LIT.curtain, thr, ...win);
    });
  }
}

/** Building `kind` at x, `w` wide: storeys between the haze's top and `most` by hash (only the
 * haze's in front of a tower's foot), then lowered under any crown (`roofLimit`): roof objects
 * first, then storeys, down to one. Compiled. */
function building(m: Layout, kind: ApartmentKind, x: number, w: number, hh: number): Building {
  const { horizon } = m;
  const lo = Math.ceil((m.least - PARAPET) / STOREY);
  const hi = m.feet.some(([a, b]) => a < x + w && b > x) ? lo : m.most;
  const limit = roofLimit(m.world, m.amb, horizon, x, x + w, ["far", "tower"]);
  // (A crown never sinks into the haze, render/landmarks.ts: at least a storey always stands under one.)
  const floors = Math.min(lo + ((hh >>> 6) % (hi - lo + 1)), Math.floor((horizon - PARAPET - limit) / STOREY));
  const roof = horizon - floors * STOREY - PARAPET;
  const tone = APARTMENT_DAY[kind][(hh >>> 12) % APARTMENT_DAY[kind].length];
  const out = new Compiler(m.walls);
  out.stand(x, x + w, roof);
  /** World y of storey `s`'s top (0 = the top storey). */
  const storey = (s: number) => roof + PARAPET + s * STOREY;
  /** Something on the roof standing `h` px over it, if no crown is over it. */
  const onRoof = (h: number) => roof - h >= limit;
  if (kind === "danchi") danchi(out, tone, x, w, floors, roof, storey, horizon, hh, onRoof);
  else if (kind === "mansion") mansion(out, tone, x, w, floors, roof, storey, horizon, hh, onRoof);
  else older(out, tone, x, w, floors, roof, storey, horizon, hh, onRoof);
  const day = out.day;
  const lightRects = [...out.lights.values()].flatMap((l) => l.filter((_, i) => i % 5 !== 0));
  return {
    kind,
    x,
    w,
    floors,
    roof,
    tone,
    parts: out.parts,
    homes: out.homes,
    day,
    dayBox: boxOf(day.flatMap((b) => b.rects)),
    lights: out.lights,
    lightBox: boxOf(lightRects),
    tvs: out.tvs,
    rasters: { day: null, light: null },
  };
}

/** The box flat [x, y, w, h, …] rects fall in; null for none. */
function boxOf(rects: number[]): Box | null {
  if (rects.length === 0) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < rects.length; i += 4) {
    x0 = Math.min(x0, rects[i]);
    y0 = Math.min(y0, rects[i + 1]);
    x1 = Math.max(x1, rects[i] + rects[i + 2]);
    y1 = Math.max(y1, rects[i + 1] + rects[i + 3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A water tank of FRP panels on a steel base, `tw` px wide, standing on the roof at x. */
function tank(out: Compiler, x: number, tw: number, roof: number): void {
  out.art(ALL, APARTMENT_DAY.steel, x, roof - 2, tw, 2);
  out.art(ALL, APARTMENT_DAY.tank, x, roof - 8, tw, 6);
  out.art(FINE, APARTMENT_DAY.tankBand, x, roof - 6, tw, 1);
  out.stand(x, x + tw, roof - 8);
}

/** A mast `h` px tall on the roof at x. */
function mast(out: Compiler, x: number, h: number, roof: number): void {
  out.art(ALL, APARTMENT_DAY.mast, x, roof - h, 1, h);
  out.stand(x, x + 1, roof - h);
}

type StoreyAt = (s: number) => number;
type OnRoof = (h: number) => boolean;

/** A danchi from its open-corridor side: corridor strip over parapet band per storey, a core rising
 * `CORE_RISE` over the roof, sometimes a tank. At night corridor and stairwell glow from early dusk
 * (their own threshold); kitchen windows light one by one. */
function danchi(out: Compiler, t: Tone, x: number, w: number, n: number, roof: number, storey: StoreyAt, horizon: number, hh: number, onRoof: OnRoof): void {
  const h = horizon - roof;
  const homes = homesAcross(x + 2, w - 4, UNIT.danchi);
  out.art(ALL, t.shade, x, roof, w, h);
  out.art(ALL, t.wall, x, roof, 2, h);
  out.art(ALL, t.wall, x + w - 2, roof, 2, h);
  for (const [hx] of homes) out.art(ALL, t.trim, hx + 4, roof, 2, h);
  for (const [hx] of homes) out.art(ALL, t.glass, hx + 10, roof, 5, h);
  // The ceiling's shadow and the parapet's lit top run between the gables; the bands are the gables' colour.
  for (let s = 0; s < n; s++) out.art(FINE, t.deep, x + 2, storey(s), w - 4, 1);
  for (let s = 0; s < n; s++) out.art(ALL, t.wall, x, storey(s) + 6, w, 7);
  for (let s = 0; s < n; s++) out.art(FINE, t.cap, x + 2, storey(s) + 6, w - 4, 1);
  out.art(ALL, t.cap, x, roof, w, PARAPET);
  const corridor = 20 + ((hh >>> 16) % 100);
  // The core, at a seam between two homes (a danchi has three or more).
  const seam = homes[1 + ((hh >>> 20) % (homes.length - 1))][0];
  const core = onRoof(CORE_RISE) ? CORE_RISE : 0;
  out.art(ALL, t.cap, seam - 4, roof - core, 8, h + core);
  out.art(ALL, t.deep, seam - 2, roof + PARAPET, 4, h - PARAPET);
  for (let s = 0; s < n; s++) out.art(FINE, t.cap, seam - 2, storey(s) + 4, 4, 9);
  out.stand(seam - 4, seam + 4, roof - core);
  if ((hh >>> 24) % 2 === 0 && onRoof(8)) tank(out, seam > x + (w >> 1) ? x + 8 : x + w - 20, 12, roof);
  for (let s = 0; s < n; s++) {
    const y = storey(s);
    out.light(APARTMENT_LIT.stair, corridor, seam - 2, y, 4, 4);
    for (const [hx] of homes) {
      out.light(APARTMENT_LIT.corridor, corridor, hx + 7, y, 1, 1);
      out.home([[hx + 10, y + 1, 5, 4]]);
    }
  }
}

/** A mansion from its balcony side: glass doors over a rail per storey, partitions between homes,
 * some laundry or futons; a machine room or mast on the roof. At night each home's two rooms light
 * on their own. */
function mansion(out: Compiler, t: Tone, x: number, w: number, n: number, roof: number, storey: StoreyAt, horizon: number, hh: number, onRoof: OnRoof): void {
  const h = horizon - roof;
  const homes = homesAcross(x + 3, w - 6, UNIT.mansion);
  out.art(ALL, t.glass, x, roof, w, h);
  for (const [hx, hw] of homes) out.art(FINE, t.trim, hx + (hw >> 1), roof, 1, h);
  for (const [hx] of homes.slice(1)) out.art(FINE, t.trim, hx, roof, 1, h);
  for (let s = 0; s < n; s++) out.art(FINE, t.deep, x, storey(s), w, 1);
  for (let s = 0; s < n; s++) out.art(ALL, t.cap, x, storey(s) + 8, w, 5);
  for (let s = 0; s < n; s++) out.art(FINE, t.shade, x, storey(s) + 12, w, 1);
  out.art(ALL, t.wall, x, roof, 3, h);
  out.art(ALL, t.wall, x + w - 3, roof, 3, h);
  out.art(ALL, t.cap, x, roof, w, PARAPET);
  for (let s = 0; s < n; s++)
    for (const [hx, hw] of homes) {
      const y = storey(s);
      const lh = hash(hx, y, 227);
      if (lh % 100 < 4) out.art(FINE, APARTMENT_DAY.futon, hx + 2, y + 7, Math.min(9, hw - 4), 4);
      else if (lh % 100 < 10)
        for (let k = 0; k < 3; k++) out.art(FINE, APARTMENT_DAY.laundry[(lh >>> (8 + 3 * k)) % 5], hx + 2 + 3 * k, y + 3, 2, 4 + ((lh >>> (20 + k)) & 1));
      const half = hw >> 1;
      out.home([
        [hx + 1, y + 2, half - 1, 6],
        [hx + half + 1, y + 2, hw - half - 1, 6],
      ]);
    }
  if ((hh >>> 16) % 10 < 7 && onRoof(MACHINE_H)) {
    const mw = Math.min(16, w - 12);
    const mx = x + 6 + ((hh >>> 20) % (w - 11 - mw));
    out.art(ALL, t.wall, mx, roof - MACHINE_H, mw, MACHINE_H);
    out.art(FINE, t.cap, mx, roof - MACHINE_H, mw, 1);
    out.stand(mx, mx + mw, roof - MACHINE_H);
  }
  if ((hh >>> 24) % 10 < 4 && onRoof(9)) mast(out, x + w - 6, 9, roof);
}

/** An older tiled block: punched windows in 10-px bays, sill lines, some AC units; a tank on the
 * roof or a mast. At night each window lights on its own. */
function older(out: Compiler, t: Tone, x: number, w: number, n: number, roof: number, storey: StoreyAt, horizon: number, hh: number, onRoof: OnRoof): void {
  const h = horizon - roof;
  const bays = homesAcross(x + 3, w - 6, UNIT.older / 2);
  out.art(ALL, t.wall, x, roof, w, h);
  for (const [bx, bw] of bays) out.art(ALL, t.glass, bx + 2, roof, bw - 4, h);
  out.art(ALL, t.wall, x, roof, w, PARAPET + 3);
  for (let s = 0; s < n; s++) out.art(ALL, t.wall, x, storey(s) + 9, w, Math.min(7, horizon - storey(s) - 9));
  for (let s = 0; s < n; s++) out.art(FINE, t.trim, x, storey(s) + 9, w, 1);
  for (let s = 0; s < n; s++)
    for (const [bx, bw] of bays) if (hash(bx, storey(s), 229) % 8 === 0) out.art(FINE, APARTMENT_DAY.ac, bx + bw - 2, storey(s) + 6, 3, 2);
  out.art(ALL, t.cap, x, roof, w, PARAPET);
  if ((hh >>> 16) % 10 < 7 && onRoof(8)) tank(out, x + 4 + ((hh >>> 20) % (w - 18)), Math.min(12, w - 8), roof);
  else if (onRoof(10)) mast(out, x + 3 + ((hh >>> 20) % (w - 6)), 10, roof);
  for (let s = 0; s < n; s++)
    for (let i = 0; i < bays.length; i += 2)
      out.home(bays.slice(i, i + 2).map(([bx, bw]): Box => [bx + 2, storey(s) + 4, bw - 4, 4]));
}

// ───────────────────────────── painting ─────────────────────────────

/** Fill a world-px rect in the current fillStyle, edges snapped like `rect` — nothing wholly off the view. */
function fillWorld(ctx: DrawTarget, s: BackdropScene, wx: number, wy: number, w: number, h: number): void {
  const x = sx(s.cam, wx);
  const y = sy(s.cam, wy);
  const rw = Math.max(1, sx(s.cam, wx + w) - x);
  const rh = Math.max(1, sy(s.cam, wy + h) - y);
  if (x < s.view.w && y < s.view.h && x + rw > 0 && y + rh > 0) ctx.fillRect(x, y, rw, rh);
}

/** Every building of the stretches over the view, left to right within each (a frame culls each by its box). */
function buildingsIn(s: BackdropScene, m: Layout): Building[] {
  return rowsIn(m, s.x0, s.x1).flatMap((r) => r.buildings);
}

/** The buildings holding rasters, least recently painted first. */
const HELD = new Set<Building>();

/** Building `b` is painted now: it becomes the most recent to hold rasters, and past the cap the least recent loses its. */
function hold(b: Building, inView: number): void {
  HELD.delete(b);
  HELD.add(b);
  if (HELD.size <= Math.max(MAX_RASTERS, inView + 8)) return;
  const old = HELD.values().next().value as Building;
  HELD.delete(old);
  old.rasters = { day: null, light: null };
}

/** A blank raster of `w`×`h` world px and its context, or null where the host has no 2D canvas (jsdom). */
function blank(w: number, h: number): { image: SpriteImage; g: DrawTarget } | null {
  const layer = defaultMakeLayer(w, h);
  return layer && { image: layer.image, g: layer.ctx };
}

/** Building `b`'s full day art in `weather` at dark step `step`, painted into a world-px raster,
 * again in the same raster when weather or step changes; null without a canvas. */
function dayRaster(b: Building, weather: WeatherKind, step: number, inView: number): SpriteImage | null {
  hold(b, inView);
  const key = weather + step;
  const had = b.rasters.day;
  if (had?.key === key) return had.image;
  const [x0, y0, w, h] = b.dayBox as Box;
  const r = had ?? blank(w, h);
  if (!r) return null;
  r.g.clearRect(0, 0, w, h);
  for (const batch of b.day) {
    r.g.fillStyle = seenThrough(batch.color, weather, step);
    for (let i = 0; i < batch.rects.length; i += 4) r.g.fillRect(batch.rects[i] - x0, batch.rects[i + 1] - y0, batch.rects[i + 2], batch.rects[i + 3]);
  }
  b.rasters.day = { image: r.image, g: r.g, key };
  return r.image;
}

/** Day pass per building in view: at a whole zoom its day raster in one `drawImage`; below 1 or
 * without a canvas its rects, pixel details only from `PANE_ZOOM`. */
function paint(s: BackdropScene): void {
  const m = layoutOf(s.world, s.amb, s.horizon);
  const { ctx, cam } = s;
  const weather = s.amb?.weather ?? "clear";
  const step = darkStep(s.amb);
  const fine = cam.zoom >= PANE_ZOOM;
  const list = buildingsIn(s, m);
  ctx.globalAlpha = 1;
  for (const b of list) {
    if (!b.dayBox || !onScreen(cam, s.view, ...b.dayBox)) continue;
    const [x, y, w, h] = b.dayBox;
    const art = cam.zoom >= 1 ? dayRaster(b, weather, step, list.length) : null;
    if (art) {
      ctx.drawImage(art, 0, 0, w, h, sx(cam, x), sy(cam, y), w * cam.zoom, h * cam.zoom);
      continue;
    }
    for (const batch of b.day) {
      if (batch.fine && !fine) continue;
      ctx.fillStyle = seenThrough(batch.color, weather, step);
      const r = batch.rects;
      for (let i = 0; i < r.length; i += 4) fillWorld(ctx, s, r[i], r[i + 1], r[i + 2], r[i + 3]);
    }
  }
}

/** Building `b`'s lights at lit share `level` as a world-px raster pattern, repainted in the same
 * raster when the share steps on; null without a canvas. */
function lightRaster(b: Building, level: number, inView: number): CanvasPattern | null {
  hold(b, inView);
  const had = b.rasters.light;
  if (had?.level === level) return had.pattern;
  const [x0, y0, w, h] = b.lightBox as Box;
  const r = had ?? blank(w, h);
  if (!r) return null;
  r.g.clearRect(0, 0, w, h);
  for (const [color, list] of b.lights) {
    r.g.fillStyle = color;
    for (let i = 0; i < list.length; i += 5) if (list[i] < level * 1000) r.g.fillRect(list[i + 1] - x0, list[i + 2] - y0, list[i + 3], list[i + 4]);
  }
  const pattern = (r.g as unknown as { createPattern(image: SpriteImage, repeat: string): CanvasPattern }).createPattern(r.image, "no-repeat");
  b.rasters.light = { pattern, image: r.image, g: r.g, level };
  return pattern;
}

/** A TV's glow at `timeMs`: one of four blues at its own alpha, changing every 150–400 ms by a hash
 * of the TV and the moment. */
export function tvGlow(seed: number, timeMs: number): { color: string; alpha: number } {
  const period = 150 + (seed % 251);
  const hh = hash(seed, Math.floor((timeMs + (seed >>> 9) % period) / period), 233);
  return { color: APARTMENT_LIT.tv[hh % 4], alpha: 0.35 + ((hh >>> 4) % 46) / 100 };
}

/** Night pass per lit building in view: one `fillLit` of its light raster less temple boxes, then
 * its TVs rect by rect. Dimmer in rain and fog, and a little at golden hour. */
function paintLights(s: BackdropLightScene): void {
  const level = Math.floor(s.lit * LIT_STEPS) / LIT_STEPS;
  if (level <= 0) return;
  const m = layoutOf(s.world, s.amb, s.horizon);
  const { ctx, cam } = s;
  const top = Math.floor(-Math.round(cam.oy) / cam.zoom);
  const bottom = Math.ceil((s.view.h - Math.round(cam.oy)) / cam.zoom);
  const k = LIGHT_SEEN[s.amb.weather] * (0.55 + 0.45 * s.dark);
  const list = buildingsIn(s, m);
  for (const b of list) {
    const [bx, by, bw, bh] = b.lightBox ?? [0, 0, 0, 0];
    const x0 = Math.max(bx, Math.floor(s.x0));
    const x1 = Math.min(bx + bw, Math.ceil(s.x1));
    const y0 = Math.max(by, top);
    const y1 = Math.min(by + bh, bottom);
    const pattern = x1 > x0 && y1 > y0 ? lightRaster(b, level, list.length) : null;
    if (pattern) {
      let pieces: Box[] = [[x0, y0, x1 - x0, y1 - y0]];
      for (const t of m.temples) pieces = pieces.flatMap((p) => subtract(p, t));
      pattern.setTransform({ a: cam.zoom, b: 0, c: 0, d: cam.zoom, e: sx(cam, bx), f: sy(cam, by) });
      ctx.fillStyle = pattern;
      ctx.globalAlpha = k;
      for (const p of pieces) s.fillLit(...p);
    }
    for (let i = 0; i < b.tvs.length; i += 6) {
      const [thr, x, y, w, h, seed] = b.tvs.slice(i, i + 6);
      if (thr >= level * 1000 || x >= s.x1 || x + w <= s.x0 || y >= bottom || y + h <= top) continue;
      const glow = tvGlow(seed, s.timeMs);
      ctx.fillStyle = glow.color;
      ctx.globalAlpha = k * glow.alpha;
      s.fillLit(x, y, w, h);
    }
  }
  ctx.globalAlpha = 1;
}

/** World y of the apartments' face at world x: the top of what stands there (roof, core, tank, mast), or the street's. */
function faceAt(s: BackdropScene, x: number): number {
  const m = layoutOf(s.world, s.amb, s.horizon);
  const k = Math.floor(x / AIR_CHUNK);
  let face = m.faces.get(k);
  if (!face) m.faces.set(k, (face = chunkFace(m, k)));
  return face[Math.floor(x) - k * AIR_CHUNK];
}

/** The face over air chunk `k`'s columns: the street's top less every row reaching in (rows never
 * overlap). Asked thousands of times a night frame, column by column. */
function chunkFace(m: Layout, k: number): Int16Array {
  const x0 = k * AIR_CHUNK;
  const face = new Int16Array(AIR_CHUNK).fill(m.horizon);
  for (const r of rowsIn(m, x0, x0 + AIR_CHUNK)) face.set(r.face.subarray(Math.max(0, x0 - r.x0), Math.min(r.x1, x0 + AIR_CHUNK) - r.x0), Math.max(r.x0, x0) - x0);
  return face;
}

/** The buildings over the stretches spanning world x ∈ [x0, x1) — for the tests and the PR. */
export function apartmentsIn(world: World, amb: Ambience | undefined, horizon: number, x0: number, x1: number): Apartment[] {
  return rowsIn(layoutOf(world, amb, horizon), x0, x1).flatMap((r) => r.buildings);
}

/** The City's Tokyo backdrop's farthest MID layer: the apartments in the quiet stretches (render/city.ts `backdropOf`). */
export const APARTMENTS: BackdropLayer = { paint, paintLights, faceAt };
