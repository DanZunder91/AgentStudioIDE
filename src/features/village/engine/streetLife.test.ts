import { describe, expect, it, vi } from "vitest";
import { recorder } from "../render/testRecorder";
import { VillageView } from "../villageView";
import { TILE, type Ambience, type DayPhase, type Prop, type WeatherKind, type World } from "../villageTypes";
import { buildCityWorld, type CityPlan } from "./city";
import { buildDrawList, characterZ, propZ, WAITER_HUES } from "./drawList";
import { WALK_FRAME_SEC, WALK_SPEED } from "./sim";
import { dressWorld } from "./streetTheme";
import { buildWorld } from "./world";
import { DWELL_MS, stationStop, SUBWAY_CYCLE_MS, trainAt } from "./subway";
import {
  BURST,
  BUTTONS,
  BUY_PER_MIN,
  CANOPIES,
  CLOSE_AHEAD,
  crowd,
  DECIDE_AHEAD,
  downChance,
  lastStop,
  FRAME_STRIDE,
  LANE_DEPTH,
  LOOK_HUES,
  machinesOf,
  MARGIN,
  MAX_BUY_SHARE,
  MAX_WALKERS,
  OPEN_SEC,
  PHASE_CROWD,
  REACT_SEC,
  RUSH,
  SINK,
  SIP_PERIOD,
  SIP_SEC,
  SPACING,
  STAIRS_RUN,
  STAIRS_SEC,
  StreetLife,
  STROLL,
  STROLL_SPREAD,
  SUBWAY_SHARE,
  TRAIN_EVERY,
  TRAIN_STOPS,
  umbrellaWeather,
  UMBRELLA_SHARE,
  VEND,
  VEND_GAP,
  WEATHER_CROWD,
  walkerZ,
  type WalkerItem,
} from "./streetLife";

// ───────────────────────────── fixtures ─────────────────────────────

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/** A reference city: gazelle (seven floors of 26 seats), a small Agent Studio, the HQ between them. */
const PLANS: CityPlan[] = [
  { key: "Agent Studio", label: "Agent Studio", team: 2, hasIde: true, floors: floorsOf("a", 1) },
  { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
];
/** In Tokyo: vending machines on the near sidewalk, the subway entrance on the far one. */
const tokyo = dressWorld(buildCityWorld(PLANS, { seats: 64 }), "Asia/Tokyo");
/** The same city anywhere else: no machine. */
const plain = buildCityWorld(PLANS, { seats: 64 });
/** A city with no capacity layout: no lounge, so no subway. */
const noSubway = buildCityWorld(PLANS);
const city = tokyo.city!;
const W = tokyo.cols * TILE;
const NEAR_Y = (city.street + 1) * TILE;
const FAR_Y = (city.street + 4) * TILE;
const STAIRS = (city.subway!.entrance.col + 1) * TILE;

function amb(phase: DayPhase, weather: WeatherKind, wind = 0): Ambience {
  return { phase, daylight: 1, tint: { color: "#000000", alpha: 0 }, weather, intensity: 0.7, wind, lightsOn: false, campfireLit: true, stayIndoors: false };
}
const NOON = amb("noon", "clear");
const RAIN = amb("noon", "rain");

/** A copy of every walker's item this frame (the live ones are the pool's, mutated in place). */
const snap = (s: StreetLife) =>
  s.walkers().map((w) => ({ ...w, vend: w.vend && { ...w.vend }, drink: w.drink && { ...w.drink } }));
type Snap = ReturnType<typeof snap>[number];

/** Each street's frame clock (ms): it runs on with the frames, as the view's does — the train's timetable reads it. */
const clocks = new WeakMap<StreetLife, number>();
/** One frame of `s`, its clock moved on by `dt`. */
function upd(s: StreetLife, dt: number, world: World, a: Ambience | null, x0: number, x1: number): void {
  const now = (clocks.get(s) ?? 0) + dt * 1000;
  clocks.set(s, now);
  s.update(dt, world, a, x0, x1, now);
}

/** Drive `s` for `sec` seconds of `dt` frames, calling `each` with a snapshot after every frame. */
function run(s: StreetLife, world: World, a: Ambience | null, sec: number, each?: (w: Snap[], t: number) => void, view: [number, number] = [0, W], dt = 0.1): void {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    upd(s, dt, world, a, view[0], view[1]);
    if (each) each(snap(s), (i + 1) * dt);
  }
}

/** Every walker's track by id: its snapshot each frame it was there, with the frame's time. */
function tracks(s: StreetLife, world: World, a: Ambience | null, sec: number, view?: [number, number], dt?: number): Map<number, { t: number; w: Snap }[]> {
  const out = new Map<number, { t: number; w: Snap }[]>();
  run(
    s,
    world,
    a,
    sec,
    (ws, t) => {
      for (const w of ws) {
        let tr = out.get(w.id);
        if (!tr) out.set(w.id, (tr = []));
        tr.push({ t, w });
      }
    },
    view,
    dt,
  );
  return out;
}

const sidewalkOf = (w: Pick<WalkerItem, "y">): "near" | "far" => (w.y > NEAR_Y ? "far" : "near");

// ───────────────────────────── tests ─────────────────────────────

describe("crowd and umbrella weather", () => {
  it("a fair day is the whole crowd; night, dawn, dusk and evening are fewer; rain fewer, snow and a storm fewer still", () => {
    expect(crowd(null)).toBe(1);
    expect(crowd(NOON)).toBe(1);
    for (const p of ["morning", "afternoon"] as const) expect(crowd(amb(p, "clear"))).toBe(1);
    expect(crowd(amb("night", "clear"))).toBeLessThan(crowd(amb("dawn", "clear")));
    expect(crowd(amb("night", "clear"))).toBeLessThanOrEqual(0.3);
    for (const p of ["dawn", "dusk", "evening"] as const) expect(crowd(amb(p, "clear"))).toBeLessThan(1);
    expect(crowd(amb("noon", "cloudy"))).toBe(1);
    expect(crowd(amb("noon", "rain"))).toBeLessThan(crowd(amb("noon", "drizzle")));
    expect(crowd(amb("noon", "drizzle"))).toBeLessThan(1);
    expect(crowd(amb("noon", "fog"))).toBeLessThan(1);
    expect(crowd(amb("noon", "snow"))).toBeLessThan(crowd(amb("noon", "rain")));
    expect(crowd(amb("noon", "storm"))).toBeLessThan(crowd(amb("noon", "rain")));
    // Clock and weather multiply: a stormy night is the emptiest street.
    expect(crowd(amb("night", "storm"))).toBeCloseTo(PHASE_CROWD.night * WEATHER_CROWD.storm);
  });

  it("umbrellas open in rain, drizzle, a storm and snow — never in clear, cloudy or fog weather, nor with no sky", () => {
    for (const k of ["rain", "drizzle", "storm", "snow"] as const) expect(umbrellaWeather(amb("noon", k)), k).toBe(true);
    for (const k of ["clear", "cloudy", "fog"] as const) expect(umbrellaWeather(amb("noon", k)), k).toBe(false);
    expect(umbrellaWeather(null)).toBe(false);
  });

  it("a passer-by wears one of the lounge waiters' few hues — no new sheet for the sprite bank", () => {
    expect([...LOOK_HUES]).toEqual([...WAITER_HUES]);
  });
});

