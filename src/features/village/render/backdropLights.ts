/**
 * Agent Village — where a backdrop layer's LIGHT may land (render/backdrop.ts `fillLit`).
 *
 * A layer's lights are painted after the outdoor grade, over everything already in the frame, so a
 * light must leave out whatever stands in front of its layer — or a lit shop front would shine
 * through the passer-by walking past it, and a tower's lit floor through the haze in front of its
 * foot. Three kinds of things stand in front, each cut its own way:
 *
 *   - BOXES: the street's trees and lamps (`skylineOccluders`) and this frame's street sprites —
 *     the agents on the street, the passers-by, the vehicles. A rect of light is split around each
 *     (≤ 4 pieces a box).
 *   - a FACE: the haze, and any nearer layer, in front of a HIGH layer — a world y per column below
 *     which nothing behind it shows. Each piece is cut column by column, a run of equal faces one rect.
 *   - SHAPES: the landmarks in front, only where a piece overlaps one's box (everywhere else a piece
 *     is one fill): Fuji and a tower a ROW at a time — their silhouette is one run of columns per row
 *     (`landmarkRow`), so a piece is split round it and rows cut alike merge back into one rect — and a
 *     temple, whose art has holes, a pixel at a time.
 *
 * COST — measured on a reference city at Fit (1280×800 @2x, Chromium, night, ~540 lights a frame):
 * 4.4 ms with the first cut of this file, nearly all of it here — every
 * column of every light walked the haze's chunk (`skylineFaceAt`), a light behind Tokyo Tower or the
 * Skytree went pixel by pixel over their feet' whole width, and every box split every piece. Now the
 * face is looked up once per column a frame (the cutter is built per frame), the towers are cut by row,
 * and a box that misses the light is never split against.
 *
 * Whole world pixels, edges snapped like `rect` (render/paint.ts), in the CURRENT `fillStyle` and
 * `globalAlpha`: the layer sets them once per batch.
 */

