/**
 * Agent Village — the City's BACKDROP: what stands behind the street in Tokyo.
 *
 * At Fit, a strip of low haze next to a four-floor gazelle leaves the sky behind the street almost
 * empty. The backdrop fills that sky: towers, ramen shops and the like in the background, big lit
 * buildings by night and by day, and neon signs for ramen and soba in katakana and for sushi in
 * hiragana.
 *
 * It is three layers — towers, a neon canyon and a yokochō of food shops — with some empty space left
 * between their clusters and karaoke among the signs. In a city with the Tokyo street
 * theme (render/city.ts `backdropOf`):
 *
 *   - the high-rises (render/backdropTowers.ts) stand out of the haze;
 *   - the neon canyon (render/backdropCanyon.ts) stands in front of the haze;
 *   - the yokochō shops (render/backdropShops.ts) stand in front of the canyon;
 *   - between their clusters there is open sky (`airSpans`).
 *
 * Any other city keeps the haze alone.
 *
 * A backdrop is LAYERS at two depths of `paintCityBackdrop` (render/city.ts):
 *
 *   sky · sun · Fuji · clouds · [HIGH layers] · Tokyo Tower / Skytree · the haze · [MID layers] · temples
 *
 * A HIGH layer stands behind the towers and the haze (its feet are in the haze). A MID layer stands in
 * front of the haze, behind the temples and everything the world itself draws, and behind any MID layer
 * after it. Each layer paints in DAY colours; the outdoor grade turns them to dusk and night, as it does
 * the haze and the landmarks. Then it paints its own LIGHTS after the grade, through `fillLit`, which
 * leaves out whatever stands in front of that layer: the haze or a nearer layer, a temple, a street tree
 * or lamp, a passer-by.
 *
 * The landmarks are never hidden: no backdrop roof rises into a crown it would
 * cover (`roofLimit`). For a HIGH layer that means Fuji's; for a MID one, Fuji's and the towers'.
 */

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
  /**
   * Fill a world-px rect of light in the CURRENT `fillStyle` and `globalAlpha`, less every part of it
   * that something in front of this layer covers. Every light a layer paints goes through here.
   */
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
  /**
   * World y where the layer's OPAQUE face begins at world x — the top of what stands there, or
   * `s.horizon` where nothing does. World-locked (a pure function of world x for a given world): the
   * stars, the moon and a farther layer's lights stay behind it.
   */
  faceAt(s: BackdropScene, x: number): number;
}

/** World px a backdrop roof keeps below a landmark crown over it, and either side of it. */
export const CROWN_PAD = 8;

/**
 * The highest a backdrop roof standing over world x ∈ [x0, x1) may rise — a world y it must stay at or
 * below — so that no crown of the given landmark `layers` is covered: `CROWN_PAD` under the lowest
 * point of every crown whose span (padded `CROWN_PAD` either side) it overlaps. `-Infinity` when no
 * such crown is over it (no limit). A HIGH layer passes `["far"]` (it stands in front of Fuji only);
 * a MID layer `["far", "tower"]`. Pure; the placement is cached per world (render/landmarks.ts).
 */
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

/**
 * The open sky between the backdrop's clusters (fewer buildings side by side, with empty space left
 * between them). These are world-locked stretches where the MID layers (the
 * canyon and the shops) build nothing and the haze is not painted, so the sky, and the towers far behind,
 * show between clusters of buildings. There is one stretch per `AIR_CHUNK` world px, `AIR_MIN`–`AIR_MAX`
 * wide, at a place hashed from the chunk. Every layer reads the SAME stretches, so a gap in the shops is a
 * gap in the canyon behind them too.
 */
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

/**
 * The city's own span: world x [a, b) from its outermost wall to its outermost wall (null: no
 * buildings). Behind its buildings nothing shows; between them the street's gaps hold the temples,
 * Tokyo Tower and the sakura.
 */
export function citySpan(world: World): readonly [number, number] | null {
  const bs = (world.city as CityInfo).buildings;
  if (bs.length === 0) return null;
  return [Math.min(...bs.map((b) => b.col * TILE)), Math.max(...bs.map((b) => (b.col + b.w) * TILE))];
}

/**
 * The QUIET stretches, where the neon district (the canyon, the shops) builds nothing and the
 * apartments stand instead (render/backdropApartments.ts). They are:
 *   - the open stretches of sky between its clusters (`airSpans`). Buildings with lights stand behind
 *     those empty spaces, some lit and some dark like vacant apartments, because otherwise the city
 *     looks unfinished;
 *   - the city's own span (`citySpan`). A sign-lit shop and canyon behind the shrine, in a narrow gap
 *     between two of the city's buildings, looked overloaded, while Tokyo Tower standing in a calm gap
 *     looked fine. Inside the city the street's gaps stay calm.
 * Every layer reads the SAME stretches. Returned in world x order; the city's span is merged with any
 * stretch of sky it overlaps.
 */
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

/**
 * Every word a backdrop sign may spell (render/kana.ts draws exactly these): katakana for ramen, soba
 * and the rest, hiragana for sushi.
 */
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
