/** Tokyo street theme, picked by the machine's IANA zone (`themeFor`); elsewhere the world is left
 * as built. Dressers return a NEW World, never mutate it (modules cache per World object). Theme
 * props never block; choices hash tile positions, so dressing is idempotent. */

import type { Prop, PropKind, TileKind, World } from "../villageTypes";
import { hash2 } from "./rng";

/** A dressed look. One for now; anything without a theme is the world as built. */
export type StreetTheme = "tokyo";

/** IANA zones that mean "this machine is in Japan": the canonical zone and its legacy alias. */
const TOKYO_ZONES: ReadonlySet<string> = new Set(["Asia/Tokyo", "Japan"]);

/** The theme for the machine's IANA time zone, or null for none (any zone but Tokyo, or unknown). */
export function themeFor(zone: string | null | undefined): StreetTheme | null {
  return zone && TOKYO_ZONES.has(zone) ? "tokyo" : null;
}

/** Props only a dresser places — dropped and placed again on a re-dress, so dressing is idempotent. */
const PLACED: ReadonlySet<PropKind> = new Set<PropKind>(["vending", "torii"]);

/** Share of the trees that blossom: a third in the village, half of the (few) street trees in the city. */
const VILLAGE_BLOSSOM = 3;
const CITY_BLOSSOM = 2;

/** Tiles of art a prop rises above its footprint (render/props.ts, render/tokyoProps.ts). A theme
 * prop needs its footprint AND art clear of every other prop's. Outdoor props only. */
const ART_ABOVE: Partial<Record<PropKind, number>> = {
  tree: 1,
  sakura: 1,
  lamp: 1,
  vending: 1,
  torii: 2,
};

/** Tiles a prop covers on screen: its footprint plus the art above it. */
export function artBox(p: Prop): { col: number; row: number; w: number; h: number } {
  const up = ART_ABOVE[p.kind] ?? 0;
  return { col: p.col, row: p.row - up, w: p.w, h: p.h + up };
}

/** No bounds check on purpose: every dresser probe is in-map by construction (plaza margins, city
 * margins or `cols`). A new caller must keep that: a column off the map wraps. */
function tileAt(world: World, c: number, r: number): TileKind {
  return world.tiles[r * world.cols + c];
}

/** A box of tiles: `w` columns from `col`, `h` rows from `row`. */
interface TileBox {
  col: number;
  row: number;
  w: number;
  h: number;
}

/** Which tiles some prop already covers (footprint + art), with a `claim` that adds a new prop. */
class Cover {
  private readonly grid: Uint8Array;
  constructor(private readonly world: World, props: readonly Prop[]) {
    this.grid = new Uint8Array(world.cols * world.rows);
    for (const p of props) this.claim(p);
  }
  /** true when no prop covers any tile of the box — always one inside the map (see `tileAt`). */
  free(col: number, row: number, w: number, h: number): boolean {
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (this.grid[r * this.world.cols + c] === 1) return false;
    return true;
  }
  claim(p: Prop): void {
    this.reserve(artBox(p));
  }
  /** Mark a box taken (its part on the map) — a prop's art, or ground nothing may stand on. */
  reserve(b: TileBox): void {
    for (let r = Math.max(0, b.row); r < Math.min(this.world.rows, b.row + b.h); r++)
      for (let c = Math.max(0, b.col); c < Math.min(this.world.cols, b.col + b.w); c++) this.grid[r * this.world.cols + c] = 1;
  }
}

/** `tree:3,4` ↔ `sakura:3,4`, `street:tree:0` ↔ `street:sakura:0`: the kind's segment of the id. */
function retag(id: string, from: string, to: string): string {
  return id.replace(new RegExp(`(^|:)${from}(?=:|$)`), `$1${to}`);
}

/** 1 in `share` of the 2×2 trees (rounded up) blossom, by position hash. Trees and sakura rank
 * TOGETHER, so a dressed world picks the same ones again (idempotence). */
