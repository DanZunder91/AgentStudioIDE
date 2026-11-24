/**
 * Agent Village — the City's TOWERS: HIGH-RISES standing up out of the haze, far behind the street — the
 * Shinjuku / Marunouchi / Shiodome skyline seen from across the city.
 *
 * At Fit in Tokyo, with only a strip of pale blocks a quarter as tall as a four-floor gazelle for a far
 * skyline, the sky behind the street is almost empty; the backdrop brings towers and big lit buildings
 * by night and by day. This layer answers the size: it gives the city BIG buildings behind it — these
 * towers, then the neon canyon (render/backdropCanyon.ts), then the yokochō shops
 * (render/backdropShops.ts) in front, with open sky between their clusters. The towers are part of the
 * City's Tokyo
 * backdrop (render/city.ts `backdropOf`: the Tokyo street theme paints them, any other city the haze
 * alone). It is the HIGH layer (render/backdrop.ts): painted after the clouds and before Tokyo Tower, the
 * Skytree and the classic haze, so its feet stand in the haze — or, in the open sky between clusters
 * (`airSpans`), on the street itself — and the landmarks' towers, the canyon and the shops stand in
 * front of it.
 *
 * BIG (sized against the sky alone, every tower would stand lower than a five-floor gazelle and read as
 * clutter, not a skyline — so a few big buildings rather than many): FEW, BIG skyscrapers, sized against the world's tallest building, rising past the
 * world's top into the open sky Fit shows over it.
 *
 * THE LAYOUT is world-locked, like the haze's (`forEachSkylineBlock`): the world is cut into fixed
 * CHUNKS of `CHUNK` px, and each chunk holds one loose CLUSTER of 0–2 towers — often none, open sky —
 * placed from a hash of the chunk's index alone, at least `MARGIN` in from either end, so two clusters
 * always have sky between them and a pan or a zoom never re-rolls a tower. Inside a cluster, towers
 * stand a few px apart or overlap a little, one in front of the other (the nearer a shade darker: aerial
 * perspective), around a DISTRICT height — a Shinjuku cluster is tall, a Shiodome one lower: one of them
 * stands at the district's height, 1.3–1.8× the world's TALLEST building's height over the street in
 * whole percents, the other at 62–100 % of it:
 *   - so the tallest rise well over that roof, and every tower stays at least 2 tiles over the haze's
 *     tallest block (`skylineMax`);
 *   - widths 5–10 tiles, never wider than 0.6 of the height (a low city's would be squat warehouses).
 *
 * UNDER THE SKYTREE (no high-rise stands taller than the Skytree, Japan's tallest structure): no
 * tower — its mast or tank included — rises over `UNDER_SKYTREE` (0.9) of the city's Skytree as
 * render/landmarks.ts places it (`capOf`, read, never assumed). Where the rule's tallest would rise
 * over that cap, the whole range of heights is drawn down into it (`heightOf`), so the towers keep
 * their spread rather than all stopping at one roofline; a mast that still would is scaled under it,
 * keeping its kind. In the reference city (gazelle 416 px, the Skytree 576) that caps them at
 * 518 px; in a tall one, whose Skytree's tip stops 5 tiles over the world's top, it keeps them inside
 * Fit's frame. With no Skytree (no landmarks), the rule above alone.
 *
 * THE SIGNATURE skyscraper (a bigger building of this kind behind the tallest, such as gazelle): one per
 * World, centred behind its tallest building, 0.55 of its width (never under 5 tiles), 1.8× its height
 * or 0.9× the Skytree, the lower — so a good part of it stands over that roof (102 px over the reference
 * city's gazelle, 25 %) — a twin, a setback or a mast by a hash of where the building
 * stands, its crown band lit faintly at night; no cluster's tower stands within `SIGNATURE_SKY` of it. A
 * function of the World alone (`signatureOf`), world-locked like the rest.
 *
 * The layout is built once per World (the signature) and chunk by chunk (memoised), and read by `paint`,
 * `paintLights` and `faceAt` alike, so the face the stars hide behind is exactly what is painted.
 *
 * SIX SILHOUETTES (`TOWER_KINDS`), one per tower by hash: a flat-top glass slab (a water tank or a plant
 * room on its roof); a stepped setback crown (solid machine floors on a glass shaft); twin glass tops on
 * a shared shaft, a notch of sky between them (the Metropolitan Government Building); a slanted roof, the
 * glass running up into it; a helipad (a pale deck, a pale "H" on a dark panel); and an antenna mast
 * with a red light at its tip. Each is a few column PARTS — `[x0, x1, top]`, a rect from `top` down to
 * the horizon — merged into one disjoint outline (`envelope`): the silhouette is one fill a part, and
 * `faceAt` is a lookup in it. Its GLASS says, column by column, where the grid starts (under a solid
 * crown, a parapet, a notch of sky).
 *
 * LANDMARKS: this layer stands in front of Fuji only, so no roof — mast and tank included — rises into
 * Fuji's snow cap (`roofLimit(…, ["far"])`: landmarks are never hidden). A tower that would becomes a
 * setback (no mast, no tank) lowered under the cap, never below the haze clearance; where even that
 * would rise into it, it is not built at all. The signature skyscraper is capped the same way but
 * never left out (no clearance floor: behind its building at worst). Tokyo Tower and the Skytree
 * stand in front of this layer, so nothing of it can hide them.
 *
 * BY DAY: glass curtain walls in cool blue-grey — lighter and bluer than the world's own buildings, a
 * little darker than the sky — as a glass-coloured outline with the FRAME laid over it: a 1-px mullion
 * between every two pane columns and the floor lines across, from the tower's glass down (render/city.ts
 * `paneColumns`: columns + floors rects a tower, never a rect per window); parapets, a lighter edge on
 * the sun's side (left in the morning, right from noon), darker machine floors in the crowns. The colours
 * are the DAY colours turned as the haze's own colour is turned through the day (`paletteOf`: a dusk
 * lilac, a night navy), so the towers stand in the haze at every hour; the shared grade goes over both.
 * Nothing is painted where it cannot show: below a tower's COVER — a nearer tower of its cluster, or a
 * building of the world, which the frame paints over the backdrop (a detail a roof crosses keeps what is
 * above it; a 1–2 px floor line it crosses goes, at most a px of it) — nor its floor lines below the haze's
 * tallest block (only its mullions reach on down to the shortest's top, below which only the haze's
 * 1-px slits show) — except in the open sky between clusters (empty space left between them), where no
 * haze stands in front and all of a tower shows, its grid down to the street. Below `PANE_ZOOM` the
 * panes would be a 1-px checkerboard: the mullions stay at the walls only and every other floor line
 * goes.
 *
 * BY NIGHT (`paintLights`, after the grade, every light through `fillLit`) — CALM (zoomed ×2 into a City
 * at night, these towers' floor-wide lit bars beside the neon looked overloaded; the towers are the
 * farthest layer, the dimmest): single WINDOWS, a 2×2-px light every third pane of a
 * floor, an eighth of them lit at full night (big towers have many windows: few lit keep the night
 * calm), each at its own fixed threshold (the `windowLit` idiom) weighed by its floor's occupancy
 * (`BUSY`: some floors dark, some busy), so as `lit` rises the same windows come on first every evening;
 * a dim warm mostly, some cool white, at alpha 0.35–0.55 — under the apartments, the canyon and the shops
 * in front. One tower in four wears a faint crown band in cool white or pale blue (the signature always),
 * and red aviation lights blink on every roof and mast (`AVIATION`, `aviationOn`), each light on its own
 * phase. A light falls only on glass that shows — above the haze, or down to the street in the open sky:
 * a nearer tower or a building cuts it here; the haze, the canyon, the shops and the landmarks in
 * `fillLit`.
 *
 * WEATHER: far things fade first — the layer is painted at the alpha landmarks.ts gives its "tower"
 * layer in each weather (`SEEN`, copied: it is not exported there), its lights at least 0.6 of that.
 *
 * COST — Chromium, the reference city at Fit, 1280×800 @2x (zoom 1), ≈ 12 towers in view: by day ≈ 840
 * rects (the open sky's floor lines among them), 0.32–0.35 ms on a quiet machine — most of it the fill
 * AREA of big glass faces (≈ 380k px²), the JS 0.05 ms; at night ≈ 700 lit windows, ≈ 0.1 ms of its own
 * (a hash a window, dark floors skipped), ≈ 0.3–0.35 ms through a cutter of the haze and the canyon's and
 * shops' faces. At 1280×800 @1x (zoom 9/16) ≈ 0.17 ms by day; zoomed ×2 on the street 0.04 ms
 * (backdropTowers.browser.test.tsx measures them). A frame walks only the chunks in view; each chunk's
 * towers are built once per World.
 */

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

