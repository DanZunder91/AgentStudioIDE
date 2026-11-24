/**
 * The LAN primitives every room's network is drawn with (engine/teamLan.ts: a project room's team
 * cabled to its router, its boss on Wi-Fi). Pure: the wiring is a function of the World, the traffic
 * a function of who sits where, what was said, and the clock.
 *
 * PACKETS: one per REAL communication, never a rhythm (packets move
 * only when agents communicate with each other). In Claude Code a parent and its sub-agent talk
 * exactly twice — the TASK when it is spawned and the RESULT when it finishes — and every TOOL call
 * is one round-trip to the model. The view observes those as `LanEvent`s; a packet exists only while
 * its trip is under way.
 *
 * Every LAN here is one shape (`starWiring`): a BUS per desk row, joined to the hub by a vertical
 * trunk. A city floor's first desk row hangs from a tray at its router's own height, its later rows
 * from buses `BRANCH_LIFT` px above them — so a one-row floor's trunk has zero length and is dropped.
 * Zero-length runs and repeated route points are always dropped: no run and no route leg has zero
 * length.
 *
 * (The Village's Seats room had a LAN of its own — a switch cabled to a desk per agent — until
 * the Village's Seats became the selected agent's context window: a hall
 * of `/context`'s 200 seats, nobody at a desk, so nothing on a cable.)
 *
 * Shared pieces: `starWiring` (the star shape), `pcPort`, `teamRoot` / `teamHue`, `routeLength` /
 * `pointAt` (a leg may also be diagonal: the Wi-Fi air hop) and `inFlight` (the trip maths).
 */

import { TILE, type Prop } from "../villageTypes";
import { hashString } from "./rng";

