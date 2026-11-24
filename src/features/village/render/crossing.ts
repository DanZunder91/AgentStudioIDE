/**
 * Agent Village — the CITY's pedestrian crossing (busy agents take a lift up
 * to the street and walk to the building they belong in). A rider comes up the lounge's lift at its
 * kiosk on the far sidewalk, right under the capacity HQ's door, and walks across both lanes to the
 * near sidewalk there. A zebra crossing marks that walk: `crossingOf` (engine/streetTheme.ts — the
 * dresser keeps its landing clear) gives its three columns, centred on the lift.
 *
 * The stripes run ALONG the road — parallel to the traffic, as on a real zebra (Japan's included) —
 * stacked across the two lanes, so a walker steps over them one by one: four bars of 4 world px with
 * 4-px gaps, below the kerb line the first lane carries (render/tiles.ts) and clear of the far
 * sidewalk. Whole world pixels on purpose: at ½ each bar and each gap is 2 screen px (still four
 * bars), at 3 they are 12. The road's yellow centre dashes stop at the crossing, as a real centre line
 * does: one asphalt row covers them where the bars would leave them showing.
 *
 * Painted every frame (render/frame.ts, right after the ground, under the puddles and everything
 * standing on the street), NOT baked into the cached ground layer: the backdrop lays copies of that
 * layer's street band beside the world (render/city.ts) to run the street on past its ends, and a
 * crossing baked into it would repeat every world-width, in front of nothing. Five rects, culled.
 */

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
