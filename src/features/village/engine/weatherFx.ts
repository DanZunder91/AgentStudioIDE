/** Weather in WORLD px, seeded and allocation-free (pooled; `particles()` reuses one array).
 * Interiors stay dry: drops target outdoor spots only, indoor particles are left out. Off-`ground`
 * drops end with no splash. Rain streak: (x, y) up to (x − rainSlant(wind)·size, y − size). */

import type { Ambience, WeatherKind, WeatherParticle } from "../villageTypes";
import { mulberry32, range, type Rng } from "./rng";

/** Hard cap on live particles (drops + flakes + splashes). */
export const MAX_PARTICLES = 400;
/** Drops/flakes may use at most this many slots — the other MAX_PARTICLES − MAX_DROPS are reserved for splashes. */
export const MAX_DROPS = 340;
/** Rain fall speed, world px/s. */
export const RAIN_SPEED = 220;
/** Horizontal rain speed at wind = ±1, world px/s. */
export const RAIN_WIND = 80;
export const SNOW_SPEED = 28;
export const SPLASH_SEC = 0.18;
/** Lightning flash decay time. */
export const FLASH_SEC = 0.25;
/** Random gap between lightning strikes in a storm, seconds. */
export const FLASH_GAP: [number, number] = [4, 12];
/** Same clamp as the sim: a backgrounded tab must not dump a second of rain at once. */
const MAX_DT = 0.1;
/** World px² of visible area per drop at intensity 1 (density 1). */
const AREA_PER_DROP = 1200;
/** Landing-spot retries before a drop gives up (its whole area is indoors). */
const LANDING_TRIES = 4;

/** Horizontal px per px of fall for rain at `wind` (the streak's slant). */
export function rainSlant(wind: number): number {
  return (wind * RAIN_WIND) / RAIN_SPEED;
}

interface Spec {
  kind: "rain" | "snow";
  density: number;
  size: [number, number];
  alpha: [number, number];
}

/** What each weather precipitates; absent → nothing falls. */
const PRECIP: Partial<Record<WeatherKind, Spec>> = {
  drizzle: { kind: "rain", density: 0.4, size: [3, 5], alpha: [0.3, 0.45] },
  rain: { kind: "rain", density: 1, size: [6, 10], alpha: [0.55, 0.85] },
  storm: { kind: "rain", density: 1.4, size: [8, 12], alpha: [0.5, 0.75] },
  snow: { kind: "snow", density: 0.6, size: [1, 2.5], alpha: [0.75, 1] },
};

interface P extends WeatherParticle {
  active: boolean;
  vx: number;
  vy: number;
  /** Landing spot (drops/flakes). */
  gx: number;
  gy: number;
  /** Snow sway phase; splash age. */
  t: number;
  baseX: number;
}

type Area = { x: number; y: number; w: number; h: number };
type Indoors = (wx: number, wy: number) => boolean;
/** Is world px (wx, wy) ground a drop can splash on? */
type Ground = (wx: number, wy: number) => boolean;

export class WeatherFx {
  private rng: Rng;
  private pool: P[] = [];
  private free: number[] = [];
  private out: WeatherParticle[] = [];
  private drops = 0;
  private splashes = 0;
  private flashT = 0;
  private nextFlash: number | null = null;