function blossom(props: readonly Prop[], share: number): Prop[] {
  const trees = props.filter((p) => p.kind === "tree" || p.kind === "sakura");
  const pick = new Set(ranked(trees, (p) => hash2(p.col * 31 + 7, p.row * 17 + 3)).slice(0, Math.ceil(trees.length / share)));
  return props.map((p) => {
    if (p.kind !== "tree" && p.kind !== "sakura") return p;
    const want: PropKind = pick.has(p) ? "sakura" : "tree";
    if (p.kind === want) return p;
    return { ...p, kind: want, id: retag(p.id, p.kind, want) };
  });
}

/** Same props, same order, field for field — then the dressed world IS the input. */
function sameProps(a: readonly Prop[], b: readonly Prop[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ka = Object.keys(a[i]) as (keyof Prop)[];
    const kb = Object.keys(b[i]);
    if (ka.length !== kb.length || ka.some((k) => a[i][k] !== b[i][k])) return false;
  }
  return true;
}

function vending(col: number, row: number): Prop {
  return { id: `tokyo:vending:${col},${row}`, kind: "vending", col, row, w: 1, h: 1 };
}

function torii(col: number, row: number): Prop {
  return { id: `tokyo:torii:${col},${row}`, kind: "torii", col, row, w: 3, h: 1 };
}

/** Try to stand `p` on the map: its whole art box must be free. Claims it and returns true on success. */
function place(cover: Cover, out: Prop[], p: Prop): boolean {
  const b = artBox(p);
  if (!cover.free(b.col, b.row, b.w, b.h)) return false;
  cover.claim(p);
  out.push(p);
  return true;
}

/** The dressed world, or the input itself when dressing changed nothing (memoised per input). */
function finish(cache: WeakMap<World, World>, world: World, props: Prop[]): World {
  const out = sameProps(world.props, props) ? world : { ...world, props };
  cache.set(world, out);
  cache.set(out, out);
  return out;
}

// ───────────────────────────── the village ─────────────────────────────

const villageCache = new WeakMap<World, World>();

interface PlazaSquare {
  top: number;
  bottom: number;
}

/** The plaza square's first and last rows, from its tiles (buildWorld always lays the square). */
function plazaSquare(world: World): PlazaSquare {
  return {
    top: Math.floor(world.tiles.indexOf("plaza") / world.cols),
    bottom: Math.floor(world.tiles.lastIndexOf("plaza") / world.cols),
  };
}

/** Ground a theme prop may stand on outdoors in the village: open grass, or a path it straddles. */
function open(k: TileKind): boolean {
  return k === "grass" || k === "path";
}

/** No wall under a prop's art (its footprint and the `up` rows above it, `w` wide). */
function noWall(world: World, c: number, r: number, w: number, up: number): boolean {
  for (let rr = r - up; rr <= r; rr++) for (let cc = c; cc < c + w; cc++) if (tileAt(world, cc, rr) === "wall") return false;
  return true;
}

/** The plaza's gate: the row north of the plaza square, centred on the fountain's column
 * (straddling a road there); shifted sideways if blocked, then tried south of the square. */
function villageTorii(world: World, cover: Cover, out: Prop[], sq: PlazaSquare): void {
  const cx = world.plaza.col;
  for (const r of [sq.top - 1, sq.bottom + 1])
    for (const d of [0, -1, 1, -2, 2, -3, 3]) {
      const c = cx + d - 1;
      if (![0, 1, 2].every((k) => open(tileAt(world, c + k, r)))) continue;
      if (!noWall(world, c, r, 3, 2)) continue;
      if (place(cover, out, torii(c, r))) return;
    }
}

/** Two machines side by side north of the plaza square, facing it, a tile clear of the gate (left,
 * right, then closer in); then south of the square; else the first single spot that fits. */
