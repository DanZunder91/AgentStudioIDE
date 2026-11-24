/**
 * StreetLife — the City's PASSERS-BY (things should move to give the city
 * a little life — people walking on the street, at random and only as many as it takes to look
 * alive; in the rain some of them, not all, carry an umbrella, and on a sunny day nobody does; and
 * now and then someone goes to buy something at a vending machine).
 *
 * Anonymous people stroll the two sidewalks — the near one under the buildings (`city.street`) and the
 * far one across the road (`city.street + 3`) — left or right, at a stroll with small differences of
 * pace. They are NOT agents: they never enter the sim's character list, so they are never hit-tested,
 * hovered, labelled or counted, and the renderer draws them with no agent marker and no bubble.
 *
 *   - WHERE: a stretch of street that always holds the whole world, plus the view where it reaches past
 *     the world's ends (the street runs on there): `[min(0, view.x0) − MARGIN, max(world, view.x1) +
 *     MARGIN]`. People arrive at its two ends and leave past them, so they enter and leave OFF-SCREEN;
 *     inside the world nothing depends on the camera — zooming in on the HQ and back out shows the
 *     same people where they were. When the stretch grows (the first frame, a pan or a
 *     zoom past the world's end, a wider world), the part it grew by is filled at once at the same
 *     density — it was off-screen until this frame, so nobody pops in where you were looking — and
 *     whoever is left outside a stretch that shrank (off-screen by construction) is retired.
 *   - HOW MANY: a seeded Poisson arrival process at each end of each sidewalk, sized so the street holds
 *     one person per `SPACING` px of sidewalk by day in fair weather (a handful on screen at Fit), times
 *     `crowd` — fewer at night, fewer in rain, fewer still in a storm or snow. A change of crowd changes
 *     the arrival rate only: the street empties (or fills) as people walk off, never at a stroke.
 *   - THE SUBWAY, on the train's timetable (engine/subway.ts, a pure function of the FRAME clock — the
 *     `nowMs` the renderer draws the train with): a small burst of people (`BURST`: 2–5 on a fair day,
 *     fewer as the crowd thins) comes UP out of its entrance (`CitySubway.entrance`, the `metro` prop) a
 *     few seconds after each train stops at the station — the time to step off and climb the stairs —
 *     and walks off, one after another; nobody comes up between trains. Going DOWN: a far-sidewalk walker
 *     heading for the entrance decides `CLOSE_AHEAD` px before its stairs, more readily in the minute
 *     before a train is due (`RUSH`), closes its umbrella and sinks out of sight over `STAIRS_SEC`. The
 *     chance (`SUBWAY_SHARE`, averaged over the timetable) is sized so as many go down as come up: the
 *     subway neither drains the street nor floods it — the link that makes it feel used.
 *   - UMBRELLAS: a share of the people (`UMBRELLA_SHARE`) carry one. In rain, drizzle, storm or snow a
 *     carrier's is open; in clear, cloudy or fog weather nobody's is. A person keeps that decision for
 *     their whole walk: when the rain starts each carrier opens theirs after a short delay of their own
 *     (so the street does not open in step), and closes it the same way when it stops. Someone who
 *     arrives while it rains arrives with it open.
 *   - VENDING MACHINES (Tokyo — engine/streetTheme.ts puts `vending` props on the near sidewalk): now and
 *     then — about `BUY_PER_MIN` purchase a minute on the whole street by day, rarer at night (the
 *     chance per machine passed is sized to that, so it holds whatever the number of machines) — a
 *     walker who passes one stops BESIDE it on the side it came from, facing it (the machine stays in
 *     view, not behind the buyer), and buys a drink (`VEND`: pays, a button flashes, a can drops into
 *     the tray, the buyer takes it), then walks on with the can, sipping now and then. One buyer per
 *     machine at a time; one drink per walker; never from a spot in front of another machine.
 *
 * Stateful but deterministic, like `WeatherFx`: a fixed pool of `MAX_WALKERS`, one seeded mulberry32,
 * every decision a draw from it — the same seed and the same frames give the same street. Allocation-
 * free on the steady path: `walkers()` returns the same array each frame, its items the pool's own
 * (mutated in place — don't keep them). A world rebuild re-anchors everyone on the HQ's door (the
 * lounge's lift), so the people keep their place on the street as it widens round the HQ; the subway
 * entrance moves with it, a buyer keeps its machine when one stands at the same place (else it walks
 * on), and outside a city nothing walks.
 */

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
/**
 * The share of far-sidewalk walkers heading for the subway entrance who go down it, over the timetable
 * (`RUSH` weighs it by the time to the next train): the far stream past the entrance by day is
 * 2 · STROLL / (2 · SPACING) a second, so 0.7 of it is ~3.5 people a train — one burst (`BURST`).
 */
