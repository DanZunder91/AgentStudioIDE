/** A project room's LAN: team PCs/laptops CABLED to a Wi-Fi router, the boss on air. Pure, on
 * engine/lan.ts's packet model; packets move only on a real task/result/tool event, and Wi-Fi
 * pulses only while a packet is on an air hop (one pulse per antenna per frame). */

import { TILE, type House, type LanEvent, type Prop, type PropKind, type Seat, type SeatedAgent, type World } from "../villageTypes";
import { BRANCH_LIFT, inFlight, pcPort, starWiring, teamHue, teamRoot, type CableRun, type LanPacket, type LanPoint, type StarTap } from "./lan";

/** One project room's wiring (a World never changes: cache per World). */
export interface TeamRoomWiring {
  /** The room's house key (village house key / city floor key). */
  room: string;
  /** The router's port, world px: every team route ends here, every air hop starts here. */
  hub: LanPoint;
  /** Every cable run to draw, each stretch of cable exactly once. */
  runs: CableRun[];
  /** Team seat id → its route: the PC / laptop port FIRST, `hub` LAST, every leg axis-aligned and on `runs`. */
  routes: Readonly<Record<string, LanPoint[]>>;
  /** Boss seat id (a non-team seat with a PC / monitor) → its antenna point, world px. */
  antennas: Readonly<Record<string, LanPoint>>;
}

/** A Wi-Fi pulse this frame (the `wifi` DrawItem minus its tag). */
export interface WifiPulse {
  x: number;
  y: number;
  /** How far its packet is across the air hop, [0, 1): the ring spreads and fades as it crosses. */
  phase: number;
  /** Degrees 0..359: the packet's team hue. */
  hue: number;
}

/** World px a screen-facing laptop's art is lifted above its tile (render/props.ts
 * `UP_LAPTOP_LIFT`); its port moves with it. */
export const LAPTOP_LIFT = 12;

/** World px a boss's screen art rises above its tile's TOP edge, where its antenna sits (sprite
 * geometry in render/props.ts); any other screen: its tile's top edge. */
export const ANTENNA_RISE: Readonly<Partial<Record<PropKind, number>>> = { pc: 24, monitor: 15 };

// ───────────────────────────── wiring ─────────────────────────────

/** Cached per World object (a World never changes). */
const wiringCache = new WeakMap<World, TeamRoomWiring[]>();

/** Wiring of every room with a router and a team seat whose PC/laptop is in it, in `world.houses`
 * order; [] for none. Cached per World. */
export function teamLanWiring(world: World): TeamRoomWiring[] {
  let wiring = wiringCache.get(world);
  if (!wiring) wiringCache.set(world, (wiring = wire(world)));
  return wiring;
}

function wire(world: World): TeamRoomWiring[] {
  const byId = new Map<string, Prop>();
  const routers: Prop[] = [];
  const tables: Prop[] = [];
  for (const p of world.props) {
    byId.set(p.id, p);
    if (p.kind === "router") routers.push(p);
    else if (p.kind === "table") tables.push(p);
  }
  const seatsOf = new Map<string, Seat[]>();
  for (const s of world.seats) {
    const list = seatsOf.get(s.houseKey);
    if (list) list.push(s);
    else seatsOf.set(s.houseKey, [s]);
  }

  const wiring: TeamRoomWiring[] = [];
  for (const room of world.houses) {
    const inRoom = (p: Prop): boolean => covers(room, p.col, p.row);
    const router = routers.find(inRoom);
    if (!router) continue;
    const hub: LanPoint = { x: router.col * TILE + TILE / 2, y: router.row * TILE + TILE / 2 };
    const roomTables = tables.filter(inRoom);

    const teamSeats: string[] = [];
    const taps: StarTap[] = [];
    const antennas: Record<string, LanPoint> = Object.create(null) as Record<string, LanPoint>;
    for (const seat of seatsOf.get(room.key) ?? []) {
      const pc = seat.pcId === null ? undefined : byId.get(seat.pcId);
      if (!pc || !inRoom(pc)) continue;
      if (!seat.forSub) {
        antennas[seat.id] = { x: pc.col * TILE + TILE / 2, y: pc.row * TILE - (ANTENNA_RISE[pc.kind] ?? 0) };
        continue;
      }
      const tap = world.city ? cityTap(pc, router, hub) : laptopTap(pc, roomTables);
      if (!tap) continue;
      teamSeats.push(seat.id);
      taps.push(tap);
    }
    if (taps.length === 0) continue;

    const star = starWiring(hub, taps);
    const routes: Record<string, LanPoint[]> = Object.create(null) as Record<string, LanPoint[]>;
    teamSeats.forEach((id, k) => (routes[id] = star.routes[k]));
    wiring.push({ room: room.key, hub, runs: star.runs, routes, antennas });
  }
  return wiring;
}

/** The room's interior holds tile (col, row). */
function covers(room: House, col: number, row: number): boolean {
  return col >= room.col && col < room.col + room.w && row >= room.row && row < room.row + room.h;
}

/** A city team PC's tap: in the floor's first desk row its bus is the tray at the router's height;
 * else its row's bus `BRANCH_LIFT` px above, joined by the trunk down the router's column. */
function cityTap(pc: Prop, router: Prop, hub: LanPoint): StarTap {
  return { port: pcPort(pc), busY: pc.row === router.row + 1 ? hub.y : pc.row * TILE - BRANCH_LIFT };
}

