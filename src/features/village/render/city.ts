/** The City's sky and street (side view) in two passes: `paintCityBackdrop` under the world, and
 * `paintCityNight` after the grade, clipped to open sky. Sky colours come from `citySky`, painted
 * through the grade's inverse. World-locked and deterministic (hashes, never `Math.random`). */

import { CITY_DAY, citySky } from "../engine/ambience";
import { TILE, type Ambience, type CityInfo, type WeatherKind, type World } from "../villageTypes";
import { themeFor } from "../engine/streetTheme";
import { airSpans, inAir, type BackdropLayer, type BackdropScene } from "./backdrop";
import { lightCutter, type Box, type Shape } from "./backdropLights";
import { APARTMENTS } from "./backdropApartments";
import { CANYON } from "./backdropCanyon";
import { SHOPS } from "./backdropShops";
import { TOWERS } from "./backdropTowers";
import type { Camera } from "./camera";
import { CLOUD_COVER, paintClouds } from "./clouds";
import type { GroundLayer } from "./ground";
import { hash, rect, sx, sy } from "./paint";
import { SKYLINE_BASE, skylineMax } from "./skyline";
import { paintSubway } from "./subway";
import {
  landmarkMask,
  landmarkRow,
  landmarksFor,
  paintFarLandmarks,
  paintLandmarkLights,
  paintLandmarks,
  paintNearLandmarks,
  placeLandmarks,
  type LandmarkSpec,
} from "./landmarks";
import type { DrawTarget } from "./renderTypes";
import { ROAD } from "./tiles";

/** Colours, exported for tests: the NOON look (`CITY_DAY`); other times come from `citySky`. Sky
 * bands run top → horizon. */
export const CITY = {
  sky: CITY_DAY.sky,
  skyline: CITY_DAY.skyline,
  skylineEdge: CITY_DAY.skylineEdge,
  skylinePane: CITY_DAY.skylinePane,
  sun: CITY_DAY.sun,
  sunCore: CITY_DAY.sunCore,
  sunGlow: "rgba(255, 236, 160, 0.35)",
  moon: "#f2efdc",
  moonShade: "#c9c4a8",
  moonGlow: "rgba(230, 236, 255, 0.18)",
  star: "#fdfcf2",
  window: "#ffd987",
  cloud: CITY_DAY.cloud,
  sidewalk: "#b9a27a",
  /** The turf along the top of the ground, and its blades. */
  verge: "#4f8a3a",
  blade: "#6aa84f",
  /** Soil in bands darkening with depth (the last runs on down), its pebbles, and the dug soil round the lounge. */
  soil: ["#7a5534", "#6d4b2f", "#62432a", "#573b25"],
  pebble: "#957d5e",
  dug: "#45301f",
} as const;

/** World px of the street's four rows (engine/city.ts `STREET_ROWS`); the street copies laid
 * beside the world are this tall, never including the lounge. */
export const STREET_H = 4 * TILE;
/** World px of turf along the top of the ground, and of each band of soil under it. */
export const TURF = 4;
export const STRATUM = 2 * TILE;
/** World px per pebble cell (each holds a pebble one time in three). */
const PEBBLE_CELL = 32;
/** World px of freshly dug, darker soil round the lounge's walls. */
export const DUG = 3;

/** How much of the moon shows through each weather (rain, snow and storm hide it). */
const MOON_SEEN: Record<WeatherKind, number> = { clear: 1, cloudy: 0.45, drizzle: 0.35, fog: 0.3, rain: 0, snow: 0, storm: 0 };

/** World px between the street's top and the bottom of the sun's arc (it rises behind the roofs). */
const ARC_BASE = TILE;

/** A city's backdrop layers (render/backdrop.ts): HIGH ones behind the towers and the haze, MID ones in front of the haze and behind the temples, back to front; `air`: open sky between its clusters. */
interface Backdrop {
  high: readonly BackdropLayer[];
  mid: readonly BackdropLayer[];
  air: boolean;
}

/** Tokyo backdrop: towers behind the haze; apartments in the quiet stretches, the canyon and the
 * shops in front. Other cities keep the haze alone (kana signs are Tokyo's, `themeFor`). */
