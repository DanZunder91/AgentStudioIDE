/** The neon canyon, a MID layer: zakkyo clusters between quiet stretches, laid out per cluster so
 * pans never re-roll them; the featured words and karaoke box carry the neon, the rest stays calm.
 * Lights go through `fillLit` as one cached raster per cluster (one per rect costs too much). */

import { TILE, type Ambience, type World } from "../villageTypes";
import { AIR_CHUNK, airSpans, quietSpans, roofLimit, SIGN_WORDS, type BackdropLayer, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { subtract, type Box } from "./backdropLights";
import type { Camera } from "./camera";
import { defaultMakeLayer } from "./ground";
import { KANA_H, KANA_W, kanaText, type Run } from "./kana";
import { landmarksFor, placeLandmarks, type LandmarkSpec } from "./landmarks";
import { neonFlicker, neonStrength } from "./neon";
import { hash, onScreen, sx, sy } from "./paint";
import type { DrawTarget, SpriteImage } from "./renderTypes";

// ───────────────────────────── geometry ─────────────────────────────

/** World px of a storey (1¼ tiles), and how many a building has (before a crown or the sky lowers it). */
export const STOREY = 20;
export const FLOORS_MIN = 5;
export const FLOORS_MAX = 9;
/** World px of the parapet over the top storey. */
const PARAPET = 3;
/** A building is 48..80 px wide in steps of 8 — the last of a cluster takes what is left, up to 95. */
const MIN_W = 48;
const W_STEP = 8;
const W_CHOICES = 5;
/** A blade with glyphs `k` times the font's size: a glyph, a px of air, a tube and a rim either side. */
export const bladeWidth = (k: number): number => KANA_W * k + 6;
/** World px from a blade's ends to its text, and how far it stands up past its building's parapet. */
const BLADE_PAD = 3;
export const BLADE_RISE = 6;
/** World px of bare wall between two stacked blade plates: with less, "すし" over "ラーメン" reads
 * as one made-up word. */
export const PLATE_GAP = 5;
/** A signboard: a glyph and 2 px of plastic over and under it. */
export const PANEL_H = KANA_H + 4;
/** A billboard's panel: 16..22 px tall, on a 2-px plinth. */
const BILLBOARD_H = 16;
/** The share of a city's sky (less a tile) the canyon may stand up into: a low city's stays low. */
export const SKY_SHARE = 0.62;
/** World px over the tallest roof the canyon's art and light can reach (a billboard, a halo): generous. */
const OVER_ROOF = 2 * STOREY;
/** Below this zoom a 1-px detail is under ¾ of a screen px: glyphs become bars, mullions go (render/city.ts's PANE_ZOOM). */
const PANE_ZOOM = 0.75;
/** How long a video screen holds a scene; one cluster in this many has one; its light at night, of a sign's. */
export const SCENE_MS = 2600;
const SCREEN_EVERY = 4;
export const SCREEN_GLOW = 0.6;
/** The windows' lit share is stepped this finely: a raster is painted again per step, not per frame. */
const LIT_STEPS = 32;
/** Share of the City's `s.lit` that lights canyon windows (≈ 30 % at full night); the rest are
 * vacant flats, never lit. */
const WINDOW_SHARE = 0.6;
/** A blade's halo in world px (the giant's twice that) and alpha: the canyon's only halos, all
 * round the featured words. */
const HALO = 3;
const HALO_ALPHA = 0.14;
/** Rasters kept for at most this many clusters (≤ ≈ 250 KB each), or every cluster in a bigger
 * view plus a few; the least recently painted go first. */
export const MAX_RASTERS = 40;

/** The featured words, two a blade in turn along every cluster; each karaoke box spells カラオケ
 * on its own. */
export const FEATURED: readonly string[] = ["ラーメン", "ソバ", "すし", "カラオケ"];
const KARAOKE = "カラオケ";
const WORDS = SIGN_WORDS.map((w) => w.text);

// ───────────────────────────── colours ─────────────────────────────

/** A facade's tones (DAY): its wall, the shade of its seams and slabs, its parapet's cap and its glass. */
interface Tone {
  wall: string;
  shade: string;
  cap: string;
  glass: string;
}

/** A signboard's plastic: its colour by day and lit from behind, and its ink by day and lit. */
interface Plastic {
  day: string;
  lit: string;
  ink: string;
  inkLit: string;
}

/** A neon tube: its colour lit, and its glass unlit by day. */
interface Tube {
  lit: string;
  day: string;
}

/** `#rrggbb` mixed `t` of the way towards `#rrggbb` `to`. */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** `#rrggbb` as `rgba(…, a)`. */
function rgba(color: string, a: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The air between the street and the canyon: a day colour seen through it is `t` nearer its blue. */
const AIR = "#a9c0d8";
const haze = (color: string, t = 0.16): string => mix(color, AIR, t);

/** The palette, exported for tests. Day colours are seen through a little air (`haze`); at night
 * the `lit` colours are the light itself, painted after the grade, never graded. */
export const CANYON_ART = {
  facades: [
    { wall: "#adb2bb", shade: "#91979f", cap: "#c6cad1", glass: "#6c7c92" }, // concrete
    { wall: "#c0b4a3", shade: "#a2978a", cap: "#d6cdc0", glass: "#6f7d90" }, // beige tile
    { wall: "#b29ca1", shade: "#968287", cap: "#c9b9bc", glass: "#6c788e" }, // rose tile
    { wall: "#8b97a9", shade: "#748092", cap: "#a6afbe", glass: "#5c6b84" }, // slate
    { wall: "#a3afa7", shade: "#89968e", cap: "#bdc8c1", glass: "#687a8f" }, // pale green
    { wall: "#cbc9c3", shade: "#acaaa5", cap: "#dfded9", glass: "#748296" }, // white tile
    { wall: "#737885", shade: "#5f6470", cap: "#8d929e", glass: "#4c5872" }, // charcoal
  ].map((t) => ({ wall: haze(t.wall, 0.1), shade: haze(t.shade, 0.1), cap: haze(t.cap, 0.1), glass: haze(t.glass, 0.1) })) as readonly Tone[],
  plastics: [
    { day: "#d8544b", lit: "#ff4a3c", ink: "#fbf4e8", inkLit: "#fffaf0" }, // red, white letters
    { day: "#e6c350", lit: "#ffd633", ink: "#b5322a", inkLit: "#d01c0c" }, // yellow, red letters
    { day: "#ebe7dd", lit: "#fff4d6", ink: "#c8382e", inkLit: "#ff2414" }, // white, red letters
    { day: "#dde5ef", lit: "#eef4ff", ink: "#2d58a6", inkLit: "#1452ff" }, // ice blue, blue letters
    { day: "#4e7ecb", lit: "#2f8cff", ink: "#f4f1e6", inkLit: "#ffffff" }, // blue
    { day: "#4ca46b", lit: "#22d872", ink: "#f4f1e6", inkLit: "#ffffff" }, // green
    { day: "#e1863f", lit: "#ff8c26", ink: "#fff2df", inkLit: "#ffffff" }, // orange
    { day: "#d46ca1", lit: "#ff4fb4", ink: "#fff2f7", inkLit: "#ffffff" }, // pink
    { day: "#8968c4", lit: "#a85cff", ink: "#ffe88a", inkLit: "#fff27a" }, // purple, yellow letters
    { day: "#4cb2c5", lit: "#22e8ff", ink: "#16304a", inkLit: "#06263f" }, // cyan, navy letters
  ].map((p) => ({ ...p, day: haze(p.day), ink: haze(p.ink) })) as readonly Plastic[],
  tubes: [
    { lit: "#ff4fa8", day: "#e6b5cf" }, // pink
    { lit: "#3ff2ff", day: "#b3e2e8" }, // cyan
    { lit: "#ffe34a", day: "#ebdfa8" }, // yellow
    { lit: "#5cff7a", day: "#b6e3be" }, // green
    { lit: "#ff4a3a", day: "#e8b2ab" }, // red
    { lit: "#5a8dff", day: "#b5c4e8" }, // blue
    { lit: "#ffa040", day: "#ecc9a6" }, // orange
    { lit: "#c66bff", day: "#d4bce8" }, // violet
  ].map((t) => ({ ...t, day: haze(t.day) })) as readonly Tube[],
  /** The dark glass behind a blade's tubes. */
  back: haze("#2a2632"),
  /** Steel: a billboard's frame and plinth, a screen's bezel. */
  steel: haze("#4b4d59"),
  /** A shop front's glass by day, its rolled-down shutter, and what a lit one glows (warm, white, pink, mint). */
  shop: haze("#3d3b47"),
  shutter: haze("#8e939d"),
  /** The karaoke box's giant blade: pink neon in a violet frame. */
  karaoke: { tube: { lit: "#ff4fa8", day: haze("#e6b5cf") }, frame: { lit: "#c66bff", day: haze("#d4bce8") } },
  /** A water tank and its bands. */
  tank: haze("#c7ccd3"),
  tankBand: haze("#9ea5b0"),
  /** At night a facade sinks back behind its signs (a veil over the grade), which then wash it in their colour. */
  veil: "rgba(10, 8, 28, 0.38)",
  /** A lit window: mostly a dim warm, now and then a cool white — nothing glaring (the calm pass). */
  windows: ["#e6cf98", "#e6cf98", "#e6cf98", "#cfd8e6"] as readonly string[],
  /** A billboard's graphics (abstract, never a brand), and the lamps on its plinth. */
  billboard: ["#ef6f4f", "#f6c75a", "#4fa3e3", "#3f5fae", "#f4efe4", "#e45d9b", "#55b88a", "#2c2f45"].map((c) => haze(c)) as readonly string[],
  sun: haze("#ffd25a"),
  lamp: "#fff6d8",
  /** What the video screens play (light: they are never hazed). */
  screen: ["#ff3d7f", "#ffd23d", "#3dd7ff", "#7dff5a", "#ffffff", "#a45cff", "#ff8a3d", "#2a2fff"] as readonly string[],
} as const;

// ───────────────────────────── glyphs ─────────────────────────────

/** 9×7 pictograms a signboard may wear instead of a word (`X` = ink). Our own. */
const PICTOS: Readonly<Record<string, readonly string[]>> = {
  bowl: ["..X.X.X..", "..X.X.X..", ".........", "XXXXXXXXX", "XXXXXXXXX", ".XXXXXXX.", "..XXXXX.."],
  cup: [".X..X....", "..X..X...", ".........", "XXXXXXX..", "XXXXXXX.X", "XXXXXXXX.", ".XXXXX..."],
  mic: ["...XXX...", "..XXXXX..", "..XXXXX..", "...XXX...", "....X....", "....X....", "..XXXXX.."],
  mug: ["XXXXXX...", "X.X.XXXX.", "XXXXXX.X.", "XXXXXX.X.", "XXXXXX.X.", "XXXXXXX..", "XXXXXX..."],
  glass: ["XXXXXXXXX", ".XXXXXXX.", "..XXXXX..", "...XXX...", "....X....", "....X....", "..XXXXX.."],
  heart: [".XXX.XXX.", "XXXXXXXXX", "XXXXXXXXX", ".XXXXXXX.", "..XXXXX..", "...XXX...", "....X...."],
  star: ["....X....", "...XXX...", "XXXXXXXXX", ".XXXXXXX.", "..XXXXX..", ".XXX.XXX.", "XX.....XX"],
};
const PICTO_W = 9;
const PICTO_H = 7;

/** A pictogram as row runs, each run merged down into an identical one under it (kana.ts's idiom). */
function pictoRuns(rows: readonly string[]): Run[] {
  const out: [number, number, number, number][] = [];
  let above: [number, number, number, number][] = [];
  rows.forEach((row, y) => {
    const here: [number, number, number, number][] = [];
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "X") {
        x++;
        continue;
      }
      const x0 = x;
      while (row[x] === "X") x++;
      const same = above.find((r) => r[0] === x0 && r[2] === x - x0);
      if (same) {
        same[3]++;
        here.push(same);
      } else {
        const r: [number, number, number, number] = [x0, y, x - x0, 1];
        out.push(r);
        here.push(r);
      }
    }
    above = here;
  });
  return out;
}

