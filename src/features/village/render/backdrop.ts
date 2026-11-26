/** Backdrop layers at two depths of `paintCityBackdrop` (render/city.ts): sky · sun · Fuji ·
 * clouds · [HIGH] · Tokyo Tower/Skytree · haze · [MID] · temples. Layers paint DAY colours, then
 * lights via `fillLit` after the grade; no roof may cover a landmark's crown (`roofLimit`). */

import { TILE, type Ambience, type CityInfo, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { landmarkCrown, landmarksFor, placeLandmarks, type LandmarkSpec } from "./landmarks";
import { hash } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** What a layer paints with, and where. */
export interface BackdropScene {
  ctx: DrawTarget;
  cam: Camera;
  world: World;
  view: { w: number; h: number };
  /** undefined = the plain day with no city zone (no landmarks). */
  amb: Ambience | undefined;
  /** World y of the street's top edge: everything stands on it. */
  horizon: number;
  timeMs: number;
  /** The world x the view spans, [x0, x1). */
  x0: number;
  x1: number;
}

/** The night pass's scene: after the grade, clipped (by the caller) to open sky. */
export interface BackdropLightScene extends BackdropScene {
  amb: Ambience;
  /** How dark it is, 0 (day) .. 1 (night): the stars' measure. */
  dark: number;
  /** The share of the far skyline's windows lit now (`citySky(amb).lit`): 0 by day, rising from golden hour. */
  lit: number;
  /** Fill a world-px rect of light (CURRENT `fillStyle`/`globalAlpha`) less whatever is in front
   * of this layer. Every light a layer paints goes through here. */
  fillLit(x: number, y: number, w: number, h: number): void;
  /** Is world pixel (x, y) covered by something in front of this layer? (For a layer's own tests and tiny lights.) */
  hidden(x: number, y: number): boolean;
}

/** One layer of the backdrop. */
export interface BackdropLayer {
  /** The day pass, at the layer's depth, in DAY colours. Paints nothing off the view. */
  paint(s: BackdropScene): void;
  /** The layer's lights, after the grade — every one through `s.fillLit`. */
  paintLights(s: BackdropLightScene): void;
  /** World y where the layer's OPAQUE face begins at world x (`s.horizon` where nothing stands).
   * World-locked; stars, moon and farther layers' lights stay behind it. */
  faceAt(s: BackdropScene, x: number): number;
}

/** World px a backdrop roof keeps below a landmark crown over it, and either side of it. */
export const CROWN_PAD = 8;

/** Highest world y a roof over [x0, x1) may reach without covering a crown of `layers`: `CROWN_PAD`
 * under each overlapped (padded) crown's lowest point; `-Infinity` if none. HIGH passes `["far"]`,
 * MID `["far", "tower"]`. Pure; placement is cached per world (render/landmarks.ts). */
export function roofLimit(
  world: World,
  amb: Ambience | undefined,
  horizon: number,
  x0: number,
  x1: number,
  layers: readonly Exclude<LandmarkSpec["layer"], "near">[],
): number {
  const specs = landmarksFor(amb?.zone);
  let limit = -Infinity;
  if (specs.length === 0) return limit;
  for (const p of placeLandmarks(world, horizon, specs).placed) {
    if (!(layers as readonly string[]).includes(p.spec.layer)) continue;
    const c = landmarkCrown(p);
    if (x1 > c.x0 - CROWN_PAD && x0 < c.x1 + CROWN_PAD) limit = Math.max(limit, c.bottom + CROWN_PAD);
  }
  return limit;
}

/** Open sky between clusters: one world-locked stretch per `AIR_CHUNK` px, `AIR_MIN`–`AIR_MAX`
 * wide, hashed from the chunk; MID layers build nothing there and the haze is not painted. Every
 * layer reads the SAME stretches, so a gap in the shops is a gap in the canyon too. */
export const AIR_CHUNK = 288;
export const AIR_MIN = 64;
export const AIR_MAX = 120;

/** Every open stretch [a, b) that overlaps world x ∈ [x0, x1), left to right. Pure. */
export function airSpans(x0: number, x1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let c = Math.floor(x0 / AIR_CHUNK); c * AIR_CHUNK < x1; c++) {
    const hh = hash(c, 41, 97);
    const w = AIR_MIN + (hh % (AIR_MAX - AIR_MIN + 1));
    const a = c * AIR_CHUNK + ((hh >>> 8) % (AIR_CHUNK - w + 1));
    if (a + w > x0 && a < x1) out.push([a, a + w]);
  }
  return out;
}

/** Does world x ∈ [x0, x1) touch any open stretch? (A backdrop building that does is not built.) */
export function inAir(x0: number, x1: number): boolean {
  return airSpans(x0, x1).length > 0;
}

/** World x [a, b) between the city's outermost walls (null: no buildings). */
export function citySpan(world: World): readonly [number, number] | null {
  const bs = (world.city as CityInfo).buildings;
  if (bs.length === 0) return null;
  return [Math.min(...bs.map((b) => b.col * TILE)), Math.max(...bs.map((b) => (b.col + b.w) * TILE))];
}

/** Quiet stretches, where the neon layers build nothing and apartments stand instead: the open sky
 * (`airSpans`) and the city's own span. Every layer reads the SAME stretches; returned in world x
 * order, the city's span merged with any sky stretch it overlaps. */
export function quietSpans(world: World, x0: number, x1: number): [number, number][] {
  const out = airSpans(x0, x1);
  const city = citySpan(world);
  if (!city || city[1] <= x0 || city[0] >= x1) return out;
  const merged: [number, number][] = [];
  let [a, b] = city;
  for (const s of out) {
    if (s[1] < a || s[0] > b) merged.push(s);
    else [a, b] = [Math.min(a, s[0]), Math.max(b, s[1])];
  }
  merged.push([a, b]);
  return merged.sort((p, q) => p[0] - q[0]);
}

/** Does world x ∈ [x0, x1) touch a quiet stretch? (A canyon building or a shop that does is not built.) */
export function inQuiet(world: World, x0: number, x1: number): boolean {
  return quietSpans(world, x0, x1).some(([a, b]) => b > x0 && a < x1);
}

/** A shop sign's word: the kana it is written in, and what it says. */
export interface SignWord {
  text: string;
  /** In English, for the tests and the PR. */
  meaning: string;
}

/** Every word a backdrop sign may spell; render/kana.ts draws exactly these. */
export const SIGN_WORDS: readonly SignWord[] = [
  { text: "ラーメン", meaning: "ramen" },
  { text: "ソバ", meaning: "soba" },
  { text: "すし", meaning: "sushi" },
  { text: "カレー", meaning: "curry" },
  { text: "コーヒー", meaning: "coffee" },
  { text: "カラオケ", meaning: "karaoke" },
  { text: "バー", meaning: "bar" },
  { text: "ゲーム", meaning: "game centre" },
  { text: "ホテル", meaning: "hotel" },
];
