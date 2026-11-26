/** LAN primitives for every room's network (engine/teamLan.ts). Pure. A packet exists only while a
 * REAL communication's trip is under way (a task/result between parent and sub-agent, or a tool
 * call's round-trip), never a rhythm. Zero-length runs and route legs are always dropped. */

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

/** `team`: a task or result between an agent and its starter, in the team's hue; `uplink`: a tool
 * call's round-trip between an agent and the hub (its model API traffic). */
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
/** Longest trip, s (longer ways run faster), so a packet is gone ≤ MAX_TRIP s after its event. */
export const MAX_TRIP = 2;

/** World px above a desk row's top where its bus runs (in the aisle above); used for every city
 * floor desk row but the first. */
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

/** Cable star around `hub`: tap drop → its bus → the hub's column → trunk to the hub. `runs`: the
 * trunk, buses top-down, then drops in tap order; `routes[k]`: tap k's port → bus → hub column →
 * hub, repeated points dropped. `taps` must not be empty. */
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

/** The key a team is coloured by: `start`'s topmost ancestor reachable through `seated`. A parent
 * loop (corrupt tree) has no top: the loop's smallest key stands in, the same for every member. */
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

/** Where the packet sent `age` s ago is: along `head` from its first point, then `tail` from its
 * LAST point back (never concatenated through the hub); `back` reverses it. At `PACKET_SPEED`, or
 * faster to fit `MAX_TRIP`. null when not under way (age < 0, arrived, or a zero-length way). */
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

/** The point `s` px along a polyline (past its end: its last point); a diagonal leg moves along
 * its direction. */
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
