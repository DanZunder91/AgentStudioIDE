/** Checked against the spec and an independent kinematic model, never the code's own helpers. */

import { describe, expect, it } from "vitest";

import { TILE, type CitySubway } from "../villageTypes";
import { buildCityWorld, planCity } from "./city";
import {
  BRAKE_MS,
  CAR_GAP,
  CAR_LEN,
  CRUISE_MS,
  DOOR_MS,
  DOOR_WAIT_MS,
  DWELL_MS,
  REACH_MIN,
  RUN_MS,
  stationStop,
  SUBWAY_CYCLE_MS,
  TRAIN_CARS,
  TRAIN_LEN,
  trainAt,
  trainReach,
  trainSpeed,
} from "./subway";

/** A reference geometry (engine/city.ts, a 7-floor gazelle left of the HQ): the station's columns 19..53, a world 104 wide. */
const reference: CitySubway = { top: 78, bottom: 82, rail: 81, station: { col0: 19, col1: 53 }, entrance: { col: 35, row: 64 } };
const COLS = 104;
/** An empty city's: the station slid against the world's left edge, a world 40 wide. */
const small: CitySubway = { top: 30, bottom: 34, rail: 33, station: { col0: 0, col1: 34 }, entrance: { col: 3, row: 16 } };

const at = (t: number, sub = reference, cols = COLS) => trainAt(sub, cols, t);
const xAt = (t: number, sub = reference, cols = COLS) => at(t, sub, cols)!.x;

describe("the timetable — the spec: the train goes out and comes back, every three minutes", () => {
  it("is a three-minute cycle: a run eastbound from its start, a run westbound from half way, nothing between", () => {
    expect(SUBWAY_CYCLE_MS).toBe(3 * 60_000);
    expect(RUN_MS).toBe(48_000);
    expect(RUN_MS).toBeLessThan(SUBWAY_CYCLE_MS / 2);
    expect(at(0)!.dir).toBe(1);
    expect(at(RUN_MS - 1)!.dir).toBe(1);
    expect(at(RUN_MS)).toBeNull();
    expect(at(SUBWAY_CYCLE_MS / 2 - 1)).toBeNull();
    expect(at(SUBWAY_CYCLE_MS / 2)!.dir).toBe(-1);
    expect(at(SUBWAY_CYCLE_MS / 2 + RUN_MS - 1)!.dir).toBe(-1);
    expect(at(SUBWAY_CYCLE_MS / 2 + RUN_MS)).toBeNull();
    expect(at(SUBWAY_CYCLE_MS - 1)).toBeNull();
    // Exactly one train out and one back per cycle, over many cycles: count the runs that START.
    let starts = 0;
    let on = false;
    for (let t = 0; t < 10 * SUBWAY_CYCLE_MS; t += 250) {
      const now = at(t) !== null;
      if (now && !on) starts++;
      on = now;
    }
    expect(starts).toBe(20);
  });

  it("repeats every cycle, and runs on the frame's clock whatever its origin (before 0 too)", () => {
    for (const t of [0, 7_000, 23_456, 95_000, 130_000]) {
      expect(at(t + SUBWAY_CYCLE_MS)).toEqual({ ...at(t)!, riders: at(t)!.riders + 4 });
      expect(at(t - SUBWAY_CYCLE_MS)).toEqual({ ...at(t)!, riders: at(t)!.riders - 4 });
    }
    // The run before the clock's 0 is a westbound one.
    expect(at(-SUBWAY_CYCLE_MS / 2)!.dir).toBe(-1);
  });

  it("stops with its middle at the station's middle, its doors shut while it moves", () => {
    expect(stationStop(reference)).toBe(36 * TILE);
    expect(stationStop(small)).toBe(17 * TILE);
    const arrive = CRUISE_MS + BRAKE_MS;
    for (const base of [0, SUBWAY_CYCLE_MS / 2])
      for (let t = arrive; t < arrive + DWELL_MS; t += 100) expect(xAt(base + t)).toBe(576);
    for (const t of [0, 5_000, CRUISE_MS, arrive - 1, arrive + DWELL_MS, arrive + DWELL_MS + 3_000, RUN_MS - 1]) expect(at(t)!.doors).toBe(0);
  });

  it("opens its doors a moment after it stops, holds them open, and shuts them a moment before it leaves", () => {
    const arrive = CRUISE_MS + BRAKE_MS;
    const doors = (ms: number) => at(arrive + ms)!.doors;
    expect(doors(0)).toBe(0);
    expect(doors(DOOR_WAIT_MS)).toBe(0);
    expect(doors(DOOR_WAIT_MS + DOOR_MS / 2)).toBeCloseTo(0.5, 9);
    expect(doors(DOOR_WAIT_MS + DOOR_MS)).toBe(1);
    expect(doors(DWELL_MS / 2)).toBe(1);
    expect(doors(DWELL_MS - DOOR_WAIT_MS - DOOR_MS)).toBe(1);
    expect(doors(DWELL_MS - DOOR_WAIT_MS - DOOR_MS / 2)).toBeCloseTo(0.5, 9);
    expect(doors(DWELL_MS - DOOR_WAIT_MS)).toBe(0);
    // A few seconds wide open: it stops a few seconds with its doors open.
    let open = 0;
    for (let t = 0; t < DWELL_MS; t += 10) if (doors(t) === 1) open += 10;
    expect(open).toBeGreaterThanOrEqual(4_000);
  });
});

