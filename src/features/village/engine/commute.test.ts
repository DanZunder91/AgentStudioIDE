/**
 * The commute's route and stepping (engine/commute.ts): bench → aisle → the lounge's lift → the far
 * sidewalk → across the road → the near sidewalk → the building's door → its lift → the seat. The
 * expected waypoints are read off the World CONTRACT (the lift stops, the street row, the bench props,
 * the seat) — never off the module's own arithmetic.
 */

import { describe, expect, it } from "vitest";

import { TILE, type Seat, type VillageAgent, type World } from "../villageTypes";
import { buildCityWorld, floorKey, planCity } from "./city";
import {
  advance,
  benchTiles,
  COMMUTE_RIDE,
  COMMUTE_WALK,
  commuteRoute,
  facing,
  legLength,
  LEGS,
  place,
  project,
  RIDES,
  riding,
  tripSeconds,
  type Cursor,
  type Route,
} from "./commute";
import { WALK_SPEED } from "./sim";
import { buildWorld, planHouses } from "./world";

function agent(key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return { key, parentKey: null, origin: "ide", title: key, folder, activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null, ...extra };
}
const subs = (parent: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${parent}.s${i}`, "x", { parentKey: parent }));

/** The reference street: the HQ between gazelle (24 sub-agents: two desk rows) and two small teams. */
const roster = planCity([agent("g", "gazelle"), ...subs("g", 24), agent("a", "alpha"), ...subs("a", 2), agent("b", "beta"), ...subs("b", 2), agent("solo", "solo")]);
const world = buildCityWorld(roster.plans, { seats: 64 });
const city = world.city!;
const lounge = city.lounge!;
const benches = world.props.filter((p) => p.kind === "bench");
const benchAt = (i: number) => {
  const p = benches.find((b) => b.index === i)!;
  return { col: p.col, row: p.row };
};
const seat = (id: string): Seat => world.seats.find((s) => s.id === id)!;
const gazelle = city.buildings.find((b) => b.key === "gazelle")!;
/** Gazelle's last seat: the far end of its floor's SECOND desk row. */
const farSeat = seat(`${floorKey("g")}:team:23`);

describe("benchTiles", () => {
  it("indexes the lounge's bench props by seat number, whatever order they come in; other props are not benches", () => {
    const w: World = {
      ...buildWorld([]),
      props: [
        { id: "b2", kind: "bench", col: 9, row: 4, w: 1, h: 1, index: 2 },
        { id: "chair", kind: "chair", col: 1, row: 1, w: 1, h: 1, index: 1 },
        { id: "b0", kind: "bench", col: 5, row: 4, w: 1, h: 1, index: 0 },
        { id: "b1", kind: "bench", col: 7, row: 6, w: 1, h: 1, index: 1 },
      ],
    };
    expect(benchTiles(w)).toEqual([
      { col: 5, row: 4 },
      { col: 7, row: 6 },
      { col: 9, row: 4 },
    ]);
    expect(benchTiles(world)).toHaveLength(64);
    expect(benchTiles(world)[37]).toEqual(benchAt(37));
  });
});

describe("commuteRoute", () => {
  it("runs bench → its aisle → the lounge's lift → up to the kiosk → across the road → the near sidewalk → the door → up the building's lift → along the seat's row", () => {
    const bench = benchAt(40); // the third bench row, left half
    const s = farSeat;
    const r = commuteRoute(world, bench, s)!;
    const lift = gazelle.lift!;
    expect(r.points).toEqual([
      bench,
      { col: bench.col, row: bench.row + 1 },
      { col: lounge.lift.col, row: bench.row + 1 },
      { col: lounge.lift.col, row: lounge.lift.top },
      { col: lounge.lift.col, row: city.street },
      { col: lift.col, row: city.street },
      { col: lift.col, row: lift.bottom },
      { col: lift.col, row: s.row },
      { col: s.col, row: s.row },
    ]);
    expect(r.rides).toEqual([false, false, true, false, false, false, true, false]);
    // What the contract promises about those points, independently of how they are computed:
    // every lift leg starts and ends at a stop of its own lift…
    const [, , onAisle, kiosk, near, , door, floor] = r.points;
    expect(lounge.lift.stops).toContain(onAisle.row);
    expect(kiosk.row).toBe(lounge.lift.stops[0]);
    expect(door.row).toBe(lift.stops[lift.stops.length - 1]);
    expect(lift.stops).toContain(floor.row);
    // …the kiosk is the lift prop on the far sidewalk, the crossing is the two road rows…
    const kioskProp = world.props.find((p) => p.kind === "lift")!;
    expect([kioskProp.col, kioskProp.row]).toEqual([kiosk.col, kiosk.row]);
    expect([city.street + 1, city.street + 2].map((row) => world.tiles[row * world.cols + kiosk.col])).toEqual(["road", "road"]);
    expect(world.tiles[near.row * world.cols + near.col]).toBe("path");
    // …the door is the building's street door, and every leg runs along a row or a column.
    expect([door.col, door.row]).toEqual([gazelle.doorCol, gazelle.row + gazelle.h - 1]);
    for (let i = 0; i < LEGS; i++) {
      const [a, b] = [r.points[i], r.points[i + 1]];
      expect(a.col === b.col || a.row === b.row).toBe(true);
    }
  });

  it("without a bench starts at the lounge lift's lowest stop: the first two legs take no length", () => {
    const r = commuteRoute(world, null, farSeat)!;
    const low = { col: lounge.lift.col, row: lounge.lift.bottom };
    expect(r.points.slice(0, 3)).toEqual([low, low, low]);
    expect([legLength(r, 0), legLength(r, 1)]).toEqual([0, 0]);
    expect(r.points[3]).toEqual({ col: lounge.lift.col, row: lounge.lift.top });
  });

  it("is null with no lounge (a city without capacity, the village) or no lift (a seat in a building without a team)", () => {
    expect(commuteRoute(buildCityWorld(roster.plans), null, farSeat)).toBeNull();
    const village = buildWorld(planHouses([agent("v", "proj")]));
    expect(commuteRoute(village, null, village.seats[0])).toBeNull();
    expect(city.buildings.find((b) => b.key === "solo")!.lift).toBeUndefined();
    expect(commuteRoute(world, benchAt(0), seat(`${floorKey("solo")}:lead`))).toBeNull();
  });
});

/** A small route by hand: P0 (0,0) → P1 (0,1) … with a known length per leg. */
const tiles = (pts: [number, number][]) => pts.map(([col, row]) => ({ col, row }));
const hand: Route = {
  // bench (2,0) ↓ aisle (2,1) → lift (5,1) ↑ kiosk (5,−3)… lengths: 1, 3, 4, 2, 3, 1, 2, 4 tiles
  points: tiles([
    [2, 0],
    [2, 1],
    [5, 1],
    [5, -3],
    [5, -5],
    [8, -5],
    [8, -6],
    [8, -8],
    [12, -8],
  ]),
  rides: RIDES,
};
const LENS = [1, 3, 4, 2, 3, 1, 2, 4];
const walkSec = (tilesN: number) => (tilesN * TILE) / COMMUTE_WALK;
const rideSec = (tilesN: number) => (tilesN * TILE) / COMMUTE_RIDE;

describe("advance / place — stepping along a route", () => {
  it("walks the walk legs at COMMUTE_WALK and rides the ride legs at COMMUTE_RIDE, carrying time over leg ends exactly", () => {
    expect(LENS.map((_, i) => legLength(hand, i))).toEqual(LENS.map((n) => n * TILE));
    const cur: Cursor = { leg: 0, d: 0, dir: 1 };
    // Leg 0 (1 tile) and leg 1 (3 tiles) walking, then half a second into the ride (leg 2).
    expect(advance(hand, cur, walkSec(4) + 0.125)).toBe(false);
    expect(cur.leg).toBe(2);
    expect(cur.d).toBeCloseTo(0.125 * COMMUTE_RIDE);
    // The whole trip takes exactly the sum of its legs at their speeds.
    const total = walkSec(1 + 3 + 2 + 3 + 1 + 4) + rideSec(4 + 2);
    expect(tripSeconds(hand)).toBeCloseTo(total);
    const fresh: Cursor = { leg: 0, d: 0, dir: 1 };
    expect(advance(hand, fresh, total - 0.01)).toBe(false);
    expect(advance(hand, fresh, 0.02)).toBe(true);
    expect(fresh).toEqual({ leg: LEGS - 1, d: 4 * TILE, dir: 1 });
    // Arrived, it stays.
    expect(advance(hand, fresh, 5)).toBe(true);
    expect(fresh).toEqual({ leg: LEGS - 1, d: 4 * TILE, dir: 1 });
  });

  it("comes back the same way at the same speeds when its direction flips, and stops at the bench end", () => {
    const cur: Cursor = { leg: 0, d: 0, dir: 1 };
    advance(hand, cur, walkSec(4) + 0.125); // half-way into the lounge's ride
    cur.dir = -1;
    expect(advance(hand, cur, 0.125)).toBe(false);
    const at = { x: 0, y: 0, col: 0, row: 0 };
    place(hand, cur, at);
    expect(at).toEqual({ x: 5 * TILE + 8, y: 2 * TILE, col: 5, row: 1 }); // back on the lounge's aisle, at the lift
    expect(advance(hand, cur, walkSec(4) - 0.01)).toBe(false);
    expect(cur.leg).toBe(0);
    expect(advance(hand, cur, 0.02)).toBe(true);
    expect(cur).toEqual({ leg: 0, d: 0, dir: -1 });
  });

  it("crosses zero-length legs in no time, either way (a traveller with no bench)", () => {
    const r = commuteRoute(world, null, farSeat)!;
    const out: Cursor = { leg: 0, d: 0, dir: 1 };
    expect(advance(r, out, 0.05)).toBe(false);
    expect(out.leg).toBe(2);
    expect(out.d).toBeCloseTo(0.05 * COMMUTE_RIDE);
    out.dir = -1;
    expect(advance(r, out, 0.06)).toBe(true);
    expect(out).toEqual({ leg: 0, d: 0, dir: -1 });
  });

  it("places the feet at the bottom centre of the tile it stands on, in between mid-leg; zero dt moves nothing", () => {
    const at = { x: 0, y: 0, col: 0, row: 0 };
    const cur: Cursor = { leg: 1, d: 0, dir: 1 };
    place(hand, cur, at);
    expect(at).toEqual({ x: 2 * TILE + 8, y: 2 * TILE, col: 2, row: 1 });
    cur.d = 1.75 * TILE; // 1.75 tiles from (2,1) towards (5,1)
    place(hand, cur, at);
    expect(at).toEqual({ x: 3.75 * TILE + 8, y: 2 * TILE, col: 4, row: 1 });
    cur.leg = 3; // the crossing, (5,−3) → (5,−5), a quarter tile in
    cur.d = 4;
    place(hand, cur, at);
    expect(at).toEqual({ x: 5 * TILE + 8, y: -3 * TILE + TILE - 4, col: 5, row: -3 });
    expect(advance(hand, cur, 0)).toBe(false);
    expect(cur).toEqual({ leg: 3, d: 4, dir: 1 });
    // A zero-length leg places at its point.
    const r = commuteRoute(world, null, farSeat)!;
    place(r, { leg: 0, d: 0, dir: 1 }, at);
    expect([at.col, at.row]).toEqual([lounge.lift.col, lounge.lift.bottom]);
  });
});

describe("facing / riding", () => {
  it("faces DOWN in a lift; walking, the way it goes — out and back", () => {
    const way = (dir: 1 | -1) => LENS.map((_, leg) => facing(hand, { leg, d: 1, dir }));
    // bench↓aisle, →lift, ride, ↑road, →door col, ↑door, ride, →seat
    expect(way(1)).toEqual(["down", "right", "down", "up", "right", "up", "down", "right"]);
    expect(way(-1)).toEqual(["up", "left", "down", "down", "left", "down", "down", "left"]);
    expect(LENS.map((_, leg) => riding(hand, { leg, d: 0, dir: 1 }))).toEqual([false, false, true, false, false, false, true, false]);
  });

  it("on the real street: up across the road towards the buildings, down coming back; along the sidewalk towards the building", () => {
    const r = commuteRoute(world, benchAt(3), farSeat)!;
    expect(facing(r, { leg: 3, d: 0, dir: 1 })).toBe("up");
    expect(facing(r, { leg: 3, d: 0, dir: -1 })).toBe("down");
    // Gazelle stands right of the HQ: out is rightwards along the sidewalk.
    expect(gazelle.col).toBeGreaterThan(lounge.lift.col);
    expect(facing(r, { leg: 4, d: 0, dir: 1 })).toBe("right");
    expect(facing(r, { leg: 4, d: 0, dir: -1 })).toBe("left");
  });
});

describe("project — re-routing from where it stands", () => {
  it("finds the nearest point of a leg, clamped to it: along a row it keeps x, up a column it keeps y", () => {
    // Leg 4 runs along row −5 from col 5 to col 8.
    const y = -5 * TILE + TILE;
    expect(project(hand, 4, 6 * TILE + 8, y)).toBe(TILE);
    expect(project(hand, 4, 6 * TILE + 8, y + 3 * TILE)).toBe(TILE); // the street moved: same x, new row
    expect(project(hand, 4, 0, y)).toBe(0);
    expect(project(hand, 4, 40 * TILE, y)).toBe(3 * TILE);
    // Leg 2 rides UP column 5 from row 1 to row −3: the y keeps the height, the x snaps to the shaft.
    expect(project(hand, 2, 9 * TILE, TILE)).toBe(TILE); // feet on row 0: one tile up from row 1
    expect(project(hand, 2, 5 * TILE + 8, 99 * TILE)).toBe(0);
    expect(project(hand, 2, 5 * TILE + 8, -99 * TILE)).toBe(4 * TILE);
    // A leg walked leftwards and one ridden downwards measure from their own start.
    const back: Route = { points: [...hand.points].reverse(), rides: RIDES };
    expect(project(back, 3, 6 * TILE + 8, y)).toBe(2 * TILE);
    expect(project(back, 5, 5 * TILE + 8, 0)).toBe(2 * TILE); // feet on row −1: two rows down from −3
    // A zero-length leg is its one point.
    const none = commuteRoute(world, null, farSeat)!;
    expect(project(none, 0, 0, 0)).toBe(0);
  });

  it("round-trips with place: a traveller's own spot projects back to its own distance", () => {
    const r = commuteRoute(world, benchAt(50), farSeat)!;
    const at = { x: 0, y: 0, col: 0, row: 0 };
    for (let leg = 0; leg < LEGS; leg++) {
      const d = legLength(r, leg) / 2;
      place(r, { leg, d, dir: 1 }, at);
      expect(project(r, leg, at.x, at.y)).toBeCloseTo(d);
    }
  });
});

describe("speeds — a trip across a typical city takes ≲ 12 s", () => {
  it("brisk: walking faster than an idle stroll, riding faster still", () => {
    expect(COMMUTE_WALK).toBeGreaterThan(WALK_SPEED);
    expect(COMMUTE_RIDE).toBeGreaterThan(COMMUTE_WALK);
  });

  it("every bench to every desk of the reference street takes at most 12 s (and at an idle stroll it would not)", () => {
    const desks = world.seats.filter((s) => s.forSub);
    let longest = 0;
    let slowest = 0;
    for (let i = 0; i < 64; i++)
      for (const s of desks) {
        const r = commuteRoute(world, benchAt(i), s)!;
        longest = Math.max(longest, tripSeconds(r));
        let walked = 0;
        for (let leg = 0; leg < LEGS; leg++) walked += legLength(r, leg) / (RIDES[leg] ? COMMUTE_RIDE : WALK_SPEED * 2);
        slowest = Math.max(slowest, walked);
      }
    expect(longest).toBeLessThanOrEqual(12);
    expect(longest).toBeGreaterThan(9); // the far corners really are far: the bound is not vacuous
    expect(slowest).toBeGreaterThan(12); // at twice an idle stroll it would not make it
  });
});
