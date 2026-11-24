import { describe, expect, it } from "vitest";
import type { Ambience, WeatherKind } from "../villageTypes";
import { mulberry32 } from "./rng";
import { FLASH_GAP, FLASH_SEC, MAX_DROPS, MAX_PARTICLES, RAIN_SPEED, RAIN_WIND, SNOW_SPEED, SPLASH_SEC, WeatherFx, rainSlant } from "./weatherFx";

function amb(weather: WeatherKind, intensity = 0.8, wind = 0): Ambience {
  return {
    phase: "afternoon",
    daylight: 0.8,
    tint: { color: "#000000", alpha: 0 },
    weather,
    intensity,
    wind,
    lightsOn: false,
    campfireLit: false,
    stayIndoors: false,
  };
}

const VIEW = { x: 0, y: 0, w: 480, h: 320 };
const outdoors = () => false;

function run(fx: WeatherFx, a: Ambience, frames: number, area = VIEW, indoors: (x: number, y: number) => boolean = outdoors, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) fx.update(dt, a, area, indoors);
}

const snapshot = (fx: WeatherFx) => fx.particles().map((p) => ({ ...p }));

describe("WeatherFx", () => {
  it("clear, cloudy and fog draw nothing; a fresh fx has no particles and no flash", () => {
    const fx = new WeatherFx();
    expect(fx.particles()).toEqual([]);
    expect(fx.flash()).toBe(0);
    for (const k of ["clear", "cloudy", "fog"] as const) {
      run(fx, amb(k), 30);
      expect(fx.particles()).toHaveLength(0);
      expect(fx.flash()).toBe(0);
    }
  });

  it("rain fills the visible area at once, falls at ~220 px/s with the wind's slant, and splashes on landing", () => {
    const fx = new WeatherFx(7);
    const a = amb("rain", 0.8, 0.5);
    fx.update(1 / 60, a, VIEW, outdoors);
    const drops = fx.particles().filter((p) => p.kind === "rain");
    expect(drops.length).toBe(Math.round(((480 * 320) / 1200) * 0.8));
    for (const p of drops) {
      expect(p.size).toBeGreaterThanOrEqual(6);
      expect(p.size).toBeLessThanOrEqual(10);
      expect(p.alpha).toBeGreaterThan(0);
    }
    const before = snapshot(fx);
    fx.update(0.05, a, VIEW, outdoors);
    const after = snapshot(fx);
    // follow particles that are the same object in the pool (same size, still rain)
    let moved = 0;
    for (const p of before) {
      const q = after.find((r) => r.kind === "rain" && r.size === p.size && r.alpha === p.alpha);
      if (!q) continue;
      const dy = q.y - p.y;
      expect(dy).toBeGreaterThan(RAIN_SPEED * 0.05 * 0.89);
      expect(dy).toBeLessThan(RAIN_SPEED * 0.05 * 1.11);
      expect((q.x - p.x) / dy).toBeCloseTo(rainSlant(0.5), 5);
      moved++;
    }
    expect(moved).toBeGreaterThan(50);
    expect(rainSlant(1)).toBeCloseTo(RAIN_WIND / RAIN_SPEED);
    expect(rainSlant(-1)).toBeCloseTo(-RAIN_WIND / RAIN_SPEED);

    run(fx, a, 30);
    const splashes = fx.particles().filter((p) => p.kind === "splash");
    expect(splashes.length).toBeGreaterThan(0);
    for (const s of splashes) {
      expect(s.size).toBeGreaterThanOrEqual(1);
      expect(s.size).toBeLessThanOrEqual(3);
      expect(s.alpha).toBeLessThanOrEqual(0.6);
    }
  });

  it("splashes are short-lived and stop with the rain; drops finish falling, then the sky is empty", () => {
    const fx = new WeatherFx(3);
    run(fx, amb("rain"), 60);
    run(fx, amb("clear"), 1);
    expect(fx.particles().length).toBeGreaterThan(0);
    run(fx, amb("clear"), Math.ceil((160 / (RAIN_SPEED * 0.9) + SPLASH_SEC) * 60) + 2);
    expect(fx.particles()).toHaveLength(0);
  });

  it("scales with intensity (with a floor) and with the visible area; lighter rain retires surplus drops", () => {
    const count = (k: WeatherKind, i: number, area = VIEW) => {
      const fx = new WeatherFx(1);
      fx.update(0, amb(k, i), area, outdoors);
      return fx.particles().length;
    };
    expect(count("rain", 1)).toBeGreaterThan(count("rain", 0.4));
    expect(count("rain", 0)).toBe(count("rain", 0.15));
    expect(count("rain", 0)).toBeGreaterThan(0);
    expect(count("drizzle", 1)).toBeLessThan(count("rain", 1));
    expect(count("storm", 1, { x: 0, y: 0, w: 240, h: 160 })).toBeGreaterThan(count("rain", 1, { x: 0, y: 0, w: 240, h: 160 }));
    expect(count("rain", 1, { x: 0, y: 0, w: 240, h: 160 })).toBeLessThan(count("rain", 1));
    expect(count("rain", 1, { x: 0, y: 0, w: -5, h: 100 })).toBe(0);
    expect(count("rain", 1, { x: 0, y: 0, w: 100, h: 0 })).toBe(0);

    const fx = new WeatherFx(2);
    run(fx, amb("rain", 1), 10);
    const heavy = fx.particles().filter((p) => p.kind === "rain").length;
    run(fx, amb("rain", 0.2), 120);
    const light = fx.particles().filter((p) => p.kind === "rain").length;
    expect(light).toBeLessThan(heavy / 2);
  });

  it("never exceeds the hard cap, even in a storm over a huge area for many frames", () => {
    const fx = new WeatherFx(11);
    const huge = { x: -5000, y: -5000, w: 10000, h: 10000 };
    let peakSplashes = 0;
    for (let i = 0; i < 600; i++) {
      fx.update(1 / 30, amb("storm", 1, 1), huge, outdoors);
      const ps = fx.particles();
      expect(ps.length).toBeLessThanOrEqual(MAX_PARTICLES);
      expect(ps.filter((p) => p.kind !== "splash").length).toBeLessThanOrEqual(MAX_DROPS);
      peakSplashes = Math.max(peakSplashes, ps.filter((p) => p.kind === "splash").length);
    }
    // the splash slots ran out (the pool was full) and nothing broke
    expect(peakSplashes).toBe(MAX_PARTICLES - MAX_DROPS);
  });

  it("refills drops after a lull while splashes hold their whole reserve (no crash, cap held)", () => {
    const fx = new WeatherFx(5);
    const huge = { x: 0, y: 0, w: 20000, h: 20000 };
    run(fx, amb("storm", 1), 120, huge, outdoors, 0.1);
    // heavy rain → lighter → heavy again: the refill loop meets a pool full of splashes
    run(fx, amb("storm", 0.2), 3, huge, outdoors, 0.1);
    run(fx, amb("storm", 1), 30, huge, outdoors, 0.1);
    expect(fx.particles().length).toBeLessThanOrEqual(MAX_PARTICLES);
  });

  it("snow drifts down slowly with a sway and leaves no splashes", () => {
    const fx = new WeatherFx(9);
    const a = amb("snow", 1, 1);
    run(fx, a, 1);
    const flakes = snapshot(fx);
    expect(flakes.length).toBeGreaterThan(0);
    for (const f of flakes) {
      expect(f.kind).toBe("snow");
      expect(f.size).toBeLessThanOrEqual(2.5);
    }
    run(fx, a, 6);
    const later = snapshot(fx);
    let checked = 0;
    for (const f of flakes) {
      const g = later.find((q) => q.size === f.size && q.alpha === f.alpha);
      if (!g) continue;
      const dy = g.y - f.y;
      expect(dy).toBeGreaterThan(SNOW_SPEED * 0.1 * 0.89);
      expect(dy).toBeLessThan(SNOW_SPEED * 0.1 * 1.11);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    run(fx, a, 600);
    expect(fx.particles().every((p) => p.kind === "snow")).toBe(true);
    // the sway: with no wind, flakes still drift both left and right
    const calm = new WeatherFx(10);
    run(calm, amb("snow", 1, 0), 30);
    const xs = snapshot(calm);
    calm.update(0.1, amb("snow", 1, 0), VIEW, outdoors);
    const dxs = calm.particles().flatMap((p) => {
      const prev = xs.find((q) => q.size === p.size && q.alpha === p.alpha);
      return prev ? [p.x - prev.x] : [];
    });
    expect(dxs.some((dx) => dx < 0)).toBe(true);
    expect(dxs.some((dx) => dx > 0)).toBe(true);
  });

  it("switching rain → snow recycles drops as flakes", () => {
    const fx = new WeatherFx(4);
    run(fx, amb("rain"), 30);
    run(fx, amb("snow"), 240);
    expect(fx.particles().length).toBeGreaterThan(0);
    expect(fx.particles().every((p) => p.kind === "snow")).toBe(true);
  });

  it("is deterministic by seed", () => {
    const go = (seed: number) => {
      const fx = new WeatherFx(seed);
      run(fx, amb("storm", 0.9, -0.4), 90);
      return { ps: snapshot(fx), flash: fx.flash() };
    };
    expect(go(42)).toEqual(go(42));
    expect(go(42)).not.toEqual(go(43));
    expect(new WeatherFx().particles()).toEqual(new WeatherFx(1).particles());
  });

  it("clamps dt: negative freezes, a huge dt moves at most 0.1 s", () => {
    const fx = new WeatherFx(6);
    run(fx, amb("rain"), 1);
    const a = snapshot(fx);
    fx.update(-1, amb("rain"), VIEW, outdoors);
    expect(snapshot(fx)).toEqual(a);
    fx.update(5, amb("rain"), VIEW, outdoors);
    const b = snapshot(fx).filter((p) => p.kind === "rain");
    for (const p of b) {
      const q = a.find((r) => r.size === p.size && r.alpha === p.alpha);
      if (q) expect(p.y - q.y).toBeLessThanOrEqual(RAIN_SPEED * 1.1 * 0.1 + 1e-9);
    }
  });

  it("no particle is ever indoors — property over many seeds, house layouts, kinds and winds", () => {
    const kinds: WeatherKind[] = ["drizzle", "rain", "storm", "snow"];
    for (let seed = 1; seed <= 40; seed++) {
      const r = mulberry32(seed * 977);
      const rooms = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({
        x: r() * 400 - 40,
        y: r() * 280 - 40,
        w: 30 + r() * 160,
        h: 30 + r() * 140,
      }));
      const indoors = (x: number, y: number) => rooms.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
      const fx = new WeatherFx(seed);
      const a = amb(kinds[seed % kinds.length], r(), r() * 2 - 1);
      const slant = rainSlant(a.wind);
      for (let f = 0; f < 120; f++) {
        fx.update(1 / 30, a, VIEW, indoors);
        for (const p of fx.particles()) {
          expect(indoors(p.x, p.y)).toBe(false);
          if (p.kind === "rain") expect(indoors(p.x - slant * p.size, p.y - p.size)).toBe(false);
        }
      }
    }
    // A property run near the 5 s default flakes under v8 coverage + parallel load;
    // the bound is generous on purpose — it is a correctness property, not a benchmark.
  }, 30_000);

  it("a view that is all indoors gets no rain at all", () => {
    const fx = new WeatherFx(8);
    run(fx, amb("storm", 1), 60, VIEW, () => true);
    expect(fx.particles()).toHaveLength(0);
  });

  it("drops whose landing area turns indoors (a house scrolled into view) retire instead of respawning indoors", () => {
    const fx = new WeatherFx(12);
    run(fx, amb("rain", 1), 30);
    expect(fx.particles().length).toBeGreaterThan(0);
    run(fx, amb("rain", 1), 120, VIEW, () => true);
    expect(fx.particles()).toHaveLength(0);
    run(fx, amb("rain", 1), 5);
    expect(fx.particles().length).toBeGreaterThan(0);
  });

  it("storm lightning: first strike 4–12 s in, flashes to 1 and decays over 0.25 s, strikes 4–12 s apart", () => {
    const fx = new WeatherFx(21);
    const dt = 0.01;
    const strikes: number[] = [];
    let prev = 0;
    for (let i = 1; i <= 6000; i++) {
      fx.update(dt, amb("storm", 1), VIEW, outdoors);
      const f = fx.flash();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      if (f === 1) strikes.push(i * dt);
      else if (prev > 0) expect(f).toBeLessThan(prev); // decaying
      prev = f;
    }
    expect(strikes.length).toBeGreaterThanOrEqual(5);
    expect(strikes[0]).toBeGreaterThanOrEqual(FLASH_GAP[0] - 1e-6);
    expect(strikes[0]).toBeLessThanOrEqual(FLASH_GAP[1] + 1e-6);
    for (let i = 1; i < strikes.length; i++) {
      const gap = strikes[i] - strikes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(FLASH_GAP[0] - 0.02);
      expect(gap).toBeLessThanOrEqual(FLASH_GAP[1] + 0.02);
    }
    // the decay: FLASH_SEC after a strike it is dark again
    const fx2 = new WeatherFx(21);
    let t = 0;
    while (fx2.flash() < 1) {
      fx2.update(dt, amb("storm", 1), VIEW, outdoors);
      t += dt;
    }
    expect(t).toBeLessThanOrEqual(FLASH_GAP[1] + dt);
    // (dt is clamped to 0.1 s, so step in quarters)
    fx2.update(FLASH_SEC / 4, amb("storm", 1), VIEW, outdoors);
    fx2.update(FLASH_SEC / 4, amb("storm", 1), VIEW, outdoors);
    expect(fx2.flash()).toBeCloseTo(0.5, 5);
    fx2.update(FLASH_SEC / 4, amb("storm", 1), VIEW, outdoors);
    fx2.update(FLASH_SEC / 4, amb("storm", 1), VIEW, outdoors);
    expect(fx2.flash()).toBeCloseTo(0, 5);
  });

  it("no lightning outside a storm; leaving a storm lets a flash fade and resets the timer", () => {
    const fx = new WeatherFx(21);
    run(fx, amb("rain", 1), 3000, VIEW, outdoors, 0.01);
    expect(fx.flash()).toBe(0);
    while (fx.flash() < 1) fx.update(0.01, amb("storm", 1), VIEW, outdoors);
    fx.update(0.1, amb("rain", 1), VIEW, outdoors);
    expect(fx.flash()).toBeCloseTo(0.6, 5);
    run(fx, amb("rain", 1), 3, VIEW, outdoors, 0.1);
    expect(fx.flash()).toBe(0);
    // back into the storm: a fresh 4–12 s wait, not an instant strike
    fx.update(0.01, amb("storm", 1), VIEW, outdoors);
    expect(fx.flash()).toBe(0);
  });

  it("returns the same array every frame (no per-frame allocation of the list)", () => {
    const fx = new WeatherFx(1);
    const list = fx.particles();
    run(fx, amb("rain"), 5);
    expect(fx.particles()).toBe(list);
  });
});