  constructor(seed = 1) {
    this.rng = mulberry32(seed);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({ kind: "rain", x: 0, y: 0, size: 0, alpha: 0, active: false, vx: 0, vy: 0, gx: 0, gy: 0, t: 0, baseX: 0 });
      this.free.push(MAX_PARTICLES - 1 - i);
    }
  }

  /** The visible particles of the last `update` (same array every frame — don't keep it). */
  particles(): readonly WeatherParticle[] {
    return this.out;
  }

  /** Lightning brightness 0..1: 1 at a strike, fading out over FLASH_SEC. Storms only. */
  flash(): number {
    return this.flashT / FLASH_SEC;
  }

  update(dtSec: number, amb: Ambience, area: Area, indoors: Indoors, ground?: Ground): void {
    const dt = Math.min(Math.max(dtSec, 0), MAX_DT);
    this.updateFlash(dt, amb.weather === "storm");

    const spec = PRECIP[amb.weather];
    const target = spec ? this.targetDrops(spec, amb.intensity, area) : 0;
    const vx = amb.wind * RAIN_WIND;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      if (p.kind === "splash") {
        p.t += dt;
        if (p.t >= SPLASH_SEC) {
          this.splashes--;
          this.release(i);
        }
        else {
          const k = p.t / SPLASH_SEC;
          p.size = 1 + 2 * k;
          p.alpha = 0.6 * (1 - k);
        }
        continue;
      }
      p.y += p.vy * dt;
      if (p.kind === "snow") {
        p.t += dt;
        p.baseX += p.vx * dt;
        p.x = p.baseX + Math.sin(p.t * 1.7) * 4;
      } else p.x += p.vx * dt;
      if (p.y < p.gy) continue;
      // Landed.
      if (p.kind === "rain" && (!ground || ground(p.gx, p.gy))) this.splash(p.gx, p.gy);
      // Recycle while the sky still wants this many drops; otherwise (or with nowhere outdoors to land) retire it.
      if (!(spec && this.drops <= target && this.aim(p, spec, area, indoors, vx, false))) this.drop(i);
    }

    if (spec) {
      for (let budget = 2 * (target - this.drops); this.drops < target && budget > 0; budget--) {
        // Splashes never take more than MAX_PARTICLES − MAX_DROPS slots, so a drop slot is always free here.
        const i = this.free.pop() as number;
        if (this.aim(this.pool[i], spec, area, indoors, vx, true)) {
          this.pool[i].active = true;
          this.drops++;
        } else this.free.push(i);
      }
    }

    this.collect(indoors, rainSlant(amb.wind));
  }

  // ───────────────────────────── internals ─────────────────────────────

  private updateFlash(dt: number, storm: boolean): void {
    this.flashT = Math.max(0, this.flashT - dt);
    if (!storm) {
      this.nextFlash = null;
      return;
    }
    this.nextFlash ??= range(this.rng, FLASH_GAP[0], FLASH_GAP[1]);
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.flashT = FLASH_SEC;
      this.nextFlash = range(this.rng, FLASH_GAP[0], FLASH_GAP[1]);
    }
  }

  private targetDrops(spec: Spec, intensity: number, area: Area): number {
    const px = Math.max(0, area.w) * Math.max(0, area.h);
    const k = Math.max(0.15, Math.min(1, intensity));
    return Math.min(MAX_DROPS, Math.round((px / AREA_PER_DROP) * spec.density * k));
  }

  /** (Re)aim drop `p` at an outdoor spot in `area`; `midFall` starts it part-way down (fills the
   * sky at once). False when no outdoor spot was found. */
  private aim(p: P, spec: Spec, area: Area, indoors: Indoors, vx: number, midFall: boolean): boolean {
    let gx = 0;
    let gy = 0;
    let found = false;
    for (let n = 0; n < LANDING_TRIES && !found; n++) {
      gx = area.x + this.rng() * area.w;
      gy = area.y + this.rng() * area.h;
      found = !indoors(gx, gy);
    }
    if (!found) return false;
    const snow = spec.kind === "snow";
    const fall = range(this.rng, 40, 160) * (midFall ? this.rng() : 1);
    p.kind = spec.kind;
    p.gx = gx;
    p.gy = gy;
    p.size = range(this.rng, spec.size[0], spec.size[1]);
    p.alpha = range(this.rng, spec.alpha[0], spec.alpha[1]);
    const speed = range(this.rng, 0.9, 1.1);
    p.vy = (snow ? SNOW_SPEED : RAIN_SPEED) * speed;
    // Rain keeps a constant slant (vx ∝ vy) so `rainSlant` describes every streak.
    p.vx = snow ? vx * 0.25 : vx * speed;
    p.t = this.rng() * Math.PI * 2;
    const tFall = fall / p.vy;
    p.y = gy - fall;
    p.baseX = gx - p.vx * tFall;
    p.x = snow ? p.baseX + Math.sin(p.t * 1.7) * 4 : p.baseX;
    return true;
  }

  private splash(x: number, y: number): void {
    if (this.splashes >= MAX_PARTICLES - MAX_DROPS) return;
    this.splashes++;
    const p = this.pool[this.free.pop() as number];
    p.active = true;
    p.kind = "splash";
    p.x = x;
    p.y = y;
    p.t = 0;
    p.size = 1;
    p.alpha = 0.6;
  }

  /** Retire drop slot `i`. */
  private drop(i: number): void {
    this.drops--;
    this.release(i);
  }

  private release(i: number): void {
    this.pool[i].active = false;
    this.free.push(i);
  }

  private collect(indoors: Indoors, slant: number): void {
    const out = this.out;
    out.length = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.active || indoors(p.x, p.y)) continue;
      if (p.kind === "rain" && indoors(p.x - slant * p.size, p.y - p.size)) continue;
      out.push(p);
    }
  }
}
