import { describe, expect, it } from "vitest";

import { TILE, type Ambience, type VehicleView, type VillageActivity, type VillageAgent, type WeatherKind, type World } from "../villageTypes";
import { computeAmbience } from "./ambience";
import { buildCityWorld, planCity, type CityPlan } from "./city";
import { buildDrawList, characterZ, propZ } from "./drawList";
import { mulberry32 } from "./rng";
import { VillageSim } from "./sim";
import { crossingOf } from "./streetTheme";
import {
  ARRIVAL_GAP,
  BUS_EVERY,
  CLEAR_PACE,
  CLEAR_PUSH,
  CONVOY,
  GAP,
  HEAVY,
  HEAVY_PACE,
  KEI_EVERY,
  LINGER,
  MARGIN,
  MAX_DT,
  MAX_PER_LANE,
  MAX_PERSON_SPEED,
  NIGHT_GAPS,
  OBS_HORIZON,
  PAD,
  PERSON_HALF,
  SPEC,
  STOP_GAP,
  TAXI_EVERY,
  TrafficFx,
  laneOf,
  segmentHits,
  vehicleZ,
  type TrafficPerson,
} from "./traffic";
import { buildWorld } from "./world";
import { VillageView } from "../villageView";
import { recorder } from "../render/testRecorder";
import { COMMON } from "../render/vehicles";

// ───────────────────────────── fixtures ─────────────────────────────