describe("StreetLife: who walks where", () => {
  it("the first frame fills the whole street at once, on its two sidewalks only, each on its own line in its tile", () => {
    const s = new StreetLife(1);
    upd(s, 0, tokyo, NOON, 0, W);
    const ws = s.walkers();
    // ~ 2 sidewalks × (W + 2·MARGIN) / SPACING people.
    const expected = (2 * (W + 2 * MARGIN)) / SPACING;
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.length).toBeLessThan(expected * 3);
    for (const w of ws) {
      const ground = sidewalkOf(w) === "near" ? NEAR_Y : FAR_Y;
      expect(w.y).toBeLessThanOrEqual(ground);
      expect(w.y).toBeGreaterThanOrEqual(ground - LANE_DEPTH);
      expect(w.x).toBeGreaterThanOrEqual(-MARGIN);
      expect(w.x).toBeLessThanOrEqual(W + MARGIN);
      expect(w.sink).toBe(0);
      expect(w.anim).toBe("walk");
    }
  });

  it("over a long day both sidewalks, both directions, every line in the tile and every look are used", () => {
    const s = new StreetLife(2);
    const seen = { near: new Set<string>(), far: new Set<string>(), depth: new Set<number>(), palette: new Set<number>(), hue: new Set<number>(), canopy: new Set<number>() };
    run(s, tokyo, RAIN, 600, (ws) => {
      for (const w of ws) {
        seen[sidewalkOf(w)].add(w.dir);
        seen.depth.add((sidewalkOf(w) === "near" ? NEAR_Y : FAR_Y) - w.y);
        seen.palette.add(w.palette);
        seen.hue.add(w.hueShift);
        seen.canopy.add(w.canopy);
      }
    });
    expect([...seen.near].sort()).toEqual(["left", "right"]);
    expect([...seen.far].sort()).toEqual(["left", "right"]);
    expect([...seen.depth].sort()).toEqual(Array.from({ length: LANE_DEPTH + 1 }, (_, i) => i));
    expect(seen.palette.size).toBe(6);
    expect([...seen.hue].sort()).toEqual([...LOOK_HUES].sort());
    expect([...seen.canopy].sort()).toEqual(Array.from({ length: CANOPIES }, (_, i) => i));
  });

  it("people stroll at STROLL ± STROLL_SPREAD — each at its own steady pace — and the walk cycle steps with the distance, an agent's stride", () => {
    const s = new StreetLife(3);
    const paces = new Set<number>();
    const tr = tracks(s, plain, NOON, 60);
    for (const t of tr.values())
      for (let i = 1; i < t.length; i++) {
        const [a, b] = [t[i - 1].w, t[i].w];
        if (a.sink !== 0 || b.sink !== 0 || a.anim !== "walk" || b.anim !== "walk") continue;
        const v = Math.abs(b.x - a.x) / 0.1;
        expect(v).toBeGreaterThanOrEqual(STROLL * (1 - STROLL_SPREAD) - 1e-9);
        expect(v).toBeLessThanOrEqual(STROLL * (1 + STROLL_SPREAD) + 1e-9);
        expect(Math.sign(b.x - a.x)).toBe(b.dir === "right" ? 1 : -1);
        paces.add(Math.round(v * 1000));
      }
    // Small differences of pace: not one speed for everyone.
    expect(paces.size).toBeGreaterThan(5);
    expect(FRAME_STRIDE).toBeCloseTo(WALK_SPEED * WALK_FRAME_SEC);
    // The walk cycle steps once per FRAME_STRIDE px walked: over a stretch of d px it moves on
    // floor(d / FRAME_STRIDE) frames or one more (where the stride stood in its cycle).
    let checked = 0;
    for (const t of tr.values())
      for (let i = 10; i < t.length; i += 10) {
        const [a, b] = [t[i - 10].w, t[i].w];
        if (a.anim !== "walk" || b.anim !== "walk" || a.sink !== 0 || b.sink !== 0) continue;
        const steps = Math.floor(Math.abs(b.x - a.x) / FRAME_STRIDE);
        expect([steps % 4, (steps + 1) % 4]).toContain((b.frame - a.frame + 4) % 4);
        expect(steps).toBeGreaterThan(0);
        checked++;
      }
    expect(checked).toBeGreaterThan(50);
  });

  it("is deterministic: the same seed and frames give the same street; another seed another", () => {
    const [a, b, c] = [new StreetLife(9), new StreetLife(9), new StreetLife(10)];
    for (const s of [a, b, c]) run(s, tokyo, RAIN, 30);
    expect(snap(a)).toEqual(snap(b));
    expect(snap(a)).not.toEqual(snap(c));
  });

  it("inside the world it is camera-invariant: two views of different parts of the city see one street", () => {
    const [a, b] = [new StreetLife(4), new StreetLife(4)];
    run(a, tokyo, NOON, 40, undefined, [0, W]);
    run(b, tokyo, NOON, 40, undefined, [W / 2 - 100, W / 2 + 100]);
    expect(snap(a)).toEqual(snap(b));
  });

  it("allocates nothing on the steady path: the same array, the same item for the same person", () => {
    const s = new StreetLife(5);
    upd(s, 0.1, tokyo, NOON, 0, W);
    const list = s.walkers();
    // Someone in the middle of the street (not about to walk off it).
    const mid = list.find((w) => w.x > 100 && w.x < W - 100)!;
    const id = mid.id;
    upd(s, 0.1, tokyo, NOON, 0, W);
    expect(s.walkers()).toBe(list);
    expect(s.walkers().find((w) => w.id === id)).toBe(mid);
  });

  it("a long dt is clamped like the sim's: nobody jumps more than a tenth of a second", () => {
    const s = new StreetLife(6);
    upd(s, 0, plain, NOON, 0, W);
    const before = new Map(snap(s).map((w) => [w.id, w.x]));
    upd(s, 10, plain, NOON, 0, W);
    for (const w of s.walkers()) if (before.has(w.id)) expect(Math.abs(w.x - (before.get(w.id) as number))).toBeLessThanOrEqual(STROLL * (1 + STROLL_SPREAD) * 0.1 + 1e-9);
  });

  it("outside a city nothing walks: a village empties the street, and a city fills it again — with new people, all along it", () => {
    const s = new StreetLife(7);
    const wide: [number, number] = [-4000, W + 4000];
    upd(s, 0, buildWorld([]), NOON, ...wide);
    expect(s.walkers()).toHaveLength(0);
    run(s, tokyo, NOON, 5, undefined, wide);
    const before = new Set(s.walkers().map((w) => w.id));
    expect(before.size).toBeGreaterThan(10);
    upd(s, 0.1, buildWorld([]), NOON, ...wide);
    expect(s.walkers()).toHaveLength(0);
    upd(s, 0.1, tokyo, NOON, ...wide);
    const after = s.walkers();
    // ~ 2 × (W + 8000) / SPACING: the whole stretch is filled at once, as on a first frame.
    expect(after.length).toBeGreaterThan(10);
    for (const w of after) expect(before.has(w.id)).toBe(false);
  });
});

