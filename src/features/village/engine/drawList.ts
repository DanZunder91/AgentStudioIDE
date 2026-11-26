/** Scene → ordered draw list: the engine owns ALL depth decisions, the renderer just paints.
 * Walls, props and characters z-sort by bottom edge (pixel-agents' 2.5D), with small offsets;
 * ties keep insertion order, so the sort is deterministic. */

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

/** Room floors as `pattern + 9·tint` (the encoding `drawTile` decodes). ONE per room, so a floor
 * reads as a floor, not a patchwork. */
export const HOUSE_FLOORS = [6, 6 + 9, 2, 3 + 18, 2 + 9, 4] as const;

/** The door tile: plain dark wood, a threshold that reads against any room floor. */
export const THRESHOLD_FLOOR = 9;

export interface HouseStyle {
  /** Wall hue, degrees. */
  hue: number;
  /** Room floor variant. */
  floor: number;
}

/** Each house's look from its key (stable across frames and reloads), linear-probed so no two
 * houses share a hue or floor while an unused one is left. */
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

/** Label placement ranks (lower first; labels.ts `placeLabels`), so in a crowd the labels that
 * matter survive. */
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

/** A walled footprint sharing one look: a house (village) or a building of floors (city); its
 * bottom row is the street-facing front wall, with the door. */
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

/** The lounge's own look: a hue no building wears, cream subway tiles not in `HOUSE_FLOORS`, so it
 * never reads as one more floor. */
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

/** Ground tiles and walls are fixed per (immutable) World, so they are built once per World, not
 * ~3,000 objects a frame. Weak, so a replaced World is collected with its items. */
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

/** World px from a building's roof line down to its neon sign's top: one tile plus 2, so the name
 * centred `SIGN_ABOVE` over it is never under the sign. */
export const NEON_DROP = TILE + 2;

/** A project building's neon sign: the outer face of its RIGHT wall (door and lift are on the
 * left), `NEON_DROP` below its roof, reaching out over the gap's open sky. */
export function neonAnchor(b: CityBuilding): { x: number; y: number } {
  return { x: (b.col + b.w) * TILE, y: b.row * TILE + NEON_DROP };
}

/** One neon sign per PROJECT building with a known language (never the HQ), z-keyed at its front
 * wall's depth: painted over its wall, under the street. Built once per World. */
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

/** Lift shafts per city World (render/lift.ts), built once: each project building's (row above its
 * top stop to the row above its door) and the lounge's (soil under the far sidewalk to its last
 * aisle). Drawn after the scene (over walls it crosses) and before the riders. */
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
  /** Lounge benches a sim character is on, leaving, away from or heading back to
   * (`VillageSim.loungeClaims`): no waiter sits there. Absent = none. */
  claims?: ReadonlySet<number>;
}

/** Lit units per rack: the Memory building has RACKS × RACK_UNITS of them. */
export const RACK_UNITS = 8;
/** A context bar's width, world px (it fits one desk tile). */
export const METER_W = 14;

/** Rack `index`'s reading: units fill rack by rack, the agents' first (a non-zero share lights at
 * least one), then the rest in use; the remainder stays dark. */
export function rackReading(memory: CapacityFrame["memory"] | null, index: number): PropReading {
  const total = RACKS * RACK_UNITS;
  if (!memory || (memory.agents === null && memory.used === null)) return { kind: "rack", agents: 0, other: 0, known: false };
  const agents = memory.agents === null ? 0 : Math.max(memory.agents > 0 ? 1 : 0, Math.round(memory.agents * total));
  const lit = Math.max(agents, memory.used === null ? 0 : Math.round(memory.used * total));
  const inRack = (units: number) => Math.min(RACK_UNITS, Math.max(0, units - index * RACK_UNITS));
  const a = inRack(agents);
  return { kind: "rack", agents: a, other: inRack(lit) - a, known: true };
}

/** A capacity prop's reading: the Seats hall, a rack, a gauge, or a lounge bench's waiter
 * (`claims` and `time` are the bench's). */
function capacityReading(prop: Prop, frame: CapacityFrame | null, claims: ReadonlySet<number> | undefined, time: number): PropReading | undefined {
  const i = prop.index as number;
  if (prop.kind === "hall") return { kind: "hall", hall: frame?.hall ?? null };
  if (prop.kind === "bench") return waiterOn(i, frame, claims, time);
  if (prop.kind === "rack") return rackReading(frame?.memory ?? null, i);
  const meter = frame ? (i === 0 ? frame.usage.session : frame.usage.week) : null;
  return { kind: "gauge", meter };
}

// ───────────────────────────── the city's lounge: its waiters ─────────────────────────────

/** Waiter hue shifts: small enough never to turn a face green, few so the sprite bank caches at
 * most 6 × 3 sheets. */
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

/** Bench `i`'s waiter pose at `time` (s): mostly still, a brief shift at its routine's end (own
 * length and phase, so the hall never moves in step); 1 in `READER_EVERY` reads a paper. */
export function waiterPose(i: number, time: number): WaiterPose {
  const h = hash2(i, 0x5e47);
  const period = ROUTINE_MIN + (h % ROUTINE_SPREAD);
  const t = (time + (((h >>> 4) % 1000) / 1000) * period) % period;
  if ((h >>> 16) % READER_EVERY === 0 && t < period / 2) return "read";
  return t >= period - SHIFT_SEC ? "shift" : "still";
}

/** A waiter on every FREE bench: no holder (`frame.desks[i]`) and no claim; a held seat is EMPTY
 * (its agent is at work). Before the first capacity frame the benches are empty. */
export function waiterOn(i: number, frame: CapacityFrame | null, claims: ReadonlySet<number> | undefined, time: number): PropReading | undefined {
  if (!frame || frame.desks[i] || claims?.has(i)) return undefined;
  return { kind: "waiter", ...waiterLook(i), pose: waiterPose(i, time) };
}

/** Context bar spot: facing up, on the desk's free right tile in the row above; facing down (a
 * city leader), centred on the front edge of the desk below. */
export function meterSpot(seat: Seat): { x: number; y: number } {
  if (seat.facing === "down") return { x: seat.col * TILE + 1, y: (seat.row + 2) * TILE - 5 };
  return { x: (seat.col + 1) * TILE + 1, y: seat.row * TILE - 5 };
}

/** This frame's draw list. LAN packets, Wi-Fi pulses and busy routers come only from `events`
 * (real communications, on `time`'s clock) and `seated` (`VillageSim.seating()`). */
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

/** The city's only words: each building's sign (the folder) and each floor's name plate. Every
 * sub-agent has a desk, so no floor shows a "+N" overflow. */
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

/** Topmost (last-drawn) non-despawning character whose 16×32 box contains the point, or null. */
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