/** One straight, axis-aligned cable run, world px. */
export interface CableRun {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LanPoint {
  x: number;
  y: number;
}

/**
 * `team`: a task or a result between an agent and the agent that started it, in the team's hue;
 * `uplink`: a tool call's round-trip between an agent and the hub (its model API traffic).
 */
export type LanPacketKind = "team" | "uplink";

/** A packet's position this frame, world px. */
export interface LanPacket {
  x: number;
  y: number;
  kind: LanPacketKind;
  /** Degrees 0..359: the team's colour — its topmost seated ancestor's key, hashed (`teamHue`). */
  hue: number;
}

/** How fast a packet runs along its way at least, world px per second. */
export const PACKET_SPEED = 48;
/**
 * The longest a trip may take, seconds: a longer way (a wide city floor, a tool call's round-trip)
 * runs faster. So an event's packet is gone at most MAX_TRIP s after the event.
 */
export const MAX_TRIP = 2;

/**
 * World px above a desk row's top edge where its bus runs: inside the walkway / aisle row above it —
 * a city floor's every desk row but its first (engine/teamLan.ts).
 */
export const BRANCH_LIFT = 4;
/** World px below a PC tile's top edge where its cable plugs in. */
const PORT_DEPTH = 2;

// ───────────────────────────── wiring ─────────────────────────────

/** Where a PC's cable plugs in, world px: its tile's centre column, `PORT_DEPTH` below its top edge. */
export function pcPort(pc: Prop): LanPoint {
  return { x: pc.col * TILE + TILE / 2, y: pc.row * TILE + PORT_DEPTH };
}

/** One end of a star: a port, and the y of the (horizontal) bus its drop hangs from. */
export interface StarTap {
  port: LanPoint;
  busY: number;
}

/**
 * A star of cable around `hub` — the shape of every LAN here: from each tap's port a vertical drop
 * to its bus, the bus out to the hub's column, a vertical trunk along that column to the hub. Taps
 * on one bus y share it. `runs`: the trunk, the buses top to bottom, then one drop per tap in tap
 * order. `routes[k]`: tap k's path `[port, (port x, bus y), (hub x, bus y), hub]`, repeated points
 * dropped. `taps` must not be empty.
 */
export function starWiring(hub: LanPoint, taps: readonly StarTap[]): { runs: CableRun[]; routes: LanPoint[][] } {
  /** Bus y → the x of every port hanging from it. */
  const buses = new Map<number, number[]>();
  const drops: CableRun[] = [];
  const routes = taps.map(({ port, busY: y }) => {
    const { x } = port;
    const bus = buses.get(y);
    if (bus) bus.push(x);
    else buses.set(y, [x]);
    addRun(drops, x, y, x, port.y);
    return withoutRepeats([port, { x, y }, { x: hub.x, y }, hub]);
  });

  const ys = [...buses.keys()].sort((a, b) => a - b);
  const runs: CableRun[] = [];
  addRun(runs, hub.x, Math.min(hub.y, ys[0]), hub.x, Math.max(hub.y, ys[ys.length - 1]));
  for (const y of ys) {
    const xs = buses.get(y) as number[];
    addRun(runs, Math.min(hub.x, ...xs), y, Math.max(hub.x, ...xs), y);
  }
  runs.push(...drops);
  return { runs, routes };
}

/** Appends the run between two points, normalised (x0 ≤ x1, y0 ≤ y1) — unless it has no length. */
function addRun(runs: CableRun[], xa: number, ya: number, xb: number, yb: number): void {
  if (xa === xb && ya === yb) return;
  runs.push({ x0: Math.min(xa, xb), y0: Math.min(ya, yb), x1: Math.max(xa, xb), y1: Math.max(ya, yb) });
}

/** The points with every immediate repeat removed (a zero-length leg is no leg). */
function withoutRepeats(points: LanPoint[]): LanPoint[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
}

// ───────────────────────────── teams ─────────────────────────────

/**
 * The key a team is coloured by: `start`'s topmost ancestor reachable through `seated` (the agents
 * that are there to draw — an ancestor that is not breaks the chain, and the last one reached is the
 * top). Parents that loop (a corrupt tree) have no top: the loop's smallest key stands in, the same
 * for every member.
 */
export function teamRoot<T extends { key: string; parentKey: string | null }>(start: T, seated: ReadonlyMap<string, T>): string {
  const chain: string[] = [];
  let h = start;
  for (;;) {
    const seen = chain.indexOf(h.key);
    if (seen >= 0) return chain.slice(seen).reduce((min, k) => (k < min ? k : min));
    chain.push(h.key);
    const p = h.parentKey === null ? undefined : seated.get(h.parentKey);
    if (p === undefined) return h.key;
    h = p;
  }
}

/** A team's colour, degrees 0..359: its root's key (`teamRoot`), hashed. */
export function teamHue(rootKey: string): number {
  return hashString(rootKey) % 360;
}

// ───────────────────────────── packets ─────────────────────────────

/** A packet under way this frame: where it is, and how far along its way. */
export interface InFlight extends LanPoint {
  /** World px it has run since it left, in [0, length). */
  d: number;
  /** Its whole way, world px: `head`'s length plus `tail`'s. */
  length: number;
  /** `head`'s length, world px. */
  lh: number;
}

/**
 * The trip maths of every LAN here (the project rooms' — engine/teamLan.ts): where
 * the packet that left `age` s ago is. Its way is `head` walked from its first point, then `tail`
 * walked from its LAST point back to its first — so a way through the hub is never concatenated;
 * `back` runs that way in reverse (tail's first point → head's first point). It runs at
 * `PACKET_SPEED`, or faster so the trip takes no longer than `MAX_TRIP`. null while the packet is
 * not under way: not sent yet (age < 0), or arrived (a way of no length has no trip at all).
 */
export function inFlight(head: readonly LanPoint[], tail: readonly LanPoint[], back: boolean, age: number): InFlight | null {
  const lh = routeLength(head);
  const length = lh + routeLength(tail);
  const d = age * Math.max(PACKET_SPEED, length / MAX_TRIP);
  if (age < 0 || d >= length) return null;
  // How far from the way's START (head's first point) the packet is.
  const s = back ? length - d : d;
  const p = s > lh ? pointAt(tail, length - s) : pointAt(head, s);
  return { x: p.x, y: p.y, d, length, lh };
}

/** Length of one straight leg, world px — exactly |dx| + |dy| when it is axis-aligned (a cable's always are). */
function legLength(dx: number, dy: number): number {
  return dx === 0 || dy === 0 ? Math.abs(dx) + Math.abs(dy) : Math.hypot(dx, dy);
}

/** Length of a polyline of straight legs (axis-aligned on a cable; the Wi-Fi air hop is diagonal), world px. */
export function routeLength(route: readonly LanPoint[]): number {
  let len = 0;
  for (let k = 1; k < route.length; k++) len += legLength(route[k].x - route[k - 1].x, route[k].y - route[k - 1].y);
  return len;
}

/**
 * The point `s` px along a polyline from its first point (past its end: its last point). An
 * axis-aligned leg moves exactly `s` px along its axis; a diagonal one along its direction.
 */
export function pointAt(route: readonly LanPoint[], s: number): LanPoint {
  let rest = s;
  for (let k = 1; k < route.length; k++) {
    const p = route[k - 1];
    const q = route[k];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const leg = legLength(dx, dy);
    if (rest <= leg) {
      const axis = dx === 0 || dy === 0;
      return { x: p.x + (axis ? Math.sign(dx) : dx / leg) * rest, y: p.y + (axis ? Math.sign(dy) : dy / leg) * rest };
    }
    rest -= leg;
  }
  return route[route.length - 1];
}