const TOKYO: Backdrop = { high: [TOWERS], mid: [APARTMENTS, CANYON, SHOPS], air: true };
const PLAIN: Backdrop = { high: [], mid: [], air: false };
const backdropOf = (amb: Ambience | undefined): Backdrop => (themeFor(amb?.zone) === "tokyo" ? TOKYO : PLAIN);

/** Clip to the view less the open stretches of sky (above the street): the haze is not painted there. */
function clipAir(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, x0: number, x1: number, horizon: number): void {
  ctx.beginPath();
  ctx.rect(0, 0, view.w, view.h);
  for (const [a, b] of airSpans(x0, x1)) ctx.rect(...screenRect(cam, a, 0, b - a, horizon));
  ctx.clip("evenodd");
}
/** World px per star cell (each holds a star one time in three). */
const STAR_CELL = 32;

/** One shooting star per `SHOOTING_PERIOD_MS` window, at a hashed moment in it, crossing for
 * `SHOOTING_MS`; seen only in clear, dark sky. */
export const SHOOTING_PERIOD_MS = 5 * 60_000;
export const SHOOTING_MS = 1200;
/** World px the head travels while it crosses, and its tail's length behind it. */
const SHOOTING_RUN = 150;
const SHOOTING_TAIL = 28;

/** The shooting star this instant — its head, its direction (unit) and how far through it is — or null. */
export function shootingStar(
  timeMs: number,
  span: { x0: number; x1: number },
  skyTop: number,
  horizon: number,
): { x: number; y: number; dx: number; dy: number; t: number } | null {
  const n = Math.floor(timeMs / SHOOTING_PERIOD_MS);
  const h = hash(n, 0, 97);
  const at = (h % 1000) / 1000 * (SHOOTING_PERIOD_MS - SHOOTING_MS);
  const local = timeMs - n * SHOOTING_PERIOD_MS - at;
  if (local < 0 || local >= SHOOTING_MS) return null;
  const t = local / SHOOTING_MS;
  // Starts in the middle three-fifths of the view, in the upper half of the open sky, and falls
  // towards the horizon at a shallow angle, left or right.
  const width = span.x1 - span.x0;
  const x0 = span.x0 + width * (0.2 + (((h >>> 10) % 1000) / 1000) * 0.6);
  const y0 = skyTop + (horizon - skyTop) * (0.1 + (((h >>> 20) % 1000) / 1000) * 0.3);
  const dir = h & 1 ? 1 : -1;
  const len = Math.hypot(1, 0.4);
  const dx = dir / len;
  const dy = 0.4 / len;
  return { x: x0 + dx * SHOOTING_RUN * t, y: y0 + dy * SHOOTING_RUN * t, dx, dy, t };
}
/** Below this zoom a skyline window's 4-px pitch is under 3 screen px: its panes merge into floor bands. */
const PANE_ZOOM = 0.75;
/** The sky bands (from the bottom) the sun's glow warms, and how far it reaches either side of the sun at the horizon (× the world's width). */
const BLOOM_BANDS = 8;
const BLOOM_REACH = 0.42;

/** World px where the street starts: everything above it is sky. */
function horizonY(world: World): number {
  return (world.city as { street: number }).street * TILE;
}

/** The world px under screen x — the backdrop covers the whole view, not just the world. */
const worldX = (cam: Camera, x: number): number => (x - Math.round(cam.ox)) / cam.zoom;

/** Sun or moon centre (world px) across the world, up a `sin^0.6` arc, so a low golden-hour sun
 * clears the roofs until its last minutes. */
export function bodyCenter(world: World, t: number): { x: number; y: number } {
  const base = horizonY(world) - ARC_BASE;
  const peak = 2 * TILE;
  return {
    x: Math.round(world.cols * TILE * (0.06 + 0.88 * t)),
    y: Math.round(base - (base - peak) * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.6),
  };
}

/** A pixel disc of radius `r` (world px) centred on (cx, cy), as horizontal runs. */
function disc(ctx: DrawTarget, cam: Camera, cx: number, cy: number, r: number, color: string): void {
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.round(Math.sqrt(r * r - dy * dy));
    rect(ctx, cam, cx - half, cy + dy, 2 * half + 1, 1, color);
  }
}

