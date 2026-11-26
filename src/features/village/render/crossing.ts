/** Painted every frame, NOT baked into the cached ground: the backdrop repeats that layer's street
 * band past the world's ends (render/city.ts), so a baked crossing would repeat every world-width.
 * Whole world px on purpose, so the four bars survive at ½ zoom. Columns come from `crossingOf`. */

import { crossingOf } from "../engine/streetTheme";
import { TILE, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { onScreen, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";
import { ROAD } from "./tiles";

/** The crossing's colours: worn white road paint, on the road's own asphalt. Exported for the tests. */
export const CROSSING = { paint: "#e9e5d8", asphalt: ROAD.asphalt } as const;

/** Each bar's top, world px below the top of the first lane (whose first px is the kerb line). */
export const BAR_TOPS: readonly number[] = [2, 10, 18, 26];
/** A bar's height, world px — the gaps between bars are as tall. */
export const BAR_H = 4;
/** World px of bare asphalt either side of the bars, so the crossing reads as a patch of its own. */
export const BAR_INSET = 2;

/** Paint the crossing of `world`'s street (nothing in a city without one, or when it is off screen). */
export function paintCrossing(ctx: DrawTarget, cam: Camera, world: World, view: { w: number; h: number }): void {
  const x = crossingOf(world);
  if (!x) return;
  // Its two lanes: the rows between the sidewalks.
  const x0 = x.col * TILE;
  const y0 = (x.row + 1) * TILE;
  const w = x.w * TILE;
  if (!onScreen(cam, view, x0, y0, w, 2 * TILE)) return;
  // The centre dashes run along the second lane's top edge: blanked across the crossing.
  rect(ctx, cam, x0, y0 + TILE, w, 1, CROSSING.asphalt);
  for (const top of BAR_TOPS) rect(ctx, cam, x0 + BAR_INSET, y0 + top, w - 2 * BAR_INSET, BAR_H, CROSSING.paint);
}