import type { Camera } from "./camera";
import { sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** A world-px rect [x, y, w, h]. */
export type Box = readonly [x: number, y: number, w: number, h: number];

/** A landmark in front: its world box, and whether it covers a world pixel. */
export interface Shape {
  box: Box;
  hit: (x: number, y: number) => boolean;
  /** The columns [x0, x1) it covers on a world row (null: none) — given for a shape that is one run per row, never for one with holes. */
  row?: (y: number) => readonly [number, number] | null;
}

/** What stands in front of one layer. */
export interface InFront {
  boxes: readonly Box[];
  /** World y below which nothing behind shows, per world x; null when nothing of the kind is in front. */
  face: ((x: number) => number) | null;
  shapes: readonly Shape[];
}

/** Fill a world-px rect in the current fillStyle, edges snapped like `rect`. */
function fillWorld(ctx: DrawTarget, cam: Camera, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  ctx.fillRect(x, y, Math.max(1, sx(cam, wx + w) - x), Math.max(1, sy(cam, wy + h) - y));
}

const overlaps = (a: Box, b: Box): boolean => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** `r` less `box`: what of it is left, as ≤ 4 rects (above, below, then left and right of the box's rows). */
export function subtract(r: Box, box: Box): Box[] {
  if (!overlaps(r, box)) return [r];
  const [x, y, w, h] = r;
  const top = Math.max(y, box[1]);
  const bottom = Math.min(y + h, box[1] + box[3]);
  const out: Box[] = [];
  if (top > y) out.push([x, y, w, top - y]);
  if (bottom < y + h) out.push([x, bottom, w, y + h - bottom]);
  if (box[0] > x) out.push([x, top, box[0] - x, bottom - top]);
  if (box[0] + box[2] < x + w) out.push([box[0] + box[2], top, x + w - box[0] - box[2], bottom - top]);
  return out;
}

/** What is left of the columns [a, b) of one row once [c0, c1) is taken out: ≤ 2 runs, as flat [x0, x1, …]. */
function rowLeft(a: number, b: number, cover: readonly [number, number] | null): number[] {
  if (!cover || cover[1] <= a || cover[0] >= b) return [a, b];
  const out: number[] = [];
  if (cover[0] > a) out.push(a, cover[0]);
  if (cover[1] < b) out.push(cover[1], b);
  return out;
}

/** `r` less a shape that is one run per row: row by row, rows left alike merged into one rect per run. */
function cutRows(r: Box, row: (y: number) => readonly [number, number] | null, out: Box[]): void {
  const [x, y, w, h] = r;
  let start = y;
  let runs = rowLeft(x, x + w, row(y));
  for (let j = y + 1; j <= y + h; j++) {
    const next = j < y + h ? rowLeft(x, x + w, row(j)) : null;
    if (next && next.length === runs.length && next.every((v, k) => v === runs[k])) continue;
    for (let k = 0; k < runs.length; k += 2) out.push([runs[k], start, runs[k + 1] - runs[k], j - start]);
    start = j;
    runs = next as number[];
  }
}

/** `r` cut at the face: per column, the part above it — a run of columns with the same cut one rect. */
function underFace(r: Box, face: (x: number) => number, out: Box[]): void {
  const [x, y, w, h] = r;
  let run = x;
  let bottom = Math.min(y + h, face(x));
  for (let c = x + 1; c <= x + w; c++) {
    const b = c < x + w ? Math.min(y + h, face(c)) : NaN;
    if (b === bottom) continue;
    if (bottom > y) out.push([run, y, c - run, bottom - y]);
    run = c;
    bottom = b;
  }
}

/**
 * The `fillLit` and `hidden` of a layer with `front` in front of it (render/backdrop.ts
 * `BackdropLightScene`).
 */
export function lightCutter(
  ctx: DrawTarget,
  cam: Camera,
  front: InFront,
): { fillLit: (x: number, y: number, w: number, h: number) => void; hidden: (x: number, y: number) => boolean } {
  const { boxes, shapes } = front;
  // The face, once per column this frame: a layer's lights stand in columns (a tower's floors, its windows).
  const faces = new Map<number, number>();
  const face =
    front.face &&
    ((c: number): number => {
      let y = faces.get(c);
      if (y === undefined) faces.set(c, (y = (front.face as (x: number) => number)(c)));
      return y;
    });
  return {
    fillLit(x, y, w, h) {
      const light: Box = [x, y, w, h];
      let pieces: Box[] = [light];
      for (const box of boxes) if (overlaps(light, box)) pieces = pieces.flatMap((p) => subtract(p, box));
      if (face) {
        const cut: Box[] = [];
        for (const p of pieces) underFace(p, face, cut);
        pieces = cut;
      }
      for (const s of shapes) {
        if (!s.row) continue;
        const cut: Box[] = [];
        for (const p of pieces) if (overlaps(p, s.box)) cutRows(p, s.row, cut);
        else cut.push(p);
        pieces = cut;
      }
      for (const p of pieces) {
        const near = shapes.filter((s) => !s.row && overlaps(p, s.box));
        if (near.length === 0) {
          fillWorld(ctx, cam, ...p);
          continue;
        }
        // Pixel by pixel where a landmark may cover it: a run of uncovered pixels per row is one rect.
        for (let row = p[1]; row < p[1] + p[3]; row++)
          for (let c = p[0]; c < p[0] + p[2]; ) {
            if (near.some((s) => s.hit(c, row))) {
              c++;
              continue;
            }
            const c0 = c;
            while (c < p[0] + p[2] && !near.some((s) => s.hit(c, row))) c++;
            fillWorld(ctx, cam, c0, row, c - c0, 1);
          }
      }
    },
    hidden(x, y) {
      return (
        boxes.some((b) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]) ||
        (face !== null && y >= face(x)) ||
        shapes.some((s) => {
          const cover = s.row?.(y);
          return cover === undefined ? s.hit(x, y) : cover !== null && x >= cover[0] && x < cover[1];
        })
      );
    },
  };
}
