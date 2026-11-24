/**
 * Agent Village — the camera: a zoom plus a screen-pixel offset of the world
 * origin. One projection shared by the canvas and any DOM overlay (the panel's
 * tooltip / hit-testing), so a label can never drift a pixel off its sprite.
 *
 * The zoom is an integer 1..8 (crisp pixel art) — or, ONLY for a scene that opts in
 * (`fitCamera`'s `minZoom`: the city, a tall one at dpr 1 being 80 world px a floor) so a
 * world bigger than the view can still be seen whole, a zoom below 1 that is a whole number of
 * SIXTEENTHS (k/16): a 16-px tile then lands on k whole screen pixels, and with smoothing off the
 * art is sampled, never blurred. Fit takes the largest k/16 that shows the world (with
 * only halvings a street a little wider than a ~720 px pane dropped straight to ½ and was
 * drawn tiny); the −/+ buttons and the wheel step through the coarse
 * rungs ¾, ½, ¼, ⅛ (`SUB_ZOOMS`). The village opts in down to ½ (VillageView): the largest k/16
 * that shows it whole, else ½, framed on its civic row so the capacity houses stay in view
 * (cropping at 1 hid half of them in a ~720 px pane).
 */

export interface Camera {
  /** Screen pixels per art pixel: an integer 1..8, or ½ / ¼ / ⅛ for an overview. */
  zoom: number;
  /** Screen-pixel position of the world origin. */
  ox: number;
  oy: number;
}

/** The smallest WHOLE zoom — where zooming out stops unless the world needs less to fit. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** The smallest zoom at all (a scene's `minZoom` floor for an overview). */
export const MIN_FIT_ZOOM = 1 / 8;
/** The coarse overview rungs below 1 that zoom steps go through, largest first. */
export const SUB_ZOOMS: readonly number[] = [3 / 4, 1 / 2, 1 / 4, MIN_FIT_ZOOM];

/** Round to an integer zoom inside [MIN_ZOOM, MAX_ZOOM]; anything non-finite becomes MIN_ZOOM. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
}

/** World px → screen px (unrounded; the renderer snaps). */
export function worldToScreen(
  cam: Camera,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return { x: cam.ox + wx * cam.zoom, y: cam.oy + wy * cam.zoom };
}

/** Screen px → world px (fractional; `Math.floor(x / TILE)` gives the tile). */
export function screenToWorld(
  cam: Camera,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - cam.ox) / cam.zoom, y: (sy - cam.oy) / cam.zoom };
}

/**
 * `zoom` moved `step` zoom steps: whole steps from 1 up to MAX_ZOOM, the `SUB_ZOOMS` rungs
 * below 1 — never below `floor` (MIN_ZOOM unless the world needs less to be seen whole).
 */
export function stepZoom(zoom: number, step: number, floor: number = MIN_ZOOM): number {
  let z = zoom;
  for (let i = 0; i < Math.abs(step); i++) {
    if (step > 0) z = z < 1 ? (SUB_ZOOMS.filter((s) => s > z).at(-1) ?? 1) : z + 1;
    else z = z > 1 ? z - 1 : (SUB_ZOOMS.find((s) => s < z) ?? z / 2);
  }
  return Math.min(MAX_ZOOM, Math.max(floor, MIN_FIT_ZOOM, z));
}

/** Fit's resolution below 1: whole sixteenths (a 16-px tile on whole pixels). */
const FIT_STEPS = 16;

/**
 * The largest zoom at which the whole world fits the view, centred: an integer
 * (capped at MAX_ZOOM) when it fits at 1; else the largest k/16 that fits, down to `minZoom`
 * (default MIN_ZOOM: nothing below 1 at all). A world bigger than the view even at the floor
 * overflows symmetrically.
 */
export function fitCamera(
  worldW: number,
  worldH: number,
  viewW: number,
  viewH: number,
  minZoom: number = MIN_ZOOM,
): Camera {
  const fit = Math.min(viewW / Math.max(1, worldW), viewH / Math.max(1, worldH));
  const floor = Math.max(MIN_FIT_ZOOM, Math.min(MIN_ZOOM, minZoom));
  const zoom =
    fit < 1
      ? Math.max(floor, MIN_FIT_ZOOM, Math.floor(fit * FIT_STEPS) / FIT_STEPS)
      : clampZoom(Math.floor(fit));
  return {
    zoom,
    ox: Math.round((viewW - worldW * zoom) / 2),
    oy: Math.round((viewH - worldH * zoom) / 2),
  };
}
