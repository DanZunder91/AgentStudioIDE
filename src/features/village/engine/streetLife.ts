/** Passers-by: anonymous walkers, NOT agents (never hit-tested, labelled or counted). They enter
 * and leave off-screen, and nothing inside the world depends on the camera. Deterministic (one
 * seeded pool); `walkers()` returns the pool's own items, mutated in place: don't keep them. */

import { TILE, type Ambience, type DayPhase, type DrawItem, type WalkerDrink, type WalkerVend, type WeatherKind, type World } from "../villageTypes";
import { PALETTE_COUNT } from "./palette";
import { mulberry32, type Rng } from "./rng";
import { WALK_FRAME_SEC, WALK_SPEED } from "./sim";
import { BRAKE_MS, CRUISE_MS, SUBWAY_CYCLE_MS } from "./subway";

/** A passer-by's draw item (the pool's own object — see `StreetLife.walkers`). */
export type WalkerItem = Extract<DrawItem, { t: "walker" }>;

/** A passer-by's stroll, world px/s: slower than an agent's idle walk (`WALK_SPEED`, 48) — they amble. */
export const STROLL = 36;
/** Each person's pace is `STROLL` ± this share of it (its own, for its whole walk). */
export const STROLL_SPREAD = 0.15;
/** World px of one sidewalk per person, by day in fair weather (both directions together). */
export const SPACING = 640;
/** The pool: never more people than this at once, however far the view reaches. */
export const MAX_WALKERS = 96;
/** World px past the view (and past the world's ends) where people arrive and leave: wider than a person and their umbrella. */
export const MARGIN = 24;
/** A person walks up to this many px above the bottom of its sidewalk tile (its own line, so two do not walk in one). */
export const LANE_DEPTH = 5;
/** The share of people who carry an umbrella. */
export const UMBRELLA_SHARE = 0.65;
/** Seconds an umbrella takes to open or close. */
export const OPEN_SEC = 0.35;
/** A carrier opens (or closes) its umbrella this long after the weather turns: its own delay, in this range. */
export const REACT_SEC: readonly [number, number] = [0.2, 3];
/** Share of far-sidewalk walkers heading for the entrance who go down (`RUSH`-weighted): ~3.5 a
 * train, one `BURST`, so the subway neither drains nor floods the street. */
export const SUBWAY_SHARE = 0.7;
/** Down-goers cluster before a train: `hi` in the `ms` before one is due, else `lo`; the weights
 * average 1 over the trains' spacing, so the total going down is unchanged. */
export const RUSH = { ms: 60_000, hi: 1.3, lo: 0.4 } as const;
/** A train's people coming up: `min`..`max` on a fair day (crowd-scaled, at least one), the first
 * `delay` ms after it stops, each next `gap` ms later. */
export const BURST = { min: 2, max: 5, delay: 7000, gap: [600, 1400] as const } as const;
/** The frame clock's ms between two trains at the station (one each way per cycle), and into each when one stops. */
export const TRAIN_EVERY = SUBWAY_CYCLE_MS / 2;
export const TRAIN_STOPS = CRUISE_MS + BRAKE_MS;
/** Seconds on the subway stairs (going down or coming up). */
export const STAIRS_SEC = 1.2;
/** World px a person moves along the sidewalk while on the stairs. */
export const STAIRS_RUN = 8;
/** World px a person sinks on the stairs: the whole sprite (its feet row is its 32nd). */
export const SINK = 32;
/** World px before the stairs where a person going down starts closing its umbrella. */
export const CLOSE_AHEAD = 24;
/** Hue shifts a passer-by wears — the lounge's waiters' set (`WAITER_HUES`), so the sprite bank caches no new sheet. */
export const LOOK_HUES: readonly number[] = [0, 15, 345];
/** Umbrella colours (render/umbrella.ts `CANOPIES` has this many). */
export const CANOPIES = 6;
/** World px walked per walk-animation frame: an agent's stride (`WALK_SPEED` × `WALK_FRAME_SEC`), so feet never slide. */
export const FRAME_STRIDE = WALK_SPEED * WALK_FRAME_SEC;
/** The sim's clamp: a backgrounded tab must not move the street by a second at once. */
const MAX_DT = 0.1;

