/**
 * Scene → ordered draw instructions. The engine owns ALL depth decisions; the
 * renderer paints the list front to back without thinking.
 *
 * Order: ground tiles (row-major) → the Seats LAN's cables → walls, props and
 * characters z-sorted by their bottom edge (the top-down "2.5D" trick from
 * pixel-agents) → the city's lift shafts, then their riders each in its car
 * (`liftShafts`) → the LAN's packets → context meters → bubbles → labels. z rules:
 *
 *   wall                 (row+1)·16                 sprite is 2 tiles tall, anchored at its tile bottom
 *   prop                 (row+h)·16                 bottom edge of the footprint
 *   pc / coffee / monitor (row+h)·16 + 0.5          in front of the desk they stand on
 *   laptop               table bottom + 0.5         in front of the 3-row team table it stands on
 *                                                   (a down-facing one is on the table's TOP row)
 *   chair facing up      (row+h)·16 + 1             its back hides the seated sitter's legs
 *   character            feet y + 0.5               (seated: minus SIT_OFFSET, i.e. its chair tile)
 *
 * Ties keep insertion order (walls, then props, then characters), so the sort is
 * fully deterministic.
 */

import {
  SEAT_LIFT,
  TILE,
  type CapacityFrame,
  type CharacterView,
  type CityBuilding,
  type CityInfo,
  type DrawItem,
  type House,
  type Prop,
  type PropReading,
  type Seat,
  type LanEvent,
  type SeatedAgent,
  type VehicleView,
  type WaiterPose,
  type World,
} from "../villageTypes";
import { teamLanTraffic, teamLanWiring } from "./teamLan";
import { PALETTE_COUNT } from "./palette";
import { hash2, hashString } from "./rng";
import { SIT_OFFSET } from "./sim";
import { walkerZ, type WalkerItem } from "./streetLife";
import { vehicleZ } from "./traffic";
import { CAPACITY_LABEL, RACKS, TEAM_TABLE_H } from "./world";

/** Prop animation frame period (pc screens, fountain, campfire), seconds. */
export const PROP_FRAME_SEC = 0.2;
const PROP_FRAMES = 3;

/** The depth key of a character: its feet, minus the sitting offset baked into `y`. */
export function characterZ(c: CharacterView): number {
  return (c.seated ? c.y - SIT_OFFSET : c.y) + 0.5;
}

export function propZ(p: Prop): number {
  const bottom = (p.row + p.h) * TILE;
  if (p.kind === "pc" || p.kind === "coffee" || p.kind === "monitor") return bottom + 0.5;
  if (p.kind === "laptop") return bottom + 0.5 + (p.facing === "down" ? (TEAM_TABLE_H - 1) * TILE : 0);
  if (p.kind === "chair" && p.facing === "up") return bottom + 1;
  return bottom;
}

/** 4-bit mask of wall neighbours: N=1 E=2 S=4 W=8. Out of bounds is not a wall. */
export function wallMask(world: World, col: number, row: number): number {
  const isWall = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < world.cols && r < world.rows && world.tiles[r * world.cols + c] === "wall";
  return (isWall(col, row - 1) ? 1 : 0) | (isWall(col + 1, row) ? 2 : 0) | (isWall(col, row + 1) ? 4 : 0) | (isWall(col - 1, row) ? 8 : 0);
}

/** Cosy house hues (degrees), spread so neighbours read apart: butter, coral, sage, sky, lavender, teal. */
export const HOUSE_HUES = [42, 12, 95, 205, 275, 165] as const;

/**
 * Room floors as `pattern + 9·tint` (the variant encoding `drawTile` decodes — pixel-agents
 * floor_N × render/tiles.ts FLOOR_TINTS): warm planks, dark planks, warm tiles, cool small
 * tiles, dark tiles, warm small tiles. ONE per room, so a floor reads as a floor and not a
 * patchwork of per-tile patterns.
 */
