/**
 * Agent Village — the City's Seats LOUNGE under the street (64 seats in
 * an area below ground, where idle agents wait to be called; busy agents move to the building
 * that needs them). Our own procedural pixel art, anchored like every prop:
 * (x0, bottom) = a footprint's left and bottom edges, world px.
 *
 *   - `drawBench` — one lounge seat (`bench` prop), seen from the front: four seats in a row read
 *     as ONE bench (a backrest and a seat running through, an armrest and legs at its two ends, a
 *     leg pair under its middle). On a free seat an anonymous agent sits facing us, waiting to be
 *     called (the engine's `waiter` reading: its look and pose); asleep at night, with a "z".
 *   - `drawLounge` — the hall itself (`lounge` DrawItem), painted right after its back wall's pieces
 *     and before its benches: a tiled frieze along the back wall's face, warm pendant lamps hanging
 *     from it, a panelled wainscot behind each bench row, a potted plant at each row's ends. Calm on
 *     purpose: the waiting agents are the subject. It keeps clear of the lift's column and the aisle
 *     either side of it (the shaft and its car are render/lift.ts's).
 *
 * The waiters are a picture of FREE SEATS, not of processes (decoration, and said so): the Seats
 * card says so.
 * Deterministic: everything here is a function of its inputs and the clock passed in.
 */

import { SIT_OFFSET } from "../engine/sim";
import { SEAT_LIFT, TILE, type Ambience, type DrawItem, type PropReading } from "../villageTypes";
import type { Camera } from "./camera";
import { blit, rect } from "./paint";
import type { DrawTarget, SpriteBank } from "./renderTypes";
import { CHAR_SHEET } from "./sprites";

/** Bench colours. Exported for the tests (they read the slats back). */
export const BENCH = {
  wood: "#b07a45",
  woodLight: "#d39d61",
  woodDark: "#7a4f2a",
  metal: "#3b3f4a",
  shadow: "rgba(0, 0, 0, 0.22)",
} as const;

/** The hall's colours. Exported for the tests. */
export const LOUNGE = {
  /** The wainscot behind each bench row (dark station-green tiles), its brass rail, and the frieze under the ceiling. */
  panel: "#2f5a57",
  rail: "#c8a050",
  frieze: "#3b6b66",
  friezeEdge: "#b8924a",
  /** A pendant lamp: its cord and shade, the lit bulb, and the warm pool it throws on the wall. */
  cord: "#2c2f36",
  shade: "#4a3a28",
  bulb: "#ffe3a3",
  glow: "rgba(255, 196, 110, 0.16)",
  /** A potted plant. */
  pot: "#b5643a",
  potRim: "#d9844f",
  leaf: "#3f8a35",
  leafLight: "#62b450",
} as const;

/** A sleeping waiter's "z". */
export const SNORE = "#eef3ff";

/** Seats on one bench (engine/city.ts `BENCH`): a seat's place on its bench is its number mod this. */
export const BENCH_SEATS = 4;

/**
 * World px from a sitter's frame top down to its seat tile's bottom — where a sim character seated
 * on the bench is drawn too (characters.ts: feet at the tile's bottom + SIT_OFFSET, the sheet's feet
 * on its row 31, the sprite raised SEAT_LIFT).
 */
export const SITTER_TOP = 31 + SEAT_LIFT - SIT_OFFSET;

/** Character-sheet column of each pose, facing us (row 0): seated still, the other hand, a paper. */
export const POSE_COL = { still: 3, shift: 4, read: 5 } as const;

/** Columns from the lift kept clear of the dressing: the shaft and the aisle either side of it. */
const LIFT_CLEAR = 1;

/**
 * One lounge seat at (x0, bottom): seat `index`'s part of its bench of four (its place, `index %
 * BENCH_SEATS`, picks the ends), then — when the engine seats a waiter on it — the waiter. Paints
 * inside its own tile and, for a waiter, the tile above it (its head, and a "z" at night).
 */