/** Every pictogram's runs, in a fixed order. Exported for the tests. */
export const PICTO_RUNS: readonly Run[][] = Object.values(PICTOS).map(pictoRuns);
/** A signboard hash that picks the mic (`signboard` picks a pictogram by `hs >>> 12`). */
const MIC = Object.keys(PICTOS).indexOf("mic") << 12;

const TEXTS = new Map<string, ReturnType<typeof kanaText>>();
/** `kanaText(word, vertical)`, laid out once per word and direction. */
function text(word: string, vertical: boolean): ReturnType<typeof kanaText> {
  const key = (vertical ? "|" : "-") + word;
  let t = TEXTS.get(key);
  if (!t) TEXTS.set(key, (t = kanaText(word, vertical)));
  return t;
}

/** One plate of a blade: its word, its offset from the blade's top, its height and its text. */
interface Plate {
  word: string;
  y: number;
  h: number;
  t: ReturnType<typeof kanaText>;
}

/** `words` on plates hung top to bottom `PLATE_GAP` apart, each at `k` × the font size,
 * `BLADE_PAD` in from its ends: the plates and the blade's height. */
function hung(words: readonly string[], k: number): { plates: Plate[]; h: number; k: number } {
  const plates: Plate[] = [];
  let y = 0;
  for (const word of words) {
    const t = text(word, true);
    const h = 2 * BLADE_PAD + k * t.h;
    plates.push({ word, y, h, t });
    y += h + PLATE_GAP;
  }
  return { plates, h: y - PLATE_GAP, k };
}

// ───────────────────────────── the layout ─────────────────────────────