export const HOUSE_FLOORS = [6, 6 + 9, 2, 3 + 18, 2 + 9, 4] as const;

/** The door tile: plain dark wood, a threshold that reads against any room floor. */
export const THRESHOLD_FLOOR = 9;

export interface HouseStyle {
  /** Wall hue, degrees. */
  hue: number;
  /** Room floor variant. */
  floor: number;
}

/**
 * Each house's look, derived from its key (so it is the same on every frame and every
 * reload), with linear probing so neighbours differ: while an unused hue / floor is
 * left, no two houses share one.
 */
export function houseStyles(keys: readonly string[]): Map<string, HouseStyle> {
  /** The option at `seed`, or the next one not taken yet (all taken → a fresh round). */
  const pick = <T>(options: readonly T[], seed: number, used: Set<T>): T => {
    if (used.size === options.length) used.clear();
    let i = seed % options.length;
    while (used.has(options[i])) i = (i + 1) % options.length;
    used.add(options[i]);
    return options[i];
  };
  const hues = new Set<number>();
  const floors = new Set<number>();
  const out = new Map<string, HouseStyle>();
  for (const key of keys) {
    const h = hashString(key);
    out.set(key, { hue: pick(HOUSE_HUES, h, hues), floor: pick(HOUSE_FLOORS, h >>> 8, floors) });
  }
  return out;
}

/**
 * Label placement ranks (lower = placed first; see labels.ts `placeLabels`): the hovered
 * character is always labelled, then whoever is waiting on the user, then root agents,
 * then sub-agents — so in a crowd the labels that matter survive.
 */
export const LABEL_RANK = { hovered: 0, waiting: 1, root: 2, sub: 3 } as const;

export function labelRank(c: CharacterView, hovered: string | null): number {
  if (c.key === hovered) return LABEL_RANK.hovered;
  if (c.activity === "waiting") return LABEL_RANK.waiting;
  return c.isSubagent ? LABEL_RANK.sub : LABEL_RANK.root;
}

interface SceneEntry {
  z: number;
  seq: number;
  item: DrawItem;
}

/** The per-World static part of the list: ground tiles (row-major), LAN cables and wall pieces (z-keyed). */
interface StaticItems {
  tiles: DrawItem[];
  cables: DrawItem[];
  walls: SceneEntry[];
  /** The city's lounge dressing (render/lounge.ts), at its back wall's depth; null without a lounge. */
  lounge: { z: number; item: DrawItem } | null;
}

/**
 * A walled footprint whose walls and floors share one look: a house, walls included (the
 * village), or a whole building of floors (the city). Its bottom row is the street-facing
 * front wall, with the door in it.
 */
interface Shell {
  key: string;
  col0: number;
  row0: number;
  col1: number;
  row1: number;
  doorCol: number;
  /** A look of its own, rather than one picked from its key (`houseStyles`). */
  style?: HouseStyle;
}

/**
 * The city's lounge: its own look — station walls of a hue no building
 * wears (not in `HOUSE_HUES`) round a hall of cream subway tiles (pattern 5, warm tint: not in
 * `HOUSE_FLOORS`), so the waiting room under the street never reads as one more floor of a building.
 */
export const LOUNGE_STYLE: HouseStyle = { hue: 188, floor: 5 };

/** The city's lounge and its house, or null (a village, or a city built without capacity). */
function loungeOf(world: World): { house: House; lift: number } | null {
  const lounge = world.city?.lounge;
  if (!lounge) return null;
  return { house: world.houses.find((h) => h.key === lounge.key) as House, lift: lounge.lift.col };
}