describe("the run — in from past the world's end, easing into the station and out of it", () => {
  it("starts and ends a run with the WHOLE train past the world's far end, by a world's width at least REACH_MIN", () => {
    const w = COLS * TILE;
    const far = Math.max(w, REACH_MIN);
    // Eastbound: from the west, out to the east.
    expect(xAt(0) + TRAIN_LEN / 2).toBeLessThanOrEqual(-far);
    expect(xAt(RUN_MS - 0.001) - TRAIN_LEN / 2).toBeGreaterThanOrEqual(w + far - 1);
    // Westbound: from the east, out to the west.
    expect(xAt(SUBWAY_CYCLE_MS / 2) - TRAIN_LEN / 2).toBeGreaterThanOrEqual(w + far);
    expect(xAt(SUBWAY_CYCLE_MS / 2 + RUN_MS - 0.001) + TRAIN_LEN / 2).toBeLessThanOrEqual(-far + 1);
    // The reach is to the FARTHER end: the reference station is left of the middle, so the east end decides it.
    expect(trainReach(reference, COLS)).toBe(w - 576 + Math.max(w, REACH_MIN) + TRAIN_LEN / 2);
    // A small world still starts REACH_MIN out, and a station at its very edge measures to the far end.
    expect(trainReach(small, 40)).toBe(40 * TILE - 17 * TILE + REACH_MIN + TRAIN_LEN / 2);
    expect(xAt(0, small, 40) + TRAIN_LEN / 2).toBeLessThanOrEqual(-REACH_MIN);
    // A world wider than REACH_MIN starts a whole world's width out — past its west end here, the farther one.
    const wide: CitySubway = { ...reference, station: { col0: 189, col1: 223 } };
    expect(trainReach(wide, 300)).toBe(206 * TILE + 300 * TILE + TRAIN_LEN / 2);
  });

  it("follows a cruise / constant brake / dwell / constant acceleration / cruise profile (an independent kinematic model)", () => {
    for (const [sub, cols] of [
      [reference, COLS],
      [small, 40],
    ] as const) {
      const D = trainReach(sub, cols);
      // Cruise speed from the profile: D = v·CRUISE + v·BRAKE/2.
      const v = D / (CRUISE_MS + BRAKE_MS / 2);
      expect(trainSpeed(sub, cols)).toBeCloseTo(v, 12);
      const a = v / BRAKE_MS;
      const stop = stationStop(sub);
      /** Distance past the stop (negative before it), integrating the profile phase by phase. */
      const model = (t: number): number => {
        const t1 = CRUISE_MS;
        const t2 = t1 + BRAKE_MS;
        const t3 = t2 + DWELL_MS;
        const t4 = t3 + BRAKE_MS;
        const atT1 = -D + v * t1;
        if (t < t1) return -D + v * t;
        if (t < t2) return atT1 + v * (t - t1) - (a * (t - t1) ** 2) / 2;
        if (t < t3) return 0;
        if (t < t4) return (a * (t - t3) ** 2) / 2;
        return (a * BRAKE_MS ** 2) / 2 + v * (t - t4);
      };
      for (let t = 0; t < RUN_MS; t += 37) {
        expect(xAt(t, sub, cols)).toBeCloseTo(stop + model(t), 6);
        expect(xAt(SUBWAY_CYCLE_MS / 2 + t, sub, cols)).toBeCloseTo(stop - model(t), 6);
      }
    }
  });

  it("is smooth: never a jump between two frames, slowing to a standstill into the station and picking up out of it", () => {
    const v = trainSpeed(reference, COLS);
    const frame = 1000 / 60;
    let prev = xAt(0);
    let prevStep = v * frame;
    for (let t = frame; t < RUN_MS; t += frame) {
      const x = xAt(t);
      const step = x - prev;
      // Always forward (east), never faster than cruising, and the speed changes gently (no jolt).
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(v * frame + 1e-9);
      expect(Math.abs(step - prevStep)).toBeLessThan(v * frame * 0.02);
      prev = x;
      prevStep = step;
    }
    // Speed (px per ms) just before it stops and just after it starts is near zero; at cruise it is v.
    const speed = (t: number) => (xAt(t + 1) - xAt(t)) / 1;
    expect(speed(CRUISE_MS - 10)).toBeCloseTo(v, 9);
    expect(speed(CRUISE_MS + BRAKE_MS - 2)).toBeLessThan(v * 0.001);
    expect(speed(CRUISE_MS + BRAKE_MS + DWELL_MS + 1)).toBeLessThan(v * 0.001);
    expect(speed(RUN_MS - 10)).toBeCloseTo(v, 9);
  });
});

