/**
 * Agent Village — the cached ground layer.
 *
 * The ground (grass, paths, plaza, indoor floors, wall bases) never changes for a
 * given World, yet painting it tile by tile costs thousands of `fillRect`s and
 * `fillStyle` parses per frame. So it is painted ONCE, at zoom 1 in world pixels,
 * into an offscreen canvas, and each frame blits it with a single `drawImage` (an
 * integer zoom with smoothing off is pixel-identical to painting it scaled).
 * Water is the one animated ground tile: it is left out here and still painted per
 * frame on top (its first fill covers the whole tile).
 */

import { TILE, type DrawItem } from "../villageTypes";
import type { Camera } from "./camera";
import type { DrawTarget, SpriteBank, SpriteImage } from "./renderTypes";
import { drawTile } from "./tiles";

/** A pre-painted ground image and its size in world px. */
export interface GroundLayer {
  image: SpriteImage;
  w: number;
  h: number;
}

/** A blank `w×h` canvas and its 2D context, or null where the host has none (jsdom). */
export type MakeLayer = (
  w: number,
  h: number,
) => { image: SpriteImage; ctx: DrawTarget } | null;

/** An `OffscreenCanvas` where available, else a detached DOM canvas. */
export function defaultMakeLayer(
  w: number,
  h: number,
): { image: SpriteImage; ctx: DrawTarget } | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), {
          width: w,
          height: h,
        });
  const ctx = canvas.getContext("2d") as unknown as DrawTarget | null;
  return ctx ? { image: canvas, ctx } : null;
}

const UNIT: Camera = { zoom: 1, ox: 0, oy: 0 };

/** Ground tiles the layer holds: every `tile` item except the animated water. */
export function isCachedGround(item: DrawItem): boolean {
  return item.t === "tile" && item.kind !== "water";
}

/**
 * Paint every cached ground tile of `items` into a fresh `cols×rows`-tile layer.
 * `bank` is the art bank (null = flat fallback fills), exactly as the frame would
 * use it. Null when the host cannot make a canvas — the frame then paints tiles.
 */
export function paintGround(
  make: MakeLayer,
  items: readonly DrawItem[],
  cols: number,
  rows: number,
  bank: SpriteBank | null,
): GroundLayer | null {
  const w = Math.max(1, cols * TILE);
  const h = Math.max(1, rows * TILE);
  const layer = make(w, h);
  if (!layer) return null;
  layer.ctx.imageSmoothingEnabled = false;
  for (const item of items)
    if (item.t === "tile" && isCachedGround(item))
      drawTile(layer.ctx, UNIT, item, bank, 0);
  return { image: layer.image, w, h };
}