function shellsOf(world: World): Shell[] {
  if (world.city) {
    const shells: Shell[] = world.city.buildings.map((b) => ({
      key: b.key,
      col0: b.col,
      row0: b.row,
      col1: b.col + b.w - 1,
      row1: b.row + b.h - 1,
      doorCol: b.doorCol,
    }));
    // The lounge is walled like a building, its bottom wall its front (one tile tall, so its last
    // aisle shows whole). It has no door: its way in is the lift, down through its back wall, and its
    // bottom wall is solid, so no threshold tile is drawn.
    const lounge = loungeOf(world);
    if (lounge) {
      const h = lounge.house;
      shells.push({ key: h.key, col0: h.col - 1, row0: h.row, col1: h.col + h.w, row1: h.row + h.h, doorCol: lounge.lift, style: LOUNGE_STYLE });
      // The Seats hall under it (in both views) is walled the same way, in the same
      // station walls: its bottom wall its front, one tile tall, so its last row of seats shows whole.
      // engine/city.ts digs the two together, so a city with a lounge always has the hall.
      const hall = world.houses.find((x) => x.capacity === "seats") as House;
      shells.push({ key: hall.key, col0: hall.col - 1, row0: hall.row, col1: hall.col + hall.w, row1: hall.row + hall.h, doorCol: lounge.lift, style: LOUNGE_STYLE });
    }
    return shells;
  }
  return world.houses.map((h) => ({
    key: h.key,
    col0: h.col - 1,
    row0: h.row - 1,
    col1: h.col + h.w,
    row1: h.doorRow,
    doorCol: h.doorCol,
  }));
}

/**
 * Ground tiles and walls never change for a given World (it is immutable — a new house
 * plan builds a new one), so they are built once per World instead of ~3,000 fresh
 * objects every animation frame. Weak, so a replaced World is collected with its items.
 */
const STATIC = new WeakMap<World, StaticItems>();

function staticItems(world: World): StaticItems {
  const hit = STATIC.get(world);
  if (hit) return hit;
  const tiles: DrawItem[] = [];
  const walls: SceneEntry[] = [];
  const { cols, rows } = world;
  // Per tile: the shell (house or building) whose footprint, walls included, holds it, so
  // its walls take the shell's hue and its floors one shell-wide pattern.
  const owner = new Map<number, HouseStyle & { frontRow: number }>();
  const door = new Set<number>();
  const shells = shellsOf(world);
  const styles = houseStyles(shells.map((s) => s.key));
  for (const sh of shells) {
    const style = { ...(sh.style ?? (styles.get(sh.key) as HouseStyle)), frontRow: sh.row1 };
    for (let r = sh.row0; r <= sh.row1; r++) for (let c = sh.col0; c <= sh.col1; c++) owner.set(r * cols + c, style);
    door.add(sh.row1 * cols + sh.doorCol);
  }
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const kind = world.tiles[row * cols + col];
      const house = owner.get(row * cols + col);
      if (kind === "wall") {
        const item: DrawItem = { t: "wall", col, row, mask: wallMask(world, col, row) };
        if (house) {
          item.hue = house.hue;
          if (row === house.frontRow) item.front = true;
        }
        walls.push({ z: (row + 1) * TILE, seq: walls.length, item });
      } else {
        const variant =
          kind === "floor" && house ? (door.has(row * cols + col) ? THRESHOLD_FLOOR : house.floor) : hash2(col, row) & 3;
        tiles.push({ t: "tile", col, row, kind, variant });
      }
    }
  // Every project room's LAN (team PCs / laptops cabled to its router).
  const runs = teamLanWiring(world).flatMap((room) => room.runs);
  const cables: DrawItem[] = runs.map((r) => ({ t: "cable", ...r }));
  // The lounge's dressing hangs on its back surface: keyed at its back wall's depth (after the wall
  // pieces of that row), so its benches, its waiters and the lift's riders are all drawn over it.
  const l = loungeOf(world);
  const lounge = l && {
    z: (l.house.row + 1) * TILE,
    item: { t: "lounge", col: l.house.col, row: l.house.row, w: l.house.w, benchRows: (l.house.h - 2) / 2, lift: l.lift } as DrawItem,
  };
  const built = { tiles, cables, walls, lounge };
  STATIC.set(world, built);
  return built;
}