describe("StreetLife: nobody pops in or out where you look", () => {
  /** Where on screen a person can be seen at all: its sprite and umbrella are within 9 px of its x. */
  const SEEN = 9;

  for (const [label, view] of [
    ["a view inside the city", [W / 2 - 300, W / 2 + 300]],
    ["a view past both of the world's ends (zoomed out)", [-1500, W + 1500]],
  ] as const)
    it(`${label}: people arrive and leave off-screen — or up and down the subway stairs`, () => {
      const s = new StreetLife(11);
      const tr = tracks(s, tokyo, RAIN, 900, [view[0], view[1]]);
      let ups = 0;
      let downs = 0;
      let arrivals = 0;
      let departures = 0;
      for (const t of tr.values()) {
        const [first, last] = [t[0], t[t.length - 1]];
        if (first.t > 0.1) {
          arrivals++;
          const offScreen = first.w.x < view[0] - SEEN || first.w.x > view[1] + SEEN;
          if (!offScreen) {
            // Up the stairs, wholly under the sidewalk at first.
            expect(first.w.sink, `id ${first.w.id} at ${first.w.x}`).toBe(SINK);
            expect(Math.abs(first.w.x - STAIRS)).toBeLessThanOrEqual(STAIRS_RUN / 2);
            ups++;
          }
        }
        if (last.t < 900) {
          departures++;
          const offScreen = last.w.x < view[0] - SEEN || last.w.x > view[1] + SEEN;
          if (!offScreen) {
            // Down the stairs: (nearly) out of sight on its last frame.
            expect(last.w.sink, `id ${last.w.id} at ${last.w.x}`).toBeGreaterThan(SINK - 4);
            downs++;
          }
        }
      }
      expect(arrivals).toBeGreaterThan(20);
      expect(departures).toBeGreaterThan(20);
      if (view[0] < STAIRS && STAIRS < view[1]) {
        expect(ups).toBeGreaterThan(0);
        expect(downs).toBeGreaterThan(0);
      }
    });

  it("a pan past the world's end shows that stretch peopled at once — filled only where the street grew, at the same density", () => {
    const s = new StreetLife(12);
    run(s, plain, NOON, 5);
    const before = new Set(s.walkers().map((w) => w.id));
    // The view jumps 6000 px left of the world.
    upd(s, 0.1, plain, NOON, -6000, 0);
    const fresh = s.walkers().filter((w) => !before.has(w.id));
    expect(fresh.length).toBeGreaterThan(5);
    for (const w of fresh) {
      expect(w.x).toBeGreaterThanOrEqual(-6000 - MARGIN);
      expect(w.x).toBeLessThan(-MARGIN);
    }
    // ~ 2 × 6000 / SPACING of them: the fill keeps the street's density.
    expect(fresh.length).toBeGreaterThan((2 * 6000) / SPACING / 2);
    expect(fresh.length).toBeLessThan((2 * 6000 * 2) / SPACING);
    // Back inside the world: the far stretch is let go (it is off-screen), the city's people stay.
    const city = new Set(s.walkers().filter((w) => w.x > 0).map((w) => w.id));
    upd(s, 0.1, plain, NOON, 0, W);
    for (const w of s.walkers()) expect(w.x).toBeGreaterThanOrEqual(-MARGIN);
    for (const id of city) expect(s.walkers().some((w) => w.id === id)).toBe(true);
  });

  it("the right end grows too: a view past it is peopled there", () => {
    const s = new StreetLife(13);
    run(s, plain, NOON, 5);
    const before = new Set(s.walkers().map((w) => w.id));
    upd(s, 0.1, plain, NOON, W, W + 6000);
    const fresh = s.walkers().filter((w) => !before.has(w.id));
    expect(fresh.length).toBeGreaterThan(5);
    for (const w of fresh) expect(w.x).toBeGreaterThan(W + MARGIN);
  });

  it("never more than MAX_WALKERS, however far the view reaches", () => {
    const s = new StreetLife(14);
    upd(s, 0, plain, NOON, -1_000_000, 1_000_000);
    expect(s.walkers().length).toBe(MAX_WALKERS);
    run(s, plain, NOON, 2, undefined, [-1_000_000, 1_000_000]);
    expect(s.walkers().length).toBeLessThanOrEqual(MAX_WALKERS);
  });
});

describe("StreetLife: how many", () => {
  /** The mean number of people in the world over a long run. */
  function mean(a: Ambience, seed = 21, sec = 1800): number {
    const s = new StreetLife(seed);
    let sum = 0;
    let n = 0;
    run(s, plain, a, sec, (ws) => {
      sum += ws.filter((w) => w.x >= 0 && w.x <= W).length;
      n++;
    });
    return sum / n;
  }

  it("holds one person per SPACING px of each sidewalk by day — a handful — and the crowd's share of it at night and in bad weather", () => {
    const day = mean(NOON);
    const expected = (2 * W) / SPACING;
    expect(day).toBeGreaterThan(expected * 0.75);
    expect(day).toBeLessThan(expected * 1.25);
    const night = mean(amb("night", "clear"));
    expect(night).toBeGreaterThan(expected * PHASE_CROWD.night * 0.6);
    expect(night).toBeLessThan(expected * PHASE_CROWD.night * 1.4);
    const storm = mean(amb("noon", "storm"));
    const rain = mean(RAIN);
    expect(storm).toBeLessThan(rain);
    expect(rain).toBeLessThan(day);
  });

  it("when night falls the street thins as people walk off — no one vanishes at a stroke", () => {
    const s = new StreetLife(22);
    run(s, plain, NOON, 60);
    const ids = new Set(s.walkers().map((w) => w.id));
    upd(s, 0.1, plain, amb("night", "clear"), 0, W);
    // Everyone who was there, still there one frame into the night.
    for (const id of ids) expect(s.walkers().some((w) => w.id === id)).toBe(true);
  });
});

describe("StreetLife: umbrellas", () => {
  it("in clear, cloudy and fog weather nobody's is open", () => {
    for (const k of ["clear", "cloudy", "fog"] as const) {
      const s = new StreetLife(31);
      run(s, tokyo, amb("noon", k), 120, (ws) => {
        for (const w of ws) expect(w.umbrella).toBe(0);
      });
    }
  });

  it("in rain about UMBRELLA_SHARE carry one, open — the rest walk without", () => {
    const s = new StreetLife(32);
    const open = new Map<number, number>();
    run(s, noSubway, RAIN, 1500, (ws) => {
      for (const w of ws) open.set(w.id, Math.max(open.get(w.id) ?? 0, w.umbrella));
    });
    const share = [...open.values()].filter((u) => u === 1).length / open.size;
    expect(open.size).toBeGreaterThan(80);
    expect(share).toBeGreaterThan(UMBRELLA_SHARE - 0.15);
    expect(share).toBeLessThan(UMBRELLA_SHARE + 0.15);
    // Nobody half-open in steady rain (with no subway nobody has a reason to close theirs).
    for (const u of open.values()) expect([0, 1]).toContain(u);
  });

  it("people who arrive while it rains arrive with it open; snow and drizzle open them too", () => {
    for (const k of ["drizzle", "snow", "storm"] as const) {
      const s = new StreetLife(33);
      upd(s, 0, noSubway, amb("noon", k), -4000, W + 4000);
      const ws = s.walkers();
      expect(ws.some((w) => w.umbrella === 1), k).toBe(true);
      expect(ws.some((w) => w.umbrella === 0), k).toBe(true);
    }
  });

  it("when the rain starts each carrier opens its own a little later (not all in step), never flickering; when it stops they close", () => {
    const s = new StreetLife(34);
    // Zoomed out past both ends: a street long enough for a few dozen people.
    const view: [number, number] = [-3000, W + 3000];
    run(s, noSubway, NOON, 20, undefined, view);
    const there = new Set(s.walkers().map((w) => w.id));
    const opened = new Map<number, number>(); // id → time it first opened
    const last = new Map<number, number>();
    run(s, noSubway, RAIN, REACT_SEC[1] + OPEN_SEC + 0.5, (ws, t) => {
      for (const w of ws) {
        if (!there.has(w.id)) continue;
        // Never closes while it rains.
        expect(w.umbrella).toBeGreaterThanOrEqual(last.get(w.id) ?? 0);
        last.set(w.id, w.umbrella);
        if (w.umbrella > 0 && !opened.has(w.id)) opened.set(w.id, t);
      }
    }, view);
    const still = [...there].filter((id) => last.has(id));
    const carriers = still.filter((id) => (last.get(id) as number) > 0);
    expect(carriers.length).toBeGreaterThan(1);
    // All carriers are fully open by REACT_SEC[1] + OPEN_SEC; the others never opened.
    for (const id of carriers) expect(last.get(id)).toBe(1);
    expect(still.length - carriers.length).toBeGreaterThan(0);
    // Not in step: they opened at different moments, none before its first REACT_SEC[0].
    const times = carriers.map((id) => opened.get(id) as number);
    expect(new Set(times).size).toBeGreaterThan(1);
    for (const t of times) expect(t).toBeGreaterThanOrEqual(REACT_SEC[0]);
    // The rain stops: they close, the same way.
    const shut = new Map<number, number>();
    run(s, noSubway, NOON, REACT_SEC[1] + OPEN_SEC + 0.5, (ws) => {
      for (const w of ws) {
        if (!carriers.includes(w.id)) continue;
        expect(w.umbrella).toBeLessThanOrEqual(shut.get(w.id) ?? 1);
        shut.set(w.id, w.umbrella);
      }
    }, view);
    // Everyone still on the street has it shut (one who walked off mid-closing is not asked).
    const still2 = new Set(s.walkers().map((w) => w.id));
    const asked = [...shut].filter(([id]) => still2.has(id));
    expect(asked.length).toBeGreaterThan(1);
    for (const [, u] of asked) expect(u).toBe(0);
  });

  it("an umbrella takes OPEN_SEC to open — it passes through half-open", () => {
    const s = new StreetLife(35);
    run(s, noSubway, NOON, 10);
    const seen = new Set<number>();
    run(s, noSubway, RAIN, REACT_SEC[1] + OPEN_SEC + 0.2, (ws) => {
      for (const w of ws) seen.add(Math.round(w.umbrella * 100));
    }, [0, W], 0.05);
    expect([...seen].some((u) => u > 10 && u < 90)).toBe(true);
  });
});

