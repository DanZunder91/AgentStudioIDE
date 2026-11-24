/**
 * Agent Village — a passer-by's UMBRELLA (when it rains some people carry
 * an umbrella and some do not; on a sunny day nobody does). Our own pixel art, drawn round a
 * walker's sprite (render/streetLife.ts) in two parts at two depths:
 *
 *   - `drawShaft` BEFORE the sprite: the stick, from the hand up to the canopy, behind the body — so only
 *     its stretch between the head and the canopy shows (held in the far hand);
 *   - `drawCanopy` AFTER it: a dome of cloth over the head, its rim scalloped by the rib tips, a shine on
 *     its upper left and a ferrule on top — leaning into the wind (the rain slants with it,
 *     engine/weatherFx.ts), a pixel at |wind| ≥ ¼ and two at ≥ ¾. 19 px across: a head and a half.
 *
 * `open` (0..1) narrows the dome as it opens or closes; 0 draws nothing. Six canopies: red, navy, yellow,
 * green, black, and the clear convenience-store umbrella of a rainy Tokyo street (its cloth translucent).
 *
 *            ▪               ferrule   y − 36
 *          ▓▓▓▓▓             top       y − 35   (half-width 2)
 *       ▓▒▒▓▓▓▓▓▓▓▓          shine     y − 34   (5)
 *     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                  y − 33   (7)
 *    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                 y − 32   (8)
 *   ╹▓▓▓▓╹▓▓▓▓▓▓▓▓╹▓▓▓▓╹  rim          y − 31   (9), ribs at its ends and halfway
 *            │               shaft     y − 30 .. y − 12 (hand), behind the body
 *
 * (x, y) is the holder's feet (bottom-centre), world px; the art sits over a 32-px character, whose head
 * top is 27–29 px above its feet.
 */

import type { Camera } from "./camera";
import { rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** A canopy's colours; `clear` = translucent cloth (`CLEAR_ALPHA`). */
export interface Canopy {
  cloth: string;
  rib: string;
  shine: string;
  clear?: boolean;
}

/** The six canopies (engine/streetLife.ts `CANOPIES` = this many), by `WalkerItem.canopy`. */
export const CANOPIES: readonly Canopy[] = [
  { cloth: "#d23f3a", rib: "#8f2522", shine: "#ee7a72" },
  { cloth: "#2b4a8c", rib: "#18295a", shine: "#5577c0" },
  { cloth: "#e2b42a", rib: "#9c7814", shine: "#f5d671" },
  { cloth: "#3f8a4e", rib: "#245a31", shine: "#72b880" },
  { cloth: "#2a2a30", rib: "#101014", shine: "#55555f" },
  { cloth: "#e2eefa", rib: "#9fb2c4", shine: "#ffffff", clear: true },
];
/** The clear umbrella's cloth opacity. */
export const CLEAR_ALPHA = 0.55;
/** The stick and the ferrule. */
export const SHAFT = "#3b3b44";

/** World px above the feet: the ferrule, the dome's top row, its rim, and the hand on the stick. */
export const TIP = 36;
export const TOP = 35;
export const RIM = 31;
export const HAND = 12;
/** The open dome's half-widths, top row to rim. */
export const DOME: readonly number[] = [2, 5, 7, 8, 9];

/** The column the stick runs up: a pixel in front of the body's middle. */
function stickX(x: number, dir: 1 | -1): number {
  return Math.round(x) + dir;
}

/** Pixels the top of the dome leans by: into the wind (against the way the rain blows). */
export function lean(wind: number): number {
  return 0 - Math.round(wind * 2);
}

/** The stick, from the hand up to the canopy's rim — drawn before the holder, so the body hides most of it. */
export function drawShaft(ctx: DrawTarget, cam: Camera, x: number, y: number, dir: 1 | -1): void {
  const top = Math.round(y) - RIM + 1;
  rect(ctx, cam, stickX(x, dir), top, 1, Math.round(y) - HAND - top, SHAFT);
}

/** The canopy over the holder's head, `open` 0..1 (0: nothing), colours `CANOPIES[canopy]` (wrapped), leaning with `wind`. */
export function drawCanopy(ctx: DrawTarget, cam: Camera, x: number, y: number, dir: 1 | -1, open: number, canopy: number, wind: number): void {
  if (open <= 0) return;
  const c = CANOPIES[((canopy % CANOPIES.length) + CANOPIES.length) % CANOPIES.length];
  const cx = stickX(x, dir);
  const by = Math.round(y);
  const l = lean(wind);
  const o = Math.min(1, open);
  /** Row r's half-width at this opening, and how far it leans (the top row all of it, the next half). */
  const half = (r: number) => Math.max(1, Math.round(DOME[r] * o));
  const shift = (r: number) => (r === 0 ? l : r === 1 ? Math.round(l / 2) : 0);
  const last = DOME.length - 1;
  if (c.clear) ctx.globalAlpha = CLEAR_ALPHA;
  for (let r = 0; r < DOME.length; r++) rect(ctx, cam, cx - half(r) + shift(r), by - TOP + r, 2 * half(r) + 1, 1, c.cloth);
  ctx.globalAlpha = 1;
  // The shine, high on the left of the second row; the ribs' tips along the rim; the ferrule on top.
  rect(ctx, cam, cx - half(1) + 1 + shift(1), by - TOP + 1, 2, 1, c.shine);
  const rim = half(last);
  const mid = Math.ceil(rim / 2);
  rect(ctx, cam, cx - rim, by - RIM, 1, 1, c.rib);
  rect(ctx, cam, cx - mid, by - RIM, 1, 1, c.rib);
  rect(ctx, cam, cx + mid, by - RIM, 1, 1, c.rib);
  rect(ctx, cam, cx + rim, by - RIM, 1, 1, c.rib);
  rect(ctx, cam, cx + shift(0), by - TIP, 1, 1, SHAFT);
}