/**
 * The DAY colours. Three tints of cool blue-grey glass, farthest (lightest, bluest — aerial perspective)
 * first: a cluster's nearer towers take the darker ones. All lighter and bluer than the world's own
 * buildings, darker than the sky they stand in; the grade turns them to dusk and night.
 */
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

/**
 * The lit windows: one window every `WINDOW` px across a floor (between the mullions: every third pane of
 * a fine grid or fins, one to a ribbon pane), a 2×2-px light in it; the share of windows lit is
 * `WINDOWS_LIT` of the far skyline's `lit` — an eighth at full night — and their alpha 0.35–0.55: the
 * towers are the farthest layer, dimmer than the apartments, the canyon and the shops in front.
 */
const WINDOW = 9;
const WINDOWS_LIT = 0.3;
/** A floor's occupancy, ×the mean share, by a hash of the floor: three floors in ten dark, the rest 0.8–2.2× (the mean is 1). */
const BUSY = [0, 0, 0, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2.2] as const;

/** A frame's colours: the three tints and the fixed inks. */
type Palette = { tints: readonly TowerTint[] } & Record<Exclude<Ink, "crown" | "frame">, string>;

const rgbOf = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/**
 * The colours to paint with this frame: the DAY colours, each channel scaled as the haze's own colour is
 * now against its day colour (`citySky(amb).skyline.block` / `CITY_DAY.skyline`). The haze is painted in
 * colours of its own through the day — a dusk lilac, a night navy — which the grade then goes over; the
 * towers stand in that haze, so they take the same turn, keeping their own offsets from it: lighter
 * frames, darker glass. Through the plain day the haze is its day colour, the scale 1, and the towers
 * exactly `TOWER`. (No channel ever passes 255: the haze is never more than 1.04 of its day colour in a
 * channel, the lightest ink's brightest channel (239) never past 249 — the tests sweep the clock in every weather.)
 */
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
/**
 * Heights against the world's TALLEST building (its height over the street): a cluster's tallest stands
 * 1.3–1.8× as tall, in whole hundredths; the haze clearance every tower keeps besides.
 */