// ───────────────────────────── neon signs ─────────────────────────────

/**
 * World px from a building's roof line down to the top of its neon sign: one tile (the top floor's
 * slab and the top of its back wall), plus 2. Below the roof, so the building's name —
 * centred `SIGN_ABOVE` over it — is never under the sign (and labels are painted last anyway).
 */
export const NEON_DROP = TILE + 2;

/**
 * Where a project building's neon sign hangs (`DrawItem` "neon"): the outer face of its RIGHT wall,
 * `NEON_DROP` below its roof. The right side, because the street door (and the lift up its column)
 * is on the left, and the gap after a building opens with a lamp whose art stops at the front
 * wall's top — so a sign high on the wall reaches out over open sky. From the rect alone: a taller
 * building (more floors, more desk rows) keeps its sign at the top.
 */
export function neonAnchor(b: CityBuilding): { x: number; y: number } {
  return { x: (b.col + b.w) * TILE, y: b.row * TILE + NEON_DROP };
}

/**
 * The neon signs of a city World: one per PROJECT building with a known language (never the HQ),
 * z-keyed at its front wall's depth — so, inserted after the walls, each is painted over its whole
 * wall (a tie keeps insertion order) and under everything on the street. Built once per World.
 */
const NEON = new WeakMap<World, { z: number; item: NeonItem }[]>();

/** A neon sign's draw item. */
export type NeonItem = Extract<DrawItem, { t: "neon" }>;

/** The neon signs the draw list hangs in `world` (the very items, with their z) — `VillageView.neonBoxes` reads them too. */
export function neonSigns(world: World): readonly { z: number; item: NeonItem }[] {
  const hit = NEON.get(world);
  if (hit) return hit;
  const out: { z: number; item: NeonItem }[] = [];
  for (const b of world.city?.buildings ?? [])
    if (!b.hq && b.language)
      out.push({ z: (b.row + b.h) * TILE, item: { t: "neon", ...neonAnchor(b), language: b.language, building: b.key } });
  NEON.set(world, out);
  return out;
}

// ───────────────────────────── the lifts ─────────────────────────────

/**
 * The lift shafts of a city World (`DrawItem` "shaft", render/lift.ts), built once per World: every
 * project building's lift (a building with a team has one) and the lounge's. TILE rows:
 *   - a building's runs from the row above its top stop (a car there is two tiles tall) down to the
 *     row above its door — the door row itself is the street door, and the near sidewalk's walkers'
 *     heads pass in front of it — with a landing door at every stop but the street door;
 *   - the lounge's runs from the soil under the far sidewalk (its kiosk stands ON the sidewalk) down
 *     to its last aisle, with a landing door at every aisle.
 * The draw list puts them after the scene, so a shaft runs OVER the back walls and slabs it crosses,
 * and before the riders, so a car is never behind its own shaft.
 */
export type ShaftItem = Extract<DrawItem, { t: "shaft" }>;

const SHAFTS = new WeakMap<World, ShaftItem[]>();

export function liftShafts(world: World): ShaftItem[] {
  const hit = SHAFTS.get(world);
  if (hit) return hit;
  const out: ShaftItem[] = [];
  for (const b of world.city?.buildings ?? []) {
    const l = b.lift;
    if (l) out.push({ t: "shaft", col: l.col, top: l.top - 1, bottom: l.bottom - 1, stops: l.stops.filter((r) => r < l.bottom) });
  }
  const down = world.city?.lounge?.lift;
  if (down) out.push({ t: "shaft", col: down.col, top: down.top + 1, bottom: down.bottom, stops: down.stops.filter((r) => r > down.top) });
  SHAFTS.set(world, out);
  return out;
}

// ───────────────────────────── capacity ───────────────────────────────────────────

