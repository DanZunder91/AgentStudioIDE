/** `/context`'s 200 seats (20 a row, one seat = 0.5% of the selected agent's window) in the CLI's
 * order, front row first. No reading: grey chairs and a "?", never an empty hall. Anchored like
 * every prop: (x0, bottom) = the footprint's left and bottom edges, world px. */

import { BUFFER_KEY, FREE_KEY, GRID_COLUMNS, GRID_ROWS, contextHex } from "../../context/contextFormat";
import { hash2 } from "../engine/rng";
import { HALL_H } from "../engine/world";
import { TILE, type HallFrame, type PropReading } from "../villageTypes";
import { METER_TONE } from "./capacity";
import type { Camera } from "./camera";
import { rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** A seat's pitch, world px: across a row, and from row to row. */
export const SEAT_W = 9;
export const SEAT_H = 12;
/** The aisle between the left and right blocks of ten, world px. */
export const AISLE_W = 12;
/** The seats' span across the hall, world px: two blocks of ten and the aisle (192). */
export const SEATS_SPAN = GRID_COLUMNS * SEAT_W + AISLE_W;
/** The Village hall's left margin (to the first seat) — 208 px wide, so the span sits centred — and the rows' top (under the screen), world px. */
export const SEATS_LEFT = 8;
export const SEATS_TOP = 16;
/** The screen's width, world px; it is centred over the seats. */
export const SCREEN_W = 120;

/** The left margin, world px, that centres the seats in a hall `widthPx` wide (208 — the Village's and the City's — → 8; 192 → 0). */
export function hallLeft(widthPx: number): number {
  return Math.max(0, Math.floor((widthPx - SEATS_SPAN) / 2));
}

/** Hall colours. Exported for the tests (they read the pixels back). */
export const HALL = {
  /** A free seat's cushion, seen from above, and its backrest (nearer the viewer). */
  cushion: "#8b2e3c",
  back: "#6a1f2b",
  backHi: "#a33a4a",
  arm: "#3a2328",
  /** The same chair with no reading: grey, so an unknown hall never reads as an empty one. */
  cushionUnknown: "#4a505c",
  backUnknown: "#3a3f4a",
  backHiUnknown: "#5a606c",
  /** The reserved card on an autocompact-buffer seat, and its ✕. */
  card: "#d9dde4",
  cross: "#5b6472",
  aisle: "#4a1e28",
  screenFrame: "#2a3140",
  screenFace: "#0f1420",
  screenTrack: "#232b38",
  screenMark: "#8b93a3",
} as const;

/** Skin tones and hair colours the audience is dealt from (by seat number, so a seat keeps its look). */
export const SKINS = ["#f1c7a3", "#d9a07a", "#a8714f", "#7a4e33"] as const;
export const HAIRS = ["#2a1d17", "#5a3a22", "#c9a25a", "#9a9aa0", "#b5532a", "#1b1b22"] as const;

/** How often a seated character shifts in its seat (s), and for how long (s). */
const SHIFT_EVERY_MIN = 7;
const SHIFT_EVERY_SPREAD = 9;
const SHIFT_SEC = 0.5;

/** Seat `i`'s top-left relative to the hall's, world px; row-major. `left` = the hall's margin
 * (`hallLeft`; the Village's by default). */
export function seatOrigin(i: number, left = SEATS_LEFT): { x: number; y: number } {
  const col = i % GRID_COLUMNS;
  const row = Math.floor(i / GRID_COLUMNS);
  return { x: left + col * SEAT_W + (col >= GRID_COLUMNS / 2 ? AISLE_W : 0), y: SEATS_TOP + row * SEAT_H };
}

/** Seat `i`'s look: a skin and a hair colour, from its number only. */
export function seatLook(i: number): { skin: string; hair: string } {
  const h = hash2(i, 0x5ea7);
  return { skin: SKINS[h % SKINS.length], hair: HAIRS[(h >>> 8) % HAIRS.length] };
}

/** True while seat `i`'s character is shifting in its seat at `timeSec`: briefly, on its own rhythm. */
export function seatShifting(i: number, timeSec: number): boolean {
  const h = hash2(i, 0x51f7);
  const period = SHIFT_EVERY_MIN + (h % SHIFT_EVERY_SPREAD);
  const t = (timeSec + ((h >>> 4) % 1000) / 1000 * period) % period;
  return t >= period - SHIFT_SEC;
}

/** The categories in the hall, in seat order, each once (the screen's legend). */
export function legendOf(cells: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of cells) if (c !== FREE_KEY && c !== BUFFER_KEY && !out.includes(c)) out.push(c);
  return out;
}

/** The whole hall, `widthPx` wide (208 in both views): carpet, screen, then seats front row first
 * (nearer rows overlap farther ones). */
