/**
 * Agent Village — the City's PASSERS-BY (engine/streetLife.ts; people walk
 * along the street too, some of them — not all — under an umbrella when it rains, and an agent goes
 * to buy something at the vending machine).
 *
 * A passer-by is a character sprite from the bank (its sheet and hue, the waiters' few), walking or
 * standing — with NO agent marker and no bubble: it is not an agent. Back to front, one walker is:
 *
 *   1. at a vending machine, what the purchase shows ON the machine (`drawVend`): the coin slot's glint as
 *      it pays, the pressed button blinking, the can landing in the tray and travelling to the hand;
 *   2. its umbrella's stick (render/umbrella.ts), behind the body;
 *   3. its shadow and sprite — on the subway stairs drawn `sink` px lower and CUT at the sidewalk's line,
 *      so it sinks out of sight going down and rises coming up (no shadow there);
 *   4. the can it bought, in its hand or raised to its mouth for a sip;
 *   5. its umbrella's canopy over its head.
 *
 * Lit like everything outdoors: the outdoor grade and the lights pass go over it (render/ambience.ts).
 */

import { VEND } from "../engine/streetLife";
import type { WalkerDrink, WalkerVend } from "../villageTypes";
import type { WalkerItem } from "../engine/streetLife";
import type { Camera } from "./camera";
import { characterFrame } from "./characters";
import { blit, rect } from "./paint";
import type { DrawTarget, SpriteBank } from "./renderTypes";
import { CHAR_SHEET } from "./sprites";
import { VENDING, vendingVariant } from "./tokyoProps";
import { drawCanopy, drawShaft, TIP } from "./umbrella";

const FW = CHAR_SHEET.frameW;
const FH = CHAR_SHEET.frameH;
/** The sprite row the feet stand on (render/characters.ts): a frame is drawn from `y − FEET`. */
const FEET = 31;
export const SHADOW = "rgba(0, 0, 0, 0.25)";
/** Without art: a plain body and head (render/characters.ts' fallback look, muted). */
export const FALLBACK = { body: ["#8a6f5a", "#5b6f8f", "#6f8a5b", "#8f7d5b", "#7a5b8f", "#5b8a85"], head: "#f1c9a5" } as const;

/** The can: its top (silver) over its colour, 2 px wide and 3 tall; where it is held and sipped, from the feet. */
export const CAN = { w: 2, h: 3, top: "#dfe4ea" } as const;
export const HOLD = { dx: 4, up: 12 } as const;
export const SIP = { dx: 5, up: 18 } as const;
/** On the machine (from its left edge / its bottom): the tray's can, the coin slot, the buttons (render/tokyoProps.ts). */
export const TRAY = { dx: 6, up: 6 } as const;
export const COIN = { dx: 11, up: 11 } as const;
export const BUTTON_X: readonly number[] = [3, 5, 7, 9, 11];
export const BUTTON_UP = 14;
/** Seconds a button blink lasts (on, then off); the coin slot glints over [PAY_GLINT[0], PAY_GLINT[1]). */
export const BLINK_SEC = 0.15;
export const PAY_GLINT: readonly [number, number] = [0.4, 0.6];
/** Seconds the can bounces in the tray as it lands. */
export const BOUNCE_SEC = 0.12;
export const FLASH = "#ffffff";
export const GLINT = "#ffe28a";

/** The drink's colour: the bottle in the machine's bottom row over the pressed button. */
export function drinkColor(d: Pick<WalkerDrink, "machine" | "button">): string {
  const b = VENDING.bottles;
  return b[(2 * BUTTON_X.length + d.button + 3 * vendingVariant(d.machine)) % b.length];
}

/** A can whose top-left is world (x, y). */
function can(ctx: DrawTarget, cam: Camera, x: number, y: number, color: string): void {
  rect(ctx, cam, x, y, CAN.w, CAN.h, color);
  rect(ctx, cam, x, y, CAN.w, 1, CAN.top);
}

/** Where the can is held (top-left, world px) by a walker whose feet are (x, y), facing `dir`, sipping or not. */
export function canSpot(x: number, y: number, dir: 1 | -1, sip: boolean): { x: number; y: number } {
  const at = sip ? SIP : HOLD;
  return { x: Math.round(x) + (dir > 0 ? at.dx : -at.dx - CAN.w + 1), y: Math.round(y) - at.up };
}