/** Purchases a minute on the whole street by day in fair weather (fewer as the crowd thins). */
export const BUY_PER_MIN = 1;
/** The chance per machine passed never goes over this (a street with one machine still sees mostly passers-by). */
export const MAX_BUY_SHARE = 0.5;
/** A purchase, seconds from the stop: pay → `flash` → `drop` (can in the tray) → `take` → `took`
 * (can in hand) → `leave`. */
export const VEND = { flash: 0.8, drop: 1.7, take: 2.3, took: 2.7, leave: 3.2 } as const;
/** A machine's buttons (render/tokyoProps.ts: one under each of its five bottle columns). */
export const BUTTONS = 5;
/** World px between a machine's side and its buyer's feet. */
export const VEND_GAP = 6;
/** World px before its stop where a walker decides whether to buy. */
export const DECIDE_AHEAD = 24;
/** A drinker sips every SIP_PERIOD[0]..SIP_PERIOD[1] s (its own), for `SIP_SEC`. */
export const SIP_PERIOD: readonly [number, number] = [4, 8];
export const SIP_SEC = 0.8;

/** How busy the street is by the clock: fewer at night, a few less at dawn, dusk and evening. */
export const PHASE_CROWD: Readonly<Record<DayPhase, number>> = {
  night: 0.3,
  dawn: 0.5,
  morning: 1,
  noon: 1,
  afternoon: 1,
  evening: 0.8,
  dusk: 0.6,
};
/** How busy the street is by the weather: fewer in rain, fewer still in a storm or snow. */
export const WEATHER_CROWD: Readonly<Record<WeatherKind, number>> = {
  clear: 1,
  cloudy: 1,
  fog: 0.8,
  drizzle: 0.8,
  rain: 0.6,
  snow: 0.45,
  storm: 0.35,
};
/** The frame-clock ms at which the last train stopped at or before `nowMs`. */
export function lastStop(nowMs: number): number {
  return Math.floor((nowMs - TRAIN_STOPS) / TRAIN_EVERY) * TRAIN_EVERY + TRAIN_STOPS;
}

/** The chance a far walker heading for the entrance goes down, at `nowMs`: more in the minute before a train. */
export function downChance(nowMs: number): number {
  const toNext = lastStop(nowMs) + TRAIN_EVERY - nowMs;
  return SUBWAY_SHARE * (toNext <= RUSH.ms ? RUSH.hi : RUSH.lo);
}

/** Weather an umbrella opens for. */
const WET: ReadonlySet<WeatherKind> = new Set<WeatherKind>(["drizzle", "rain", "storm", "snow"]);

/** The share of the fair-day crowd on the street in `amb` (no sky yet: a fair day). */
export function crowd(amb: Ambience | null): number {
  return amb ? PHASE_CROWD[amb.phase] * WEATHER_CROWD[amb.weather] : 1;
}

/** Whether umbrellas are open in `amb`. */
export function umbrellaWeather(amb: Ambience | null): boolean {
  return !!amb && WET.has(amb.weather);
}

/** In front of everything on its sidewalk tile, behind an agent at the same spot (`characterZ` =
 * feet + 0.5); of two passers-by the nearer (lower feet) is in front. */
export function walkerZ(w: WalkerItem): number {
  const ground = Math.ceil(w.y / TILE) * TILE;
  return ground + 0.5 - (ground - w.y) / 64;
}

/** The two sidewalks. */
const NEAR = 0;
const FAR = 1;
/** What a person is doing. */
const WALK = 0;
const DOWN = 1;
const UP = 2;
const BUY = 3;

/** A vending machine on the street, and where a buyer stands at it when coming from each side (NaN: not from that side). */
interface Machine {
  id: string;
  x0: number;
  bottom: number;
  /** The stop of a walker heading right (it stands at the machine's left) and heading left (at its right). */
  right: number;
  left: number;
}

interface Walker {
  active: boolean;
  side: number;
  x: number;
  dir: 1 | -1;
  speed: number;
  depth: number;
  carrier: boolean;
  react: number;
  waited: number;
  open: number;
  /** Goes down the subway stairs when it reaches them. */
  bound: boolean;
  stage: number;
  /** Seconds on the stairs, or into a purchase. */
  t: number;
  stride: number;
  /** The machine it means to buy from or is buying from (an index of `machines`), or −1. */
  vm: number;
  button: number;
  /** Seconds since it got its drink, and its sip period. */
  sipT: number;
  sipEvery: number;
  hasDrink: boolean;
  vend: WalkerVend;
  drink: WalkerDrink;
  item: WalkerItem;
}

