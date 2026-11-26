/** The City's landmarks for the machine's zone (Tokyo: Fuji, Tower, Skytree, pagoda, shrine): four
 * passes at four depths, in DAY colours (the grade does night), world-locked. Placement is cached
 * per world: no building hides a CROWN; towers stand as far apart as the street allows. */

import { TILE, type Ambience, type CityInfo, type DayPhase, type WeatherKind, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { artBox } from "../engine/streetTheme";
import { hash, onScreen, rect, sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";
import { SKYLINE_BASE, skylineMax } from "./skyline";

// ───────────────────────────── the cities ─────────────────────────────

export type LandmarkKind = "fuji" | "tokyo-tower" | "skytree" | "pagoda" | "shrine";

export interface LandmarkSpec {
  kind: LandmarkKind;
  /** far = `paintFarLandmarks` (behind the clouds), tower = `paintLandmarks` (in front of them),
   * near = `paintNearLandmarks` (in front of the far skyline's blocks). */
  layer: "far" | "tower" | "near";
  /** Height as a fraction of its reference (`referenceHeight`, or `towerReference` with `tower`); 0
   * = the fixed size `min`. */
  height: number;
  /** Sized against the towers' reference (`towerReference`) rather than the sky's. */
  tower?: boolean;
  /** The fewest world px it may be, however short the sky: the size a temple's art is drawn for. */
  min?: number;
  /** The most world px it may be: a temple must fit the street's 4-tile gap between two buildings. */
  cap?: number;
  /** Where it would stand at Fit with nothing in the way: 0 = the city's left end .. 1 = its right end. */
  prefer: number;
}

const FUJI_SPEC: LandmarkSpec = { kind: "fuji", layer: "far", height: 0.6, prefer: 0.3 };
const TOWER_SPEC: LandmarkSpec = { kind: "tokyo-tower", layer: "tower", height: 333 / 634, tower: true, prefer: 0.58 };
const SKYTREE_SPEC: LandmarkSpec = { kind: "skytree", layer: "tower", height: 1, tower: true, prefer: 0.82 };
const PAGODA_SPEC: LandmarkSpec = { kind: "pagoda", layer: "near", height: 0.3, min: 2 * SKYLINE_BASE, cap: 176, prefer: 0.1 };
const SHRINE_SPEC: LandmarkSpec = { kind: "shrine", layer: "near", height: 0, min: SKYLINE_BASE, prefer: 0.62 };

/** Back to front within each layer, so the nearer Tower stands in front of the Skytree. */
const TOKYO: readonly LandmarkSpec[] = [FUJI_SPEC, SKYTREE_SPEC, TOWER_SPEC, PAGODA_SPEC, SHRINE_SPEC];

/** IANA zone → its skyline. "Japan" is the IANA link to Asia/Tokyo. */
const CITY_LANDMARKS: Readonly<Record<string, readonly LandmarkSpec[]>> = {
  "Asia/Tokyo": TOKYO,
  Japan: TOKYO,
};

const NONE: readonly LandmarkSpec[] = [];

/** The landmarks a city in time zone `zone` shows (none for an unknown or absent zone). */
export function landmarksFor(zone: string | undefined): readonly LandmarkSpec[] {
  return (zone && Object.hasOwn(CITY_LANDMARKS, zone) && CITY_LANDMARKS[zone]) || NONE;
}

// ───────────────────────────── colours ─────────────────────────────

interface Band {
  light: string;
  shade: string;
  edge: string;
}

/** A tower's colours: its body bands, the bracing, and its decks (frame, glass, the light line in the glass). */
export interface TowerPalette {
  bands: Readonly<Record<string, Band>>;
  lattice: string;
  girder: string;
  deck: { frame: string; shade: string; edge: string; glass: string; light: string };
}

/** Tokyo Tower by day: international orange and white, lighter orange X-bracing. Exported for the tests. */
export const TOKYO_TOWER: TowerPalette = {
  bands: {
    orange: { light: "#e5532a", shade: "#c8461f", edge: "#9e3416" },
    white: { light: "#f3efe7", shade: "#d9d2c6", edge: "#b3aa9c" },
    antenna: { light: "#e1ddd5", shade: "#e1ddd5", edge: "#e1ddd5" },
  },
  lattice: "#f49a70",
  girder: "#b23c19",
  deck: { frame: "#f6f3ec", shade: "#cdc6ba", edge: "#a99f91", glass: "#55667e", light: "#8fa3bc" },
};

/** Tokyo Tower's "Landmark Light": the whole lattice glowing warm orange-gold. */
export const TOKYO_TOWER_LIT: TowerPalette = {
  bands: {
    orange: { light: "#ff8a2b", shade: "#f2731f", edge: "#ffc266" },
    white: { light: "#fff0cf", shade: "#ffdca0", edge: "#fff5df" },
    antenna: { light: "#ffe7bd", shade: "#ffe7bd", edge: "#ffe7bd" },
  },
  lattice: "#ffd27e",
  girder: "#ffb04a",
  deck: { frame: "#fff4da", shade: "#ffd890", edge: "#ffe9b8", glass: "#ffe39a", light: "#fffbea" },
};

/** The Skytree by day: "Skytree White" (a pale blue-grey) with dark glass decks and cyan light bands. */
export const SKYTREE: TowerPalette = {
  bands: {
    body: { light: "#e2e9f0", shade: "#c5d1dd", edge: "#8399b0" },
    mast: { light: "#d3dce6", shade: "#b4c2d2", edge: "#7d93aa" },
    antenna: { light: "#c9d3de", shade: "#c9d3de", edge: "#c9d3de" },
  },
  lattice: "#b7c6d6",
  girder: "#a5b6c8",
  deck: { frame: "#f1f5f8", shade: "#ccd7e2", edge: "#7a90a6", glass: "#2c445e", light: "#5fcdf0" },
};

/** The Skytree at night: "Iki" pale blue on the body and decks, a "Miyabi" purple mast. */
export const SKYTREE_LIT: TowerPalette = {
  bands: {
    body: { light: "#78c2ee", shade: "#58a4da", edge: "#d4f0ff" },
    mast: { light: "#a47ae4", shade: "#8a5fd0", edge: "#dccaff" },
    antenna: { light: "#e2d4ff", shade: "#e2d4ff", edge: "#e2d4ff" },
  },
  lattice: "#bfe8ff",
  girder: "#9fd8fa",
  deck: { frame: "#c4edff", shade: "#9cd6f6", edge: "#e8f8ff", glass: "#e6fbff", light: "#ffffff" },
};

/** Fuji: a deep blue cone, lighter ridges, a white cap, hazier toward its hidden foot. Exported for the tests. */
export const FUJI = {
  body: "#5b7db0",
  shade: "#4d6d9e",
  ridge: "#7d9bc7",
  ridgeShade: "#6a88b6",
  snow: "#f4f7fb",
  snowShade: "#d2ddeb",
  haze: ["#6e8ebd", "#86a3cb", "#9db7d9"],
  hazeShade: ["#6181b1", "#7895c0", "#90abcf"],
} as const;

/** The aviation lights on both tips (a red core in a soft red halo). */
export const AVIATION = { core: "#ff2a1f", glow: "rgba(255, 64, 48, 0.4)" } as const;

/** The temples' day palette. Exported for the tests. */
export const TEMPLE = {
  roof: "#4b4f59",
  roofShade: "#363942",
  eave: "#1f2127",
  vermilion: "#d04a2e",
  vermilionShade: "#a83a22",
  bracket: "#6b2618",
  cream: "#f3e9d1",
  creamShade: "#d7cbaf",
  stone: "#a29e94",
  stoneShade: "#848077",
  stoneTop: "#c0bcb1",
  riser: "#6a665e",
  gold: "#e4b440",
  goldShade: "#b98d28",
  spire: "#28272c",
  ring: "#4c4952",
  door: "#70492a",
  lattice: "#ab8352",
  rope: "#dfca8c",
  ropeShade: "#a99155",
  shide: "#fbfbf5",
  fireBox: "#46423b",
} as const;

/** Temple lights at night over the graded silhouette: storeys washed faintly warm, roofs left dark.
 */
export const TEMPLE_LIT = {
  wall: "rgba(255, 146, 78, 0.55)",
  wallShade: "rgba(236, 116, 58, 0.5)",
  panel: "rgba(255, 224, 164, 0.6)",
  panelShade: "rgba(246, 198, 128, 0.55)",
  eaves: "rgba(255, 186, 98, 0.7)",
  fire: "#ffd47c",
  door: "rgba(255, 192, 98, 0.7)",
  glow: "rgba(255, 198, 112, 0.3)",
} as const;

// ───────────────────────────── when they show ─────────────────────────────

/** How much of each layer shows through each weather (far things fade first, near ones least). */
const SEEN: Record<WeatherKind, Record<LandmarkSpec["layer"], number>> = {
  clear: { far: 1, tower: 1, near: 1 },
  cloudy: { far: 0.6, tower: 1, near: 1 },
  drizzle: { far: 0.35, tower: 0.9, near: 0.95 },
  snow: { far: 0.35, tower: 0.85, near: 0.9 },
  rain: { far: 0.2, tower: 0.8, near: 0.9 },
  fog: { far: 0.15, tower: 0.5, near: 0.65 },
  storm: { far: 0.12, tower: 0.7, near: 0.85 },
};

/** How bright the towers' night lighting is per phase (absent = off). */
const LIT: Partial<Record<DayPhase, number>> = { evening: 0.55, dusk: 0.85, night: 1 };

/** Aviation lights: one blink every 1.5 s, on for half of it. */
export const BLINK_MS = 1500;

// ───────────────────────────── placement ─────────────────────────────

/** A landmark where it stands — in the world: it scrolls and zooms with the street. */
export interface PlacedLandmark {
  spec: LandmarkSpec;
  /** Centre x, world px. */
  x: number;
  /** Height, world px. */
  h: number;
  /** Half-width at its foot, world px (for culling). */
  hw: number;
  /** Its foot, world px: the horizon it stands on. */
  base: number;
}

/** A world-px box: columns x0 ≤ x < x1, rows top ≤ y < bottom. */
export interface WorldBox {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

export interface LandmarkLayout {
  /** What Fit frames, less its air (world px): `prefer` runs across it, and every crown stands inside it. */
  span: readonly [number, number];
  /** In the table's order (back to front within a layer). */
  placed: PlacedLandmark[];
}

/** A temple's score cost of standing beyond the frame's outer walls (Fit may crop there), as a fraction of its height. */
const SIDE_COST = 0.6;
/** A temple's score cost per world px from its preferred place (a tie-break). */
const DIST_COST = 0.05;
/** World px kept between two crowns (a temple's crown is all of it). */
const PAD = 8;
/** Share of the framed span between two towers' crowns when no building can stand between them
 * (what the HQ alone gives: 6.5× PAD). */
const APART = 1 / 8;
/** World px a temple stands off an outer wall: Fit frames only a tile of air beyond it. */
const WALL = 2;
/** Fuji's width per unit height. */
const FUJI_ASPECT = 4.2;
/** The share of its full height a landmark with no clear spot loses at a time. */
const SHRINK = 0.05;

const cache = new WeakMap<World, { horizonY: number; specs: readonly LandmarkSpec[]; layout: LandmarkLayout }>();

/** The reference height Fuji and the temples are a fraction of: the city's sky less a tile. */
export function referenceHeight(horizonY: number): number {
  return Math.max(TILE, horizonY - TILE);
}

/** The Skytree is this many times the tallest roof (capped by OVER_TOP); sized by the sky alone it
 * is too small beside a tall building. */
const TOWERING = 1.5;

/** Most tiles the Skytree's tip may rise past the world's top. Fit frames the tip, so each tile
 * costs Fit zoom; at 5 the reference five-floor city keeps its zoom in every measured @2x pane. */
const OVER_TOP = 5;

/** Towers' reference height: TOWERING × the tallest roof (`tallest`, world px; −∞ = none), tip at
 * most OVER_TOP tiles past the world's top, never less than the sky's reference. */
export function towerReference(horizonY: number, tallest: number): number {
  return Math.max(referenceHeight(horizonY), Math.min(TOWERING * tallest, horizonY + OVER_TOP * TILE));
}

/** Half-width of a landmark's foot (world px) for its kind and height (a temple's: its widest part). */
function footHalfWidth(kind: LandmarkKind, h: number): number {
  if (kind === "fuji") return Math.ceil((FUJI_ASPECT * h) / 2);
  if (kind === "pagoda" || kind === "shrine") return templeArt(kind, h, true).hw;
  return Math.ceil(h * ART[kind].profile[0][1]) + 1;
}

/** A tower's half-width (world px) where it rises out of the `haze`-px far skyline; a tower is
 * always taller than the haze, so the profile brackets the height. */
function towerHwAtSkyline(p: { spec: LandmarkSpec; h: number }, haze: number): number {
  return Math.ceil(p.h * profileAt(ART[p.spec.kind as keyof typeof ART].profile, haze / p.h));
}

/** The crown of a `kind` landmark `h` tall, its foot centred on (cx, base) — see `landmarkCrown`. */
function crownAt(kind: LandmarkKind, cx: number, h: number, base: number): WorldBox {
  const top = base - h;
  if (kind === "fuji") {
    // As `paintFuji` lays it out: the ragged snow columns, cx − capHw … cx + capHw, each reaching its
    // own depth, under the solid cap's rows — the widest of which, its lowest, can round a px further
    // right than the columns reach (at 110 px tall, say), never further left.
    const cap = Math.round(h * CAP);
    const capHw = Math.floor(fujiHw(h, cap));
    const [rx, rw] = run(cx, fujiHw(h, cap - 0.5));
    let depth = 0;
    for (let dx = -capHw; dx < capHw; dx += SNOW_COL) depth = Math.max(depth, snowDepth(h, Math.floor(dx / SNOW_COL)));
    return { x0: cx - capHw, x1: Math.max(rx + rw, cx + capHw), top, bottom: top + depth };
  }
  if (kind === "pagoda" || kind === "shrine") {
    const { hw } = templeArt(kind, h, true);
    return { x0: cx - hw, x1: cx + hw, top, bottom: base };
  }
  // A tower: down to the bottom of its lowest deck (decks are listed bottom up), as wide as that deck
  // — `paintTower` lays it out exactly so. On both towers it overhangs everything above it.
  const d = ART[kind].decks[0];
  const yTop = base - Math.round(d.f1 * h);
  const [x0, w] = run(cx, Math.max(2, d.hw * h));
  return { x0, x1: x0 + w, top, bottom: yTop + Math.max(2, base - Math.round(d.f0 * h) - yTop) };
}

/** A placed landmark's CROWN, world px, the part never to be hidden: a tower's tip to its lowest
 * deck (as wide), Fuji's whole snow cap, a temple's whole art. Pure. */
export function landmarkCrown(p: PlacedLandmark): WorldBox {
  return crownAt(p.spec.kind, p.x, p.h, p.base);
}

/** Where `specs` stand in `world` (cached per world): Fuji and the towers at the largest sizes
 * where every crown has an unhidden spot (Fuji shrinks first), towers as far apart as possible;
 * then the temples. Pure, deterministic. */
export function placeLandmarks(world: World, horizonY: number, specs: readonly LandmarkSpec[]): LandmarkLayout {
  const hit = cache.get(world);
  if (hit && hit.horizonY === horizonY && hit.specs === specs) return hit.layout;
  // Only the City paints landmarks (render/city.ts, under frame.ts's `if (world.city)`), so a world here always has one.
  const buildings = [...(world.city as CityInfo).buildings].sort((a, b) => a.col - b.col);
  const boxes = buildings.map((b) => ({ x0: b.col * TILE, x1: (b.col + b.w) * TILE, top: b.row * TILE }));
  const x0 = boxes.length ? boxes[0].x0 : 0;
  const x1 = boxes.length ? Math.max(...boxes.map((b) => b.x1)) : world.cols * TILE;
  const [s0, s1] = framed(world, x0, x1);
  const haze = skylineMax(horizonY);
  /** The tallest building over [a, b] (0 = open sky down to the far skyline). */
  const occluder = (a: number, b: number): number => {
    let m = 0;
    for (const o of boxes) if (o.x0 < b && o.x1 > a) m = Math.max(m, horizonY - o.top);
    return m;
  };
  /** Is crown `c` hidden — by a building whose roof rises above its bottom, across its width? */
  const hidden = (c: WorldBox): boolean => boxes.some((b) => b.x0 < c.x1 && b.x1 > c.x0 && b.top < c.bottom);
  /** Is crown `c` closer than PAD to `d` (x only)? */
  const crowding = (c: WorldBox, d: WorldBox): boolean => c.x0 < d.x1 + PAD && d.x0 < c.x1 + PAD;
  /** The air two towers' crowns keep when no building can stand between them (world px): APART of the span. */
  const far = Math.round(APART * (s1 - s0));
  const ref = referenceHeight(horizonY);
  const towerRef = towerReference(horizonY, horizonY - Math.min(...boxes.map((b) => b.top)));
  /** Where a landmark would stand at Fit with nothing in the way (world x). */
  const prefOf = (s: LandmarkSpec): number => Math.round(s0 + s.prefer * (s1 - s0));
  // The far and tower layers shortest first; then the temples, tallest first (the pagoda can stand
  // in front of no tower, the low shrine in front of a tower's foot). Equal heights keep the
  // table's order (Array.prototype.sort is stable).
  const near = (s: LandmarkSpec): number => (s.layer === "near" ? 1 : 0);
  const order = specs
    .map((spec, i) => ({ spec, i, h: Math.min(spec.cap ?? Infinity, Math.max(spec.min ?? 0, Math.round((spec.tower ? towerRef : ref) * spec.height))) }))
    .sort((a, b) => near(a.spec) - near(b.spec) || (near(a.spec) ? b.h - a.h : a.h - b.h));
  const placed: (PlacedLandmark & { c: WorldBox; i: number })[] = [];
  const stand = (spec: LandmarkSpec, i: number, x: number, h: number): void => {
    placed.push({ spec, x, h, hw: footHalfWidth(spec.kind, h), base: horizonY, c: crownAt(spec.kind, x, h, horizonY), i });
  };

  // Largest sizes at which every crown has a spot at once (towers kept full while any Fuji size
  // allows), on the best arrangement; else each at full size, free to stand past the outer walls.
  const big = order.filter((o) => !near(o.spec));
  /** Fuji's and the towers' sizes with the towers `t` twentieths smaller and Fuji `f` — null once a crown would sink into the haze. */
  const sized = (t: number, f: number): number[] | null => {
    const out: number[] = [];
    for (const { spec, h } of big) {
      const size = Math.round(h * (1 - (spec.layer === "tower" ? t : f) * SHRINK));
      if (horizonY - crownAt(spec.kind, 0, size, horizonY).bottom < haze) return null;
      out.push(size);
    }
    return out;
  };
  const steps = (layer: LandmarkSpec["layer"]): number => (big.some((o) => o.spec.layer === layer) ? Infinity : 1);
  let fit: { sizes: number[]; xs: number[] } | null = null;
  for (let t = 0; !fit && t < steps("tower") && sized(t, 0); t++)
    for (let f = 0; !fit && f < steps("far"); f++) {
      const sizes = sized(t, f);
      if (!sizes) break;
      const xs = arrange(sizes, false);
      if (xs) fit = { sizes, xs };
    }
  const sizes = fit ? fit.sizes : big.map((o) => o.h);
  // Out past the walls, a crown may stand as far off as every crown laid end to end: there is always room.
  const xs = fit ? fit.xs : (arrange(sizes, true) as number[]);
  big.forEach(({ spec, i }, k) => stand(spec, i, xs[k], sizes[k]));
  for (const { spec, i, h } of order.filter((o) => near(o.spec))) stand(spec, i, templeSpot(spec, h, prefOf(spec)), h);

  /** Best arrangement at `sizes` (every order and stretch, solved exactly; `free` allows past the
   * span), or null: towers furthest apart (two buildings, one, `far` px of air, PAD), then fewest
   * pairs out of `prefer` order, then nearest places. */
  function arrange(sizes: readonly number[], free: boolean): number[] | null {
    const n = big.length;
    const crowns = big.map((o, k) => crownAt(o.spec.kind, 0, sizes[k], horizonY));
    const wide = free ? crowns.reduce((s, c) => s + c.x1 - c.x0 + PAD, 0) : 0;
    const all = big.map((o, k) => ({ spec: o.spec, c: crowns[k], pref: prefOf(o.spec), stretches: stretches(crowns[k], wide) }));
    /** The landmarks left to right, and the stretch each stands on. */
    const row: number[] = [];
    const on: (readonly [number, number])[] = [];
    let best: { key: number[]; xs: number[] | null } = { key: [Infinity], xs: null };
    /** Spots for `row` with x[v] − x[u] ≥ need[u][v] for u left of v: each, shortest first, as near
     * its preferred place as the others allow (ranges are exact: constraints run left to right),
     * or null. */
    const solve = (need: readonly number[][]): number[] | null => {
      const lo = on.map((s) => s[0]);
      const hi = on.map((s) => s[1]);
      for (let k = 0; k < n; k++) {
        const L = [...lo];
        const U = [...hi];
        for (let v = 0; v < n; v++) for (let u = 0; u < v; u++) L[v] = Math.max(L[v], L[u] + need[u][v]);
        for (let u = n - 1; u >= 0; u--) for (let v = u + 1; v < n; v++) U[u] = Math.min(U[u], U[v] - need[u][v]);
        if (L.some((l, v) => l > U[v])) return null;
        const u = row.indexOf(k);
        lo[u] = hi[u] = Math.min(U[u], Math.max(L[u], all[k].pref));
      }
      return all.map((_, k) => lo[row.indexOf(k)]);
    };
    const settle = (): void => {
      // PAD between every two crowns; `far` too between two towers with no building between them.
      const need = row.map((k, u) => row.map((q, v) => (v > u ? all[k].c.x1 - all[q].c.x0 + PAD : -Infinity)));
      const apart = need.map((r) => [...r]);
      let level = 3;
      for (let u = 0; u < n; u++)
        for (let v = u + 1; v < n; v++) {
          const [a, b] = [all[row[u]], all[row[v]]];
          if (a.spec.layer !== "tower" || b.spec.layer !== "tower") continue;
          // Anywhere on a stretch, the same buildings stand wholly right of the left crown and left of the right one.
          const count = boxes.filter((o) => o.x0 >= on[u][0] + a.c.x1 && o.x1 <= on[v][0] + b.c.x0).length;
          level = Math.min(level, 1 + Math.min(2, count));
          if (!count) apart[u][v] = a.c.x1 - b.c.x0 + far;
        }
      let xs = solve(apart);
      if (!xs) [level, xs] = [0, solve(need)];
      if (!xs) return;
      let inversions = 0;
      for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) if (all[row[u]].spec.prefer > all[row[v]].spec.prefer) inversions++;
      // Past the walls (`free`), as few crowns as can be.
      const past = xs.filter((x, k) => x + all[k].c.x0 < s0 || x + all[k].c.x1 > s1).length;
      const key = [past, -level, inversions, ...xs.flatMap((x, k) => [Math.abs(x - all[k].pref), -x])];
      const i = key.findIndex((x, j) => x !== best.key[j]);
      if (key[i] < best.key[i]) best = { key, xs };
    };
    const visit = (): void => {
      if (row.length === n) return settle();
      for (let k = 0; k < n; k++)
        if (!row.includes(k))
          for (const s of all[k].stretches) {
            row.push(k);
            on.push(s);
            visit();
            row.pop();
            on.pop();
          }
    };
    visit();
    return best.xs;
  }

  /** The whole x ranges [a, z] where crown `c` (offsets from its centre) stands unhidden, inside
   * the span or up to `wide` past it, cut where a wall meets its edges so each range has the same
   * buildings wholly left and right. */
  function stretches(c: WorldBox, wide: number): (readonly [number, number])[] {
    const lo = s0 - c.x0 - wide;
    const hi = s1 - c.x1 + wide;
    const ends = new Set([lo - 1, hi]);
    for (const b of boxes) ends.add(b.x0 - c.x1).add(b.x1 - c.x0 - 1);
    const cuts = [...ends].filter((e) => e >= lo - 1 && e <= hi).sort((a, b) => a - b);
    const out: (readonly [number, number])[] = [];
    for (let k = 1; k < cuts.length; k++) {
      const a = cuts[k - 1] + 1;
      if (!hidden({ ...c, x0: a + c.x0, x1: a + c.x1 })) out.push([a, cuts[k]]);
    }
    return out;
  }

  /** A temple's spot among its candidates (preferred place, each building's and gap's middle, three
   * steps past each outer wall): where most of it shows, never on the other temple or a tower's
   * body above the haze; else its preferred place. */
  function templeSpot(spec: LandmarkSpec, h: number, pref: number): number {
    const r = templeArt(spec.kind as TempleKind, h, true).hw;
    /** Would standing at x cover what must show of `p`? A temple is placed after every far and tower landmark. */
    const clash = (x: number, p: (typeof placed)[number]): boolean => {
      if (p.spec.layer === "near") return crowding({ x0: x - r, x1: x + r, top: horizonY - h, bottom: horizonY }, p.c);
      // A tower's foot stands behind the far skyline's haze anyway: only its body above the haze must
      // stay clear — and only of a temple that reaches up there. A temple may stand in front of Fuji,
      // which is far further off (a pagoda before Fuji's snow is the classic picture of it).
      return p.spec.layer === "tower" && h > haze && Math.abs(x - p.x) < r + towerHwAtSkyline(p, haze) + PAD;
    };
    const candidates: { x: number; side: boolean }[] = [{ x: pref, side: false }];
    boxes.forEach((b, k) => {
      candidates.push({ x: Math.round((b.x0 + b.x1) / 2), side: false });
      const next = boxes[k + 1];
      if (next && next.x0 > b.x1) candidates.push({ x: Math.round((b.x1 + next.x0) / 2), side: false });
    });
    if (boxes.length)
      for (let k = 0; k < 3; k++) {
        const off = r + WALL + k * 2 * TILE;
        // Beyond an outer wall: a cost only past the framed span (on the side with less built, Fit
        // shows the empty street beyond the last wall).
        candidates.push({ x: x0 - off, side: x0 - off < s0 }, { x: x1 + off, side: x1 + off > s1 });
      }
    let best: { x: number; score: number } | null = null;
    for (const c of candidates) {
      if (placed.some((p) => clash(c.x, p))) continue;
      const score = h - occluder(c.x - r, c.x + r) - (c.side ? SIDE_COST * h : 0) - DIST_COST * Math.abs(c.x - pref);
      if (!best || score > best.score) best = { x: c.x, score };
    }
    return best ? best.x : pref;
  }

  const layout: LandmarkLayout = {
    span: [s0, s1],
    placed: placed.sort((a, b) => a.i - b.i).map(({ spec, x, h, hw, base }) => ({ spec, x, h, hw, base })),
  };
  cache.set(world, { horizonY, specs, layout });
  return layout;
}

/** The span Fit frames less its air, world px (`VillageView.fitTarget`'s rule; a test keeps them
 * equal): the outer walls, or with the HQ, centred on it out to the farther built end (lounge
 * walls included). */
function framed(world: World, x0: number, x1: number): [number, number] {
  const hq = (world.city as CityInfo).buildings.find((b) => b.hq);
  if (!hq) return [x0, x1];
  const room = world.houses.find((h) => h.capacity === "lounge") as World["houses"][number];
  const mid = (hq.col + hq.w / 2) * TILE;
  const half = Math.max(mid - Math.min(x0, (room.col - 1) * TILE), Math.max(x1, (room.col + room.w + 1) * TILE) - mid);
  return [mid - half, mid + half];
}

// ───────────────────────────── the art ─────────────────────────────

type Profile = readonly (readonly [number, number])[];

interface Deck {
  /** Height fractions of its bottom and top. */
  f0: number;
  f1: number;
  /** Half-width, fraction of the tower's height. */
  hw: number;
  /** Its rows top-down: up to which fraction of the deck's height each part runs. */
  rows: readonly (readonly [number, keyof TowerPalette["deck"]])[];
}

interface TowerArt {
  /** Half-width (fraction of the height) at height fractions, bottom up; linear in between. */
  profile: Profile;
  /** The body band at height fraction f. */
  band(f: number): string;
  /** The opening between the legs: up to `top`, legs `leg` (fraction of height) wide. */
  arch: { top: number; leg: number };
  /** X-bracing from the foot up to `top`, one X per section of `section`·height rows (≥ 4). */
  lattice: { top: number; section: number };
  decks: readonly Deck[];
  /** Aviation lights: height fractions (1 = the tip) and each one's blink phase (ms). */
  lights: readonly (readonly [number, number])[];
}

/** Tokyo Tower bands above the main deck, top-down — orange and white, then the striped mast. */
const TOWER_BANDS: readonly (readonly [number, string])[] = [
  [0.92, "antenna"],
  [0.9, "orange"],
  [0.87, "white"],
  [0.835, "orange"],
  [0.8, "white"],
  [0.655, "orange"],
  [0.62, "white"],
  [0.585, "orange"],
  [0.55, "white"],
];

const ART: Record<"tokyo-tower" | "skytree", TowerArt> = {
  "tokyo-tower": {
    profile: [
      [0, 0.14],
      [0.04, 0.118],
      [0.1, 0.094],
      [0.18, 0.074],
      [0.28, 0.057],
      [0.38, 0.046],
      [0.45, 0.04],
      [0.55, 0.034],
      [0.65, 0.028],
      [0.735, 0.022],
      [0.76, 0.016],
      [0.85, 0.011],
      [0.92, 0.0065],
      [0.921, 0.0015],
      [1, 0.0015],
    ],
    band: (f) => {
      for (const [from, band] of TOWER_BANDS) if (f >= from) return band;
      return "orange";
    },
    arch: { top: 0.11, leg: 0.036 },
    lattice: { top: 0.735, section: 0.04 },
    decks: [
      // The main observatory (150 m): two white tiers, each with a band of glass.
      { f0: 0.428, f1: 0.457, hw: 0.066, rows: [[0.2, "frame"], [0.65, "glass"], [0.8, "frame"], [1, "shade"]] },
      { f0: 0.457, f1: 0.486, hw: 0.057, rows: [[0.25, "frame"], [0.7, "glass"], [1, "frame"]] },
      // The top deck (250 m).
      { f0: 0.733, f1: 0.758, hw: 0.034, rows: [[0.3, "frame"], [0.75, "glass"], [1, "shade"]] },
    ],
    lights: [[1, 0]],
  },
  skytree: {
    profile: [
      [0, 0.052],
      [0.06, 0.046],
      [0.15, 0.039],
      [0.3, 0.032],
      [0.45, 0.028],
      [0.535, 0.026],
      [0.57, 0.025],
      [0.69, 0.021],
      [0.715, 0.019],
      [0.78, 0.016],
      [0.781, 0.01],
      [0.93, 0.007],
      [0.931, 0.0015],
      [1, 0.0015],
    ],
    band: (f) => (f >= 0.931 ? "antenna" : f >= 0.781 ? "mast" : "body"),
    arch: { top: 0.045, leg: 0.016 },
    lattice: { top: 0.93, section: 0.022 },
    decks: [
      // The Tembo Deck (350 m): the big one — a white frame round a dark glass band with a cyan light line.
      { f0: 0.532, f1: 0.572, hw: 0.045, rows: [[0.16, "frame"], [0.42, "glass"], [0.52, "light"], [0.76, "glass"], [0.9, "frame"], [1, "shade"]] },
      // The Tembo Galleria (450 m): the thinner ring.
      { f0: 0.693, f1: 0.712, hw: 0.033, rows: [[0.25, "frame"], [0.45, "glass"], [0.65, "light"], [0.8, "glass"], [1, "frame"]] },
    ],
    lights: [
      [1, 0],
      [0.86, BLINK_MS / 2],
    ],
  },
};

/** Half-width fraction of `profile` at height fraction f ∈ (0, 1]; callers stay within the profile,
 * so a pair always brackets f. */
function profileAt(profile: Profile, f: number): number {
  const i = profile.findIndex(([f1]) => f <= f1);
  const [f0, w0] = profile[i - 1];
  const [f1, w1] = profile[i];
  return w0 + ((w1 - w0) * (f - f0)) / (f1 - f0);
}

/** The pixel run of half-width `hw` (world px) centred on `cx`: its left x and width (≥ 1). */
function run(cx: number, hw: number): [number, number] {
  const w = Math.max(1, Math.round(2 * hw));
  return [cx - (w >> 1), w];
}

/** World rows on screen, as [first, end) clamped to [top, bottom). */
function visibleRows(cam: Camera, view: { h: number }, top: number, bottom: number): [number, number] {
  const oy = Math.round(cam.oy);
  return [Math.max(top, Math.floor(-oy / cam.zoom) - 1), Math.min(bottom, Math.ceil((view.h - oy) / cam.zoom) + 1)];
}

/** World px per painted row: 1 from zoom 1 up; below it every round(1/zoom)-th row (the others land on the same screen row). */
function rowStep(cam: Camera): number {
  return cam.zoom < 1 ? Math.max(1, Math.round(1 / cam.zoom)) : 1;
}

/** Vertical stack of runs: consecutive rows with equal x, width and colour paint as ONE rect. An
 * empty run (width ≤ 0) paints and joins nothing. */
function lane(ctx: DrawTarget, cam: Camera) {
  let x = 0;
  let w = 0;
  let y0 = 0;
  let y1 = 0;
  let c = "";
  const flush = (): void => {
    if (w > 0) rect(ctx, cam, x, y0, w, y1 - y0, c);
    w = 0;
  };
  return {
    add(nx: number, ny: number, nw: number, nh: number, nc: string): void {
      if (w > 0 && nx === x && nw === w && nc === c && ny === y1) {
        y1 = ny + nh;
        return;
      }
      flush();
      [x, y0, w, y1, c] = [nx, ny, nw, ny + nh, nc];
    },
    flush,
  };
}

/** A lattice tower of height `h` on horizon `base`, centred on `cx`; only rows above `cut` are
 * painted (the night pass stops above the far skyline). Day or lit is just the palette. */
function paintTower(
  ctx: DrawTarget,
  cam: Camera,
  view: { w: number; h: number },
  art: TowerArt,
  pal: TowerPalette,
  cx: number,
  base: number,
  h: number,
  cut: number,
): void {
  // No rows on screen (ya ≥ yb) paints nothing below: every loop and deck clamps to [ya, yb).
  const [ya, yb] = visibleRows(cam, view, base - h, Math.min(base, cut));
  const step = rowStep(cam);
  const archRows = art.arch.top * h;
  const leg = Math.max(2, Math.round(art.arch.leg * h));
  const footHw = art.profile[0][1] * h;
  const edgeL = lane(ctx, cam);
  const bodyL = lane(ctx, cam);
  const bodyR = lane(ctx, cam);
  const edgeR = lane(ctx, cam);
  for (let y = ya; y < yb; y += step) {
    const n = Math.min(step, yb - y);
    const above = base - y - n / 2;
    const f = above / h;
    const band = pal.bands[art.band(f)];
    const [x0, w] = run(cx, h * profileAt(art.profile, f));
    if (w <= 3) {
      bodyL.add(x0, y, w, n, band.light);
      continue;
    }
    const x1 = x0 + w;
    // Between the legs, an arch of open sky (elliptical, closing at `arch.top`).
    const open = above < archRows ? Math.round(Math.max(0, footHw - leg) * Math.sqrt(1 - (above / archRows) ** 2)) : 0;
    edgeL.add(x0, y, 1, n, band.edge);
    bodyL.add(x0 + 1, y, cx - open - x0 - 1, n, band.light);
    bodyR.add(cx + open, y, x1 - 1 - cx - open, n, band.shade);
    edgeR.add(x1 - 1, y, 1, n, band.edge);
  }
  edgeL.flush();
  bodyL.flush();
  bodyR.flush();
  edgeR.flush();
  // The X-bracing — only where a pixel of it is a pixel on screen: a girder at the foot of each
  // section and its two diagonals, a short run per row.
  if (cam.zoom >= 1) {
    const section = Math.max(4, Math.round(art.lattice.section * h));
    const top = Math.max(ya, base - Math.floor(art.lattice.top * h));
    for (let y = top; y < yb; y++) {
      const above = base - y - 0.5;
      if (above < archRows) continue;
      const [x0, w] = run(cx, h * profileAt(art.profile, above / h));
      const inner = w - 2;
      if (inner < 3) continue;
      const k = (base - 1 - y) % section;
      if (k === 0) {
        rect(ctx, cam, x0 + 1, y, inner, 1, pal.girder);
        continue;
      }
      const dw = Math.max(1, Math.ceil(inner / section));
      const along = Math.round((k / section) * (inner - dw));
      rect(ctx, cam, x0 + 1 + along, y, dw, 1, pal.lattice);
      rect(ctx, cam, x0 + 1 + inner - dw - along, y, dw, 1, pal.lattice);
    }
  }
  // The decks, over the lattice.
  for (const d of art.decks) {
    const yTop = base - Math.round(d.f1 * h);
    const yBottom = base - Math.round(d.f0 * h);
    const rows = Math.max(2, yBottom - yTop);
    const [x0, w] = run(cx, Math.max(2, d.hw * h));
    let from = yTop;
    for (const [upTo, part] of d.rows) {
      const to = Math.min(yTop + rows, yTop + Math.max(1, Math.round(upTo * rows)));
      const a = Math.max(from, ya);
      const b = Math.min(to, yb);
      if (b > a) rect(ctx, cam, x0 + 1, a, w - 2, b - a, pal.deck[part]);
      from = Math.max(from, to);
    }
    const a = Math.max(yTop, ya);
    const b = Math.min(yTop + rows, yb);
    if (b > a) {
      rect(ctx, cam, x0, a, 1, b - a, pal.deck.edge);
      rect(ctx, cam, x0 + w - 1, a, 1, b - a, pal.deck.edge);
    }
  }
}

/** Fuji's crater rim half-width, as a fraction of its half-width at the foot. */
const PLATEAU = 0.022;
/** Fuji's flank straightness: this share of the half-width grows linearly, the rest with depth
 * squared (a gentle concave cone, never a spike). */
const FLANK = 0.55;
/** The solid snow cap: the top fifth. */
const CAP = 0.2;

/** Fuji's half-width (world px) `d` px below its peak, for height `h`. */
function fujiHw(h: number, d: number): number {
  const half = (FUJI_ASPECT * h) / 2;
  const p = Math.max(2, PLATEAU * half);
  const t = Math.max(0, Math.min(1, d / h));
  return p + (half - p) * (FLANK * t + (1 - FLANK) * t * t);
}

/** World px per snow column. */
const SNOW_COL = 2;

/** A column's noise, 0..1 (deterministic). */
const noise = (g: number, salt: number): number => ((hash(g, salt, 101) >>> 3) % 1000) / 1000;

/** How far below the peak the snow reaches in column `g` (world px): the cap, then a gently ragged edge. */
function snowDepth(h: number, g: number): number {
  const s = (noise(g, 37) + noise(g + 1, 37)) / 2;
  return Math.round(h * (CAP + 0.1 * s));
}

/** Lighter ridges down Fuji's flanks: where each runs, as a fraction of the half-width (− = the sunlit left). */
const RIDGES = [-0.62, -0.38, -0.14, 0.12, 0.36, 0.6];

/** Mt Fuji: `h` tall on `base`, centred on `cx` — the cone hazing toward its foot, ridges, then the snow. */
function paintFuji(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, cx: number, base: number, h: number): void {
  const peak = base - h;
  // No rows on screen (ya ≥ yb) paints nothing below: every loop and the snow clamp to [ya, yb).
  const [ya, yb] = visibleRows(cam, view, peak, base);
  const step = rowStep(cam);
  const lit = lane(ctx, cam);
  const shade = lane(ctx, cam);
  const cap = Math.round(h * CAP);
  for (let y = ya; y < yb; y += step) {
    const n = Math.min(step, yb - y);
    const d = y - peak;
    const [x0, w] = run(cx, fujiHw(h, d + n / 2));
    // The crater: a notch in the very top row.
    if (d === 0 && w >= 7) {
      const notch = Math.max(1, Math.round(w / 6));
      lit.add(x0, y, (w >> 1) - notch, n, FUJI.snow);
      shade.add(cx + notch, y, x0 + w - cx - notch, n, FUJI.snowShade);
      continue;
    }
    const k = d / h;
    const level = d < cap ? -2 : k < 0.55 ? -1 : k < 0.72 ? 0 : k < 0.86 ? 1 : 2;
    const [cl, cs] =
      level === -2 ? [FUJI.snow, FUJI.snowShade] : level === -1 ? [FUJI.body, FUJI.shade] : [FUJI.haze[level], FUJI.hazeShade[level]];
    lit.add(x0, y, cx - x0, n, cl);
    shade.add(cx, y, x0 + w - cx, n, cs);
  }
  lit.flush();
  shade.flush();
  // Ridges below the snow: lighter streaks following the slope, two rows a step, merged into vertical runs.
  if (cam.zoom >= 1)
    for (const a of RIDGES) {
      const ridge = lane(ctx, cam);
      const from = Math.max(ya, peak + cap + Math.round(h * 0.06));
      const to = Math.min(yb, peak + Math.round(h * (0.6 + 0.12 * Math.abs(a))));
      for (let y = from; y < to; y += 2) ridge.add(cx + Math.round(a * fujiHw(h, y - peak + 1)), y, 1, Math.min(2, to - y), a < 0 ? FUJI.ridge : FUJI.ridgeShade);
      ridge.flush();
    }
  // The snow's ragged lower edge (2-px columns from the cap down to each one's depth), and every
  // third column a streak further down its ravine — fanning out with the slope, 2 px then 1.
  const capHw = Math.floor(fujiHw(h, cap));
  const yCap = Math.max(peak + cap, ya);
  for (let x = cx - capHw; x < cx + capHw; x += SNOW_COL) {
    const g = Math.floor((x - cx) / SNOW_COL);
    const colour = x < cx ? FUJI.snow : FUJI.snowShade;
    const depth = snowDepth(h, g);
    const bottom = Math.min(peak + depth, yb);
    if (bottom > yCap) rect(ctx, cam, x, yCap, SNOW_COL, bottom - yCap, colour);
    if (hash(g, 41, 7) % 3 !== 0) continue;
    const len = Math.round(h * (0.03 + 0.07 * noise(g, 53)));
    const streak = lane(ctx, cam);
    const spread = (x + 1 - cx) / fujiHw(h, depth);
    for (let y = Math.max(peak + depth, ya); y < Math.min(peak + depth + len, yb); y++) {
      const wide = y - peak - depth < (len * 2) / 3 ? 2 : 1;
      streak.add(cx + Math.round(spread * fujiHw(h, y - peak)) - (wide >> 1), y, wide, 1, colour);
    }
    streak.flush();
  }
}

// ───────────────────────────── the temples ─────────────────────────────

export type TempleKind = "pagoda" | "shrine";
type Tone = keyof typeof TEMPLE;
type Glow = keyof typeof TEMPLE_LIT;
const TONES = Object.keys(TEMPLE) as Tone[];
const GLOWS = Object.keys(TEMPLE_LIT) as Glow[];
/** The palettes as a temple's pixel grid indexes them (0 = empty). */
const DAY_COLOURS: readonly string[] = ["", ...TONES.map((t) => TEMPLE[t])];
const LIT_COLOURS: readonly string[] = ["", ...GLOWS.map((g) => TEMPLE_LIT[g])];

/** A row's run of one colour: [dx from the centre, width, palette index]. */
type Run = readonly [number, number, number];

/** A temple drawn at one height: columns −hw … hw − 1 round its centre, rows top-down. */
export interface TempleArt {
  hw: number;
  h: number;
  /** The day art: each row's runs (row 0 = the top). */
  day: Run[][];
  /** What glows at night: each row's runs of `TEMPLE_LIT` colours. */
  lit: Run[][];
  /** Each row's silhouette as [left, right) dx — symmetric, like all of the art. */
  span: (readonly [number, number])[];
  /** Soft halos round the lanterns at night: [dx, up from the foot, w, h]. */
  halos: (readonly [number, number, number, number])[];
  /** The day pixels (palette index, 0 = empty), row-major from the top: the exact shape the night sky masks. */
  grid: Uint8Array;
}

/** A blank grid for a temple `2·hw` wide and `h` tall, the tools to draw on it, and `finish` to turn it into runs. */
function sketch(hw: number, h: number) {
  const w = 2 * hw;
  const day = new Uint8Array(w * h);
  const lit = new Uint8Array(w * h);
  const halos: [number, number, number, number][] = [];
  /** Colour dx ∈ [a, b) on the row `up` px above the foot (what it covers stops glowing unless `glow` says). */
  const fill = (a: number, b: number, up: number, tone: Tone, glow?: Glow): void => {
    const row = (h - 1 - up) * w + hw;
    for (let x = a; x < b; x++) {
      day[row + x] = TONES.indexOf(tone) + 1;
      lit[row + x] = glow ? GLOWS.indexOf(glow) + 1 : 0;
    }
  };
  /** A row `half` px either side of the middle: the sunlit left in `light`, the right in `shade`. */
  const pair = (up: number, half: number, light: Tone, shade: Tone = light, glow?: Glow, glowShade: Glow | undefined = glow): void => {
    fill(-half, 0, up, light, glow);
    fill(0, half, up, shade, glowShade);
  };
  const runs = (grid: Uint8Array, y: number): Run[] => {
    const out: Run[] = [];
    for (let x = 0; x < w; ) {
      const c = grid[y * w + x];
      let e = x + 1;
      while (e < w && grid[y * w + e] === c) e++;
      if (c) out.push([x - hw, e - x, c]);
      x = e;
    }
    return out;
  };
  const finish = (): TempleArt => {
    const art: TempleArt = { hw, h, day: [], lit: [], span: [], halos, grid: day };
    for (let y = 0; y < h; y++) {
      const r = runs(day, y);
      art.day.push(r);
      art.lit.push(runs(lit, y));
      // Every row has something in it (the art is solid from its base to its tip).
      art.span.push([r[0][0], r[r.length - 1][0] + r[r.length - 1][1]]);
    }
    return art;
  };
  return { fill, pair, halos, finish };
}

type Sketch = ReturnType<typeof sketch>;

/** A pagoda's storey heights, bottom up (relative): the first storey the tallest, as on a real one. */
const STOREYS = [1.14, 1.04, 0.98, 0.93, 0.88];

/** One storey's roof, `rows` tall from row `up`: upturned tips two rows above the eave's middle,
 * sweeping concavely in to `topHalf`; a gold bell under each tip. */
function pagodaRoof(g: Sketch, up: number, rows: number, half: number, topHalf: number, detail: boolean): void {
  for (let r = 0; r < rows; r++) {
    const w = r < 3 ? half - [3, 1, 0][r] : Math.round(topHalf + (half - 2 - topHalf) * (1 - (r - 3) / Math.max(1, rows - 4)) ** 1.5);
    if (r === 0) {
      g.pair(up, w, "eave");
      continue;
    }
    g.pair(up + r, w, "roof", "roofShade");
    if (r < 3) {
      g.fill(-w, 1 - w, up + r, "eave");
      g.fill(w - 1, w, up + r, "eave");
    }
  }
  if (detail)
    for (const [y, tone] of [
      [up, "goldShade"],
      [up + 1, "gold"],
    ] as const) {
      g.fill(-half, 1 - half, y, tone);
      g.fill(half - 1, half, y, tone);
    }
}

/** A storey's wall row: vermilion pillars at the corners and the middle, cream panels between (lit warm at night). */
function pagodaWall(g: Sketch, up: number, half: number): void {
  g.fill(-half, 2 - half, up, "vermilion", "wall");
  g.fill(2 - half, -1, up, "cream", "panel");
  g.fill(-1, 0, up, "vermilion", "wall");
  g.fill(0, 1, up, "vermilionShade", "wallShade");
  g.fill(1, half - 2, up, "creamShade", "panelShade");
  g.fill(half - 2, half, up, "vermilionShade", "wallShade");
}

/** A five-storey pagoda `h` tall: stone base, five storeys narrowing upward, the sōrin spire. */
function pagodaArt(h: number, detail: boolean): TempleArt {
  const spireH = Math.round(h * 0.27);
  const baseH = Math.round(h * 0.035);
  const body = (s: number): number => Math.round(h * (0.08 - (0.022 * s) / 4));
  const eaves = (s: number): number => Math.round(h * (0.17 - (0.06 * s) / 4));
  const g = sketch(eaves(0), h);
  for (let up = 0; up < baseH; up++) {
    const top = up === baseH - 1;
    g.pair(up, body(0) + 3, top ? "stoneTop" : "stone", top ? "stoneTop" : "stoneShade");
  }
  const room = h - spireH - baseH;
  const total = STOREYS.reduce((a, b) => a + b, 0);
  let up = baseH;
  let sum = 0;
  STOREYS.forEach((weight, s) => {
    sum += weight;
    const top = baseH + Math.round((room * sum) / total);
    const roofRows = Math.round((top - up) / 2);
    const eaveRow = top - roofRows;
    const b = body(s);
    for (let y = up; y < eaveRow; y++) {
      // Under the eaves, the shadow of the brackets (lit from below at night); at the foot of every
      // storey but the first, its balcony's vermilion railing; between, the wall.
      if (y === eaveRow - 1) g.pair(y, b + 1, "bracket", "bracket", "eaves");
      else if (s > 0 && y === up) g.pair(y, b + 1, "vermilion", "vermilionShade", "wall", "wallShade");
      else pagodaWall(g, y, b);
    }
    pagodaRoof(g, eaveRow, roofRows, eaves(s), s < 4 ? body(s + 1) + 1 : 3, detail);
    up = top;
  });
  // The sōrin: dew basin, upturned bowl and lotus, nine rings on the mast, the water flame, the jewel.
  const row = (half: number, tone: Tone): void => g.pair(up++, half, tone);
  row(3, "spire");
  row(3, "spire");
  row(2, "spire");
  row(3, "ring");
  for (let k = 0; up < h - 4; k++) {
    // Zoomed out the rings would only shimmer: the ring section is drawn as one band.
    const mast = detail && k % 2 === 1;
    row(mast ? 1 : 2, mast ? "spire" : "ring");
  }
  row(2, "spire");
  row(2, "spire");
  row(1, "spire");
  row(1, "gold");
  return g.finish();
}

/** A shrine hall on its stone terrace, `h` tall and 1.25 h wide; the terrace lifts the hall clear
 * of the street's trees and lamps in front of it. */
function shrineArt(h: number, detail: boolean): TempleArt {
  const hw = Math.round(h * 0.62);
  const terrace = Math.round(h * 0.35);
  const bodyH = Math.round(h * 0.23);
  const roofH = h - terrace - bodyH - 2;
  const bodyHw = Math.round(h * 0.4);
  const doorHw = Math.round(bodyHw / 2);
  const ridgeHw = Math.round(hw * 0.45);
  const g = sketch(hw, h);
  // The terrace: courses of stone (a darker joint every fourth row), its top lighter; the steps.
  for (let up = 0; up < terrace; up++) {
    const top = up === terrace - 1;
    const joint = detail && !top && (terrace - 1 - up) % 4 === 0;
    g.pair(up, bodyHw + 7, top ? "stoneTop" : joint ? "riser" : "stone", top ? "stoneTop" : joint ? "riser" : "stoneShade");
    g.pair(up, doorHw - 4, (terrace - 1 - up) % 2 ? "riser" : "stoneTop");
  }
  // The hall: the veranda's edge, then pillars, white walls and the door bay, under the head beam.
  const floor = terrace;
  const beam = floor + bodyH - 1;
  g.pair(floor, bodyHw + 1, "bracket");
  for (let up = floor + 1; up < beam; up++) {
    g.fill(-bodyHw, 2 - bodyHw, up, "vermilion");
    g.fill(2 - bodyHw, -doorHw - 2, up, "cream");
    g.fill(-doorHw - 2, -doorHw, up, "vermilion");
    for (let x = -doorHw; x < doorHw; x++) {
      const bar = detail && ((x + doorHw) % 3 === 0 || (up - floor) % 3 === 0);
      g.fill(x, x + 1, up, bar ? "lattice" : "door", bar ? undefined : "door");
    }
    g.fill(doorHw, doorHw + 2, up, "vermilionShade");
    g.fill(doorHw + 2, bodyHw - 2, up, "creamShade");
    g.fill(bodyHw - 2, bodyHw, up, "vermilionShade");
  }
  g.pair(beam, bodyHw + 2, "vermilion", "vermilionShade");
  // The shimenawa, pillar to pillar under the beam, sagging in the middle — a twisted rope — and
  // the white shide hanging from it (zigzag paper; straight strips zoomed out).
  const rope = doorHw + 2;
  const sag = (x: number): number => (Math.abs(2 * x + 1) < rope ? 1 : 0);
  for (let x = -rope; x < rope; x++) {
    const twist = detail && (x + rope) % 4 < 2;
    g.fill(x, x + 1, beam - 1 - sag(x), twist ? "ropeShade" : "rope");
    g.fill(x, x + 1, beam - 2 - sag(x), twist ? "rope" : "ropeShade");
  }
  for (const f of [0.7, 0.25]) {
    const left = -Math.round(f * doorHw);
    for (let k = 1; k <= 3; k++) {
      const z = detail ? k % 2 : 0;
      const y = beam - 2 - sag(left) - k;
      g.fill(left + z, left + z + 1, y, "shide");
      g.fill(-1 - left - z, -left - z, y, "shide");
    }
  }
  // A stone lantern at either end of the terrace, its fire box lit at night inside a soft halo.
  const posts = Math.round(h * 0.2) - 7;
  for (const cx of [-bodyHw - 4, bodyHw + 4]) {
    let up = floor;
    const row = (half: number, light: Tone, shade: Tone = light): void => {
      g.fill(cx - half, cx, up, light);
      g.fill(cx, cx + half, up++, shade);
    };
    row(2, "stone", "stoneShade");
    for (let k = 0; k < posts; k++) row(1, "stone", "stoneShade");
    row(2, "stoneTop");
    g.halos.push([cx - 3, up - 1, 6, 4]);
    for (let k = 0; k < 2; k++) {
      row(2, "stone", "stoneShade");
      g.fill(cx - 1, cx + 1, up - 1, "fireBox", "fire");
    }
    row(3, "stoneShade");
    row(2, "stone", "stoneShade");
    row(1, "stone");
  }
  // The roof: the eave's lowest edge, its ends turned up, then the concave sweep to the ridge.
  const roof0 = floor + bodyH;
  for (let r = 0; r < roofH; r++) {
    const w = r < 4 ? hw - [4, 2, 1, 0][r] : Math.round(ridgeHw + (hw - 2 - ridgeHw) * (1 - (r - 4) / (roofH - 5)) ** 1.6);
    if (r === 0) {
      g.pair(roof0, w, "eave");
      continue;
    }
    g.pair(roof0 + r, w, "roof", "roofShade");
    if (r < 4) {
      g.fill(-w, 1 - w, roof0 + r, "eave");
      g.fill(w - 1, w, roof0 + r, "eave");
    }
  }
  // A gable over the entrance: a cream bargeboard in an inverted V, a gold ornament under its apex.
  const gableH = Math.round(roofH * 0.45);
  for (let k = 0; k <= gableH; k++) {
    const w = Math.max(1, Math.round((doorHw + 1) * (1 - k / gableH)));
    g.fill(-w, 1 - w, roof0 + 3 + k, "cream");
    g.fill(w - 1, w, roof0 + 3 + k, "creamShade");
  }
  g.pair(roof0 + 1 + gableH, 1, "gold", "goldShade");
  // The ridge with gold end caps flaring up and out, and a gold crest in the middle.
  const ridge = roof0 + roofH;
  g.pair(ridge, ridgeHw + 1, "eave");
  g.fill(-ridgeHw - 1, 1 - ridgeHw, ridge, "gold");
  g.fill(ridgeHw - 1, ridgeHw + 1, ridge, "goldShade");
  g.fill(-ridgeHw - 2, -ridgeHw, ridge + 1, "gold");
  g.fill(ridgeHw, ridgeHw + 2, ridge + 1, "goldShade");
  g.pair(ridge + 1, 1, "gold", "goldShade");
  return g.finish();
}

const temples = new Map<string, TempleArt>();

/** The temple `kind` drawn `h` px tall — with its fine details (bells, rings, lattice, rope twist) or without (zoomed out). Cached. */
export function templeArt(kind: TempleKind, h: number, detail: boolean): TempleArt {
  const key = `${kind}:${h}:${detail}`;
  let art = temples.get(key);
  if (!art) temples.set(key, (art = kind === "pagoda" ? pagodaArt(h, detail) : shrineArt(h, detail)));
  return art;
}

/** The art for `p` at this zoom: the details from zoom 1 up, where a pixel of them is a pixel on screen. */
function templeOf(p: PlacedLandmark, cam: Camera): TempleArt {
  return templeArt(p.spec.kind as TempleKind, p.h, cam.zoom >= 1);
}

/** Paints a temple's `rows` of `colours` runs, foot centred on (cx, base); a run repeated on the
 * next row grows into one rect. */
function paintRuns(
  ctx: DrawTarget,
  cam: Camera,
  view: { w: number; h: number },
  rows: readonly (readonly Run[])[],
  colours: readonly string[],
  cx: number,
  base: number,
): void {
  const top = base - rows.length;
  // No rows on screen (ya ≥ yb) paints nothing.
  const [ya, yb] = visibleRows(cam, view, top, base);
  let open = new Map<number, { dx: number; w: number; c: number; y0: number }>();
  const flush = (y1: number): void => {
    for (const o of open.values()) rect(ctx, cam, cx + o.dx, o.y0, o.w, y1 - o.y0, colours[o.c]);
  };
  for (let y = ya; y < yb; y++) {
    const next = new Map<number, { dx: number; w: number; c: number; y0: number }>();
    for (const [dx, w, c] of rows[y - top]) {
      const key = (dx + 1024) * 65536 + w * 64 + c;
      next.set(key, open.get(key) ?? { dx, w, c, y0: y });
      open.delete(key);
    }
    flush(y);
    open = next;
  }
  flush(yb);
}

/** A temple's silhouette as world-px rects [x, y, w, h], rows of equal span merged. */
function silhouette(art: TempleArt, cx: number, base: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = 0; y < art.h; ) {
    const [a, b] = art.span[y];
    let e = y + 1;
    // The art is symmetric, so an equal left edge is an equal span.
    while (e < art.h && art.span[e][0] === a) e++;
    out.push([cx + a, base - art.h + y, b - a, e - y]);
    y = e;
  }
  return out;
}

/** Clip to the view less `holes` (world-px rects that never overlap one another); undone by `restore`. */
function clipOut(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, holes: readonly (readonly [number, number, number, number])[]): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.w, view.h);
  for (const [x, y, w, h] of holes) {
    const a = sx(cam, x);
    const b = sy(cam, y);
    ctx.rect(a, b, sx(cam, x + w) - a, sy(cam, y + h) - b);
  }
  ctx.clip("evenodd");
}