describe("StreetLife: the subway", () => {
  it("about SUBWAY_SHARE of the far walkers heading for it go down — closing their umbrella first — and others come up, on its stairs", () => {
    const s = new StreetLife(41);
    const tr = tracks(s, tokyo, RAIN, 1800);
    let down = 0;
    let up = 0;
    let closers = 0;
    for (const t of tr.values()) {
      const sunk = t.filter((f) => f.w.sink > 0);
      if (sunk.length === 0) continue;
      // Only on the far sidewalk, at the entrance, and never with an umbrella open.
      for (const f of sunk) {
        expect(sidewalkOf(f.w)).toBe("far");
        expect(Math.abs(f.w.x - STAIRS)).toBeLessThanOrEqual(STAIRS_RUN / 2 + STROLL * 0.2);
        expect(f.w.umbrella).toBe(0);
      }
      const goingDown = sunk[sunk.length - 1].w.sink > sunk[0].w.sink;
      if (goingDown) {
        down++;
        // Its last frame on the street is (nearly) out of sight, and it is gone the frame after.
        expect(t[t.length - 1].w.sink).toBeGreaterThan(SINK - SINK * (0.1 / STAIRS_SEC) - 1e-9);
        // Closing as it came within CLOSE_AHEAD of the stairs: shut by the time it reached them.
        const before = t.filter((f) => f.w.sink === 0 && Math.abs(f.w.x - STAIRS) < STAIRS_RUN);
        for (const f of before) expect(f.w.umbrella).toBe(0);
        // …and not before: open (if it carried one) until it was CLOSE_AHEAD from them.
        const start = (w: Snap) => STAIRS - ((w.dir === "right" ? 1 : -1) * STAIRS_RUN) / 2;
        const ahead = (w: Snap) => (w.dir === "right" ? 1 : -1) * (start(w) - w.x);
        const lastOpen = t.filter((f) => f.w.umbrella === 1).pop();
        if (lastOpen) {
          closers++;
          expect(ahead(lastOpen.w)).toBeGreaterThanOrEqual(CLOSE_AHEAD - STROLL * (1 + STROLL_SPREAD) * 0.1);
          const next = t[t.indexOf(lastOpen) + 1];
          expect(ahead(next.w)).toBeLessThan(CLOSE_AHEAD);
        }
      } else {
        up++;
        expect(t[0].w.sink).toBe(SINK);
        // Then it walks on, up on the sidewalk.
        expect(t[t.length - 1].w.sink).toBe(0);
      }
      // The stairs take STAIRS_SEC.
      expect(sunk.length * 0.1).toBeLessThanOrEqual(STAIRS_SEC + 0.1 + 1e-9);
      expect(sunk.length * 0.1).toBeGreaterThanOrEqual(STAIRS_SEC - 0.2);
    }
    expect(closers).toBeGreaterThan(0);
    // Down: the far stream into the entrance × SUBWAY_SHARE (the timetable's weights average 1).
    const expected = ((2 * STROLL) / (2 * SPACING)) * SUBWAY_SHARE * crowd(RAIN) * 1800;
    expect(down).toBeGreaterThan(expected * 0.6);
    expect(down).toBeLessThan(expected * 1.4);
    expect(up).toBeGreaterThan(0);
  });

  it("whoever goes down has its umbrella shut before it sinks — even someone the first frame put just short of the stairs", () => {
    // Over many streets' first seconds: the first frame scatters people anywhere, a few right before the stairs.
    let sinkers = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const s = new StreetLife(seed);
      run(s, tokyo, RAIN, 1.5, (ws) => {
        for (const w of ws)
          if (w.sink > 0 && w.sink < SINK) {
            sinkers++;
            expect(w.umbrella, `seed ${seed}`).toBe(0);
          }
      });
    }
    expect(sinkers).toBeGreaterThan(0);
  });

  it("a carrier coming up opens its umbrella once it is on the sidewalk", () => {
    const s = new StreetLife(42);
    const tr = tracks(s, tokyo, RAIN, 1800);
    let opened = 0;
    for (const t of tr.values()) {
      if (t[0].w.sink !== SINK) continue;
      if (t.some((f) => f.w.umbrella === 1)) opened++;
    }
    expect(opened).toBeGreaterThan(0);
  });

  it("only ever down the stairs at the stairs — even when a rebuild takes the subway away and brings it back", () => {
    // While there is no subway the walkers bound for it walk on past where its stairs were; when it is
    // back they must not sink where they stand.
    const s = new StreetLife(44);
    let sunk = 0;
    // Six seconds with it, half a second without, for half an hour: many a walker on its way down is
    // still short of the stairs when they go, and past them when they are back.
    for (let k = 0; k < 560; k++)
      run(s, k % 2 === 0 ? tokyo : noSubway, RAIN, k % 2 === 0 ? 6 : 0.5, (ws) => {
        if (k % 2 !== 0) return;
        for (const w of ws)
          if (w.sink > 0) {
            sunk++;
            expect(Math.abs(w.x - STAIRS), `id ${w.id}`).toBeLessThanOrEqual(STAIRS_RUN / 2 + STROLL * 0.2);
          }
      });
    expect(sunk).toBeGreaterThan(0);
  });

  it("the near sidewalk's people never go down, nor anyone where there is no subway", () => {
    for (const world of [noSubway, tokyo]) {
      const s = new StreetLife(43);
      run(s, world, NOON, 600, (ws) => {
        for (const w of ws) if (world === noSubway || sidewalkOf(w) === "near") expect(w.sink).toBe(0);
      });
    }
  });
});

