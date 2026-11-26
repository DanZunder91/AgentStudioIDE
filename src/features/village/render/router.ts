/** A project room's Wi-Fi router: team PCs are cabled to it, the boss talks over the air
 * (engine/teamLan.ts; pulses: `drawWifi` in render/lan.ts). (x0, bottom) = the footprint's left
 * and bottom edges, world px. Hung at the tile's top so it reads wall-mounted in both views. */

import type { Camera } from "./camera";
import { rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Router colours. Exported for the tests (they read the LEDs back). */
export const ROUTER = {
  outline: "#3a4252",
  /** The white top of the box. */
  top: "#eef1f5",
  /** Its light grey front face. */
  face: "#c3cad5",
  /** The dark window the LEDs shine through. */
  window: "#232935",
  antenna: "#1f242e",
  /** An antenna's tip: a light cap, so a tip reads against a dark wall too. */
  tip: "#8f9aae",
  /** The power LED: lit whenever the router is drawn (it is powered, traffic or not). */
  power: "#5fb4ff",
  /** An activity LED with a link: steady green. */
  ledOn: "#46e38a",
  /** An activity LED flashing with traffic this frame. */
  ledBlink: "#d9ffe9",
  /** No traffic: every activity LED dim. */
  ledOff: "#3a4a42",
  shadow: "rgba(0, 0, 0, 0.25)",
} as const;

/** Activity LEDs (Wi-Fi, then the LAN), right of the power LED. */
export const ROUTER_LEDS = 3;
/** Its animation frames: the prop frame cycles 0..2. */
const ROUTER_FRAMES = 3;
/** How far the antennas rise above the tile's top edge, world px. */
export const ROUTER_RISE = 4;

/** `on` lights the activity LEDs, one flashing per `frame` (taken mod 3); off they are dim and
 * frame-independent. The power LED is always lit. Paints within
 * `[x0 + 1, x0 + 15) × [bottom − 16 − ROUTER_RISE, bottom − 6)`. */
export function drawRouter(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, on: boolean, frame: number): void {
  const f = ((Math.trunc(frame) % ROUTER_FRAMES) + ROUTER_FRAMES) % ROUTER_FRAMES;
  const top = bottom - 16;
  // Antennas: a lower stub straight up out of the box's corners, the upper part leaning out, a light tip.
  for (const [stub, lean] of [
    [x0 + 3, x0 + 2],
    [x0 + 12, x0 + 13],
  ]) {
    rect(ctx, cam, stub, top - 1, 1, 2, ROUTER.antenna);
    rect(ctx, cam, lean, top - ROUTER_RISE, 1, 3, ROUTER.antenna);
    rect(ctx, cam, lean, top - ROUTER_RISE, 1, 1, ROUTER.tip);
  }
  rect(ctx, cam, x0 + 2, top + 9, 12, 1, ROUTER.shadow);
  rect(ctx, cam, x0 + 1, top + 1, 14, 8, ROUTER.outline);
  rect(ctx, cam, x0 + 2, top + 2, 12, 3, ROUTER.top);
  rect(ctx, cam, x0 + 2, top + 5, 12, 3, ROUTER.face);
  rect(ctx, cam, x0 + 3, top + 6, 10, 1, ROUTER.window);
  rect(ctx, cam, x0 + 4, top + 6, 1, 1, ROUTER.power);
  for (let i = 0; i < ROUTER_LEDS; i++) {
    let led: string = ROUTER.ledOff;
    if (on) led = (i + f) % ROUTER_FRAMES === 0 ? ROUTER.ledBlink : ROUTER.ledOn;
    rect(ctx, cam, x0 + 6 + 2 * i, top + 6, 1, 1, led);
  }
}
