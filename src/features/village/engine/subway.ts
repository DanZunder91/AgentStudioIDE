/**
 * The CITY's SUBWAY timetable (a subway under the Seats lounge, whose
 * train goes out and comes back about every three minutes).
 *
 * One train, one track, one round per `SUBWAY_CYCLE_MS`: EASTBOUND (left to right) at the start of each
 * cycle, WESTBOUND half a cycle later. A run comes in from far beyond the world's end, cruises, brakes
 * to a stop at the station (`CitySubway.station`, under the street entrance), waits there with its doors
 * open, pulls away and cruises out past the other end. Constant deceleration and acceleration, so its
 * speed never jumps: it eases into the station and out of it.
 *
 *   |— cruise in —|— brake —|— dwell (doors open) —|— accelerate —|— cruise out —|      …nothing…      |
 *   0          CRUISE_MS                                                     RUN_MS            CYCLE/2
 *
 * A PURE function of the clock (`trainAt`) and the World: no state, nothing to tick. The renderer asks
 * with the frame's clock (`RenderView.timeMs`, the animation loop's `now`), so every view of the same
 * World on that clock shows the train in the same place; and none of it depends on a camera:
 * where the train is, and where its run starts, are properties of the World.
 *
 * How far out a run starts (`trainReach`): past the world's FAR end from the station, by a world's
 * width (at least `REACH_MIN`), so the train is off screen at Fit even where the view runs far past the
 * world (a tall, narrow city). Its cruising speed follows (`trainSpeed`): a run always takes `RUN_MS`.
 *
 * The train is DECORATION: it runs on a timetable, never on anything an agent does. It
 * is not an agent — never hit-tested, labelled or counted.
 */

import { TILE, type CitySubway } from "../villageTypes";

/** One round — out and back — every three minutes. */
export const SUBWAY_CYCLE_MS = 180_000;
/**
 * Cars in the train, each `CAR_LEN` world px long, `CAR_GAP` px of gangway between two. Eight (up
 * from three).
 */
export const TRAIN_CARS = 8;
export const CAR_LEN = 62;
export const CAR_GAP = 2;
/** The train, end to end (world px): 510. The station's platform is sized from it (engine/city.ts `STATION_W`). */
export const TRAIN_LEN = TRAIN_CARS * CAR_LEN + (TRAIN_CARS - 1) * CAR_GAP;
/** A run's phases (ms): cruising in (and out), braking (and accelerating), standing at the station. */
export const CRUISE_MS = 14_000;
export const BRAKE_MS = 6_000;
export const DWELL_MS = 8_000;
/** One run, end to end: 48 s — well inside the half cycle, so the two runs never meet. */
export const RUN_MS = 2 * (CRUISE_MS + BRAKE_MS) + DWELL_MS;
/** At the station the doors stay shut `DOOR_WAIT_MS` after it stops (and before it leaves), and take `DOOR_MS` to slide. */
export const DOOR_WAIT_MS = 800;
export const DOOR_MS = 700;
/** World px a run starts (and ends) beyond the world's far end from the station, at least. */
export const REACH_MIN = 2048;

/** The train this instant. */
export interface TrainState {
  /** World x of its middle (the rail it runs on is `CitySubway.rail`). */
  x: number;
  /** 1 = eastbound (moving right), −1 = westbound. Its head lamp leads, its red tail lamp trails. */
  dir: 1 | -1;
  /** How far its doors are open: 0 shut .. 1 wide open (only while it stands at the station). */
  doors: number;
  /**
   * Who is aboard, as a seed: one per run before the station and another after it (some got off,
   * others on), so its riders change at the station and nowhere else.
   */
  riders: number;
}

/** World x of the station's middle — where the train's middle stops. */
export function stationStop(sub: CitySubway): number {
  return ((sub.station.col0 + sub.station.col1) / 2) * TILE;
}

/**
 * World px from where a run starts to the stop (and from the stop to where it ends): past the world's
 * farther end from the station by a world's width (at least `REACH_MIN`), and half a train more, so
 * even its last car starts out there.
 */
export function trainReach(sub: CitySubway, cols: number): number {
  const w = cols * TILE;
  const stop = stationStop(sub);
  return Math.max(stop, w - stop) + Math.max(w, REACH_MIN) + TRAIN_LEN / 2;
}

/** The train's cruising speed, world px per ms: its reach covered in a cruise and a brake (half the brake's time at full speed). */
export function trainSpeed(sub: CitySubway, cols: number): number {
  return trainReach(sub, cols) / (CRUISE_MS + BRAKE_MS / 2);
}

/**
 * The train at `timeMs` (the frame's clock) in a World `cols` wide, or null between runs. Eastbound in
 * the first half of each cycle, westbound in the second.
 */
export function trainAt(sub: CitySubway, cols: number, timeMs: number): TrainState | null {
  const half = SUBWAY_CYCLE_MS / 2;
  const n = Math.floor(timeMs / half);
  const local = timeMs - n * half;
  if (local >= RUN_MS) return null;
  const reach = trainReach(sub, cols);
  const v = trainSpeed(sub, cols);
  const arrive = CRUISE_MS + BRAKE_MS;
  const depart = arrive + DWELL_MS;
  // s: how far past the stop it is, along its way (negative before it).
  let s: number;
  if (local < CRUISE_MS) s = v * local - reach;
  else if (local < arrive) s = (-v * (arrive - local) ** 2) / (2 * BRAKE_MS);
  else if (local < depart) s = 0;
  else if (local < depart + BRAKE_MS) s = (v * (local - depart) ** 2) / (2 * BRAKE_MS);
  else s = (v * BRAKE_MS) / 2 + v * (local - depart - BRAKE_MS);
  const dir = n % 2 === 0 ? 1 : -1;
  const at = local - arrive;
  const doors = Math.max(0, Math.min(1, (at - DOOR_WAIT_MS) / DOOR_MS, (DWELL_MS - DOOR_WAIT_MS - at) / DOOR_MS));
  return { x: stationStop(sub) + dir * s, dir, doors, riders: 2 * n + (at < DWELL_MS / 2 ? 0 : 1) };
}
