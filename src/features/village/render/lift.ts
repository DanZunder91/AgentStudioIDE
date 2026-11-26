/** The City's lifts: `drawShaft` (drawn after the scene, OVER the walls and slabs it crosses),
 * `drawCar` (back before the rider, frame after), `drawKiosk` and `kioskGlow` (night-lights pass).
 * A handful of fills each; nothing is allocated per frame. */

import { TILE, type DrawItem } from "../villageTypes";
import type { Camera } from "./camera";
import { rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Shaft colours. Exported for the tests (they read the pieces back). */
export const SHAFT = {
  /** The shaft's back: dark steel. */
  back: "#262c35",
  /** Its edges, a shade darker, so it reads against any wall. */
  edge: "#171b21",
  rail: "#6c7a8a",
  tie: "#323a45",
  /** A landing door's frame and its two closed leaves. */
  frame: "#8792a1",
  leaf: "#b8c1cc",
  seam: "#5b6573",
  /** The call lamp over each landing door. */
  lamp: "#ffc85a",
} as const;

/** World px of a landing door's height, from its stop row's floor line up. */
export const DOOR_H = 26;

/** A shaft over rows `top..bottom` of column `col`, a landing door on each stop's floor line;
 * paints within x0 + 1 to x0 + 15 and its rows. */
export function drawShaft(ctx: DrawTarget, cam: Camera, item: Extract<DrawItem, { t: "shaft" }>): void {
  const x0 = item.col * TILE;
  const y0 = item.top * TILE;
  const h = (item.bottom - item.top + 1) * TILE;
  rect(ctx, cam, x0 + 1, y0, 14, h, SHAFT.edge);
  rect(ctx, cam, x0 + 2, y0, 12, h, SHAFT.back);
  for (let r = item.top; r <= item.bottom; r++) rect(ctx, cam, x0 + 3, r * TILE + 7, 10, 1, SHAFT.tie);
  rect(ctx, cam, x0 + 3, y0, 1, h, SHAFT.rail);
  rect(ctx, cam, x0 + 12, y0, 1, h, SHAFT.rail);
  for (const stop of item.stops) {
    const floor = (stop + 1) * TILE;
    rect(ctx, cam, x0 + 2, floor - DOOR_H, 12, DOOR_H, SHAFT.frame);
    rect(ctx, cam, x0 + 3, floor - DOOR_H + 2, 10, DOOR_H - 2, SHAFT.leaf);
    rect(ctx, cam, x0 + 7, floor - DOOR_H + 2, 2, DOOR_H - 2, SHAFT.seam);
    rect(ctx, cam, x0 + 7, floor - DOOR_H - 2, 2, 1, SHAFT.lamp);
  }
}

/** Car colours. Exported for the tests. */
export const CAR = {
  /** The cab's back wall: warm, lit from inside. */
  wall: "#efe2c4",
  /** Its ceiling light. */
  light: "#fff7df",
  /** Lintel, sill and side posts. */
  frame: "#475262",
} as const;

/** The car's size round a rider's feet, world px: 14 wide, 31 tall (a standing sprite's height). */
export const CAR_W = 14;
export const CAR_H = 31;

/** One part of a car round the rider whose feet are at (x, y): `back` (wall, ceiling light) goes
 * behind the rider, `front` (lintel, sill, posts) in front of it. */
export function drawCar(ctx: DrawTarget, cam: Camera, item: Extract<DrawItem, { t: "car" }>): void {
  const x = Math.round(item.x) - CAR_W / 2;
  const top = Math.round(item.y) - CAR_H;
  if (item.part === "back") {
    rect(ctx, cam, x + 1, top + 2, CAR_W - 2, CAR_H - 4, CAR.wall);
    rect(ctx, cam, x + 3, top + 2, CAR_W - 6, 1, CAR.light);
    return;
  }
  rect(ctx, cam, x, top, CAR_W, 2, CAR.frame);
  rect(ctx, cam, x, top + CAR_H - 2, CAR_W, 2, CAR.frame);
  rect(ctx, cam, x, top + 2, 1, CAR_H - 4, CAR.frame);
  rect(ctx, cam, x + CAR_W - 1, top + 2, 1, CAR_H - 4, CAR.frame);
}

/** Kiosk colours. Exported for the tests. */
export const KIOSK = {
  plinth: "#3b434d",
  post: "#55606d",
  canopy: "#2a6f9a",
  canopyEdge: "#1d5274",
  /** The glass by day, and lit from inside at night. */
  glass: "rgba(176, 214, 232, 0.5)",
  glassLit: "rgba(255, 236, 184, 0.62)",
  seam: "#7aa3b8",
  /** The up/down sign on the canopy: white by day, warm at night. */
  sign: "#e8f1f7",
  signLit: "#fff1b8",
  /** Its light on the street at night. */
  glow: "rgba(255, 228, 160, 0.14)",
} as const;

/** How far the kiosk's art rises above its 1-tile footprint's top, world px: one tile (the frame's prop cull reaches that far). */
export const KIOSK_RISE = TILE;

/** The kiosk at (x0, bottom); `lit` (night lights on) lights its glass and sign. */
export function drawKiosk(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, lit: boolean): void {
  const top = bottom - TILE - KIOSK_RISE;
  rect(ctx, cam, x0 + 3, top + 5, 10, bottom - top - 7, lit ? KIOSK.glassLit : KIOSK.glass);
  rect(ctx, cam, x0 + 8, top + 6, 1, bottom - top - 8, KIOSK.seam);
  rect(ctx, cam, x0 + 1, top + 5, 2, bottom - top - 7, KIOSK.post);
  rect(ctx, cam, x0 + 13, top + 5, 2, bottom - top - 7, KIOSK.post);
  rect(ctx, cam, x0, bottom - 2, TILE, 2, KIOSK.plinth);
  rect(ctx, cam, x0, top, TILE, 5, KIOSK.canopy);
  rect(ctx, cam, x0, top + 4, TILE, 1, KIOSK.canopyEdge);
  const sign = lit ? KIOSK.signLit : KIOSK.sign;
  // ▲ and ▼, three px wide each, side by side on the canopy.
  rect(ctx, cam, x0 + 5, top + 1, 1, 1, sign);
  rect(ctx, cam, x0 + 4, top + 2, 3, 1, sign);
  rect(ctx, cam, x0 + 9, top + 1, 3, 1, sign);
  rect(ctx, cam, x0 + 10, top + 2, 1, 1, sign);
}

/** The kiosk's light on the street at night: a soft pool round the booth and on the sidewalk. */
export function kioskGlow(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  rect(ctx, cam, x0 - 6, bottom - 26, TILE + 12, 22, KIOSK.glow);
  rect(ctx, cam, x0 - 3, bottom - 32, TILE + 6, 32, KIOSK.glow);
  rect(ctx, cam, x0 - 8, bottom - 3, TILE + 16, 5, KIOSK.glow);
}

/** A shaft's own light at night: a soft cool glow over its column, a px either side (the lights pass clips it to the facade). */
export const SHAFT_GLOW = "rgba(200, 225, 255, 0.16)";

/** Where a shaft's light shows at night: its column and rows, a px wider either side. */
export function shaftGlowBox(item: Extract<DrawItem, { t: "shaft" }>): [number, number, number, number] {
  return [item.col * TILE - 1, item.top * TILE, TILE + 2, (item.bottom - item.top + 1) * TILE];
}

/** A shaft's night glow over the stretches the grade darkens (slabs, the soil over the lounge), so
 * the lift reads as one lit column, not a ladder of lit rooms. */
export function shaftGlow(ctx: DrawTarget, cam: Camera, item: Extract<DrawItem, { t: "shaft" }>): void {
  rect(ctx, cam, ...shaftGlowBox(item), SHAFT_GLOW);
}

/** World box [x, y, w, h] holding everything `kioskGlow` paints — for an `onScreen` cull. */
export function kioskGlowBox(x0: number, bottom: number): [number, number, number, number] {
  return [x0 - 8, bottom - 32, TILE + 16, 34];
}