/** The skyline's grid step (world px): 8 in a low city, widened by the square root of how much
 * taller its skyline is, in whole 4-px windows; heights scale fully, so tall blocks read taller
 * without thinning into needles. */
function skylineStep(top: number): number {
  return 4 * Math.round(2 * Math.sqrt(top / SKYLINE_BASE));
}

/** Steps per skyline CHUNK: blocks are laid out afresh from each chunk's left edge, on a
 * world-fixed grid. */
const CHUNK_STEPS = 32;

/** Width of the block at world x (`hh`: its hash) in a chunk ending at `end`: 2–4 steps, adjusted
 * so a chunk never keeps a one-step sliver nor is overrun; chunks fill with whole blocks. */
function blockWidth(x: number, end: number, step: number, hh: number): number {
  const w = step * (2 + (hh % 3));
  const rest = end - x - w;
  if (rest === step) return w > 2 * step ? w - step : w + step;
  return rest < 0 ? end - x : w;
}

/** The height of a skyline block of hash `hh` in a skyline whose tallest is `top`: 35–99 % of it. */
function blockHeight(top: number, hh: number): number {
  return Math.round(top * (0.35 + ((hh >>> 4) % 65) / 100));
}

/** Walk skyline blocks over [x0, x1): `visit(x, w, h)`, each 35–99% of `skylineMax(horizon)`.
 * WORLD-LOCKED: laid out per fixed chunk, never from the view's edge (that re-rolled blocks on each
 * pan). A walk, not a list: it runs twice a night frame and must not allocate. */
export function forEachSkylineBlock(x0: number, x1: number, horizon: number, visit: (x: number, w: number, h: number) => void): void {
  const top = skylineMax(horizon);
  const step = skylineStep(top);
  const chunk = CHUNK_STEPS * step;
  for (let c = Math.floor(x0 / chunk) * chunk; c < x1; c += chunk)
    for (let x = c; x < c + chunk && x < x1; ) {
      const hh = hash(Math.floor(x / step), 7, 13);
      const w = blockWidth(x, c + chunk, step, hh);
      if (x + w > x0) visit(x, w, blockHeight(top, hh));
      x += w;
    }
}

/** World y where the skyline face begins at x (a block's top, or the street's top in the 1-px gap
 * after it); night-sky points at or below it are not painted. Same layout, no allocation. */
export function skylineFaceAt(x: number, horizon: number): number {
  const top = skylineMax(horizon);
  const step = skylineStep(top);
  const chunk = CHUNK_STEPS * step;
  const c = Math.floor(x / chunk) * chunk;
  for (let b = c; ; ) {
    const hh = hash(Math.floor(b / step), 7, 13);
    const w = blockWidth(b, c + chunk, step, hh);
    if (x < b + w - 1) return horizon - blockHeight(top, hh);
    if (x < b + w) return horizon;
    b += w;
  }
}

/** Is any of the skyline's band on screen? If not (zoomed onto upper floors or the lounge) its
 * blocks and windows aren't walked at all. */
function skylineInView(cam: Camera, view: { h: number }, horizon: number): boolean {
  return sy(cam, horizon) > 0 && sy(cam, horizon - skylineMax(horizon)) < view.h;
}

/** Walk skyline WINDOWS over [x0, x1): `visit(x, y)` per 1×2 px window, columns 4 px apart. Day
 * panes and night lights share this grid, so a light always lands in a pane. */
export function forEachSkylineWindow(x0: number, x1: number, horizon: number, visit: (x: number, y: number) => void): void {
  forEachSkylineBlock(x0, x1, horizon, (bx, bw, bh) => {
    for (let y = horizon - bh + 3; y < horizon - 3; y += 5) for (let x = bx + 2; x < bx + bw - 3; x += 4) visit(x, y);
  });
}

/** Each window has its own fixed hashed threshold, so the lit set only GROWS with `share`: the
 * same windows light first every evening. */
export function windowLit(x: number, y: number, share: number): boolean {
  return hash(x, y, 5) % 1000 < share * 1000;
}

/** Sky, sun, clouds, far skyline and the street across the whole view, painted first: the world's
 * sky tiles are transparent. Copies of `ground`'s street band run the street past the world
 * (without it, flat bands). */
