/**
 * A project room's LAN (agents that communicate with each other are
 * networked, and the main agent — the boss — is the one on wireless). Every PROJECT room — a
 * village house with team tables, a city floor with a team — gets a Wi-Fi ROUTER: its team's
 * PCs / laptops are CABLED to it, and its boss (the root at its desk / the floor's leader) talks to
 * it OVER THE AIR. The Seats room's LAN (engine/lan.ts) is the precedent and shares its packet
 * model (`LanPacket`, `inFlight`: `PACKET_SPEED`, `MAX_TRIP`; the team hue).
 *
 *   - WIRING (`teamLanWiring`, per World): per room with a router — the cable runs, each TEAM
 *     seat's route to the router (its PC / laptop port first, the router's port last), and each
 *     BOSS seat's antenna point (where its Wi-Fi pulses and where an air hop ends).
 *   - TRAFFIC (`teamLanTraffic`, per frame, from `VillageSim.seating()` and the view's `LanEvent`s):
 *     packets move only on a real communication (nothing moves unless
 *     agents are communicating with each other). A TASK (a sub-agent spawned) runs from its
 *     parent's seat to its team seat through the router, a RESULT (it finished) back; a parent on a
 *     team seat is all cable, a BOSS parent's hop is over the air (antenna ↔ router, a straight
 *     line). A TOOL call is one round-trip from the caller's seat to the router and back — over the
 *     air both ways for a boss. Wi-Fi pulses ONLY while a packet is on an air hop; a router is busy
 *     while a packet is in flight in its room. No event, nothing moves.
 *
 * Geometry — the Seats LAN's star (`starWiring`), hung from the router (hub = its tile centre):
 *   - City (side view): the router hangs in the headroom row over the end of the leader's desk, the
 *     column left of the building's lift (`CityBuilding.lift`, up the door column). The floor's FIRST
 *     desk row hangs from a tray along that row at the hub's height, out to its farthest PC, a drop
 *     down to each PC's port (`pcPort`, as on the Village's Seats desks). A floor wraps its team onto
 *     more desk rows below (after every 10 tables, continue vertically): every LATER
 *     row hangs from its own bus `BRANCH_LIFT` px above its PCs' row — inside the aisle row above
 *     it, as a Seats desk row's branch does — and the buses join the router by a trunk straight down
 *     the router's column, never the lift's (it runs behind the leader's desk). Never through the
 *     back wall: the tray is one row below it. A one-row floor has no trunk at all.
 *   - Village (top-down): the router hangs at the top of the door column; a trunk runs down that
 *     always-clear column to the lowest team-table row, a branch along each table row's MIDDLE row
 *     (both tables of a row share it), and a drop from the branch to each laptop. A table is a
 *     blocking prop drawn over the cables, so the cable shows only down the door column and across
 *     the aisle, and vanishes under the table it feeds. A laptop's port is its tile's centre, raised
 *     with its art when it shows its screen (`LAPTOP_LIFT`).
 *   - Antenna: the top of a boss's PC (village) or monitor (city) art (`ANTENNA_RISE`).
 *   An air hop is straight (diagonal) from the antenna to the hub, inside the room.
 *
 * Wi-Fi rule: one pulse per ANTENNA per frame, however many packets are in the air there — a boss
 * sending three tasks at once pulses once, a router serving two bosses once. A pulse spreads and
 * fades as its packet crosses the hop (`phase` = how far across, 0 → 1), in the packet's hue; when
 * two share an antenna, the first event's packet sets it.
 *
 * Cost: the wiring is built once per World, its seat index once per wiring. Per frame,
 * `teamLanTraffic` is one Map over the seated agents, then per event a few Map lookups and a walk
 * of its way; it allocates nothing but its output. One packet per event at most.
 */

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

/**
 * World px a screen-facing laptop's art is lifted above its tile (render/props.ts `UP_LAPTOP_LIFT`:
 * it is raised onto the table's middle row so its sitter's head does not hide it). Its port moves
 * with it.
 */