/** A sample of the exponential distribution (mean 1). */
function exp1(rng: Rng): number {
  return -Math.log(1 - rng());
}

/** A Poisson sample of `mean` (Knuth's product of uniforms — the means here are small). */
function poisson(rng: Rng, mean: number): number {
  const floor = Math.exp(-mean);
  let k = 0;
  for (let p = rng(); p > floor; p *= rng()) k++;
  return k;
}

/** World px the street is anchored on: the HQ's door (the lounge's lift), else the world's middle. */
function anchorX(world: World): number {
  const lift = world.city?.lounge?.lift;
  return lift ? (lift.col + 0.5) * TILE : (world.cols * TILE) / 2;
}

/** The vending machines of a city World, left to right, each with the stops a buyer may take at it. */
export function machinesOf(world: World): Machine[] {
  const out: Machine[] = world.props
    .filter((p) => p.kind === "vending")
    .map((p) => ({ id: p.id, x0: p.col * TILE, bottom: (p.row + p.h) * TILE, right: p.col * TILE - VEND_GAP, left: (p.col + p.w) * TILE + VEND_GAP }))
    .sort((a, b) => a.x0 - b.x0);
  // Never stand in front of another machine: a stop within reach of one is not a stop.
  const blocked = (x: number) => out.some((m) => x > m.x0 - VEND_GAP && x < m.x0 + TILE + VEND_GAP);
  for (const m of out) {
    if (blocked(m.right)) m.right = NaN;
    if (blocked(m.left)) m.left = NaN;
  }
  return out;
}

export class StreetLife {
  private readonly rng: Rng;
  private readonly pool: Walker[] = [];
  private readonly free: number[] = [];
  private readonly out: WalkerItem[] = [];
  private world: World | null = null;
  private machines: Machine[] = [];
  /** The chance a walker passing a machine buys from it. */
  private buyShare = 0;
  /** The stretch of street simulated last frame, or null (none yet). */
  private zl: number | null = null;
  private zr = 0;
  /** Per arrival stream (near →, near ←, far →, far ←): expected arrivals left before the next. */
  private readonly due: number[] = [];
  /** The last frame's clock (ms), or null before the first. */
  private clock: number | null = null;
  /** A train's burst still to come up the stairs: the frame-clock ms each one does, from `burstNext` to `burstN`. */
  private readonly burst: number[] = new Array<number>(BURST.max).fill(0);
  private burstN = 0;
  private burstNext = 0;
  private serial = 0;

  constructor(seed = 1) {
    this.rng = mulberry32(seed ^ 0x57ee7);
    for (let i = 0; i < MAX_WALKERS; i++) {
      const vend: WalkerVend = { x0: 0, bottom: 0, machine: "", button: 0, t: 0 };
      const drink: WalkerDrink = { machine: "", button: 0, sip: false };
      const item: WalkerItem = { t: "walker", id: 0, x: 0, y: 0, dir: "right", anim: "walk", frame: 0, palette: 0, hueShift: 0, sink: 0, umbrella: 0, canopy: 0, vend: null, drink: null };
      this.pool.push({ active: false, side: NEAR, x: 0, dir: 1, speed: STROLL, depth: 0, carrier: false, react: 0, waited: 0, open: 0, bound: false, stage: WALK, t: 0, stride: 0, vm: -1, button: 0, sipT: 0, sipEvery: SIP_PERIOD[0], hasDrink: false, vend, drink, item });
      this.free.push(MAX_WALKERS - 1 - i);
    }
    for (let s = 0; s < 4; s++) this.due.push(exp1(this.rng));
  }

  /** This frame's passers-by, in a stable order (the same array every frame, its items mutated in place — don't keep them). */
  walkers(): readonly WalkerItem[] {
    return this.out;
  }

