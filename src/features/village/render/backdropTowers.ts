/** The HIGH backdrop layer (render/backdrop.ts): few, BIG towers out of the haze, world-locked in
 * fixed `CHUNK`s, capped under the Skytree (`capOf`) and Fuji's snow cap (`roofLimit`), plus one
 * signature tower behind the tallest building. Night stays calm: sparse windows, the dimmest. */

import { CITY_DAY, citySky } from "../engine/ambience";
import { TILE, type Ambience, type CityBuilding, type CityInfo, type WeatherKind, type World } from "../villageTypes";
import { airSpans, roofLimit, type BackdropLayer, type BackdropLightScene, type BackdropScene } from "./backdrop";
import type { Camera } from "./camera";
import { AVIATION, aviationOn, BLINK_MS, landmarksFor, placeLandmarks, referenceHeight } from "./landmarks";
import { hash, sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";
import { skylineMax } from "./skyline";

// ───────────────────────────── the look ─────────────────────────────

/** The six silhouettes. */
export const TOWER_KINDS = ["slab", "setback", "twin", "slant", "helipad", "mast"] as const;
export type TowerKind = (typeof TOWER_KINDS)[number];

/** One tint of glass tower, DAY colours: its frame (the outline, mullions, floor lines), glass panes, sun-side edge and crown. */
export interface TowerTint {
  frame: string;
  glass: string;
  edge: string;
  crown: string;
}

/** DAY colours: three blue-grey glass tints, farthest (lightest, bluest) first; nearer towers take
 * darker ones. Lighter than the world's buildings, darker than the sky; the grade does night. */
export const TOWER = {
  tints: [
    { frame: "#a8bace", glass: "#8ea5be", edge: "#c3d1e0", crown: "#98abc1" },
    { frame: "#9aaec4", glass: "#8099b4", edge: "#b7c8da", crown: "#8b9fb7" },
    { frame: "#a0afc1", glass: "#8696ad", edge: "#bdc9d6", crown: "#909fb2" },
  ] as readonly TowerTint[],
  /** An antenna mast, a tank's legs and hoops. */
  mast: "#768598",
  /** A water tank. */
  tank: "#b0bccb",
  /** A helipad's deck and its "H". */
  pad: "#e2e8ef",
  /** The dark panel the "H" is painted on. */
  panel: "#6f8299",
} as const;

/** The night's lights (painted after the grade). */
export const TOWER_LIT = {
  /** A lit window: a dim warm mostly, some cool white — nothing glaring (the calm pass). */
  warm: "#e6cf98",
  cool: "#d8e2f0",
  /** A crown band, faint: cool white or pale blue. */
  crown: ["#f2f7ff", "#bfe2ff"],
} as const;

/** One window every `WINDOW` px across a floor, a 2×2-px light; `WINDOWS_LIT` of the skyline's
 * `lit` (an eighth at full night), alpha 0.35–0.55: the farthest, dimmest layer. */
const WINDOW = 9;
const WINDOWS_LIT = 0.3;
/** A floor's occupancy, ×the mean share, by a hash of the floor: three floors in ten dark, the rest 0.8–2.2× (the mean is 1). */
const BUSY = [0, 0, 0, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2.2] as const;

/** A frame's colours: the three tints and the fixed inks. */
type Palette = { tints: readonly TowerTint[] } & Record<Exclude<Ink, "crown" | "frame">, string>;

const rgbOf = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** DAY colours scaled per channel as the haze's colour is now vs its day colour, so the towers turn
 * with the haze they stand in (exactly `TOWER` by day). No channel passes 255; the tests sweep the
 * clock in every weather. */
function paletteOf(amb: Ambience | undefined): Palette {
  const look = citySky(amb);
  const day = rgbOf(CITY_DAY.skyline);
  const k = rgbOf(look.skyline.block).map((v, i) => v / day[i]);
  const scale = (c: string): string =>
    `#${rgbOf(c)
      .map((v, i) => Math.round(v * k[i]).toString(16).padStart(2, "0"))
      .join("")}`;
  return {
    tints: TOWER.tints.map((t) => ({ frame: scale(t.frame), glass: scale(t.glass), edge: scale(t.edge), crown: scale(t.crown) })),
    mast: scale(TOWER.mast),
    tank: scale(TOWER.tank),
    pad: scale(TOWER.pad),
    panel: scale(TOWER.panel),
  };
}

/** How much of the layer shows through each weather: landmarks.ts's `SEEN` for its "tower" layer (not exported there; the same numbers — keep them in step). */
const SEEN: Record<WeatherKind, number> = { clear: 1, cloudy: 1, drizzle: 0.9, snow: 0.85, rain: 0.8, fog: 0.5, storm: 0.7 };

/** Below this zoom a pane column is under 2 screen px: the columns go, every other floor line stays (render/city.ts's PANE_ZOOM). */
const PANE_ZOOM = 0.75;

// ───────────────────────────── the layout ─────────────────────────────

/** World px of a layout chunk: one cluster each. */
export const CHUNK = 26 * TILE;
/** World px of sky a cluster keeps from either end of its chunk: two clusters stand ≥ 2·MARGIN apart. */
export const MARGIN = 2 * TILE;
/** How many towers a chunk's cluster holds (by hash): mostly two or three, now and then none — open sky. */
const COUNTS = [0, 0, 1, 1, 1, 1, 2, 2] as const;
/** World px from one tower to the next in a cluster: negative = overlapping, one in front of the other. */
const GAPS = [-22, -14, -8, 2, 3, 5, 8] as const;
/** Heights vs the world's TALLEST building: a cluster's tallest is 1.3–1.8× (whole hundredths);
 * every tower also keeps the haze clearance. */
const TALL_MIN = 130; // percent
const TALL_STEPS = 51; // 130, 131 … 180 %
export const CLEAR = 2 * TILE;
/** SIGNATURE skyscraper behind the tallest building: `SIGNATURE_H` of its height, `SIGNATURE_W` of
 * its width (≥ 5 tiles), centred; a cluster tower within `SIGNATURE_SKY` of it is left out. */
const SIGNATURE_H = 1.8;
const SIGNATURE_W = 0.55;
const SIGNATURE_KINDS = ["twin", "setback", "mast"] as const;
const SIGNATURE_SKY = 4 * TILE;
/** No tower — its mast or tank included — stands taller than this share of the city's Skytree. */
const UNDER_SKYTREE = 0.9;
/** A column's pitch and a floor's (world px), and how tall its floor line is, per grid style. */
const GRIDS: readonly (readonly [col: number, floor: number, line: number])[] = [
  [3, 6, 1], // a fine grid
  [3, 8, 1], // vertical fins: tall panes, floors far apart
  [9, 6, 2], // ribbon windows: bands of glass under deep spandrels
];

/** A column of a silhouette: x0 ≤ x < x1, from `top` down to the horizon. */
export type Part = readonly [x0: number, x1: number, top: number];
/** A stretch [x0, x1) of a tower: its glass grid starts at y `glass`, what stands in front at y
 * `cover` (horizon: nothing), and `open` if in the backdrop's open sky (no haze in front). */
export type Cell = readonly [x0: number, x1: number, glass: number, cover: number, open: boolean];
/** What a day detail is painted in: the tower's own frame or crown tint, or one of `TOWER`'s fixed colours. */
type Ink = "frame" | "crown" | "mast" | "tank" | "pad" | "panel";
/** A world-px rect [x, y, w, h]. */
type Rect = readonly [x: number, y: number, w: number, h: number];

/** One high-rise, where it stands. */
export interface Tower {
  kind: TowerKind;
  /** Its width: x0 ≤ x < x + w. */
  x: number;
  w: number;
  /** Its roof's y (a mast, a tank, a deck's rail stand above it), and the y its floors count from: the highest glass. */
  roof: number;
  top: number;
  /** The whole silhouette, disjoint, left to right. */
  parts: readonly Part[];
  /** Where its glass grid starts, across its whole width (contiguous, left to right). */
  glass: readonly Part[];
  /** What stands in front across its width (contiguous): a nearer cluster tower, a world building,
   * or nothing (the horizon). Nothing of the tower below it is painted or lit. */
  cover: readonly Part[];
  /** `glass` and `cover` together: what the grid and the lights go by. */
  cells: readonly Cell[];
  tint: number;
  grid: number;
  seed: number;
  /** Its highest point, world y (a mast's tip, a tank's lid…). */
  peak: number;
  /** Day details over the silhouette: [x, y, w, h, ink]. */
  marks: readonly (readonly [x: number, y: number, w: number, h: number, ink: Ink])[];
  /** The crown band (null: none on this tower), and whether it is lit at night — a faint band on a few. */
  crown: Rect | null;
  crowned: boolean;
  /** Aviation lights: their centres. */
  beacons: readonly (readonly [x: number, y: number])[];
}

/** The outline of overlapping parts: per column the highest top, as disjoint parts left to right. */
export function envelope(parts: readonly Part[]): Part[] {
  const xs = [...new Set(parts.flatMap(([a, b]) => [a, b]))].sort((p, q) => p - q);
  const out: [number, number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    let top = Infinity;
    for (const [a, b, t] of parts) if (a <= xs[i] && b > xs[i]) top = Math.min(top, t);
    if (top === Infinity) continue;
    const last = out[out.length - 1];
    if (last && last[1] === xs[i] && last[2] === top) last[1] = xs[i + 1];
    else out.push([xs[i], xs[i + 1], top]);
  }
  return out;
}

/** Glass and cover cut at both's breaks and the open-sky edges (`air`): one Cell per stretch. */
function cellsOf(glass: readonly Part[], cover: readonly Part[], air: readonly (readonly [number, number])[]): Cell[] {
  const edges = air.flatMap(([a, b]) => [a, b]);
  const out: Cell[] = [];
  for (let i = 0, j = 0; i < glass.length && j < cover.length; ) {
    const x0 = Math.max(glass[i][0], cover[j][0]);
    const x1 = Math.min(glass[i][1], cover[j][1]);
    const cuts = [x0, ...edges.filter((e) => e > x0 && e < x1), x1];
    for (let k = 0; k + 1 < cuts.length; k++) out.push([cuts[k], cuts[k + 1], glass[i][2], cover[j][2], air.some(([a, b]) => cuts[k] >= a && cuts[k] < b)]);
    if (glass[i][1] === x1) i++;
    if (cover[j][1] === x1) j++;
  }
  return out;
}

type Shape = Omit<Tower, "kind" | "cover" | "cells" | "tint" | "grid" | "seed" | "crowned">;

/** A tower of `kind` over x .. x + w, roof `h` above the horizon: silhouette, glass, day marks,
 * crown band and beacons; `hh` picks variants. */
function shape(kind: TowerKind, x: number, w: number, h: number, horizon: number, hh: number): Shape {
  const roof = horizon - h;
  const parts: Part[] = [];
  const marks: [number, number, number, number, Ink][] = [];
  const beacons: [number, number][] = [[x + 2, roof], [x + w - 3, roof]];
  let glass: Part[] = [[x, x + w, roof + 2]];
  let crown: Rect | null = [x + 1, roof + 2, w - 2, 2];
  const c = Math.round(h * 0.12); // a crown's height (≥ 10 px: a tower is ≥ 80 px tall)
  const base = roof + c; // where a crown sits on its shaft
  if (kind === "slab") {
    parts.push([x, x + w, roof]);
    marks.push([x, roof, w, 2, "frame"]);
    // A plant room or a water tank on the roof, off-centre.
    const bw = Math.round(w * (0.2 + ((hh >>> 5) % 20) / 100));
    const bx = x + 2 + ((hh >>> 9) % (w - bw - 3));
    if ((hh >>> 3) % 2 === 0) {
      parts.push([bx, bx + bw, roof - 4]);
      marks.push([bx, roof - 4, bw, 4, "crown"]);
    } else {
      // A water tank on legs: its body and a hoop, the legs' shadow under it.
      const tw = Math.min(bw, 10);
      parts.push([bx, bx + tw, roof - 7]);
      marks.push([bx, roof - 7, tw, 5, "tank"], [bx, roof - 5, tw, 1, "mast"], [bx + 1, roof - 2, tw - 2, 2, "mast"]);
    }
  } else if (kind === "setback") {
    // Two or three solid steps in from both sides — the machine floors — on a glass shaft.
    const n = 2 + ((hh >>> 3) % 2);
    const inset = Math.round(w / (2 * n + 3)); // ≥ 5 px: a tower is ≥ 48 px wide
    parts.push([x, x + w, base]);
    for (let k = 1; k <= n; k++) {
      const y = base - Math.round((c * k) / n);
      parts.push([x + k * inset, x + w - k * inset, y]);
      marks.push([x + k * inset, y, w - 2 * k * inset, Math.round(c / n), "crown"]);
    }
    marks.push([x, base, w, 2, "frame"]);
    glass = [[x, x + w, base + 2]];
    beacons.splice(0, 2, [x + n * inset + 2, roof], [x + w - n * inset - 3, roof]);
    crown = [x + inset, base - Math.round(c / n) + 1, w - 2 * inset, 2];
  } else if (kind === "twin") {
    // The shaft splits into two glass towers, a notch of sky between them (the Metropolitan Government Building).
    const tw = Math.round(w * 0.36);
    parts.push([x, x + w, base], [x, x + tw, roof], [x + w - tw, x + w, roof]);
    marks.push([x, roof, tw, 3, "crown"], [x + w - tw, roof, tw, 3, "crown"], [x + tw, base, w - 2 * tw, 2, "frame"]);
    glass = [[x, x + tw, roof + 3], [x + tw, x + w - tw, base + 2], [x + w - tw, x + w, roof + 3]];
    beacons.splice(0, 2, [x + (tw >> 1), roof], [x + w - tw + (tw >> 1), roof]);
    crown = [x + 1, base - 3, w - 2, 2];
  } else if (kind === "slant") {
    // The roof falls one way across the shaft in 2-px steps, the glass running up into it.
    const rise = c + (hh % 2) * Math.round(c / 2);
    const left = (hh >>> 3) % 2 === 0;
    const top = roof + rise;
    glass = [];
    for (let d = 0; d < w; d += 2) {
      const y = top - Math.round((rise * (left ? w - d : d + 2)) / w);
      parts.push([x + d, Math.min(x + w, x + d + 2), y]);
      glass.push([x + d, Math.min(x + w, x + d + 2), y + 1]);
    }
    beacons.splice(0, 2, left ? [x + 2, roof] : [x + w - 3, roof]);
    crown = [x + 1, top + 1, w - 2, 2];
  } else if (kind === "helipad") {
    // A pale deck on the roof, and a pale "H" on a dark panel on the crown's face under it.
    parts.push([x, x + w, roof + 2], [x + 1, x + w - 1, roof]);
    const hx = x + (w >> 1) - 3;
    marks.push(
      [x + 1, roof, w - 2, 2, "pad"],
      [x, roof + 2, w, 2, "frame"],
      [hx - 1, roof + 4, 7, 7, "panel"],
      [hx, roof + 5, 1, 5, "pad"],
      [hx + 4, roof + 5, 1, 5, "pad"],
      [hx + 1, roof + 7, 3, 1, "pad"],
    );
    glass = [[x, x + w, roof + 4]];
    crown = [x + 1, roof + 2, w - 2, 1];
  } else {
    // An antenna mast: a 3-px foot, a 1-px mast, a red light at its tip.
    const m = Math.round(h * (0.08 + ((hh >>> 3) % 6) / 100));
    const mx = x + Math.round(w * (0.3 + ((hh >>> 7) % 5) / 10));
    parts.push([x, x + w, roof], [mx - 1, mx + 2, roof - 4], [mx, mx + 1, roof - m]);
    marks.push([x, roof, w, 2, "frame"], [mx - 1, roof - 4, 3, 4, "mast"], [mx, roof - m, 1, m - 4, "mast"]);
    beacons.push([mx, roof - m]);
    crown = null;
  }
  const outline = envelope(parts);
  return {
    x,
    w,
    roof,
    top: Math.min(...glass.map((g) => g[2])),
    parts: outline,
    glass: envelope(glass),
    peak: Math.min(...outline.map((p) => p[2])),
    marks,
    crown,
    beacons,
  };
}

interface Layout {
  horizon: number;
  zone: string | undefined;
  /** The skyscraper behind the tallest building (null: none — no building, or Fuji's cap in the way). */
  signature: Tower | null;
  /** The tallest a tower may stand, tip and all (`capOf`). */
  cap: number;
  chunks: Map<number, readonly Tower[]>;
}

const LAYOUTS = new WeakMap<World, Layout>();

/** The layout of `world` for this horizon and zone (built once, its chunks as they are asked for). */
function layoutOf(world: World, amb: Ambience | undefined, horizon: number): Layout {
  let l = LAYOUTS.get(world);
  if (!l || l.horizon !== horizon || l.zone !== amb?.zone) {
    const cap = capOf(world, amb, horizon);
    l = { horizon, zone: amb?.zone, signature: signatureOf(world, amb, horizon, cap), cap, chunks: new Map() };
    LAYOUTS.set(world, l);
  }
  return l;
}

/** The towers of chunk `k`, back to front (built once per World, horizon and zone). */
function chunkTowers(world: World, amb: Ambience | undefined, horizon: number, k: number): readonly Tower[] {
  const l = layoutOf(world, amb, horizon);
  let out = l.chunks.get(k);
  if (!out) {
    out = buildChunk(world, amb, horizon, k, l.signature, l.cap);
    l.chunks.set(k, out);
  }
  return out;
}

/** Tallest tip allowed here: `UNDER_SKYTREE` of the city's Skytree as render/landmarks.ts places
 * it (read, never assumed); no Skytree, no cap. */
function capOf(world: World, amb: Ambience | undefined, horizon: number): number {
  const skytree = placeLandmarks(world, horizon, landmarksFor(amb?.zone)).placed.find((p) => p.spec.kind === "skytree");
  return skytree ? Math.floor(UNDER_SKYTREE * skytree.h) : Infinity;
}

/** Height for `share` × `base` under `cap`: if the rule's tallest (1.8 × base) would exceed the
 * cap, the whole range is scaled into it, keeping spread and order, not one flat roofline. */
function heightOf(share: number, base: number, cap: number): number {
  const hi = ((TALL_MIN + TALL_STEPS - 1) / 100) * base;
  if (hi <= cap) return Math.round(share * base);
  const lo = 0.62 * (TALL_MIN / 100) * base;
  const floor = Math.min(lo, 0.85 * cap);
  return Math.round(floor + ((share * base - lo) / (hi - lo)) * (cap - floor));
}

/** The world's tallest building (the first of equals), if it has any. */
function tallestOf(world: World): CityBuilding | undefined {
  const bs = (world.city as CityInfo).buildings;
  return bs.length ? bs.reduce((p, q) => (q.row < p.row ? q : p)) : undefined;
}

/** What stands in front of tower `t`: `over` (nearer towers' parts) and the world's buildings — its cover and cells. */
function covered(t: Tower, over: readonly Part[], world: World, horizon: number): Tower {
  const x1 = t.x + t.w;
  const walls = (world.city as CityInfo).buildings.map((b): Part => [b.col * TILE, (b.col + b.w) * TILE, b.row * TILE]);
  const front = [...over, ...walls].filter(([a, b]) => a < x1 && b > t.x);
  const cover = envelope([[t.x, x1, horizon], ...front.map(([a, b, top]): Part => [Math.max(a, t.x), Math.min(b, x1), top])]);
  return { ...t, cover, cells: cellsOf(t.glass, cover, airSpans(t.x, x1)) };
}

/** SIGNATURE skyscraper centred behind the world's tallest building (`SIGNATURE_W` × `SIGNATURE_H`
 * of it), kind by a hash of its place. World-locked; every World with a building has one. */
function signatureOf(world: World, amb: Ambience | undefined, horizon: number, cap: number): Tower | null {
  const b = tallestOf(world);
  if (!b) return null;
  const w = Math.max(5 * TILE, Math.round(SIGNATURE_W * b.w * TILE));
  const x = Math.round((b.col + b.w / 2) * TILE - w / 2);
  const hh = hash(b.col, b.row, 61);
  // Under Fuji's snow cap it is capped like any tower — never left out: with no floor to its height (0),
  // `fit` always builds it (the cap's bottom is over the street), at worst hidden behind its building.
  const t = fit(world, amb, horizon, x, w, Math.round(SIGNATURE_H * (horizon - b.row * TILE)), 0, hh, cap, SIGNATURE_KINDS[hh % SIGNATURE_KINDS.length]) as Tower;
  return covered({ ...t, tint: 1, crowned: t.crown !== null }, [], world, horizon);
}

/** Chunk `k`'s cluster: see THE LAYOUT in the file comment — clear of the `signature`'s sky. Pure. */
function buildChunk(world: World, amb: Ambience | undefined, horizon: number, k: number, signature: Tower | null, cap: number): Tower[] {
  const h0 = hash(k, 23, 211);
  const tallest = tallestOf(world);
  // The tallest building's height over the street (with none, half the sky's).
  const base = tallest ? horizon - tallest.row * TILE : referenceHeight(horizon) / 2;
  const least = skylineMax(horizon) + CLEAR;
  const district = (TALL_MIN + ((h0 >>> 4) % TALL_STEPS)) / 100;
  const n = COUNTS[h0 % COUNTS.length];
  // Widths first, then where the cluster starts in its chunk — two towers of at most 168 px and a gap of
  // at most 8 always fit the chunk's 352 px between its margins…
  const sized: { hh: number; w: number; gap: number }[] = [];
  let span = 0;
  for (let i = 0; i < n; i++) {
    const hh = hash(k, i, 137);
    const w = (5 + (hh % 6)) * TILE + ((hh >>> 20) % 3) * 4; // 5–10 tiles
    const gap = i === 0 ? 0 : GAPS[(hh >>> 16) % GAPS.length];
    span += gap + w;
    sized.push({ hh, w, gap });
  }
  // …then heights: one of them — the district's tallest — at the district's height, the rest 62–100 % of it.
  const hero = (h0 >>> 12) % n;
  let x = k * CHUNK + MARGIN + ((h0 >>> 16) % (CHUNK - 2 * MARGIN - span + 1));
  const placed: { t: Tower; near: number; i: number }[] = [];
  sized.forEach(({ hh, w, gap }, i) => {
    const share = i === hero ? district : district * (0.62 + ((hh >>> 8) % 39) / 100);
    const h = Math.max(least, heightOf(share, base, cap));
    // Never wider than 0.6 of its height (a low city's would be squat warehouses).
    const tw = Math.min(w, Math.round(0.6 * h));
    x += gap;
    const t = fit(world, amb, horizon, x, tw, h, least, hh, cap);
    // Sky either side of the signature skyscraper: a tower that would crowd it is left out.
    const crowds = signature !== null && x < signature.x + signature.w + SIGNATURE_SKY && x + tw > signature.x - SIGNATURE_SKY;
    if (t && !crowds) placed.push({ t, near: (hh >>> 24) % 2, i: placed.length });
    x += tw;
  });
  // Back to front: farther towers first, in the lightest tint (the nearer, darker one covers the overlap).
  placed.sort((a, b) => a.near - b.near || a.i - b.i);
  return placed.map(({ t, near }, j) =>
    covered(
      { ...t, tint: near ? 1 + (t.seed % 2) : 0 },
      placed.slice(j + 1).flatMap((f) => f.t.parts),
      world,
      horizon,
    ),
  );
}

/** Tower `hh` at x, lowered (kind kept) until its tip is under `cap`; if still into Fuji's snow
 * cap (`roofLimit`), a setback lowered under it, never below `least`; null if that won't fit. */
function fit(
  world: World,
  amb: Ambience | undefined,
  horizon: number,
  x: number,
  w: number,
  h: number,
  least: number,
  hh: number,
  cap: number,
  kind: TowerKind = TOWER_KINDS[(hh >>> 12) % TOWER_KINDS.length],
): Tower | null {
  const limit = roofLimit(world, amb, horizon, x, x + w, ["far"]);
  const grid = (hh >>> 26) % GRIDS.length;
  const make = (): Tower => {
    const sh = shape(kind, x, w, h, horizon, hh);
    // One tower in four wears its crown band lit (the signature skyscraper always: `signatureOf`).
    return { kind, cover: [], cells: [], tint: 0, grid, seed: hh, ...sh, crowned: sh.crown !== null && hh % 4 === 0 };
  };
  let t = make();
  // Under the Skytree, tip and all (its roof is, `heightOf`; a mast or a tank may rise over): lowered by
  // what it rises over — a mast shrinks with it, so it ends at or just under the cap.
  const over = horizon - t.peak - cap;
  if (over > 0) {
    h -= over;
    t = make();
  }
  if (t.peak >= limit) return t;
  kind = "setback";
  h = Math.min(h, horizon - limit);
  return h < least ? null : make();
}

// ───────────────────────────── painting ─────────────────────────────

/** The world rect in view, in whole world px: nothing is painted outside it. */
interface Clip {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function clipOf(s: BackdropScene): Clip {
  const { cam } = s;
  return {
    x0: Math.floor(s.x0),
    x1: Math.ceil(s.x1),
    y0: Math.floor(-Math.round(cam.oy) / cam.zoom),
    y1: Math.ceil((s.view.h - Math.round(cam.oy)) / cam.zoom),
  };
}

/** Fill the part of a world-px rect in view, in the current fillStyle, edges snapped like `rect`. */
function fill(ctx: DrawTarget, cam: Camera, c: Clip, x: number, y: number, w: number, h: number): void {
  const a = Math.max(x, c.x0);
  const b = Math.min(x + w, c.x1);
  const t = Math.max(y, c.y0);
  const u = Math.min(y + h, c.y1);
  if (a >= b || t >= u) return;
  const X = sx(cam, a);
  const Y = sy(cam, t);
  ctx.fillRect(X, Y, Math.max(1, sx(cam, b) - X), Math.max(1, sy(cam, u) - Y));
}

/** Visit every tower standing over world x ∈ [x0, x1), back to front: the signature skyscraper, then the clusters. */
export function forEachTower(s: BackdropScene, x0: number, x1: number, visit: (t: Tower) => void): void {
  const sig = layoutOf(s.world, s.amb, s.horizon).signature;
  if (sig && sig.x < x1 && sig.x + sig.w > x0) visit(sig);
  for (let k = Math.floor(x0 / CHUNK); k * CHUNK < x1; k++)
    for (const t of chunkTowers(s.world, s.amb, s.horizon, k)) if (t.x < x1 && t.x + t.w > x0) visit(t);
}

/** Over [a, b), each stretch of `cells` where a row from `top` to `bottom` shows whole (nothing in
 * front above `bottom`; for `glass`, glass from `top`; below `deep` only in open sky), as one
 * `visit(x0, x1)`. Indexed, not destructured: a slanted crown has a cell per 2 px. */
export function rowRuns(
  cells: readonly Cell[],
  top: number,
  bottom: number,
  glass: boolean,
  deep: number,
  a: number,
  b: number,
  visit: (x0: number, x1: number) => void,
): void {
  let from = Infinity;
  let to = a;
  for (let i = 0; i <= cells.length; i++) {
    const cell = cells[i];
    if (i < cells.length && cell[3] >= bottom && (!glass || cell[2] <= top) && (cell[4] || bottom <= deep)) {
      if (from === Infinity) from = cell[0];
      to = cell[1];
    } else if (from !== Infinity) {
      if (Math.max(from, a) < Math.min(to, b)) visit(Math.max(from, a), Math.min(to, b));
      from = Infinity;
    }
  }
}

/** How far down glass shows behind the haze: mullions to its SHORTEST block's top, floor lines and
 * lit floors to its TALLEST's (one rect a mullion, one a floor). In open sky, all the way down. */
function floors(horizon: number): [mullions: number, lines: number] {
  const haze = skylineMax(horizon);
  return [horizon - Math.round(haze * 0.35), horizon - haze];
}

/** The pane columns of a tower `w` wide in pitch `col`: how many, and the first one's offset from its left wall. */
function columns(w: number, col: number): [n: number, off: number] {
  const n = Math.floor((w - 1) / col);
  return [n, 1 + ((w - 1 - n * col) >> 1)];
}

/** A tower by day: its outline in glass, the frame over it — mullions, floor lines, parapets — its sun-side edge and its details, each only where it shows. */
function paintTower(s: BackdropScene, c: Clip, t: Tower, colors: Palette, sunLeft: boolean, [floorY, lineY]: [number, number]): void {
  const { ctx, cam } = s;
  const tint = colors.tints[t.tint];
  ctx.fillStyle = tint.glass;
  for (const [a, b, top] of t.parts)
    for (const [p, q, o] of t.cover) if (p < b && q > a && o > top) fill(ctx, cam, c, Math.max(a, p), top, Math.min(b, q) - Math.max(a, p), o - top);
  // A mullion between every two pane columns and at both ends of them (zoomed out, at the walls only),
  // each from its glass's top; then the floor lines across.
  const [col, floor, line] = GRIDS[t.grid];
  const fine = cam.zoom >= PANE_ZOOM;
  const [n, off] = fine ? columns(t.w, col) : [1, t.w - 1];
  const pitch = fine ? col : off;
  ctx.fillStyle = tint.frame;
  const foot = (cell: Cell) => Math.min(cell[3], cell[4] ? s.horizon : floorY);
  for (let i = 0, j = 0; i <= n; i++) {
    const x = t.x + (fine ? off - 1 : 0) + i * pitch;
    while (t.cells[j][1] <= x) j++;
    fill(ctx, cam, c, x, t.cells[j][2], 1, foot(t.cells[j]) - t.cells[j][2]);
  }
  const step = fine ? floor : 2 * floor;
  const bottom = Math.min(s.horizon, c.y1);
  let y = t.top + Math.max(0, Math.floor((c.y0 - t.top) / step)) * step + floor - line;
  const across = (a: number, b: number) => fill(ctx, cam, c, a, y, b - a, line);
  for (; y < bottom; y += step) rowRuns(t.cells, y, y + line, true, lineY, t.x + 1, t.x + t.w - 1, across);
  // The sun-side edge, from the outline's top on that side down to whatever covers its foot.
  const [side, cell] = sunLeft ? [t.parts[0], t.cells[0]] : [t.parts[t.parts.length - 1], t.cells[t.cells.length - 1]];
  ctx.fillStyle = tint.edge;
  fill(ctx, cam, c, sunLeft ? t.x : t.x + t.w - 1, side[2], 1, foot(cell) - side[2]);
  for (const [x, y, w, h, ink] of t.marks) {
    ctx.fillStyle = ink === "frame" || ink === "crown" ? tint[ink] : colors[ink];
    for (const [p, q, , o] of t.cells) if (p < x + w && q > x) fill(ctx, cam, c, Math.max(x, p), y, Math.min(x + w, q) - Math.max(x, p), Math.min(h, o - y));
  }
}

/** The sun's side: left while it climbs, right from noon (and left with no sun to say). */
function sunOnLeft(amb: Ambience | undefined): boolean {
  return !(amb?.arc?.body === "sun" && amb.arc.t >= 0.5);
}

/** A light of tower `t` through `fillLit`: only uncovered parts in view, and for a lit floor
 * (`glass`) only glass above the haze or in open sky (`deep`). */
function emit(s: BackdropLightScene, c: Clip, t: Tower, glass: boolean, deep: number, x: number, y: number, w: number, h: number): void {
  const top = Math.max(y, c.y0);
  const bottom = Math.min(y + h, c.y1);
  // What shows is decided on the whole light, never on the part in view: world-locked.
  if (top < bottom) rowRuns(t.cells, y, y + h, glass, deep, Math.max(x, c.x0), Math.min(x + w, c.x1), (a, b) => s.fillLit(a, top, b - a, bottom - top));
}

/** Lit windows: one every `WINDOW` px per floor, lit past its own hashed threshold weighed by floor
 * occupancy (`BUSY`), so the same ones light first; scattered, never a floor-wide bar. */
function paintWindows(s: BackdropLightScene, c: Clip, t: Tower, lineY: number, seen: number): void {
  const [col, floor] = GRIDS[t.grid];
  const [n, off] = columns(t.w, col);
  const share = WINDOWS_LIT * s.lit * 1000;
  // Only the floors in view (a frame walks only what it shows), and not a dark floor's windows: none of them can light.
  for (let f = Math.max(0, Math.floor((c.y0 - t.top) / floor)); t.top + f * floor + 3 <= s.horizon && t.top + f * floor < c.y1; f++) {
    const busy = share * BUSY[hash(t.seed, f, 53) % BUSY.length];
    if (busy === 0) continue;
    for (let x = t.x + off; x + 2 <= t.x + off + n * col - 1; x += WINDOW) {
      const hw = hash(t.seed ^ f, x, 41);
      if (hw % 1000 >= busy) continue;
      s.ctx.fillStyle = (hw >>> 10) % 4 === 0 ? TOWER_LIT.cool : TOWER_LIT.warm;
      s.ctx.globalAlpha = seen * (0.35 + ((hw >>> 14) % 21) / 100);
      emit(s, c, t, true, lineY, x, t.top + f * floor + 1, 2, 2);
    }
  }
}

/** The City's Tokyo backdrop's HIGH layer: the high-rises behind the haze (render/city.ts `backdropOf`). */
export const TOWERS: BackdropLayer = {
  paint(s) {
    const c = clipOf(s);
    const floorY = floors(s.horizon);
    const sunLeft = sunOnLeft(s.amb);
    const colors = paletteOf(s.amb);
    s.ctx.globalAlpha = SEEN[s.amb?.weather ?? "clear"];
    forEachTower(s, c.x0, c.x1, (t) => paintTower(s, c, t, colors, sunLeft, floorY));
    s.ctx.globalAlpha = 1;
  },

  paintLights(s) {
    const c = clipOf(s);
    const floorY = floors(s.horizon)[1];
    const seen = Math.max(0.6, SEEN[s.amb.weather]);
    const night = Math.min(1, 2 * s.dark);
    forEachTower(s, c.x0, c.x1, (t) => {
      paintWindows(s, c, t, floorY, seen);
      if (night <= 0) return;
      if (t.crowned) {
        s.ctx.fillStyle = TOWER_LIT.crown[(t.seed >>> 6) % 2];
        s.ctx.globalAlpha = seen * night * 0.3;
        emit(s, c, t, false, Infinity, ...(t.crown as Rect));
      }
      s.ctx.globalAlpha = seen * night;
      for (const [bx, by] of t.beacons) {
        if (!aviationOn(s.timeMs, hash(t.seed, bx, 43) % BLINK_MS)) continue;
        s.ctx.fillStyle = AVIATION.glow;
        emit(s, c, t, false, Infinity, bx - 1, by - 2, 4, 4);
        s.ctx.fillStyle = AVIATION.core;
        emit(s, c, t, false, Infinity, bx, by - 1, 2, 2);
      }
    });
    s.ctx.globalAlpha = 1;
  },

  faceAt(s, x) {
    let y = s.horizon;
    // (Each tower's span first: the stars ask ~700 times a night frame, and a slanted roof has 50 parts.)
    const sig = layoutOf(s.world, s.amb, s.horizon).signature;
    for (const t of [...(sig ? [sig] : []), ...chunkTowers(s.world, s.amb, s.horizon, Math.floor(x / CHUNK))])
      if (x >= t.x && x < t.x + t.w) for (const [a, b, top] of t.parts) if (x >= a && x < b && top < y) y = top;
    return y;
  },
};