describe("WeatherFx — seen from the side (the city)", () => {
  it("splashes only where `ground` says there is ground; a drop ending in open sky just ends", () => {
    const splashes = (ground?: (x: number, y: number) => boolean) => {
      const fx = new WeatherFx(7);
      let n = 0;
      for (let i = 0; i < 240; i++) {
        fx.update(1 / 60, amb("rain"), VIEW, outdoors, ground);
        n += fx.particles().filter((p) => p.kind === "splash").length;
      }
      return { fx, n };
    };
    const everywhere = splashes();
    expect(everywhere.n).toBeGreaterThan(0);
    const street = splashes((_x, y) => y >= 280);
    expect(street.n).toBeGreaterThan(0);
    expect(street.n).toBeLessThan(everywhere.n);
    for (let i = 0; i < 60; i++) {
      street.fx.update(1 / 60, amb("rain"), VIEW, outdoors, (_x, y) => y >= 280);
      for (const p of street.fx.particles()) if (p.kind === "splash") expect(p.y).toBeGreaterThanOrEqual(280);
    }
    expect(splashes(() => false).n).toBe(0);
    // The drops themselves fall the same either way: only where they END changes.
    const sky = splashes(() => false);
    expect(sky.fx.particles().filter((p) => p.kind === "rain").length).toBeGreaterThan(0);
  });
});