describe("the train and its riders", () => {
  it("has eight cars of CAR_LEN with gangways (five more than the original three), and fits the platform", () => {
    expect(TRAIN_CARS).toBe(3 + 5);
    expect(TRAIN_LEN).toBe(TRAIN_CARS * CAR_LEN + (TRAIN_CARS - 1) * CAR_GAP);
    expect(TRAIN_LEN).toBe(510);
    expect(TRAIN_LEN).toBeLessThanOrEqual((reference.station.col1 - reference.station.col0) * TILE);
  });

  it("changes riders at the station, half way through its stop — the same riders before it, others after, others again next run", () => {
    const arrive = CRUISE_MS + BRAKE_MS;
    const before = at(1_000)!.riders;
    expect(at(arrive + DWELL_MS / 2 - 1)!.riders).toBe(before);
    const after = at(arrive + DWELL_MS / 2)!.riders;
    expect(after).not.toBe(before);
    expect(at(RUN_MS - 1)!.riders).toBe(after);
    const back = at(SUBWAY_CYCLE_MS / 2)!.riders;
    expect(new Set([before, after, back]).size).toBe(3);
  });

  it("runs under a real city: its geometry is the World's (engine/city.ts)", () => {
    const agent = (key: string, folder: string, parentKey: string | null = null) => ({
      key, parentKey, origin: "ide" as const, title: key, folder, activity: "typing" as const, tool: null, ideAgentId: key, lastActivityAt: null,
    });
    const roster = planCity([agent("g", "gazelle"), agent("g.s", "gazelle", "g"), agent("a", "Agent Studio")]);
    const w = buildCityWorld(roster.plans, { seats: 64 });
    const sub = w.city!.subway!;
    const t = trainAt(sub, w.cols, CRUISE_MS + BRAKE_MS + 1_000)!;
    expect(t.x).toBe(((sub.station.col0 + sub.station.col1) / 2) * TILE);
    // Standing there, the whole train is along the platform — none of it past either end.
    expect(t.x - TRAIN_LEN / 2).toBeGreaterThanOrEqual(sub.station.col0 * TILE);
    expect(t.x + TRAIN_LEN / 2).toBeLessThanOrEqual(sub.station.col1 * TILE);
    expect(trainAt(sub, w.cols, 0)!.x + TRAIN_LEN / 2).toBeLessThan(0);
  });
});