export function drawBench(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  index: number,
  reading: PropReading | undefined,
  bank: SpriteBank | null,
  timeMs: number,
  ambience?: Ambience,
): void {
  const b = bottom;
  const place = index % BENCH_SEATS;
  const left = place === 0;
  const right = place === BENCH_SEATS - 1;
  // The run of the bench through this seat: an end seat stops a px short of its outer edge.
  const x = x0 + (left ? 1 : 0);
  const w = TILE - (left ? 1 : 0) - (right ? 1 : 0);
  rect(ctx, cam, x, b - 2, w, 2, BENCH.shadow);
  // Backrest: two slats, lit along their tops.
  for (const y of [b - 15, b - 12]) {
    rect(ctx, cam, x, y, w, 2, BENCH.wood);
    rect(ctx, cam, x, y, w, 1, BENCH.woodLight);
  }
  // Seat: its lit top, its body, its dark front edge.
  rect(ctx, cam, x, b - 9, w, 1, BENCH.woodLight);
  rect(ctx, cam, x, b - 8, w, 2, BENCH.wood);
  rect(ctx, cam, x, b - 6, w, 1, BENCH.woodDark);
  // Legs: under each end, and a pair straddling the middle (the 2nd seat's right edge, the 3rd's left).
  if (left) rect(ctx, cam, x0 + 2, b - 5, 2, 4, BENCH.metal);
  if (right) rect(ctx, cam, x0 + 12, b - 5, 2, 4, BENCH.metal);
  if (place === 1) rect(ctx, cam, x0 + 15, b - 5, 1, 4, BENCH.metal);
  if (place === 2) rect(ctx, cam, x0, b - 5, 1, 4, BENCH.metal);
  // Armrests at the ends: a post up from the seat and a short arm over it.
  if (left) {
    rect(ctx, cam, x0 + 1, b - 12, 1, 6, BENCH.metal);
    rect(ctx, cam, x0 + 1, b - 12, 4, 1, BENCH.metal);
  }
  if (right) {
    rect(ctx, cam, x0 + 14, b - 12, 1, 6, BENCH.metal);
    rect(ctx, cam, x0 + 11, b - 12, 4, 1, BENCH.metal);
  }
  if (reading?.kind === "waiter") drawWaiter(ctx, cam, x0, b, reading, bank, timeMs, ambience?.phase === "night");
}

/** The waiter on a seat: its sheet's seated pose facing us (asleep: still, and a "z" rising and falling). */
function drawWaiter(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  w: Extract<PropReading, { kind: "waiter" }>,
  bank: SpriteBank | null,
  timeMs: number,
  asleep: boolean,
): void {
  const top = bottom - SITTER_TOP;
  const sheet = bank?.character(w.palette, w.hueShift) ?? null;
  const col = asleep ? POSE_COL.still : POSE_COL[w.pose];
  if (sheet) blit(ctx, cam, sheet, col * CHAR_SHEET.frameW, 0, CHAR_SHEET.frameW, CHAR_SHEET.frameH, x0, top);
  else {
    // No art: a body and a head block, the body in its sheet's colour.
    rect(ctx, cam, x0 + 4, bottom - 16, 8, 10, FALLBACK_BODY[w.palette % FALLBACK_BODY.length]);
    rect(ctx, cam, x0 + 5, bottom - 23, 6, 7, "#f1c9a5");
  }
  if (!asleep) return;
  // A small "z" up and to the right of the head, bobbing a px every 0.7 s — inside the tile above.
  const zy = top + 3 - (Math.floor(timeMs / 700) % 2);
  rect(ctx, cam, x0 + 11, zy, 3, 1, SNORE);
  rect(ctx, cam, x0 + 12, zy + 1, 1, 1, SNORE);
  rect(ctx, cam, x0 + 11, zy + 2, 3, 1, SNORE);
}

/** A waiter's body without art, by sheet (characters.ts's fallback colours). */
const FALLBACK_BODY = ["#d9534f", "#3d6fc4", "#5cb85c", "#f0ad4e", "#9b59b6", "#1abc9c"];

/**
 * The hall, painted on its back surface (under its benches, its waiters and the lift's riders):
 * a frieze and pendant lamps under the ceiling, a wainscot and a plant at each end of every bench
 * row — none of it in the lift's column or the aisle either side of it.
 */