function villageVending(world: World, cover: Cover, out: Prop[], sq: PlazaSquare): void {
  const cx = world.plaza.col;
  const rows = [sq.top - 1, sq.bottom + 1];
  const spot = (c: number, r: number) => tileAt(world, c, r) === "grass" && noWall(world, c, r, 1, 1);
  for (const r of rows)
    for (const d of [-5, 4, -4, 3, -3, 2]) {
      const [a, b] = [cx + d, cx + d + 1];
      if (!spot(a, r) || !spot(b, r) || !cover.free(a, r - 1, 2, 2)) continue;
      place(cover, out, vending(a, r));
      place(cover, out, vending(b, r));
      return;
    }
  for (const r of rows)
    for (const d of [-5, 5, -4, 4, -3, 3, -2, 2])
      if (spot(cx + d, r) && place(cover, out, vending(cx + d, r))) return;
}

/** A new World with sakura, vending machines and a torii in Tokyo; the SAME object anywhere else,
 * for a city world, or when dressing changes nothing. */
export function dressVillage(world: World, zone: string | null | undefined): World {
  if (themeFor(zone) !== "tokyo" || world.city) return world;
  const cached = villageCache.get(world);
  if (cached) return cached;
  const props = blossom(
    world.props.filter((p) => !PLACED.has(p.kind)),
    VILLAGE_BLOSSOM,
  );
  const cover = new Cover(world, props);
  const sq = plazaSquare(world);
  villageTorii(world, cover, props, sq);
  villageVending(world, cover, props, sq);
  return finish(villageCache, world, props);
}

// ───────────────────────────── the city ─────────────────────────────

const cityCache = new WeakMap<World, World>();

/** Columns the pedestrian crossing reaches either side of the lounge lift's column: it is three tiles wide. */
export const CROSSING_HALF = 1;

/** The crossing: `w` columns centred on the lounge lift's column, from the near sidewalk (`row`) to
 * the far one (`row + h − 1`); null without a lounge or in the village. Lives in the engine because
 * this dresser needs it and the engine never imports the renderer. */
export function crossingOf(world: World): TileBox | null {
  const city = world.city;
  if (!city?.lounge) return null;
  return { col: city.lounge.lift.col - CROSSING_HALF, row: city.street, w: 2 * CROSSING_HALF + 1, h: 4 };
}

/** A sidewalk tile (c, r) whose art backs onto a front wall or open sky; never in front of a door
 * (a `floor` tile in the front wall), so a door is never covered. */
function cityVendingSpot(world: World, c: number, r: number): boolean {
  const art = tileAt(world, c, r - 1);
  return tileAt(world, c, r) === "path" && (art === "wall" || art === "sky");
}

/** Hash bits of a tile, for "does this one get a machine". */
function bits(c: number, r: number, salt: number): number {
  return hash2(c * 13 + salt, r * 7 + salt);
}

/** The machines, all on the near sidewalk row (`city.street`), under the buildings' front walls. */
function cityVending(world: World, cover: Cover, out: Prop[]): void {
  const city = world.city as NonNullable<World["city"]>;
  const sr = city.street;
  // Beside a door: half the buildings (rounded up, chosen by a hash of where they stand), two tiles
  // left of the door (else right); every third of those — in that same hash order — a pair.
  const chosen = ranked(city.buildings, (b) => bits(b.col, sr, 1)).slice(0, Math.ceil(city.buildings.length / 2));
  chosen.forEach((b, i) => {
    for (const c of [b.doorCol - 2, b.doorCol + 2]) {
      if (!cityVendingSpot(world, c, sr) || !place(cover, out, vending(c, sr))) continue;
      const mate = c < b.doorCol ? c - 1 : c + 1;
      if (i % 3 === 0 && mate >= b.col && mate < b.col + b.w && cityVendingSpot(world, mate, sr)) place(cover, out, vending(mate, sr));
      return;
    }
  });
  // In a gap between two buildings: a third of the gaps' free sidewalk tiles (rounded up), by hash.
  // (An empty street has x0 = +∞ and x1 = −∞: no gap.)
  const gaps: number[] = [];
  const x0 = Math.min(...city.buildings.map((b) => b.col));
  const x1 = Math.max(...city.buildings.map((b) => b.col + b.w));
  for (let c = x0; c < x1; c++) {
    const b = artBox(vending(c, sr));
    if (tileAt(world, c, sr - 1) === "sky" && cityVendingSpot(world, c, sr) && cover.free(b.col, b.row, b.w, b.h)) gaps.push(c);
  }
  for (const c of ranked(gaps, (c) => bits(c, sr, 2)).slice(0, Math.ceil(gaps.length / 3))) place(cover, out, vending(c, sr));
}