/** What the capacity buildings and the desks' context bars need this frame. */
export interface CapacityDraw {
  frame: CapacityFrame;
  /** The seat an agent holds in the sim (`VillageSim.seatFor`) — its context bar sits on that desk. */
  seatOf: (key: string) => Seat | null;
  /**
   * The city's lounge: the benches (by seat number) a sim character is on, leaving from, away
   * from or heading back to (`VillageSim.loungeClaims`) — no anonymous waiter sits there. Absent = none.
   */
  claims?: ReadonlySet<number>;
}

/** Lit units per rack: the Memory building has RACKS × RACK_UNITS of them. */
export const RACK_UNITS = 8;
/** A context bar's width, world px (it fits one desk tile). */
export const METER_W = 14;

/**
 * Rack `index`'s reading for these memory shares: units fill rack by rack, the agents' first (a
 * non-zero share lights at least one unit), then everything else in use; the rest stay dark.
 */
export function rackReading(memory: CapacityFrame["memory"] | null, index: number): PropReading {
  const total = RACKS * RACK_UNITS;
  if (!memory || (memory.agents === null && memory.used === null)) return { kind: "rack", agents: 0, other: 0, known: false };
  const agents = memory.agents === null ? 0 : Math.max(memory.agents > 0 ? 1 : 0, Math.round(memory.agents * total));
  const lit = Math.max(agents, memory.used === null ? 0 : Math.round(memory.used * total));
  const inRack = (units: number) => Math.min(RACK_UNITS, Math.max(0, units - index * RACK_UNITS));
  const a = inRack(agents);
  return { kind: "rack", agents: a, other: inRack(lit) - a, known: true };
}

/**
 * A capacity prop's reading: the Village's Seats hall (the selected agent's context window), a rack,
 * a gauge, or a lounge bench's waiter (`claims` and `time` are the bench's).
 */
function capacityReading(prop: Prop, frame: CapacityFrame | null, claims: ReadonlySet<number> | undefined, time: number): PropReading | undefined {
  const i = prop.index as number;
  if (prop.kind === "hall") return { kind: "hall", hall: frame?.hall ?? null };
  if (prop.kind === "bench") return waiterOn(i, frame, claims, time);
  if (prop.kind === "rack") return rackReading(frame?.memory ?? null, i);
  const meter = frame ? (i === 0 ? frame.usage.session : frame.usage.week) : null;
  return { kind: "gauge", meter };
}

// ───────────────────────────── the city's lounge: its waiters ─────────────────────────────

/**
 * Hue shifts a waiter wears: none, or a touch either way — enough to tell two of the same sheet
 * apart, never enough to turn a face green (a big shift moves the skin too). Few, so the sprite bank
 * caches at most 6 × 3 sheets for the whole hall.
 */
export const WAITER_HUES = [0, 15, 345] as const;
/** A waiter's routine lasts ROUTINE_MIN..ROUTINE_MIN + ROUTINE_SPREAD − 1 s (its own), and ends in a short shift in its seat. */
export const ROUTINE_MIN = 9;
export const ROUTINE_SPREAD = 7;
export const SHIFT_SEC = 0.6;
/** One waiter in READER_EVERY reads a paper through the first half of its routine. */
export const READER_EVERY = 4;

/** Bench `i`'s waiter's look: one of the six sheets and one of `WAITER_HUES`, from the bench's number only. */
export function waiterLook(i: number): { palette: number; hueShift: number } {
  const h = hash2(i, 0x10a9);
  return { palette: h % PALETTE_COUNT, hueShift: WAITER_HUES[(h >>> 8) % WAITER_HUES.length] };
}

/**
 * Bench `i`'s waiter's pose at `time` (s): mostly sitting still; at the end of its routine (its own
 * length and phase, so the hall never moves in step) a brief shift in its seat; and one in
 * `READER_EVERY` reads a paper through the first half of it. Deterministic in (bench, time).
 */
