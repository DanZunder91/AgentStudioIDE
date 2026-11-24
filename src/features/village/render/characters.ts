/**
 * Agent Village — characters, their origin marker, the spawn/despawn effect
 * and the status bubbles.
 *
 * Sheets are the vendored pixel-agents 112×96 character PNGs: 7 columns × 3
 * rows of 16×32 frames. Rows: down, up, right (left = right mirrored).
 * Columns: 0-2 walk (cycle 0,1,2,1; col 1 doubles as the idle pose), 3-4 type,
 * 5-6 read. The CharacterView's (x, y) is the FEET (bottom-centre).
 *
 * Spawn/despawn is a green "matrix rain": per column, a bright head sweeps
 * top-to-bottom over ALL 32 rows of the frame, trailed by flickering green;
 * on spawn the sprite is revealed behind the head, on despawn it is consumed.
 */

import { SEAT_LIFT, type CharacterView, type Dir } from "../villageTypes";
import type { Camera } from "./camera";
import { blit, hash, rect, sx, sy } from "./paint";
import type { DrawTarget, SpriteBank, SpriteImage } from "./renderTypes";
import { CHAR_SHEET } from "./sprites";

const FW = CHAR_SHEET.frameW;
const FH = CHAR_SHEET.frameH;
/** Sprite row (from the frame top) the feet sit on: the frame's art ends ~2 px above its bottom. */
const FEET = 31;
/** The head top, measured from the feet. */
const HEAD = 29;
const WALK_CYCLE = [0, 1, 2, 1];
const ROW: Record<Dir, number> = { down: 0, up: 1, right: 2, left: 2 };

export const MARKER_IDE = "#4c9aff";
export const MARKER_EXTERNAL = "#8b8f96";
const RAIN_HEAD = "#ccffcc";
const RAIN = ["#2bd55a", "#1fae48", "#138a37"];
const TRAIL = 6;
const FALLBACK_BODY = [
  "#d9534f",
  "#3d6fc4",
  "#5cb85c",
  "#f0ad4e",
  "#9b59b6",
  "#1abc9c",
];

const mod = (i: number, n: number): number => ((Math.trunc(i) % n) + n) % n;

/** Which sheet cell a CharacterView shows: `{ col, row, flip }`. */
export function characterFrame(
  c: Pick<CharacterView, "dir" | "anim" | "frame">,
): {
  col: number;
  row: number;
  flip: boolean;
} {
  const col =
    c.anim === "walk"
      ? WALK_CYCLE[mod(c.frame, 4)]
      : c.anim === "type"
        ? 3 + mod(c.frame, 2)
        : c.anim === "read"
          ? 5 + mod(c.frame, 2)
          : 1;
  return { col, row: ROW[c.dir], flip: c.dir === "left" };
}

/** World y of the top of the head (where marker and bubble stack from). */
export function headTop(c: Pick<CharacterView, "y" | "seated">): number {
  return Math.round(c.y) - HEAD - (c.seated ? SEAT_LIFT : 0);
}

/**
 * The matrix-rain reveal/consume of one frame. Column `i` of the displayed
 * sprite starts after a per-column stagger and sweeps its head from row 0 to
 * past row 31 (the whole frame — no rows are skipped).
 */
function drawMatrix(
  ctx: DrawTarget,
  cam: Camera,
  sheet: SpriteImage,
  srcX: number,
  srcY: number,
  flip: boolean,
  wx: number,
  wy: number,
  fx: { kind: "spawn" | "despawn"; t: number },
): void {
  const t = Math.min(1, Math.max(0, fx.t));
  const spawn = fx.kind === "spawn";
  const z = cam.zoom;
  const tick = Math.floor(t * 24);
  for (let i = 0; i < FW; i++) {
    const stagger = ((hash(i, 31, 5) % 1000) / 1000) * 0.3;
    const p = Math.min(1, Math.max(0, (t - stagger) / 0.7));
    const head = Math.floor(p * (FH + TRAIL));
    const src = srcX + (flip ? FW - 1 - i : i);
    // The plain sprite: above the trail on spawn, below the head on despawn.
    const [a, b] = spawn
      ? [0, Math.min(FH, head - TRAIL)]
      : [Math.max(0, head + 1), FH];
    if (b > a)
      ctx.drawImage(
        sheet,
        src,
        srcY + a,
        1,
        b - a,
        sx(cam, wx + i),
        sy(cam, wy + a),
        z,
        (b - a) * z,
      );
    for (let r = Math.max(0, head - TRAIL); r < Math.min(FH, head); r++) {
      if (spawn)
        ctx.drawImage(
          sheet,
          src,
          srcY + r,
          1,
          1,
          sx(cam, wx + i),
          sy(cam, wy + r),
          z,
          z,
        );
      if ((hash(i, r, tick) & 255) < 176) {
        const age = head - r; // 1 = just behind the head
        ctx.globalAlpha = 1 - (age - 1) / TRAIL;
        rect(ctx, cam, wx + i, wy + r, 1, 1, RAIN[mod(age, RAIN.length)]);
        ctx.globalAlpha = 1;
      }
    }
    if (head < FH) rect(ctx, cam, wx + i, wy + head, 1, 1, RAIN_HEAD);
  }
}

