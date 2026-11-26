/** One projection shared by the canvas and DOM overlays, so a label never drifts off its sprite.
 * Zoom is an integer 1..8 (crisp pixel art); scenes opting in (`fitCamera`'s `minZoom`) also get
 * k/16 below 1, so a 16-px tile lands on whole screen px (sampled, never blurred). */

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

/** Whole steps from 1 to MAX_ZOOM, the `SUB_ZOOMS` rungs below 1; never below `floor`. */
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

/** Largest zoom fitting the whole world, centred: an integer (≤ MAX_ZOOM) if it fits at 1, else the
 * largest k/16 down to `minZoom` (default MIN_ZOOM: nothing below 1). Too big even at the floor:
 * it overflows symmetrically. */
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