/** When a piece of art is painted: at every zoom, only from PANE_ZOOM up, or only below it (its stand-in). */
type Detail = 0 | 1 | 2;
const ALL: Detail = 0;
const FINE: Detail = 1;
const COARSE: Detail = 2;

/** Rects of one colour at one depth: flat [x, y, w, h, …] world px — a window's, [x, y, w, h, threshold ‰, …]. */
interface Batch {
  color: string;
  detail: Detail;
  rects: number[];
}

/** A neon blade's letters: the seed of its stutter, and each glyph's cell (world px). */
interface Blade {
  seed: number;
  cells: Box[];
}

/** A video screen: its picture's world box (inside the bezel) and its seed. */
export interface CanyonScreen {
  box: Box;
  seed: number;
}

/** A building of the canyon as it stands (for the tests): its span, storeys and roof's world y. */
export interface CanyonBuilding {
  x: number;
  w: number;
  floors: number;
  top: number;
}

/** A sign a passer-by could read: its word and where it is (for the tests and the PR). */
export interface CanyonSign {
  text: string;
  vertical: boolean;
  box: Box;
}

/** A light raster: a cluster's lights in world px, as a pattern to fill with. */
interface Raster {
  pattern: CanvasPattern;
  /** The windows' lit share it was painted at (a `LIT_STEPS` step). */
  level: number;
}

/** A cluster's rasters, made when first painted: its day art, and its lights fine and coarse. */
interface Rasters {
  day: SpriteImage | null;
  fine: Raster | null;
  coarse: Raster | null;
}
const NO_RASTERS = (): Rasters => ({ day: null, fine: null, coarse: null });

/** A cluster of the canyon, laid out and compiled once per World. */
interface Cluster {
  /** Where it starts in the world, and the world y of its face per column from there (`horizon` where nothing stands). */
  x0: number;
  face: Int16Array;
  /** Its ground, one stretch or two (the city's span may cut it): no light falls past it. */
  ground: [number, number][];
  /** The day's art and the night's lights, in paint order; the windows, by colour. */
  day: Batch[];
  /** The box all its day art falls in (null: none — all of it behind the world's buildings). */
  art: Box | null;
  lights: Batch[];
  windows: Batch[];
  /** The box all its lights fall in (null: none — all of it behind the world's buildings). */
  lit: Box | null;
  blades: Blade[];
  screen: CanyonScreen | null;
  signs: CanyonSign[];
  buildings: CanyonBuilding[];
  rasters: Rasters;
}

/** The canyon of one World, for one horizon and one city's landmarks. */
interface Canyon {
  world: World;
  amb: Ambience | undefined;
  horizon: number;
  specs: readonly LandmarkSpec[];
  /** The temples' boxes: no light is lit inside them (see the file comment). */
  temples: Box[];
  clusters: Map<number, Cluster>;
  /** The air span of each air chunk asked about (a cluster runs from one to the next). */
  air: Map<number, [number, number]>;
}

const MEMO = new WeakMap<World, Canyon>();

/** The canyon of `world` (only the City paints one: it has a city) — laid out afresh for a new horizon or city. */
function canyonOf(world: World, amb: Ambience | undefined, horizon: number): Canyon {
  const specs = landmarksFor(amb?.zone);
  const hit = MEMO.get(world);
  if (hit && hit.horizon === horizon && hit.specs === specs) return hit;
  // As render/city.ts `frontShapes` boxes them.
  const temples = placeLandmarks(world, horizon, specs)
    .placed.filter((p) => p.spec.layer === "near")
    .map((p): Box => [p.x - p.hw, horizon - p.h - 2, 2 * p.hw + 1, p.h + 2]);
  const out: Canyon = { world, amb, horizon, specs, temples, clusters: new Map(), air: new Map() };
  MEMO.set(world, out);
  return out;
}

/** Cluster `c` of the canyon, laid out on first use. */
function clusterOf(m: Canyon, c: number): Cluster {
  let ch = m.clusters.get(c);
  if (!ch) m.clusters.set(c, (ch = layoutCluster(m, c)));
  return ch;
}

/** Collects a cluster's art by depth, detail and colour; none is ever behind a world building
 * (those all stand in the city's quiet span). */
class Compiler {
  private readonly day: Map<string, Batch>[] = [];
  private readonly light: Map<string, Batch>[] = [];
  private readonly panes: Map<string, Batch>[] = [];
  readonly face: Int16Array;
  /** A cluster starting at world x `x0`, `w` wide, on a street whose top is `horizon`. */
  constructor(
    private readonly x0: number,
    w: number,
    horizon: number,
  ) {
    this.face = new Int16Array(w).fill(horizon);
  }

  private put(layers: Map<string, Batch>[], depth: number, detail: Detail, color: string, rect: number[]): void {
    const layer = (layers[depth] ??= new Map());
    const key = detail + color;
    let b = layer.get(key);
    if (!b) layer.set(key, (b = { color, detail, rects: [] }));
    b.rects.push(...rect);
  }

  /** A rect of the day's art at `depth` (0 = the walls, painted first). */
  art(depth: number, detail: Detail, color: string, x: number, y: number, w: number, h: number): void {
    this.put(this.day, depth, detail, color, [x, y, w, h]);
  }

  /** A rect of the night's light at `depth` (0 = the veils, 1 the halos, 2 the lit plastic, 3 the ink). */
  glow(depth: number, detail: Detail, color: string, x: number, y: number, w: number, h: number): void {
    this.put(this.light, depth, detail, color, [x, y, w, h]);
  }

  /** A pane that lights up once the windows' lit share passes its own threshold (‰, a hash of its place). */
  window(color: string, x: number, y: number, w: number, h: number): void {
    this.put(this.panes, 0, ALL, color, [x, y, w, h, hash(x, y, 557) % 1000]);
  }

  /** Opaque up to world y `top` over [x, x + w): each call stands higher than the ones before
   * there (walls, roof objects, blade), so it is simply the face. */
  stand(x: number, w: number, top: number): void {
    this.face.fill(top, x - this.x0, x + w - this.x0);
  }

  /** The batches, depth by depth. */
  batches(): { day: Batch[]; lights: Batch[]; windows: Batch[] } {
    const flat = (layers: Map<string, Batch>[]) => layers.flatMap((l) => [...l.values()]);
    return { day: flat(this.day), lights: flat(this.light), windows: flat(this.panes) };
  }
}

/** One building's choices: hashes of its cluster and its place in it. */
interface Plan {
  x: number;
  w: number;
  floors: number;
  tone: Tone;
  /** Its blade: on the left wall (or the right), its words, neon (or plastic boxes), its colours — and a second plate's, never the first's. */
  left: boolean;
  words: string[];
  neon: boolean;
  tube: Tube;
  frame: Tube;
  box: Plastic;
  second: { tube: Tube; frame: Tube; box: Plastic };
  /** Its roof: 0 nothing, 1 a billboard, 2 a water tank, 3 a stair house. */
  roof: number;
  /** It wears signs at all (about half the buildings do; the rest are windows only). */
  signed: boolean;
  /** It is the cluster's karaoke box: a giant pink カラオケ, its signboards mics. */
  karaoke: boolean;
  /** It has the cluster's video screen. */
  screen: boolean;
  hh: number;
}