export function paintCityBackdrop(
  ctx: DrawTarget,
  amb: Ambience | undefined,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
  ground: GroundLayer | null = null,
): void {
  const horizon = horizonY(world);
  const hs = sy(cam, horizon);
  const span = { x0: worldX(cam, 0), x1: worldX(cam, view.w) };
  const look = citySky(amb);
  const layers = backdropOf(amb);
  const scene: BackdropScene = { ctx, cam, world, view, amb, horizon, timeMs, x0: span.x0, x1: span.x1 };
  ctx.globalAlpha = 1;
  // Sky: world-space bands from the world's top to the horizon (the top band runs on up); a run
  // of equal bands is one fill (by day, the ten bands the city always had).
  const n = look.bands.length;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && look.bands[j] === look.bands[i]) j++;
    const top = i === 0 ? 0 : sy(cam, (horizon * i) / n);
    const bottom = sy(cam, (horizon * j) / n);
    if (bottom > 0 && top < view.h) {
      ctx.fillStyle = look.bands[i];
      ctx.fillRect(0, top, view.w, bottom - top);
    }
    i = j;
  }
  const weather = amb?.weather ?? "clear";
  const sunUp = amb?.arc?.body === "sun";
  // The glow low on the sun's side (golden hour, sunset, dawn): a stepped dome, widest and
  // strongest at the horizon, centred on the sun — or where it just set / is about to rise.
  if (look.bloom.alpha > 0) {
    const cx = bodyCenter(world, sunUp ? amb!.arc!.t : look.bloom.side).x;
    for (let k = 1; k <= BLOOM_BANDS; k++) {
      const top = (horizon * (n - k)) / n;
      const reach = Math.round(world.cols * TILE * BLOOM_REACH * ((BLOOM_BANDS + 1 - k) / BLOOM_BANDS));
      ctx.globalAlpha = look.bloom.alpha * ((BLOOM_BANDS + 1 - k) / BLOOM_BANDS);
      rect(ctx, cam, cx - reach, top, 2 * reach, horizon / n, look.bloom.color);
    }
    ctx.globalAlpha = 1;
  }
  // The sun, behind everything else in the sky: bigger and redder as it nears the horizon.
  if (sunUp) {
    const c = bodyCenter(world, amb!.arc!.t);
    const r = look.sun.r;
    disc(ctx, cam, c.x, c.y, r + 4, look.sun.glow);
    disc(ctx, cam, c.x, c.y, r, look.sun.color);
    const core = Math.max(2, Math.round((3 * r) / 7));
    disc(ctx, cam, c.x - Math.round((2 * r) / 7), c.y - Math.round((2 * r) / 7), core, look.sun.core);
  }
  // The city's far landmarks (Asia/Tokyo: Mt Fuji) — behind the clouds.
  paintFarLandmarks(ctx, cam, world, view, amb, horizon);
  // The clouds the weather calls for, over all the sky in view (render/clouds.ts).
  const ys = { y0: -Math.round(cam.oy) / cam.zoom, y1: (view.h - Math.round(cam.oy)) / cam.zoom };
  paintClouds(ctx, cam, { ...span, ...ys }, horizon, weather, amb?.intensity ?? 0, timeMs, amb?.wind ?? 0, look.cloud[CLOUD_COVER[weather].shade]);
  // The backdrop's HIGH layers (the high-rises) — in front of the clouds, behind the towers and the haze.
  for (const layer of layers.high) layer.paint(scene);
  // Its towers (Tokyo Tower, Skytree) — in front of the clouds, behind the skyline's blocks.
  paintLandmarks(ctx, cam, world, view, amb, horizon, timeMs);
  // The far skyline: hazy blocks standing on the horizon behind the street (in Tokyo, not in its open sky)…
  if (skylineInView(cam, view, horizon)) {
    if (layers.air) {
      ctx.save();
      clipAir(ctx, cam, view, span.x0, span.x1, horizon);
    }
    forEachSkylineBlock(span.x0, span.x1, horizon, (x, w, h) => {
      rect(ctx, cam, x, horizon - h, w - 1, h, look.skyline.block);
      rect(ctx, cam, x, horizon - h, w - 1, 1, look.skyline.edge);
    });
    // …and their windows: a 1×2 pane per window, drawn as one strip per window COLUMN plus walls
    // laid back between floors (`paneColumns`): columns + floors rects, not columns × floors.
    // Zoomed out, panes merge into a faint band per floor.
    if (cam.zoom >= PANE_ZOOM) forEachSkylineBlock(span.x0, span.x1, horizon, (bx, bw, bh) => paneColumns(ctx, cam, look.skyline, horizon, bx, bw, bh));
    else {
      ctx.fillStyle = look.skyline.pane;
      ctx.globalAlpha = 0.5;
      forEachSkylineBlock(span.x0, span.x1, horizon, (bx, bw, bh) => {
        for (let y = horizon - bh + 3; y < horizon - 3; y += 5) fillWorld(ctx, cam, bx + 2, y, bw - 5, 2);
      });
      ctx.globalAlpha = 1;
    }
    if (layers.air) ctx.restore();
  }
  // The backdrop's MID layers (the canyon, then the shops) — in front of the haze, behind the temples.
  for (const layer of layers.mid) layer.paint(scene);
  // The city's nearer landmarks (Asia/Tokyo: a pagoda, a shrine) — in front of the skyline's haze.
  paintNearLandmarks(ctx, cam, world, view, amb, horizon, timeMs);
  // The street, carried past the world's ends (the world's own tiles cover its middle).
  if (hs >= view.h) return;
  const row = (r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, sy(cam, horizon + r * TILE), view.w, TILE * cam.zoom);
  };
  row(0, CITY.sidewalk);
  row(1, ROAD.asphalt);
  row(2, ROAD.asphalt);
  row(3, CITY.sidewalk);
  rect(ctx, cam, span.x0 - 1, horizon + TILE, span.x1 - span.x0 + 2, 1, ROAD.edge);
  for (let c = Math.floor(span.x0 / TILE / 2) * 2; c * TILE < span.x1; c += 2) rect(ctx, cam, c * TILE + 3, horizon + 2 * TILE, 10, 1, ROAD.line);
  paintUnderground(ctx, cam, world, view, span, horizon + STREET_H);
  // The subway dug in under the lounge: its tunnel across the view, its station, stairwell and train.
  paintSubway(ctx, cam, world, view, timeMs);
  if (!ground) return;
  // Copies of the world's own street band — its four rows only: the lounge under it is the world's.
  for (let k = Math.floor(span.x0 / ground.w); k * ground.w < span.x1; k++)
    if (k !== 0)
      ctx.drawImage(ground.image, 0, horizon, ground.w, STREET_H, sx(cam, k * ground.w), hs, ground.w * cam.zoom, STREET_H * cam.zoom);
}

