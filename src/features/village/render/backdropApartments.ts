/**
 * Agent Village — the City's APARTMENTS: calm residential blocks in the backdrop's QUIET stretches, the
 * farthest of its MID layers (render/backdrop.ts), behind the neon canyon and the yokochō shops.
 *
 * Zoomed ×2 into a City at night, the open stretches of sky between the neon clusters made the city
 * look unfinished, so buildings stand behind them, with randomly lit windows like occupied and vacant
 * apartments. A narrow gap between two of the city's buildings, a shrine and sakura in front of a
 * sign-lit shop and a canyon building, looked overloaded; Tokyo Tower standing in a gap with only a dark
 * high-rise and sky behind it looked fine. So the neon district builds nothing in the quiet stretches
 * (`quietSpans`: the open sky between its clusters, and the city's own span from wall to wall), and
 * this layer stands there instead: no signs, no neon, ordinary homes with their lights on.
 *
 * WHERE: every quiet stretch, filled edge to edge — `PAD` px past both ends, under the canyon and the
 * shops standing in front there, so no slit of sky shows at a seam — with buildings shoulder to
 * shoulder; and two stretches less than `SLIVER` apart are one row, the ground between them filled too
 * (no canyon building fits it: the haze would show there as a sliver, such as 17 px of it right of a
 * website building; a shop may still stand there, in front). Inside the city's span most of it stands
 * behind the city's buildings (laid out all the same, so a pan never re-rolls it; what a world building
 * wholly covers is dropped when it is compiled): what shows is the roofline over its low buildings and
 * the narrow street gaps behind the temples, Tokyo Tower and the sakura.
 *
 * HOW TALL: every roof rises at least to the haze's top (`skylineMax`, render/skyline.ts) — the haze is
 * not painted in the open sky (render/city.ts `clipAir`), and a roof lower than its blocks either side
 * would leave a notch of sky there — and the tallest only `RISE` times that: a band of homes with the sky
 * open above it, never a third of it. In the reference city (a sky of 960 px, the haze 144 px) that is
 * 11–15 storeys of `STOREY` px: Tokyo's high-rise danchi and mansions; in a low city, four or five.
 * Farther than the canyon (20-px storeys), so smaller storeys and smaller windows. In front of a tower's
 * foot (Tokyo Tower, the Skytree, which stand behind the MID layers) no taller than the haze, which hides
 * their legs everywhere else. No roof, tank or mast rises into a landmark's crown (`roofLimit(…, ["far",
 * "tower"])`: landmarks are never hidden): a building under one loses what stands on its roof, then
 * storeys.
 *
 * THREE KINDS, by a hash of its place (`KINDS`), our own pixel art:
 *
 *   danchi — a long slab seen from its open-corridor side: a light parapet band per storey over a dark
 *            strip of corridor, the doors and frosted kitchen windows in it, a stair-and-lift core
 *            standing up over the roof, sometimes a tank;
 *            ┌──┬─┐───────────────┐
 *            ▓▓▓│░│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    ▓ parapet bands   ░ the core's stair openings
 *            ·▌·▌░│·▌·▀▀·▌·▀▀·▌·▀▀    · corridor        ▌ doors   ▀▀ kitchen windows
 *   mansion — a smaller block seen from its balcony side: a rail per storey, the sliding glass doors
 *            above it, a partition between each two homes; laundry and futons hung out on some
 *            balconies by day; a lift's machine room or a mast on the roof;
 *   older   — a 1970s block in brown or ochre tile with punched windows, a sill line under each row,
 *            air-conditioner units on the wall beside some of them, a water tank on the roof.
 *
 * DAY (`paint`): concrete, cream, beige and tile, seen through more of the air than the canyon in front
 * of it (`AERIAL`: lighter, bluer, lower in contrast — aerial perspective), and more in rain and fog
 * (`WEATHER_MIX`: far things fade first, as the landmarks do); the shared grade turns them to golden hour,
 * dusk and night — and as it darkens they sink back towards `NIGHT` (`VEIL`, by the stars' measure of the
 * dark), darker than the canyon's veiled walls, so the farther stays the dimmer. Details of a pixel
 * (mullions, partitions, laundry, the sill lines) only from `PANE_ZOOM`.
 *
 * NIGHT (`paintLights`, after the grade): homes light up one window at a time, mostly a dim warm white,
 * some cool, some behind a curtain (dimmer, warmer); now and then a TV's blue flicker (by the frame clock,
 * `tvGlow`). A QUARTER of the homes are vacant and never lit (`VACANT`); every other window has its own
 * fixed threshold, lit while `s.lit` is above it — so the same windows come on first every evening, and
 * the lit share follows the haze's (a quarter of all windows at full night, single windows, never a
 * floor's bar). On a danchi the corridor's ceiling lights are a faint dotted row and its stairwell glows,
 * from early dusk.
 *
 * EVERY LIGHT goes through `s.fillLit`. A building's lights are painted ONCE into a small raster in world
 * px at the lit share's step (`LIT_STEPS`) and filled through `fillLit` as a pattern — one fill a building,
 * less the temples' boxes (whose pixel-by-pixel cut would otherwise test every pixel of the fill: what
 * peeks round a temple's eaves stays dark — a calm gap) — the canyon's idiom (render/backdropCanyon.ts);
 * only the TVs, which change by the frame, are lit rect by rect. At a whole zoom a building's day art is a
 * raster too, blitted in one `drawImage` (smoothing is off: pixel for pixel its rects); below 1 its rects
 * are painted one by one, snapped like `rect`.
 *
 * WORLD-LOCKED and DETERMINISTIC: a stretch is laid out from its own left end by hashes of its place
 * (the stretches are a pure function of the world, render/backdrop.ts), every window's threshold is a
 * hash of its world px, the TVs' flicker a hash of the frame clock — never `Math.random`. Laid out and
 * compiled once per World (and horizon, and city's landmarks); a frame walks only the stretches in view.
 *
 * COST — Chromium, the reference city at Fit, 1280×800 @2x (zoom 1), each pass timed in the real frame:
 * by day ≈ 0.03 ms (a blit a building, ≈ 25 in view), at night ≈ 0.13 ms of script (a
 * pattern fill a building through the real cutter, and a few TVs) — ≈ 0.27 ms with the GPU's fills flushed
 * into the timing; at 1280×800 @1x (zoom 1/2, rects) ≈ 0.05 and 0.12 ms. Its face is one lookup a column
 * (`faceAt`, a face per air chunk made on first use): the night pass asks it ≈ 5,000 times a frame — the
 * stars, the haze's lit windows, the towers' lights — and paints that many fewer of them behind it.
 */

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
/**
 * Two quiet stretches less than this apart are one row of buildings: the ground between them is too narrow
 * for any canyon building (its narrowest is 48 px), so the haze — or the sky — would show there as a
 * sliver (17 px of it right of a website building). A shop may still stand there, in front.
 */
