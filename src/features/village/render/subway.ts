/** The City's subway: `paintSubway` (backdrop pass), `paintSubwayLights` (night pass) and
 * `drawMetroEntrance` (the `metro` prop). Backdrop, not draw list: nothing stands in front, it runs
 * past the world's ends, and the train follows the FRAME clock. World-locked; decoration only. */

import { CAR_GAP, CAR_LEN, TRAIN_CARS, TRAIN_LEN, trainAt, type TrainState } from "../engine/subway";
import { TILE, type CitySubway, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { hash, onScreen, rect, sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** The line's colour (the train's stripe, the station's band, the signs) and its lit night shade. */
export const LINE = "#1f9e89";
export const LINE_LIT = "#62e3cc";

/** The tunnel's colours. Exported for the tests (they read the pieces back). */
export const TUNNEL = {
  /** Freshly dug soil round the tunnel and the stairwell (render/city.ts `CITY.dug`, as round the lounge). */
  dug: "#45301f",
  /** The concrete shell, and its outer edge against the soil. */
  lining: "#5b5e64",
  liningEdge: "#2c2e33",
  /** The dark back wall, its ring joints and the cable tray along it. */
  wall: "#24272d",
  joint: "#31353c",
  tray: "#15171b",
  /** The low wall along the track (a walkway's face). */
  walkway: "#2f333a",
  /** A lamp: its bracket and housing, the bulb, the pool it throws down the wall. */
  housing: "#17191d",
  bulb: "#ffd98a",
  pool: "rgba(255, 206, 128, 0.1)",
  /** The track bed: ballast, the sleepers' ends, the far rail, the near rail and its shine. */
  ballast: "#48423b",
  sleeper: "#2e2620",
  railFar: "#666e77",
  rail: "#a2aab3",
  railShine: "#d5dbe1",
} as const;

/** The station's colours. Exported for the tests. */
export const STATION = {
  /** Cream wall tiles, their grout lines, and the pillars at the hall's two ends. */
  wall: "#e4dcc8",
  grout: "#d2c8b1",
  pillar: "#8f8a80",
  /** The ceiling, a fluorescent tube's housing and the tube. */
  ceiling: "#cbc5b6",
  housing: "#8a867d",
  tube: "#fffbe6",
  /** The platform: its floor, the yellow edge line, its face over the track and the shadow under it. */
  floor: "#c9bfab",
  edge: "#f2c230",
  face: "#78726a",
  faceShadow: "#4d4944",
  /** The name plate: its frame, its face, its letters. */
  plateFrame: "#8f897d",
  plate: "#fbfaf5",
  letter: "#22262d",
  /** The bench on the platform. */
  bench: "#8a5a32",
  benchLeg: "#3b3f4a",
} as const;

/** The stairwell's colours. Exported for the tests. */
export const STAIRS = {
  /** Its concrete lining and its lit, tiled back wall. */
  lining: "#6e6a63",
  back: "#cfc6b2",
  /** A flight's treads, their shaded risers, the handrail; a lamp on the wall. */
  step: "#8f887b",
  riser: "#5e5951",
  rail: "#2e5d52",
  lamp: "#ffe6a8",
} as const;

/** The train's colours. Exported for the tests. */
export const TRAIN = {
  body: "#dde1e6",
  roof: "#98a0ab",
  skirt: "#b3bac3",
  /** The thin amber line under the teal stripe (`LINE`). */
  accent: "#f0a830",
  /** A window's frame, and its lit inside (underground the cars are always lit). */
  frame: "#4a5260",
  window: "#f6eed4",
  /** A rider's silhouette in a window. */
  rider: "#3d4553",
  /** A door leaf, its frame, and the lit inside seen through an open door (its floor below). */
  door: "#c9cfd6",
  doorFrame: "#7d8691",
  inside: "#efe5c9",
  insideFloor: "#7f7a70",
  /** The gangway between two cars, the bogies, the wheels and their hubs. */
  gangway: "#2a2d32",
  bogie: "#2b2e33",
  wheel: "#4a4e55",
  hub: "#8a8f96",
  /** The cab's windscreen at each end, the head lamp (leading) and the tail lamp (trailing). */
  windscreen: "#26303b",
  head: "#fff6d0",
  tail: "#ff4a3a",
} as const;

/** The street entrance's colours. Exported for the tests. */
export const METRO = {
  /** The stairwell's mouth, and its steps' nosings from the top step down. */
  mouth: "#1d2025",
  nosing: ["#8d8778", "#6d685d", "#4f4b44", "#36332f"],
  /** The railing round it. */
  railing: "#2e5d52",
  /** The sign's pole, and the sign by day and lit. */
  pole: "#3a3f47",
  sign: LINE,
  signLit: LINE_LIT,
  letter: "#ffffff",
  letterLit: "#fffef2",
} as const;

/** The night pass's light. Exported for the tests. */
export const GLOW = {
  lamp: "rgba(255, 196, 110, 0.13)",
  station: "rgba(255, 246, 222, 0.14)",
  stairs: "rgba(255, 236, 196, 0.22)",
  window: "rgba(255, 230, 170, 0.22)",
  beam: "rgba(255, 240, 190, 0.14)",
  tail: "rgba(255, 74, 58, 0.3)",
  sign: "rgba(98, 227, 204, 0.2)",
  mouth: "rgba(255, 228, 170, 0.14)",
} as const;

/** World px of dug soil round the tunnel and the stairwell (render/city.ts `DUG`). */
export const DUG = 3;
/** World px of the tunnel's concrete shell, top and bottom. */
export const SHELL = 4;
/** World px between two ring joints of the tunnel, and between two lamps (a lamp's x is `LAMP_PITCH·k + LAMP_PITCH/2`). */
export const RING = 32;
export const LAMP_PITCH = 128;
/** World px between two sleepers. */
export const SLEEPER_PITCH = 10;
/** World px of the station's ceiling under the tunnel's shell. */
export const CEILING = 5;
/** World px of the platform's height over the rail, and of its floor (the rest is its face). */
export const PLATFORM_H = 12;
const PLATFORM_FLOOR = 4;
/** World px of a stairwell flight's drop (four steps of 4). */
export const FLIGHT = 16;
/** Below this zoom the 1-px details — joints, sleepers, handrails, grout — are left out. */
export const DETAIL_ZOOM = 0.75;
/** World px the entrance's sign stands over its footprint's bottom (the prop cull reaches a tile above it). */
export const METRO_RISE = 31;

/** Pixel glyphs (rows of 1s), for the station's name plate and the signs. */
const GLYPH = {
  H: ["1001", "1001", "1111", "1001", "1001"],
  Q: ["0110", "1001", "1001", "1010", "0101"],
  A: ["010", "101", "111", "101", "101"],
  M: ["10001", "11011", "10101", "10001", "10001"],
} as const;

/** The station's name (two letters: the plate holds two glyphs) and its number badge's letter. */
export const STATION_NAME: readonly (keyof typeof GLYPH)[] = ["H", "Q"];
export const LINE_LETTER: keyof typeof GLYPH = "A";

/** Paint `glyph` at world (x, y) in `color`, a rect per run of 1s. */
function glyph(ctx: DrawTarget, cam: Camera, g: readonly string[], x: number, y: number, color: string): void {
  for (let dy = 0; dy < g.length; dy++) {
    const row = g[dy];
    for (let i = 0; i < row.length; ) {
      if (row[i] !== "1") {
        i++;
        continue;
      }
      let j = i;
      while (row[j] === "1") j++;
      rect(ctx, cam, x + i, y + dy, j - i, 1, color);
      i = j;
    }
  }
}

/** A disc `d` px across (odd) at world (x, y), as rows of runs. */
function disc(ctx: DrawTarget, cam: Camera, x: number, y: number, d: number, color: string): void {
  const r = (d - 1) / 2;
  for (let dy = 0; dy < d; dy++) {
    const half = Math.round(Math.sqrt((r + 0.5) ** 2 - (dy - r) ** 2) - 0.5);
    rect(ctx, cam, x + r - half, y + dy, 2 * half + 1, 1, color);
  }
}

/** A band of world rows [wy, wy + h) across the whole view, in screen space (it runs past the world's ends). */
function band(ctx: DrawTarget, cam: Camera, view: { w: number }, wy: number, h: number, color: string): void {
  const y = sy(cam, wy);
  ctx.fillStyle = color;
  ctx.fillRect(0, y, view.w, Math.max(1, sy(cam, wy + h) - y));
}

/** Fill a world-px rect in the CURRENT fillStyle, snapped like `rect` (the batches below set it once). */
function fill(ctx: DrawTarget, cam: Camera, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  ctx.fillRect(x, y, Math.max(1, sx(cam, wx + w) - x), Math.max(1, sy(cam, wy + h) - y));
}

/** World-px geometry, computed once per World: tunnel top/rail/bottom, station span [x0, x1),
 * stairwell box (under the entrance, sidewalk to platform), entrance left edge and bottom. */
export interface SubwayGeometry {
  sub: CitySubway;
  top: number;
  rail: number;
  bottom: number;
  station: { x0: number; x1: number };
  stairs: { x: number; y: number; w: number; h: number };
  entrance: { x: number; bottom: number };
}

const GEOMETRY = new WeakMap<World, SubwayGeometry | null>();

/** The subway's geometry in `world`, or null without one — built once per World (the frame allocates nothing for it). */
export function subwayGeometry(world: World): SubwayGeometry | null {
  const hit = GEOMETRY.get(world);
  if (hit !== undefined) return hit;
  const sub = world.city?.subway;
  let g: SubwayGeometry | null = null;
  if (sub) {
    const rail = (sub.rail + 1) * TILE;
    const y = (sub.entrance.row + 1) * TILE;
    g = {
      sub,
      top: sub.top * TILE,
      rail,
      bottom: (sub.bottom + 1) * TILE,
      station: { x0: sub.station.col0 * TILE, x1: sub.station.col1 * TILE },
      stairs: { x: sub.entrance.col * TILE, y, w: 2 * TILE, h: rail - PLATFORM_H - y },
      entrance: { x: sub.entrance.col * TILE, bottom: y },
    };
  }
  GEOMETRY.set(world, g);
  return g;
}

/** World x of the view's left and right edges (the tunnel is painted across all of it). */
const viewX0 = (cam: Camera): number => -Math.round(cam.ox) / cam.zoom;
const viewX1 = (cam: Camera, view: { w: number }): number => (view.w - Math.round(cam.ox)) / cam.zoom;

/** World x of tunnel lamp `k` (one every `LAMP_PITCH`, fixed in the world). */
const lampX = (k: number): number => (k + 0.5) * LAMP_PITCH;
/** The first lamp whose light reaches past world x (its light spans [x − LAMP_REACH, x + LAMP_REACH)). */
const firstLamp = (x: number): number => Math.floor((x - LAMP_REACH) / LAMP_PITCH - 0.5) + 1;
/** World px a tunnel lamp's light reaches either side of it (its night halo; its day pool is narrower). */
export const LAMP_REACH = 16;
/** Is the tunnel lamp at x clear of the station (which has its own lights)? The same rule by day and at night. */
const lampClear = (x: number, st: { x0: number; x1: number }): boolean => x + LAMP_REACH <= st.x0 || x - LAMP_REACH >= st.x1;

/** Tunnel, station, stairwell, track and the train running at `timeMs` (the frame's clock),
 * under the world; nothing in a world without a subway. */
export function paintSubway(ctx: DrawTarget, cam: Camera, world: World, view: { w: number; h: number }, timeMs: number): void {
  const g = subwayGeometry(world);
  if (!g) return;
  const tunnel = sy(cam, g.bottom + DUG) > 0 && sy(cam, g.top - DUG) < view.h;
  const fine = cam.zoom >= DETAIL_ZOOM;
  const x0 = viewX0(cam);
  const x1 = viewX1(cam, view);
  const st = g.station;
  if (tunnel) paintTunnel(ctx, cam, view, g, x0, x1, fine);
  if (onScreen(cam, view, st.x0, g.top, st.x1 - st.x0, g.bottom - g.top)) paintStation(ctx, cam, g, fine);
  const s = g.stairs;
  if (onScreen(cam, view, s.x - DUG, s.y, s.w + 2 * DUG, s.h)) paintStairwell(ctx, cam, g, fine);
  if (!tunnel) return;
  paintTrack(ctx, cam, view, g.rail, x0, x1, fine);
  const train = trainAt(g.sub, world.cols, timeMs);
  if (train) paintTrain(ctx, cam, view, g.rail, train);
}

/** The tube; no joints or lamps inside the station, which has its own wall and lights. */
function paintTunnel(ctx: DrawTarget, cam: Camera, view: { w: number }, g: SubwayGeometry, x0: number, x1: number, fine: boolean): void {
  const { top, rail, bottom, station: st } = g;
  const wall = top + SHELL;
  band(ctx, cam, view, top - DUG, DUG, TUNNEL.dug);
  band(ctx, cam, view, bottom, DUG, TUNNEL.dug);
  band(ctx, cam, view, top, SHELL, TUNNEL.lining);
  band(ctx, cam, view, top, 1, TUNNEL.liningEdge);
  band(ctx, cam, view, wall, rail - wall, TUNNEL.wall);
  band(ctx, cam, view, rail - 8, 8, TUNNEL.walkway);
  band(ctx, cam, view, wall + 6, 1, TUNNEL.tray);
  band(ctx, cam, view, rail, bottom - SHELL - rail, TUNNEL.ballast);
  band(ctx, cam, view, bottom - SHELL, SHELL, TUNNEL.lining);
  band(ctx, cam, view, bottom - 1, 1, TUNNEL.liningEdge);
  if (fine) {
    // Ring joints: where two of the tube's concrete rings meet, down the back wall to the walkway.
    ctx.fillStyle = TUNNEL.joint;
    for (let x = Math.floor(x0 / RING) * RING; x < x1; x += RING) if (x + 1 <= st.x0 || x >= st.x1) fill(ctx, cam, x, wall, 1, rail - 8 - wall);
  }
  // Lamps: a bracket and housing under the shell, the bulb, and a soft pool of light down the wall.
  for (let k = firstLamp(x0); lampX(k) - LAMP_REACH < x1; k++) {
    const x = lampX(k);
    if (!lampClear(x, st)) continue;
    rect(ctx, cam, x - 3, wall + 6, 7, 6, TUNNEL.pool);
    rect(ctx, cam, x - 6, wall + 6, 13, 16, TUNNEL.pool);
    rect(ctx, cam, x - 10, wall + 12, 21, 22, TUNNEL.pool);
    rect(ctx, cam, x, wall, 1, 3, TUNNEL.housing);
    rect(ctx, cam, x - 2, wall + 3, 5, 2, TUNNEL.housing);
    rect(ctx, cam, x - 1, wall + 5, 3, 1, TUNNEL.bulb);
  }
}

/** The track across the view: the sleepers' ends in the ballast, the far rail behind, the near rail the wheels run on. */
function paintTrack(ctx: DrawTarget, cam: Camera, view: { w: number }, rail: number, x0: number, x1: number, fine: boolean): void {
  if (fine) {
    ctx.fillStyle = TUNNEL.sleeper;
    for (let x = Math.floor(x0 / SLEEPER_PITCH) * SLEEPER_PITCH; x < x1; x += SLEEPER_PITCH) fill(ctx, cam, x, rail + 2, 6, 3);
  } else band(ctx, cam, view, rail + 2, 3, TUNNEL.sleeper);
  band(ctx, cam, view, rail - 3, 1, TUNNEL.railFar);
  band(ctx, cam, view, rail, 2, TUNNEL.rail);
  if (fine) band(ctx, cam, view, rail, 1, TUNNEL.railShine);
}

/** World px from the station's left edge to its first fluorescent tube, and between two. */
const TUBE_IN = 8;
const TUBE_PITCH = 32;

/** The station from `col0` to `col1`: tiled hall, name plate right of the stairs, bench left. */
function paintStation(ctx: DrawTarget, cam: Camera, g: SubwayGeometry, fine: boolean): void {
  const { x0, x1 } = g.station;
  const w = x1 - x0;
  const ceil = g.top + SHELL;
  const floor = g.rail - PLATFORM_H;
  rect(ctx, cam, x0, ceil, w, CEILING, STATION.ceiling);
  rect(ctx, cam, x0, ceil + CEILING, w, floor - ceil - CEILING, STATION.wall);
  if (fine) {
    ctx.fillStyle = STATION.grout;
    for (let y = ceil + CEILING + 6; y < floor; y += 6) fill(ctx, cam, x0, y, w, 1);
  }
  // The line's stripe along the hall, just over the roof of a train standing in it.
  rect(ctx, cam, x0, g.rail - CAR_H - 4, w, 3, LINE);
  for (let x = x0 + TUBE_IN; x + 16 <= x1 - 4; x += TUBE_PITCH) {
    rect(ctx, cam, x, ceil + 2, 16, 2, STATION.housing);
    rect(ctx, cam, x + 1, ceil + 4, 14, 1, STATION.tube);
  }
  rect(ctx, cam, x0, ceil, 3, floor - ceil, STATION.pillar);
  rect(ctx, cam, x1 - 3, ceil, 3, floor - ceil, STATION.pillar);
  // The platform: its floor, the yellow line along its edge, its face down to the track.
  rect(ctx, cam, x0, floor, w, PLATFORM_FLOOR, STATION.floor);
  rect(ctx, cam, x0, floor + PLATFORM_FLOOR - 1, w, 1, STATION.edge);
  rect(ctx, cam, x0, floor + PLATFORM_FLOOR, w, PLATFORM_H - PLATFORM_FLOOR, STATION.face);
  rect(ctx, cam, x0, g.rail - 1, w, 1, STATION.faceShadow);
  // The bench, centred on the platform left of the stairs; the name plate right of them.
  const stairs = g.stairs.x;
  bench(ctx, cam, Math.round((x0 + stairs) / 2) - 7, floor);
  namePlate(ctx, cam, Math.round((stairs + g.stairs.w + x1) / 2) - 13, ceil + CEILING);
}

/** The platform's bench, 14 px wide from x, standing on the platform's floor line. */
function bench(ctx: DrawTarget, cam: Camera, x: number, floor: number): void {
  rect(ctx, cam, x + 1, floor - 5, 1, 5, STATION.benchLeg);
  rect(ctx, cam, x + 12, floor - 5, 1, 5, STATION.benchLeg);
  rect(ctx, cam, x, floor - 12, 14, 3, STATION.bench);
  rect(ctx, cam, x, floor - 7, 14, 2, STATION.bench);
}

/** The 26 × 13 name plate at (x, p), under the ceiling and over a stopped train's roof, so it
 * reads with one standing there. */
function namePlate(ctx: DrawTarget, cam: Camera, x: number, p: number): void {
  rect(ctx, cam, x, p, 26, 13, STATION.plateFrame);
  rect(ctx, cam, x + 1, p + 1, 24, 11, STATION.plate);
  disc(ctx, cam, x + 2, p + 2, 9, LINE);
  disc(ctx, cam, x + 3, p + 3, 7, STATION.plate);
  glyph(ctx, cam, GLYPH[LINE_LETTER], x + 5, p + 4, LINE);
  for (let i = 0; i < STATION_NAME.length; i++) glyph(ctx, cam, GLYPH[STATION_NAME[i]], x + 13 + 5 * i, p + 4, STATION.letter);
}

/** The stairwell under the entrance: switchback flights of four steps (`FLIGHT` px down each)
 * from the platform up to the sidewalk, a wall lamp every fourth flight. */
function paintStairwell(ctx: DrawTarget, cam: Camera, g: SubwayGeometry, fine: boolean): void {
  const { x, y, w, h } = g.stairs;
  rect(ctx, cam, x - DUG, y, w + 2 * DUG, g.top - DUG - y, TUNNEL.dug);
  rect(ctx, cam, x, y, w, h, STAIRS.lining);
  rect(ctx, cam, x + 2, y, w - 4, h, STAIRS.back);
  const floor = y + h;
  // From the top flight down, so each flight is drawn over the foot of the slab above it.
  for (let k = Math.floor(h / FLIGHT) - 1; k >= 0; k--) {
    const yb = floor - k * FLIGHT;
    // Even flights (the lowest is 0) come down to the left, odd ones to the right: a slab of four steps
    // (6 × 4 each) in section — the steps' saw-tooth on top, the slab under them, never into the platform.
    const right = k % 2 === 1;
    for (let i = 0; i < 4; i++) {
      const x0 = right ? x + 4 + 6 * i : x + w - 10 - 6 * i;
      const tread = yb - FLIGHT + 4 * i + 3;
      rect(ctx, cam, x0, tread, 6, Math.min(7, floor - tread), STAIRS.riser);
      rect(ctx, cam, x0, tread, 6, 1, STAIRS.step);
      if (fine) rect(ctx, cam, x0, tread - 7, 6, 1, STAIRS.rail);
    }
    if (k % 4 === 2) rect(ctx, cam, x + w / 2 - 1, yb - FLIGHT - 2, 3, 2, STAIRS.lamp);
  }
}

/** A car's shape (world px, 62 long): its height clears a 32-px sprite in the door and the tunnel
 * lamps; window x offsets (7 px wide), doors (8 px), bogies and wheels. */
export const CAR_H = 38;
export const CAR_WINDOWS = [3, 24, 33, 54] as const;
export const CAR_DOORS = [13, 43] as const;
const BOGIES = [8, 44] as const;
const WHEELS = [0, 6] as const;

/** The train at `t` on the rail line `rail`: each car on screen, and the gangway before each but the first. */
function paintTrain(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, rail: number, t: TrainState): void {
  const left = t.x - TRAIN_LEN / 2;
  for (let i = 0; i < TRAIN_CARS; i++) {
    const c0 = left + i * (CAR_LEN + CAR_GAP);
    if (!onScreen(cam, view, c0 - CAR_GAP, rail - CAR_H, CAR_LEN + CAR_GAP, CAR_H)) continue;
    if (i > 0) rect(ctx, cam, c0 - CAR_GAP, rail - 34, CAR_GAP, 26, TRAIN.gangway);
    paintCar(ctx, cam, c0, rail, t, i);
  }
}

/** Does window `w` of car `car` hold a rider on run `riders`? About half of them do. */
export function riderIn(riders: number, car: number, w: number): boolean {
  return hash(riders, car * 8 + w, 37) % 2 === 0;
}

/** Car `i` of the train at `t`, from c0: body, roof, the line's stripe, windows (riders in them), doors, cab ends, bogies. */
function paintCar(ctx: DrawTarget, cam: Camera, c0: number, rail: number, t: TrainState, i: number): void {
  rect(ctx, cam, c0, rail - CAR_H + 1, CAR_LEN, CAR_H - 6, TRAIN.body);
  rect(ctx, cam, c0 + 1, rail - CAR_H, CAR_LEN - 2, 2, TRAIN.roof);
  rect(ctx, cam, c0, rail - 9, CAR_LEN, 4, TRAIN.skirt);
  rect(ctx, cam, c0, rail - 18, CAR_LEN, 3, LINE);
  rect(ctx, cam, c0, rail - 15, CAR_LEN, 1, TRAIN.accent);
  for (let w = 0; w < CAR_WINDOWS.length; w++) {
    const wx = c0 + CAR_WINDOWS[w];
    rect(ctx, cam, wx, rail - 31, 7, 10, TRAIN.frame);
    rect(ctx, cam, wx + 1, rail - 30, 5, 8, TRAIN.window);
    if (riderIn(t.riders, i, w)) rider(ctx, cam, wx + 1, rail - 22);
  }
  const gap = Math.round(4 * t.doors);
  for (const dx of CAR_DOORS) {
    const d = c0 + dx;
    rect(ctx, cam, d - 1, rail - 35, 10, 30, TRAIN.doorFrame);
    if (gap === 0) {
      // Shut: two leaves meeting at a seam, a narrow window in each.
      rect(ctx, cam, d, rail - 34, 8, 28, TRAIN.door);
      rect(ctx, cam, d + 4, rail - 34, 1, 28, TRAIN.doorFrame);
      rect(ctx, cam, d + 1, rail - 31, 2, 9, TRAIN.window);
      rect(ctx, cam, d + 6, rail - 31, 2, 9, TRAIN.window);
      continue;
    }
    // Opening: the lit inside and its floor, and each leaf sliding into its pocket in the body — only
    // the part still in the doorway shows.
    rect(ctx, cam, d, rail - 34, 8, 28, TRAIN.inside);
    rect(ctx, cam, d, rail - 8, 8, 2, TRAIN.insideFloor);
    if (gap < 4) {
      rect(ctx, cam, d, rail - 34, 4 - gap, 28, TRAIN.door);
      rect(ctx, cam, d + 4 + gap, rail - 34, 4 - gap, 28, TRAIN.door);
    }
  }
  // The cabs: a windscreen at the train's two ends; the head lamp leads, the tail lamp trails.
  if (i === 0 || i === TRAIN_CARS - 1) {
    // The west end is the first car's left; it leads westbound (and the east end eastbound).
    const west = i === 0;
    const leading = west === (t.dir < 0);
    rect(ctx, cam, west ? c0 : c0 + CAR_LEN - 3, rail - 33, 3, 12, TRAIN.windscreen);
    rect(ctx, cam, west ? c0 : c0 + CAR_LEN - 2, rail - 13, 2, 2, leading ? TRAIN.head : TRAIN.tail);
  }
  for (const bx of BOGIES) {
    rect(ctx, cam, c0 + bx, rail - 6, 10, 2, TRAIN.bogie);
    for (const wx of WHEELS) {
      rect(ctx, cam, c0 + bx + wx, rail - 4, 4, 4, TRAIN.wheel);
      rect(ctx, cam, c0 + bx + wx + 1, rail - 3, 2, 2, TRAIN.hub);
    }
  }
}

/** A rider's silhouette, its shoulders' bottom-left at (x, y): a head over a pair of shoulders. */
function rider(ctx: DrawTarget, cam: Camera, x: number, y: number): void {
  rect(ctx, cam, x + 1, y - 6, 3, 3, TRAIN.rider);
  rect(ctx, cam, x, y - 3, 5, 3, TRAIN.rider);
}

// ───────────────────────────── the night ─────────────────────────────

/** Night-pass lights after the grade: entrance glow, stairwell, lamp halos, station tubes, and the
 * train's windows re-lit over the grade (nothing passes in front underground) and its lamps. */
export function paintSubwayLights(ctx: DrawTarget, cam: Camera, world: World, view: { w: number; h: number }, timeMs: number): void {
  const g = subwayGeometry(world);
  if (!g) return;
  const { top, rail, bottom, station: st, stairs: s, entrance: e } = g;
  if (onScreen(cam, view, ...metroGlowBox(e.x, e.bottom))) metroGlow(ctx, cam, e.x, e.bottom);
  if (onScreen(cam, view, s.x, s.y, s.w, s.h)) rect(ctx, cam, s.x + 2, s.y, s.w - 4, s.h, GLOW.stairs);
  if (sy(cam, bottom) <= 0 || sy(cam, top) >= view.h) return;
  const wall = top + SHELL;
  const roof = rail - CAR_H;
  const t = trainAt(g.sub, world.cols, timeMs);
  const x1 = viewX1(cam, view);
  for (let k = firstLamp(viewX0(cam)); lampX(k) - LAMP_REACH < x1; k++) {
    const x = lampX(k);
    if (!lampClear(x, st)) continue;
    // A warm halo round the lamp, brightest at the bulb (the layers overlap there) — over the roof line
    // of a passing train, never on it.
    rect(ctx, cam, x - 4, wall + 2, 9, 7, GLOW.lamp);
    rect(ctx, cam, x - 9, wall + 4, 19, 12, GLOW.lamp);
    rect(ctx, cam, x - LAMP_REACH, wall + 8, 2 * LAMP_REACH, roof - wall - 8, GLOW.lamp);
    rect(ctx, cam, x - 1, wall + 5, 3, 1, TUNNEL.bulb);
  }
  if (onScreen(cam, view, st.x0, top, st.x1 - st.x0, bottom - top)) {
    // The station's tubes, and the light they throw over the hall: above a train's roof line all along
    // it, below it only where no train stands (a train is lit by its own windows, as in the tunnel).
    for (let x = st.x0 + TUBE_IN; x + 16 <= st.x1 - 4; x += TUBE_PITCH) rect(ctx, cam, x + 1, wall + 4, 14, 1, STATION.tube);
    rect(ctx, cam, st.x0, wall, st.x1 - st.x0, roof - wall, GLOW.station);
    const l = t ? Math.max(st.x0, Math.min(st.x1, Math.round(t.x - TRAIN_LEN / 2))) : st.x1;
    const r = t ? Math.max(st.x0, Math.min(st.x1, Math.round(t.x + TRAIN_LEN / 2))) : st.x1;
    if (l > st.x0) rect(ctx, cam, st.x0, roof, l - st.x0, rail - roof, GLOW.station);
    if (r < st.x1) rect(ctx, cam, r, roof, st.x1 - r, rail - roof, GLOW.station);
  }
  if (t) trainLights(ctx, cam, view, rail, t);
}

/** The train's lights at night: a glow round each window, lit windows (their riders over them) and open doorways, the lamps' beams. */
function trainLights(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, rail: number, t: TrainState): void {
  const left = t.x - TRAIN_LEN / 2;
  const gap = Math.round(4 * t.doors);
  for (let i = 0; i < TRAIN_CARS; i++) {
    const c0 = left + i * (CAR_LEN + CAR_GAP);
    if (!onScreen(cam, view, c0 - 1, rail - 35, CAR_LEN + 2, 29)) continue;
    for (let w = 0; w < CAR_WINDOWS.length; w++) {
      const wx = c0 + CAR_WINDOWS[w];
      rect(ctx, cam, wx - 2, rail - 33, 11, 14, GLOW.window);
      rect(ctx, cam, wx + 1, rail - 30, 5, 8, TRAIN.window);
      if (riderIn(t.riders, i, w)) rider(ctx, cam, wx + 1, rail - 22);
    }
    if (gap > 0) for (const dx of CAR_DOORS) rect(ctx, cam, c0 + dx + 4 - gap, rail - 34, 2 * gap, 26, TRAIN.inside);
  }
  // The head lamp's beam along the track ahead; the tail lamp's red glow behind.
  const east = t.dir > 0;
  const head = east ? left + TRAIN_LEN : left;
  const tail = east ? left : left + TRAIN_LEN;
  const beam = east ? head : head - BEAM;
  // A cone widening ahead of the lamp (three overlapping layers, brightest at the lamp).
  if (onScreen(cam, view, beam, rail - 19, BEAM, 16)) {
    for (let k = 1; k <= 3; k++) {
      const len = (BEAM * k) / 3;
      rect(ctx, cam, east ? head : head - len, rail - 13 - 2 * k, len, 2 + 4 * k, GLOW.beam);
    }
  }
  if (onScreen(cam, view, tail - 6, rail - 16, 12, 8)) rect(ctx, cam, tail - 6, rail - 16, 12, 8, GLOW.tail);
}

/** World px the head lamp's beam reaches ahead of the train. */
export const BEAM = 40;

// ───────────────────────────── the street entrance ─────────────────────────────

/** The `metro` prop (2 × 1, far sidewalk) at (x0, bottom); `lit` lights the sign. Paints inside
 * its two tiles and up to `METRO_RISE` px over their bottom. */
export function drawMetroEntrance(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, lit: boolean): void {
  rect(ctx, cam, x0 + 2, bottom - 13, 25, 12, METRO.mouth);
  for (let i = 0; i < METRO.nosing.length; i++) rect(ctx, cam, x0 + 4, bottom - 12 + 3 * i, 21, 1, METRO.nosing[i]);
  // The railing: a top rail and a mid rail across the back, posts down to the sidewalk at both ends.
  rect(ctx, cam, x0 + 1, bottom - 20, 28, 1, METRO.railing);
  rect(ctx, cam, x0 + 1, bottom - 16, 28, 1, METRO.railing);
  rect(ctx, cam, x0 + 10, bottom - 20, 1, 7, METRO.railing);
  rect(ctx, cam, x0 + 19, bottom - 20, 1, 7, METRO.railing);
  rect(ctx, cam, x0 + 1, bottom - 20, 1, 18, METRO.railing);
  rect(ctx, cam, x0 + 28, bottom - 20, 1, 18, METRO.railing);
  // The sign: a pole from the sidewalk, and the rounded teal square with the "M".
  rect(ctx, cam, x0 + 30, bottom - 22, 1, 21, METRO.pole);
  const s = x0 + 23;
  const top = bottom - METRO_RISE;
  const face = lit ? METRO.signLit : METRO.sign;
  rect(ctx, cam, s + 1, top, 7, 9, face);
  rect(ctx, cam, s, top + 1, 9, 7, face);
  glyph(ctx, cam, GLYPH.M, s + 2, top + 2, lit ? METRO.letterLit : METRO.letter);
}

/** World box [x, y, w, h] of everything `metroGlow` paints, for an `onScreen` cull. */
export function metroGlowBox(x0: number, bottom: number): [number, number, number, number] {
  return [x0, bottom - METRO_RISE - 4, 2 * TILE + 4, METRO_RISE + 6];
}

/** The entrance at night: the sign's teal glow round it, and warm light welling up out of the stairwell's mouth. */
export function metroGlow(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  rect(ctx, cam, x0 + 20, bottom - METRO_RISE - 4, 15, 17, GLOW.sign);
  rect(ctx, cam, x0, bottom - 18, 30, 20, GLOW.mouth);
}
