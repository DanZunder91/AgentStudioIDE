/** Road traffic is DECORATION; only the crossing ties it to agents. Japan keeps LEFT. The crossing
 * is busy if someone is on it or about to be: (1) on the street within LINGER or heading there,
 * (2) in or toward the lounge lift, (3) stepping off a bench. Each fixed a graze in a sim. */

import { TILE, type Ambience, type VehicleKind, type VehicleView, type WeatherKind, type World } from "../villageTypes";
import { mulberry32, range, type Rng } from "./rng";
import { crossingOf } from "./streetTheme";

/** Same clamp as the sim: a backgrounded tab must not fling a car down the street. */
export const MAX_DT = 0.1;
/** The road's lanes: 0 = the far lane (drives right), 1 = the near lane (drives left). */
export const LANES = 2;
/** The most vehicles in one lane — the pool holds `LANES × MAX_PER_LANE`. */
export const MAX_PER_LANE = 6;
/** Seconds between two arrivals in a lane, by day (uniform). */
export const ARRIVAL_GAP: readonly [number, number] = [6, 20];
/** How many times further apart arrivals are at night. */
export const NIGHT_GAPS = 2.5;
/** Speed share in heavy weather. */
export const HEAVY_PACE = 0.8;
/** Weather that slows the traffic. */
export const HEAVY: ReadonlySet<WeatherKind> = new Set<WeatherKind>(["rain", "storm", "snow", "fog"]);
/** One arrival in BUS_EVERY is a bus; one in TAXI_EVERY a taxi; one car in KEI_EVERY a kei car. */
export const BUS_EVERY = 6;
export const TAXI_EVERY = 4;
export const KEI_EVERY = 3;

/** Per kind: body length (world px), cruise speed range (px/s), acceleration (px/s²), paints to pick from. */
export const SPEC: Record<VehicleKind, { len: number; speed: readonly [number, number]; accel: number; liveries: number }> = {
  car: { len: 38, speed: [88, 104], accel: 110, liveries: 6 },
  kei: { len: 30, speed: [80, 92], accel: 100, liveries: 4 },
  taxi: { len: 38, speed: [96, 110], accel: 120, liveries: 4 },
  bus: { len: 64, speed: [64, 72], accel: 90, liveries: 2 },
};

/** Braking, px/s² — what an obstacle's distance lets a vehicle still go (√(2·BRAKE·d)). */
export const BRAKE = 220;
/** World px between a stopped vehicle and the one ahead (or a person). */
export const GAP = 6;
/** World px a waiting vehicle's front stays short of the crossing's stripes. */
export const STOP_GAP = 3;
/** World px the road is driven past each end of the world. */
export const MARGIN = 6 * TILE;
/** World px past the view's edges a vehicle is born and leaves (longer than any vehicle). */
export const PAD = 80;
/** A vehicle over the walking line of a busy crossing clears it at CLEAR_PACE × speed, CLEAR_PUSH ×
 * acceleration: a bus clears in ≤ 0.7 s, inside the ~0.97 s a bench commuter needs to reach the
 * near lane. */
export const CLEAR_PACE = 2;
export const CLEAR_PUSH = 4;
/** World px between one vehicle's rear and the next one's front within which they clear the stripes together. */
export const CONVOY = 2 * TILE;
/** Seconds ahead a person's path is followed to the crossing (rules 1 and 2). */
export const HORIZON = 2;
/** Seconds ahead a person's path is followed into a lane (a vehicle then stops short of it). */
export const OBS_HORIZON = 1;
/** Half a person's body width, world px. */
export const PERSON_HALF = 7;
/** World px round the crossing's tiles that still count as its landing. */
export const LANDING = 4;
/** World px either side of the crossing where anyone, even walking away, keeps it busy: a commuter
 * changing its mind turns round where it stands (engine/sim.ts). */
export const LINGER = 6 * TILE;
/** Faster than this (px/s) a person did not walk there: a rebuild re-placed it. */
export const MAX_PERSON_SPEED = 300;
/** A person moving slower than this (px/s) along an axis is not moving along it. */
const STILL = 1;