export const SLIVER = 48;
/**
 * The tallest roof is at most this times the haze's top: 0.22 of a tall city's sky (the haze is 0.15 of it),
 * 70 px of the lowest city's 240 (its haze is never under 3 tiles) — the sky stays open above the homes.
 */
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

/**
 * The DAY colours, exported for the tests: concrete, cream, beige and tile, before the air (`AERIAL`) goes
 * over them. The grade turns them to dusk and night like everything else in the sky.
 */
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
/**
 * At night the facades sink back into the dark — farther than the canyon's, so darker than its veiled walls,
 * nearer than the towers' — a share `VEIL` of the way to `NIGHT` (before the grade, which then darkens
 * both), by the stars' measure of the dark in `DARK_STEPS` (a day raster is painted again per step).
 */
export const NIGHT = "#1e2438";
export const VEIL = 0.6;
const DARK_STEPS = 16;
/** How much of the lights shows through each weather. */
export const LIGHT_SEEN: Record<WeatherKind, number> = { clear: 1, cloudy: 1, drizzle: 0.9, snow: 0.85, rain: 0.8, storm: 0.75, fog: 0.6 };

/**
 * The lights, painted after the grade — never hazed — and dim: a home's window in a warm white (not pure
 * white), some cool, some behind a curtain; a danchi's corridor and stairwell; a TV's blues.
 */
export const APARTMENT_LIT = {
  warm: "rgba(230, 207, 152, 0.85)",
  cool: "rgba(211, 224, 236, 0.8)",
  curtain: "rgba(217, 160, 102, 0.6)",
  corridor: "rgba(223, 230, 226, 0.6)",
  stair: "rgba(223, 230, 226, 0.3)",
  tv: ["#7ea4ff", "#a8c0ff", "#5b80e6", "#c6d4ff"] as readonly string[],
} as const;