/** A village laptop's tap: its port, and its table's middle row as the bus (so the table hides
 * the branch). A laptop on no table has no cable (null). */
function laptopTap(laptop: Prop, tables: readonly Prop[]): StarTap | null {
  const table = tables.find((t) => laptop.col >= t.col && laptop.col < t.col + t.w && laptop.row >= t.row && laptop.row < t.row + t.h);
  if (!table) return null;
  const x = laptop.col * TILE + TILE / 2;
  const lift = laptop.facing === "up" ? LAPTOP_LIFT : 0;
  return { port: { x, y: laptop.row * TILE + TILE / 2 - lift }, busY: (table.row + Math.floor(table.h / 2)) * TILE + TILE / 2 };
}

// ───────────────────────────── traffic ─────────────────────────────

/** A wired seat's place on its room's LAN. */
interface Role {
  room: TeamRoomWiring;
  /** A boss seat, on Wi-Fi — else a team seat, on cable. */
  air: boolean;
  /** Its way to the router, its own end first and the router's port last: a team seat's route, a boss's air hop. */
  path: readonly LanPoint[];
}

/** Every wired seat (team or boss) → its role, per wiring array (the one `teamLanWiring` caches is the same every frame). */
const rolesCache = new WeakMap<readonly TeamRoomWiring[], Map<string, Role>>();

function rolesOf(wiring: readonly TeamRoomWiring[]): Map<string, Role> {
  let roles = rolesCache.get(wiring);
  if (roles) return roles;
  roles = new Map();
  for (const room of wiring) {
    for (const [id, route] of Object.entries(room.routes)) roles.set(id, { room, air: false, path: route });
    for (const [id, antenna] of Object.entries(room.antennas)) roles.set(id, { room, air: true, path: [antenna, room.hub] });
  }
  rolesCache.set(wiring, roles);
  return roles;
}

/** A project room LAN's traffic this frame. */
export interface TeamLanTraffic {
  /** Every packet under way, one per event at most, in event order. */
  packets: LanPacket[];
  /** One pulse per antenna with a packet on an air hop: the router first, then the boss, as first named. */
  wifi: WifiPulse[];
  /** The rooms (house keys) with a packet in flight: their routers are busy. */
  busy: Set<string>;
}

/** `head`'s way to the router, then `tail`'s walked back (task/result: parent's then child's;
 * tool call: the caller's, out and back). */
interface Way {
  agent: SeatedAgent;
  head: Role;
  tail: Role;
}

/** null when no way: a tool call needs its caller on a wired seat; a task/result needs the
 * sub-agent on a TEAM seat and its parent on another wired seat of the SAME room. */
function wayOf(ev: LanEvent, byKey: ReadonlyMap<string, SeatedAgent>, roles: ReadonlyMap<string, Role>): Way | null {
  const agent = byKey.get(ev.key);
  const mine = agent && roles.get(agent.seatId);
  if (!agent || !mine) return null;
  if (ev.kind === "tool") return { agent, head: mine, tail: mine };
  const parent = agent.parentKey === null ? undefined : byKey.get(agent.parentKey);
  const theirs = parent && parent.seatId !== agent.seatId ? roles.get(parent.seatId) : undefined;
  return !mine.air && theirs?.room === mine.room ? { agent, head: theirs, tail: mine } : null;
}

/** One packet per event whose trip is under way, in event order: task parent → router →
 * sub-agent, result back, tool seat → router → back (`uplink`); a boss's leg is the air hop. Every
 * packet takes its agent's team hue (topmost seated ancestor anywhere, not only this room). */
export function teamLanTraffic(
  wiring: readonly TeamRoomWiring[],
  seated: readonly SeatedAgent[],
  events: readonly LanEvent[],
  timeSec: number,
): TeamLanTraffic {
  const roles = rolesOf(wiring);
  const byKey = new Map<string, SeatedAgent>();
  for (const a of seated) byKey.set(a.key, a);
  const traffic: TeamLanTraffic = { packets: [], wifi: [], busy: new Set() };
  /** The antennas pulsing this frame (a room's router, a boss's seat) → their pulse. */
  const pulses = new Map<TeamRoomWiring | Role, WifiPulse>();
  for (const ev of events) {
    const way = wayOf(ev, byKey, roles);
    if (!way) continue;
    const { head, tail } = way;
    const back = ev.kind === "result";
    const at = inFlight(head.path, tail.path, back, timeSec - ev.at);
    if (!at) continue;
    const hue = teamHue(teamRoot(way.agent, byKey));
    const { room } = tail;
    traffic.packets.push({ x: at.x, y: at.y, kind: ev.kind === "tool" ? "uplink" : "team", hue });
    traffic.busy.add(room.room);
    // Its two legs in the order it runs them; on an air leg, both of the hop's antennas pulse.
    const [first, firstLength, second] = back ? [tail, at.length - at.lh, head] : [head, at.lh, tail];
    const onFirst = at.d < firstLength;
    const leg = onFirst ? first : second;
    if (!leg.air) continue;
    const phase = onFirst ? at.d / firstLength : (at.d - firstLength) / (at.length - firstLength);
    for (const [antenna, p] of [
      [room, room.hub],
      [leg, leg.path[0]],
    ] as const)
      if (!pulses.has(antenna)) pulses.set(antenna, { x: p.x, y: p.y, phase, hue });
  }
  traffic.wifi = [...pulses.values()];
  return traffic;
}