export const LAPTOP_LIFT = 12;

/**
 * World px a boss's screen art rises above its tile's TOP edge — where its antenna is (render/props.ts):
 * a desk PC is a 16×32 sprite, bottom-anchored and lifted `SURFACE_LIFT` (8) onto the desk top, so it
 * reaches 32 + 8 − 16 = 24 px above its tile; a city leader's monitor (the left tile of its 2-tile
 * workstation) — its back panel tops out 31 px above its tile's bottom edge, 15 px above its top. Any
 * other screen: its tile's top edge.
 */
export const ANTENNA_RISE: Readonly<Partial<Record<PropKind, number>>> = { pc: 24, monitor: 15 };

// ───────────────────────────── wiring ─────────────────────────────

/** Cached per World object (a World never changes). */
const wiringCache = new WeakMap<World, TeamRoomWiring[]>();

/**
 * Every project room's wiring, in `world.houses` order: rooms with a router and at least one team
 * seat whose PC / laptop stands in the room. [] for none. Cached per World.
 */
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

/**
 * A city team PC's end of the star: its port, and as its bus the tray at the router's own height
 * when it stands in the floor's first desk row (right under the router's headroom row) — else its
 * row's bus, `BRANCH_LIFT` px above it in the aisle row above, which the trunk down the router's
 * column joins to the router.
 */
function cityTap(pc: Prop, router: Prop, hub: LanPoint): StarTap {
  return { port: pcPort(pc), busY: pc.row === router.row + 1 ? hub.y : pc.row * TILE - BRANCH_LIFT };
}

/**
 * A village laptop's end of the star: its port (its tile's centre, raised with its art when it shows
 * its screen) and, as its bus, the middle row of the table it stands on — so the table hides the
 * branch where it runs under it. A laptop on no table has no cable (null).
 */
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

/**
 * Where an event's packet runs: `head`'s way to the router, then `tail`'s walked back from it (a
 * task / result: the parent's, then the child's; a tool call: the caller's, out and back).
 */
interface Way {
  agent: SeatedAgent;
  head: Role;
  tail: Role;
}

/**
 * An event's way, or null when it has none: a tool call needs its caller on a wired seat; a task or a
 * result needs the sub-agent on a TEAM seat and its parent seated on another wired seat of the SAME
 * room (another room, the plaza, unseated, or its own seat: no way).
 */
function wayOf(ev: LanEvent, byKey: ReadonlyMap<string, SeatedAgent>, roles: ReadonlyMap<string, Role>): Way | null {
  const agent = byKey.get(ev.key);
  const mine = agent && roles.get(agent.seatId);
  if (!agent || !mine) return null;
  if (ev.kind === "tool") return { agent, head: mine, tail: mine };
  const parent = agent.parentKey === null ? undefined : byKey.get(agent.parentKey);
  const theirs = parent && parent.seatId !== agent.seatId ? roles.get(parent.seatId) : undefined;
  return !mine.air && theirs?.room === mine.room ? { agent, head: theirs, tail: mine } : null;
}

/**
 * The project rooms' traffic at `timeSec`, from who is seated where (`VillageSim.seating()`) and the
 * view's `LanEvent`s — one packet per event whose trip is under way (`inFlight`), in event order:
 *   - task (`key` = the sub-agent): the parent's seat → the router → the sub-agent's team seat;
 *   - result: the same way back;
 *   - tool (`key` = the caller): its seat → the router → back, an `uplink` packet.
 * A boss's leg (its antenna ↔ the router) is the AIR hop, a straight line; a team seat's is cable.
 * While a packet is on an air hop, the router and that boss's antenna pulse (`phase` = how far across
 * the hop it is), one pulse per antenna. Every packet takes its agent's team hue — its topmost seated
 * ancestor anywhere, not only in this room.
 */
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