/** What stands on a roof, by a hash: a billboard, a tank or a stair house one time in five each. */
const ROOFS: readonly number[] = [1, 2, 3, 0, 0];

/** The air span [start, end) in air chunk `a` (render/backdrop.ts `airSpans`), remembered. */
function airOf(m: Canyon, a: number): [number, number] {
  let span = m.air.get(a);
  if (!span) m.air.set(a, (span = airSpans(a * AIR_CHUNK, (a + 1) * AIR_CHUNK)[0]));
  return span;
}

/** Cluster `c`'s span [x0, x1): its ground from the end of air span `c` (`airSpans`), plus the
 * next stretch of air, left open. */
function spanOf(m: Canyon, c: number): [number, number] {
  return [airOf(m, c)[1], airOf(m, c + 1)[1]];
}

/** The cluster holding world x (see `spanOf`). */
function clusterAt(m: Canyon, x: number): number {
  const a = Math.floor(x / AIR_CHUNK);
  return x < airOf(m, a)[1] ? a - 1 : a;
}

/** Cluster `c`'s ground: up to the next stretch of air, less the city's own (quiet) span, where
 * calm apartments stand instead. One stretch or two, none too narrow for a building. */
function groundOf(m: Canyon, c: number): [number, number][] {
  let a = airOf(m, c)[1];
  const b = airOf(m, c + 1)[0];
  const out: [number, number][] = [];
  for (const [q0, q1] of quietSpans(m.world, a, b)) {
    if (q0 - a >= MIN_W) out.push([a, q0]);
    a = q1;
  }
  if (b - a >= MIN_W) out.push([a, b]);
  return out;
}

/** Cluster `c`'s buildings, 48..80 px wide by hash (the last takes the rest, 48..95), every other
 * one signed. Clusters of 4+ get a karaoke box (tallest of 56+ px), one in four a video screen.
 * Signed blades alternate `FEATURED` pairs, so any two signed neighbours show all four. */
function plansOf(m: Canyon, c: number): Plan[] {
  const plans: Plan[] = [];
  let i = 0;
  for (const [g0, g1] of groundOf(m, c))
    for (let x = g0, rem = g1 - g0; rem > 0; i++) {
      const hh = hash(c, i, 389);
      // Too little ground left for two buildings: the last takes all of it.
      const w = rem < 2 * MIN_W ? rem : Math.min(MIN_W + W_STEP * (hh % W_CHOICES), rem - MIN_W);
      const pick = <T>(list: readonly T[], salt: number): T => list[hash(c, i, salt) % list.length];
      /** Another of `list` than `one`, by a hash. */
      const other = <T>(list: readonly T[], one: T, salt: number): T => list[(list.indexOf(one) + 1 + (hash(c, i, salt) % (list.length - 1))) % list.length];
      const tube = pick(CANYON_ART.tubes, 405);
      const frame = pick(CANYON_ART.tubes, 407);
      const box = pick(CANYON_ART.plastics, 411);
      plans.push({
        x,
        w,
        floors: FLOORS_MIN + ((hh >>> 3) % (FLOORS_MAX - FLOORS_MIN + 1)),
        tone: pick(CANYON_ART.facades, 401),
        left: (hh >>> 11) % 2 === 0,
        words: [],
        neon: (hh >>> 16) % 3 !== 0,
        tube,
        frame,
        box,
        second: { tube: other(CANYON_ART.tubes, tube, 415), frame: other(CANYON_ART.tubes, frame, 417), box: other(CANYON_ART.plastics, box, 423) },
        roof: pick(ROOFS, 409),
        signed: (i + hash(c, 0, 431)) % 2 === 0,
        karaoke: false,
        screen: false,
        hh,
      });
      x += w;
      rem -= w;
    }
  const best = (ok: (p: Plan) => boolean, by: (p: Plan) => number): Plan | undefined =>
    plans.reduce<Plan | undefined>((a, p) => (ok(p) && (!a || by(p) > by(a)) ? p : a), undefined);
  const box = plans.length >= 4 ? best((p) => p.w >= 56, (p) => p.floors) : undefined;
  if (box) Object.assign(box, { signed: true, karaoke: true, words: [KARAOKE], neon: true, tube: CANYON_ART.karaoke.tube, frame: CANYON_ART.karaoke.frame });
  const screen = hash(c, 0, 433) % SCREEN_EVERY === 0 ? plans.find((p) => p.signed && !p.karaoke && p.w >= 64) : undefined;
  if (screen) screen.screen = true;
  // The rest of the signed, two featured words each, in turn: (1, 2), (3, 4), (1, 2)… from a place of the cluster's own.
  const n = FEATURED.length;
  let j = hash(c, 0, 397) % n;
  for (const p of plans)
    if (p.signed && !p.karaoke) {
      p.words = [FEATURED[j % n], FEATURED[(j + 1) % n]];
      j += 2;
    }
  return plans;
}

/** Lay out cluster `c`: its buildings, each lowered under any crown it would cover, compiled. */
function layoutCluster(m: Canyon, c: number): Cluster {
  const [x0, x1] = spanOf(m, c);
  const out = new Compiler(x0, x1 - x0, m.horizon);
  const blades: Blade[] = [];
  const signs: CanyonSign[] = [];
  const buildings: CanyonBuilding[] = [];
  let screen: CanyonScreen | null = null;
  plansOf(m, c).forEach((p, i) => {
    const made = building(m, out, p, c, i);
    blades.push(...made.blades);
    screen ??= made.screen;
    signs.push(...made.signs);
    buildings.push(made.stands);
  });
  const { day, lights, windows } = out.batches();
  return { x0, face: out.face, ground: groundOf(m, c), day, art: boxOf(day, []), lights, windows, lit: boxOf(lights, windows), blades, screen, signs, buildings, rasters: NO_RASTERS() };
}