const TALL_MIN = 130; // percent
const TALL_STEPS = 51; // 130, 131 … 180 %
export const CLEAR = 2 * TILE;
/**
 * The SIGNATURE skyscraper behind the tallest building: `SIGNATURE_H` of its height, `SIGNATURE_W` of its
 * width (never under 5 tiles), centred on it, one of `SIGNATURE_KINDS`; `SIGNATURE_SKY` of sky kept
 * either side of it (a cluster's tower that would stand nearer is left out).
 */
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
/**
 * A stretch of a tower's width: over x0 ≤ x < x1 its glass grid starts at y `glass` (under a solid
 * crown, a parapet, a notch of sky), what stands in front of it at y `cover` (the horizon: nothing), and
 * whether it stands in the backdrop's OPEN sky (`airSpans`), where no haze stands in front of its foot.
 */
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
  /**
   * What stands in front of it across its width (contiguous, left to right): a nearer tower of its
   * cluster, a building of the world — or nothing (the horizon). Below it nothing of the tower shows, so
   * nothing of it is painted there by day, nor lit by night.
   */
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

/**
 * A tower's glass and its cover — two contiguous lists over its width — cut at both's breaks and at the
 * edges of the open sky (`air`, the stretches over its width): [x0, x1, glass, cover, open] a stretch.
 */
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