/** The origin marker: a 5×5 diamond above the head — accent blue for IDE agents, grey for external. */
function drawMarker(ctx: DrawTarget, cam: Camera, c: CharacterView): void {
  const color = c.origin === "ide" ? MARKER_IDE : MARKER_EXTERNAL;
  const cx = Math.round(c.x);
  const top = headTop(c) - 7;
  rect(ctx, cam, cx, top, 1, 1, color);
  rect(ctx, cam, cx - 1, top + 1, 3, 1, color);
  rect(ctx, cam, cx - 2, top + 2, 5, 1, color);
  rect(ctx, cam, cx - 1, top + 3, 3, 1, color);
  rect(ctx, cam, cx, top + 4, 1, 1, color);
}

/** The world box [x, y, w, h] of `c`'s sprite frame — what a light painted after the grade must leave out (render/backdropLights.ts). */
export function characterBox(c: CharacterView): [number, number, number, number] {
  return [Math.round(c.x) - FW / 2, Math.round(c.y) - FEET - (c.seated ? SEAT_LIFT : 0), FW, FH];
}

/** One character: shadow, sprite (or matrix effect, or a fallback block), origin marker. */
export function drawCharacter(
  ctx: DrawTarget,
  cam: Camera,
  c: CharacterView,
  bank: SpriteBank | null,
): void {
  const { col, row, flip } = characterFrame(c);
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const wx = x - FW / 2;
  const lift = c.seated ? SEAT_LIFT : 0;
  const wy = y - FEET - lift;
  const sheet = bank?.character(c.palette, c.hueShift) ?? null;

  if (!c.seated && !c.fx)
    rect(ctx, cam, x - 5, y - 2, 10, 2, "rgba(0, 0, 0, 0.25)");

  if (sheet && c.fx) {
    drawMatrix(ctx, cam, sheet, col * FW, row * FH, flip, wx, wy, c.fx);
  } else if (sheet) {
    blit(ctx, cam, sheet, col * FW, row * FH, FW, FH, wx, wy, flip);
  } else {
    // No art: a coloured body + head block, faded through any spawn/despawn.
    const t = c.fx ? Math.min(1, Math.max(0, c.fx.t)) : 1;
    ctx.globalAlpha = c.fx?.kind === "despawn" ? 1 - t : t;
    const body = FALLBACK_BODY[mod(c.palette, FALLBACK_BODY.length)];
    rect(ctx, cam, x - 4, y - 18 - lift, 8, 16, body);
    rect(ctx, cam, x - 3, headTop(c), 6, 7, "#f1c9a5");
    ctx.globalAlpha = 1;
  }

  if (!c.fx) drawMarker(ctx, cam, c);
}

// ───────────────────────────── bubbles ─────────────────────────────

const BUBBLE_W = 11;
const BUBBLE_BOX_H = 10;
const BUBBLE_EDGE = "#3b3b4a";
const BUBBLE_FILL = "#f4f4fb";

/** Icon pixels (relative to the bubble's top-left) per bubble kind. */
const BUBBLE_ICON: Record<
  NonNullable<CharacterView["bubble"]>,
  { color: string; px: [number, number, number, number][] }
> = {
  // amber "…"
  waiting: {
    color: "#d9a400",
    px: [
      [2, 5, 1, 1],
      [5, 5, 1, 1],
      [8, 5, 1, 1],
    ],
  },
  // green check
  done: {
    color: "#2e9e44",
    px: [
      [2, 5, 1, 1],
      [3, 6, 1, 1],
      [4, 7, 1, 1],
      [5, 6, 1, 1],
      [6, 5, 1, 1],
      [7, 4, 1, 1],
      [8, 3, 1, 1],
    ],
  },
  // red "!"
  error: {
    color: "#d33a3a",
    px: [
      [5, 2, 1, 4],
      [5, 7, 1, 1],
    ],
  },
};

/** The status bubble over a character's head (above the marker), at `bubbleAlpha`. */
export function drawBubble(
  ctx: DrawTarget,
  cam: Camera,
  c: CharacterView,
): void {
  if (!c.bubble || c.bubbleAlpha <= 0) return;
  const bx = Math.round(c.x) - Math.floor(BUBBLE_W / 2);
  const by = headTop(c) - 9 - (BUBBLE_BOX_H + 2);
  ctx.globalAlpha = Math.min(1, c.bubbleAlpha);
  rect(ctx, cam, bx, by, BUBBLE_W, BUBBLE_BOX_H, BUBBLE_EDGE);
  rect(ctx, cam, bx + 1, by + 1, BUBBLE_W - 2, BUBBLE_BOX_H - 2, BUBBLE_FILL);
  rect(ctx, cam, bx + 4, by + BUBBLE_BOX_H, 3, 1, BUBBLE_EDGE); // tail
  rect(ctx, cam, bx + 5, by + BUBBLE_BOX_H - 1, 1, 1, BUBBLE_FILL);
  rect(ctx, cam, bx + 5, by + BUBBLE_BOX_H + 1, 1, 1, BUBBLE_EDGE);
  const icon = BUBBLE_ICON[c.bubble];
  for (const [ix, iy, w, h] of icon.px)
    rect(ctx, cam, bx + ix, by + iy, w, h, icon.color);
  ctx.globalAlpha = 1;
}