/** The box every rect of `batches` and `windows` falls in, or null when there is none. */
function boxOf(batches: Batch[], windows: Batch[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (r: number[], step: number) => {
    for (let i = 0; i < r.length; i += step) {
      x0 = Math.min(x0, r[i]);
      y0 = Math.min(y0, r[i + 1]);
      x1 = Math.max(x1, r[i] + r[i + 2]);
      y1 = Math.max(y1, r[i + 1] + r[i + 3]);
    }
  };
  for (const b of batches) take(b.rects, 4);
  for (const b of windows) take(b.rects, 5);
  return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
}

/** One building into the cluster. Landmark crowns (`roofLimit`) and `SKY_SHARE` cut its height:
 * roof object first, then storeys (never the last); its blade is the biggest that still fits. */
function building(
  m: Canyon,
  out: Compiler,
  p: Plan,
  c: number,
  i: number,
): { blades: Blade[]; screen: CanyonScreen | null; signs: CanyonSign[]; stands: CanyonBuilding } {
  const { horizon } = m;
  const { x, w, tone } = p;
  const limit = Math.max(roofLimit(m.world, m.amb, horizon, x, x + w, ["far", "tower"]), horizon - Math.round(SKY_SHARE * (horizon - TILE)));
  const roofH = [0, BILLBOARD_H + 2 + 3 * (p.hh % 3), 9, 9][p.roof];
  let floors = p.floors;
  let roof = p.roof;
  const roofOf = (f: number) => horizon - f * STOREY - PARAPET;
  const reach = () => roofOf(floors) - Math.max(roof ? roofH : 0, BLADE_RISE);
  if (reach() < limit) roof = 0;
  while (floors > 1 && reach() < limit) floors--;
  const top = roofOf(floors);
  const stands = { x, w, floors, top };
  // The blade (a signed building's): the biggest of its candidates that the building is tall enough to wear.
  const blade = p.signed ? [hung(p.words, p.karaoke ? 2 : 1), hung(p.words.slice(0, 1), 1)].find((b) => top - BLADE_RISE + b.h <= horizon - STOREY) : undefined;
  // The column of signboards and windows: the face less the blade's side (the whole face without one).
  const bw = bladeWidth(blade?.k ?? 1);
  const bladeX = p.left ? x + 3 : x + w - 3 - bw;
  const rx0 = blade && p.left ? bladeX + bw + 2 : x + 3;
  const rx1 = blade && !p.left ? bladeX - 2 : x + w - 3;
  const rw = rx1 - rx0;

  // ── the walls, and at night their veil: the facades sink back behind their signs ──
  out.art(0, ALL, tone.wall, x + 1, top, w - 1, horizon - top);
  out.art(0, ALL, tone.shade, x, top, 1, horizon - top);
  out.art(1, ALL, tone.cap, x + 1, top, w - 1, 1);
  out.stand(x, w, top);
  out.glow(0, ALL, CANYON_ART.veil, x, top, w, horizon - top);

  // ── the storeys, top down: a slab line, then a row of windows — or, on a signed building's storeys
  // (a third of them at most, never two in a row), a signboard ──
  const screenAt = p.screen && floors >= 6 ? floors - 2 : -1;
  const signs: CanyonSign[] = [];
  let screen: CanyonScreen | null = null;
  let boards = p.signed ? Math.floor(floors / 3) : 0;
  let below = -1;
  let last = -2;
  for (let s = floors - 1; s >= 1; s--) {
    const ft = horizon - STOREY * (s + 1);
    out.art(1, FINE, tone.shade, x + 1, ft, w - 1, 1);
    if (s === screenAt) {
      // A video screen over this storey and the next: a steel bezel round a picture painted per frame.
      const bh = 2 * STOREY - 5;
      out.art(2, ALL, CANYON_ART.steel, rx0, ft + 3, rw, bh);
      screen = { box: [rx0 + 1, ft + 4, rw - 2, bh - 2], seed: hash(c, i, 433) };
      s--;
      continue;
    }
    const hs = hash(c, i * 16 + s, 413);
    if (boards === 0 || s === last - 1 || hs % 3 === 0) {
      windows(out, tone, rx0, ft + 6, rw);
      continue;
    }
    boards--;
    last = s;
    // Each signboard a different colour from the one under it.
    let k = (hs >>> 4) % CANYON_ART.plastics.length;
    if (k === below) k = (k + 1) % CANYON_ART.plastics.length;
    below = k;
    // The karaoke box's signboards: mics.
    const kind = 2 + ((hs >>> 2) % 8);
    const sign = signboard(out, CANYON_ART.plastics[k], (hs >>> 9) % 8 !== 0, rx0, ft + 3, rw, p.karaoke && kind < 8 ? 5 : kind, p.karaoke ? MIC : hs);
    if (sign) signs.push(sign);
    out.art(2, FINE, tone.shade, rx0, ft + 3 + PANEL_H, rw, 1);
  }

  // ── the ground floor: a shop front (a signed building's under a coloured fascia), or a shutter rolled
  // down — its lights single windows of the bays, never a lit band ──
  const gf = horizon - STOREY;
  const shop = hash(c, i, 419);
  out.art(1, FINE, tone.shade, x + 1, gf, w - 1, 1);
  if (p.signed) out.art(1, ALL, CANYON_ART.plastics[(shop >>> 5) % CANYON_ART.plastics.length].day, x + 1, gf + 2, w - 1, 3);
  if (shop % 4 === 0) {
    out.art(1, ALL, CANYON_ART.shutter, x + 3, gf + 6, w - 6, STOREY - 6);
    for (let y = gf + 8; y < horizon - 1; y += 3) out.art(2, FINE, tone.shade, x + 3, y, w - 6, 1);
  } else {
    out.art(1, ALL, CANYON_ART.shop, x + 3, gf + 6, w - 6, STOREY - 6);
    // Bays of 12 px, each a window of light when lit.
    for (let bx = x + 3; bx < x + w - 3; bx += 12) {
      if (bx > x + 3) out.art(2, FINE, tone.shade, bx, gf + 6, 1, STOREY - 6);
      if (x + w - 3 - bx >= 9) out.window(CANYON_ART.windows[hash(bx, gf, 571) % CANYON_ART.windows.length], bx + 3, gf + 9, 6, 8);
    }
  }

  // ── the roof ──
  if (roof === 1) billboard(out, rx0 + 1, top, rw - 2, roofH - 2, p.hh);
  else if (roof === 2) {
    const tx = p.left ? rx1 - 12 : rx0 + 2;
    out.art(1, ALL, CANYON_ART.tankBand, tx, top - 2, 10, 2);
    out.art(1, ALL, CANYON_ART.tank, tx + 1, top - 9, 8, 7);
    out.art(2, FINE, CANYON_ART.tankBand, tx + 1, top - 7, 8, 1);
    out.art(2, FINE, CANYON_ART.tankBand, tx + 1, top - 4, 8, 1);
    out.stand(tx, 10, top - 2);
    out.stand(tx + 1, 8, top - 9);
  } else if (roof === 3) {
    const hx = p.left ? rx1 - 16 : rx0 + 2;
    out.art(1, ALL, tone.shade, hx, top - 9, 14, 9);
    out.art(2, ALL, tone.cap, hx, top - 9, 14, 1);
    out.art(2, ALL, CANYON_ART.shop, hx + 3, top - 6, 3, 6);
    out.stand(hx, 14, top - 9);
  }

  // ── the blade: a plate a word, hung one under the other ──
  const blades: Blade[] = [];
  if (!blade) return { blades, screen, signs, stands };
  const by = top - BLADE_RISE;
  const k = blade.k;
  const tx = bladeX + 3;
  const bar = 3 * k;
  const barX = tx + Math.floor((KANA_W * k - bar) / 2);
  const r = k * HALO;
  out.stand(bladeX, bw, by);
  blade.plates.forEach((plate, j) => {
    const { tube, frame, box } = j === 0 ? p : p.second;
    const py = by + plate.y;
    const ty = py + BLADE_PAD;
    const ph = plate.h;
    signs.push({ text: plate.word, vertical: true, box: [bladeX, py, bw, ph] });
    // Under the first, two steel hangers across the bare wall it hangs from.
    if (j > 0) for (const hx of [bladeX + 2, bladeX + bw - 4]) out.art(2, ALL, CANYON_ART.steel, hx, py - PLATE_GAP, 2, PLATE_GAP);
    /** The plate's word in `color`: its glyphs (fine), or a bar (coarse) — by day, or lit. */
    const word = (lit: boolean, color: string) => {
      const put = lit ? out.glow : out.art;
      for (const [dx, dy, w2, h2] of plate.t.runs) put.call(out, 3, FINE, color, tx + k * dx, ty + k * dy, k * w2, k * h2);
      put.call(out, 3, COARSE, color, barX, ty, bar, k * plate.t.h);
    };
    if (!p.neon) {
      // A plastic box, lit from behind at night.
      out.art(2, ALL, box.day, bladeX, py, bw, ph);
      word(false, box.ink);
      out.glow(1, ALL, rgba(box.lit, HALO_ALPHA), bladeX - r, py - r, bw + 2 * r, ph + 2 * r);
      out.glow(2, ALL, box.lit, bladeX, py, bw, ph);
      word(true, box.inkLit);
      return;
    }
    // Neon: tubes on dark glass — by day unlit, at night lit in one soft halo (the giant's wider).
    out.art(2, ALL, CANYON_ART.back, bladeX, py, bw, ph);
    tubeFrame(out, false, frame.day, bladeX, py, bw, ph);
    word(false, tube.day);
    out.glow(1, ALL, rgba(tube.lit, HALO_ALPHA), bladeX - r, py - r, bw + 2 * r, ph + 2 * r);
    tubeFrame(out, true, frame.lit, bladeX, py, bw, ph);
    word(true, tube.lit);
    // Each plate its own sign: its own stutter, a glyph's cell at a time.
    blades.push({ seed: hash(p.hh, j, 439), cells: [...plate.word].map((_, n): Box => [tx, ty + k * n * (KANA_H + 1), k * KANA_W, k * KANA_H]) });
  });
  return { blades, screen, signs, stands };
}

/** The 1-px tube round a neon blade, a px in from its edge: by day (fine detail), or lit. */
function tubeFrame(out: Compiler, lit: boolean, color: string, bx: number, by: number, bw: number, bh: number): void {
  const put = (x: number, y: number, w: number, h: number) => (lit ? out.glow(2, ALL, color, x, y, w, h) : out.art(3, FINE, color, x, y, w, h));
  put(bx + 1, by + 1, bw - 2, 1);
  put(bx + 1, by + bh - 2, bw - 2, 1);
  put(bx + 1, by + 2, 1, bh - 4);
  put(bx + bw - 2, by + 2, 1, bh - 4);
}

/** World px of a window, and of the wall between two. */
const WIN_W = 3;
const WIN_H = 6;
const WIN_GAP = 3;

/** A row of single windows across [x, x + w) at y, each lit once the lit share passes its own
 * threshold (vacant flats never: `WINDOW_SHARE`). */
function windows(out: Compiler, tone: Tone, x: number, y: number, w: number): void {
  for (let px = x + 1; px + WIN_W <= x + w - 1; px += WIN_W + WIN_GAP) {
    out.art(1, ALL, tone.glass, px, y, WIN_W, WIN_H);
    out.window(CANYON_ART.windows[hash(px, y, 571) % CANYON_ART.windows.length], px, y, WIN_W, WIN_H);
  }
}

/** A signboard over [x, x + w) × [y, y + PANEL_H): kana (kind 2–4), pictogram (5–7) or plain
 * plastic (8–9), back-lit at night unless closed (`lit`). Returns the word it shows, if any. */
function signboard(out: Compiler, plastic: Plastic, lit: boolean, x: number, y: number, w: number, kind: number, hs: number): CanyonSign | null {
  out.art(2, ALL, plastic.day, x, y, w, PANEL_H);
  if (lit) out.glow(2, ALL, plastic.lit, x, y, w, PANEL_H);
  const ink = (dx: number, dy: number, rw: number, rh: number, detail: Detail) => {
    out.art(3, detail, plastic.ink, x + dx, y + dy, rw, rh);
    if (lit) out.glow(3, detail, plastic.inkLit, x + dx, y + dy, rw, rh);
  };
  const pick = hs >>> 12;
  if (kind < 5) {
    const fits = WORDS.filter((word) => text(word, false).w + 4 <= w);
    const word = fits[pick % fits.length];
    const t = text(word, false);
    const tx = Math.floor((w - t.w) / 2);
    for (const [dx, dy, rw, rh] of t.runs) ink(tx + dx, 2 + dy, rw, rh, FINE);
    ink(tx, 4, t.w, KANA_H - 4, COARSE);
    return { text: word, vertical: false, box: [x, y, w, PANEL_H] };
  }
  if (kind < 8) {
    const px = Math.floor((w - PICTO_W) / 2);
    const py = Math.floor((PANEL_H - PICTO_H) / 2);
    for (const [dx, dy, rw, rh] of PICTO_RUNS[pick % PICTO_RUNS.length]) ink(px + dx, py + dy, rw, rh, FINE);
    ink(px + 2, py + 2, PICTO_W - 4, PICTO_H - 3, COARSE);
    return null;
  }
  if (pick % 2) ink(0, 4, w, 3, ALL);
  else ink(w - 9, 2, 7, PANEL_H - 4, ALL);
  return null;
}

/** A rooftop billboard over [x, x + w): an abstract graphic (never a brand) on a 2-px plinth at
 * `roof`, lit at night by lamps on the plinth. */
function billboard(out: Compiler, x: number, roof: number, w: number, h: number, hh: number): void {
  const top = roof - 2 - h;
  const pal = CANYON_ART.billboard;
  const a = pal[(hh >>> 4) % pal.length];
  const b = pal[((hh >>> 4) + 1 + ((hh >>> 8) % (pal.length - 1))) % pal.length];
  out.art(1, ALL, CANYON_ART.steel, x, top, w, h + 2);
  out.stand(x, w, top);
  const ix = x + 1;
  const iy = top + 1;
  const iw = w - 2;
  const ih = h - 2;
  /** A piece of the graphic, by day — and at night half lit by the lamps under it. */
  const paint = (depth: number, color: string, rx: number, ry: number, rw: number, rh: number) => {
    out.art(depth, ALL, color, rx, ry, rw, rh);
    out.glow(depth, ALL, rgba(color, 0.5), rx, ry, rw, rh);
  };
  const q = Math.floor(iw / 4);
  switch ((hh >>> 16) % 4) {
    case 0: {
      // A sun over the sea.
      paint(2, a, ix, iy, iw, ih - 4);
      paint(2, b, ix, iy + ih - 4, iw, 4);
      const cx = ix + Math.floor(iw / 2);
      paint(3, CANYON_ART.sun, cx - 2, iy + ih - 9, 5, 6);
      paint(3, CANYON_ART.sun, cx - 3, iy + ih - 8, 7, 4);
      break;
    }
    case 1:
      // Upright stripes.
      for (let j = 0; j < 4; j++) paint(2, pal[((hh >>> 4) + j) % pal.length], ix + j * q, iy, j === 3 ? iw - 3 * q : q, ih);
      break;
    case 2:
      // A wave: a stepped crest across a field.
      paint(2, a, ix, iy, iw, ih);
      [4, 7, 5, 8].forEach((up, j) => paint(3, b, ix + j * q, iy + ih - up, j === 3 ? iw - 3 * q : q, up));
      break;
    default:
      // Three dots on a field.
      paint(2, a, ix, iy, iw, ih);
      for (let j = 1; j <= 3; j++) paint(3, b, ix + Math.floor(((iw - 6) * j) / 4), iy + Math.floor((ih - 6) / 2), 6, 6);
  }
  out.glow(3, ALL, CANYON_ART.lamp, x + 2, roof - 2, 2, 1);
  out.glow(3, ALL, CANYON_ART.lamp, x + w - 4, roof - 2, 2, 1);
}

// ───────────────────────────── the screens ─────────────────────────────

/** A video screen's rects [colour, x, y, w, h] at `timeMs`, in paint order, inside its box. Each
 * `SCENE_MS` scene and its colours are a hash of the screen and scene number. Pure. */
export function screenScene(sc: CanyonScreen, timeMs: number): [string, number, number, number, number][] {
  const n = Math.floor(timeMs / SCENE_MS);
  const t = (timeMs - n * SCENE_MS) / SCENE_MS;
  const h = hash(sc.seed, n, 449);
  const pal = CANYON_ART.screen;
  const a = pal[(h >>> 4) % pal.length];
  const b = pal[((h >>> 4) + 1 + ((h >>> 8) % (pal.length - 1))) % pal.length];
  const [x, y, w, hh] = sc.box;
  const out: [string, number, number, number, number][] = [];
  /** A rect clipped to the screen. */
  const put = (color: string, rx: number, ry: number, rw: number, rh: number) => {
    const x0 = Math.max(x, rx);
    const y0 = Math.max(y, ry);
    const x1 = Math.min(x + w, rx + rw);
    const y1 = Math.min(y + hh, ry + rh);
    if (x1 > x0 && y1 > y0) out.push([color, x0, y0, x1 - x0, y1 - y0]);
  };
  switch (h % 5) {
    case 0:
      for (let j = 0; j < 5; j++) {
        const x0 = x + Math.floor((w * j) / 5);
        put(pal[(j + n) % pal.length], x0, y, x + Math.floor((w * (j + 1)) / 5) - x0, hh);
      }
      break;
    case 1: {
      put(a, x, y, w, hh);
      put(b, x, y + hh - 6, w, 6);
      const cx = x + Math.floor(w / 2);
      const cy = y + hh - 4 - Math.round(t * (hh - 10));
      put("#ffffff", cx - 3, cy - 4, 7, 9);
      put("#ffffff", cx - 4, cy - 3, 9, 7);
      break;
    }
    case 2:
      put(a, x, y, w, hh);
      put(b, x, y, Math.round(t * w), hh);
      break;
    case 3: {
      const word = text(WORDS[(h >>> 12) % WORDS.length], false);
      put(a, x, y, w, hh);
      const ox = x + w - Math.round(t * (w + 2 * word.w));
      const oy = y + Math.floor((hh - 2 * KANA_H) / 2);
      for (const [dx, dy, rw, rh] of word.runs) put(b, ox + 2 * dx, oy + 2 * dy, 2 * rw, 2 * rh);
      break;
    }
    default:
      for (let j = 0; j <= Math.floor(t * 3) + 1; j++) put(j % 2 ? b : a, x + 3 * j, y + 3 * j, w - 6 * j, hh - 6 * j);
  }
  return out;
}

// ───────────────────────────── painting ─────────────────────────────

/** The clusters over world x ∈ [x0, x1), left to right. */
function clustersIn(m: Canyon, x0: number, x1: number): Cluster[] {
  const out: Cluster[] = [];
  for (let c = clusterAt(m, x0); spanOf(m, c)[0] < x1; c++) out.push(clusterOf(m, c));
  return out;
}

/** Is any of the canyon's band — over its tallest roof down to the street — on screen? */
function inView(cam: Camera, view: { h: number }, horizon: number): boolean {
  return sy(cam, horizon) > 0 && sy(cam, horizon - FLOORS_MAX * STOREY - PARAPET - OVER_ROOF) < view.h;
}

/** Fill a world-px rect in the current fillStyle, edges snapped like `rect` — nothing wholly off the view. */
function fillWorld(ctx: DrawTarget, cam: Camera, view: { w: number; h: number }, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  const rw = Math.max(1, sx(cam, wx + w) - x);
  const rh = Math.max(1, sy(cam, wy + h) - y);
  if (x < view.w && y < view.h && x + rw > 0 && y + rh > 0) ctx.fillRect(x, y, rw, rh);
}

/** Day pass per cluster in view: at a whole zoom its day raster in one `drawImage` (pixel for
 * pixel its rects); below 1 or without a canvas, batches rect by rect. Then the screen's scene. */
function paint(s: BackdropScene): void {
  if (!inView(s.cam, s.view, s.horizon)) return;
  const { ctx, cam, view } = s;
  const skip = cam.zoom >= PANE_ZOOM ? COARSE : FINE;
  const clusters = clustersIn(canyonOf(s.world, s.amb, s.horizon), s.x0, s.x1);
  ctx.globalAlpha = 1;
  for (const ch of clusters) {
    const art = cam.zoom >= 1 && ch.art && onScreen(cam, view, ...ch.art) ? dayRaster(ch, clusters.length) : null;
    if (art) {
      const [x, y, w, h] = ch.art as Box;
      ctx.drawImage(art, 0, 0, w, h, sx(cam, x), sy(cam, y), w * cam.zoom, h * cam.zoom);
    } else
      for (const b of ch.day) {
        if (b.detail === skip) continue;
        ctx.fillStyle = b.color;
        const r = b.rects;
        for (let i = 0; i < r.length; i += 4) fillWorld(ctx, cam, view, r[i], r[i + 1], r[i + 2], r[i + 3]);
      }
    for (const [color, x, y, w, h] of ch.screen ? screenScene(ch.screen, s.timeMs) : []) {
      ctx.fillStyle = color;
      fillWorld(ctx, cam, view, x, y, w, h);
    }
  }
}

/** The clusters holding rasters, least recently painted first. */
const HELD = new Set<Cluster>();

/** Mark cluster `ch` most recently painted; past `MAX_RASTERS` (or `inView` and a few more) the
 * least recent loses its rasters. */
function hold(ch: Cluster, inView: number): void {
  HELD.delete(ch);
  HELD.add(ch);
  if (HELD.size <= Math.max(MAX_RASTERS, inView + 4)) return;
  const old = HELD.values().next().value as Cluster;
  HELD.delete(old);
  old.rasters = NO_RASTERS();
}

/** A blank raster of `w`×`h` world px and its context, or null where the host has no 2D canvas (jsdom). */
function blank(w: number, h: number): { image: SpriteImage; g: DrawTarget } | null {
  const layer = defaultMakeLayer(w, h);
  return layer && { image: layer.image, g: layer.ctx };
}

/** Paint `batches` (rects every `step` numbers, kept when `keep` says so) into a raster whose origin is world (x0, y0). */
function fillInto(g: DrawTarget, batches: Batch[], step: number, x0: number, y0: number, keep: (b: Batch, i: number) => boolean): void {
  for (const b of batches) {
    g.fillStyle = b.color;
    for (let i = 0; i < b.rects.length; i += step) if (keep(b, i)) g.fillRect(b.rects[i] - x0, b.rects[i + 1] - y0, b.rects[i + 2], b.rects[i + 3]);
  }
}

/** Cluster `ch`'s day art with its fine detail, painted once into a raster in world px; null without a canvas. */
function dayRaster(ch: Cluster, inView: number): SpriteImage | null {
  hold(ch, inView);
  if (ch.rasters.day) return ch.rasters.day;
  const [x0, y0, w, h] = ch.art as Box;
  const r = blank(w, h);
  if (!r) return null;
  fillInto(r.g, ch.day, 4, x0, y0, (b) => b.detail !== COARSE);
  return (ch.rasters.day = r.image);
}

/** Cluster `ch`'s lights at lit share `level` (fine or coarse art), painted once into a world-px
 * raster pattern; null without a canvas. */
function lightRaster(ch: Cluster, coarse: boolean, level: number, inView: number): Raster | null {
  hold(ch, inView);
  const slot = coarse ? "coarse" : "fine";
  const had = ch.rasters[slot];
  if (had?.level === level) return had;
  const [x0, y0, w, h] = ch.lit as Box;
  const r = blank(w, h);
  if (!r) return null;
  // The veils, halos, lit plastic and ink, depth by depth; then the windows lit at this share.
  const skip = coarse ? FINE : COARSE;
  fillInto(r.g, ch.lights, 4, x0, y0, (b) => b.detail !== skip);
  fillInto(r.g, ch.windows, 5, x0, y0, (b, i) => b.rects[i + 4] < level * WINDOW_SHARE * 1000);
  const pattern = (r.g as unknown as { createPattern(image: SpriteImage, repeat: string): CanvasPattern }).createPattern(r.image, "no-repeat");
  return (ch.rasters[slot] = { pattern, level });
}

/** Night pass at `neonStrength`: per cluster in view, one `fillLit` of its light raster less
 * temple boxes and stuttering letters, then its screen's scene rect by rect. */
function paintLights(s: BackdropLightScene): void {
  const k = neonStrength(s.amb);
  if (k <= 0 || !inView(s.cam, s.view, s.horizon)) return;
  const m = canyonOf(s.world, s.amb, s.horizon);
  const { ctx, cam, view } = s;
  const coarse = cam.zoom < PANE_ZOOM;
  const level = Math.floor(s.lit * LIT_STEPS) / LIT_STEPS;
  // The world rows the view shows: a fill is cut to them, and to its columns (nothing lit off the view).
  const top = Math.floor(-Math.round(cam.oy) / cam.zoom);
  const bottom = Math.ceil((view.h - Math.round(cam.oy)) / cam.zoom);
  ctx.globalAlpha = k;
  const clusters = clustersIn(m, s.x0, s.x1);
  for (const ch of clusters) {
    const [bx, by, bw, bh] = ch.lit ?? [0, 0, 0, 0];
    const y0 = Math.max(by, top);
    const y1 = Math.min(by + bh, bottom);
    // Its lights over each stretch of its ground in view (none in the quiet).
    let pieces: Box[] = [];
    for (const [g0, g1] of ch.ground) {
      const x0 = Math.max(bx, Math.floor(s.x0), g0);
      const x1 = Math.min(bx + bw, Math.ceil(s.x1), g1);
      if (x1 > x0 && y1 > y0) pieces.push([x0, y0, x1 - x0, y1 - y0]);
    }
    const raster = pieces.length ? lightRaster(ch, coarse, level, clusters.length) : null;
    if (raster) {
      for (const t of m.temples) pieces = pieces.flatMap((p) => subtract(p, t));
      for (const blade of ch.blades) {
        const out = neonFlicker(blade.seed, s.timeMs, blade.cells.length);
        if (out >= 0) pieces = pieces.flatMap((p) => subtract(p, blade.cells[out]));
      }
      raster.pattern.setTransform({ a: cam.zoom, b: 0, c: 0, d: cam.zoom, e: sx(cam, bx), f: sy(cam, by) });
      ctx.fillStyle = raster.pattern;
      for (const p of pieces) s.fillLit(...p);
    }
    // A screen glows, but under the neon: never the brightest thing in its street.
    ctx.globalAlpha = k * SCREEN_GLOW;
    for (const [color, x, y, w, h] of ch.screen ? screenScene(ch.screen, s.timeMs) : []) {
      if (x >= s.x1 || x + w <= s.x0 || y >= bottom || y + h <= top) continue;
      ctx.fillStyle = color;
      s.fillLit(x, y, w, h);
    }
    ctx.globalAlpha = k;
  }
  ctx.globalAlpha = 1;
}

/** World y of the canyon's face at world x: the top of its building there (roof, blade, billboard, tank), or the street's. */
function faceAt(s: BackdropScene, x: number): number {
  const m = canyonOf(s.world, s.amb, s.horizon);
  const ch = clusterOf(m, clusterAt(m, x));
  return ch.face[Math.floor(x) - ch.x0];
}

/** Signs with a word wholly inside [x0, x1), blades and signboards, whatever stands in front: for
 * the tests, what a passer-by would read there. */
export function canyonSigns(world: World, amb: Ambience | undefined, horizon: number, x0: number, x1: number): CanyonSign[] {
  return clustersIn(canyonOf(world, amb, horizon), x0, x1).flatMap((ch) => ch.signs.filter((g) => g.box[0] >= x0 && g.box[0] + g.box[2] <= x1));
}

/** The canyon's buildings over the clusters spanning world x ∈ [x0, x1), and its screens there — for the tests. */
export function canyonLayout(world: World, amb: Ambience | undefined, horizon: number, x0: number, x1: number): { buildings: CanyonBuilding[]; screens: CanyonScreen[] } {
  const clusters = clustersIn(canyonOf(world, amb, horizon), x0, x1);
  return { buildings: clusters.flatMap((ch) => ch.buildings), screens: clusters.flatMap((ch) => (ch.screen ? [ch.screen] : [])) };
}

/** The City's backdrop canyon in Tokyo (the MID layer, behind the shops): render/backdrop.ts. */
export const CANYON: BackdropLayer = { paint, paintLights, faceAt };