  /** Advance by `dtSec`; the view spans world x `viewX0..viewX1` (the stretch always holds the
   * whole world too); `nowMs` is the FRAME clock the train runs on (engine/subway.ts). */
  update(dtSec: number, world: World, amb: Ambience | null, viewX0: number, viewX1: number, nowMs: number): void {
    const dt = Math.min(Math.max(dtSec, 0), MAX_DT);
    if (world !== this.world) this.rebase(world);
    const city = world.city;
    this.out.length = 0;
    if (!city) return;
    const zl = Math.min(0, viewX0) - MARGIN;
    const zr = Math.max(world.cols * TILE, viewX1) + MARGIN;
    const share = crowd(amb);
    const wet = umbrellaWeather(amb);
    const subway = city.subway;
    const stairs = subway ? (subway.entrance.col + 1) * TILE : NaN;
    const down = downChance(nowMs);

    for (let i = 0; i < MAX_WALKERS; i++) {
      const w = this.pool[i];
      if (w.active) this.step(i, w, dt, wet, stairs, zl, zr, down);
    }
    this.fill(zl, zr, share, wet);
    this.arrive(dt, share, wet, zl, zr);
    this.trains(nowMs, share, wet, stairs);

    const near = (city.street + 1) * TILE;
    const far = (city.street + 4) * TILE;
    for (let i = 0; i < MAX_WALKERS; i++) {
      const w = this.pool[i];
      if (w.active) this.out.push(this.draw(w, w.side === NEAR ? near : far));
    }
  }

  // ───────────────────────────── a person ─────────────────────────────

  /** One person's frame: walk (and maybe stop to buy, or reach the stairs), the stairs, a purchase; its umbrella. */
  private step(i: number, w: Walker, dt: number, wet: boolean, stairs: number, zl: number, zr: number, down: number): void {
    if (w.stage === WALK) {
      const from = w.x;
      w.x += w.dir * w.speed * dt;
      w.stride += w.speed * dt;
      // No stairs (a world with no subway): whoever meant to go down walks on, umbrella and all.
      if (Number.isNaN(stairs)) w.bound = false;
      else if (w.side === FAR) {
        const start = stairs - (w.dir * STAIRS_RUN) / 2;
        // CLOSE_AHEAD before the stairs it decides (room to close its umbrella); at them, down it goes.
        // (One that decided is always between the two: a rebuild moves the stairs with everyone.)
        const decide = start - w.dir * CLOSE_AHEAD;
        if (w.dir * (decide - from) > 0 && w.dir * (decide - w.x) <= 0) w.bound = this.rng() < down;
        if (w.bound && w.dir * (start - w.x) <= 0) {
          w.stage = DOWN;
          w.t = 0;
        }
      }
      if (w.side === NEAR && !w.hasDrink) this.passMachines(i, w, from);
      if (w.hasDrink) w.sipT += dt;
    } else if (w.stage === BUY) {
      w.t += dt;
      if (w.t >= VEND.took && !w.hasDrink) {
        const m = this.machines[w.vm];
        w.hasDrink = true;
        w.sipT = 0;
        w.drink.machine = m.id;
        w.drink.button = w.button;
      }
      if (w.t >= VEND.leave) {
        w.stage = WALK;
        w.vm = -1;
      }
    } else {
      w.t += dt;
      w.x += ((w.dir * STAIRS_RUN) / STAIRS_SEC) * dt;
      w.stride += w.speed * dt;
      if (w.t >= STAIRS_SEC) {
        if (w.stage === DOWN) return this.retire(i);
        w.stage = WALK;
      }
    }
    if (w.x < zl || w.x > zr) return this.retire(i);
    this.umbrella(w, dt, wet, stairs);
  }

  /** A near-sidewalk walker without a drink, moved from `from`: decide at a machine, or stop at the one it chose. */
  private passMachines(i: number, w: Walker, from: number): void {
    for (let k = 0; k < this.machines.length; k++) {
      const m = this.machines[k];
      const stop = w.dir > 0 ? m.right : m.left;
      if (Number.isNaN(stop)) continue;
      if (w.vm === k) {
        if (w.dir * (stop - w.x) <= 0) {
          // Arrived: it stops exactly there (this frame it walked a little less), facing the machine.
          w.x = stop;
          w.stage = BUY;
          w.t = 0;
          w.button = Math.floor(this.rng() * BUTTONS);
        }
        continue;
      }
      // No "unless it has a plan already": two usable stops facing one way are ≥ 32 px apart (machinesOf
      // blocks a stop beside a machine), so a walker stops at the one it chose before it reaches the
      // decide point of the next.
      const decide = stop - w.dir * DECIDE_AHEAD;
      if (w.dir * (decide - from) > 0 && w.dir * (decide - w.x) <= 0 && !this.taken(k, i) && this.rng() < this.buyShare) w.vm = k;
    }
  }

  /** Is machine `k` already someone else's (heading to it or buying)? */
  private taken(k: number, self: number): boolean {
    for (let j = 0; j < MAX_WALKERS; j++) if (j !== self && this.pool[j].active && this.pool[j].vm === k) return true;
    return false;
  }