describe("StreetLife: the subway follows the train (engine/subway.ts)", () => {
  const sub = city.subway!;
  const HALF = SUBWAY_CYCLE_MS / 2;

  it("the train stops at the station at TRAIN_STOPS into each half cycle, by the subway's own timetable", () => {
    for (let k = 0; k < 6; k++) {
      const stop = k * HALF + TRAIN_STOPS;
      expect(trainAt(sub, tokyo.cols, stop)!.x).toBeCloseTo(stationStop(sub));
      expect(trainAt(sub, tokyo.cols, stop + DWELL_MS - 1)!.x).toBeCloseTo(stationStop(sub));
      expect(Math.abs(trainAt(sub, tokyo.cols, stop - 200)!.x - stationStop(sub))).toBeGreaterThan(0.01);
      expect(lastStop(stop)).toBe(stop);
      expect(lastStop(stop - 1)).toBe(stop - HALF);
      expect(lastStop(stop + HALF - 1)).toBe(stop);
    }
    expect(TRAIN_EVERY).toBe(HALF);
  });

  it("going down is likelier in the minute before a train, less right after one — the same on average", () => {
    const stop = 3 * HALF + TRAIN_STOPS;
    expect(downChance(stop - RUSH.ms)).toBeCloseTo(SUBWAY_SHARE * RUSH.hi);
    expect(downChance(stop - 1)).toBeCloseTo(SUBWAY_SHARE * RUSH.hi);
    expect(downChance(stop)).toBeCloseTo(SUBWAY_SHARE * RUSH.lo);
    expect(downChance(stop - RUSH.ms - 1)).toBeCloseTo(SUBWAY_SHARE * RUSH.lo);
    expect(RUSH.hi).toBeGreaterThan(1);
    expect(RUSH.lo).toBeLessThan(1);
    expect(SUBWAY_SHARE * RUSH.hi).toBeLessThanOrEqual(1);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < HALF; t += 10) {
      sum += downChance(t);
      n++;
    }
    expect(sum / n).toBeCloseTo(SUBWAY_SHARE, 2);
  });

  /** Everyone who came up the stairs in a run: the frame-clock ms it first showed (wholly under the sidewalk). */
  function risers(world: World, a: Ambience, sec: number, seed: number): number[] {
    const s = new StreetLife(seed);
    const out: number[] = [];
    const seen = new Set<number>();
    run(s, world, a, sec, (ws, t) => {
      for (const w of ws) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        if (w.sink === SINK) out.push(Math.round(t * 1000));
      }
    });
    return out;
  }

  it("a burst of 2–5 comes up a few seconds after each train stops — one after another — and nobody between trains", () => {
    const sec = 1800;
    const ups = risers(tokyo, NOON, sec, 81);
    const last = BURST.delay + (BURST.max - 1) * BURST.gap[1] + 100;
    const sizes: number[] = [];
    for (let stop = TRAIN_STOPS; stop + last < sec * 1000; stop += HALF) {
      const mine = ups.filter((t) => t >= stop + BURST.delay && t <= stop + last);
      expect(mine.length, `the train at ${stop} ms`).toBeGreaterThanOrEqual(BURST.min);
      expect(mine.length).toBeLessThanOrEqual(BURST.max);
      // The first a frame after `delay`; then one at a time, `gap` apart.
      expect(mine[0] - (stop + BURST.delay)).toBeLessThanOrEqual(100);
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i] - mine[i - 1]).toBeGreaterThanOrEqual(BURST.gap[0] - 100);
        expect(mine[i] - mine[i - 1]).toBeLessThanOrEqual(BURST.gap[1] + 100);
      }
      sizes.push(mine.length);
    }
    expect(sizes.length).toBeGreaterThan(15);
    // Seeded, not one size for every train.
    expect(new Set(sizes).size).toBeGreaterThan(1);
    // Nobody comes up between trains.
    for (const t of ups) {
      const since = t - lastStop(t);
      expect(since).toBeGreaterThanOrEqual(BURST.delay);
      expect(since).toBeLessThanOrEqual(last);
    }
  });

  it("on a stormy night a train brings fewer — but always someone — and none comes where there is no train", () => {
    const night = amb("night", "storm");
    const ups = risers(tokyo, night, 1800, 82);
    const last = BURST.delay + (BURST.max - 1) * BURST.gap[1] + 100;
    let trains = 0;
    for (let stop = TRAIN_STOPS; stop + last < 1800_000; stop += HALF) {
      trains++;
      expect(ups.filter((t) => t >= stop + BURST.delay && t <= stop + last).length, `the train at ${stop} ms`).toBeGreaterThanOrEqual(1);
    }
    expect(trains).toBeGreaterThan(15);
    expect(ups.length).toBeLessThan(trains * BURST.min);
    expect(risers(noSubway, NOON, 600, 83)).toEqual([]);
  });

  it("nobody comes up while the subway is gone (a pending burst comes when it is back) — and nothing is made up: no burst on a first frame, after a jump of the clock or with the clock run back", () => {
    const bare = { ...tokyo, city: { ...city, subway: undefined } };
    const frame = (s: StreetLife, w: World, ms: number) => {
      s.update(0.1, w, NOON, 0, W, ms);
      return s.walkers().filter((x) => x.sink === SINK).length;
    };
    // A train stops; its subway goes before its people come up: nobody — then it is back, and they come.
    const a = new StreetLife(84);
    frame(a, tokyo, TRAIN_STOPS - 1000);
    frame(a, tokyo, TRAIN_STOPS + 50);
    let ups = 0;
    for (let ms = TRAIN_STOPS + 100; ms < TRAIN_STOPS + BURST.delay + 1000; ms += 100) ups += frame(a, bare, ms);
    expect(ups).toBe(0);
    for (let ms = TRAIN_STOPS + BURST.delay + 1000; ms < TRAIN_STOPS + 15_000; ms += 100) ups += frame(a, tokyo, ms);
    expect(ups).toBeGreaterThanOrEqual(1);
    // The same with the subway kept: they come.
    const b = new StreetLife(84);
    frame(b, tokyo, TRAIN_STOPS - 1000);
    frame(b, tokyo, TRAIN_STOPS + 50);
    ups = 0;
    for (let ms = TRAIN_STOPS + 100; ms < TRAIN_STOPS + 15_000; ms += 100) ups += frame(b, tokyo, ms);
    expect(ups).toBeGreaterThanOrEqual(BURST.min);
    // A first frame just after a stop: no burst for that train.
    const c = new StreetLife(85);
    ups = 0;
    for (let ms = TRAIN_STOPS + 50; ms < TRAIN_STOPS + 15_000; ms += 100) ups += frame(c, tokyo, ms);
    expect(ups).toBe(0);
    // A paused tab: the clock jumps past the moment a burst begins — nobody pops up at once.
    const d = new StreetLife(86);
    frame(d, tokyo, TRAIN_STOPS - 1000);
    expect(frame(d, tokyo, TRAIN_STOPS + BURST.delay + 3000)).toBe(0);
    ups = 0;
    for (let ms = TRAIN_STOPS + BURST.delay + 3100; ms < TRAIN_STOPS + 20_000; ms += 100) ups += frame(d, tokyo, ms);
    expect(ups).toBe(0);
    // …but a jump that lands before the burst begins still lets it come.
    const e = new StreetLife(87);
    frame(e, tokyo, TRAIN_STOPS - 5000);
    frame(e, tokyo, TRAIN_STOPS + 2000);
    ups = 0;
    for (let ms = TRAIN_STOPS + 2100; ms < TRAIN_STOPS + 15_000; ms += 100) ups += frame(e, tokyo, ms);
    expect(ups).toBeGreaterThanOrEqual(BURST.min);
    // The clock run back to before a stop, then on past it: one burst, for the stop it then sees.
    const f = new StreetLife(88);
    frame(f, tokyo, TRAIN_STOPS + 1000);
    frame(f, tokyo, TRAIN_STOPS - 500);
    ups = 0;
    for (let ms = TRAIN_STOPS - 400; ms < TRAIN_STOPS + 15_000; ms += 100) ups += frame(f, tokyo, ms);
    expect(ups).toBeGreaterThanOrEqual(BURST.min);
    expect(ups).toBeLessThanOrEqual(BURST.max);
  });

  it("those who go down cluster in the minute before a train", () => {
    const s = new StreetLife(89);
    const tr = tracks(s, tokyo, NOON, 3600);
    let rush = 0;
    let all = 0;
    for (const t of tr.values()) {
      const i = t.findIndex((f) => f.w.sink > 0);
      if (i < 0 || t[i].w.sink > t[t.length - 1].w.sink) continue;
      // It started down the frame before its first sunk frame.
      const at = Math.round(t[i - 1].t * 1000);
      all++;
      if (lastStop(at) + TRAIN_EVERY - at <= RUSH.ms) rush++;
    }
    expect(all).toBeGreaterThan(50);
    // 60 of every 90 s are "the minute before"; weighted, ~87 % of the descents fall in it.
    expect(rush / all).toBeGreaterThan(0.75);
  });

  it("the totals hold: as many go down as come up, and the street holds the same crowd as with no subway at all", () => {
    const bare = { ...tokyo, city: { ...city, subway: undefined } };
    const tally = (world: World, seed: number) => {
      const s = new StreetLife(seed);
      let sum = 0;
      let n = 0;
      let up = 0;
      let down = 0;
      const sunk = new Map<number, number>();
      run(s, world, NOON, 3600, (ws) => {
        sum += ws.length;
        n++;
        const ids = new Set<number>();
        for (const w of ws) {
          ids.add(w.id);
          if (w.sink === SINK && !sunk.has(w.id)) up++;
          sunk.set(w.id, w.sink);
        }
        for (const [id, k] of sunk)
          if (!ids.has(id)) {
            if (k > SINK / 2) down++;
            sunk.delete(id);
          }
      });
      return { mean: sum / n, up, down };
    };
    const withSubway = tally(tokyo, 90);
    const without = tally(bare, 90);
    expect(withSubway.up).toBeGreaterThan(80);
    expect(withSubway.down / withSubway.up).toBeGreaterThan(0.75);
    expect(withSubway.down / withSubway.up).toBeLessThan(1.33);
    expect(withSubway.mean / without.mean).toBeGreaterThan(0.85);
    expect(withSubway.mean / without.mean).toBeLessThan(1.15);
    expect(without.up + without.down).toBe(0);
  });
});