// ───────────────────────────── the passes ─────────────────────────────

/** The landmarks of `layer` on screen this frame — where they stand in the world. Empty for a city without any. */
function visible(
  layer: LandmarkSpec["layer"],
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
): PlacedLandmark[] {
  const specs = landmarksFor(amb?.zone);
  if (specs.length === 0) return [];
  const out: PlacedLandmark[] = [];
  for (const p of placeLandmarks(world, horizonY, specs).placed)
    if (p.spec.layer === layer && onScreen(cam, view, p.x - p.hw, horizonY - p.h - 2, 2 * p.hw + 1, p.h + 2)) out.push(p);
  return out;
}

/** The farthest layer (Fuji): after the sky bands and the sun, before the clouds. */
export function paintFarLandmarks(
  ctx: DrawTarget,
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
): void {
  const list = visible("far", cam, world, view, amb, horizonY);
  if (list.length === 0) return;
  // A landmark on screen means a sky with a landmark city's zone (`visible`), so `amb` is there.
  ctx.globalAlpha = SEEN[amb!.weather].far;
  for (const p of list) paintFuji(ctx, cam, view, p.x, horizonY, p.h);
  ctx.globalAlpha = 1;
}

/** The towers, back to front (the table's order: the Skytree behind the nearer Tower): after the clouds, before the far skyline's blocks. */
export function paintLandmarks(
  ctx: DrawTarget,
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
  _timeMs: number,
): void {
  const list = visible("tower", cam, world, view, amb, horizonY);
  if (list.length === 0) return;
  ctx.globalAlpha = SEEN[amb!.weather].tower; // `amb` is there: see paintFarLandmarks.
  for (const p of list) {
    const kind = p.spec.kind as keyof typeof ART;
    paintTower(ctx, cam, view, ART[kind], kind === "skytree" ? SKYTREE : TOKYO_TOWER, p.x, horizonY, p.h, horizonY);
  }
  ctx.globalAlpha = 1;
}