export function waiterPose(i: number, time: number): WaiterPose {
  const h = hash2(i, 0x5e47);
  const period = ROUTINE_MIN + (h % ROUTINE_SPREAD);
  const t = (time + (((h >>> 4) % 1000) / 1000) * period) % period;
  if ((h >>> 16) % READER_EVERY === 0 && t < period / 2) return "read";
  return t >= period - SHIFT_SEC ? "shift" : "still";
}

/**
 * Lounge bench `i`'s waiter this frame — an anonymous agent waiting to be called on every FREE seat:
 * no holder (`frame.desks[i]`) and no sim character on it, leaving it, away from it or coming back to
 * it (`claims`). A held seat is EMPTY: its agent is away at work. Before the first capacity frame
 * nobody is known to be anywhere, so the benches are empty.
 */
export function waiterOn(i: number, frame: CapacityFrame | null, claims: ReadonlySet<number> | undefined, time: number): PropReading | undefined {
  if (!frame || frame.desks[i] || claims?.has(i)) return undefined;
  return { kind: "waiter", ...waiterLook(i), pose: waiterPose(i, time) };
}

/**
 * Where an agent's context bar goes on its desk: a sitter facing up has its desk on the row above
 * (the bar on the desk's free right tile); one facing down (a city leader) has it on the row below
 * (the bar centred on its front edge).
 */
export function meterSpot(seat: Seat): { x: number; y: number } {
  if (seat.facing === "down") return { x: seat.col * TILE + 1, y: (seat.row + 2) * TILE - 5 };
  return { x: (seat.col + 1) * TILE + 1, y: seat.row * TILE - 5 };
}

/**
 * This frame's draw list. `seated` (`VillageSim.seating()`) is who sits where in the project rooms;
 * `events` the real communications the view observed (`LanEvent`, on the same clock as `time`): the
 * LANs' packets, their Wi-Fi pulses and a busy switch / router come from those and nothing else.
 */