describe("StreetLife: the vending machines", () => {
  const machines = machinesOf(tokyo);
  const props = tokyo.props.filter((p) => p.kind === "vending");

  it("machinesOf lists the vending props left to right, with a stop each side — none in front of another machine", () => {
    expect(machines.map((m) => m.id)).toEqual(props.slice().sort((a, b) => a.col - b.col).map((p) => p.id));
    for (const m of machines) {
      expect(m.bottom).toBe(NEAR_Y);
      for (const stop of [m.right, m.left]) {
        if (Number.isNaN(stop)) continue;
        for (const o of machines) expect(stop <= o.x0 - VEND_GAP || stop >= o.x0 + TILE + VEND_GAP, `${m.id} stop ${stop} by ${o.id}`).toBe(true);
      }
      if (!Number.isNaN(m.right)) expect(m.right).toBe(m.x0 - VEND_GAP);
      if (!Number.isNaN(m.left)) expect(m.left).toBe(m.x0 + TILE + VEND_GAP);
    }
    // The reference street has a pair side by side: the stops between them are not stops.
    const pair = machines.findIndex((m, i) => i + 1 < machines.length && machines[i + 1].x0 === m.x0 + TILE);
    expect(pair).toBeGreaterThanOrEqual(0);
    expect(machines[pair].left).toBeNaN();
    expect(machines[pair + 1].right).toBeNaN();
    expect(machines[pair].right).not.toBeNaN();
    expect(machines[pair + 1].left).not.toBeNaN();
  });

  /** Every purchase in a long run: the buyer's frames while at a machine and after. */
  function purchases(world: World, a: Ambience, sec: number, seed = 51) {
    const s = new StreetLife(seed);
    const tr = tracks(s, world, a, sec);
    const out: { frames: { t: number; w: Snap }[]; at: number }[] = [];
    for (const t of tr.values()) {
      const i = t.findIndex((f) => f.w.vend);
      if (i >= 0) out.push({ frames: t, at: i });
    }
    return out;
  }

  it("a buyer stops beside the machine on the side it came from, facing it; pays, a button flashes, the can drops, it takes it — in that order — then walks on with it", () => {
    expect(VEND.flash).toBeGreaterThan(0);
    expect(VEND.drop).toBeGreaterThan(VEND.flash);
    expect(VEND.take).toBeGreaterThan(VEND.drop);
    expect(VEND.took).toBeGreaterThan(VEND.take);
    expect(VEND.leave).toBeGreaterThan(VEND.took);
    const all = purchases(tokyo, NOON, 1800);
    expect(all.length).toBeGreaterThan(5);
    let walkedOn = 0;
    for (const { frames, at } of all) {
      const buying = frames.filter((f) => f.w.vend);
      const v0 = buying[0].w.vend!;
      const m = machines.find((x) => x.id === v0.machine)!;
      const w0 = buying[0].w;
      expect(sidewalkOf(w0)).toBe("near");
      // Beside it, facing it: heading right it stands at the machine's left, heading left at its right.
      const centre = m.x0 + TILE / 2;
      expect(w0.x).toBe(w0.dir === "right" ? m.x0 - VEND_GAP : m.x0 + TILE + VEND_GAP);
      expect(Math.sign(centre - w0.x)).toBe(w0.dir === "right" ? 1 : -1);
      expect(v0.x0).toBe(m.x0);
      expect(v0.bottom).toBe(m.bottom);
      expect(v0.button).toBeGreaterThanOrEqual(0);
      expect(v0.button).toBeLessThan(BUTTONS);
      // It came walking towards the machine (the frame before, it was further off on its approach side).
      expect(Math.sign(centre - frames[at - 1].w.x)).toBe(Math.sign(centre - w0.x));
      // Standing still, idle, the whole purchase; its clock runs from 0 to `leave`; the drink from `took` on.
      for (const f of buying) {
        expect(f.w.x).toBe(w0.x);
        expect(f.w.dir).toBe(w0.dir);
        expect(f.w.anim).toBe("idle");
        expect(f.w.vend!.machine).toBe(m.id);
        expect(f.w.vend!.button).toBe(v0.button);
        expect(!!f.w.drink).toBe(f.w.vend!.t >= VEND.took);
        if (f.w.drink) expect(f.w.drink).toMatchObject({ machine: m.id, button: v0.button, sip: false });
      }
      expect(v0.t).toBeLessThan(0.1 + 1e-9);
      for (let i = 1; i < buying.length; i++) expect(buying[i].w.vend!.t).toBeGreaterThan(buying[i - 1].w.vend!.t);
      const lastT = buying[buying.length - 1].w.vend!.t;
      const after = frames.slice(at + buying.length);
      if (after.length === 0) continue;
      expect(lastT).toBeLessThan(VEND.leave);
      expect(lastT).toBeGreaterThanOrEqual(VEND.leave - 0.1 - 1e-9);
      walkedOn++;
      // Then it walks on, the same way, with the can, and never buys again.
      for (const f of after) {
        expect(f.w.vend).toBeNull();
        expect(f.w.drink).toMatchObject({ machine: m.id, button: v0.button });
        expect(f.w.anim).toBe("walk");
        expect(f.w.dir).toBe(w0.dir);
      }
      if (after.length > 5) expect(Math.abs(after[5].w.x - w0.x)).toBeGreaterThan(5);
    }
    expect(walkedOn).toBeGreaterThan(3);
    // Different drinks: more than one button gets pressed.
    expect(new Set(all.map(({ frames, at }) => frames[at].w.vend!.button)).size).toBeGreaterThan(2);
  });

  it("about BUY_PER_MIN purchases a minute on the street by day, rarer at night; one buyer per machine at a time", () => {
    const day = purchases(tokyo, NOON, 3600, 52);
    const night = purchases(tokyo, amb("night", "clear"), 3600, 52);
    expect(day.length / 60).toBeGreaterThan(BUY_PER_MIN * 0.5);
    expect(day.length / 60).toBeLessThan(BUY_PER_MIN * 1.5);
    expect(night.length).toBeLessThan(day.length / 2);
    // Never two at one machine: per frame time, the machines in use are distinct.
    const busy = new Map<string, number>();
    for (const { frames } of day)
      for (const f of frames)
        if (f.w.vend) {
          const key = `${f.t.toFixed(1)}:${f.w.vend.machine}`;
          busy.set(key, (busy.get(key) ?? 0) + 1);
        }
    for (const n of busy.values()) expect(n).toBe(1);
  });

  it("they may hold an umbrella while buying — open the whole time, in steady rain", () => {
    const rainy = purchases(tokyo, RAIN, 3600, 53);
    let held = 0;
    for (const { frames } of rainy) {
      const buying = frames.filter((f) => f.w.vend);
      if (buying[0].w.umbrella !== 1) continue;
      held++;
      for (const f of buying) expect(f.w.umbrella).toBe(1);
    }
    expect(held).toBeGreaterThan(0);
  });

  it("one buyer per machine at a time, even at a lone machine all afternoon", () => {
    const lone = withVending(plain, [20]);
    const s = new StreetLife(58);
    let purchases = 0;
    let prev = new Set<number>();
    run(s, lone, NOON, 7200, (ws) => {
      const at = ws.filter((w) => w.vend);
      expect(at.length).toBeLessThanOrEqual(1);
      for (const w of at) if (!prev.has(w.id)) purchases++;
      prev = new Set(at.map((w) => w.id));
    });
    expect(purchases).toBeGreaterThan(60);
  });

  it("a drinker sips now and then while walking — for SIP_SEC, every SIP_PERIOD — never while still at the machine", () => {
    const all = purchases(tokyo, NOON, 3600, 54);
    let sips = 0;
    for (const { frames } of all) {
      const walking = frames.filter((f) => f.w.drink && !f.w.vend);
      let streak = 0;
      for (const f of walking) {
        if (f.w.drink!.sip) streak++;
        else {
          if (streak > 0) {
            sips++;
            expect(streak * 0.1).toBeLessThanOrEqual(SIP_SEC + 0.1 + 1e-9);
            expect(streak * 0.1).toBeGreaterThanOrEqual(SIP_SEC - 0.1 - 1e-9);
          }
          streak = 0;
        }
      }
      // The first sip comes no sooner than SIP_PERIOD[0] − SIP_SEC after taking the can.
      const firstSip = walking.findIndex((f) => f.w.drink!.sip);
      if (firstSip >= 0) {
        const took = frames.find((f) => f.w.drink)!.t;
        expect(walking[firstSip].t - took).toBeGreaterThanOrEqual(SIP_PERIOD[0] - SIP_SEC - 0.5);
      }
    }
    expect(sips).toBeGreaterThan(3);
  });

  it("no machine, no purchase: a street anywhere but Tokyo, and the far sidewalk", () => {
    expect(machinesOf(plain)).toEqual([]);
    const s = new StreetLife(55);
    run(s, plain, NOON, 600, (ws) => {
      for (const w of ws) {
        expect(w.vend).toBeNull();
        expect(w.drink).toBeNull();
      }
    });
    const t = new StreetLife(56);
    run(t, tokyo, NOON, 600, (ws) => {
      for (const w of ws) if (sidewalkOf(w) === "far") expect(w.vend).toBeNull();
    });
  });

  it("the chance per machine passed is sized to BUY_PER_MIN over the usable stops, and capped at MAX_BUY_SHARE for a lone machine", () => {
    // One machine with both stops: the uncapped chance would be 1/60 · 2·SPACING / (STROLL · 2) > MAX_BUY_SHARE? It is not —
    // so a lone machine sees ~BUY_PER_MIN purchases a minute too.
    const lone = withVending(plain, [20]);
    expect(machinesOf(lone)).toHaveLength(1);
    const s = new StreetLife(57);
    let n = 0;
    let prev = new Set<number>();
    run(s, lone, NOON, 1800, (ws) => {
      const now = new Set(ws.filter((w) => w.vend).map((w) => w.id));
      for (const id of now) if (!prev.has(id)) n++;
      prev = now;
    });
    const uncapped = ((BUY_PER_MIN / 60) * 2 * SPACING) / (STROLL * 2);
    expect(uncapped).toBeLessThan(MAX_BUY_SHARE);
    expect(n / 30).toBeGreaterThan(BUY_PER_MIN * 0.5);
    expect(n / 30).toBeLessThan(BUY_PER_MIN * 1.6);
    expect(DECIDE_AHEAD).toBeGreaterThan(STROLL * (1 + STROLL_SPREAD) * 0.1);
  });
});