/** A person: any `CharacterView` is one (`key` gives it a velocity; without one it only counts where it stands). */
export interface TrafficPerson {
  key?: string;
  /** Feet, world px. */
  x: number;
  y: number;
  /** Seated (at a desk, on a bench): going nowhere — but getting up from a lounge bench is a commuter on its way. */
  seated?: boolean;
}

/** Lane `lane`'s direction: the far lane (0) drives right, the near lane left (Japan keeps left — see the module note). */
function dirOf(lane: number): 1 | -1 {
  return lane === 0 ? 1 : -1;
}

/** Lane `lane`'s row, its direction, and the road under its wheels (the row's bottom). */
export function laneOf(street: number, lane: number): { row: number; dir: 1 | -1; y: number } {
  const row = street + 1 + lane;
  return { row, dir: dirOf(lane), y: (row + 1) * TILE };
}

/** The crossing of each World (`crossingOf` builds a fresh box per call; the traffic asks every frame). */
const CROSSINGS = new WeakMap<World, ReturnType<typeof crossingOf>>();
function crossingFor(world: World): ReturnType<typeof crossingOf> {
  let x = CROSSINGS.get(world);
  if (x === undefined) CROSSINGS.set(world, (x = crossingOf(world)));
  return x;
}

/** Draw-list depth: the road under its wheels + 0.25, in front of anything on its row, behind a
 * walker on the same line (+0.5). */
export function vehicleZ(v: Pick<VehicleView, "y">): number {
  return v.y + 0.25;
}

