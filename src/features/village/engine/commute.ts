/** The route between a lounge bench and a desk: nine fixed waypoints (eight legs, two lift rides),
 * pure geometry from the World contract. `VillageSim` decides who travels when, this where and how
 * fast. A world rebuild projects a traveller onto the same leg, never teleports it. */

import { TILE, type Dir, type Seat, type World } from "../villageTypes";
import type { Tile } from "./path";

/** World px/s: a commuter walks 2.5× `WALK_SPEED` and rides faster, so a trip across a typical city
 * takes ≲ 12 s (commute.test.ts checks every bench to every desk). The walk animation steps in
 * proportion (`COMMUTE_FRAME_SEC` in sim.ts), so feet don't slide. */
export const COMMUTE_WALK = 120;
export const COMMUTE_RIDE = 160;

/** Legs of every route (nine waypoints). */
export const LEGS = 8;
/** Which legs are lift rides: P2 → P3 (the lounge's lift) and P6 → P7 (the building's). */
export const RIDES: readonly boolean[] = [false, false, true, false, false, false, true, false];

export interface Route {
  /** The nine waypoints (tile coords), bench end first; each leg runs along a row or a column. */
  points: readonly Tile[];
  /** `rides[i]`: leg i (points[i] → points[i + 1]) is a lift ride — always `RIDES`. */
  rides: readonly boolean[];
}

/** Where a traveller is on a route: leg `leg`, `d` px from `points[leg]` along it, heading `dir`. */
export interface Cursor {
  leg: number;
  d: number;
  /** +1 towards the desk (P8), −1 back towards the bench (P0). */
  dir: 1 | -1;
}

/** The lounge's bench tiles by seat number (`Prop.index`) — what a sub-agent's bench index points at. */
export function benchTiles(world: World): Tile[] {
  const out: Tile[] = [];
  for (const p of world.props) if (p.kind === "bench") out[p.index as number] = { col: p.col, row: p.row };
  return out;
}

/** Route from `bench` (null: the lounge lift's lowest stop) to team `seat`. null when the world
 * has no lounge or the seat's building no lift (only a building with a team has one). */
export function commuteRoute(world: World, bench: Tile | null, seat: Seat): Route | null {
  const city = world.city;
  const lift = city?.buildings.find((b) => b.floors.includes(seat.houseKey))?.lift;
  if (!city?.lounge || !lift) return null;
  const down = city.lounge.lift;
  const start = bench ?? { col: down.col, row: down.bottom };
  const aisle = bench ? bench.row + 1 : down.bottom;
  return {
    points: [
      start,
      { col: start.col, row: aisle },
      { col: down.col, row: aisle },
      { col: down.col, row: down.top },
      { col: down.col, row: city.street },
      { col: lift.col, row: city.street },
      { col: lift.col, row: lift.bottom },
      { col: lift.col, row: seat.row },
      { col: seat.col, row: seat.row },
    ],
    rides: RIDES,
  };
}

/** Leg `leg`'s length, world px (legs are straight along a row or a column). */
export function legLength(route: Route, leg: number): number {
  const a = route.points[leg];
  const b = route.points[leg + 1];
  return (Math.abs(b.col - a.col) + Math.abs(b.row - a.row)) * TILE;
}

/** Speed on leg `leg`, px/s. */
function speed(route: Route, leg: number): number {
  return route.rides[leg] ? COMMUTE_RIDE : COMMUTE_WALK;
}

/** Move `cur` along `route` for `dt` s at each leg's speed, carrying leftover time into the next
 * leg. True once at the end it heads for (P8 going out, P0 coming back), where it then stays. */
export function advance(route: Route, cur: Cursor, dt: number): boolean {
  let t = dt;
  for (;;) {
    const v = speed(route, cur.leg);
    if (cur.dir > 0) {
      const len = legLength(route, cur.leg);
      if (len - cur.d > t * v) {
        cur.d += t * v;
        return false;
      }
      t -= (len - cur.d) / v;
      cur.d = len;
      if (cur.leg === LEGS - 1) return true;
      cur.leg++;
      cur.d = 0;
    } else {
      if (cur.d > t * v) {
        cur.d -= t * v;
        return false;
      }
      t -= cur.d / v;
      cur.d = 0;
      if (cur.leg === 0) return true;
      cur.leg--;
      cur.d = legLength(route, cur.leg);
    }
  }
}

/** Write the feet into `out`: world px (`x`, `y`, the tile's bottom centre, as the sim uses) and
 * the tile under them (`col`, `row`, rounded). */
export function place(route: Route, cur: Cursor, out: { x: number; y: number; col: number; row: number }): void {
  const a = route.points[cur.leg];
  const b = route.points[cur.leg + 1];
  const len = legLength(route, cur.leg);
  const f = len === 0 ? 0 : cur.d / len;
  const col = a.col + (b.col - a.col) * f;
  const row = a.row + (b.row - a.row) * f;
  out.x = col * TILE + TILE / 2;
  out.y = row * TILE + TILE;
  out.col = Math.round(col);
  out.row = Math.round(row);
}

/** Riding a lift (on a ride leg), rather than walking. */
export function riding(route: Route, cur: Cursor): boolean {
  return route.rides[cur.leg];
}

/** DOWN (towards us) in a lift; walking, the way it goes (along a row, up across the road and into
 * a door, down coming back). */
export function facing(route: Route, cur: Cursor): Dir {
  if (route.rides[cur.leg]) return "down";
  const a = route.points[cur.dir > 0 ? cur.leg : cur.leg + 1];
  const b = route.points[cur.dir > 0 ? cur.leg + 1 : cur.leg];
  if (b.col !== a.col) return b.col > a.col ? "right" : "left";
  return b.row < a.row ? "up" : "down";
}

/** How far along `leg` the point nearest feet (x, y) is, clamped to the leg: how a rebuilt world
 * re-routes a traveller from where it stands. */
export function project(route: Route, leg: number, x: number, y: number): number {
  const a = route.points[leg];
  const b = route.points[leg + 1];
  const along = b.row === a.row ? (x - (a.col * TILE + TILE / 2)) * Math.sign(b.col - a.col) : (y - (a.row + 1) * TILE) * Math.sign(b.row - a.row);
  return Math.min(legLength(route, leg), Math.max(0, along));
}

/** Seconds a whole trip takes, end to end, either way. */
export function tripSeconds(route: Route): number {
  let s = 0;
  for (let leg = 0; leg < LEGS; leg++) s += legLength(route, leg) / speed(route, leg);
  return s;
}