/** The ground under the street, from `top` to the view's bottom: turf, soil bands darkening with
 * depth, pebbles, dug soil round the lounge (the world paints over it). World-space; fine detail
 * only from `PANE_ZOOM`. */
function paintUnderground(
  ctx: DrawTarget,
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  span: { x0: number; x1: number },
  top: number,
): void {
  const y0 = sy(cam, top);
  if (y0 >= view.h) return;
  const soil = top + TURF;
  const n = CITY.soil.length;
  for (let i = 0; i < n; i++) {
    const a = sy(cam, soil + i * STRATUM);
    const b = i === n - 1 ? view.h : sy(cam, soil + (i + 1) * STRATUM);
    if (b <= 0 || a >= view.h) continue;
    ctx.fillStyle = CITY.soil[i];
    ctx.fillRect(0, a, view.w, b - a);
  }
  ctx.fillStyle = CITY.verge;
  ctx.fillRect(0, y0, view.w, sy(cam, soil) - y0);
  if (cam.zoom >= PANE_ZOOM) {
    // Blades of grass standing up out of the turf, one 4-px cell in three; pebbles in the soil.
    ctx.fillStyle = CITY.blade;
    for (let c = Math.floor(span.x0 / 4); c * 4 < span.x1; c++) if (hash(c, 3, 53) % 3 === 0) fillWorld(ctx, cam, c * 4 + 1, top - 1, 1, 3);
    ctx.fillStyle = CITY.pebble;
    const bottom = (view.h - Math.round(cam.oy)) / cam.zoom;
    for (let r = Math.floor(soil / PEBBLE_CELL); r * PEBBLE_CELL < bottom; r++)
      for (let c = Math.floor(span.x0 / PEBBLE_CELL); c * PEBBLE_CELL < span.x1; c++) {
        const h = hash(c, r, 61);
        if (h % 3 !== 0) continue;
        const y = r * PEBBLE_CELL + ((h >>> 9) % (PEBBLE_CELL - 2));
        if (y > soil) fillWorld(ctx, cam, c * PEBBLE_CELL + ((h >>> 3) % (PEBBLE_CELL - 3)), y, 3, 2);
      }
  }
  // The lounge is dug in: a band of darker soil round its outer walls (they cover its inner part).
  const lounge = world.city?.lounge;
  if (!lounge) return;
  const h = world.houses.find((x) => x.key === lounge.key) as World["houses"][number];
  rect(ctx, cam, (h.col - 1) * TILE - DUG, h.row * TILE - DUG, (h.w + 2) * TILE + 2 * DUG, (h.h + 1) * TILE + 2 * DUG, CITY.dug);
}

