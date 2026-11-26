/** City vehicles (car, kei, taxi, bus), driven by engine/traffic.ts. Parts are laid out FACING
 * RIGHT (`lx` from the left end, `y` px up from the road), mirrored by `part`; lights are drawn in
 * the night-lights pass after the grade. Nothing is allocated per frame. */

import type { VehicleKind, VehicleView } from "../villageTypes";
import type { Camera } from "./camera";
import { hash, onScreen, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** A part's paint: a role a palette fills in. */
type Role = "roof" | "cabin" | "body" | "light" | "shade" | "glass" | "dark" | "trim" | "head" | "tail" | "band" | "lamp" | "accent";
/** One rect of a vehicle facing right: [role, lx, y above the road to its top, w, h]. */
type Part = readonly [Role, number, number, number, number];

/** Colours every vehicle shares. Exported for the tests. */
export const COMMON = {
  glass: "#4d6074",
  glassHi: "#7d93aa",
  dark: "#23262c",
  trim: "#9ea5ae",
  head: "#f3eecb",
  tail: "#8f2630",
  /** The tail lights while braking. */
  brake: "#ff3d3d",
  tyre: "#1b1c20",
  hub: "#9aa3ad",
  spoke: "#dde2e7",
  shadow: "rgba(0, 0, 0, 0.28)",
  spray: "rgba(222, 232, 246, 0.5)",
  /** A bus's door glass, its destination board and the passengers seen through its windows by day. */
  door: "#384858",
  board: "#2a2a2e",
  boardText: "#d98a2b",
  rider: "#273040",
} as const;

/** The paints a kind is drawn in: body (lower body), cabin (upper body), their highlight and shade, and the kind's own accents. */
export interface Paint {
  body: string;
  cabin: string;
  light: string;
  shade: string;
  /** A taxi's stripe, a bus's livery band. */
  band: string;
  /** A taxi's roof lamp; a bus's roof. */
  lamp: string;
  roof: string;
  /** A bus's thin line under its band. */
  accent: string;
}

const livery = (body: string, light: string, shade: string, extra: Partial<Paint> = {}): Paint => ({
  body,
  cabin: body,
  light,
  shade,
  band: shade,
  lamp: light,
  roof: light,
  accent: light,
  ...extra,
});

/** Per kind, one paint per livery (engine/traffic.ts `SPEC.liveries` picks among them). Exported for the tests. */
export const PAINTS: Record<VehicleKind, readonly Paint[]> = {
  car: [
    livery("#e9e7e1", "#ffffff", "#c4c2bb"), // white
    livery("#b8bfc8", "#dfe4ea", "#8f97a1"), // silver
    livery("#2b2f37", "#4a515d", "#1b1e24"), // black
    livery("#c3343c", "#e2626a", "#8e2129"), // red
    livery("#2f5d9e", "#5582c2", "#213f6c"), // blue
    livery("#3f7f74", "#62a497", "#2b5a52"), // teal
  ],
  kei: [
    livery("#efe6cf", "#fffaf0", "#cbbf9f"), // cream
    livery("#9fd3c0", "#c8eadc", "#76a996"), // mint
    livery("#f1d36b", "#fbe8a4", "#c3a640"), // butter
    livery("#8dbbe3", "#bcd9f2", "#6690b8"), // sky
  ],
  taxi: [
    // The tall indigo wagon: a gold pinstripe, a warm roof lantern.
    livery("#232c45", "#3a4666", "#161c2e", { band: "#c8a24a", lamp: "#ffd257" }),
    // Classic two-tone sedans with a roof sign.
    livery("#f0b42c", "#ffd772", "#b9861a", { cabin: "#f0b42c", band: "#2a2a2a", lamp: "#fff1c2" }),
    livery("#2f8a5c", "#56b384", "#1f6141", { cabin: "#efece2", band: "#efece2", lamp: "#fff1c2" }),
    livery("#e2703a", "#f39a6b", "#a94f25", { cabin: "#f3efe6", band: "#f3efe6", lamp: "#fff1c2" }),
  ],
  bus: [
    livery("#efe9da", "#fbf7ee", "#c9c1ad", { band: "#1f8a8a", accent: "#7cc6c0", roof: "#cfd5d9" }), // cream, teal band
    livery("#f2f3f0", "#ffffff", "#c8cbc6", { band: "#2c5aa0", accent: "#86a8dc", roof: "#d3d7dc" }), // white, blue band
  ],
};

// ───────────────────────────── shapes (facing right) ─────────────────────────────

const SEDAN: readonly Part[] = [
  ["roof", 13, 20, 13, 1],
  ["cabin", 10, 19, 19, 7],
  ["glass", 12, 18, 6, 5],
  ["glass", 19, 18, 6, 5],
  ["glass", 26, 18, 2, 5],
  ["body", 0, 13, 38, 7],
  ["light", 1, 13, 36, 1],
  ["shade", 18, 12, 1, 5],
  ["shade", 1, 9, 36, 1],
  ["dark", 3, 7, 32, 1],
  ["trim", 0, 9, 1, 3],
  ["trim", 37, 9, 1, 3],
  ["head", 36, 12, 2, 2],
  ["tail", 0, 12, 2, 2],
];

const KEI: readonly Part[] = [
  ["roof", 3, 21, 22, 1],
  ["cabin", 2, 20, 24, 8],
  ["glass", 4, 19, 7, 5],
  ["glass", 12, 19, 7, 5],
  ["glass", 21, 19, 3, 6],
  ["body", 0, 13, 30, 7],
  ["light", 1, 13, 28, 1],
  ["shade", 11, 12, 1, 5],
  ["shade", 1, 9, 28, 1],
  ["dark", 3, 7, 24, 1],
  ["trim", 0, 9, 1, 3],
  ["trim", 29, 9, 1, 3],
  ["head", 28, 12, 2, 2],
  ["tail", 0, 12, 2, 2],
];

/** The tall indigo taxi: a lantern on its roof, three side windows, a gold pinstripe. */
const WAGON: readonly Part[] = [
  ["lamp", 16, 23, 6, 2],
  ["dark", 15, 21, 8, 1],
  ["roof", 8, 20, 24, 1],
  ["cabin", 6, 19, 28, 7],
  ["glass", 8, 18, 7, 5],
  ["glass", 16, 18, 7, 5],
  ["glass", 24, 18, 6, 5],
  ["glass", 31, 18, 2, 6],
  ["body", 0, 13, 38, 7],
  ["light", 1, 13, 36, 1],
  ["shade", 16, 12, 1, 5],
  ["band", 1, 11, 36, 1],
  ["shade", 1, 9, 36, 1],
  ["dark", 3, 7, 32, 1],
  ["trim", 0, 9, 1, 3],
  ["trim", 37, 9, 1, 3],
  ["head", 36, 12, 2, 2],
  ["tail", 0, 12, 2, 2],
];

/** A classic taxi: the sedan, a roof sign, a stripe along its flank. */
const CLASSIC: readonly Part[] = [["lamp", 16, 22, 6, 2], ...SEDAN, ["band", 2, 11, 34, 1]];

const BUS: readonly Part[] = [
  ["roof", 2, 32, 60, 1],
  ["body", 0, 31, 64, 24],
  ["dark", 21, 30, 17, 3],
  ["glass", 59, 26, 3, 13],
  ["band", 0, 15, 64, 3],
  ["accent", 0, 12, 64, 1],
  ["dark", 0, 8, 64, 1],
  ["trim", 0, 10, 1, 2],
  ["trim", 63, 10, 1, 2],
  ["head", 62, 11, 2, 2],
  ["tail", 0, 16, 1, 4],
];

/** A bus's side windows: their left ends; each `WINDOW_W` wide, its top `WINDOW_TOP` px above the road, `WINDOW_H` tall. */
export const BUS_WINDOWS: readonly number[] = [3, 11, 19, 27, 35, 43, 51];
const WINDOW_W = 7;
const WINDOW_TOP = 26;
const WINDOW_H = 10;
/** Its doors (the kerb side only — the near lane): front and middle, door glass from the window band's top to the skirt. */
export const BUS_DOORS: readonly number[] = [52, 28];
const DOOR_W = 5;
const DOOR_TOP = 27;
const DOOR_H = 19;
/** Its destination board's amber text, a dot every other px. */
const BOARD = { lx: 22, y: 29, n: 8 } as const;

/** Wheels: their centre columns (facing right) and size (odd: a middle pixel for the hub). */
const WHEELS: Record<VehicleKind, { at: readonly number[]; size: number }> = {
  car: { at: [8, 29], size: 7 },
  kei: { at: [7, 23], size: 7 },
  taxi: { at: [8, 29], size: 7 },
  bus: { at: [13, 47], size: 9 },
};

/** World px driven per step of a wheel's light spot round its hub (four steps a turn). */
export const WHEEL_STEP = 4;
/** A vehicle sprays a wet road behind it above this speed (px/s). */
export const SPRAY_SPEED = 20;

/** The parts of `v`'s shape (a taxi's livery 0 is the wagon, the others the classic sedan). */
export function shapeOf(v: Pick<VehicleView, "kind" | "livery">): readonly Part[] {
  if (v.kind === "bus") return BUS;
  if (v.kind === "kei") return KEI;
  if (v.kind === "taxi") return v.livery === 0 ? WAGON : CLASSIC;
  return SEDAN;
}

/** World px the spray reaches behind a vehicle's body. */
const SPRAY_BACK = 4;
/** World px the tallest vehicle's art rises above the road (the bus's roof). */
export const ART_H = 32;
/** World px the headlamps' beam reaches ahead (`BEAM_SLICES` × `BEAM_STEP` and the pool's 2 px), and more than the tail lights' glow behind. */
export const BEAM = 32;

/** One rect of `v` given FACING RIGHT (`lx` from its left end, `y` px above the road to its top),
 * mirrored about its middle when it faces left. */
function part(ctx: DrawTarget, cam: Camera, v: VehicleView, lx: number, y: number, w: number, h: number, color: string): void {
  const x0 = Math.round(v.x);
  rect(ctx, cam, v.dir > 0 ? x0 + lx : x0 + v.w - lx - w, Math.round(v.y) - y, w, h, color);
}

/** A role's colour in `p`. */
function roleColor(role: Role, p: Paint, braking: boolean): string {
  switch (role) {
    case "glass":
    case "dark":
    case "trim":
    case "head":
      return COMMON[role];
    case "tail":
      return braking ? COMMON.brake : COMMON.tail;
    default:
      return p[role];
  }
}

/** Which light-spot position (0..3: top, front, bottom, back) a wheel shows after `odo` px. */
export function wheelFrame(odo: number): number {
  return Math.floor(Math.max(0, odo) / WHEEL_STEP) & 3;
}

const SPOKE: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Passenger at bus window `k`: null for an empty seat, else its offset (0 or 1 px) in the window. Stable per bus. */
export function busRider(seed: number, k: number): number | null {
  const h = hash(seed, k, 0x6b75);
  return (h & 3) === 0 ? null : (h >>> 2) & 1;
}

/** A passenger's head and shoulders at window `k` (offset `off`), in `color`. */
function rider(ctx: DrawTarget, cam: Camera, v: VehicleView, k: number, off: number, color: string): void {
  const lx = BUS_WINDOWS[k] + 1 + off;
  part(ctx, cam, v, lx + 1, WINDOW_TOP - 4, 3, 3, color);
  part(ctx, cam, v, lx, WINDOW_TOP - 7, 5, 3, color);
}

/** `v` itself: its shadow, its body, a bus's windows and doors, its wheels, and spray on a wet road. */
export function drawVehicle(ctx: DrawTarget, cam: Camera, v: VehicleView, wet: boolean): void {
  const p = PAINTS[v.kind][v.livery];
  const wheels = WHEELS[v.kind];
  part(ctx, cam, v, 1, 1, v.w - 2, 1, COMMON.shadow);
  for (const [role, lx, y, w, h] of shapeOf(v)) part(ctx, cam, v, lx, y, w, h, roleColor(role, p, v.braking));
  if (v.kind === "bus") {
    BUS_WINDOWS.forEach((lx, k) => {
      part(ctx, cam, v, lx, WINDOW_TOP, WINDOW_W, WINDOW_H, COMMON.glass);
      part(ctx, cam, v, lx, WINDOW_TOP, WINDOW_W, 1, COMMON.glassHi);
      const off = busRider(v.seed, k);
      if (off !== null) rider(ctx, cam, v, k, off, COMMON.rider);
    });
    // The kerb side (the near lane, driving left): its doors.
    if (v.dir < 0) for (const lx of BUS_DOORS) part(ctx, cam, v, lx, DOOR_TOP, DOOR_W, DOOR_H, COMMON.door);
    for (let i = 0; i < BOARD.n; i++) part(ctx, cam, v, BOARD.lx + 2 * i, BOARD.y, 1, 1, COMMON.boardText);
  }
  const f = wheelFrame(v.odo);
  const r = (wheels.size - 1) / 2;
  for (const cx of wheels.at) {
    part(ctx, cam, v, cx - r + 1, wheels.size, wheels.size - 2, wheels.size, COMMON.tyre);
    part(ctx, cam, v, cx - r, wheels.size - 1, wheels.size, wheels.size - 2, COMMON.tyre);
    // The hub, 3 px round the wheel's middle (`r + 1` px up); the light spot on its rim.
    part(ctx, cam, v, cx - 1, r + 2, 3, 3, COMMON.hub);
    const [dx, dy] = SPOKE[f];
    part(ctx, cam, v, cx + dx, r + 1 - dy, 1, 1, COMMON.spoke);
  }
  if (wet && v.speed > SPRAY_SPEED) {
    // Behind the rear wheel, three droplets flickering with the wheel.
    const back = wheels.at[0] - r - 2;
    for (let k = 0; k < 3; k++) part(ctx, cam, v, back - 2 * k, 1 + ((k + f) & 1), 1, 1, COMMON.spray);
  }
}

/** The world box `v`'s art covers (for culling). */
export function vehicleBox(v: VehicleView): [number, number, number, number] {
  return [v.x - SPRAY_BACK, v.y - ART_H, v.w + 2 * SPRAY_BACK, ART_H + 1];
}

// ───────────────────────────── night ─────────────────────────────

/** Night-light colours. Exported for the tests. */
export const LIGHTS = {
  head: "#fff7d6",
  tail: "#ff4b3e",
  tailGlow: "rgba(255, 60, 45, 0.26)",
  /** The wider halo of a braking vehicle's tail lights. */
  brakeGlow: "rgba(255, 60, 45, 0.16)",
  lamp: "#ffe38a",
  lampGlow: "rgba(255, 214, 110, 0.28)",
  window: "#ffe6a6",
  rider: "#3b3138",
  board: "#ffbe55",
} as const;

/** Headlamp beam: `BEAM_SLICES` strips `BEAM_STEP` px long, each a px taller each side and
 * fainter (a stepped cone), plus as many on the road under it. */
export const BEAM_STEP = 5;
export const BEAM_SLICES = 6;
export const BEAM_FADE: readonly string[] = [0.26, 0.2, 0.15, 0.11, 0.08, 0.05].map((a) => `rgba(255, 214, 120, ${a})`);

/** The world box `v`'s lights cover: its art, the beam ahead and the glow behind. */
export function lightsBox(v: VehicleView): [number, number, number, number] {
  return [v.x - BEAM, v.y - ART_H - 2, v.w + 2 * BEAM, ART_H + 3];
}

/** Every on-screen vehicle's lights for the night-lights pass (render/ambience.ts); tail lights
 * glow wider and brighter when braking. */
export function paintVehicleLights(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, list: readonly VehicleView[]): void {
  for (const v of list) {
    if (!onScreen(cam, view, ...lightsBox(v))) continue;
    for (const [role, lx, y, w, h] of shapeOf(v)) {
      if (role === "head") {
        // The beam from the lamp's front edge — a stepped cone, and its pool on the road — then the lamp.
        for (let k = 0; k < BEAM_SLICES; k++) {
          part(ctx, cam, v, lx + w + BEAM_STEP * k, y + k, BEAM_STEP, h + 2 * k, BEAM_FADE[k]);
          part(ctx, cam, v, lx + w + 2 + BEAM_STEP * k, 3, BEAM_STEP, 3, BEAM_FADE[k]);
        }
        part(ctx, cam, v, lx, y, w, h, LIGHTS.head);
      } else if (role === "tail") {
        part(ctx, cam, v, lx - 3, y + 1, 3, h + 2, LIGHTS.tailGlow);
        if (v.braking) part(ctx, cam, v, lx - 6, y + 2, 6, h + 4, LIGHTS.brakeGlow);
        part(ctx, cam, v, lx, y, w, h, LIGHTS.tail);
      } else if (role === "lamp") {
        part(ctx, cam, v, lx - 2, y + 2, w + 4, h + 4, LIGHTS.lampGlow);
        part(ctx, cam, v, lx, y, w, h, LIGHTS.lamp);
      }
    }
    if (v.kind !== "bus") continue;
    BUS_WINDOWS.forEach((lx, k) => {
      part(ctx, cam, v, lx, WINDOW_TOP, WINDOW_W, WINDOW_H, LIGHTS.window);
      const off = busRider(v.seed, k);
      if (off !== null) rider(ctx, cam, v, k, off, LIGHTS.rider);
    });
    for (let i = 0; i < BOARD.n; i++) part(ctx, cam, v, BOARD.lx + 2 * i, BOARD.y, 1, 1, LIGHTS.board);
  }
}
