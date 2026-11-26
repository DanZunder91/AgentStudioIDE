/** Tokyo street props, placed by engine/streetTheme.ts. Anchored like every prop: (x0, bottom) is
 * the footprint's left and bottom edges, world px. Deterministic: petals move with the clock `t`
 * alone. */

import { hashString } from "../engine/rng";
import type { Camera } from "./camera";
import { hash, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

// ───────────────────────────── sakura ─────────────────────────────

/** Cherry-tree colours. Exported for the tests (they read the canopy and the petals back). */
export const SAKURA = {
  shadow: "rgba(0, 0, 0, 0.22)",
  trunk: "#3d2626",
  bark: "#5c3a36",
  deep: "#a9496f",
  shade: "#cc6a92",
  pink: "#ea8fb2",
  light: "#f6b5cc",
  pale: "#fdd5e3",
  white: "#fff6f9",
  petal: "#f592b6",
  petalPale: "#ffc4d8",
} as const;

/** Falling petals per tree. */
export const PETALS = 6;
/** Seconds for one petal's whole cycle: fall, rest on the ground, start again in the canopy. */
export const PETAL_PERIOD = 4;
/** Share of the cycle a petal spends falling; the rest it lies on the ground. */
const FALL = 0.8;
/** Every place a petal can be, relative to (x0, bottom); right and bottom are exclusive. */
export const PETAL_COLUMN = { left: 1, right: 38, top: -24, bottom: 0 } as const;

/** One petal this frame, world px. */
export interface Petal {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** Falling petals at `t` seconds, each at its own offset in the shared cycle; seeded by the tree's
 * position so neighbours differ. Exactly periodic in `t` with PETAL_PERIOD. */
export function sakuraPetals(x0: number, bottom: number, t: number): Petal[] {
  const out: Petal[] = [];
  for (let k = 0; k < PETALS; k++) {
    const h = hash(x0, bottom, 101 + k);
    const off = (k / PETALS + ((h >>> 20) % 100) / 1000) * PETAL_PERIOD;
    const u = ((((t + off) % PETAL_PERIOD) + PETAL_PERIOD) % PETAL_PERIOD) / PETAL_PERIOD;
    const xs = x0 + 3 + (h % 24);
    const ys = bottom - 24 + ((h >>> 5) % 6);
    const ground = bottom - 1 - ((h >>> 8) % 3);
    const drift = 3 + ((h >>> 11) % 6);
    const amp = 1 + ((h >>> 14) % 2);
    const color = k % 2 === 0 ? SAKURA.petal : SAKURA.petalPale;
    if (u >= FALL) {
      out.push({ x: xs + drift, y: ground, w: 2, h: 1, color });
      continue;
    }
    const f = u / FALL;
    const turn = 2 * Math.PI * (2 * f + k / PETALS);
    out.push({
      x: Math.round(xs + drift * f + amp * Math.sin(turn)),
      y: Math.round(ys + (ground - ys) * f),
      w: Math.cos(turn) > 0 ? 2 : 1,
      h: 1,
      color,
    });
  }
  return out;
}

/** A cherry tree in bloom, its petals falling (`t` in seconds). 2×2 footprint, the canopy ~5 px above it. */
export function drawSakura(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, t: number): void {
  const b = bottom;
  const S = SAKURA;
  rect(ctx, cam, x0 + 5, b - 3, 22, 3, S.shadow);
  // A few petals already fallen around the foot of the tree (its own scatter, never moving).
  for (let i = 0; i < 5; i++) {
    const h = hash(x0, b, 7 + i);
    rect(ctx, cam, x0 + 1 + (h % 29), b - 1 - (i % 2), 1 + ((h >>> 9) % 2), 1, i % 2 === 0 ? S.petal : S.petalPale);
  }
  // The trunk: dark, leaning right then back left — crooked, as a cherry's is.
  rect(ctx, cam, x0 + 13, b - 3, 7, 2, S.trunk); // root flare
  rect(ctx, cam, x0 + 14, b - 9, 5, 7, S.trunk);
  rect(ctx, cam, x0 + 15, b - 13, 4, 5, S.trunk);
  rect(ctx, cam, x0 + 13, b - 17, 4, 5, S.trunk);
  rect(ctx, cam, x0 + 9, b - 19, 5, 2, S.trunk); // branch, left
  rect(ctx, cam, x0 + 17, b - 20, 6, 2, S.trunk); // branch, right
  rect(ctx, cam, x0 + 14, b - 9, 1, 6, S.bark);
  rect(ctx, cam, x0 + 15, b - 13, 1, 4, S.bark);
  // The canopy: a deep shade underneath, then layered pinks lighter towards the top-left.
  rect(ctx, cam, x0 + 3, b - 22, 26, 5, S.shade);
  rect(ctx, cam, x0 + 1, b - 27, 30, 7, S.shade);
  rect(ctx, cam, x0 + 5, b - 18, 22, 1, S.deep);
  rect(ctx, cam, x0 + 2, b - 31, 28, 9, S.pink);
  rect(ctx, cam, x0, b - 28, 32, 5, S.pink);
  rect(ctx, cam, x0 + 6, b - 35, 20, 5, S.pink);
  rect(ctx, cam, x0 + 10, b - 37, 11, 3, S.pink);
  // Lumps on the silhouette (a cloud of blossom, not a ball) and the scalloped underside.
  rect(ctx, cam, x0 + 3, b - 34, 5, 4, S.pink);
  rect(ctx, cam, x0 + 24, b - 34, 4, 4, S.pink);
  rect(ctx, cam, x0 + 21, b - 36, 4, 2, S.pink);
  rect(ctx, cam, x0 + 1, b - 21, 4, 2, S.shade);
  rect(ctx, cam, x0 + 27, b - 21, 4, 3, S.shade);
  rect(ctx, cam, x0 + 9, b - 17, 4, 1, S.shade);
  rect(ctx, cam, x0 + 21, b - 17, 3, 1, S.shade);
  rect(ctx, cam, x0 + 5, b - 33, 14, 7, S.light);
  rect(ctx, cam, x0 + 20, b - 29, 7, 5, S.light);
  rect(ctx, cam, x0 + 2, b - 26, 6, 3, S.light);
  rect(ctx, cam, x0 + 24, b - 33, 3, 2, S.light);
  rect(ctx, cam, x0 + 8, b - 35, 8, 3, S.pale);
  rect(ctx, cam, x0 + 22, b - 28, 3, 2, S.pale);
  rect(ctx, cam, x0 + 4, b - 25, 2, 1, S.pale);
  // Clumps of blossom: darker pink pockets between them.
  for (const [dx, dy, w] of [
    [13, 27, 4],
    [7, 29, 3],
    [19, 32, 3],
    [26, 26, 3],
    [16, 23, 5],
    [3, 23, 3],
  ])
    rect(ctx, cam, x0 + dx, b - dy, w, 1, S.shade);
  // Branch tips poking out of the underside.
  rect(ctx, cam, x0 + 10, b - 19, 3, 1, S.trunk);
  rect(ctx, cam, x0 + 20, b - 20, 3, 1, S.trunk);
  // White blossoms.
  for (const [dx, dy] of [
    [9, 34],
    [13, 31],
    [17, 36],
    [24, 27],
    [5, 24],
    [27, 25],
    [11, 28],
    [19, 24],
  ])
    rect(ctx, cam, x0 + dx, b - dy, 1, 1, S.white);
  for (const p of sakuraPetals(x0, b, t)) rect(ctx, cam, p.x, p.y, p.w, p.h, p.color);
}

// ───────────────────────────── vending machine ─────────────────────────────

/** Vending machine colours. Exported for the tests. */
export const VENDING = {
  /** The body by variant: 0 = blue, 1 = red. */
  body: [
    { base: "#2d5bd1", light: "#5f8bee", dark: "#1c3c94" },
    { base: "#cf2d2d", light: "#f0605a", dark: "#931d1c" },
  ],
  /** The display window's back-lit glass: always lit, brighter at night. */
  glassDay: "#cfe7f4",
  glassNight: "#f4fcff",
  shelf: "#8a96a4",
  cap: "#e8edf2",
  bottles: ["#e8412c", "#2fa84f", "#f2b631", "#3a7be0", "#8a4b2a", "#ff8fb1", "#f6f6f6"],
  panel: "#1f2633",
  button: "#b9c0c9",
  buttonLit: "#8dffa8",
  coin: "#c3c9d2",
  slot: "#171b22",
  slotEdge: "#3a414d",
  shadow: "rgba(0, 0, 0, 0.25)",
} as const;

/** A machine's look from its prop id: 0 = blue, 1 = red. */
export function vendingVariant(id: string): 0 | 1 {
  return (hashString(id) & 1) as 0 | 1;
}

/** Bottle columns and rows in the window (world px from x0 / from bottom). */
const BOTTLE_X = [3, 5, 7, 9, 11];
const BOTTLE_ROW = [26, 22, 18];

/** A 1×2-tile vending machine: `variant` 0 blue / 1 red; `lightsOn` lights window and buttons. */
export function drawVending(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, variant: number, lightsOn: boolean): void {
  const b = bottom;
  const V = VENDING;
  const body = V.body[variant === 1 ? 1 : 0];
  rect(ctx, cam, x0 + 1, b - 2, 14, 2, V.shadow);
  rect(ctx, cam, x0 + 1, b - 31, 14, 29, body.base);
  rect(ctx, cam, x0 + 1, b - 31, 14, 1, body.light);
  rect(ctx, cam, x0 + 1, b - 30, 1, 28, body.light);
  rect(ctx, cam, x0 + 14, b - 30, 1, 28, body.dark);
  rect(ctx, cam, x0 + 2, b - 30, 11, 2, body.light); // the lit header
  // The window: back-lit glass, three shelves of five bottles (a cap over each).
  rect(ctx, cam, x0 + 2, b - 27, 11, 13, lightsOn ? V.glassNight : V.glassDay);
  BOTTLE_ROW.forEach((dy, row) => {
    BOTTLE_X.forEach((dx, col) => {
      rect(ctx, cam, x0 + dx, b - dy, 1, 1, V.cap);
      rect(ctx, cam, x0 + dx, b - dy + 1, 1, 2, V.bottles[(row * BOTTLE_X.length + col + 3 * variant) % V.bottles.length]);
    });
    rect(ctx, cam, x0 + 2, b - dy + 3, 11, 1, V.shelf);
  });
  // A button under every column, then the coin panel and the pickup slot.
  rect(ctx, cam, x0 + 2, b - 14, 11, 2, V.panel);
  for (const dx of BOTTLE_X) rect(ctx, cam, x0 + dx, b - 14, 1, 1, lightsOn ? V.buttonLit : V.button);
  rect(ctx, cam, x0 + 2, b - 11, 7, 3, body.light); // the brand panel
  rect(ctx, cam, x0 + 10, b - 12, 3, 6, V.coin);
  rect(ctx, cam, x0 + 11, b - 11, 1, 2, V.slot); // coin slot
  rect(ctx, cam, x0 + 2, b - 6, 11, 3, V.slot); // pickup slot
  rect(ctx, cam, x0 + 2, b - 6, 11, 1, V.slotEdge);
  rect(ctx, cam, x0 + 1, b - 3, 14, 1, body.dark);
}

/** The machine's light at night: a cool halo round its window and a pool on the ground before it. */
export const VENDING_GLOW = "rgba(190, 228, 255, 0.14)";
/** Halo radii, world px, centred on the window. */
const GLOW_RADII = [6, 10, 14];
const GLOW_CX = 7;
const GLOW_CY = 21;

/** The machine's soft pool of light (`render/ambience.ts`'s lamp glow) round the window and on
 * the ground, for the night-lights pass. */
export function vendingGlow(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  const cx = x0 + GLOW_CX;
  const cy = bottom - GLOW_CY;
  for (const r of GLOW_RADII) {
    rect(ctx, cam, cx - r, cy - Math.round(r * 0.6), 2 * r, Math.round(r * 1.2), VENDING_GLOW);
    rect(ctx, cam, cx - Math.round(r * 0.6), cy - r, Math.round(r * 1.2), 2 * r, VENDING_GLOW);
  }
  rect(ctx, cam, x0 - 2, bottom - 2, 20, 4, VENDING_GLOW);
}

/** World box [x, y, w, h] holding everything `vendingGlow` paints — for an `onScreen` cull. */
export function vendingGlowBox(x0: number, bottom: number): [number, number, number, number] {
  const r = Math.max(...GLOW_RADII);
  const left = Math.min(x0 + GLOW_CX - r, x0 - 2);
  const right = Math.max(x0 + GLOW_CX + r, x0 + 18);
  const top = bottom - GLOW_CY - r;
  return [left, top, right - left, bottom + 2 - top];
}

// ───────────────────────────── torii ─────────────────────────────

/** Shrine gate colours. Exported for the tests. */
export const TORII = {
  vermilion: "#dd4a2c",
  highlight: "#f2724f",
  shade: "#a5321c",
  black: "#1f1a1a",
  sheen: "#3d3535",
  plaque: "#2b2321",
  gold: "#e2b84a",
  shadow: "rgba(0, 0, 0, 0.2)",
} as const;

/** Pillar left edges (world px from x0) and width. */
export const TORII_PILLARS = [9, 35] as const;
const PILLAR_W = 4;
/** How far the art rises above `bottom` (the kasagi's upturned ends). */
export const TORII_HEIGHT = 43;

/** A shrine gate, three tiles wide: you walk through its middle tile. */
export function drawTorii(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  const b = bottom;
  const T = TORII;
  for (const px of TORII_PILLARS) {
    rect(ctx, cam, x0 + px - 2, b - 2, PILLAR_W + 4, 2, T.shadow);
    rect(ctx, cam, x0 + px, b - 37, PILLAR_W, 33, T.vermilion); // hashira
    rect(ctx, cam, x0 + px, b - 37, 1, 33, T.highlight);
    rect(ctx, cam, x0 + px + PILLAR_W - 1, b - 37, 1, 33, T.shade);
    rect(ctx, cam, x0 + px - 1, b - 4, PILLAR_W + 2, 4, T.black); // kamaki, the black foot
  }
  rect(ctx, cam, x0 + 5, b - 29, 38, 3, T.vermilion); // nuki, the tie beam through the pillars
  rect(ctx, cam, x0 + 5, b - 27, 38, 1, T.shade);
  rect(ctx, cam, x0 + 22, b - 36, 4, 7, T.vermilion); // gakuzuka, the centre strut
  rect(ctx, cam, x0 + 21, b - 35, 6, 5, T.plaque); // the plaque on it
  rect(ctx, cam, x0 + 23, b - 34, 2, 3, T.gold);
  rect(ctx, cam, x0 + 3, b - 38, 42, 3, T.vermilion); // shimaki, under the top beam
  rect(ctx, cam, x0 + 3, b - 36, 42, 1, T.shade);
  rect(ctx, cam, x0 + 2, b - 41, 44, 3, T.black); // kasagi, the black top beam…
  rect(ctx, cam, x0 + 4, b - 42, 4, 1, T.black);
  rect(ctx, cam, x0 + 40, b - 42, 4, 1, T.black);
  rect(ctx, cam, x0, b - TORII_HEIGHT, 4, 3, T.black); // …its ends turned up
  rect(ctx, cam, x0 + 44, b - TORII_HEIGHT, 4, 3, T.black);
  rect(ctx, cam, x0 + 4, b - 41, 40, 1, T.sheen);
}