/** `world` with vending machines at near-sidewalk columns `cols` (and none other). */
function withVending(world: World, cols: number[]): World {
  const street = world.city!.street;
  const props: Prop[] = [...world.props.filter((p) => p.kind !== "vending"), ...cols.map((c) => ({ id: `tokyo:vending:${c},${street}`, kind: "vending" as const, col: c, row: street, w: 1, h: 1 }))];
  return { ...world, props };
}

describe("StreetLife: depth", () => {
  it("in front of what stands on its sidewalk tile, behind an agent at the same spot, the nearer of two passers-by in front", () => {
    const lamp = tokyo.props.find((p) => p.kind === "lamp" && p.row === city.street)!;
    const item = (y: number) => ({ y }) as WalkerItem;
    for (let d = 0; d <= LANE_DEPTH; d++) {
      expect(walkerZ(item(NEAR_Y - d))).toBeGreaterThan(propZ(lamp));
      expect(walkerZ(item(NEAR_Y - d))).toBeLessThanOrEqual(characterZ({ y: NEAR_Y, seated: false } as never));
      // …and behind anything on the road below (a vehicle's z is its lane's bottom, a tile lower).
      expect(walkerZ(item(NEAR_Y - d))).toBeLessThan(NEAR_Y + TILE);
    }
    expect(walkerZ(item(NEAR_Y))).toBeGreaterThan(walkerZ(item(NEAR_Y - 3)));
    const kiosk = tokyo.props.find((p) => p.kind === "lift")!;
    expect(walkerZ(item(FAR_Y - LANE_DEPTH))).toBeGreaterThan(propZ(kiosk));
  });
});

describe("StreetLife: a rebuilt world", () => {
  /** The reference city with one more project — it widens round the HQ, which moves in world px. */
  const wider = dressWorld(
    buildCityWorld([...PLANS, { key: "zeta", label: "zeta", team: 26, hasIde: true, floors: floorsOf("z", 2) }], { seats: 64 }),
    "Asia/Tokyo",
  );
  const lift = (w: World) => (w.city!.lounge!.lift.col + 0.5) * TILE;

  it("everyone keeps its place relative to the HQ's door (and so to the subway's stairs); nobody is lost", () => {
    expect(lift(wider)).not.toBe(lift(tokyo));
    const s = new StreetLife(61);
    run(s, tokyo, NOON, 30);
    const before = snap(s);
    upd(s, 0, wider, NOON, 0, wider.cols * TILE);
    const after = new Map(snap(s).map((w) => [w.id, w]));
    for (const w of before) {
      const n = after.get(w.id)!;
      expect(n, `id ${w.id}`).toBeDefined();
      expect(n.x - lift(wider)).toBeCloseTo(w.x - lift(tokyo));
      // Its sidewalk line moved with the street.
      const [ob, nb] = sidewalkOf(w) === "near" ? [NEAR_Y, (wider.city!.street + 1) * TILE] : [FAR_Y, (wider.city!.street + 4) * TILE];
      expect(nb - n.y).toBe(ob - w.y);
    }
    // The wider world's new ends are peopled too.
    expect(after.size).toBeGreaterThan(before.length);
  });

  /** A street (seed `seed`) run to a moment when someone heading `dir` is at a machine, before it has its can. */
  function buyerFacing(dir: "left" | "right", seed: number): { s: StreetLife; found: Snap } {
    const s = new StreetLife(seed);
    for (let i = 0; i < 40000; i++) {
      upd(s, 0.1, tokyo, NOON, 0, W);
      const found = snap(s).find((w) => w.vend && w.dir === dir && w.vend.t < VEND.took - 0.5);
      if (found) return { s, found };
    }
    throw new Error(`no buyer heading ${dir}`);
  }

  for (const dir of ["right", "left"] as const)
    it(`a buyer heading ${dir} keeps its machine when one stands where it stood (moved with the HQ) — and walks on, without a can, when none does`, () => {
      const { s, found } = buyerFacing(dir, 62);
      const id = found.id;
      // The same world, moved by a whole tile (its HQ door one column right): the machine is still beside the buyer.
      const shifted = shiftWorld(tokyo, 1);
      upd(s, 0.1, shifted, NOON, 0, W + TILE);
      const kept = s.walkers().find((w) => w.id === id)!;
      expect(kept.vend).not.toBeNull();
      expect(kept.vend!.x0).toBe(found.vend!.x0 + TILE);
      expect(kept.x).toBe(found.x + TILE);
      // Now its machine is gone: it walks on with no can.
      const bare = { ...shifted, props: shifted.props.filter((p) => p.kind !== "vending") };
      upd(s, 0.1, bare, NOON, 0, W + TILE);
      const gone = s.walkers().find((w) => w.id === id)!;
      expect(gone.vend).toBeNull();
      expect(gone.drink).toBeNull();
      expect(gone.anim).toBe("walk");
      const x = gone.x;
      upd(s, 0.1, bare, NOON, 0, W + TILE);
      expect(s.walkers().find((w) => w.id === id)!.x).not.toBe(x);
    });

  it("a buyer whose spot a rebuild puts in front of another machine walks on", () => {
    const { s, found } = buyerFacing("right", 64);
    const col = found.vend!.x0 / TILE;
    // A machine appears right where the buyer stands (the column left of its machine): its stop is no stop now.
    const crowded = withVending(tokyo, [...tokyo.props.filter((p) => p.kind === "vending").map((p) => p.col), col - 1]);
    expect(machinesOf(crowded).find((m) => m.x0 === col * TILE)!.right).toBeNaN();
    upd(s, 0.1, crowded, NOON, 0, W);
    const w = s.walkers().find((x) => x.id === found.id)!;
    expect(w.vend).toBeNull();
    expect(w.anim).toBe("walk");
  });

  it("a walker heading to a machine that a rebuild takes away just walks past", () => {
    // The frame the first purchase of this seed starts…
    const s = new StreetLife(63);
    let frames = 0;
    let buyer = -1;
    while (buyer < 0) {
      upd(s, 0.1, tokyo, NOON, 0, W);
      frames++;
      buyer = s.walkers().find((w) => w.vend)?.id ?? -1;
    }
    // …replayed to two frames before it (the buyer has decided by then: DECIDE_AHEAD is several frames' walk), then the machines go.
    expect(DECIDE_AHEAD).toBeGreaterThan(3 * STROLL * (1 + STROLL_SPREAD) * 0.1);
    const t = new StreetLife(63);
    for (let i = 0; i < frames - 2; i++) upd(t, 0.1, tokyo, NOON, 0, W);
    const bare = { ...tokyo, props: tokyo.props.filter((p) => p.kind !== "vending") };
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) {
      upd(t, 0.1, bare, NOON, 0, W);
      const w = t.walkers().find((x) => x.id === buyer)!;
      expect(w.vend).toBeNull();
      expect(w.anim).toBe("walk");
      xs.push(w.x);
    }
    expect(new Set(xs).size).toBe(20);
  });
});