/** A block's panes as one strip per window column, then the block's colour laid back over the 3-px
 * walls between floors: the same pixels as a pane per window from PANE_ZOOM up (2-px panes and
 * 3-px walls are ≥ 1.5 screen px, never forced). Everything stays on the block's face. */
function paneColumns(ctx: DrawTarget, cam: Camera, colors: { block: string; pane: string }, horizon: number, bx: number, bw: number, bh: number): void {
  const top = horizon - bh + 3;
  const bottom = top + 5 * Math.ceil((bh - 6) / 5) - 3;
  ctx.fillStyle = colors.pane;
  for (let x = bx + 2; x < bx + bw - 3; x += 4) fillWorld(ctx, cam, x, top, 1, bottom - top);
  ctx.fillStyle = colors.block;
  for (let y = top + 2; y < bottom; y += 5) fillWorld(ctx, cam, bx + 2, y, bw - 3, 3);
}

/** Fill a world-px rect in the CURRENT fillStyle, edges snapped like `rect` (each batch of panes or windows sets it first). */
function fillWorld(ctx: DrawTarget, cam: Camera, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  ctx.fillRect(x, y, Math.max(1, sx(cam, wx + w) - x), Math.max(1, sy(cam, wy + h) - y));
}

/** World-px boxes of the props whose art reaches the far skyline (street trees, lamps): lit windows stay behind them. */
const occluderCache = new WeakMap<World, [number, number, number, number][]>();

/** Per-world boxes every lit window is tested against: street trees and lamps rising above the
 * street. Things wholly below the street (lounge, benches, lift) are left out: never in front. */
export function skylineOccluders(world: World): [number, number, number, number][] {
  const cached = occluderCache.get(world);
  if (cached) return cached;
  const { buildings } = world.city as CityInfo;
  const horizon = horizonY(world);
  const out: [number, number, number, number][] = [];
  for (const p of world.props) {
    // A building's furniture is already outside the open-sky clip.
    if (buildings.some((b) => p.col >= b.col && p.col + p.w <= b.col + b.w && p.row >= b.row && p.row + p.h <= b.row + b.h)) continue;
    // Tall art reaches a tile above its footprint (the frame culls props the same way).
    const top = (p.row - 1) * TILE;
    if (top >= horizon) continue;
    out.push([p.col * TILE, top, p.w * TILE, (p.row + p.h) * TILE - top]);
  }
  occluderCache.set(world, out);
  return out;
}

/** After the grade, clipped to open sky: stars and moon (overcast hides stars), lit windows (by
 * clock), then backdrop lights, HIGH before the landmarks', MID last, each cut by what stands in
 * front of its layer (`frontOf`, incl. this frame's street sprites). */