/**
 * A tower of `kind`, x .. x + w, its roof `h` above the horizon: its silhouette and its glass, its day
 * marks (parapets, crowns, tank, pad, mast), its crown band and its beacons. `hh` picks the variants.
 */
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

/**
 * The tallest a tower may stand here, its tip — a mast's, a tank's — included (no high-rise
 * stands taller than the Skytree, Japan's tallest structure): `UNDER_SKYTREE` of the city's
 * Skytree as it is placed (render/landmarks.ts sizes it; this reads it). With no Skytree, no cap.
 */
function capOf(world: World, amb: Ambience | undefined, horizon: number): number {
  const skytree = placeLandmarks(world, horizon, landmarksFor(amb?.zone)).placed.find((p) => p.spec.kind === "skytree");
  return skytree ? Math.floor(UNDER_SKYTREE * skytree.h) : Infinity;
}

/**
 * The height of a tower of `share` × the tallest building's height (`base`), under the Skytree's `cap`:
 * where the rule's tallest (1.8 × base) would rise over it, the whole range is drawn down into it — its
 * lowest as it was (or 0.85 of the cap), its tallest at the cap — so the towers keep their spread and
 * their order rather than all stopping at one roofline.
 */
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

/**
 * The SIGNATURE skyscraper (a bigger tall dark high-rise with sparse windows, behind the tallest
 * building, such as gazelle): centred behind
 * the world's tallest building, `SIGNATURE_W` of its width and `SIGNATURE_H` of its height — so a good
 * part of it stands over that roof — a twin, a setback or a mast by a hash of where the building stands.
 * A function of the World alone: world-locked. Every World with a building has one.
 */
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

/**
 * The tower of hash `hh` at x, `w` wide, `h` tall, of `kind` (by default, by the hash) — lowered, its kind
 * kept, until its tip stands no taller than `cap` (`capOf`: under the Skytree); and where it would still
 * rise into Fuji's snow cap (`roofLimit`), a setback (no mast, no tank: its roof the top of it), lowered
 * under the cap but never below `least`; null when even that would rise into it.
 */
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

/**
 * Over [a, b), each stretch of a tower's `cells` where a row from `top` down to `bottom` shows whole —
 * nothing in front of it reaches above `bottom`; for `glass`, its glass starts at or above `top`; and a
 * row ending below `deep` (the haze's top) only in the open sky — as one `visit(x0, x1)`: a row is one
 * rect wherever nothing breaks it. (Indexed, no destructuring: a slanted crown has a cell per 2 px,
 * walked once per floor.)
 */
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

/**
 * How far down a tower's glass shows behind the haze: its mullions run to the haze's SHORTEST block's
 * top (below it only the haze's 1-px slits show), its floor lines and lit floors only to the TALLEST's —
 * a mullion costs one rect however long, a floor one rect a floor, and between the haze's blocks of all
 * heights a tower's foot reads as its mullions alone. In the open sky (no haze) all of it reaches the street.
 */
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

/**
 * A light of tower `t` through `fillLit`: the parts of it in view that nothing in front of the tower
 * covers — and, for a lit floor (`glass`), that are glass, above the haze or in the open sky (`deep`).
 */
function emit(s: BackdropLightScene, c: Clip, t: Tower, glass: boolean, deep: number, x: number, y: number, w: number, h: number): void {
  const top = Math.max(y, c.y0);
  const bottom = Math.min(y + h, c.y1);
  // What shows is decided on the whole light, never on the part in view: world-locked.
  if (top < bottom) rowRuns(t.cells, y, y + h, glass, deep, Math.max(x, c.x0), Math.min(x + w, c.x1), (a, b) => s.fillLit(a, top, b - a, bottom - top));
}

/**
 * The lit windows of tower `t`: per floor, a window every `WINDOW` px, each lit when `lit` passes its own
 * threshold — a hash of its place, weighed by its floor's occupancy (`BUSY`: some floors busy, some
 * dark), so as `lit` rises the same windows come on first every evening, and an eighth are lit at full
 * night, scattered like offices, never a floor-wide bar (zoomed in at night, those look overloaded).
 */
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