  /** Open in wet weather while on the sidewalk, after the carrier's own delay; closed at once on
   * the stairs or within `CLOSE_AHEAD` px of going down them. */
  private umbrella(w: Walker, dt: number, wet: boolean, stairs: number): void {
    const closing = w.bound && w.stage === WALK && w.dir * (stairs - (w.dir * STAIRS_RUN) / 2 - w.x) < CLOSE_AHEAD;
    if (closing) {
      w.open = Math.max(0, w.open - dt / OPEN_SEC);
      return;
    }
    const want = w.carrier && wet && (w.stage === WALK || w.stage === BUY) ? 1 : 0;
    if (w.open === want) {
      w.waited = 0;
      return;
    }
    w.waited += dt;
    if (w.waited < w.react) return;
    w.open = want > w.open ? Math.min(1, w.open + dt / OPEN_SEC) : Math.max(0, w.open - dt / OPEN_SEC);
  }

  /** This frame's draw item for `w`, whose sidewalk tile ends at world y `ground`. */
  private draw(w: Walker, ground: number): WalkerItem {
    const it = w.item;
    it.x = w.x;
    it.y = ground - w.depth;
    it.dir = w.dir > 0 ? "right" : "left";
    it.anim = w.stage === BUY ? "idle" : "walk";
    it.frame = w.stage === BUY ? 0 : Math.floor(w.stride / FRAME_STRIDE) % 4;
    it.sink = w.stage === DOWN ? (SINK * w.t) / STAIRS_SEC : w.stage === UP ? SINK * (1 - w.t / STAIRS_SEC) : 0;
    it.umbrella = w.open;
    if (w.stage === BUY) {
      const m = this.machines[w.vm];
      w.vend.x0 = m.x0;
      w.vend.bottom = m.bottom;
      w.vend.machine = m.id;
      w.vend.button = w.button;
      w.vend.t = w.t;
      it.vend = w.vend;
    } else it.vend = null;
    if (w.hasDrink) {
      // Its sip clock runs only while it walks (from 0 when it took the can), so never at the machine.
      w.drink.sip = w.sipT % w.sipEvery >= w.sipEvery - SIP_SEC;
      it.drink = w.drink;
    } else it.drink = null;
    return it;
  }

  private retire(i: number): void {
    this.pool[i].active = false;
    this.free.push(i);
  }

  // ───────────────────────────── arrivals ─────────────────────────────

  /** Spawn on `side` at `x` heading `dir` at `stage` (WALK, or UP out of the subway); nobody when
   * the pool is full. Its look, pace, line, umbrella and sip rhythm are drawn here. */
  private spawn(side: number, x: number, dir: 1 | -1, stage: number, wet: boolean): void {
    const i = this.free.pop();
    if (i === undefined) return;
    const w = this.pool[i];
    const rng = this.rng;
    w.active = true;
    w.side = side;
    w.x = x;
    w.dir = dir;
    w.stage = stage;
    w.t = 0;
    w.speed = STROLL * (1 + STROLL_SPREAD * (2 * rng() - 1));
    w.depth = Math.floor(rng() * (LANE_DEPTH + 1));
    w.carrier = rng() < UMBRELLA_SHARE;
    w.react = REACT_SEC[0] + rng() * (REACT_SEC[1] - REACT_SEC[0]);
    w.waited = 0;
    w.open = stage === WALK && w.carrier && wet ? 1 : 0;
    w.stride = rng() * 4 * FRAME_STRIDE;
    w.vm = -1;
    w.hasDrink = false;
    w.sipT = 0;
    w.sipEvery = SIP_PERIOD[0] + rng() * (SIP_PERIOD[1] - SIP_PERIOD[0]);
    // Down the subway: decided on the way, CLOSE_AHEAD before the stairs (`step`).
    w.bound = false;
    const it = w.item;
    it.id = ++this.serial;
    it.palette = Math.floor(rng() * PALETTE_COUNT);
    it.hueShift = LOOK_HUES[Math.floor(rng() * LOOK_HUES.length)];
    it.canopy = Math.floor(rng() * CANOPIES);
  }