export function buildDrawList(
  world: World,
  chars: CharacterView[],
  pcOn: (propId: string) => boolean,
  time: number,
  hovered: string | null = null,
  cap: CapacityDraw | null = null,
  seated: readonly SeatedAgent[] = [],
  events: readonly LanEvent[] = [],
  walkers: readonly WalkerItem[] = [],
  vehicles: readonly VehicleView[] = [],
): DrawItem[] {
  const { tiles, cables, walls, lounge } = staticItems(world);
  // The cables lie on the floor (village) / along the back wall (city): under everything in the scene.
  const out: DrawItem[] = [...tiles, ...cables];
  // Walls keep their own (stable, 0-based) seq; props and characters follow them.
  const scene: SceneEntry[] = walls.slice();
  // The neon signs hang on their buildings' right walls: after every wall piece of the street.
  for (const n of neonSigns(world)) scene.push({ z: n.z, seq: scene.length, item: n.item });
  // The lounge's dressing, on its back surface (after its back wall's pieces: same z, later seq).
  if (lounge) scene.push({ z: lounge.z, seq: scene.length, item: lounge.item });
  const animFrame = Math.floor(time / PROP_FRAME_SEC) % PROP_FRAMES;
  const frame = cap?.frame ?? null;
  const gauges: Prop[] = [];
  // The LANs' traffic this frame: a packet only while a real communication (`events`) is under way —
  // the project rooms': the team over cable, the boss over the air.
  const rooms = teamLanTraffic(teamLanWiring(world), seated, events, time);

  for (const prop of world.props) {
    let on = false;
    let reading: PropReading | undefined;
    // A router blinks while a packet is in flight in its room — never on a rhythm.
    if (prop.kind === "router") on = rooms.busy.has(prop.id.slice(0, -":router".length));
    else if (prop.capacity) {
      reading = capacityReading(prop, frame, cap?.claims, time);
      if (prop.kind === "gauge") gauges.push(prop);
    } else if (prop.kind === "pc" || prop.kind === "laptop" || prop.kind === "monitor") on = pcOn(prop.id);
    else if (prop.kind === "fountain" || prop.kind === "campfire") on = true;
    const item: DrawItem = { t: "prop", prop, on, frame: on ? animFrame : 0 };
    if (reading) item.reading = reading;
    scene.push({ z: propZ(prop), seq: scene.length, item });
  }

  // The City's passers-by (engine/streetLife.ts): in the scene, in front of their sidewalk's props and
  // behind an agent at the same spot — never in `chars`, so never hit-tested, labelled or bubbled.
  for (const w of walkers) scene.push({ z: walkerZ(w), seq: scene.length, item: w });

  // The City's traffic (engine/traffic.ts), by the road under its wheels (`vehicleZ`).
  for (const v of vehicles) scene.push({ z: vehicleZ(v), seq: scene.length, item: { t: "vehicle", v } });

  // A lift's riders are drawn after the shafts (below), each inside its car; everyone else in the scene.
  const riders: CharacterView[] = [];
  for (const c of chars) {
    if (c.riding) riders.push(c);
    else scene.push({ z: characterZ(c), seq: scene.length, item: { t: "character", c } });
  }

  scene.sort((a, b) => a.z - b.z || a.seq - b.seq);
  for (const s of scene) out.push(s.item);

  // The lifts: every shaft over the walls and slabs it crosses, then each rider in its car — the
  // car's back, the rider, the car's front — front to back.
  for (const s of liftShafts(world)) out.push(s);
  riders.sort((a, b) => characterZ(a) - characterZ(b));
  for (const c of riders) out.push({ t: "car", x: c.x, y: c.y, part: "back" }, { t: "character", c }, { t: "car", x: c.x, y: c.y, part: "front" });

  // The LAN's packets run over the desks and the sitters, under the context bars.
  // Wi-Fi rings first, so the packets flying through them are drawn on top.
  for (const p of rooms.wifi) out.push({ t: "wifi", ...p });
  for (const p of rooms.packets) out.push({ t: "packet", ...p });

  // Context bars float over the desks, above the furniture and the sitters — in a city with a Seats
  // lounge only over a desk its agent sits at (`seated`): a commuter on its bench or on its way leaves
  // no bar hanging over an empty desk.
  if (cap) {
    const atDesk = world.city?.lounge ? new Set(seated.map((a) => a.key)) : null;
    for (const [key, m] of Object.entries(cap.frame.context)) {
      const seat = cap.seatOf(key);
      if (seat && (!atDesk || atDesk.has(key))) out.push({ t: "meter", ...meterSpot(seat), w: METER_W, fill: m.fill, tone: m.tone });
    }
  }

  // Bubbles and labels float above everything, in the same front-to-back order as their characters.
  const sorted: CharacterView[] = [];
  for (const s of scene) if (s.item.t === "character") sorted.push(s.item.c);
  sorted.push(...riders);
  for (const c of sorted) if (c.bubble && c.bubbleAlpha > 0) out.push({ t: "bubble", c });
  capacityLabels(out, gauges, frame);
  const tag = (c: CharacterView, priority: number): DrawItem => ({
    t: "label",
    x: c.x,
    y: (c.seated ? c.y - SIT_OFFSET : c.y) + AGENT_LABEL_BELOW,
    text: c.label,
    tone: "agent",
    priority,
  });
  if (world.city) {
    cityLabels(out, world.city, world.houses, frame);
    // A floor's plate already names its leader, and a desk row of tags would bury the
    // floor: in the city only the hovered character is tagged (the card names everyone).
    const c = sorted.find((v) => v.key === hovered);
    if (c) out.push(tag(c, LABEL_RANK.hovered));
    return out;
  }
  // House names hang on the back wall's face, centred over the house — never over the room.
  for (const h of world.houses)
    out.push({
      t: "label",
      x: (h.col + h.w / 2) * TILE,
      y: h.row * TILE - HOUSE_LABEL_ABOVE,
      ...(h.capacity ? { text: civicText(h, frame), tone: "civic" as const } : { text: h.label, tone: "house" as const }),
    });
  // Agent labels in placement order (stable within a rank, i.e. front-to-back).
  const ranked = sorted.map((c) => ({ c, rank: labelRank(c, hovered) })).sort((a, b) => a.rank - b.rank);
  for (const { c, rank } of ranked) out.push(tag(c, rank));
  return out;
}