/** A deterministic shuffle: `items` by `key` (a hash); ties keep input order since `sort` is
 * stable (ES2019). */
function ranked<T>(items: readonly T[], key: (t: T) => number): T[] {
  return items
    .map((t) => ({ t, k: key(t) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

/** On the near sidewalk at an end with three free columns under open sky, right end first, nearest
 * the buildings; else the far sidewalk's right end under the last building, never on the crossing's
 * reserved landing (`dressCity`). */
function cityTorii(world: World, cover: Cover, out: Prop[]): void {
  const city = world.city as NonNullable<World["city"]>;
  const sr = city.street;
  const { buildings } = city;
  /** Three sidewalk tiles from column c on row r, `over` the two rows of tiles its art rises into, all clear. */
  const fits = (c: number, r: number, over: (k: TileKind) => boolean): boolean => {
    for (let k = 0; k < 3; k++) {
      if (tileAt(world, c + k, r) !== "path") return false;
      if (!over(tileAt(world, c + k, r - 1)) || !over(tileAt(world, c + k, r - 2))) return false;
    }
    return cover.free(c, r - 2, 3, 3);
  };
  const sky = (k: TileKind) => k === "sky";
  // One free sidewalk tile either side (or the world's edge), so the gate is not jammed against a lamp.
  const roomy = (c: number) => (c === 0 || cover.free(c - 1, sr, 1, 1)) && (c + 3 === world.cols || cover.free(c + 3, sr, 1, 1));
  if (buildings.length === 0) {
    // An empty street: its right end.
    for (let c = world.cols - 3; c >= 0; c--) if (fits(c, sr, sky) && roomy(c)) return void place(cover, out, torii(c, sr));
    return;
  }
  const right = Math.max(...buildings.map((b) => b.col + b.w));
  const left = Math.min(...buildings.map((b) => b.col));
  for (let c = right; c + 3 <= world.cols; c++) if (fits(c, sr, sky) && roomy(c)) return void place(cover, out, torii(c, sr));
  for (let c = left - 3; c >= 0; c--) if (fits(c, sr, sky) && roomy(c)) return void place(cover, out, torii(c, sr));
  // The far sidewalk: the road rows rise over nothing a prop stands on.
  const far = sr + 3;
  const road = (k: TileKind) => k === "road";
  for (let c = right - 3; c >= left; c--) if (fits(c, far, road)) return void place(cover, out, torii(c, far));
}

/** A new World with sakura, vending machines and a torii in Tokyo; the SAME object anywhere else,
 * for a village world, or when dressing changes nothing. */
export function dressCity(world: World, zone: string | null | undefined): World {
  if (themeFor(zone) !== "tokyo" || !world.city) return world;
  const cached = cityCache.get(world);
  if (cached) return cached;
  const props = blossom(
    world.props.filter((p) => !PLACED.has(p.kind)),
    CITY_BLOSSOM,
  );
  const cover = new Cover(world, props);
  // The crossing's far landing: a rider steps off the lounge's lift there and onto the road.
  const crossing = crossingOf(world);
  if (crossing) cover.reserve({ ...crossing, row: crossing.row + crossing.h - 1, h: 1 });
  cityVending(world, cover, props);
  cityTorii(world, cover, props);
  return finish(cityCache, world, props);
}

/** Either scene dressed for `zone`: what the panel calls on every world it builds. */
export function dressWorld(world: World, zone: string | null | undefined): World {
  return world.city ? dressCity(world, zone) : dressVillage(world, zone);
}