/**
 * A purchase, drawn on the machine: the coin slot's glint while paying; the pressed button blinking white;
 * the can in the tray (bouncing as it lands); the can travelling to the buyer's hand. Once the buyer
 * holds it, its can is the drink's (`drawWalker`).
 */
export function drawVend(ctx: DrawTarget, cam: Camera, v: WalkerVend, holder: { x: number; y: number; dir: 1 | -1 }): void {
  const b = v.bottom;
  if (v.t >= PAY_GLINT[0] && v.t < PAY_GLINT[1]) rect(ctx, cam, v.x0 + COIN.dx, b - COIN.up, 1, 2, GLINT);
  if (v.t >= VEND.flash && v.t < VEND.drop && Math.floor((v.t - VEND.flash) / BLINK_SEC) % 2 === 0)
    rect(ctx, cam, v.x0 + BUTTON_X[v.button] - 1, b - BUTTON_UP, 3, 1, FLASH);
  if (v.t < VEND.drop || v.t >= VEND.took) return;
  const color = drinkColor(v);
  const tray = { x: v.x0 + TRAY.dx, y: b - TRAY.up - (v.t - VEND.drop < BOUNCE_SEC ? 1 : 0) };
  if (v.t < VEND.take) return can(ctx, cam, tray.x, tray.y, color);
  // Taken: from the tray to the hand.
  const k = (v.t - VEND.take) / (VEND.took - VEND.take);
  const hand = canSpot(holder.x, holder.y, holder.dir, false);
  can(ctx, cam, Math.round(tray.x + (hand.x - tray.x) * k), Math.round(tray.y + (hand.y - tray.y) * k), color);
}

/** World box [x, y, w, h] holding everything `drawWalker` paints for `w` — for an `onScreen` cull. */
export function walkerBox(w: WalkerItem): [number, number, number, number] {
  // A buyer's purchase is drawn on its machine, which stands within 22 px of it.
  const reach = w.vend ? 30 : 12;
  return [w.x - reach, w.y - TIP - 1, 2 * reach, TIP + 3];
}

/** One passer-by (see the module doc for its layers); `wind` leans its umbrella. */
export function drawWalker(ctx: DrawTarget, cam: Camera, w: WalkerItem, bank: SpriteBank | null, wind: number): void {
  const dir: 1 | -1 = w.dir === "right" ? 1 : -1;
  const x = Math.round(w.x);
  const y = Math.round(w.y);
  const sink = Math.round(w.sink);
  if (w.vend) drawVend(ctx, cam, w.vend, { x, y, dir });
  const brolly = w.umbrella > 0;
  if (brolly) drawShaft(ctx, cam, x, y, dir);
  // The sprite: its rows above the cut line (all of them on the sidewalk).
  const rows = Math.min(FH, FEET + 1 - sink);
  if (rows > 0) {
    if (sink === 0) rect(ctx, cam, x - 5, y - 2, 10, 2, SHADOW);
    const top = y + sink - FEET;
    const sheet = bank?.character(w.palette, w.hueShift) ?? null;
    if (sheet) {
      const { col, row, flip } = characterFrame({ dir: w.dir, anim: w.anim, frame: w.frame });
      blit(ctx, cam, sheet, col * FW, row * FH, FW, rows, x - FW / 2, top, flip);
    } else {
      const body = FALLBACK.body[((w.palette % 6) + 6) % 6];
      const cut = (y0: number, h: number) => Math.max(0, Math.min(h, y + 1 - y0));
      const bodyTop = y + sink - 18;
      const headTop = y + sink - 29;
      if (cut(bodyTop, 16) > 0) rect(ctx, cam, x - 4, bodyTop, 8, cut(bodyTop, 16), body);
      if (cut(headTop, 7) > 0) rect(ctx, cam, x - 3, headTop, 6, cut(headTop, 7), FALLBACK.head);
    }
  }
  if (w.drink) {
    const at = canSpot(x, y, dir, w.drink.sip);
    can(ctx, cam, at.x, at.y, drinkColor(w.drink));
  }
  if (brolly) drawCanopy(ctx, cam, x, y, dir, w.umbrella, w.canopy, wind);
}