  /** Fill the part of the street the stretch grew by since last frame (all of it on the first). */
  private fill(zl: number, zr: number, share: number, wet: boolean): void {
    if (this.zl === null) this.scatter(zl, zr, share, wet);
    else {
      if (zl < this.zl) this.scatter(zl, Math.min(this.zl, zr), share, wet);
      if (zr > this.zr) this.scatter(Math.max(this.zr, zl), zr, share, wet);
    }
    this.zl = zl;
    this.zr = zr;
  }

  /** People mid-walk on both sidewalks over world x [a, b), at the crowd's density. */
  private scatter(a: number, b: number, share: number, wet: boolean): void {
    for (let side = NEAR; side <= FAR; side++) {
      const n = poisson(this.rng, ((b - a) * share) / SPACING);
      for (let k = 0; k < n; k++) this.spawn(side, a + this.rng() * (b - a), this.rng() < 0.5 ? 1 : -1, WALK, wet);
    }
  }

  /** Arrivals at each sidewalk end: `share · STROLL / (2 · SPACING)` per second, so the street
   * holds `share / SPACING` people per px of sidewalk. */
  private arrive(dt: number, share: number, wet: boolean, zl: number, zr: number): void {
    const rate = (share * STROLL) / (2 * SPACING);
    for (let s = 0; s < 4; s++) {
      const side = s < 2 ? NEAR : FAR;
      const dir = s % 2 === 0 ? 1 : -1;
      for (this.due[s] -= rate * dt; this.due[s] <= 0; this.due[s] += exp1(this.rng)) this.spawn(side, dir > 0 ? zl : zr, dir, WALK, wet);
    }
  }

  /** A train that stopped since the last frame schedules its `BURST`. Nothing is made up: on the
   * first frame or after a clock jump past a burst's start, none is scheduled (all would pop out at
   * once); a pending burst keeps its times, even through a frame with no subway. */
  private trains(nowMs: number, share: number, wet: boolean, stairs: number): void {
    const prev = this.clock;
    this.clock = nowMs;
    if (Number.isNaN(stairs) || prev === null) return;
    const stop = lastStop(nowMs);
    if (stop > prev && nowMs - stop < BURST.delay) {
      const n = Math.max(1, Math.round(share * (BURST.min + Math.floor(this.rng() * (BURST.max - BURST.min + 1)))));
      let at = stop + BURST.delay;
      for (let k = 0; k < n; k++) {
        this.burst[k] = at;
        at += BURST.gap[0] + this.rng() * (BURST.gap[1] - BURST.gap[0]);
      }
      this.burstN = n;
      this.burstNext = 0;
    }
    for (; this.burstNext < this.burstN && this.burst[this.burstNext] <= nowMs; this.burstNext++) {
      const dir = this.rng() < 0.5 ? 1 : -1;
      this.spawn(FAR, stairs - (dir * STAIRS_RUN) / 2, dir, UP, wet);
    }
  }

  // ───────────────────────────── a new world ─────────────────────────────

  /** Swap in `world`: everyone moves with the HQ's door; a buyer keeps its machine if one stands
   * where it stood (else walks on); outside a city the street empties. */
  private rebase(world: World): void {
    const prev = this.world;
    this.world = world;
    const old = this.machines;
    this.machines = world.city ? machinesOf(world) : [];
    // Walkers pass each usable stop at STROLL / (2 · SPACING) a second by day: the chance per pass that
    // makes BUY_PER_MIN purchases a minute over all of them.
    let stops = 0;
    for (const m of this.machines) stops += (Number.isNaN(m.right) ? 0 : 1) + (Number.isNaN(m.left) ? 0 : 1);
    this.buyShare = stops > 0 ? Math.min(MAX_BUY_SHARE, ((BUY_PER_MIN / 60) * 2 * SPACING) / (STROLL * stops)) : 0;
    if (!world.city) {
      for (let i = 0; i < MAX_WALKERS; i++) if (this.pool[i].active) this.retire(i);
      this.zl = null;
      return;
    }
    const d = prev ? anchorX(world) - anchorX(prev) : 0;
    if (this.zl !== null) {
      this.zl += d;
      this.zr += d;
    }
    for (const w of this.pool) {
      if (!w.active) continue;
      w.x += d;
      if (w.vm < 0) continue;
      const x0 = old[w.vm].x0 + d;
      w.vm = this.machines.findIndex((m) => m.x0 === x0 && !Number.isNaN(w.dir > 0 ? m.right : m.left));
      if (w.vm < 0 && w.stage === BUY) w.stage = WALK;
    }
  }
}
