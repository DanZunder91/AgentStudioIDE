/** Clouds fill the whole sky in view from a field of `CELL_W`×`CELL_H` cells, each cell's cloud a
 * hash of the cell (never `Math.random`), world-locked: a pan or zoom moves it with the street.
 * Cost is bounded by the view: only the cells it overlaps are looked at. */

import type { CloudShade } from "../engine/ambience";
import { TILE, type WeatherKind } from "../villageTypes";
import type { Camera } from "./camera";
import { hash, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Per weather: share of cells holding a cloud, width range in tiles (`w0`..`w1`, inclusive),
 * shade. A cloudy sky follows the live cover (`share` thin to `full` full, widths up to `grow`×).
 * Fog has its own bands and no clouds. */
export const CLOUD_COVER: Record<WeatherKind, { share: number; live?: { full: number; grow: number }; w0: number; w1: number; shade: CloudShade }> = {
  clear: { share: 0.08, w0: 3, w1: 6, shade: "light" },
  cloudy: { share: 0.35, live: { full: 0.95, grow: 0.5 }, w0: 8, w1: 18, shade: "grey" },
  fog: { share: 0, w0: 0, w1: 0, shade: "grey" },
  drizzle: { share: 0.85, w0: 10, w1: 22, shade: "grey" },
  rain: { share: 0.9, w0: 12, w1: 24, shade: "dark" },
  snow: { share: 0.85, w0: 10, w1: 22, shade: "grey" },
  storm: { share: 0.95, w0: 14, w1: 26, shade: "storm" },
};

/** A cell of the field (world px): 20 tiles wide, 5 tall. */
export const CELL_W = 20 * TILE;
export const CELL_H = 5 * TILE;
/** World px between the horizon and the lowest row's bottom (the lowest clouds stand over the roofs' line). */
export const LOW = 5 * TILE;
/** World px the field runs on above the world's top, and the least height of it. */
export const ABOVE = 6 * TILE;
export const MIN_BAND = 40 * TILE;
/** The widest a cloud gets (world px): the tallest, too — `cloudHeight` of it, its crown included. */
const MAX_W = Math.ceil(Math.max(...Object.values(CLOUD_COVER).map((c) => c.w1 * (1 + (c.live?.grow ?? 0)))) * TILE);

/** A cloud at least this wide (world px) is a BANK: it carries a crown over its puffs. */
export const BANK_W = 8 * TILE;

/** A cloud's height unit: 2 px for a fair cloud, a 24th of its width for a bank (wide is tall). */
export function cloudUnit(w: number): number {
  return w < BANK_W ? 2 : Math.round(w / 24);
}

/** World px from a cloud's top (its crown, on a bank) to its underside's bottom. */
export function cloudHeight(w: number): number {
  return (w >= BANK_W ? 6 : 5) * cloudUnit(w);
}

/** Row `r`'s drift (world px) at `t`: 2–4 px a second, its own speed, the wind's way. */
export function rowDrift(r: number, t: number, wind: number): number {
  return (t / 1000) * (2 + (hash(r, 0, 41) % 3)) * (wind < 0 ? -1 : 1);
}

/** Cell share and draw-width scale (1 = as is). For cloudy, `intensity` is Open-Meteo `cloud_cover`
 * / 100 (src-tauri/src/weather.rs; 0.6 with no live reading); every other weather's is fixed. */
export function cloudCover(weather: WeatherKind, intensity: number): { share: number; scale: number } {
  const c = CLOUD_COVER[weather];
  if (!c.live) return { share: c.share, scale: 1 };
  const k = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  return { share: c.share + (c.live.full - c.share) * k, scale: 1 + c.live.grow * k };
}

/** The cloud in cell `k` of row `r`, world px from the row's drift; null if the cell is clear. */
export function cloudIn(k: number, r: number, weather: WeatherKind, cover: { share: number; scale: number }): { dx: number; dy: number; w: number } | null {
  const c = CLOUD_COVER[weather];
  const h = hash(k, r, 29);
  if (h % 1000 >= cover.share * 1000) return null;
  const w = Math.round((c.w0 + ((h >>> 10) % (c.w1 - c.w0 + 1))) * TILE * cover.scale);
  return { dx: k * CELL_W + ((h >>> 14) % CELL_W), dy: (h >>> 22) % (CELL_H / 2), w };
}

/** Paint the clouds over the sky in view (world x `x0`..`x1`, y `y0`..`y1`): rows from `LOW` above
 * the `horizon` to `ABOVE` over the world's top. */
export function paintClouds(
  ctx: DrawTarget,
  cam: Camera,
  span: { x0: number; x1: number; y0: number; y1: number },
  horizon: number,
  weather: WeatherKind,
  intensity: number,
  t: number,
  wind: number,
  color: { body: string; under: string },
): void {
  const cover = cloudCover(weather, intensity);
  if (cover.share === 0) return;
  const base = horizon - LOW;
  const top = Math.min(-ABOVE, base - MIN_BAND);
  const rows = Math.ceil((base - top) / CELL_H);
  // Row r's clouds stand from its top (base − (r+1)·CELL_H) down to its middle, and reach a cloud's height below.
  const tall = cloudHeight(MAX_W);
  const rFrom = Math.max(0, Math.floor((base - span.y1) / CELL_H) - 1);
  const rTo = Math.min(rows - 1, Math.ceil((base + tall - span.y0) / CELL_H));
  for (let r = rFrom; r <= rTo; r++) {
    const rowTop = base - (r + 1) * CELL_H;
    const o = rowDrift(r, t, wind);
    const kTo = Math.floor((span.x1 - o) / CELL_W);
    for (let k = Math.floor((span.x0 - o - MAX_W) / CELL_W) - 1; k <= kTo; k++) {
      const c = cloudIn(k, r, weather, cover);
      if (!c) continue;
      const x = o + c.dx;
      if (x >= span.x1 || x + c.w <= span.x0) continue;
      cloud(ctx, cam, x, rowTop + c.dy, c.w, color);
    }
  }
}

/** One cloud `w` px wide from (x, y); a bank (`BANK_W` and wider) adds a crown over the puffs. */
function cloud(ctx: DrawTarget, cam: Camera, x: number, y: number, w: number, color: { body: string; under: string }): void {
  const u = cloudUnit(w);
  const bank = w >= BANK_W;
  const y0 = bank ? y + u : y;
  if (bank) rect(ctx, cam, x + Math.round(w * 0.25), y, Math.round(w * 0.3), 2 * u, color.body);
  rect(ctx, cam, x, y0 + 2 * u, w, 3 * u, color.body);
  rect(ctx, cam, x + Math.round(w * 0.15), y0, Math.round(w * 0.45), 3 * u, color.body);
  rect(ctx, cam, x + Math.round(w * 0.5), y0 + Math.round(u / 2), Math.round(w * 0.35), 3 * u - Math.round(u / 2), color.body);
  // Its underside, lit from below at sunrise and sunset (by day just a shade darker).
  rect(ctx, cam, x + 1, y0 + 4 * u, w - 2, u, color.under);
}