export function drawHall(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  reading: PropReading | undefined,
  timeMs: number,
  widthPx = SEATS_SPAN + 2 * SEATS_LEFT,
): void {
  const hall: HallFrame | null = reading?.kind === "hall" ? reading.hall : null;
  const cells = hall?.cells ?? null;
  const top = bottom - HALL_H * TILE;
  const left = hallLeft(widthPx);
  const aisle = x0 + left + (GRID_COLUMNS / 2) * SEAT_W;
  // The aisle's carpet runs from the front row down to the hall's back, where the door is.
  rect(ctx, cam, aisle + 2, top + SEATS_TOP, AISLE_W - 4, HALL_H * TILE - SEATS_TOP, HALL.aisle);
  drawScreen(ctx, cam, x0 + Math.floor((widthPx - SCREEN_W) / 2), top, hall);
  const timeSec = timeMs / 1000;
  for (let i = 0; i < GRID_COLUMNS * GRID_ROWS; i++) {
    const o = seatOrigin(i, left);
    drawSeat(ctx, cam, x0 + o.x, top + o.y, cells ? cells[i] ?? FREE_KEY : null, i, timeSec);
  }
}

/** The legend (a swatch per category in the hall) and the window's fill bar in the Context card's
 * tone; with no reading, a dark face and a "?". */
function drawScreen(ctx: DrawTarget, cam: Camera, sx: number, top: number, hall: HallFrame | null): void {
  rect(ctx, cam, sx, top + 1, SCREEN_W, 12, HALL.screenFrame);
  rect(ctx, cam, sx + 1, top + 2, 118, 10, HALL.screenFace);
  if (!hall?.cells || hall.usedPct === null) {
    rect(ctx, cam, sx + 57, top + 3, 4, 1, HALL.screenMark);
    rect(ctx, cam, sx + 61, top + 4, 1, 2, HALL.screenMark);
    rect(ctx, cam, sx + 59, top + 6, 2, 1, HALL.screenMark);
    rect(ctx, cam, sx + 59, top + 7, 1, 1, HALL.screenMark);
    rect(ctx, cam, sx + 59, top + 9, 1, 1, HALL.screenMark);
    return;
  }
  legendOf(hall.cells).slice(0, 14).forEach((key, k) => rect(ctx, cam, sx + 4 + k * 8, top + 4, 6, 2, contextHex(key)));
  rect(ctx, cam, sx + 4, top + 8, 110, 2, HALL.screenTrack);
  const pct = Math.min(100, Math.max(0, hall.usedPct));
  const filled = Math.max(pct > 0 ? 1 : 0, Math.round((110 * pct) / 100));
  if (filled > 0) rect(ctx, cam, sx + 4, top + 8, filled, 2, METER_TONE[hall.tone]);
}

/** `key`: the seated category; `free-space` an empty chair, `autocompact-buffer` a reserved one,
 * null no reading (a grey chair). (x, y) is the seat's top-left, world px. */
function drawSeat(ctx: DrawTarget, cam: Camera, x: number, y: number, key: string | null, i: number, timeSec: number): void {
  const unknown = key === null;
  const taken = key !== null && key !== FREE_KEY && key !== BUFFER_KEY;
  rect(ctx, cam, x, y + 7, 1, 5, HALL.arm);
  rect(ctx, cam, x + 8, y + 7, 1, 5, HALL.arm);
  if (taken) {
    // A character seen from behind: a round head of hair with its ears showing, the shoulders and
    // back in its category's colour.
    const { skin, hair } = seatLook(i);
    const lift = seatShifting(i, timeSec) ? 1 : 0;
    const shirt = contextHex(key);
    rect(ctx, cam, x + 1, y + 3 - lift, 7, 1, skin);
    rect(ctx, cam, x + 3, y + 1 - lift, 3, 1, hair);
    rect(ctx, cam, x + 2, y + 2 - lift, 5, 3, hair);
    rect(ctx, cam, x + 2, y + 5, 5, 1, shirt);
    rect(ctx, cam, x + 1, y + 6, 7, 4, shirt);
  } else {
    rect(ctx, cam, x + 1, y + 6, 7, 4, unknown ? HALL.cushionUnknown : HALL.cushion);
    if (key === BUFFER_KEY) {
      rect(ctx, cam, x + 2, y + 5, 5, 4, HALL.card);
      rect(ctx, cam, x + 3, y + 6, 1, 1, HALL.cross);
      rect(ctx, cam, x + 5, y + 6, 1, 1, HALL.cross);
      rect(ctx, cam, x + 4, y + 7, 1, 1, HALL.cross);
      rect(ctx, cam, x + 3, y + 8, 1, 1, HALL.cross);
      rect(ctx, cam, x + 5, y + 8, 1, 1, HALL.cross);
    }
  }
  // The backrest, nearer the viewer than whoever sits there: it hides the sitter's lower back.
  rect(ctx, cam, x + 1, y + 10, 7, 2, unknown ? HALL.backUnknown : HALL.back);
  rect(ctx, cam, x + 1, y + 10, 7, 1, unknown ? HALL.backHiUnknown : HALL.backHi);
}