/**
 * The city's words: each building's sign over its roof (the folder) and each floor's name plate
 * on the slab above it (the agent or console tab) — nothing else. Every sub-agent has a desk
 * (engine/city.ts), so no floor ever counts a "+N" overflow.
 */
function cityLabels(out: DrawItem[], city: CityInfo, floors: readonly House[], frame: CapacityFrame | null): void {
  for (const b of city.buildings)
    out.push({ t: "label", x: (b.col + b.w / 2) * TILE, y: b.row * TILE - SIGN_ABOVE, text: b.label, tone: b.hq ? "civic" : "house" });
  for (const h of floors) {
    const plateY = (h.row - 1) * TILE + TILE / 2;
    if (h.capacity) {
      out.push({ t: "label", x: (h.col + h.w / 2) * TILE, y: plateY, text: civicText(h, frame), tone: "civic" });
      continue;
    }
    // Capped at its floor: below zoom 1 a screen-sized plate would spill past the building.
    out.push({
      t: "label",
      x: h.col * TILE + PLATE_INSET,
      y: plateY,
      text: h.label,
      tone: "floor",
      priority: LABEL_RANK.root,
      maxW: h.w * TILE - PLATE_INSET * 2,
    });
  }
}

/** A capacity building's board: its figure this frame ("Seats 3/10"), or just its name without one. */
function civicText(h: House, frame: CapacityFrame | null): string {
  const kind = h.capacity as NonNullable<House["capacity"]>;
  return frame ? frame.captions[kind] : CAPACITY_LABEL[kind];
}

/** Each usage gauge's caption just above its art. */
function capacityLabels(out: DrawItem[], gauges: readonly Prop[], frame: CapacityFrame | null): void {
  if (!frame) return;
  for (const g of gauges)
    out.push({ t: "label", x: (g.col + g.w / 2) * TILE, y: (g.row - 1) * TILE - GAUGE_CAPTION_ABOVE, text: frame.gaugeCaptions[g.index as number], tone: "gauge" });
}

/** World px a gauge's caption is centred above the top of its (2-tile-tall) art. */
const GAUGE_CAPTION_ABOVE = 6;
/** An agent's tag hangs this many world px below its feet (a sitter's: below its chair tile). */
const AGENT_LABEL_BELOW = 1;
/** World px from the interior's top edge up to the middle of the back wall's face (a 2-tile wall piece). */
const HOUSE_LABEL_ABOVE = 12;
/** World px a building's sign is centred above its roof. */
const SIGN_ABOVE = 14;
/** World px a floor's plate starts right of the floor's left wall. */
const PLATE_INSET = 2;

/** Sprite box half-width and height (px), feet at bottom-centre. */
const HIT_HALF_W = 8;
const HIT_H = 32;

/**
 * Key of the topmost (last-drawn) character whose 16×32 sprite box contains the
 * world point, ignoring characters that are despawning. null if none.
 */
export function hitTest(chars: CharacterView[], wx: number, wy: number): string | null {
  let best: string | null = null;
  let bestZ = -Infinity;
  for (const c of chars) {
    if (c.fx?.kind === "despawn") continue;
    const feet = c.seated ? c.y - SEAT_LIFT : c.y;
    if (wx < c.x - HIT_HALF_W || wx >= c.x + HIT_HALF_W || wy < feet - HIT_H || wy >= feet) continue;
    const z = characterZ(c);
    if (z >= bestZ) {
      best = c.key;
      bestZ = z;
    }
  }
  return best;
}