/** Does the segment from (x, y) to (x + dx, y + dy) touch the closed box [x0, x1] × [y0, y1]? */
export function segmentHits(x: number, y: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  if (dx === 0) {
    if (x < x0 || x > x1) return false;
  } else {
    const a = (x0 - x) / dx;
    const b = (x1 - x) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (dy === 0) {
    if (y < y0 || y > y1) return false;
  } else {
    const a = (y0 - y) / dy;
    const b = (y1 - y) / dy;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

/** A pooled vehicle: its view plus the driving state. */
interface Veh extends VehicleView {
  /** Its front bumper in LANE coordinates (`dir · x`: growing downstream). */
  s: number;
  cruise: number;
  accel: number;
}

/** A person's last position and velocity (px/s), stamped with the update that saw it. */
interface Track {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seated at the last look (its feet then carry the seat's offset: no velocity across a sit or a stand). */
  seated: boolean;
  stamp: number;
}

export class TrafficFx {
  private readonly rngs: Rng[] = [];
  private readonly free: Veh[] = [];
  /** Each lane's vehicles, the furthest downstream first. */
  private readonly lanes: Veh[][] = [];
  /** Seconds until each lane's next arrival. */
  private readonly due: number[] = [];
  private readonly out: VehicleView[] = [];
  private readonly tracks = new Map<string, Track>();
  private stamp = 0;
  private warm = false;
  private _busy = false;
  // Scratch, refilled every update: the people in or about to enter a lane (lane bit mask, x span).
  private readonly pMask: number[] = [];
  private readonly pX0: number[] = [];
  private readonly pX1: number[] = [];
  private pCount = 0;
  /** Forget a person not seen this update (bound once: the sweep allocates nothing). */
  private readonly sweep = (t: Track, key: string): void => {
    if (t.stamp !== this.stamp) this.tracks.delete(key);
  };

  constructor(seed = 1) {
    for (let l = 0; l < LANES; l++) {
      this.rngs.push(mulberry32((seed ^ Math.imul(l + 1, 0x9e3779b1)) >>> 0));
      this.lanes.push([]);
      this.due.push(0);
    }
    for (let i = 0; i < LANES * MAX_PER_LANE; i++)
      this.free.push({ kind: "car", x: 0, w: 0, y: 0, dir: 1, livery: 0, odo: 0, braking: false, seed: 0, speed: 0, s: 0, cruise: 0, accel: 0 });
  }

  /** The vehicles of the last `update` (the same array, and the same objects, every frame — don't keep them). */
  vehicles(): readonly VehicleView[] {
    return this.out;
  }

  /** Was the crossing busy at the last `update` (someone on it or about to be)? */
  get busy(): boolean {
    return this._busy;
  }

  /** Advance by `dtSec` (clamped to [0, MAX_DT]); nothing outside a city. `amb` null = a plain day;
   * yields to `people`; `view` is the world-x span on screen. */
  update(dtSec: number, world: World, amb: Ambience | null, people: readonly TrafficPerson[], view: { x0: number; x1: number }): void {
    const city = world.city;
    if (!city) {
      for (const lane of this.lanes) while (lane.length > 0) this.free.push(lane.pop() as Veh);
      this.out.length = 0;
      this.warm = false;
      this._busy = false;
      return;
    }
    const dt = Math.min(Math.max(dtSec, 0), MAX_DT);
    const night = amb?.phase === "night";
    const pace = amb && HEAVY.has(amb.weather) ? HEAVY_PACE : 1;
    const d0 = Math.min(-MARGIN, view.x0 - PAD);
    const d1 = Math.max(world.cols * TILE + MARGIN, view.x1 + PAD);
    const crossing = crossingFor(world);
    this.sense(world, city.street, people, dt, crossing);
    if (!this.warm) {
      this.warm = true;
      for (let l = 0; l < LANES; l++) this.lay(l, d0, d1, night, crossing);
    }
    for (let l = 0; l < LANES; l++) {
      const dir = dirOf(l);
      this.arrive(l, dt, dir > 0 ? d0 : -d1, night);
      // The stop line, in lane coordinates: STOP_GAP short of the crossing's upstream edge; and its far edge.
      const stop = crossing ? (dir > 0 ? crossing.col * TILE : -(crossing.col + crossing.w) * TILE) - STOP_GAP : Infinity;
      const far = crossing ? stop + STOP_GAP + crossing.w * TILE : Infinity;
      this.drive(l, dt, dir, pace, stop, far, dir > 0 ? d1 : -d0);
    }
    this.collect(city.street);
  }

  // ───────────────────────────── people ─────────────────────────────

  /** Track the people, decide whether the crossing is busy, and list who is in a lane — or, at the crossing, about to be. */
  private sense(world: World, street: number, people: readonly TrafficPerson[], dt: number, crossing: ReturnType<typeof crossingOf>): void {
    const stamp = ++this.stamp;
    const lounge = world.city?.lounge;
    // The crossing with its landings and LINGER either side (rule 1)…
    const cx0 = crossing ? crossing.col * TILE - LINGER : 0;
    const cx1 = crossing ? (crossing.col + crossing.w) * TILE + LINGER : 0;
    const cy0 = (street + 1) * TILE - LANDING;
    const cy1 = (street + 4) * TILE + LANDING;
    // …the lounge lift's shaft, from the kiosk's feet line to its lowest stop's (rule 2), and the lounge (rule 3).
    // Rule 1 looks only at people on the street (or above it): from under it, the only way up is the lift.
    const liftX = lounge ? lounge.lift.col * TILE + TILE / 2 : 0;
    const shaftBottom = lounge ? (lounge.lift.bottom + 1) * TILE + LANDING : 0;
    let room: World["houses"][number] | undefined;
    for (const h of world.houses) if (h.key === lounge?.key) room = h;
    let busy = false;
    let n = 0;
    for (const p of people) {
      const seated = p.seated === true;
      let vx = 0;
      let vy = 0;
      /** Up from its seat this very frame. */
      let rose = false;
      if (p.key !== undefined) {
        const t = this.tracks.get(p.key);
        if (!t) this.tracks.set(p.key, { x: p.x, y: p.y, vx: 0, vy: 0, seated, stamp });
        else {
          rose = t.seated && !seated;
          if (dt > 0) {
            const ax = (p.x - t.x) / dt;
            const ay = (p.y - t.y) / dt;
            const walked = !t.seated && !seated && Math.hypot(ax, ay) <= MAX_PERSON_SPEED;
            t.vx = walked ? ax : 0;
            t.vy = walked ? ay : 0;
          }
          t.x = p.x;
          t.y = p.y;
          t.seated = seated;
          t.stamp = stamp;
          vx = t.vx;
          vy = t.vy;
        }
      }
      // A sitter is going nowhere (at a desk, on a bench) — tracked only to see it get up.
      if (seated) continue;
      if (crossing)
        busy =
          busy ||
          (p.y <= cy1 && segmentHits(p.x, p.y, vx * HORIZON, vy * HORIZON, cx0, cy0, cx1, cy1)) ||
          (!!lounge &&
            // Moving up or down the shaft, or along an aisle towards it — or onto it: the frame it reaches the
            // lift's column it is still walking, not yet riding.
            (Math.abs(vy) > STILL || (Math.abs(vx) > STILL && (liftX - p.x) * vx >= 0)) &&
            segmentHits(p.x, p.y, vx * HORIZON, vy * HORIZON, liftX - TILE / 2, (street + 4) * TILE, liftX + TILE / 2, shaftBottom)) ||
          (!!room && (rose || vy > STILL) && p.x >= room.col * TILE && p.x <= (room.col + room.w) * TILE && p.y > room.row * TILE && p.y <= (room.row + room.h) * TILE);
      // The lanes it is in — a lane row r holds the feet in (r·T + T/2, (r+1)·T + T/2] — or, at the crossing
      // (the only place anyone steps into the road), will be within OBS_HORIZON.
      const k = crossing && p.x >= cx0 && p.x <= cx1 ? OBS_HORIZON : 0;
      const ya = Math.min(p.y, p.y + vy * k);
      const yb = Math.max(p.y, p.y + vy * k);
      let mask = 0;
      for (let l = 0; l < LANES; l++) {
        const row = street + 1 + l;
        if (yb > row * TILE + TILE / 2 && ya <= (row + 1) * TILE + TILE / 2) mask |= 1 << l;
      }
      if (mask === 0) continue;
      this.pMask[n] = mask;
      this.pX0[n] = Math.min(p.x, p.x + vx * k) - PERSON_HALF;
      this.pX1[n] = Math.max(p.x, p.x + vx * k) + PERSON_HALF;
      n++;
    }
    // A busy crossing's walking line (its middle column, where the commuters cross) is blocked in both lanes:
    // a vehicle already past the stop line still stops short of it — unless its body is over it already.
    if (busy) {
      const mid = ((crossing as NonNullable<typeof crossing>).col + (crossing as NonNullable<typeof crossing>).w / 2) * TILE;
      this.pMask[n] = (1 << LANES) - 1;
      this.pX0[n] = mid - PERSON_HALF;
      this.pX1[n] = mid + PERSON_HALF;
      n++;
    }
    this.pCount = n;
    this._busy = busy;
    this.tracks.forEach(this.sweep);
  }

  // ───────────────────────────── arrivals ─────────────────────────────

  /** Seconds to lane `l`'s next arrival. */
  private gap(l: number, night: boolean): number {
    return range(this.rngs[l], ARRIVAL_GAP[0], ARRIVAL_GAP[1]) * (night ? NIGHT_GAPS : 1);
  }

  /** A new vehicle for lane `l` from the pool, its front at lane coordinate `s` (put last in the lane). */
  private spawn(l: number, s: number): Veh {
    const rng = this.rngs[l];
    const r = rng();
    const kind: VehicleKind = r < 1 / BUS_EVERY ? "bus" : r < 1 / BUS_EVERY + 1 / TAXI_EVERY ? "taxi" : rng() < 1 / KEI_EVERY ? "kei" : "car";
    const spec = SPEC[kind];
    const v = this.free.pop() as Veh;
    v.kind = kind;
    v.w = spec.len;
    v.livery = Math.floor(rng() * spec.liveries);
    v.seed = Math.floor(rng() * 0x100000000);
    v.cruise = range(rng, spec.speed[0], spec.speed[1]);
    v.accel = spec.accel;
    v.speed = v.cruise;
    v.odo = 0;
    v.s = s;
    this.lanes[l].push(v);
    return v;
  }

  /** First look at a city: lane `l` laid as if vehicles had been arriving all along, an arrival gap
   * apart (traffic.test.ts pins the spacing), none over the crossing. */
  private lay(l: number, d0: number, d1: number, night: boolean, crossing: ReturnType<typeof crossingOf>): void {
    const dir = dirOf(l);
    const entrance = dir > 0 ? d0 : -d1;
    let s = dir > 0 ? d1 : -d0;
    for (let k = 0; k < MAX_PER_LANE; k++) {
      s -= this.gap(l, night) * SPEC.car.speed[0];
      if (s - SPEC.bus.len < entrance) break;
      const v = this.spawn(l, s);
      // Over the stripes, it waits at the stop line instead.
      if (crossing) {
        const a = dir > 0 ? crossing.col * TILE : -(crossing.col + crossing.w) * TILE;
        if (v.s > a - STOP_GAP && v.s - v.w < a + crossing.w * TILE) v.s = a - STOP_GAP;
      }
    }
    this.due[l] = this.gap(l, night);
  }

  /** Lane `l`'s arrival clock: a vehicle is born at `entrance` when one is due and the entrance is clear. */
  private arrive(l: number, dt: number, entrance: number, night: boolean): void {
    this.due[l] -= dt;
    if (this.due[l] > 0) return;
    const lane = this.lanes[l];
    const last = lane[lane.length - 1] as Veh | undefined;
    if (lane.length < MAX_PER_LANE) {
      // Wait until the last one has cleared the entrance by a gap.
      if (last && last.s - last.w - GAP < entrance) return;
      this.spawn(l, entrance);
    }
    this.due[l] = this.gap(l, night);
  }

  // ───────────────────────────── driving ─────────────────────────────

  /** Lane `l`, front to back: each aims for cruise × `pace`, held to stopping short of the vehicle
   * ahead, the stop line `stop` (while busy and not yet reached) and anyone in its lane; its front
   * is clamped there. Past `exit`, gone. */
  private drive(l: number, dt: number, dir: 1 | -1, pace: number, stop: number, far: number, exit: number): void {
    const lane = this.lanes[l];
    // While the crossing is busy, the vehicles caught on the stripes clear them — and so does the convoy
    // ahead of the last of them (nose to tail, CONVOY px apart at most), or it would hold that one there.
    let last = -1;
    if (this._busy) for (let i = 0; i < lane.length; i++) if (lane[i].s > stop && lane[i].s - lane[i].w < far) last = i;
    let first = last;
    while (first > 0 && lane[first - 1].s - lane[first - 1].w - lane[first].s < CONVOY) first--;
    for (let i = 0; i < lane.length; i++) {
      const v = lane[i];
      let limit = i > 0 ? lane[i - 1].s - lane[i - 1].w - GAP : Infinity;
      if (this._busy && v.s <= stop) limit = Math.min(limit, stop);
      for (let j = 0; j < this.pCount; j++) {
        if ((this.pMask[j] & (1 << l)) === 0) continue;
        const near = dir > 0 ? this.pX0[j] : -this.pX1[j];
        // Ahead of its front (one already alongside its body is passed, not stopped for).
        if (near >= v.s) limit = Math.min(limit, near - GAP);
      }
      // Caught on the stripes by someone stepping up (or ahead of one that is, nose to tail): it clears them, briskly.
      const clearing = i >= first && i <= last;
      const was = v.speed;
      const want = Math.min(v.cruise * pace * (clearing ? CLEAR_PACE : 1), Math.sqrt(2 * BRAKE * Math.max(0, limit - v.s)));
      let speed = want < was ? want : Math.min(want, was + v.accel * (clearing ? CLEAR_PUSH : 1) * dt);
      let s = v.s + speed * dt;
      // Never past the obstacle (and never backwards). Only a move can overshoot, so dt > 0 here.
      const cap = Math.max(v.s, limit);
      if (s > cap) {
        s = cap;
        speed = (s - v.s) / dt;
      }
      v.speed = speed;
      v.braking = speed < was || speed < STILL;
      v.odo += s - v.s;
      v.s = s;
    }
    while (lane.length > 0 && lane[0].s - lane[0].w > exit) this.free.push(lane.shift() as Veh);
  }

  /** Every vehicle's view: its left end, and the road under it from the lane's row in THIS world. */
  private collect(street: number): void {
    const out = this.out;
    out.length = 0;
    for (let l = 0; l < LANES; l++) {
      const dir = dirOf(l);
      const y = (street + 2 + l) * TILE;
      for (const v of this.lanes[l]) {
        v.dir = dir;
        v.x = dir > 0 ? v.s - v.w : -v.s;
        v.y = y;
        out.push(v);
      }
    }
  }
}