export function drawLounge(ctx: DrawTarget, cam: Camera, item: Extract<DrawItem, { t: "lounge" }>): void {
  const x0 = item.col * TILE;
  const x1 = (item.col + item.w) * TILE;
  // The two halves either side of the lift (world px), each painted on its own.
  const halves: [number, number][] = [
    [x0, (item.lift - LIFT_CLEAR) * TILE],
    [(item.lift + LIFT_CLEAR + 1) * TILE, x1],
  ];
  const wall = item.row * TILE;
  for (const [a, b] of halves) {
    // The frieze: a band of dark tiles between brass lines, along the back wall's face.
    rect(ctx, cam, a, wall + FRIEZE, b - a, 1, LOUNGE.friezeEdge);
    rect(ctx, cam, a, wall + FRIEZE + 1, b - a, 2, LOUNGE.frieze);
    rect(ctx, cam, a, wall + FRIEZE + 3, b - a, 1, LOUNGE.friezeEdge);
    for (let k = 0; k < item.benchRows; k++) {
      const top = (item.row + 2 + 2 * k) * TILE;
      // The wainscot behind the bench row, its rail lit.
      rect(ctx, cam, a, top + 5, b - a, 11, LOUNGE.panel);
      rect(ctx, cam, a, top + 5, b - a, 1, LOUNGE.rail);
    }
  }
  // Pendant lamps in the gaps between the benches and at the hall's ends (never over a sitter's head).
  for (const c of lampCols(item)) lamp(ctx, cam, c * TILE, wall);
  // A plant at both ends of every bench row.
  for (let k = 0; k < item.benchRows; k++) {
    const bottom = (item.row + 3 + 2 * k) * TILE;
    plant(ctx, cam, x0, bottom);
    plant(ctx, cam, x1 - TILE, bottom);
  }
}

/**
 * The columns the pendant lamps hang in: the hall's two end columns and the gaps between each side's
 * two benches (6 from the lift: engine/city.ts's margin, bench, gap, bench, aisle) — over no
 * sitter's head, and never in the lift's way.
 */
export function lampCols(item: Extract<DrawItem, { t: "lounge" }>): number[] {
  return [item.col, item.lift - 6, item.lift + 6, item.col + item.w - 1];
}

/**
 * A pendant lamp in the tile column at x0, hung from the frieze on the back wall (row top `wall`)
 * down into the headroom row: its cord, a brass-rimmed shade, the lit bulb under it and the warm
 * pool it throws on the tiles below.
 */
function lamp(ctx: DrawTarget, cam: Camera, x0: number, wall: number): void {
  const shade = wall + TILE + 1;
  rect(ctx, cam, x0 + 1, shade + 2, 14, 10, LOUNGE.glow);
  rect(ctx, cam, x0 + 3, shade + 1, 10, 14, LOUNGE.glow);
  rect(ctx, cam, x0 + 7, wall + FRIEZE + 4, 2, shade - wall - FRIEZE - 4, LOUNGE.cord);
  rect(ctx, cam, x0 + 4, shade, 8, 3, LOUNGE.shade);
  rect(ctx, cam, x0 + 4, shade + 2, 8, 1, LOUNGE.friezeEdge);
  rect(ctx, cam, x0 + 6, shade + 3, 4, 2, LOUNGE.bulb);
}

/** World px from the back wall's top down to its frieze: the band sits low on the wall's face. */
export const FRIEZE = 9;

/** A potted plant standing on the floor at (x0, bottom): a terracotta pot, a tuft of leaves. */
function plant(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  rect(ctx, cam, x0 + 4, bottom - 6, 8, 5, LOUNGE.pot);
  rect(ctx, cam, x0 + 3, bottom - 7, 10, 2, LOUNGE.potRim);
  rect(ctx, cam, x0 + 5, bottom - 13, 6, 6, LOUNGE.leaf);
  rect(ctx, cam, x0 + 3, bottom - 11, 3, 3, LOUNGE.leaf);
  rect(ctx, cam, x0 + 10, bottom - 11, 3, 3, LOUNGE.leaf);
  rect(ctx, cam, x0 + 7, bottom - 15, 2, 3, LOUNGE.leafLight);
  rect(ctx, cam, x0 + 6, bottom - 11, 2, 2, LOUNGE.leafLight);
}