/**
 * `#rrggbb` mixed `t` of the way towards `#rrggbb` `to`. (Six hex digits without padding: every mix here
 * leans at least `AERIAL` towards the haze, then towards the night, whose reds keep the result's red over 0x10.)
 */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16)}`;
}

const tints = new Map<string, Map<string, string>>();
/**
 * A DAY colour as it is painted in `weather` at dark step `step` (0 day .. `DARK_STEPS` night): through
 * the air — more of it in rain and fog — then veiled by the dark. Cached.
 */
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

/**
 * The stretch of open sky starting in [b, b + `SLIVER`), or null — one at most: every stretch is wider than
 * `SLIVER`. (Not the city's: whatever is chained to the city is known with it, `layoutOf`.)
 */
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

/**
 * Quiet stretch `s`'s row: its CHAIN of stretches, each less than `SLIVER` from the next, laid out as one
 * (the ground between them filled too) — the chain walked out both ways to a gap of `SLIVER` or more,
 * whatever span was asked about, so it is world-locked — laid out from the chain's start, and known by
 * every stretch in it. (The city's chain is laid out with the layout: a chain walked later never meets it.)
 */
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

/**
 * The rows over world x ∈ [x0, x1): the city's, and those of the air chunks there (and a padding's width
 * either side). A row's ground between two stretches lies in one of their chunks, or is the city's.
 */
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

/**
 * The quiet stretch [a, b), laid out: buildings shoulder to shoulder from `PAD` before it to `PAD` past it,
 * each of a kind and width by a hash of the stretch's start and its place in the row — never two danchi
 * side by side (a wall of slabs reads as one), and the last taking what is left when a narrowest building
 * would not fit after it — then compiled.
 */
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

  /**
   * A home's windows: vacant one time in `VACANT` (never lit); else each window at its own threshold, in a
   * warm white mostly, some cool, some behind a curtain — and in one home of 25 a TV, flickering blue.
   */
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

/**
 * The building of kind `kind` at world x, `w` px wide (`hh`: its hash): its storeys between the haze's top
 * and `most` by its hash — only the haze's, in front of a tower's foot: Tokyo Tower and the Skytree stand
 * behind the MID layers, and a home is no more in front of their legs than the haze is everywhere else —
 * then lowered under any crown over it (`roofLimit`): what stands on its roof first, then storeys, down
 * to one. Compiled.
 */
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

/**
 * A danchi from its open-corridor side: per storey a dark strip of corridor (6 px: its ceiling's shadow,
 * then the doors and frosted kitchen windows) over a light parapet band (7 px), gable ends either side; a
 * stair-and-lift core standing `CORE_RISE` over the roof at a seam between two homes, its stair openings
 * a storey apart; a tank on the roof one time in two. At night its corridor's ceiling lights are a faint
 * dotted row and its stairwell glows, all from early dusk (a threshold of its own), and its homes' kitchen
 * windows light one by one.
 */
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

/**
 * A mansion from its balcony side: per storey the sliding glass doors (8 px: the slab's shadow, then glass
 * with a mullion down each home's middle) over a balcony rail (5 px, a slab line at its foot), a partition
 * between each two homes, end walls either side; laundry or a futon hung out on a few balconies; a lift's
 * machine room on the roof seven times in ten, a mast some of the time. At night each of a home's two
 * rooms lights on its own.
 */
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

/**
 * An older block in tile: per storey a row of punched windows (6 px tall, in bays of 10 px) between bands
 * of tile, a sill line under each row, an air conditioner's outdoor unit beside one window in eight; a
 * water tank on the roof seven times in ten, else a mast. At night each window lights on its own.
 */
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

/**
 * Building `b`'s day art in `weather` at dark step `step`, every detail, painted into a raster in world px —
 * once, and again (in the same raster) when the weather or the step changes; null without a canvas.
 */
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

/**
 * The day pass: every building in view — at a whole zoom its day raster blitted in one `drawImage`, below 1
 * (or where the host has no canvas) its rects one by one, a pixel's details only from `PANE_ZOOM`.
 */
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

/**
 * Building `b`'s lights at lit share `level`, painted into a raster in world px and made a pattern — once,
 * and again (in the same raster) when the share steps on; null without a canvas.
 */
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

/**
 * A TV's glow at `timeMs`: one of four blues at an alpha of its own, changing every 150–400 ms by a hash of
 * the TV and the moment — a scene cut, a bright frame, a dark one.
 */
export function tvGlow(seed: number, timeMs: number): { color: string; alpha: number } {
  const period = 150 + (seed % 251);
  const hh = hash(seed, Math.floor((timeMs + (seed >>> 9) % period) / period), 233);
  return { color: APARTMENT_LIT.tv[hh % 4], alpha: 0.35 + ((hh >>> 4) % 46) / 100 };
}

/**
 * The night pass: per building in view with a light on, its raster of lights through `fillLit` — one fill
 * over the view's part of it, less the temples' boxes — then its TVs, rect by rect. Dimmer in rain and fog,
 * and a little at golden hour (the lit windows are few then, the facades still lit by the sky).
 */
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

/**
 * The face over air chunk `k`'s columns: the street's top, less every row reaching into the chunk (rows never
 * overlap: two are `SLIVER` or more apart, their padding 2 px). The stars ask thousands of times a night
 * frame (and the haze's lit windows, and the towers' lights, column by column).
 */
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