const floors = (k: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${k}${i}`, label: `${k}${i}`, ide: true }));
const plans = (gazelleFloors: number): CityPlan[] => [
  { key: "gazelle", label: "gazelle", team: 4, hasIde: true, floors: floors("g", gazelleFloors) },
  { key: "app", label: "app", team: 2, hasIde: true, floors: floors("a", 1) },
];
/** The reference City: 56 columns, the street on row 15, the crossing on columns 27–29, the lounge under it. */
const W = buildCityWorld(plans(2), { seats: 16 });
/** The same city, gazelle two floors taller: the street moves down 10 rows. */
const TALL = buildCityWorld(plans(4), { seats: 16 });
/** A City without a capacity layout: no lounge, so no crossing. */
const BARE = buildCityWorld(plans(2));

const street = W.city!.street;
const X = crossingOf(W)!;
const x0 = X.col * TILE;
const x1 = (X.col + X.w) * TILE;
const mid = (X.col + X.w / 2) * TILE;
const lounge = W.city!.lounge!;
const liftX = lounge.lift.col * TILE + TILE / 2;
const room = W.houses.find((h) => h.key === lounge.key)!;
/** Feet lines: the near sidewalk, the far lane, the near lane, the far sidewalk, a lounge aisle. */
const NEAR_WALK = (street + 1) * TILE;
const FAR_LANE = (street + 2) * TILE;
const NEAR_LANE = (street + 3) * TILE;
const FAR_WALK = (street + 4) * TILE;
const AISLE = (lounge.lift.stops[1] + 1) * TILE;
const WORLD_VIEW = { x0: 0, x1: W.cols * TILE };
/** A view so wide the first look lays MAX_PER_LANE in each lane. */
const WIDE = { x0: -40000, x1: 40000 };

const sky = (hour: number, weather: WeatherKind = "clear"): Ambience => computeAmbience(new Date(2026, 9, 26, hour, 0), null, { weather, phase: "auto" });
const DAY = sky(12);
const NIGHT = sky(23);

const DT = 1 / 30;

/** A walker: a position now and a velocity, so `at(t)` is where it is t seconds on. */
function walker(key: string | undefined, x: number, y: number, vx = 0, vy = 0): { at: (t: number) => TrafficPerson } {
  return { at: (t) => ({ ...(key === undefined ? {} : { key }), x: x + vx * t, y: y + vy * t }) };
}

/** Drive `fx` for `seconds` (DT steps), handing it `people(t)`; `each` sees every frame. Returns the time reached. */
function drive(
  fx: TrafficFx,
  seconds: number,
  opts: { world?: World; amb?: Ambience | null; people?: (t: number) => readonly TrafficPerson[]; view?: { x0: number; x1: number }; t0?: number; each?: (t: number) => void } = {},
): number {
  const t0 = opts.t0 ?? 0;
  let t = t0;
  for (; t < t0 + seconds - 1e-9; t += DT) {
    fx.update(DT, opts.world ?? W, opts.amb === undefined ? DAY : opts.amb, opts.people?.(t) ?? [], opts.view ?? WORLD_VIEW);
    opts.each?.(t);
  }
  return t;
}

/** Lane coordinate of a vehicle's front (growing downstream) and of its rear. */
const front = (v: VehicleView) => (v.dir > 0 ? v.x + v.w : -v.x);
const rear = (v: VehicleView) => front(v) - v.w;
const inLane = (fx: TrafficFx, dir: 1 | -1) => fx.vehicles().filter((v) => v.dir === dir);

/**
 * Every vehicle's life: from the frame it appears in `vehicles()` to the last one it is there. Pooled objects
 * are reused — one that leaves a lane can be born in the other in the same update — so a life also ends where
 * an object changes lane or jumps. `ended` is false for those still on the road when the run stops.
 */
interface Life {
  kind: string;
  dir: number;
  first: VehicleView;
  last: VehicleView;
  born: number;
  ended: boolean;
}
function lives(fx: TrafficFx, seconds: number, opts: Parameters<typeof drive>[2] = {}): Life[] {
  const out: Life[] = [];
  const open = new Map<VehicleView, Life>();
  let frame = 0;
  drive(fx, seconds, {
    ...opts,
    each: (t) => {
      const now = new Set(fx.vehicles());
      for (const [v, life] of open)
        if (!now.has(v) || v.dir !== life.dir || Math.abs(v.x - life.last.x) > 10) {
          open.delete(v);
          out.push(life);
        }
      for (const v of now) {
        const life = open.get(v);
        if (life) life.last = { ...v };
        else open.set(v, { kind: v.kind, dir: v.dir, first: { ...v }, last: { ...v }, born: frame, ended: true });
      }
      frame++;
      opts.each?.(t);
    },
  });
  for (const life of open.values()) out.push({ ...life, ended: false });
  return out;
}

// ───────────────────────────── geometry ─────────────────────────────

describe("the road (Japan keeps left)", () => {
  it("the far lane (along the buildings) drives right, the near lane left; a vehicle stands on its row's bottom edge", () => {
    expect(laneOf(street, 0)).toEqual({ row: street + 1, dir: 1, y: FAR_LANE });
    expect(laneOf(street, 1)).toEqual({ row: street + 2, dir: -1, y: NEAR_LANE });
    const fx = new TrafficFx(3);
    fx.update(DT, W, DAY, [], WIDE);
    for (const v of fx.vehicles()) expect(v.y).toBe(v.dir > 0 ? FAR_LANE : NEAR_LANE);
    expect(new Set(fx.vehicles().map((v) => v.dir))).toEqual(new Set([1, -1]));
    // …and they go that way.
    const before = new Map(fx.vehicles().map((v) => [v, v.x]));
    fx.update(DT, W, DAY, [], WIDE);
    for (const v of fx.vehicles()) expect(Math.sign(v.x - (before.get(v) as number))).toBe(v.dir);
  });

  it("segmentHits: a segment touching, crossing or ending short of a box", () => {
    expect(segmentHits(5, 5, 0, 0, 0, 0, 10, 10)).toBe(true); // a point inside
    expect(segmentHits(15, 5, 0, 0, 0, 0, 10, 10)).toBe(false); // a point beside it
    expect(segmentHits(5, 15, 0, 0, 0, 0, 10, 10)).toBe(false); // a point under it
    expect(segmentHits(-10, 5, 30, 0, 0, 0, 10, 10)).toBe(true); // straight through, along x
    expect(segmentHits(5, -10, 0, 30, 0, 0, 10, 10)).toBe(true); // straight through, along y
    expect(segmentHits(-10, 5, 5, 0, 0, 0, 10, 10)).toBe(false); // ends short of it
    expect(segmentHits(5, 30, 0, -10, 0, 0, 10, 10)).toBe(false); // ends short of it, coming up
    expect(segmentHits(-10, 5, 0, 30, 0, 0, 10, 10)).toBe(false); // passes beside it
    expect(segmentHits(-10, -10, 30, 30, 0, 0, 10, 10)).toBe(true); // diagonally through
    expect(segmentHits(-10, 12, 30, -30, 0, 0, 10, 10)).toBe(true); // diagonally, entering through its bottom
    expect(segmentHits(-10, 15, 12, -30, 0, 0, 10, 10)).toBe(false); // diagonally past its corner
    expect(segmentHits(10, 10, 5, 5, 0, 0, 10, 10)).toBe(true); // touching its corner
  });

  it("depth: the near sidewalk's lamps < the far lane < the near lane < the far sidewalk's kiosk and walkers", () => {
    const lamp = W.props.find((p) => p.kind === "lamp")!;
    const kiosk = W.props.find((p) => p.kind === "lift")!;
    expect(lamp.row).toBe(street);
    expect(propZ(lamp)).toBeLessThan(vehicleZ({ y: FAR_LANE }));
    expect(vehicleZ({ y: FAR_LANE })).toBeLessThan(vehicleZ({ y: NEAR_LANE }));
    expect(vehicleZ({ y: NEAR_LANE })).toBeLessThan(propZ(kiosk));
    // In front of what stands on its own row, behind a walker whose feet are on its line.
    expect(vehicleZ({ y: FAR_LANE })).toBeGreaterThan(FAR_LANE);
    expect(vehicleZ({ y: FAR_LANE })).toBeLessThan(characterZ({ y: FAR_LANE, seated: false } as never));
  });
});

// ───────────────────────────── arrivals ─────────────────────────────

describe("arrivals — random, not too many", () => {
  it("is deterministic: the same seed and inputs give the same traffic; another seed, other traffic", () => {
    const trace = (seed: number) => {
      const fx = new TrafficFx(seed);
      const out: string[] = [];
      drive(fx, 120, { each: () => out.push(fx.vehicles().map((v) => `${v.kind}${v.livery}@${v.x.toFixed(3)}`).join(",")) });
      return out;
    };
    expect(trace(11)).toEqual(trace(11));
    expect(trace(11)).not.toEqual(trace(12));
  });

  it("each lane draws its own arrivals: the two lanes' sequences differ", () => {
    const fx = new TrafficFx(5);
    const all = lives(fx, 1800).filter((l) => l.born > 0);
    const seq = (dir: number) => all.filter((l) => l.dir === dir).map((l) => `${l.kind}${l.first.livery}`).join();
    expect(seq(1)).not.toEqual(seq(-1));
  });

  it("by day: one per lane every ARRIVAL_GAP seconds on average; a bus in BUS_EVERY, a taxi in TAXI_EVERY, a third of the cars kei", () => {
    const fx = new TrafficFx(5);
    const T = 3 * 3600;
    const all = lives(fx, T).filter((l) => l.born > 0); // not the first frame's laid traffic
    const mean = (ARRIVAL_GAP[0] + ARRIVAL_GAP[1]) / 2;
    for (const dir of [1, -1]) {
      const n = all.filter((l) => l.dir === dir).length;
      expect(n).toBeGreaterThan((T / mean) * 0.95);
      expect(n).toBeLessThan((T / mean) * 1.05);
    }
    const share = (kind: string) => all.filter((l) => l.kind === kind).length / all.length;
    expect(share("bus")).toBeGreaterThan((1 / BUS_EVERY) * 0.8);
    expect(share("bus")).toBeLessThan((1 / BUS_EVERY) * 1.2);
    expect(share("taxi")).toBeGreaterThan((1 / TAXI_EVERY) * 0.85);
    expect(share("taxi")).toBeLessThan((1 / TAXI_EVERY) * 1.15);
    const cars = 1 - 1 / BUS_EVERY - 1 / TAXI_EVERY;
    expect(share("kei")).toBeGreaterThan((cars / KEI_EVERY) * 0.8);
    expect(share("kei")).toBeLessThan((cars / KEI_EVERY) * 1.2);
    expect(share("car")).toBeGreaterThan(cars * (1 - 1 / KEI_EVERY) * 0.85);
    // Every livery of every kind turns up, and nothing else.
    for (const kind of ["car", "kei", "taxi", "bus"] as const) {
      const paints = new Set(fx.vehicles().length >= 0 ? all.filter((l) => l.kind === kind).map((l) => l.first.livery) : []);
      expect([...paints].sort()).toEqual(Array.from({ length: SPEC[kind].liveries }, (_, i) => i));
      for (const l of all.filter((x) => x.kind === kind)) expect(l.first.w).toBe(SPEC[kind].len);
    }
  });

  it("at night arrivals are NIGHT_GAPS times as far apart", () => {
    const fx = new TrafficFx(5);
    const T = 3 * 3600;
    const n = lives(fx, T, { amb: NIGHT }).filter((l) => l.born > 0 && l.dir === 1).length;
    const expected = T / (((ARRIVAL_GAP[0] + ARRIVAL_GAP[1]) / 2) * NIGHT_GAPS);
    expect(n).toBeGreaterThan(expected * 0.92);
    expect(n).toBeLessThan(expected * 1.08);
  });

  it("a handful on screen at Fit: over an hour of day, at most 6 in the world's span at once, ~2 on average", () => {
    const fx = new TrafficFx(9);
    let most = 0;
    let sum = 0;
    let frames = 0;
    drive(fx, 3600, {
      each: () => {
        const n = fx.vehicles().filter((v) => v.x + v.w > 0 && v.x < W.cols * TILE).length;
        most = Math.max(most, n);
        sum += n;
        frames++;
      },
    });
    expect(most).toBeLessThanOrEqual(6);
    expect(sum / frames).toBeGreaterThan(1);
    expect(sum / frames).toBeLessThan(3);
  });

  it("heavy weather (rain, storm, snow, fog) drives everyone at HEAVY_PACE; drizzle, cloud and a clear day at full speed", () => {
    const leadSpeed = (amb: Ambience) => {
      const fx = new TrafficFx(21);
      drive(fx, 2, { amb, view: WIDE });
      // The lead vehicle of the far lane, nobody ahead of it.
      return inLane(fx, 1)[0].speed;
    };
    const clear = leadSpeed(DAY);
    for (const w of ["rain", "storm", "snow", "fog"] as const) {
      expect(HEAVY.has(w)).toBe(true);
      expect(leadSpeed(sky(12, w))).toBeCloseTo(clear * HEAVY_PACE, 6);
    }
    for (const w of ["drizzle", "cloudy"] as const) expect(leadSpeed(sky(12, w))).toBeCloseTo(clear, 6);
    expect(leadSpeed(null as never)).toBeCloseTo(clear, 6);
    expect(clear).toBeGreaterThanOrEqual(SPEC.car.speed[0] * 0.9);
  });

  it("each is born upstream of the view and leaves downstream of it — never appearing or vanishing on screen", () => {
    for (const view of [{ x0: 300, x1: 700 }, WORLD_VIEW, { x0: -3000, x1: 4000 }]) {
      const fx = new TrafficFx(4);
      const all = lives(fx, 1800, { view });
      expect(all.length).toBeGreaterThan(100);
      for (const l of all) {
        const off = (v: VehicleView) => v.x + v.w <= view.x0 || v.x >= view.x1;
        if (l.born > 0) expect(off(l.first)).toBe(true);
        if (l.ended) expect(off(l.last)).toBe(true);
        // Born upstream, gone downstream.
        if (l.born > 0) expect(l.dir > 0 ? l.first.x < view.x0 : l.first.x >= view.x1).toBe(true);
      }
    }
  });

  it("…from the world ± MARGIN whatever the camera inside it; a wider view widens the stretch", () => {
    const run = (view: { x0: number; x1: number }) => {
      const fx = new TrafficFx(8);
      drive(fx, 300, { view });
      return fx.vehicles().map((v) => `${v.kind}@${v.x.toFixed(6)}`);
    };
    expect(run({ x0: 100, x1: 500 })).toEqual(run({ x0: 350, x1: 900 }));
    expect(run({ x0: -MARGIN + PAD, x1: W.cols * TILE + MARGIN - PAD })).toEqual(run(WORLD_VIEW));
    expect(run({ x0: -2000, x1: 3000 })).not.toEqual(run(WORLD_VIEW));
    // Born exactly at the stretch's upstream end: the far lane's at −MARGIN, the near lane's at the world's width + MARGIN.
    const fx = new TrafficFx(8);
    const born = lives(fx, 600).filter((l) => l.born > 0);
    for (const l of born) {
      const at = l.dir > 0 ? l.first.x + l.first.w : l.first.x;
      const edge = l.dir > 0 ? -MARGIN : W.cols * TILE + MARGIN;
      expect(Math.abs(at - edge)).toBeLessThanOrEqual(l.first.speed * DT + 1e-6);
      expect(l.first.odo).toBeLessThanOrEqual(l.first.speed * DT + 1e-6);
    }
    // …and gone once wholly past the other end: its rear within a frame's drive of it.
    const gone = lives(new TrafficFx(8), 600).filter((l) => l.ended);
    expect(gone.length).toBeGreaterThan(20);
    for (const l of gone) {
      const back = l.dir > 0 ? l.last.x : l.last.x + l.last.w;
      const edge = l.dir > 0 ? W.cols * TILE + MARGIN : -MARGIN;
      expect(Math.abs(back - edge)).toBeLessThanOrEqual(l.last.speed * DT + 1e-6);
    }
  });

  it("the first look lays the road as if the traffic had been running: inside the stretch, apart, never over the crossing", () => {
    let atLine = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const fx = new TrafficFx(seed);
      fx.update(0, W, DAY, [], WORLD_VIEW);
      for (const dir of [1, -1] as const) {
        const lane = inLane(fx, dir);
        expect(lane.length).toBeLessThanOrEqual(MAX_PER_LANE);
        for (let i = 1; i < lane.length; i++) expect(rear(lane[i - 1]) - front(lane[i])).toBeGreaterThanOrEqual(GAP);
        for (const v of lane) {
          expect(v.x + v.w).toBeGreaterThan(-MARGIN - SPEC.bus.len);
          expect(v.x).toBeLessThan(W.cols * TILE + MARGIN + SPEC.bus.len);
          // Clear of the stripes: wholly before or after them.
          expect(v.x + v.w <= x0 || v.x >= x1).toBe(true);
          if (front(v) === (dir > 0 ? x0 : -x1) - STOP_GAP) atLine++;
        }
      }
    }
    // Some seed laid one over the stripes, and it was put back at the stop line.
    expect(atLine).toBeGreaterThan(0);
    // Laid one arrival gap at a car's pace apart: more than a bus put back from the far edge of the stripes
    // to the stop line, plus a gap — so none is ever laid on another.
    expect(ARRIVAL_GAP[0] * SPEC.car.speed[0]).toBeGreaterThan(SPEC.bus.len + X.w * TILE + STOP_GAP + SPEC.bus.len + GAP);
    // Already driving at its own speed, as if it had been all along.
    const fx = new TrafficFx(2);
    fx.update(DT, W, DAY, [], WIDE);
    for (const v of fx.vehicles()) expect(v.speed).toBeGreaterThanOrEqual(SPEC[v.kind].speed[0] - 1e-9);
  });

  it("a very wide stretch is laid with MAX_PER_LANE a lane at most", () => {
    const fx = new TrafficFx(2);
    fx.update(0, W, DAY, [], { x0: -40000, x1: 40000 });
    expect(inLane(fx, 1).length).toBe(MAX_PER_LANE);
    expect(inLane(fx, -1).length).toBe(MAX_PER_LANE);
  });

  it("a lane holds MAX_PER_LANE at most: behind a crossing busy for ten minutes the queue stops growing", () => {
    const fx = new TrafficFx(6);
    const guard = walker("guard", mid, FAR_WALK).at;
    let most = 0;
    drive(fx, 600, {
      people: (t) => [guard(t)],
      each: () => {
        for (const dir of [1, -1] as const) most = Math.max(most, inLane(fx, dir).length);
      },
    });
    expect(most).toBe(MAX_PER_LANE);
    // The queue: each one GAP behind the next, the first at the stop line.
    const lane = inLane(fx, 1).filter((v) => front(v) <= x0);
    expect(front(lane[0])).toBeCloseTo(x0 - STOP_GAP, 6);
    for (let i = 1; i < lane.length; i++) expect(rear(lane[i - 1]) - front(lane[i])).toBeCloseTo(GAP, 6);
  });

  it("an arrival is held while the entrance is still taken, and comes as soon as it clears", () => {
    const fx = new TrafficFx(7);
    // Someone standing in the far lane just inside its entrance: the vehicle born there cannot move.
    const blocker = walker(undefined, -MARGIN + 20, FAR_LANE).at;
    const born = lives(fx, 300, { people: (t) => [blocker(t)] }).filter((l) => l.born > 0 && l.dir === 1);
    expect(born.length).toBe(1);
    expect(front(born[0].last)).toBeLessThanOrEqual(-MARGIN + 20 - PERSON_HALF - GAP + 1e-6);
    // Gone: the held one drives off, and the overdue arrival follows it in within seconds.
    const after = lives(fx, 3).filter((l) => l.born > 0 && l.dir === 1);
    expect(after.length).toBe(1);
  });
});

// ───────────────────────────── driving ─────────────────────────────

describe("driving — gaps, brakes and wheels", () => {
  it("vehicles never overlap, and keep at least GAP when stopped — over an hour of a crossing that keeps getting busy", () => {
    const fx = new TrafficFx(13);
    const rng = mulberry32(1);
    let guard: TrafficPerson[] = [];
    drive(fx, 3600, {
      people: () => {
        if (rng() < DT / 8) guard = guard.length ? [] : [{ x: mid, y: FAR_WALK }];
        return guard;
      },
      each: () => {
        for (const dir of [1, -1] as const) {
          const lane = inLane(fx, dir);
          for (let i = 1; i < lane.length; i++) expect(rear(lane[i - 1]) - front(lane[i])).toBeGreaterThanOrEqual(GAP - 1e-9);
        }
      },
    });
  });

  it("brake lights: on while slowing or standing, off while cruising or pulling away; the wheels turn with the distance driven", () => {
    const fx = new TrafficFx(14);
    let t = 0;
    let v: VehicleView | undefined;
    while (!v && t < 600) {
      t = drive(fx, DT, { t0: t });
      v = inLane(fx, 1).find((u) => front(u) < x0 - 300 && front(u) > 0);
    }
    if (!v) throw new Error("no car came");
    expect(v.braking).toBe(false);
    // Make the crossing busy: the lead vehicle of the far lane brakes for the stop line and stands there.
    const guard = { x: mid, y: FAR_WALK };
    let slowing = false;
    let slowFrames = 0;
    let odo = v.odo;
    const car = v;
    t = drive(fx, 40, {
      t0: t,
      people: () => [guard],
      each: () => {
        if (car.speed > 1 && car.braking) slowing = true;
        if (car.braking && car.speed > 5 && car.speed < SPEC[car.kind].speed[0] - 5) slowFrames++;
        expect(car.odo).toBeGreaterThanOrEqual(odo);
        odo = car.odo;
      },
    });
    const lead = inLane(fx, 1).find((u) => front(u) <= x0)!;
    expect(lead.speed).toBe(0);
    expect(lead.braking).toBe(true);
    expect(slowing).toBe(true);
    // It slowed down over a stretch of frames — at BRAKE, not in one jolt.
    expect(slowFrames).toBeGreaterThan(6);
    // Released: it pulls away — no brake lights — and its odometer counts what it drove.
    const before = { odo: lead.odo, x: lead.x };
    drive(fx, 0.5, { t0: t });
    expect(lead.speed).toBeGreaterThan(0);
    expect(lead.braking).toBe(false);
    expect(lead.odo - before.odo).toBeCloseTo(lead.x - before.x, 6);
  });

  it("a backgrounded tab's huge dt moves a vehicle MAX_DT at most; a negative one not at all", () => {
    const fx = new TrafficFx(15);
    drive(fx, 1, { view: WIDE });
    const v = fx.vehicles()[0];
    const x = v.x;
    fx.update(30, W, DAY, [], WIDE);
    expect(Math.abs(v.x - x)).toBeLessThanOrEqual(v.speed * MAX_DT + 1e-6);
    expect(Math.abs(v.x - x)).toBeGreaterThan(0);
    const y = v.x;
    fx.update(-1, W, DAY, [], WIDE);
    expect(v.x).toBe(y);
  });

  it("allocation-free: the same array every frame, and only ever the pool's LANES × MAX_PER_LANE objects", () => {
    const fx = new TrafficFx(16);
    const list = fx.vehicles();
    const seen = new Set<VehicleView>();
    drive(fx, 1800, {
      each: () => {
        expect(fx.vehicles()).toBe(list);
        for (const v of fx.vehicles()) seen.add(v);
      },
    });
    expect(seen.size).toBeLessThanOrEqual(2 * MAX_PER_LANE);
  });

  it("a world rebuild: everyone keeps its x and its lane, and stands on the new street; a non-city world clears the road, a city lays it again", () => {
    const fx = new TrafficFx(17);
    drive(fx, 30);
    const before = fx.vehicles().map((v) => ({ v, x: v.x, dir: v.dir }));
    expect(before.length).toBeGreaterThan(0);
    fx.update(0, TALL, DAY, [], WORLD_VIEW);
    const tallStreet = TALL.city!.street;
    expect(tallStreet).not.toBe(street);
    for (const b of before) {
      expect(fx.vehicles()).toContain(b.v);
      expect(b.v.x).toBe(b.x);
      expect(b.v.dir).toBe(b.dir);
      expect(b.v.y).toBe(laneOf(tallStreet, b.dir > 0 ? 0 : 1).y);
    }
    // The village has no road: everything leaves at once, and no crossing is busy.
    fx.update(DT, W, DAY, [{ x: mid, y: FAR_LANE }], WORLD_VIEW);
    expect(fx.busy).toBe(true);
    fx.update(DT, buildWorld([]), DAY, [], WORLD_VIEW);
    expect(fx.vehicles()).toEqual([]);
    expect(fx.busy).toBe(false);
    // …and a city again starts with a laid road.
    fx.update(0, W, DAY, [], { x0: -40000, x1: 40000 });
    expect(fx.vehicles().length).toBe(2 * MAX_PER_LANE);
  });
});

// ───────────────────────────── the crossing ─────────────────────────────

describe("the crossing — never through a person", () => {
  /** Is the crossing busy for `who` (one person, its velocity measured over two frames)? */
  function busyFor(who: { at: (t: number) => TrafficPerson }, world: World = W): boolean {
    const fx = new TrafficFx(1);
    fx.update(DT, world, DAY, [who.at(0)], WORLD_VIEW);
    fx.update(DT, world, DAY, [who.at(DT)], WORLD_VIEW);
    return fx.busy;
  }

  it("someone on the stripes, or on a landing: busy; one standing a little further along the sidewalk: not", () => {
    expect(busyFor(walker("a", mid, FAR_LANE))).toBe(true);
    expect(busyFor(walker("a", mid, NEAR_LANE))).toBe(true);
    expect(busyFor(walker("a", mid, NEAR_WALK))).toBe(true); // the HQ's door
    expect(busyFor(walker("a", mid, FAR_WALK))).toBe(true); // the kiosk
    // LINGER either side, walking away included.
    expect(busyFor(walker("a", x0 - LINGER + 2, NEAR_WALK))).toBe(true);
    expect(busyFor(walker("a", x1 + LINGER - 10, FAR_WALK, 120, 0))).toBe(true);
    expect(busyFor(walker("a", x0 - LINGER - 6, NEAR_WALK))).toBe(false);
    expect(busyFor(walker("a", x1 + LINGER + 6, FAR_WALK, 120, 0))).toBe(false);
    // Not the street: under the far sidewalk (in the earth), above the near one (a building's door row).
    expect(busyFor(walker("a", x0 - 20, FAR_WALK + 12))).toBe(false);
    expect(busyFor(walker("a", x0 - 20, NEAR_WALK - 12))).toBe(false);
    // Nobody: not busy. Seated: skipped.
    expect(busyFor({ at: () => ({ x: -9999, y: -9999 }) })).toBe(false);
    expect(busyFor({ at: () => ({ key: "s", x: mid, y: FAR_LANE, seated: true }) })).toBe(false);
  });

  it("rule 1: walking towards it along the sidewalk, it is busy HORIZON seconds ahead; walking away or standing back, not", () => {
    expect(busyFor(walker("a", x0 - LINGER - 200, NEAR_WALK, 120, 0))).toBe(true);
    expect(busyFor(walker("a", x0 - LINGER - 200, NEAR_WALK, -120, 0))).toBe(false);
    expect(busyFor(walker("a", x0 - LINGER - 200, NEAR_WALK))).toBe(false);
    expect(busyFor(walker("a", x1 + LINGER + 200, NEAR_WALK, -120, 0))).toBe(true);
    // Too far for HORIZON: 300 px at 120 px/s is 2.5 s away.
    expect(busyFor(walker("a", x0 - LINGER - 300, NEAR_WALK, 120, 0))).toBe(false);
    // Without a key there is no velocity: it counts only where it stands.
    expect(busyFor(walker(undefined, x0 - LINGER - 200, NEAR_WALK, 120, 0))).toBe(false);
  });

  it("…a frame where no time passed (the first after a pause) keeps everyone's velocity", () => {
    const fx = new TrafficFx(1);
    const w = walker("a", x0 - LINGER - 200, NEAR_WALK, 120, 0).at;
    fx.update(DT, W, DAY, [w(0)], WORLD_VIEW);
    fx.update(DT, W, DAY, [w(DT)], WORLD_VIEW);
    expect(fx.busy).toBe(true);
    fx.update(0, W, DAY, [w(DT)], WORLD_VIEW);
    expect(fx.busy).toBe(true);
  });

  it("…a jump faster than MAX_PERSON_SPEED is a rebuild re-placing someone, not a walk towards the crossing", () => {
    const step = (MAX_PERSON_SPEED + 30) * DT;
    expect(busyFor(walker("a", x0 - LINGER - 200, NEAR_WALK, (MAX_PERSON_SPEED - 30), 0))).toBe(true);
    const fx = new TrafficFx(1);
    fx.update(DT, W, DAY, [{ key: "a", x: x0 - LINGER - 200 - step, y: NEAR_WALK }], WORLD_VIEW);
    fx.update(DT, W, DAY, [{ key: "a", x: x0 - LINGER - 200, y: NEAR_WALK }], WORLD_VIEW);
    expect(fx.busy).toBe(false);
  });

  it("…a person's velocity is forgotten while it is gone: back, it starts from standing", () => {
    const fx = new TrafficFx(1);
    fx.update(DT, W, DAY, [{ key: "a", x: x0 - LINGER - 260, y: NEAR_WALK }], WORLD_VIEW);
    fx.update(DT, W, DAY, [], WORLD_VIEW);
    // Back 20 px on: as if it had walked 200 px/s towards the crossing over 0.1 s, were it remembered.
    fx.update(0.1, W, DAY, [{ key: "a", x: x0 - LINGER - 240, y: NEAR_WALK }], WORLD_VIEW);
    expect(fx.busy).toBe(false);
  });

  it("…and across a sit and a stand — its feet carry the seat's offset then, not a walk", () => {
    const fx = new TrafficFx(1);
    fx.update(DT, W, DAY, [{ key: "a", x: x0 - LINGER - 260, y: NEAR_WALK }], WORLD_VIEW);
    fx.update(DT, W, DAY, [{ key: "a", x: x0 - LINGER - 260, y: NEAR_WALK, seated: true }], WORLD_VIEW);
    // Up again 20 px on (as if it had walked 20 px in one frame: 600 px/s… or 200 px/s over 0.1 s).
    fx.update(0.1, W, DAY, [{ key: "a", x: x0 - LINGER - 240, y: NEAR_WALK }], WORLD_VIEW);
    expect(fx.busy).toBe(false);
  });

  it("rule 2: moving in the lounge lift's shaft (either way) or walking an aisle towards it: busy; standing at its foot or walking away: not", () => {
    const shaft = (lounge.lift.stops[0] + 3) * TILE;
    expect(busyFor(walker("r", liftX, shaft, 0, -160))).toBe(true);
    expect(busyFor(walker("r", liftX, shaft, 0, 160))).toBe(true);
    expect(busyFor(walker("r", liftX, AISLE))).toBe(false);
    expect(busyFor(walker("w", liftX - 100, AISLE, 120, 0))).toBe(true);
    expect(busyFor(walker("w", liftX + 100, AISLE, -120, 0))).toBe(true);
    expect(busyFor(walker("w", liftX - 100, AISLE, -120, 0))).toBe(false);
    expect(busyFor(walker("w", liftX + 100, AISLE, 120, 0))).toBe(false);
    // Stepping off the lift onto the aisle (a commuter back from work) is walking away, though it starts in the shaft…
    expect(busyFor(walker("w", liftX + 4, AISLE, 120, 0))).toBe(false);
    expect(busyFor(walker("w", liftX - 4, AISLE, -120, 0))).toBe(false);
    // …while the frame one reaches the lift's column, still walking, counts (`>= 0`: it is on its way up).
    expect(busyFor(walker("w", liftX - 4, AISLE, 120, 0))).toBe(true);
    // Too far down the aisle for HORIZON.
    expect(busyFor(walker("w", liftX - 300, AISLE, 120, 0))).toBe(false);
    // Moving up beside the shaft (onto a bench by the lift) is not in it.
    expect(busyFor(walker("b", liftX - 32, AISLE - 10, 0, -120))).toBe(false);
    expect(busyFor(walker("b", liftX + 32, AISLE - 10, 0, -120))).toBe(false);
    // Below the lowest stop is not the shaft.
    expect(busyFor(walker("r", liftX, AISLE + 2 * TILE, 0, 160))).toBe(false);
    // A lift in a city without a lounge is no crossing's.
    expect(busyFor(walker("r", liftX, shaft, 0, -160), BARE)).toBe(false);
  });

  it("rule 3: anywhere in the lounge, stepping down (off a bench): busy; stepping up, or outside the lounge: not", () => {
    const bench = room.col * TILE + 40;
    expect(busyFor(walker("b", bench, AISLE - 10, 0, 120))).toBe(true);
    expect(busyFor(walker("b", bench, AISLE - 10, 0, -120))).toBe(false);
    expect(busyFor(walker("b", bench, AISLE - 10))).toBe(false);
    // Just outside its walls (left, right), above its back wall, below its floor.
    expect(busyFor(walker("b", room.col * TILE - 5, AISLE - 10, 0, 120))).toBe(false);
    expect(busyFor(walker("b", (room.col + room.w) * TILE + 5, AISLE - 10, 0, 120))).toBe(false);
    expect(busyFor(walker("b", bench, room.row * TILE - 5, 0, 120))).toBe(false);
    expect(busyFor(walker("b", bench, (room.row + room.h) * TILE + 2, 0, 120))).toBe(false);
  });

  it("a city without a lounge has no crossing: nobody at the HQ's door ever stops the traffic", () => {
    expect(crossingOf(BARE)).toBeNull();
    const fx = new TrafficFx(3);
    let stopped = 0;
    drive(fx, 300, {
      world: BARE,
      people: () => [{ x: mid, y: NEAR_WALK }, { x: mid + 40, y: FAR_WALK }],
      each: () => {
        expect(fx.busy).toBe(false);
        stopped += fx.vehicles().filter((v) => v.speed < 1).length;
      },
    });
    expect(stopped).toBe(0);
  });

  it("busy: each lane's first vehicle waits at its stop line, STOP_GAP short of the stripes; clear again, it drives across", () => {
    const fx = new TrafficFx(18);
    const guard = { x: mid, y: FAR_WALK };
    const t = drive(fx, 90, { people: () => [guard] });
    const far = inLane(fx, 1).find((v) => front(v) <= x0)!;
    const near = inLane(fx, -1).find((v) => front(v) <= -x1)!;
    expect(far.x + far.w).toBeCloseTo(x0 - STOP_GAP, 6);
    expect(near.x).toBeCloseTo(x1 + STOP_GAP, 6);
    expect(far.speed).toBe(0);
    expect(near.speed).toBe(0);
    drive(fx, 6, { t0: t });
    expect(far.x).toBeGreaterThan(x1);
    expect(near.x + near.w).toBeLessThan(x0);
  });

  it("someone standing in a lane anywhere stops that lane short of them, and only that lane", () => {
    for (const [dir, y] of [[1, FAR_LANE], [-1, NEAR_LANE]] as const) {
      const fx = new TrafficFx(19);
      // Right behind a vehicle on the world's left (well clear of the crossing): that one is past them, and
      // drives on.
      let t = 0;
      let passed: VehicleView | undefined;
      while (!passed && t < 600) {
        t = drive(fx, DT, { t0: t });
        passed = inLane(fx, dir).find((v) => v.x > 100 && v.x < 160);
      }
      if (!passed) throw new Error("no car came");
      expect((dir > 0 ? passed.x : passed.x + passed.w) + 20).toBeLessThan(x0 - LINGER);
      const at = dir > 0 ? passed.x - 20 : passed.x + passed.w + 20;
      const from = passed.x;
      t = drive(fx, 1, { t0: t, people: () => [{ x: at, y }] });
      expect(Math.abs(passed.x - from)).toBeGreaterThan(60);
      let otherPassed = false;
      drive(fx, 120, {
        t0: t,
        people: () => [{ x: at, y }],
        each: () => {
          for (const v of inLane(fx, dir))
            if (v !== passed && (dir > 0 ? v.x < at : v.x + v.w > at)) expect(front(v)).toBeLessThanOrEqual(dir * at - PERSON_HALF - GAP + 1e-6);
          for (const v of inLane(fx, -dir as 1 | -1)) if (Math.abs(v.x + v.w / 2 - at) < 5) otherPassed = true;
        },
      });
      expect(inLane(fx, dir).some((v) => v.speed === 0 && Math.abs(front(v) - (dir * at - PERSON_HALF - GAP)) < 1e-6)).toBe(true);
      expect(otherPassed).toBe(true);
    }
  });

  it("never backwards: someone stepping a little towards a waiting car does not push it back", () => {
    const fx = new TrafficFx(25);
    let p = 150;
    const t = drive(fx, 120, { people: () => [{ x: p, y: FAR_LANE }] });
    const car = inLane(fx, 1).find((v) => v.speed === 0 && front(v) < p)!;
    const at = front(car);
    expect(at).toBeCloseTo(p - PERSON_HALF - GAP, 6);
    // Three px closer: now within GAP of its front, still ahead of it.
    p -= 3;
    drive(fx, 1, { t0: t, people: () => [{ x: p, y: FAR_LANE }] });
    expect(front(car)).toBe(at);
  });

  it("at the crossing, someone about to step into a lane (within OBS_HORIZON) stops it short of where they will walk", () => {
    // Beside the stripes (inside LINGER, upstream of the far lane's stop line), a slow walker steps down off
    // the near sidewalk at 30 px/s: it reaches the far lane in ~0.27 s, by when an oncoming car 16–22 px away
    // (~90 px/s) would be past it — and a person alongside a car's body is passed, not stopped for.
    // Predicted, the car stops short of where it will walk.
    const px = x0 - 30;
    const speed = 30;
    expect(OBS_HORIZON * speed).toBeGreaterThan(TILE / 2);
    const fx = new TrafficFx(20);
    let t = 0;
    let v: VehicleView | undefined;
    while (!v && t < 600) {
      t = drive(fx, DT, { t0: t });
      v = inLane(fx, 1).find((u) => front(u) > px - 22 && front(u) < px - 16 && u.speed > 80);
    }
    if (!v) throw new Error("no car came");
    const car = v;
    let y = NEAR_WALK;
    let crossed = false;
    drive(fx, 2, {
      t0: t,
      people: () => [{ key: "w", x: px, y: (y += speed * DT) }],
      each: () => {
        if (y <= FAR_LANE + TILE / 2) expect(front(car)).toBeLessThanOrEqual(px - PERSON_HALF - GAP + 1e-6);
        else crossed = true;
      },
    });
    expect(crossed).toBe(true);
  });

  it("…but away from the crossing someone stepping out of a door onto the sidewalk brakes nobody", () => {
    const door = W.city!.buildings.find((b) => b.key === "app")!.doorCol * TILE + TILE / 2;
    const fx = new TrafficFx(22);
    let y = street * TILE;
    let slowed = 0;
    drive(fx, 120, {
      people: () => {
        y = y >= NEAR_WALK ? street * TILE : y + 120 * DT;
        return [{ key: "d", x: door, y }];
      },
      each: () => (slowed += fx.vehicles().filter((v) => v.braking).length),
    });
    expect(slowed).toBe(0);
  });

  it("a vehicle already past its stop line when someone comes rolls up to the walking line and stops there", () => {
    for (const dir of [1, -1] as const) {
      const fx = new TrafficFx(23);
      const line = (dir > 0 ? x0 : -x1) - STOP_GAP;
      let t = 0;
      let v: VehicleView | undefined;
      // Wait for a vehicle whose front has just crossed the stop line.
      while (!v && t < 600) {
        t = drive(fx, DT, { t0: t });
        v = inLane(fx, dir).find((u) => front(u) > line && front(u) < line + 5 && u.speed > 50);
      }
      expect(v).toBeDefined();
      drive(fx, 5, { t0: t, people: () => [{ x: mid, y: FAR_WALK }] });
      expect(front(v!)).toBeCloseTo(dir * mid - PERSON_HALF - GAP, 6);
      expect(v!.speed).toBe(0);
    }
  });

  it("…and one already over the walking line clears the stripes — CLEAR_PACE faster, CLEAR_PUSH as hard — then drives on at its own speed", () => {
    // A moment (the first seed that has one) where a vehicle is over the walking line with another further
    // down the road, beyond a convoy's reach.
    let fx = new TrafficFx(0);
    let t = 0;
    let v: VehicleView | undefined;
    for (let seed = 24; !v && seed < 80; seed++) {
      fx = new TrafficFx(seed);
      for (t = 0; !v && t < 120; ) {
        t = drive(fx, DT, { t0: t });
        const lane = inLane(fx, 1);
        v = lane.find((u, i) => front(u) > mid + PERSON_HALF + 2 && rear(u) < mid - PERSON_HALF && u.speed > 50 && i > 0 && rear(lane[i - 1]) - front(u) >= CONVOY);
      }
    }
    expect(v).toBeDefined();
    const car = v!;
    const cruise = car.speed;
    t = drive(fx, DT, { t0: t, people: () => [{ x: mid, y: FAR_WALK }] });
    expect(car.speed - cruise).toBeGreaterThan(SPEC[car.kind].accel * DT * 1.5);
    expect(car.speed - cruise).toBeLessThanOrEqual(SPEC[car.kind].accel * CLEAR_PUSH * DT + 1e-6);
    let fastest = 0;
    // Further down the road, beyond a convoy's reach: a vehicle there keeps to its own speed.
    let others = 0;
    t = drive(fx, 0.5, {
      t0: t,
      people: () => [{ x: mid, y: FAR_WALK }],
      each: () => {
        if (rear(car) < x1) fastest = Math.max(fastest, car.speed);
        const lane = inLane(fx, 1);
        const i = lane.indexOf(car);
        for (let j = i - 1; j >= 0 && rear(lane[j]) - front(lane[j + 1]) >= CONVOY; j--, others++)
          expect(lane[j].speed).toBeLessThanOrEqual(SPEC[lane[j].kind].speed[1] + 1e-6);
      },
    });
    expect(others).toBeGreaterThan(0);
    expect(fastest).toBeGreaterThan(cruise * 1.2);
    expect(fastest).toBeLessThanOrEqual(cruise * CLEAR_PACE + 1e-6);
    drive(fx, 2, { t0: t, people: () => [{ x: mid, y: FAR_WALK }] });
    expect(car.speed).toBeCloseTo(cruise, 6);
  });
});

describe("the crossing — a convoy clears together", () => {
  it("a queue released from the stop line, caught on the stripes: the one ahead of the caught one hurries too, even off them", () => {
    const fx = new TrafficFx(26);
    const guard = { x: mid, y: FAR_WALK };
    // A queue at the far lane's stop line…
    let t = drive(fx, 120, { people: () => [guard] });
    const queue = inLane(fx, 1).filter((v) => front(v) <= x0);
    expect(queue.length).toBeGreaterThanOrEqual(2);
    const [a, b] = queue;
    // …released: wait until the second is over the walking line, the first nose to tail ahead of it.
    for (const end = t + 30; !(rear(b) < mid - PERSON_HALF && front(b) > mid + PERSON_HALF); t = drive(fx, DT, { t0: t })) if (t > end) throw new Error("it never got there");
    expect(rear(a) - front(b)).toBeLessThan(CONVOY);
    const cruiseA = SPEC[a.kind].speed[1];
    // Someone comes: the first, even once its rear is off the stripes, hurries ahead of the second.
    let fastest = 0;
    drive(fx, 0.6, {
      t0: t,
      people: () => [guard],
      each: () => {
        if (rear(a) > x1 && rear(b) < x1) fastest = Math.max(fastest, a.speed);
      },
    });
    expect(fastest).toBeGreaterThan(cruiseA * 1.1);
  });
});

// ───────────────────────────── the real commute ─────────────────────────────

describe("the real commute against the traffic (engine/sim.ts) — test it hard", () => {
  const ag = (key: string, folder: string, parentKey: string | null, activity: VillageActivity): VillageAgent => ({
    key,
    parentKey,
    origin: "ide",
    title: key,
    folder,
    activity,
    tool: null,
    ideAgentId: key,
    lastActivityAt: null,
  });

  /**
   * A city of three projects and `subs` commuting sub-agents, one of them flipping busy ↔ done every few
   * seconds (far more than real agents do: every flip is a trip across the street, and a flip mid-trip
   * turns the commuter round where it stands), for `seconds` of sim time at `dt`. Reports every frame where a
   * vehicle is over a person in its lane, every pair of overlapping vehicles, and how busy it all was.
   */
  function commute(seed: number, subs: number, seconds: number, dt: number) {
    const folders = ["gazelle", "chat-server", "Agent Studio"];
    const agents: VillageAgent[] = folders.map((f, i) => ag(`root${i}`, f, null, "typing"));
    for (let i = 0; i < subs; i++) agents.push(ag(`s${i}`, folders[i % 3], `root${i % 3}`, "idle"));
    const roster = planCity(agents);
    const world = buildCityWorld(roster.plans, { seats: 64 });
    const sim = new VillageSim({ seed, stayPut: true });
    sim.setWorld(world);
    sim.setLoungeSeats(new Map(agents.map((a, i) => [a.key, i])));
    sim.setAgents(roster.agents);
    const fx = new TrafficFx(seed * 7 + 1);
    const rng = mulberry32(seed);
    const acts = new Map(agents.map((a) => [a.key, a.activity]));
    const out = { overPerson: [] as string[], overlaps: 0, busy: 0, stops: 0, frames: 0, crossings: 0 };
    const onRoad = new Set<string>();
    const lanes = [laneOf(world.city!.street, 0), laneOf(world.city!.street, 1)];
    for (let t = 0; t < seconds; t += dt) {
      if (rng() < dt / 3) {
        const k = `s${Math.floor(rng() * subs)}`;
        acts.set(k, acts.get(k) === "typing" ? "done" : "typing");
        sim.setAgents(planCity(agents.map((a) => ({ ...a, activity: acts.get(a.key)! }))).agents);
      }
      sim.tick(dt);
      const chars = sim.characters();
      fx.update(dt, world, DAY, chars, { x0: 0, x1: world.cols * TILE });
      out.frames++;
      if (fx.busy) out.busy++;
      const vs = fx.vehicles();
      out.stops += vs.filter((v) => v.speed === 0).length;
      for (const c of chars) {
        if (c.seated) continue;
        const lane = lanes.find((l) => c.y > l.y - TILE / 2 && c.y <= l.y + TILE / 2);
        if (lane && !onRoad.has(c.key)) out.crossings++;
        if (lane) onRoad.add(c.key);
        else onRoad.delete(c.key);
        if (!lane) continue;
        for (const v of vs)
          if (v.y === lane.y && c.x + PERSON_HALF > v.x && c.x - PERSON_HALF < v.x + v.w)
            out.overPerson.push(`t=${t.toFixed(2)} ${c.key}@${c.x},${c.y} under ${v.kind} ${v.x.toFixed(1)}+${v.w}`);
      }
      for (const dir of [1, -1] as const) {
        const lane = vs.filter((v) => v.dir === dir);
        for (let i = 1; i < lane.length; i++) if (rear(lane[i - 1]) - front(lane[i]) < GAP - 1e-9) out.overlaps++;
      }
    }
    return out;
  }

  it("one commute, out and back from the bench next to the lift: the crossing is busy without a single gap, at 60 and at 10 fps", () => {
    for (const dt of [1 / 60, MAX_DT])
      for (const bench of [7, 8]) {
        // Benches 7 and 8 are the two right beside the lounge's lift (two columns either side).
        const agents = [ag("lead", "gazelle", null, "typing"), ag("sub", "gazelle", "lead", "idle")];
        const world = buildCityWorld(planCity(agents).plans, { seats: 16 });
        const lift = world.city!.lounge!.lift.col * TILE + TILE / 2;
        const b = world.props.find((p) => p.kind === "bench" && p.index === bench)!;
        expect(Math.abs(b.col * TILE + TILE / 2 - lift)).toBe(2 * TILE);
        const cr = crossingOf(world)!;
        const sim = new VillageSim({ seed: 1, stayPut: true });
        sim.setWorld(world);
        sim.setLoungeSeats(new Map([["sub", bench]]));
        sim.setAgents(planCity(agents).agents);
        const fx = new TrafficFx(1);
        const view = { x0: 0, x1: world.cols * TILE };
        const step = () => {
          sim.tick(dt);
          const chars = sim.characters();
          fx.update(dt, world, DAY, chars, view);
          return chars.find((c) => c.key === "sub")!;
        };
        for (let t = 0; t < 3; t += dt) step();
        expect(step().seated).toBe(true);
        // Out: from the frame it gets up until it is LINGER past the crossing on the near sidewalk.
        sim.setAgents(planCity([agents[0], { ...agents[1], activity: "typing" }]).agents);
        let c = step();
        let frames = 0;
        const clear = (x: number) => x < cr.col * TILE - LINGER || x > (cr.col + cr.w) * TILE + LINGER;
        while (!(c.y === (world.city!.street + 1) * TILE && clear(c.x))) {
          expect(fx.busy).toBe(true);
          c = step();
          if (++frames * dt > 60) throw new Error("it never got there");
        }
        expect(frames * dt).toBeGreaterThan(1);
        // Back: from the first busy frame until it steps off the lounge's lift at the foot of the shaft.
        for (let t = 0; t < 5; t += dt) step(); // at its desk
        sim.setAgents(planCity(agents).agents);
        let back = 0;
        for (c = step(); !fx.busy; c = step()) if (++back * dt > 60) throw new Error("it never came back");
        const shaftFoot = (world.city!.lounge!.lift.bottom + 1) * TILE;
        while (!(c.y === shaftFoot && c.x !== lift)) {
          expect(fx.busy).toBe(true);
          c = step();
          if (++back * dt > 60) throw new Error("it never got there");
        }
      }
  });

  it("forty commuters, busy ↔ done every few seconds, an hour per seed at 60 fps: no vehicle is ever over a person, none overlaps another", () => {
    for (const seed of [1, 2, 3]) {
      const r = commute(seed, 40, 3600, 1 / 60);
      expect(r.overPerson).toEqual([]);
      expect(r.overlaps).toBe(0);
      // Not vacuous: hundreds of crossings, and the traffic really stopped for them.
      expect(r.crossings).toBeGreaterThan(500);
      expect(r.busy / r.frames).toBeGreaterThan(0.2);
      expect(r.stops).toBeGreaterThan(1000);
    }
  }, 60_000);

  it("…and at a choppy 10 fps (the frame clamp's worst)", () => {
    for (const seed of [4, 5]) {
      const r = commute(seed, 40, 3600, MAX_DT);
      expect(r.overPerson).toEqual([]);
      expect(r.overlaps).toBe(0);
      expect(r.crossings).toBeGreaterThan(500);
    }
  }, 60_000);
});

// ───────────────────────────── the draw list ─────────────────────────────

describe("in the draw list (engine/drawList.ts)", () => {
  it("one `vehicle` item per vehicle, z-sorted: lamps on the near sidewalk, then the far lane, the near lane, then the far sidewalk's kiosk and walkers", () => {
    const far: VehicleView = { kind: "bus", x: 200, w: 76, y: FAR_LANE, dir: 1, livery: 0, odo: 0, braking: false, seed: 1, speed: 70 };
    const near: VehicleView = { ...far, kind: "car", x: 210, w: 38, y: NEAR_LANE, dir: -1 };
    const items = buildDrawList(W, [], () => false, 0, null, null, [], [], [], [near, far]);
    const at = (pred: (i: (typeof items)[number]) => boolean) => items.findIndex(pred);
    const iFar = at((i) => i.t === "vehicle" && i.v === far);
    const iNear = at((i) => i.t === "vehicle" && i.v === near);
    const lamp = at((i) => i.t === "prop" && i.prop.kind === "lamp");
    const kiosk = at((i) => i.t === "prop" && i.prop.kind === "lift");
    expect(items.filter((i) => i.t === "vehicle")).toHaveLength(2);
    expect(lamp).toBeLessThan(iFar);
    expect(iFar).toBeLessThan(iNear);
    expect(iNear).toBeLessThan(kiosk);
    // Never a character: nothing to hit-test, label or bubble.
    expect(items.some((i) => i.t === "character" || i.t === "label" && i.tone === "agent")).toBe(false);
  });
});

// ───────────────────────────── the view (villageView.ts) ─────────────────────────────

describe("in the City view (villageView.ts)", () => {
  const agentOf = (key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
    key,
    parentKey: null,
    origin: "ide",
    title: key,
    folder,
    activity: "typing",
    tool: null,
    ideAgentId: key,
    lastActivityAt: null,
    ...extra,
  });
  const trafficOf = (v: VillageView) => (v as unknown as { traffic: TrafficFx }).traffic;

  function cityView(): { view: VillageView; agents: VillageAgent[] } {
    const agents = [agentOf("g", "gazelle"), agentOf("g.s0", "gazelle", { parentKey: "g", activity: "idle" }), agentOf("a", "app")];
    const roster = planCity(agents);
    const view = new VillageView(3, () => null, "city");
    view.setWorld(buildCityWorld(roster.plans, { seats: 16 }));
    view.setAgents(roster.agents);
    view.setCapacity({ machine: null, machineError: null, agents, includesOutside: true, usage: null, usageError: null, context: {}, nowMs: 0, lounge: true });
    view.resize(800, 600, 1);
    return { view, agents };
  }

  it("drives the road every frame and draws it: vehicles in the frame's paint (the Village has none)", () => {
    const { view } = cityView();
    for (let t = 0; t <= 2000; t += 33) view.frame(t, null);
    expect(trafficOf(view).vehicles().length).toBeGreaterThan(0);
    const ctx = recorder();
    view.frame(2033, ctx);
    expect(ctx.of("fillRect").some((c) => c.fillStyle === COMMON.tyre)).toBe(true);
    const village = new VillageView(3, () => null, "village");
    village.setWorld(buildWorld([]));
    village.resize(800, 600, 1);
    const vctx = recorder();
    for (let t = 0; t <= 2000; t += 33) village.frame(t, vctx);
    expect(trafficOf(village).vehicles()).toEqual([]);
    expect(vctx.of("fillRect").some((c) => c.fillStyle === COMMON.tyre)).toBe(false);
  });

  it("yields to the sim's commuters: a sub-agent sent to work crosses, and the crossing is busy while it does", () => {
    const { view, agents } = cityView();
    for (let t = 0; t <= 1000; t += 33) view.frame(t, null);
    expect(trafficOf(view).busy).toBe(false);
    view.setAgents(planCity(agents.map((a) => (a.key === "g.s0" ? { ...a, activity: "typing" as const } : a))).agents);
    let busy = 0;
    for (let t = 1033; t <= 15000; t += 33) {
      view.frame(t, null);
      if (trafficOf(view).busy) busy++;
    }
    expect(busy).toBeGreaterThan(10);
  });

  it("the road runs past the world's ends: a view panned far off the world still sees traffic go by", () => {
    const { view } = cityView();
    view.frame(0, null);
    // Pan so the view's left edge is at world x −3000.
    const cam = view.camera;
    view.pan((-3000 * -cam.zoom - cam.ox) / 1, 0);
    expect(Math.round((0 - view.camera.ox) / view.camera.zoom)).toBe(-3000);
    const x0 = -3000;
    const x1 = x0 + 800 / view.camera.zoom;
    let seen = 0;
    for (let t = 33; t <= 300_000; t += 100) {
      view.frame(t, null);
      seen += trafficOf(view).vehicles().filter((v) => v.x + v.w > x0 && v.x < x1).length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});