/** true while aviation light with blink phase `phase` (ms) is on at `timeMs`. */
export function aviationOn(timeMs: number, phase: number): boolean {
  return (((timeMs + phase) % BLINK_MS) + BLINK_MS) % BLINK_MS < BLINK_MS / 2;
}

/** The temples: after the far skyline's blocks and panes (they stand nearer than that haze), before the street. */
export function paintNearLandmarks(
  ctx: DrawTarget,
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
  _timeMs: number,
): void {
  const list = visible("near", cam, world, view, amb, horizonY);
  if (list.length === 0) return;
  ctx.globalAlpha = SEEN[amb!.weather].near; // `amb` is there: see paintFarLandmarks.
  for (const p of list) paintRuns(ctx, cam, view, templeOf(p, cam).day, DAY_COLOURS, p.x, horizonY);
  ctx.globalAlpha = 1;
}

/** Night lights after the grade, in the night sky's clip (evening, dusk, night only). Tower lights
 * stop at the far skyline's haze top and skip temples across a tower's foot; temple lights never
 * land on the street's props. */
export function paintLandmarkLights(
  ctx: DrawTarget,
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
  timeMs: number,
): void {
  const lit = amb ? LIT[amb.phase] : undefined;
  if (!amb || lit === undefined) return;
  const towers = visible("tower", cam, world, view, amb, horizonY);
  const near = visible("near", cam, world, view, amb, horizonY);
  if (towers.length) {
    const haze = skylineMax(horizonY);
    // The temples in front of a tower's lights: those reaching above the haze across a tower's foot.
    const front = near.filter((p) => p.h > haze && towers.some((t) => Math.abs(t.x - p.x) < t.hw + p.hw));
    if (front.length) clipOut(ctx, cam, view, front.flatMap((p) => silhouette(templeOf(p, cam), p.x, horizonY)));
    const seen = Math.max(0.6, SEEN[amb.weather].tower);
    for (const p of towers) {
      const kind = p.spec.kind as keyof typeof ART;
      const art = ART[kind];
      ctx.globalAlpha = lit * seen;
      paintTower(ctx, cam, view, art, kind === "skytree" ? SKYTREE_LIT : TOKYO_TOWER_LIT, p.x, horizonY, p.h, horizonY - haze);
      ctx.globalAlpha = seen;
      for (const [f, phase] of art.lights) {
        if (!aviationOn(timeMs, phase)) continue;
        const y = horizonY - Math.round(f * p.h);
        rect(ctx, cam, p.x - 2, y - 2, 4, 4, AVIATION.glow);
        rect(ctx, cam, p.x - 1, y - 1, 2, 2, AVIATION.core);
      }
    }
    if (front.length) ctx.restore();
  }
  if (near.length) {
    // The props across the temples' width whose art reaches above the horizon (where the temples
    // stand — not the lounge's benches and kiosk under the street), as holes in the clip (they
    // never overlap: the street theme places each clear of every other's art, engine/streetTheme.ts).
    const x0 = Math.min(...near.map((p) => p.x - p.hw));
    const x1 = Math.max(...near.map((p) => p.x + p.hw));
    const props = world.props.map(artBox).filter((b) => b.col * TILE < x1 && (b.col + b.w) * TILE > x0 && b.row * TILE < horizonY);
    clipOut(ctx, cam, view, props.map((b) => [b.col * TILE, b.row * TILE, b.w * TILE, b.h * TILE] as const));
    ctx.globalAlpha = lit * Math.max(0.6, SEEN[amb.weather].near);
    for (const p of near) {
      const art = templeOf(p, cam);
      paintRuns(ctx, cam, view, art.lit, LIT_COLOURS, p.x, horizonY);
      for (const [dx, up, w, h] of art.halos) rect(ctx, cam, p.x + dx, horizonY - up - h, w, h, TEMPLE_LIT.glow);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

const ALL_LAYERS: readonly LandmarkSpec["layer"][] = ["far", "tower", "near"];

/** Night-sky mask: true where a landmark of `layers` stands at world (wx, wy) this frame (every
 * layer for stars and moon; `["near"]` for the skyline's lit windows). null when the city has
 * none. */
export function landmarkMask(
  cam: Camera,
  world: World,
  view: { w: number; h: number },
  amb: Ambience | undefined,
  horizonY: number,
  layers: readonly LandmarkSpec["layer"][] = ALL_LAYERS,
): ((wx: number, wy: number) => boolean) | null {
  const list = layers.flatMap((layer) => visible(layer, cam, world, view, amb, horizonY));
  if (list.length === 0) return null;
  return (wx, wy) =>
    list.some((p) => {
      const above = horizonY - wy;
      if (above <= 0 || above > p.h) return false;
      if (p.spec.layer === "near") {
        const art = templeOf(p, cam);
        const col = Math.floor(wx) - p.x + art.hw;
        return col >= 0 && col < 2 * art.hw && art.grid[(Math.floor(wy) - horizonY + p.h) * 2 * art.hw + col] !== 0;
      }
      return Math.abs(wx - p.x) <= profileHw(p, above) + 0.5;
    });
}

/** A far or tower landmark's half-width `above` world px over its foot (its profile; Fuji's flanks). */
function profileHw(p: PlacedLandmark, above: number): number {
  return p.spec.kind === "fuji" ? fujiHw(p.h, p.h - above) : p.h * profileAt(ART[p.spec.kind as keyof typeof ART].profile, above / p.h);
}

/** World columns [x0, x1) a far or tower landmark covers on row `wy` (`landmarkMask`'s test as one
 * interval), or null; lets backdrop lights cut by row. Not for temples (their art has holes). */
export function landmarkRow(p: PlacedLandmark, horizonY: number, wy: number): readonly [number, number] | null {
  const above = horizonY - wy;
  if (above <= 0 || above > p.h) return null;
  const hw = profileHw(p, above) + 0.5;
  return [Math.ceil(p.x - hw), Math.floor(p.x + hw) + 1];
}
