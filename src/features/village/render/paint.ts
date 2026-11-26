/** Shared painting primitives. Positions are WORLD px snapped to the screen grid
 * (`round(ox) + floor(round(wx) * zoom)`), so art lands on whole pixels at any integer zoom and at
 * overview zooms below 1. */

import type { Camera } from "./camera";
import type { DrawTarget, SpriteImage } from "./renderTypes";

/** Screen x of world x, snapped. */
export function sx(cam: Camera, wx: number): number {
  return Math.round(cam.ox) + Math.floor(Math.round(wx) * cam.zoom);
}

/** Screen y of world y, snapped. */
export function sy(cam: Camera, wy: number): number {
  return Math.round(cam.oy) + Math.floor(Math.round(wy) * cam.zoom);
}

/** A snapped span `[a, a + size)`'s screen length: edge to snapped edge, never below 1 px unless empty. */
function span(a: number, b: number, size: number): number {
  return size > 0 ? Math.max(1, b - a) : 0;
}

/** Both edges snap like positions, so below zoom 1 a rect is still whole pixels and neighbours
 * share edges exactly; anything non-empty keeps at least 1 px. */
export function rect(
  ctx: DrawTarget,
  cam: Camera,
  wx: number,
  wy: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  ctx.fillRect(x, y, span(x, sx(cam, wx + w), w), span(y, sy(cam, wy + h), h));
}

/** Draw the `sw×sh` source rect at world (wx, wy), optionally mirrored horizontally. */
export function blit(
  ctx: DrawTarget,
  cam: Camera,
  img: SpriteImage,
  srcX: number,
  srcY: number,
  sw: number,
  sh: number,
  wx: number,
  wy: number,
  flip = false,
): void {
  const dw = sw * cam.zoom;
  const dh = sh * cam.zoom;
  if (!flip) {
    ctx.drawImage(img, srcX, srcY, sw, sh, sx(cam, wx), sy(cam, wy), dw, dh);
    return;
  }
  ctx.save();
  ctx.translate(sx(cam, wx) + dw, sy(cam, wy));
  ctx.scale(-1, 1);
  ctx.drawImage(img, srcX, srcY, sw, sh, 0, 0, dw, dh);
  ctx.restore();
}

/** A small deterministic integer hash (procedural detail must not shimmer frame to frame). */
export function hash(a: number, b: number, c: number): number {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^
    Math.imul(b | 0, 0x165667b1) ^
    Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** true when the world rect intersects the view (used to skip off-screen tiles). */
export function onScreen(
  cam: Camera,
  view: { w: number; h: number },
  wx: number,
  wy: number,
  w: number,
  h: number,
): boolean {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  return (
    x + w * cam.zoom > 0 && y + h * cam.zoom > 0 && x < view.w && y < view.h
  );
}