export const SUBWAY_SHARE = 0.7;
/**
 * Down-goers cluster before a train: in the `ms` before one is due their chance is `SUBWAY_SHARE · hi`,
 * otherwise `SUBWAY_SHARE · lo` — weights that average 1 over the trains' spacing (half a cycle), so the
 * total going down is unchanged.
 */
export const RUSH = { ms: 60_000, hi: 1.3, lo: 0.4 } as const;
/**
 * A train's people coming up: `min`..`max` on a fair day (scaled by the crowd, at least one), the first
 * `delay` ms after the train stops (doors, the platform, the stairs), each next one `gap` ms later.
 */
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
/**
 * A purchase, seconds from the stop: pays until `flash`; a button flashes until `drop`; the can lies in
 * the tray until `take`; the buyer takes it until `took` (the can travels from the tray to its hand);
 * holds it until `leave`, then walks on.
 */
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

/**
 * Where a passer-by is drawn in the scene: in front of everything standing on its sidewalk tile (its
 * lamps, trees, machines and kiosks — like an agent walking there), behind an agent at the same spot
 * (`characterZ` = feet + 0.5), and the nearer of two passers-by (the lower feet) in front.
 */
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

  /**
   * Advance the street by `dtSec` in `world` under `amb`, with the view spanning world x `viewX0..viewX1`
   * (both ends of the view, any order of magnitude — the stretch always holds the whole world too), at
   * `nowMs` on the FRAME clock — the one the train runs on (engine/subway.ts).
   */
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

  /**
   * The umbrella: a carrier wants it open in wet weather while on the sidewalk (walking or buying) — not
   * on the stairs, nor in the last `CLOSE_AHEAD` px before going down them, where it closes at once.
   * Otherwise it follows the weather after the carrier's own delay.
   */
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

  /**
   * A new person on `side` at `x` heading `dir`, at `stage` (WALK, or UP out of the subway); nobody when
   * the pool is full. Its look, pace, line, umbrella and sip rhythm are all drawn here.
   */
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

  /**
   * The arrival streams: each end of each sidewalk at `share · STROLL / (2 · SPACING)` people a second
   * (the street then holds `share / SPACING` per px of sidewalk).
   */
  private arrive(dt: number, share: number, wet: boolean, zl: number, zr: number): void {
    const rate = (share * STROLL) / (2 * SPACING);
    for (let s = 0; s < 4; s++) {
      const side = s < 2 ? NEAR : FAR;
      const dir = s % 2 === 0 ? 1 : -1;
      for (this.due[s] -= rate * dt; this.due[s] <= 0; this.due[s] += exp1(this.rng)) this.spawn(side, dir > 0 ? zl : zr, dir, WALK, wet);
    }
  }

  /**
   * The trains' people coming up the stairs. A train that stopped since the last frame schedules its burst
   * (`BURST`); its people come up, each at its time. Nothing is made up: on the first frame, or after a
   * jump of the clock (a paused tab) past the moment a burst begins, no burst is scheduled — caught up
   * all at once, its people would pop out of the stairs together. A clock run back schedules nothing
   * until it passes a stop again. A burst still pending keeps its times, which are a train's — through a
   * frame with no subway too: when the stairs are back, its people come up.
   */
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

  /**
   * Swap in `world`: everyone (and the stretch) moves with the HQ's door, a buyer keeps its machine
   * when one stands where it stood (else it walks on), and outside a city the street is emptied.
   */
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
