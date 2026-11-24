/**
 * The street theme — the village and the city dressed for where this machine is.
 *
 * The Tokyo theme: sakura trees with petals falling from them, vending
 * machines on the street, and some temples. The theme is picked by the machine's IANA time zone (`themeFor`, the zone the live weather already reads for its
 * city): Asia/Tokyo dresses the scene, anywhere else leaves it exactly as built.
 *
 * Two dressers, one per scene. Each takes a BUILT world and returns a NEW one — never mutating its
 * input: a World is immutable and several modules cache per World object (walkGrid, indoors,
 * puddles, the LAN wiring), so an edited prop list on an old object would leave every one of those
 * caches describing a world that no longer exists.
 *
 *   dressVillage (top-down, engine/world.ts)
 *     - a third of the trees (rounded up) blossom into `sakura` — same 2×2 footprint, so the walk
 *       grid is unchanged (sakura blocks like the tree it replaces);
 *     - a `torii` as the plaza's gate: on the row just north of the plaza square, centred on the
 *       fountain's column, so you walk through its middle tile into the plaza (where a road runs
 *       down that column, the gate straddles it);
 *     - two `vending` machines side by side on the same row, a tile clear of the gate, facing the
 *       plaza (a single one when only one spot is free).
 *   dressCity (side view, engine/city.ts — the capacity HQ in the middle of the one street, the
 *   projects on both sides of it: the HQ is the centre)
 *     - half the street trees (rounded up) blossom;
 *     - `vending` machines on the near sidewalk: in front of half the buildings (rounded up; the HQ
 *       is one of them), two tiles left of the street door (else right; every third of them a
 *       pair), and on a third of the gaps' free sidewalk tiles — the column between a gap's lamp and
 *       its tree;
 *     - a `torii` at one end of the near sidewalk when three columns are free there — right end
 *       first, as close to the buildings as fits; with the HQ centred, that is usually the shorter
 *       side's empty stretch — else on the far sidewalk at the right end of the street, under the
 *       last building.
 *   Never on the PEDESTRIAN CROSSING (`crossingOf`): busy agents ride the lounge's lift up to
 *   its kiosk on the far sidewalk, cross both lanes and reach the HQ's door. Its far landing — the
 *   kiosk's tile and one either side — is reserved before anything is placed (only the far-sidewalk
 *   gate could reach it). Its near landing needs no reservation: it is the HQ's door and the front
 *   wall either side, where nothing is ever placed — a machine stands two or three tiles off a door,
 *   a gap's under open sky, and a gate only past the street's last building.
 *
 * Neither vending machines nor the torii block (villageTypes: you walk past one and through the
 * other), so dressing never changes a walkable tile. Every choice is a hash of tile positions —
 * no `Math.random` — so the same world always dresses the same way, and dressing is idempotent:
 * a dressed world dresses to itself (the same object).
 */

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

/**
 * Tiles of art a prop's sprite rises above its footprint (render/props.ts and render/tokyoProps.ts).
 * A theme prop is only placed where its footprint AND that art are clear of every other prop's, so
 * no machine stands inside a tree's canopy or a lamp's post. Only outdoor props are listed: the
 * theme never places anything indoors, where the rest of the art stays.
 */
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

/**
 * A world's tile kind at (c, r). No bounds check, on purpose: every tile the dressers ask about is
 * inside the map by construction — buildWorld keeps the plaza ≥ 3 rows from either edge and its
 * fountain ≥ 16 columns in; the city's probes stay between its margins or are bounded by `cols` —
 * so a check here could never fire. A new caller must keep that: a column off the map wraps.
 */
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

/**
 * The trees with a blossom: 1 in `share` of the 2×2 trees (rounded up), chosen by a hash of their
 * position. Trees and sakura are ranked TOGETHER, so a dressed world picks exactly the same ones
 * again (idempotence) and a tree's fate depends only on where the trees stand.
 */
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

/**
 * The torii is the plaza's gate: on the row just north of the plaza square, centred on the
 * fountain's column — you walk through its middle tile into the plaza, from the road above (where a
 * road runs down that column, the gate straddles it). Shifted a tile or more sideways if something
 * is in the way, then tried on the row south of the square.
 */
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

/**
 * Two machines side by side on the grass just north of the plaza square, facing it — beside the
 * gate, a tile clear of it (left first, then right, then closer in); then the row south of the
 * square. When no pair fits anywhere, the first single spot that does.
 */
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

/**
 * The village dressed for `zone`: a new World with sakura, vending machines and a torii in Tokyo;
 * the SAME world object anywhere else, for a city world, or when dressing changes nothing.
 */
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

/**
 * The PEDESTRIAN CROSSING in front of the capacity HQ (a busy agent rides an
 * elevator up to the street and walks to its building): the lounge's lift comes up at its kiosk
 * on the far sidewalk, right under the HQ's door, and a rider crosses both lanes there. Its tiles:
 * `w` columns centred on the lift's column, from the near sidewalk (`row`, the street's first row —
 * the HQ's door is right above it) through the two lanes to the far sidewalk (`row + h − 1`, the
 * kiosk's). render/crossing.ts paints its stripes on the two lanes; the dresser keeps its far landing
 * clear. null in a city without a lounge (no capacity layout) and in the village.
 *
 * It lives here, not in render/, because an engine module (this dresser) needs it too and the engine
 * never imports the renderer.
 */
export function crossingOf(world: World): TileBox | null {
  const city = world.city;
  if (!city?.lounge) return null;
  return { col: city.lounge.lift.col - CROSSING_HALF, row: city.street, w: 2 * CROSSING_HALF + 1, h: 4 };
}

/**
 * A machine on a sidewalk tile (c, r): path under it, its art against a building's front wall or
 * the open sky of a gap. Never in front of an opening — a street door is a `floor` tile in the front
 * wall, so the door (its light, its way out) is never covered.
 */
function cityVendingSpot(world: World, c: number, r: number): boolean {
  const art = tileAt(world, c, r - 1);
  return tileAt(world, c, r) === "path" && (art === "wall" || art === "sky");
}

/** Hash bits of a tile, for "does this one get a machine". */
function bits(c: number, r: number, salt: number): number {
  return hash2(c * 13 + salt, r * 7 + salt);
}

/**
 * The machines. Every building stands on the one street — its front wall on the row above the near
 * sidewalk (`city.street`) — so that is the row they all go on.
 */
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

/**
 * `items` ordered by `key` (a hash), ties by input order: a deterministic shuffle. The tie order
 * needs no comparator arm — `Array.prototype.sort` is stable (ES2019), so equal keys keep their order.
 */
function ranked<T>(items: readonly T[], key: (t: T) => number): T[] {
  return items
    .map((t) => ({ t, k: key(t) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

/**
 * A torii on the street. On its near sidewalk (under the buildings) at an end: three free columns of
 * sidewalk with open sky above them, not touching another prop's tile — the right end first, as close
 * to the buildings as fits, then the left end. The HQ stands in the middle and the world is as wide
 * on both sides of it, so the side with less street built has an empty stretch at its end: the gate
 * usually stands there, beside its last building. With no room at either end (both sides built
 * alike), on the far sidewalk (across the road) at the right end of the street, under the last
 * building — never on the crossing's landing there (reserved by `dressCity`).
 */
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

/**
 * The city dressed for `zone`: a new World with sakura street trees, vending machines and a torii in
 * Tokyo; the SAME world object anywhere else, for a village world, or when dressing changes nothing.
 */
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