export function paintCityNight(
  ctx: DrawTarget,
  amb: Ambience,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
  street: readonly Box[] = [],
): void {
  const dark = Math.min(1, Math.max(0, (0.6 - amb.daylight) / 0.45));
  const lit = citySky(amb).lit;
  const horizon = horizonY(world);
  const span = { x0: worldX(cam, 0), x1: worldX(cam, view.w) };
  const { high, mid, air } = backdropOf(amb);
  const scene: BackdropScene = { ctx, cam, world, view, amb, horizon, timeMs, x0: span.x0, x1: span.x1 };
  /** The haze's face at world x — none in the open sky between the backdrop's clusters. */
  const hazeAt = (x: number): number => (air && inAir(x, x + 1) ? horizon : skylineFaceAt(x, horizon));
  /** The nearest face at world x: the haze's, or a layer's standing taller there. */
  const faceAt = (x: number): number => {
    let y = hazeAt(x);
    for (const layer of high) y = Math.min(y, layer.faceAt(scene, x));
    for (const layer of mid) y = Math.min(y, layer.faceAt(scene, x));
    return y;
  };
  // No star or moon shows through a landmark's silhouette (Fuji, the towers)…
  const behind = dark > 0 ? landmarkMask(cam, world, view, amb, horizon) : null;
  if (dark > 0 && amb.weather === "clear") {
    // One chance of a star per 32 px cell of visible sky, twinkling on its own phase, never in
    // front of a skyline block (a star on a block's face is behind it); the lookup costs ≈ 0.07 ms.
    const top = Math.max(-STAR_CELL * 4, -Math.round(cam.oy) / cam.zoom);
    for (let r = Math.floor(top / STAR_CELL); r * STAR_CELL < horizon - TILE; r++)
      for (let c = Math.floor(span.x0 / STAR_CELL); c * STAR_CELL < span.x1; c++) {
        const hh = hash(c, r, 71);
        if (hh % 3 !== 0) continue;
        const x = c * STAR_CELL + ((hh >>> 3) % STAR_CELL);
        const y = r * STAR_CELL + ((hh >>> 9) % STAR_CELL);
        if (behind?.(x, y) || y >= faceAt(x)) continue;
        ctx.globalAlpha = dark * (0.55 + 0.45 * Math.sin(timeMs / 600 + (hh % 360)));
        rect(ctx, cam, x, y, 1, 1, CITY.star);
      }
    // Now and then a shooting star: a bright head and a tail fading behind it, gone in a blink
    // (it brightens in and out at both ends of its run).
    const shot = shootingStar(timeMs, span, Math.max(top, 0), horizon - TILE);
    if (shot) {
      const fade = Math.min(1, shot.t / 0.15, (1 - shot.t) / 0.25);
      for (let k = SHOOTING_TAIL; k >= 0; k -= 2) {
        const x = shot.x - shot.dx * k;
        const y = shot.y - shot.dy * k;
        if (behind?.(x, y)) continue;
        ctx.globalAlpha = dark * fade * (1 - k / (SHOOTING_TAIL + 2));
        rect(ctx, cam, x, y, k === 0 ? 2 : 1, 1, CITY.star);
      }
    }
  }
  // The moon, rising and setting, is behind the skyline's blocks too (by its centre, like a landmark).
  const moon = dark > 0 && amb.arc?.body === "moon" ? bodyCenter(world, amb.arc.t) : null;
  if (moon && !behind?.(moon.x, moon.y) && moon.y < faceAt(moon.x)) {
    const c = moon;
    ctx.globalAlpha = dark * MOON_SEEN[amb.weather];
    disc(ctx, cam, c.x, c.y, 9, CITY.moonGlow);
    disc(ctx, cam, c.x, c.y, 6, CITY.moon);
    rect(ctx, cam, c.x + 1, c.y - 3, 3, 2, CITY.moonShade);
    rect(ctx, cam, c.x - 3, c.y + 1, 2, 2, CITY.moonShade);
  }
  ctx.globalAlpha = 1;
  // What stands in front of every layer's lights: the street's trees and lamps, and its sprites — those
  // reaching above the street, and not inside a building (the caller's clip already keeps light out of
  // those: an agent at its desk is cut by its floor). Every light is tested against each box left.
  const { buildings } = world.city as CityInfo;
  const inside = (b: Box) =>
    buildings.some((o) => b[0] >= o.col * TILE && b[0] + b[2] <= (o.col + o.w) * TILE && b[1] >= o.row * TILE && b[1] + b[3] <= (o.row + o.h) * TILE);
  const boxes = high.length + mid.length > 0 ? [...skylineOccluders(world), ...street.filter((b) => b[1] < horizon && !inside(b))] : [];
  /** The nearest MID face at world x (the street's top where none stands). */
  const midFace = (x: number): number => {
    let y = horizon;
    for (const layer of mid) y = Math.min(y, layer.faceAt(scene, x));
    return y;
  };
  // The HIGH layers' lights (the towers' lit floors): behind the landmarks, the haze and every MID layer.
  if (high.length > 0) {
    const cut = lightCutter(ctx, cam, {
      boxes,
      face: (x) => Math.min(hazeAt(x), midFace(x)),
      shapes: frontShapes(cam, world, view, amb, horizon, ["tower", "near"]),
    });
    for (const layer of high) layer.paintLights({ ...scene, amb, dark, lit, ...cut });
    ctx.globalAlpha = 1;
  }
  // The landmarks' own lights (evening to night): over the stars, under the skyline's lit windows.
  paintLandmarkLights(ctx, cam, world, view, amb, horizon, timeMs);
  // Lit windows in the far skyline, in panes of the day's grid — never over a street tree or lamp, nor
  // behind a MID layer standing in front of the haze.
  if (lit > 0 && skylineInView(cam, view, horizon)) {
    const hide = skylineOccluders(world);
    // The temples stand in front of the far skyline: none of its lit windows shows through them.
    const front = landmarkMask(cam, world, view, amb, horizon, ["near"]);
    ctx.fillStyle = CITY.window;
    forEachSkylineWindow(span.x0, span.x1, horizon, (x, y) => {
      if (!windowLit(x, y, lit)) return;
      if (front?.(x, y) || front?.(x, y + 1)) return;
      if (mid.length > 0 && y + 1 >= midFace(x)) return;
      if (air && inAir(x, x + 1)) return;
      for (const [ox, oy, ow, oh] of hide) if (x + 1 > ox && x < ox + ow && y + 2 > oy && y < oy + oh) return;
      fillWorld(ctx, cam, x, y, 1, 2);
    });
  }
  // The MID layers' lights (the canyon's signs, the shops): in front of all the rest, behind the temples —
  // back to front, each behind the faces of the MID layers after it (the canyon behind the shops).
  if (mid.length > 0) {
    const shapes = frontShapes(cam, world, view, amb, horizon, ["near"]);
    mid.forEach((layer, i) => {
      const nearer = mid.slice(i + 1);
      const face =
        nearer.length > 0
          ? (x: number) => {
              let y = horizon;
              for (const n of nearer) y = Math.min(y, n.faceAt(scene, x));
              return y;
            }
          : null;
      layer.paintLights({ ...scene, amb, dark, lit, ...lightCutter(ctx, cam, { boxes, face, shapes }) });
    });
    ctx.globalAlpha = 1;
  }
}

/** On-screen landmarks of `layers` as light-cutting shapes (render/backdropLights.ts): each box
 * (as `landmarkMask` culls) and its pixel mask. */
function frontShapes(
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience,
  horizon: number,
  layers: readonly LandmarkSpec["layer"][],
): Shape[] {
  const hit = landmarkMask(cam, world, view, amb, horizon, layers);
  if (!hit) return [];
  // Fuji and the towers are one run of columns a row (cut a row at a time); a temple, pixel by pixel.
  return placeLandmarks(world, horizon, landmarksFor(amb.zone))
    .placed.filter((p) => layers.includes(p.spec.layer))
    .map((p) => ({
      box: [p.x - p.hw, horizon - p.h - 2, 2 * p.hw + 1, p.h + 2],
      hit,
      ...(p.spec.layer !== "near" && { row: (y: number) => landmarkRow(p, horizon, y) }),
    }));
}

/** Screen rect of a world-px rect (for building the sky's clip path). */
export function screenRect(cam: Camera, x: number, y: number, w: number, h: number): [number, number, number, number] {
  return [sx(cam, x), sy(cam, y), w * cam.zoom, h * cam.zoom];
}