/** `world` moved right by `cols` columns: the same street, as a rebuild that widened it on the left would. */
function shiftWorld(world: World, cols: number): World {
  const c = world.city!;
  const tiles = new Array(world.tiles.length + cols * world.rows);
  const nc = world.cols + cols;
  for (let r = 0; r < world.rows; r++) for (let x = 0; x < nc; x++) tiles[r * nc + x] = x < cols ? world.tiles[r * world.cols] : world.tiles[r * world.cols + x - cols];
  const lounge = c.lounge!;
  return {
    ...world,
    cols: nc,
    tiles,
    props: world.props.map((p) => ({ ...p, id: p.kind === "vending" ? `tokyo:vending:${p.col + cols},${p.row}` : p.id, col: p.col + cols })),
    city: {
      ...c,
      buildings: c.buildings.map((b) => ({ ...b, col: b.col + cols, doorCol: b.doorCol + cols })),
      lounge: { ...lounge, lift: { ...lounge.lift, col: lounge.lift.col + cols } },
      subway: { ...c.subway!, entrance: { ...c.subway!.entrance, col: c.subway!.entrance.col + cols } },
    },
  };
}


describe("StreetLife: wired into the draw list and the view", () => {
  it("buildDrawList puts each passer-by in the scene once — after its sidewalk's lamp, before an agent standing at the same spot — and never labels or bubbles one", () => {
    const s = new StreetLife(71);
    run(s, tokyo, NOON, 30);
    const walkers = s.walkers();
    expect(walkers.length).toBeGreaterThan(2);
    const agent = { key: "a", x: 0, y: NEAR_Y, dir: "down", anim: "idle", frame: 0, palette: 0, hueShift: 0, seated: false, origin: "ide", isSubagent: false, activity: "idle", label: "a", tool: null, bubble: "waiting", bubbleAlpha: 1, fx: null } as const;
    const items = buildDrawList(tokyo, [{ ...agent }], () => false, 1, "a", null, [], [], walkers);
    const bare = buildDrawList(tokyo, [{ ...agent }], () => false, 1, "a", null, [], []);
    for (const w of walkers) expect(items.filter((i) => i === w)).toHaveLength(1);
    expect(bare.some((i) => i.t === "walker")).toBe(false);
    // Only their own items are added: no label, no bubble for them.
    expect(items.length - bare.length).toBe(walkers.length);
    // Depth: after the last lamp of the near sidewalk, before the agent standing on it.
    const near = walkers.filter((w) => w.y <= NEAR_Y);
    const lamp = items.findIndex((i) => i.t === "prop" && i.prop.kind === "lamp" && i.prop.row === city.street && i === items.filter((j) => j.t === "prop" && j.prop.kind === "lamp" && j.prop.row === city.street).pop());
    const standing = items.findIndex((i) => i.t === "character");
    for (const w of near) {
      expect(items.indexOf(w)).toBeGreaterThan(lamp);
      expect(items.indexOf(w)).toBeLessThan(standing);
    }
  });

  it("the City view walks them every frame and paints them — but never picks one: they are not agents", () => {
    const b = { fallback: false, character: vi.fn(() => ({}) as never), floor: () => null, wall: () => null, furniture: () => null };
    const v = new VillageView(1, () => null, "city");
    v.setWorld(tokyo);
    v.setBank(b);
    v.setAmbience(NOON);
    v.resize(1280, 800, 1);
    for (let t = 0; t <= 5000; t += 100) v.frame(t, null);
    const ctx = recorder();
    v.frame(5100, ctx);
    // No agent is in the city, so every character sheet drawn is a passer-by's.
    const sprites = ctx.of("drawImage").length;
    expect(sprites).toBeGreaterThan(2);
    expect(b.character).toHaveBeenCalled();
    // Clicking where one stands picks nothing.
    const street = (v as unknown as { street: StreetLife }).street;
    const cam = v.camera;
    for (const w of street.walkers()) expect(v.pick(cam.ox + w.x * cam.zoom, cam.oy + (w.y - 10) * cam.zoom)).toBeNull();
    // They moved between frames: the view advances them.
    const xs = street.walkers().map((w) => [w.id, w.x] as const);
    v.frame(5200, null);
    const moved = xs.filter(([id, x]) => street.walkers().some((w) => w.id === id && w.x !== x));
    expect(moved.length).toBeGreaterThan(0);
  });

  it("the City view runs the stairs on its frame clock: a train's people come up a few seconds after it stops", () => {
    const v = new VillageView(1, () => null, "city");
    v.setWorld(tokyo);
    v.setAmbience(NOON);
    v.resize(1280, 800, 1);
    const street = (v as unknown as { street: StreetLife }).street;
    const risen = new Set<number>();
    for (let t = TRAIN_STOPS - 2000; t <= TRAIN_STOPS + BURST.delay + BURST.max * BURST.gap[1]; t += 100) {
      v.frame(t, null);
      for (const w of street.walkers()) if (w.sink === SINK) risen.add(w.id);
      if (t < TRAIN_STOPS + BURST.delay) expect(risen.size).toBe(0);
    }
    expect(risen.size).toBeGreaterThanOrEqual(BURST.min);
  });

  it("the village view has none", () => {
    const v = new VillageView();
    v.resize(800, 600, 1);
    v.setAmbience(NOON);
    for (let t = 0; t <= 1000; t += 100) v.frame(t, null);
    expect((v as unknown as { street: StreetLife }).street.walkers()).toHaveLength(0);
  });
});
