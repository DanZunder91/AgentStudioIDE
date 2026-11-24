/**
 * The City's CLOUDS (a cloudy afternoon in Tokyo used to show only two clouds
 * in the sky). They used to be a fixed handful per WORLD — six on a cloudy day, each 3–6 tiles wide —
 * scattered over the world's width and its own sky only, so a view held two. Now the weather sets how
 * much of the sky is COVERED (`CLOUD_COVER`), and the clouds fill the whole sky in view: past the
 * world's ends and above its top, as the sky bands themselves do. A clear day keeps a few small fair
 * clouds; a cloudy one is mostly cloud — wide grey banks in rows, overlapping.
 *
 * A FIELD of cells, `CELL_W` × `CELL_H` world px, in rows going up from `LOW` above the horizon to
 * `ABOVE` over the world's top (`MIN_BAND` tall at least, so a low city's tall view is not bare up
 * there): each cell holds at most one cloud, and whether it does — its width and its place in the
 * cell — is a hash of the cell (never `Math.random`), so it is the same sky every frame. Each ROW
 * drifts with the wind at a speed of its own (2–4 world px a second, the wind's sign its direction),
 * so the rows slide past each other.
 *
 * WORLD-LOCKED (visibility is a property of the World, never of one camera): a cloud is a function of world x/y and the frame's clock alone — a pan
 * or a zoom moves it exactly with the street.
 *
 * COST is bounded by the view, not the world: only the cells it overlaps are looked at — at most
 * (view width / CELL_W + 2) cells in each of the rows in view — and a cloud is 4 rects (5 for a bank).
 * Measured (Chromium, a seven-floor city, the whole backdrop, a full cloud cover against a
 * clear sky): +0.3 ms at zoom 1 (1280×800: 0.60 → 0.89 ms), +0.1–0.3 ms zoomed out to ½ and ¼, where
 * the rest of the backdrop dominates (2.3 → 2.4 ms, 3.5 → 3.8 ms).
 */

import type { CloudShade } from "../engine/ambience";
import { TILE, type WeatherKind } from "../villageTypes";
import type { Camera } from "./camera";
import { hash, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/**
 * How each weather covers the sky: the share of cells holding a cloud, its width range in tiles
 * (`w0`..`w1`, both included), and its shade. A cloudy sky follows the live cloud cover (`cloudCover`,
 * its `live`): `share` of the cells under a thin cover, `full` under a full one — and its clouds grow
 * wider with it, by up to `grow` × their width, so an overcast sky is mostly cloud. Fog has its own
 * bands and no clouds.
 */
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

/**
 * A cloud `w` px wide: its height unit. A fair cloud's is 2 px whatever its width — the 10-px cloud the
 * City always had; a bank's grows with its width (a 24th of it), so a wide grey bank is tall too.
 */
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

/**
 * How `weather` covers the sky: the share of the field's cells holding a cloud, and how much wider than
 * its tiles a cloud is drawn (1 = as is). A cloudy sky follows the live cloud cover — `intensity` is
 * Open-Meteo's `cloud_cover` / 100 for it (src-tauri/src/weather.rs `intensity`; 0.6 when there is no
 * live reading) — every other weather's is fixed.
 */
export function cloudCover(weather: WeatherKind, intensity: number): { share: number; scale: number } {
  const c = CLOUD_COVER[weather];
  if (!c.live) return { share: c.share, scale: 1 };
  const k = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  return { share: c.share + (c.live.full - c.share) * k, scale: 1 + c.live.grow * k };
}

/**
 * The cloud in cell `k` of row `r` under `weather`, its cover `cover` (`cloudCover`), as world px from
 * the row's drift — or null if that cell is clear.
 */
export function cloudIn(k: number, r: number, weather: WeatherKind, cover: { share: number; scale: number }): { dx: number; dy: number; w: number } | null {
  const c = CLOUD_COVER[weather];
  const h = hash(k, r, 29);
  if (h % 1000 >= cover.share * 1000) return null;
  const w = Math.round((c.w0 + ((h >>> 10) % (c.w1 - c.w0 + 1))) * TILE * cover.scale);
  return { dx: k * CELL_W + ((h >>> 14) % CELL_W), dy: (h >>> 22) % (CELL_H / 2), w };
}

/**
 * The clouds `weather` brings (`intensity`: its `Ambience.intensity`) over the sky in view (world x `x0`..`x1`, y `y0`..`y1`): the field's rows
 * up from `LOW` above the `horizon` to `ABOVE` over the world's top, each cell's cloud if it holds one.
 */
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

/**
 * One cloud, `w` px wide from (x, y): a long base, two puffs over it, a lit underside — and on a bank
 * (`BANK_W` and wider) a crown over the puffs. Its height grows with its width (`cloudUnit`).
 */
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
