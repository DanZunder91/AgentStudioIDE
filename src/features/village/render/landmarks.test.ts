import { describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import type { CityPlan } from "../engine/city";
import { TILE, type Ambience, type DayPhase, type WeatherKind, type World } from "../villageTypes";
import { VillageView } from "../villageView";
import type { Camera } from "./camera";
import {
  AVIATION,
  BLINK_MS,
  FUJI,
  SKYTREE,
  SKYTREE_LIT,
  TEMPLE,
  TEMPLE_LIT,
  TOKYO_TOWER,
  TOKYO_TOWER_LIT,
  aviationOn,
  landmarkCrown,
  landmarkMask,
  landmarkRow,
  landmarksFor,
  paintFarLandmarks,
  paintLandmarkLights,
  paintLandmarks,
  paintNearLandmarks,
  placeLandmarks,
  referenceHeight,
  templeArt,
  towerReference,
  type LandmarkKind,
  type LandmarkSpec,
  type PlacedLandmark,
  type TowerPalette,
  type WorldBox,
} from "./landmarks";
import { SKYLINE_BASE, skylineMax } from "./skyline";
import { recorder, type DrawCall, type RecordingTarget } from "./testRecorder";

// ───────────────────────────── fixtures ─────────────────────────────

const plan = (i: number, floors: number, team = 2): CityPlan => ({
  key: `p${i}`,
  label: `p${i}`,
  team,
  hasIde: true,
  floors: Array.from({ length: floors }, (_, f) => ({ key: `floor:${i}:${f}`, label: `a${i}.${f}`, ide: true })),
});

/** Projects of `floors` floors each, alternating right and left of the mid-street HQ (2 floors)
 * unless `hq` is false. */
const city = (floors: number[], hq = true): World => buildCityWorld(floors.map((f, i) => plan(i, f)), hq ? { seats: 6 } : undefined);

/** HQ, one floor right, two left: the shortest sky a city has (240 px). */
const typical = city([1, 2]);
/** The HQ alone: the same 240-px sky, open street either side of the HQ — every landmark at its full size. */
const alone = city([]);
/** HQ mid-street, `gazelle` left (7 floors of up to 25 sub-agents: 912 px tall, 608 wide), one
 * floor right. */
const referenceCity = buildCityWorld([plan(0, 1), plan(1, 7, 26)], { seats: 64 });
/** `gazelle` (7 floors) RIGHT of the HQ, one floor left: the one gap between them could hold both
 * towers, yet they must stand at least one or two buildings apart. */
const build11 = buildCityWorld([plan(0, 7, 26), plan(1, 1)], { seats: 64 });
/** A realistic five-floor city (`gazelle` 5 floors left of the HQ, two one-floor ones right, no
 * sub-agents): sized against the sky alone, its towers would be too small. */
const real = buildCityWorld([plan(0, 1, 0), plan(1, 5, 0), plan(2, 1, 0)], { seats: 64 });
const horizonOf = (w: World): number => w.city!.street * TILE;
const H = horizonOf(typical);
/** The tallest roof of `world` over its street, world px (−∞ for a street with no building). */
const tallestRoof = (w: World): number => Math.max(...w.city!.buildings.map((b) => horizonOf(w) - b.row * TILE));
/** FULL size of a far or tower landmark: towers a share of 1.5× the tallest roof (Skytree tip ≤ 5
 * tiles past the world's top, ≥ the sky less a tile); Fuji a share of the sky less a tile. */
const fullOf = (w: World, spec: LandmarkSpec): number => {
  const sky = referenceHeight(horizonOf(w));
  return Math.round((spec.layer === "tower" ? Math.max(sky, Math.min(1.5 * tallestRoof(w), horizonOf(w) + 5 * TILE)) : sky) * spec.height);
};
/** PAD in render/landmarks.ts: the world px kept between two crowns. */
const PAD = 8;

/** The sky in `phase` and `weather`, in Tokyo unless `zone` says otherwise (null = no zone known). */
function sky(phase: DayPhase = "noon", weather: WeatherKind = "clear", zone: string | null = "Asia/Tokyo"): Ambience {
  return computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather, phase }, zone ?? undefined);
}

const layoutOf = (world: World) => placeLandmarks(world, horizonOf(world), landmarksFor("Asia/Tokyo"));
const placed = (world: World, kind: LandmarkKind): PlacedLandmark => layoutOf(world).placed.find((p) => p.spec.kind === kind)!;

/** A view big enough for the whole typical city at zoom 1, the camera centred on what Fit frames (screen = world + offset). */
const VIEW = { w: 1600, h: H + 200 };
function centred(world: World, zoom = 1, view = VIEW): Camera {
  const [s0, s1] = layoutOf(world).span;
  return { zoom, ox: Math.round(view.w / 2 - ((s0 + s1) / 2) * zoom), oy: 100 };
}

const colours = (p: TowerPalette): Set<string> =>
  new Set([...Object.values(p.bands).flatMap((b) => [b.light, b.shade, b.edge]), p.lattice, p.girder, ...Object.values(p.deck)]);
const FUJI_COLOURS = new Set<string>([FUJI.body, FUJI.shade, FUJI.ridge, FUJI.ridgeShade, FUJI.snow, FUJI.snowShade, ...FUJI.haze, ...FUJI.hazeShade]);
const PALETTE: Record<Exclude<LandmarkKind, "pagoda" | "shrine">, Set<string>> = { fuji: FUJI_COLOURS, "tokyo-tower": colours(TOKYO_TOWER), skytree: colours(SKYTREE) };

const fills = (ctx: RecordingTarget, set: Set<string>): DrawCall[] => ctx.of("fillRect").filter((c) => set.has(c.fillStyle));

/** Screen bounding box [x0, y0, x1, y1] of some fillRects. */
function bbox(calls: DrawCall[]): [number, number, number, number] {
  const a = calls.map((c) => c.args as number[]);
  return [
    Math.min(...a.map((r) => r[0])),
    Math.min(...a.map((r) => r[1])),
    Math.max(...a.map((r) => r[0] + r[2])),
    Math.max(...a.map((r) => r[1] + r[3])),
  ];
}

function day(world = typical, cam = centred(world), amb: Ambience | undefined = sky(), view = VIEW): RecordingTarget {
  const ctx = recorder();
  paintFarLandmarks(ctx, cam, world, view, amb, horizonOf(world));
  paintLandmarks(ctx, cam, world, view, amb, horizonOf(world), 0);
  return ctx;
}

function night(phase: DayPhase, t: number, world = typical, cam = centred(world), weather: WeatherKind = "clear", view = VIEW): RecordingTarget {
  const ctx = recorder();
  paintLandmarkLights(ctx, cam, world, view, sky(phase, weather), horizonOf(world), t);
  return ctx;
}

// ───────────────────────────── which city ─────────────────────────────

describe("landmarksFor", () => {
  it("gives Tokyo its five — Fuji far, the two towers nearer, a pagoda and a shrine nearer still — each layer listed back to front, and every other zone none", () => {
    for (const zone of ["Asia/Tokyo", "Japan"])
      expect(landmarksFor(zone).map((l) => [l.kind, l.layer])).toEqual([
        ["fuji", "far"],
        ["skytree", "tower"],
        ["tokyo-tower", "tower"],
        ["pagoda", "near"],
        ["shrine", "near"],
      ]);
    // Not even a key every object has ("constructor") — the table is looked up by its own keys only.
    for (const zone of ["Europe/London", "America/New_York", "Asia/Seoul", "", undefined, "constructor", "toString"])
      expect(landmarksFor(zone), String(zone)).toEqual([]);
  });

  it("each painter draws nothing at all for another zone, no zone or no sky", () => {
    const none = sky("night", "clear", null);
    expect(none.zone).toBeUndefined();
    for (const amb of [sky("noon", "clear", "Europe/Paris"), sky("night", "clear", "Europe/Paris"), none, undefined]) {
      const ctx = recorder();
      paintFarLandmarks(ctx, centred(typical), typical, VIEW, amb, H);
      paintLandmarks(ctx, centred(typical), typical, VIEW, amb, H, 0);
      paintNearLandmarks(ctx, centred(typical), typical, VIEW, amb, H, 0);
      paintLandmarkLights(ctx, centred(typical), typical, VIEW, amb, H, 0);
      expect(ctx.calls).toEqual([]);
      expect(ctx.globalAlpha).toBe(1);
      expect(landmarkMask(centred(typical), typical, VIEW, amb, H)).toBeNull();
      expect(landmarkMask(centred(typical), typical, VIEW, amb, H, ["near"])).toBeNull();
    }
  });
});

// ───────────────────────────── size ─────────────────────────────

describe("size — real proportions against the city's sky", () => {
  it("the Skytree towers over the tallest building — 1.5× its roof — the Tower 333/634 of it (≈ 1/1.9); Fuji 0.6 of the sky less a tile and 4.2× as wide — each standing on the horizon", () => {
    // The HQ alone: open street either side of it, so every landmark stands at its full size.
    const cam = centred(alone);
    const ctx = day(alone, cam);
    const ref = referenceHeight(H);
    expect(horizonOf(alone)).toBe(H);
    expect(ref).toBe(H - TILE);
    // The HQ's two floors are its tallest roof (176 px): the Skytree is 264 px, rising 24 px past the world's
    // top (the sky is 240 px) into the open sky the City paints above it.
    expect(tallestRoof(alone)).toBe(176);
    expect(towerReference(H, 176)).toBe(264);
    const box = (k: keyof typeof PALETTE) => bbox(fills(ctx, PALETTE[k]));
    const [, skyTop, , skyBottom] = box("skytree");
    const [, towerTop, , towerBottom] = box("tokyo-tower");
    const [fx0, fujiTop, fx1, fujiBottom] = box("fuji");
    const top = (h: number) => cam.oy + H - h;
    expect(skyTop).toBe(top(264));
    expect(skyTop).toBeLessThan(cam.oy);
    expect(towerTop).toBe(top(Math.round((264 * 333) / 634)));
    expect(fujiTop).toBe(top(Math.round(ref * 0.6)));
    for (const bottom of [skyBottom, towerBottom, fujiBottom]) expect(bottom).toBe(cam.oy + H);
    // Skytree ≈ 1.9 × the Tower (634 m / 333 m); Fuji wide and low: wider than tall, by far the widest.
    const sk = skyBottom - skyTop;
    const tt = towerBottom - towerTop;
    expect(sk / tt).toBeGreaterThan(1.85);
    expect(sk / tt).toBeLessThan(1.95);
    expect((fx1 - fx0) / (fujiBottom - fujiTop)).toBeGreaterThan(4);
    expect(fx1 - fx0).toBeGreaterThan(5 * (box("tokyo-tower")[2] - box("tokyo-tower")[0]));
  });

  it("the towers' reference is 1.5× the tallest roof — its tip at most 5 tiles past the world's top — never less than the sky less a tile, which only a street of one-floor buildings, or none, keeps", () => {
    // `gazelle` is 416 px under a 496-px sky: 1.5× would put the Skytree's tip 128 px past the top,
    // so it stops 5 tiles past: 576 px (1.38× gazelle); the Tower is 333/634 of that.
    expect(tallestRoof(real)).toBe(416);
    expect(referenceHeight(horizonOf(real))).toBe(480);
    expect(horizonOf(real)).toBe(496);
    expect(towerReference(496, 416)).toBe(576);
    expect([placed(real, "skytree").h, placed(real, "tokyo-tower").h]).toEqual([576, 303]);
    expect(horizonOf(real) - placed(real, "skytree").h).toBe(-5 * TILE);
    expect(placed(real, "fuji").h).toBe(Math.round(0.6 * 480));
    // Up to three floors the full 1.5×: the HQ alone (two floors, 176 px) has a 264-px Skytree, 24 px past
    // the top of its 240-px sky; three floors (256 px) one of 384, 48 past a 336-px sky.
    expect(towerReference(240, 176)).toBe(264);
    expect(towerReference(336, 256)).toBe(384);
    expect(placed(city([3]), "skytree").h).toBe(384);
    // Four floors and up, the cap: 1.43× four floors, 1.29× six, 1.15× twelve.
    expect(towerReference(400, 336) / 336).toBeCloseTo(1.43, 2);
    expect(towerReference(560, 496) / 496).toBeCloseTo(1.29, 2);
    expect(towerReference(1040, 976) / 976).toBeCloseTo(1.15, 2);
    // In every City the tests sweep the Skytree stands at that reference — at full size, its tip at most 5
    // tiles past the world's top, and the Tower 333/634 of it.
    for (const [name, w] of WITH_HQ) {
      const [sk, tt] = [placed(w, "skytree"), placed(w, "tokyo-tower")];
      expect(sk.h, name).toBe(towerReference(horizonOf(w), tallestRoof(w)));
      expect(sk.h, name).toBeLessThanOrEqual(horizonOf(w) + 5 * TILE);
      expect(sk.h / tallestRoof(w), name).toBeGreaterThan(1.14);
      expect(tt.h, name).toBe(Math.round((sk.h * 333) / 634));
    }
    // One-floor buildings with no HQ: the world's sky is never shorter than a two-floor block's (240 px), and
    // 1.5× their 96-px roofs is 144, under its 224 px less a tile — which the Skytree keeps; an empty street
    // has no roof and keeps it too.
    const ones = city([1, 1], false);
    expect([tallestRoof(ones), horizonOf(ones)]).toEqual([96, 240]);
    expect(towerReference(horizonOf(ones), 96)).toBe(224);
    expect(placed(ones, "skytree").h).toBe(224);
    const empty = buildCityWorld([]);
    expect(tallestRoof(empty)).toBe(-Infinity);
    expect(towerReference(horizonOf(empty), -Infinity)).toBe(referenceHeight(horizonOf(empty)));
    expect(placed(empty, "skytree").h).toBe(referenceHeight(horizonOf(empty)));
  });

  it("they grow with the city: a taller sky, taller Fuji and towers — and a taller pagoda once 0.3 of the sky passes its floor; the shrine stays the skyline's low-city height", () => {
    const low = city([1], false);
    const high = city([1, 4]);
    expect(horizonOf(high)).toBeGreaterThan(horizonOf(low));
    const heights = (w: World) => Object.fromEntries(layoutOf(w).placed.map((p) => [p.spec.kind, p.h]));
    const [a, b] = [heights(low), heights(high)];
    for (const kind of ["fuji", "tokyo-tower", "skytree", "pagoda"]) expect(b[kind], kind).toBeGreaterThan(a[kind]);
    expect([a.shrine, b.shrine]).toEqual([SKYLINE_BASE, SKYLINE_BASE]);
  });

  it("Fuji is the far layer only and the towers the near one — Fuji behind the clouds' layer, the towers in front of it", () => {
    const cam = centred(typical);
    const far = recorder();
    paintFarLandmarks(far, cam, typical, VIEW, sky(), H);
    const near = recorder();
    paintLandmarks(near, cam, typical, VIEW, sky(), H, 0);
    expect(fills(far, FUJI_COLOURS).length).toBe(far.of("fillRect").length);
    expect(far.of("fillRect").length).toBeGreaterThan(50);
    const towers = new Set([...PALETTE["tokyo-tower"], ...PALETTE.skytree]);
    expect(fills(near, towers).length).toBe(near.of("fillRect").length);
    expect(fills(near, PALETTE.skytree).length).toBeGreaterThan(50);
    expect(fills(near, PALETTE["tokyo-tower"]).length).toBeGreaterThan(50);
    // The Skytree (the farther: the table lists it first) goes down first, so the Tower stands in front where they overlap.
    const first = (set: Set<string>) => near.calls.findIndex((c) => c.op === "fillRect" && set.has(c.fillStyle));
    expect(first(PALETTE.skytree)).toBeLessThan(first(PALETTE["tokyo-tower"]));
  });

  it("the Tower is international orange and white with lighter X-bracing; the Skytree pale with dark glass decks and a cyan band", () => {
    const ctx = day();
    const used = new Set(ctx.of("fillRect").map((c) => c.fillStyle));
    for (const c of [TOKYO_TOWER.bands.orange.light, TOKYO_TOWER.bands.white.light, TOKYO_TOWER.lattice, TOKYO_TOWER.deck.glass]) expect(used).toContain(c);
    for (const c of [SKYTREE.bands.body.light, SKYTREE.deck.glass, SKYTREE.deck.light, SKYTREE.lattice]) expect(used).toContain(c);
    for (const c of [FUJI.snow, FUJI.body, FUJI.ridge]) expect(used).toContain(c);
    // Two white bands between the Tower's main deck and its top deck, two more on its mast.
    const cam = centred(typical);
    // (Every row a white rect covers — a band narrowing upward is a few rects, one per width — and a band
    // is a run of consecutive rows.)
    const rows = [
      ...new Set(fills(ctx, new Set([TOKYO_TOWER.bands.white.light])).flatMap((c) => {
        const [, y, , h] = c.args as number[];
        return Array.from({ length: h }, (_, k) => y + k);
      })),
    ].sort((a, b) => a - b);
    const bands = rows.filter((y, i) => i === 0 || y - rows[i - 1] > 1);
    expect(bands.length).toBe(4);
    // The lowest above the Tower's middle (its main deck), as its height fraction.
    expect((cam.oy + H - rows.at(-1)! - 1) / placed(typical, "tokyo-tower").h).toBeGreaterThan(0.5);
  });
});

// ───────────────────────────── crowns ─────────────────────────────

describe("landmarkCrown — the part no building may hide", () => {
  /** Zoom-1 fillRects of `set` as world rects [x, y, w, h] (screen less the camera's offset). */
  const world = (calls: DrawCall[], cam: Camera) =>
    calls.map((c) => {
      const [x, y, w, h] = c.args as number[];
      return [x - Math.round(cam.ox), y - Math.round(cam.oy), w, h];
    });

  it("a tower's: from its tip down to the bottom of its lowest deck, as wide as that deck — everything painted in those rows lies inside it, and the deck fills it edge to edge", () => {
    for (const w of [alone, typical, referenceCity, real]) {
      // The view reaches up past the world's top to the Skytree's tip, 100 px under its top edge.
      const over = Math.max(0, ...layoutOf(w).placed.map((p) => p.h - horizonOf(w)));
      const view = { w: w.cols * TILE + 400, h: horizonOf(w) + 200 + over };
      const cam = { ...centred(w, 1, view), oy: 100 + over };
      const ctx = day(w, cam, sky(), view);
      for (const [kind, pal] of [
        ["tokyo-tower", TOKYO_TOWER],
        ["skytree", SKYTREE],
      ] as const) {
        const p = placed(w, kind);
        const c = landmarkCrown(p);
        const where = `${kind} ${p.h} px`;
        const rects = world(fills(ctx, colours(pal)), cam);
        // Its tip is the crown's top.
        expect(Math.min(...rects.map((r) => r[1])), where).toBe(c.top);
        const inCrown = rects.filter(([, y, , h]) => y < c.bottom && y + h > c.top);
        for (const [x, , rw] of inCrown) {
          expect(x, `${where}: left`).toBeGreaterThanOrEqual(c.x0);
          expect(x + rw, `${where}: right`).toBeLessThanOrEqual(c.x1);
        }
        expect(Math.min(...inCrown.map((r) => r[0])), where).toBe(c.x0);
        expect(Math.max(...inCrown.map((r) => r[0] + r[2])), where).toBe(c.x1);
        // Its bottom row is the lowest deck's (deck colours there, none on the row below — the body).
        const deck = new Set(Object.values(pal.deck));
        const deckRows = world(fills(ctx, deck), cam).filter(([x]) => x >= c.x0 && x < c.x1);
        expect(Math.max(...deckRows.map(([, y, , h]) => y + h)), where).toBe(c.bottom);
        // The crown is the upper part, not the whole tower: the Skytree's Tembo Deck sits at 0.53 of it, the Tower's main deck at 0.43.
        expect((horizonOf(w) - c.bottom) / p.h, where).toBeCloseTo(kind === "skytree" ? 0.53 : 0.43, 1);
      }
    }
  });

  it("Fuji's: its whole snow cap — the solid cap and every ragged snow column under it, to the deepest", () => {
    // Its full size in the shortest sky and the reference city's, smaller in the typical city — and 110 px on an
    // empty street under a 200-px horizon, where the cap's lowest row reaches a px past the columns.
    const empty = buildCityWorld([]);
    for (const [w, h0] of [
      [alone, horizonOf(alone)],
      [typical, H],
      [referenceCity, horizonOf(referenceCity)],
      [empty, 200],
    ] as const) {
      const p = placeLandmarks(w, h0, landmarksFor("Asia/Tokyo")).placed.find((q) => q.spec.kind === "fuji")!;
      const view = { w: w.cols * TILE + 2000, h: h0 + 200 };
      const [s0, s1] = placeLandmarks(w, h0, landmarksFor("Asia/Tokyo")).span;
      const cam = { zoom: 1, ox: Math.round(view.w / 2 - (s0 + s1) / 2), oy: 100 };
      const ctx = recorder();
      paintFarLandmarks(ctx, cam, w, view, sky(), h0);
      const c = landmarkCrown(p);
      const peak = h0 - p.h;
      const cap = Math.round(p.h * 0.2);
      const snow = world(fills(ctx, new Set([FUJI.snow, FUJI.snowShade])), cam);
      // The solid cap: the rows above `cap`. The columns: one rect each, from the cap's foot down to its own depth
      // (the streaks further down its ravines start lower, each at its own column's depth).
      const solid = snow.filter(([, y]) => y < peak + cap);
      const columns = snow.filter(([, y]) => y === peak + cap);
      expect(columns.length, `${p.h}`).toBeGreaterThan(10);
      expect(c.top).toBe(peak);
      expect(c.x0).toBe(Math.min(...[...solid, ...columns].map((r) => r[0])));
      expect(c.x1).toBe(Math.max(...[...solid, ...columns].map((r) => r[0] + r[2])));
      expect(c.bottom).toBe(Math.max(...columns.map(([, y, , h]) => y + h)));
      if (w === empty) {
        expect(p.h).toBe(110);
        expect(Math.max(...solid.map((r) => r[0] + r[2]))).toBe(Math.max(...columns.map((r) => r[0] + r[2])) + 1);
      }
    }
  });

  it("a temple's is all of it: it shows whole", () => {
    for (const kind of ["pagoda", "shrine"] as const) {
      const p = placed(typical, kind);
      const { hw } = templeArt(kind, p.h, true);
      expect(landmarkCrown(p)).toEqual({ x0: p.x - hw, x1: p.x + hw, top: H - p.h, bottom: H });
    }
  });
});

// ───────────────────────────── placement ─────────────────────────────

/** Every building of `world` as a world-px box: its outer walls, from its roof slab down. */
const buildingsOf = (world: World) =>
  world.city!.buildings.map((b) => ({ key: b.key, x0: b.col * TILE, x1: (b.col + b.w) * TILE, top: b.row * TILE }));
/** The buildings that HIDE crown `c`: across its width, their roof above its bottom. */
const hiders = (world: World, c: WorldBox): string[] =>
  buildingsOf(world)
    .filter((b) => b.x0 < c.x1 && b.x1 > c.x0 && b.top < c.bottom)
    .map((b) => b.key);
/** The far and tower landmarks of `world` — the ones with a crown to keep in sight. */
const crowned = (world: World) => layoutOf(world).placed.filter((p) => p.spec.layer !== "near");

/** The tallest building of `world` over world x ∈ [a, b] (0 = open sky). */
function roofOver(world: World, a: number, b: number): number {
  let m = 0;
  for (const bl of world.city!.buildings)
    if (bl.col * TILE < b && (bl.col + bl.w) * TILE > a) m = Math.max(m, horizonOf(world) - bl.row * TILE);
  return m;
}

/** An eighth of the span Fit frames: the air two towers' crowns keep when no building can stand between them. */
const farOf = (world: World): number => Math.round((layoutOf(world).span[1] - layoutOf(world).span[0]) / 8);

/** Two tower crowns' separation: 3 = two or more buildings WHOLLY between them, 2 = one, 1 = none
 * but an eighth of the span of air, 0 = less. */
function separation(world: World, a: WorldBox, b: WorldBox, bs = buildingsOf(world), far = farOf(world)): number {
  const [l, r] = a.x0 < b.x0 ? [a, b] : [b, a];
  const n = bs.filter((o) => o.x0 >= l.x1 && o.x1 <= r.x0).length;
  if (n) return 1 + Math.min(2, n);
  return r.x0 - l.x1 >= far ? 1 : 0;
}
/** The separation of `world`'s Tokyo Tower and Skytree, where they stand. */
const towersApart = (world: World): number => separation(world, landmarkCrown(placed(world, "tokyo-tower")), landmarkCrown(placed(world, "skytree")));

/** Are two crowns at least PAD apart? */
const padClear = (a: WorldBox, b: WorldBox): boolean => a.x1 + PAD <= b.x0 || b.x1 + PAD <= a.x0;

/** Every crown `p` could have at its size: one per whole world x with the crown inside the span Fit frames and no building hiding it. */
function spotsOf(world: World, p: PlacedLandmark): WorldBox[] {
  const [s0, s1] = layoutOf(world).span;
  const c = landmarkCrown({ ...p, x: 0 });
  const out: WorldBox[] = [];
  for (let x = s0 - c.x0; x <= s1 - c.x1; x++) {
    const at = { ...c, x0: c.x0 + x, x1: c.x1 + x };
    if (hiders(world, at).length === 0) out.push(at);
  }
  return out;
}

/** BRUTE FORCE: the best separation any arrangement could have at the drawn sizes (every whole-px
 * tower pair, PAD clear, Fuji PAD clear of both). Shares only the crowns with landmarks.ts. */
function bestApart(world: World): number {
  const [fuji, tower, skytree] = (["fuji", "tokyo-tower", "skytree"] as const).map((k) => spotsOf(world, placed(world, k)));
  const [bs, far] = [buildingsOf(world), farOf(world)];
  let best = 0;
  for (const t of tower)
    for (const s of skytree) {
      if (!padClear(t, s)) continue;
      const level = separation(world, t, s, bs, far);
      if (level > best && fuji.some((f) => padClear(f, t) && padClear(f, s))) best = level;
      if (best === 3) return best;
    }
  return best;
}

/** Where Fuji and the towers stand (centre x, world px). */
type Spots = Record<"fuji" | "tokyo-tower" | "skytree", number>;
const spotsNow = (world: World): Spots => Object.fromEntries(crowned(world).map((p) => [p.spec.kind, p.x])) as Spots;
/** How many pairs stand out of the composition's order: Fuji, the Tower, the Skytree, left to right. */
const inversions = (xs: Spots): number => Number(xs.fuji > xs["tokyo-tower"]) + Number(xs.fuji > xs.skytree) + Number(xs["tokyo-tower"] > xs.skytree);

/** The NEAREST spots, shortest first: each on the whole x nearest its preferred place (ties go
 * right), crown in the span, unhidden, PAD clear of earlier ones: where they would stand if not
 * kept apart. Null when that greedy pass finds no spot though an arrangement exists. */
function nearestSpots(world: World): Spots | null {
  const { span } = layoutOf(world);
  const before: WorldBox[] = [];
  const out = {} as Spots;
  for (const p of [...crowned(world)].sort((a, b) => fullOf(world, a.spec) - fullOf(world, b.spec))) {
    const pref = Math.round(span[0] + p.spec.prefer * (span[1] - span[0]));
    const clear = (x: number) => {
      const c = landmarkCrown({ ...p, x });
      return c.x0 >= span[0] && c.x1 <= span[1] && hiders(world, c).length === 0 && before.every((o) => padClear(c, o));
    };
    let d = 0;
    while (!clear(pref + d) && !clear(pref - d)) if (++d > span[1] - span[0]) return null;
    const x = clear(pref + d) ? pref + d : pref - d;
    out[p.spec.kind as keyof Spots] = x;
    before.push(landmarkCrown({ ...p, x }));
  }
  return out;
}
/** The separation of the towers on those nearest spots. */
function nearestApart(world: World): number {
  const xs = nearestSpots(world)!;
  return separation(world, landmarkCrown({ ...placed(world, "tokyo-tower"), x: xs["tokyo-tower"] }), landmarkCrown({ ...placed(world, "skytree"), x: xs.skytree }));
}

/** The camera VillageView's Fit gives `world` in a `w`×`h` CSS px pane (HUD 117 px tall). */
function fitOf(world: World, w: number, h: number, dpr: number): { cam: Camera; view: { w: number; h: number } } {
  const v = new VillageView(1, () => null, "city");
  v.resize(w, h, dpr);
  v.setInset(117);
  v.setWorld(world);
  // Tokyo's sky: Fit frames the landmarks' tips (`fitTarget`), as in the panel.
  v.setAmbience(sky());
  v.fit();
  return { cam: v.camera, view: v.view };
}

/** Typical cities (1–5 buildings of 1–3 floors), with and without the mid-street HQ, so a
 * lopsided city runs on past its buildings on one side. */
const TYPICAL: [string, World][] = [
  ["HQ alone", alone],
  ["HQ + 1", city([1])],
  ["HQ + 1 wide (a 24-seat team: the HQ at the left end of what is built)", buildCityWorld([plan(0, 1, 24)], { seats: 16 })],
  ["HQ + 2 (1, 2 floors)", typical],
  ["HQ + 2 (3, 3 floors)", city([3, 3])],
  ["HQ + 3 (1, 3, 2 floors)", city([1, 3, 2])],
  ["HQ + 3 (2, 2, 2 floors, wide teams)", buildCityWorld([plan(0, 2, 8), plan(1, 2, 6), plan(2, 2, 10)], { seats: 12 })],
  ["2 projects (1, 2 floors)", city([1, 2], false)],
  ["3 projects (1 floor each)", city([1, 1, 1], false)],
  ["4 projects (1, 2, 3, 1 floors)", city([1, 2, 3, 1], false)],
];
/** Every City the panel builds has the HQ: 0–3 projects of 1–6 floors, narrow and wide teams. */
const WITH_HQ: [string, World][] = [
  ["the reference city", referenceCity],
  ["the reference city on build-11", build11],
  ["the realistic five-floor city", real],
];
for (let a = 0; a <= 6; a++)
  for (let b = 0; b <= 6; b += 2)
    for (const c of [0, 1, 5])
      for (const team of [2, 26]) {
        const floors = [a, b, c].filter((f) => f > 0);
        WITH_HQ.push([`HQ + [${floors}] team ${team}`, buildCityWorld(floors.map((f, i) => plan(i, f, i === 0 ? team : 2)), { seats: 64 })]);
      }
// …and tall ones: a building of eleven or twelve floors beside a low one, three tall projects.
for (const floors of [[1, 11], [12, 5], [7, 9, 11], [1, 12, 1]])
  WITH_HQ.push([`HQ + [${floors}] (tall)`, buildCityWorld(floors.map((f, i) => plan(i, f)), { seats: 64 })]);
/** Panes the City is fitted into (CSS w × h × device pixel ratio). */
const PANES: [number, number, number][] = [
  [720, 600, 1],
  [720, 600, 2],
  [990, 576, 1],
  [1200, 800, 2],
];

describe("placement — no building ever hides a crown", () => {
  it("in every city the panel builds (all with the HQ) — the reference city too: no building hides a crown, each inside the span Fit frames, PAD clear of the others", () => {
    for (const [name, world] of WITH_HQ) {
      const { span } = layoutOf(world);
      const crowns = crowned(world).map((p) => ({ kind: p.spec.kind, c: landmarkCrown(p) }));
      for (const { kind, c } of crowns) {
        expect(hiders(world, c), `${name}: ${kind}`).toEqual([]);
        expect(c.x0, `${name}: ${kind} in the frame`).toBeGreaterThanOrEqual(span[0]);
        expect(c.x1, `${name}: ${kind} in the frame`).toBeLessThanOrEqual(span[1]);
        for (const o of crowns) if (o.kind !== kind) expect(c.x1 + PAD <= o.c.x0 || o.c.x1 + PAD <= c.x0, `${name}: ${kind} vs ${o.kind}`).toBe(true);
      }
    }
  });

  it("SEPARATION (the two towers stand at least one or two buildings apart): in every city the panel builds, the towers stand as far apart as ANY arrangement at their sizes could have them — two buildings wholly between their crowns, else one, else an eighth of the span, else PAD", () => {
    const seen = [0, 0, 0, 0];
    for (const [name, world] of [...WITH_HQ, ...TYPICAL.filter(([n]) => n.startsWith("HQ"))]) {
      const got = towersApart(world);
      expect(got, name).toBe(bestApart(world));
      seen[got]++;
    }
    // Every level occurs in the sweep — the claim is not vacuous for any of them.
    expect(seen.every((n) => n > 0), `${seen}`).toBe(true);
  });

  it("…which parts them by a building in every city with two projects or more beside the HQ, but where no arrangement can: where the Skytree's crown is wider than a 4-tile gap (eleven floors and up), or every crown must stand in a gap or over the low HQ", () => {
    const unparted: string[] = [];
    for (const [name, world] of WITH_HQ)
      if (world.city!.buildings.length >= 3 && towersApart(world) < 2) {
        expect(bestApart(world), name).toBeLessThan(2);
        unparted.push(name);
      }
    expect(unparted).toEqual(["HQ + [2,2] team 2", "HQ + [3,4] team 2", "HQ + [4,4] team 2", "HQ + [1,11] (tall)", "HQ + [12,5] (tall)", "HQ + [7,9,11] (tall)"]);
    const named = (name: string) => WITH_HQ.find(([n]) => n === name)![1];
    // Three or four floors either side: every crown but the Skytree's is lower than every roof but the HQ's —
    // Fuji's and the Tower's must each stand in a gap — and the Skytree's lower than the projects' too: it
    // stands over the HQ, between them but not WHOLLY between their crowns.
    for (const name of ["HQ + [3,4] team 2", "HQ + [4,4] team 2"]) {
      const w = named(name);
      const [left, mid, right] = [...w.city!.buildings].sort((p, q) => p.col - q.col);
      expect(landmarkCrown(placed(w, "skytree")).x0, name).toBeGreaterThanOrEqual(mid.col * TILE);
      expect(landmarkCrown(placed(w, "skytree")).x1, name).toBeLessThanOrEqual((mid.col + mid.w) * TILE);
      for (const k of ["fuji", "tokyo-tower", "skytree"] as const)
        for (const b of [left, right]) expect(b.row * TILE, `${name}: ${k}`).toBeLessThan(landmarkCrown(placed(w, k)).bottom);
    }
    // From eleven floors up the Skytree's crown (the cap holds it to 1056–1120 px) is wider than a 4-tile gap:
    // beside the HQ it overhangs the HQ's roof (too low to hide it), and the HQ is no longer wholly between.
    for (const name of ["HQ + [1,11] (tall)", "HQ + [12,5] (tall)", "HQ + [7,9,11] (tall)"]) {
      const c = landmarkCrown(placed(named(name), "skytree"));
      expect(c.x1 - c.x0, name).toBeGreaterThan(4 * TILE);
    }
    // Where they share the street — the only two cities. With two-floor projects even the eighth of the span is
    // out of reach: every crown must stand in one of the two 4-tile gaps (each roof rises above every crown's
    // bottom) and Fuji's snow fills one, so the towers share the other.
    const shared = [...WITH_HQ, ...TYPICAL].filter(([, w]) => towersApart(w) === 0);
    expect(shared.map(([n]) => n)).toEqual(["HQ + [2,2] team 2", "HQ + [7,9,11] (tall)"]);
    const two = named("HQ + [2,2] team 2");
    const [a, hq, b] = [...two.city!.buildings].sort((p, q) => p.col - q.col);
    const gaps = [
      [(a.col + a.w) * TILE, hq.col * TILE],
      [(hq.col + hq.w) * TILE, b.col * TILE],
    ];
    const inGap = (c: WorldBox) => gaps.findIndex(([g0, g1]) => c.x0 >= g0 && c.x1 <= g1);
    const [f, t, s] = (["fuji", "tokyo-tower", "skytree"] as const).map((k) => landmarkCrown(placed(two, k)));
    for (const c of [f, t, s]) for (const bl of [a, hq, b]) expect(bl.row * TILE).toBeLessThan(c.bottom);
    expect(inGap(t)).toBeGreaterThanOrEqual(0);
    expect(inGap(s)).toBe(inGap(t));
    expect(inGap(f)).toBe(1 - inGap(t));
    expect(f.x1 - f.x0).toBe(4 * TILE);
    // Every roof but the HQ's tops every crown, and Fuji's snow (336 px) fits only over the HQ (352
    // px between its neighbours), so both towers stand in the open street left of them all, under
    // an eighth of the span apart.
    const tall = named("HQ + [7,9,11] (tall)");
    const [first, hqTall, next] = [...tall.city!.buildings].sort((p, q) => p.col - q.col);
    const [ft, tt, st] = (["fuji", "tokyo-tower", "skytree"] as const).map((k) => landmarkCrown(placed(tall, k)));
    expect(hqTall.hq).toBe(true);
    expect([ft.x1 - ft.x0, next.col * TILE - (first.col + first.w) * TILE]).toEqual([336, 352]);
    expect(ft.x0).toBeGreaterThanOrEqual((first.col + first.w) * TILE);
    expect(ft.x1).toBeLessThanOrEqual(next.col * TILE);
    for (const c of [tt, st]) expect(c.x1).toBeLessThanOrEqual(first.col * TILE);
    expect(first.col * TILE - layoutOf(tall).span[0] - (tt.x1 - tt.x0) - (st.x1 - st.x0)).toBeLessThan(farOf(tall));
  });

  it("in the reference city as on build-11 the towers no longer share the gap between the HQ and gazelle: the Tower against the one-floor building's left wall, the Skytree against gazelle — that building wholly between their crowns, it and the HQ between the two towers; Fuji between them (no room for its snow left of the bigger Tower); all at full size, nothing hidden", () => {
    const [ide, hq, gazelle] = [...build11.city!.buildings].sort((a, b) => a.col - b.col);
    expect([ide.hq, hq.hq, gazelle.hq, gazelle.w]).toEqual([undefined, true, undefined, 38]);
    const [fuji, tower, skytree] = (["fuji", "tokyo-tower", "skytree"] as const).map((k) => placed(build11, k));
    const [t, s] = [tower, skytree].map(landmarkCrown);
    // Before, on the nearest spots: both towers over the HQ and its gap to gazelle, PAD apart.
    const near = nearestSpots(build11)!;
    for (const k of ["tokyo-tower", "skytree"] as const) {
      const c = landmarkCrown({ ...placed(build11, k), x: near[k] });
      expect(c.x0, k).toBeGreaterThanOrEqual(hq.col * TILE);
      expect(c.x1, k).toBeLessThanOrEqual(gazelle.col * TILE);
    }
    expect(nearestApart(build11)).toBe(0);
    // Now: the one-floor building wholly between the crowns — the Tower right against its left wall, the
    // Skytree right against gazelle — and both it and the HQ between the towers.
    expect(t.x1).toBe(ide.col * TILE);
    expect(s.x1).toBe(gazelle.col * TILE);
    expect(towersApart(build11)).toBe(2);
    for (const b of [ide, hq]) {
      expect(tower.x).toBeLessThan(b.col * TILE);
      expect(skytree.x).toBeGreaterThan((b.col + b.w) * TILE);
    }
    // Fuji stands between the towers, one pair out of the composition's order: its snow and the bigger Tower's
    // crown, PAD apart, are wider than the street the frame shows left of the one-floor building — by 3 px (they
    // fitted there while the Tower was 504 px, its crown 67 wide; at 555 px it is 73).
    expect([tower.h, t.x1 - t.x0]).toEqual([555, 73]);
    expect(tower.x).toBeLessThan(fuji.x);
    expect(fuji.x).toBeLessThan(skytree.x);
    const f = landmarkCrown(fuji);
    expect(f.x1 - f.x0 + PAD + t.x1 - t.x0).toBeGreaterThan(ide.col * TILE - layoutOf(build11).span[0]);
    expect(inversions(spotsNow(build11))).toBe(1);
    for (const p of crowned(build11)) {
      expect(hiders(build11, landmarkCrown(p)), p.spec.kind).toEqual([]);
      expect(p.h, p.spec.kind).toBe(fullOf(build11, p.spec));
    }
  });

  it("COMPOSITION: where no arrangement parts the towers further than the nearest spots do, nor in a better order, each stands on its nearest spot; where one does, it is further apart, or as far in fewer pairs out of the order Fuji – Tower – Skytree", () => {
    const kept: string[] = [];
    const ordered: string[] = [];
    const greedy: string[] = [];
    // (…and a street without the HQ, where the nearest spots stand out of order.)
    const unordered: [string, World] = ["3 projects (1, 3, 3 floors)", city([1, 3, 3], false)];
    for (const [name, world] of [...WITH_HQ, ...TYPICAL.filter(([n]) => n.startsWith("HQ")), unordered]) {
      const [near, now] = [nearestSpots(world), spotsNow(world)];
      // One at a time, nearest first, the last finds no room; together, every one has a spot (the first test).
      if (!near) {
        greedy.push(name);
        continue;
      }
      const [was, is] = [nearestApart(world), towersApart(world)];
      if (was === is && inversions(near) === inversions(now)) {
        expect(now, name).toEqual(near);
        kept.push(name);
      } else expect(is > was || (is === was && inversions(now) < inversions(near)), name).toBe(true);
      if (is === was && inversions(now) < inversions(near)) ordered.push(name);
    }
    // The nearest spots already part the towers as far as anything can, in as good an order, in these — the
    // reference city with `gazelle` LEFT of the HQ among them (a one-floor building stands between them
    // there), and the one city where they share a gap (two-floor projects).
    expect(kept).toEqual(["the reference city", "HQ + [1,4] team 2", "HQ + [2,2] team 2"]);
    // One at a time, each nearest its preferred place, the last finds no room in these: the one-at-a-time SIZE
    // pass there was before would have drawn it smaller (or stood it past the walls). Sized together, every
    // crown has its spot in the frame, and the towers stand at full size (the towers' reference test).
    expect(greedy).toEqual(["HQ + [6,6,5] team 26", "HQ + [1,11] (tall)", "HQ + [12,5] (tall)", "HQ + [7,9,11] (tall)"]);
    // …and where the nearest spots stand out of the composition's order, the separation they had is kept but
    // put back into it. (In no City with the HQ the tests sweep do the nearest spots stand out of order at a
    // separation nothing betters: Fuji, now the shortest, takes its spot left first.)
    expect(ordered).toEqual(["3 projects (1, 3, 3 floors)"]);
    expect(inversions(nearestSpots(unordered[1])!)).toBe(2);
    expect(inversions(spotsNow(unordered[1]))).toBe(0);
  });

  it("the HQ alone: no building can stand between the towers (Fuji takes the open street left of it), so they keep an eighth of the span — both right of the HQ, the Tower against its wall and the Skytree just that far on", () => {
    const [hq] = alone.city!.buildings;
    const [t, s] = [placed(alone, "tokyo-tower"), placed(alone, "skytree")].map(landmarkCrown);
    expect(bestApart(alone)).toBe(1);
    expect(landmarkCrown(placed(alone, "fuji")).x1).toBeLessThanOrEqual(hq.col * TILE);
    expect(t.x0).toBe((hq.col + hq.w) * TILE);
    expect(s.x0 - t.x1).toBe(farOf(alone));
    expect(farOf(alone)).toBe(52);
    // The most the street right of the HQ could give them (its 96 px less both crowns, 18 + 24 px) is not much more.
    expect([t.x1 - t.x0, s.x1 - s.x0]).toEqual([18, 24]);
    expect(layoutOf(alone).span[1] - (hq.col + hq.w) * TILE - (t.x1 - t.x0) - (s.x1 - s.x0)).toBe(54);
    // Before: PAD apart.
    expect(nearestApart(alone)).toBe(0);
  });

  it("a crown never pokes past the frame's edge, even where its preferred place is the edge itself and the building there is too low to hide it", () => {
    // The HQ and a one-floor project, whose right wall is the span's right end: a Skytree that prefers the
    // very end stands with its crown flush against it, not half a crown past it (nearer, but cropped at Fit).
    const one = city([1]);
    const [s0, s1] = layoutOf(one).span;
    const last = [...one.city!.buildings].sort((a, b) => a.col - b.col).at(-1)!;
    expect((last.col + last.w) * TILE).toBe(s1);
    const edges: LandmarkSpec[] = [
      { kind: "skytree", layer: "tower", height: 1, prefer: 1 },
      { kind: "fuji", layer: "far", height: 0.6, prefer: 0 },
    ];
    const [skytree, fuji] = placeLandmarks(one, horizonOf(one), edges).placed;
    expect(landmarkCrown(skytree).x1).toBe(s1);
    expect(landmarkCrown(fuji).x0).toBe(s0);
    // Flush with the frame's edge is inside it, not past it: the HQ alone has open street either side, and
    // each stands flush with the end it prefers — not swapped to stand clear of the edges.
    const [a0, a1] = layoutOf(alone).span;
    const [sk, fj] = placeLandmarks(alone, H, edges).placed.map(landmarkCrown);
    expect([fj.x0, sk.x1]).toEqual([a0, a1]);
  });

  it("a landmark whose preferred place is taken steps aside to the nearest clear spot — to the right on a tie, as a project goes in engine/city.ts; a second tower an eighth of the span off the first", () => {
    // An empty street: the only thing in the way is the first landmark's crown.
    const empty = buildCityWorld([]);
    expect(empty.city!.buildings).toHaveLength(0);
    const pref = Math.round(0.5 * empty.cols * TILE);
    const far = Math.round((empty.cols * TILE) / 8);
    // Two Fujis (the table is data; Fuji keeps no tower apart): equal heights keep the table's order, so the
    // first takes its place; the second's nearest clear spots are as far either side — it goes right, PAD clear.
    const fujis: LandmarkSpec[] = [
      { kind: "fuji", layer: "far", height: 0.6, prefer: 0.5 },
      { kind: "fuji", layer: "far", height: 0.6, prefer: 0.5 },
    ];
    const [f1, f2] = placeLandmarks(empty, horizonOf(empty), fujis).placed;
    expect(f1.x).toBe(pref);
    expect(landmarkCrown(f2).x0).toBe(landmarkCrown(f1).x1 + PAD);
    // Two Skytrees: no building can stand between them on an empty street, so the second keeps an eighth of
    // the span off the first — to its right, the tie again.
    const twins: LandmarkSpec[] = [
      { kind: "skytree", layer: "tower", height: 1, prefer: 0.5 },
      { kind: "skytree", layer: "tower", height: 1, prefer: 0.5 },
    ];
    const [a, b] = placeLandmarks(empty, horizonOf(empty), twins).placed;
    expect(a.x).toBe(pref);
    expect(landmarkCrown(b).x0).toBe(landmarkCrown(a).x1 + far);
    // Not a tie: the shorter goes first, and the Skytree takes the nearer side, whichever it is — here
    // the left (the Tower's 15-px deck reaches a px further right of its centre than left).
    const pair: LandmarkSpec[] = [
      { kind: "skytree", layer: "tower", height: 1, prefer: 0.5 },
      { kind: "tokyo-tower", layer: "tower", height: 0.5, prefer: 0.5 },
    ];
    const [skytree, tower] = placeLandmarks(empty, horizonOf(empty), pair).placed;
    expect(tower.x).toBe(pref);
    expect(pref - landmarkCrown(tower).x0).toBeLessThan(landmarkCrown(tower).x1 - pref);
    expect(landmarkCrown(skytree).x1 + far).toBe(landmarkCrown(tower).x0);
    // Neither was made smaller: there was room.
    expect([skytree.h, tower.h]).toEqual([referenceHeight(horizonOf(empty)), Math.round(referenceHeight(horizonOf(empty)) / 2)]);
    // The FIRST one's tie too: a lone Skytree whose preferred place is the middle of the middle one of three
    // two-floor buildings (they hide its crown) has the gaps either side of it 98 px off — it takes the right.
    const three = city([2, 2, 2], false);
    const [mid] = [...three.city!.buildings].sort((p, q) => p.col - q.col).slice(1);
    const lone = placeLandmarks(three, horizonOf(three), [twins[0]]).placed[0];
    expect(Math.round(layoutOf(three).span[0] + 0.5 * (layoutOf(three).span[1] - layoutOf(three).span[0]))).toBe((mid.col + mid.w / 2) * TILE);
    expect(lone.x).toBe((mid.col + mid.w / 2) * TILE + 98);
    expect(landmarkCrown(lone).x0).toBe((mid.col + mid.w) * TILE);
  });

  it("with no clear spot at its size, a landmark is drawn smaller, a twentieth at a time, until one is — the typical city's Fuji in the gap left of the HQ", () => {
    // Fuji's crown reaches 95 px over the street at full size (134 px) and every building here is at least
    // 96 px tall, so only the 4-tile gaps are open sky: 64 px, narrower than its 82-px snow cap.
    const fuji = placed(typical, "fuji");
    const { span } = layoutOf(typical);
    const clearAt = (h: number) => {
      const out: number[] = [];
      for (let x = span[0]; x <= span[1]; x++) {
        const c = landmarkCrown({ ...fuji, x, h });
        if (c.x0 >= span[0] && c.x1 <= span[1] && hiders(typical, c).length === 0) out.push(x);
      }
      return out;
    };
    // Full size and 95 %, 90 %, 85 % of it: nowhere. 80 %: in the gap — and that is its size.
    for (const h of [134, 127, 121, 114]) expect(clearAt(h), `${h} px`).toEqual([]);
    expect(fuji.h).toBe(107);
    expect(clearAt(107)).toContain(fuji.x);
    expect(hiders(typical, landmarkCrown(fuji))).toEqual([]);
    // Still above the far skyline's haze: a crown sunk into it would be hidden just the same.
    expect(H - landmarkCrown(fuji).bottom).toBeGreaterThanOrEqual(skylineMax(H));
    // A twentieth at a time, not a tenth: two three-floor projects leave Fuji only a gap, and 55 % of its
    // 192 px is the largest size that fits there.
    const both = city([3, 3]);
    expect(placed(both, "fuji").h).toBe(Math.round(192 * 0.55));
    expect(hiders(both, landmarkCrown(placed(both, "fuji")))).toEqual([]);
    // The reference cities have room for all three at full size.
    for (const w of [referenceCity, real]) for (const p of crowned(w)) expect(p.h, p.spec.kind).toBe(fullOf(w, p.spec));
  });

  it("SIZE: Fuji gives way first; with no room even so, both towers are drawn smaller together — keeping 333/634 — and Fuji from its full size down again; a crown right at the haze's top still counts", () => {
    // The typical city's buildings under a 400-px sky (no City has one: a sky this tall comes with roofs this
    // much taller): at full size the towers' crowns have no spots together; at 70 % they do — both at that.
    const towers = landmarksFor("Asia/Tokyo").filter((x) => x.layer === "tower");
    const deep = placeLandmarks(typical, 400, landmarksFor("Asia/Tokyo"));
    const at = (kind: LandmarkKind) => deep.placed.find((p) => p.spec.kind === kind)!;
    const full = towerReference(400, 400 - Math.min(...typical.city!.buildings.map((b) => b.row * TILE)));
    expect(full).toBe(480);
    expect([at("skytree").h, at("tokyo-tower").h]).toEqual([Math.round(480 * 0.7), Math.round(Math.round((480 * 333) / 634) * 0.7)]);
    expect(at("tokyo-tower").h / at("skytree").h).toBeCloseTo(333 / 634, 2);
    for (const p of deep.placed.filter((q) => q.spec.layer !== "near")) {
      const c = landmarkCrown(p);
      expect(c.x0 >= deep.span[0] && c.x1 <= deep.span[1], p.spec.kind).toBe(true);
      for (const b of buildingsOf(typical)) expect(b.x0 < c.x1 && b.x1 > c.x0 && b.top < c.bottom, p.spec.kind).toBe(false);
    }
    // With the towers drawn smaller, Fuji is tried from its full size again: a Fuji of 0.3 of the sky stands at
    // 90 % beside them, not at the towers' 70 %.
    const low: LandmarkSpec = { kind: "fuji", layer: "far", height: 0.3, prefer: 0.3 };
    const both = placeLandmarks(typical, 400, [low, ...towers]).placed;
    expect(both.map((p) => p.h)).toEqual([Math.round(Math.round(0.3 * referenceHeight(400)) * 0.9), 336, 176]);
    // The haze's top is not in it: a lone Fuji in the typical city under a 464-px sky is drawn smaller until its
    // snow fits a gap — down to where the snow's foot is the haze's top row, which still shows.
    const lone = placeLandmarks(typical, 464, [{ kind: "fuji", layer: "far", height: 0.6, prefer: 0.5 }]).placed[0];
    expect(464 - landmarkCrown(lone).bottom).toBe(skylineMax(464));
    expect(lone.h).toBe(94);
    expect(landmarkCrown(lone).x0).toBeGreaterThanOrEqual(layoutOf(typical).span[0]);
  });

  it("never so small that its crown sinks into the haze: a street without the HQ and with no room stands it at full size just past its outer walls instead", () => {
    // Two projects, no HQ: the frame ends at their outer walls; the 4-tile gap between them holds the Tower;
    // the room left beside it would fit Fuji's snow cap only once its crown had sunk under the haze.
    const two = city([1, 2], false);
    const fuji = placed(two, "fuji");
    const c = landmarkCrown(fuji);
    const first = Math.min(...buildingsOf(two).map((b) => b.x0));
    expect(fuji.h).toBe(Math.round(referenceHeight(horizonOf(two)) * 0.6));
    expect(c.x1).toBeLessThanOrEqual(first);
    expect(c.x1).toBeGreaterThan(first - PAD);
    expect(hiders(two, c)).toEqual([]);
    // …and only Fuji: as few crowns past the walls as can be — the towers, which fit, stay in the frame at full size.
    const [s0, s1] = layoutOf(two).span;
    for (const k of ["tokyo-tower", "skytree"] as const) {
      const t = landmarkCrown(placed(two, k));
      expect(t.x0 >= s0 && t.x1 <= s1, k).toBe(true);
      expect(placed(two, k).h, k).toBe(fullOf(two, placed(two, k).spec));
    }
    // One building filling its whole frame: every crown past a wall, at full size, none hidden — and the
    // towers kept apart out there too: the Tower past its left wall, the Skytree past its right one.
    const one = city([3], false);
    const [b] = buildingsOf(one);
    for (const p of crowned(one)) {
      const k = landmarkCrown(p);
      expect(p.h, p.spec.kind).toBe(fullOf(one, p.spec));
      expect(k.x1 <= b.x0 || k.x0 >= b.x1, p.spec.kind).toBe(true);
      expect(hiders(one, k), p.spec.kind).toEqual([]);
    }
    expect(landmarkCrown(placed(one, "tokyo-tower")).x1).toBeLessThanOrEqual(b.x0);
    expect(landmarkCrown(placed(one, "skytree")).x0).toBeGreaterThanOrEqual(b.x1);
  });

  it("at Fit in every typical city and pane, each tower's decks and Fuji's snow are painted over the roofs in front of them, inside the view", () => {
    for (const [name, world] of TYPICAL) {
      const h0 = horizonOf(world);
      for (const [w, h, dpr] of PANES) {
        const { cam, view } = fitOf(world, w, h, dpr);
        const ctx = day(world, cam, sky(), view);
        const where = `${name} @ ${w}×${h}×${dpr}`;
        for (const [kind, part] of [
          ["tokyo-tower", new Set([TOKYO_TOWER.deck.glass])],
          ["skytree", new Set([SKYTREE.deck.glass])],
          ["fuji", new Set([FUJI.snow, FUJI.snowShade])],
        ] as const) {
          const p = placed(world, kind);
          // The painted silhouette: on screen, its top below the view's top; a tower's whole width inside the view.
          const [x0, y0, x1] = bbox(fills(ctx, PALETTE[kind]));
          expect(y0, `${where}: ${kind} top`).toBeGreaterThanOrEqual(0);
          if (kind !== "fuji" || name.startsWith("HQ")) {
            expect(Math.max(x0, 0) < Math.min(x1, view.w), `${where}: ${kind} on screen`).toBe(true);
          }
          if (kind !== "fuji") {
            expect(x0, `${where}: ${kind} left`).toBeGreaterThanOrEqual(0);
            expect(x1, `${where}: ${kind} right`).toBeLessThanOrEqual(view.w);
          }
          // Every pixel of the part is above the roof of whatever building stands in front of it (world px) —
          // for Fuji, its solid cap (the top fifth; the streaks down its ravines may run on behind a roof).
          for (const c of fills(ctx, part)) {
            const [sx, sy, sw, sh] = c.args as number[];
            const wx0 = (sx - Math.round(cam.ox)) / cam.zoom;
            const wx1 = (sx + sw - Math.round(cam.ox)) / cam.zoom;
            const lowest = h0 - (sy + sh - Math.round(cam.oy)) / cam.zoom;
            if (kind === "fuji" && (sy - Math.round(cam.oy)) / cam.zoom >= h0 - p.h + Math.round(0.2 * p.h)) continue;
            expect(lowest, `${where}: ${kind} over the roof`).toBeGreaterThanOrEqual(roofOver(world, wx0, wx1));
          }
        }
      }
    }
  });

  it("the span is what Fit frames, less its tile of air either side — with the HQ, centred on the HQ's middle, in a city built more on one side too", () => {
    for (const [name, world] of [...TYPICAL, ["the reference city", referenceCity] as [string, World]]) {
      const { span } = layoutOf(world);
      const v = new VillageView(1, () => null, "city");
      v.setWorld(world);
      const t = v.fitTarget();
      expect(span, name).toEqual([t.x + TILE, t.x + t.w - TILE]);
    }
    // One wide project right of the HQ (the Capacity HQ is the centre): the
    // span's middle is the HQ's — the world's too — not the middle of what is built.
    const wide = TYPICAL.find(([name]) => name.startsWith("HQ + 1 wide"))![1];
    const hq = wide.city!.buildings.find((b) => b.hq)!;
    const last = wide.city!.buildings.at(-1)!;
    const [s0, s1] = layoutOf(wide).span;
    expect((s0 + s1) / 2).toBe((hq.col + hq.w / 2) * TILE);
    expect((s0 + s1) / 2).toBe((wide.cols * TILE) / 2);
    expect((s0 + s1) / 2).toBeLessThan(((hq.col + last.col + last.w) * TILE) / 2 - 200);
  });

  it("the HQ alone: Fit frames the lounge under the street, wider than the HQ, so the street either side of the HQ is open sky — the Tower right of it (its preferred side), the pagoda left at its preferred place", () => {
    const [hq] = alone.city!.buildings;
    const { span } = layoutOf(alone);
    expect(span[0]).toBeLessThan(hq.col * TILE - 4 * TILE);
    expect(span[1]).toBeGreaterThan((hq.col + hq.w) * TILE + 4 * TILE);
    for (const p of crowned(alone)) expect(roofOver(alone, landmarkCrown(p).x0, landmarkCrown(p).x1), p.spec.kind).toBe(0);
    expect(landmarkCrown(placed(alone, "tokyo-tower")).x0).toBeGreaterThanOrEqual((hq.col + hq.w) * TILE);
    const pagoda = placed(alone, "pagoda");
    expect(pagoda.x).toBe(Math.round(span[0] + 0.1 * (span[1] - span[0])));
    expect(pagoda.x + pagoda.hw).toBeLessThan(hq.col * TILE);
  });

  it("with more built on one side of the HQ, the skyline takes the open sky over the empty street Fit frames on the other — and the HQ stands between the towers", () => {
    // The HQ and one project right of it: the street left of the HQ is empty, and framed (the HQ is centred).
    const one = city([1]);
    const hq = one.city!.buildings.find((b) => b.hq)!;
    const project = one.city!.buildings.at(-1)!;
    expect(project.hq).toBeUndefined();
    const left = layoutOf(one).placed.filter((p) => p.x < hq.col * TILE);
    // Fuji, the pagoda and the Tower by the HQ's left wall, in the open; the Skytree right of the HQ, on its
    // preferred place over the one-floor project — lower than its crown's bottom (its Tembo Deck).
    expect(left.map((p) => p.spec.kind).sort()).toEqual(["fuji", "pagoda", "tokyo-tower"]);
    for (const p of left) expect(roofOver(one, landmarkCrown(p).x0, landmarkCrown(p).x1), p.spec.kind).toBe(0);
    const skytree = placed(one, "skytree");
    const { span } = layoutOf(one);
    expect(skytree.x).toBe(Math.round(span[0] + 0.82 * (span[1] - span[0])));
    expect(landmarkCrown(skytree).x0).toBeGreaterThan(project.col * TILE);
    expect(towersApart(one)).toBe(2);
    // The composition's order, left to right.
    expect(inversions(spotsNow(one))).toBe(0);
  });

  it("is deterministic and cached per world (the same layout object every frame)", () => {
    const specs = landmarksFor("Asia/Tokyo");
    const a = placeLandmarks(typical, H, specs);
    expect(placeLandmarks(typical, H, specs)).toBe(a);
    const twin = city([1, 2]);
    expect(placeLandmarks(twin, H, specs)).not.toBe(a);
    expect(placeLandmarks(twin, H, specs)).toEqual(a);
    expect(placeLandmarks(typical, H + TILE, specs)).not.toEqual(a);
  });

  it("an empty street (no building at all) stands each at its preferred place: Fuji left, the Tower middle, the Skytree right, the pagoda far left, the shrine by the Tower", () => {
    const empty = buildCityWorld([]);
    const { placed: all, span } = layoutOf(empty);
    expect(span).toEqual([0, empty.cols * TILE]);
    const xs = Object.fromEntries(all.map((p) => [p.spec.kind, p.x / (empty.cols * TILE)]));
    expect(xs).toEqual({
      fuji: 0.3,
      "tokyo-tower": expect.closeTo(0.58, 2),
      skytree: expect.closeTo(0.82, 2),
      pagoda: expect.closeTo(0.1, 2),
      shrine: expect.closeTo(0.62, 2),
    });
  });
});

// ───────────────────────────── world-locked, zoom, culling ─────────────────────────────

describe("world-locked, zoom and culling", () => {
  /** A view wide enough that nothing of the typical city's landmarks is culled at zoom 3. */
  const BIG = { w: 4000, h: 3 * (H + 200) };
  /** Every landmark of every layer, painted. */
  function all(cam: Camera, view = BIG): RecordingTarget {
    const ctx = recorder();
    paintFarLandmarks(ctx, cam, typical, view, sky(), H);
    paintLandmarks(ctx, cam, typical, view, sky(), H, 0);
    paintNearLandmarks(ctx, cam, typical, view, sky(), H, 0);
    return ctx;
  }

  it("every landmark scrolls and zooms WITH the street (the backdrop must never slide behind the city): each rect painted is its zoom-1 world rect through the camera, panned or zoomed to 2 and 3", () => {
    const base: Camera = { zoom: 1, ox: 200, oy: 100 };
    const rects = all(base).of("fillRect");
    expect(rects.length).toBeGreaterThan(500);
    const worldRects = rects.map((c) => {
      const [x, y, w, h] = c.args as number[];
      return [x - base.ox, y - base.oy, w, h, c.fillStyle] as const;
    });
    // (Every camera keeps all of it in the view: culling is not what this is about.)
    for (const cam of [
      { zoom: 1, ox: 200 + 340, oy: 100 },
      { zoom: 1, ox: 83, oy: 160 },
      { zoom: 2, ox: 300, oy: 120 },
      { zoom: 3, ox: 50, oy: 90 },
    ]) {
      const sx = (wx: number) => Math.round(cam.ox) + Math.floor(wx * cam.zoom);
      const sy = (wy: number) => Math.round(cam.oy) + Math.floor(wy * cam.zoom);
      const want = worldRects.map(([x, y, w, h, c]) => [sx(x), sy(y), sx(x + w) - sx(x), sy(y + h) - sy(y), c]);
      const got = all(cam).of("fillRect").map((c) => [...(c.args as number[]), c.fillStyle]);
      expect(got, JSON.stringify(cam)).toEqual(want);
    }
  });

  it("at ½ the silhouettes are all still there — even the 1-px antennas — without the X-bracing, in fewer rects", () => {
    const one = day(typical, centred(typical, 1));
    const half = day(typical, centred(typical, 0.5));
    for (const k of ["fuji", "tokyo-tower", "skytree"] as const) {
      expect(fills(half, PALETTE[k]).length, k).toBeGreaterThan(10);
      expect(fills(half, PALETTE[k]).length, k).toBeLessThan(fills(one, PALETTE[k]).length);
    }
    for (const c of half.of("fillRect")) {
      const [, , w, h] = c.args as number[];
      expect(w).toBeGreaterThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(1);
    }
    const lattice = new Set([TOKYO_TOWER.lattice, SKYTREE.lattice, FUJI.ridge]);
    expect(fills(one, lattice).length).toBeGreaterThan(20);
    expect(fills(half, lattice)).toHaveLength(0);
    // The antennas reach their full height at ½ too (the top row is drawn).
    const top = (k: keyof typeof PALETTE, ctx: RecordingTarget) => bbox(fills(ctx, PALETTE[k]))[1];
    const cam = centred(typical, 0.5);
    expect(top("skytree", half)).toBe(cam.oy + Math.floor((H - placed(typical, "skytree").h) * 0.5));
  });

  it("stays cheap: under 1,800 rects for all three at zoom 1 (rows of equal width merged; ~0.45 ms a frame in Chromium)", () => {
    expect(day().of("fillRect").length).toBeLessThan(1800);
    expect(day(alone, centred(alone)).of("fillRect").length).toBeLessThan(1800);
  });

  it("culls: nothing off screen is painted, and a view of only the towers' feet paints only their feet", () => {
    const cam = centred(alone);
    // Panned far past the city: they go with it, off screen.
    expect(day(alone, { ...cam, ox: cam.ox + 50_000 }).calls).toHaveLength(0);
    expect(day(alone, { ...cam, ox: cam.ox - 50_000 }).calls).toHaveLength(0);
    // The view shows only the far skyline's band above the horizon (where only the towers' and Fuji's
    // feet are): no rect starts above the view.
    const low = { ...cam, oy: -(H - skylineMax(H)) };
    const ctx = day(alone, low, sky(), { w: VIEW.w, h: 200 });
    const rows = ctx.of("fillRect").map((c) => (c.args as number[])[1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(-2);
    expect(ctx.of("fillRect").length).toBeLessThan(day(alone, cam).of("fillRect").length / 3);
  });

  it("is deterministic: the same frame twice is the same calls", () => {
    expect(day().calls).toEqual(day().calls);
    expect(night("night", 300).calls).toEqual(night("night", 300).calls);
  });
});

// ───────────────────────────── weather ─────────────────────────────

describe("weather — far things fade first, never to nothing", () => {
  it("Fuji is a ghost in rain and fog, the towers only dim; clear is fully there", () => {
    const alpha = (weather: WeatherKind, set: Set<string>) => fills(day(typical, centred(typical), sky("noon", weather)), set)[0].alpha;
    const towers = PALETTE.skytree;
    expect(alpha("clear", FUJI_COLOURS)).toBe(1);
    expect(alpha("clear", towers)).toBe(1);
    for (const w of ["rain", "fog", "storm"] as const) {
      expect(alpha(w, FUJI_COLOURS), w).toBeLessThan(0.25);
      expect(alpha(w, FUJI_COLOURS), w).toBeGreaterThan(0);
      expect(alpha(w, towers), w).toBeGreaterThanOrEqual(0.5);
      expect(alpha(w, towers), w).toBeLessThan(1);
    }
    // And the alpha is put back for whatever paints next.
    const ctx = day(typical, centred(typical), sky("noon", "rain"));
    expect(ctx.globalAlpha).toBe(1);
  });
});

// ───────────────────────────── night ─────────────────────────────

describe("paintLandmarkLights", () => {
  const LIT = new Set([...colours(TOKYO_TOWER_LIT), ...colours(SKYTREE_LIT)]);

  it("lights nothing by day — dawn, morning, noon, afternoon — and the towers in the evening, at dusk and at night, brighter as it gets dark", () => {
    for (const phase of ["dawn", "morning", "noon", "afternoon"] as const) expect(night(phase, 0).calls, phase).toHaveLength(0);
    const alphaOf = (phase: DayPhase) => fills(night(phase, 0), new Set([TOKYO_TOWER_LIT.bands.orange.light]))[0].alpha;
    expect(alphaOf("evening")).toBeLessThan(alphaOf("dusk"));
    expect(alphaOf("dusk")).toBeLessThan(alphaOf("night"));
    expect(alphaOf("night")).toBe(1);
    for (const phase of ["evening", "dusk", "night"] as const) {
      const ctx = night(phase, 0);
      expect(fills(ctx, colours(TOKYO_TOWER_LIT)).length, phase).toBeGreaterThan(30);
      expect(fills(ctx, colours(SKYTREE_LIT)).length, phase).toBeGreaterThan(30);
      // Never Fuji: it has no lights (the grade leaves it a dark silhouette).
      expect(fills(ctx, FUJI_COLOURS), phase).toHaveLength(0);
      expect(ctx.globalAlpha).toBe(1);
    }
  });

  it("the Tower glows warm orange (Landmark Light), the Skytree pale blue (Iki) with a purple (Miyabi) mast", () => {
    const used = new Set(night("night", 0).of("fillRect").map((c) => c.fillStyle));
    for (const c of [TOKYO_TOWER_LIT.bands.orange.light, TOKYO_TOWER_LIT.lattice, SKYTREE_LIT.bands.body.light, SKYTREE_LIT.bands.mast.light, SKYTREE_LIT.deck.glass])
      expect(used).toContain(c);
  });

  it("lights nothing below the top of the far skyline's haze, where it, the trees and the lamps stand in front — a haze that grows with the city", () => {
    // The typical city's low haze (48 px) and the reference seven-floor city's (144 px: render/skyline.ts).
    for (const w of [typical, referenceCity]) {
      const h0 = horizonOf(w);
      const view = { w: w.cols * TILE + 400, h: h0 + 200 };
      const cam = centred(w, 1, view);
      const lit = fills(night("night", 0, w, cam, "clear", view), LIT);
      expect(lit.length).toBeGreaterThan(30);
      const lowest = Math.max(...lit.map((c) => (c.args as number[])[1] + (c.args as number[])[3]));
      // Right down to it, and not a pixel lower.
      expect(lowest, `${h0}`).toBe(cam.oy + h0 - skylineMax(h0));
    }
    expect(skylineMax(horizonOf(referenceCity))).toBeGreaterThan(SKYLINE_BASE);
  });

  it("blinks the red aviation lights on both tips every 1.5 s — the Skytree's mast light in antiphase", () => {
    const cores = (t: number) => fills(night("night", t), new Set([AVIATION.core])).map((c) => (c.args as number[])[1]);
    const cam = centred(typical);
    const skytreeTip = cam.oy + H - placed(typical, "skytree").h - 1;
    const towerTip = cam.oy + H - placed(typical, "tokyo-tower").h - 1;
    expect(cores(0).sort((a, b) => a - b)).toEqual([skytreeTip, towerTip].sort((a, b) => a - b));
    expect(cores(BLINK_MS / 2)).toHaveLength(1); // only the Skytree's mast light
    expect(cores(BLINK_MS / 2)[0]).toBeGreaterThan(skytreeTip);
    expect(cores(BLINK_MS)).toEqual(cores(0));
    expect(aviationOn(0, 0)).toBe(true);
    expect(aviationOn(BLINK_MS / 2 - 1, 0)).toBe(true);
    expect(aviationOn(BLINK_MS / 2, 0)).toBe(false);
    expect(aviationOn(-1, 0)).toBe(false);
    // In the rain they still show (dimmed, not gone).
    const wet = fills(night("night", 0, typical, cam, "rain"), new Set([AVIATION.core]));
    expect(wet.length).toBe(2);
    expect(wet[0].alpha).toBeGreaterThanOrEqual(0.6);
  });

  it("is culled like the day pass: nothing when the towers are off screen", () => {
    const cam = centred(typical);
    expect(night("night", 0, typical, { ...cam, ox: cam.ox + 50_000 }).calls).toHaveLength(0);
  });
});

describe("landmarkMask — so the night sky's stars stay behind them", () => {
  it("is true on a landmark and false in the open sky beside it", () => {
    const cam = centred(typical);
    const mask = landmarkMask(cam, typical, VIEW, sky("night"), H)!;
    // (The temples, and the shrine standing in front of the Tower's foot, have a test of their own.)
    for (const p of crowned(typical)) {
      expect(mask(p.x, H - p.h / 2), `${p.spec.kind} body`).toBe(true);
      expect(mask(p.x, H - p.h - 4), `${p.spec.kind} above its tip`).toBe(false);
      expect(mask(p.x, H + 4), `${p.spec.kind} below the horizon`).toBe(false);
    }
    const skytree = placed(typical, "skytree");
    expect(mask(skytree.x + 40, H - skytree.h * 0.9)).toBe(false);
  });
});

describe("landmarkRow — the mask of Fuji and the towers as one run of columns a row", () => {
  it("covers exactly the pixels the mask does, row by row, and nothing above a tip or below the horizon", () => {
    const cam = centred(typical);
    const mask = landmarkMask(cam, typical, VIEW, sky("night"), H, ["far", "tower"])!;
    const list = crowned(typical);
    expect(list.map((p) => p.spec.kind).sort()).toEqual(["fuji", "skytree", "tokyo-tower"]);
    const x0 = Math.min(...list.map((p) => p.x - p.hw)) - 3;
    const x1 = Math.max(...list.map((p) => p.x + p.hw)) + 3;
    const top = Math.min(...list.map((p) => H - p.h)) - 3;
    for (let y = top; y <= H + 2; y++) {
      const rows = list.map((p) => landmarkRow(p, H, y));
      for (let x = x0; x < x1; x++) expect(rows.some((r) => r !== null && x >= r[0] && x < r[1]), `(${x}, ${y})`).toBe(mask(x, y));
    }
    for (const p of list) {
      expect(landmarkRow(p, H, H - p.h - 1)).toBeNull();
      expect(landmarkRow(p, H, H)).toBeNull();
      expect(landmarkRow(p, H, H - p.h)).not.toBeNull();
    }
  });
});

// ───────────────────────────── the temples ─────────────────────────────

describe("the temples — a five-storey pagoda and a shrine hall, nearer than the far skyline", () => {
  const DAY = new Set<string>(Object.values(TEMPLE));
  const NIGHT = new Set<string>(Object.values(TEMPLE_LIT));
  /** The far skyline's tallest block in a low city (render/skyline.ts): what the temples are sized against. */
  const SKYLINE = 3 * TILE;
  /** A street gap between two buildings (engine/city.ts GAP: 4 tiles), less 2 px a side. */
  const GAP_FIT = 4 * TILE - 4;

  const syOf = (cam: Camera, wy: number) => Math.round(cam.oy) + Math.floor(Math.round(wy) * cam.zoom);

  function near(world = typical, cam = centred(world), amb: Ambience | undefined = sky(), view = VIEW): RecordingTarget {
    const ctx = recorder();
    paintNearLandmarks(ctx, cam, world, view, amb, horizonOf(world), 0);
    return ctx;
  }
  function lights(phase: DayPhase, world = typical, cam = centred(world), weather: WeatherKind = "clear", view = VIEW): RecordingTarget {
    const ctx = recorder();
    paintLandmarkLights(ctx, cam, world, view, sky(phase, weather), horizonOf(world), 0);
    return ctx;
  }
  /** The fillRects of `calls` nearest to `p` of the two temples (they never overlap). */
  function own(calls: DrawCall[], cam: Camera, world: World, p: PlacedLandmark): DrawCall[] {
    const others = layoutOf(world).placed.filter((q) => q.spec.layer === "near" && q !== p);
    const mid = (c: DrawCall) => {
      const [x, , w] = c.args as number[];
      return (x + w / 2 - Math.round(cam.ox)) / cam.zoom;
    };
    return calls.filter((c) => others.every((q) => Math.abs(mid(c) - p.x) < Math.abs(mid(c) - q.x)));
  }
  /** Zoom-1 rects as world pixels: y → (x → colour), later rects painting over earlier ones. */
  function pixels(calls: DrawCall[], cam: Camera): Map<number, Map<number, string>> {
    const rows = new Map<number, Map<number, string>>();
    for (const c of calls) {
      const [x, y, w, h] = c.args as number[];
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          const wy = yy - Math.round(cam.oy);
          if (!rows.has(wy)) rows.set(wy, new Map());
          rows.get(wy)!.set(xx - Math.round(cam.ox), c.fillStyle);
        }
    }
    return rows;
  }
  const width = (row: Map<number, string>) => Math.max(...row.keys()) - Math.min(...row.keys()) + 1;
  const count = (row: Map<number, string>, colour: string) => [...row.values()].filter((c) => c === colour).length;
  const has = (row: Map<number, string>, ...colours: string[]) => [...row.values()].some((c) => colours.includes(c));

  it("their colours are their own: no tower's, no Fuji's", () => {
    for (const set of [FUJI_COLOURS, PALETTE["tokyo-tower"], PALETTE.skytree, colours(TOKYO_TOWER_LIT), colours(SKYTREE_LIT)])
      for (const c of [...DAY, ...NIGHT]) expect(set.has(c), c).toBe(false);
  });

  it("the pagoda: five roofs with upturned tips over vermilion-and-cream storeys, narrowing upward, under a black spire with nine rings and a gold jewel", () => {
    const cam = centred(typical);
    const p = placed(typical, "pagoda");
    const px = pixels(own(near(typical, cam).of("fillRect"), cam, typical, p), cam);
    const top = H - p.h;
    // Solid from its foot to its tip, every row symmetric about its centre.
    for (let y = top; y < H; y++) {
      const xs = [...px.get(y)!.keys()];
      expect(Math.min(...xs) + Math.max(...xs) + 1, `row ${y}`).toBe(2 * p.x);
    }
    expect(px.has(top - 1) || px.has(H)).toBe(false);
    // Each roof starts on a row of dark eave: five of them.
    const rows = Array.from({ length: p.h }, (_, i) => top + i);
    const eaves = rows.filter((y) => count(px.get(y)!, TEMPLE.eave) >= 10).reverse(); // bottom roof first
    expect(eaves).toHaveLength(5);
    const roofW = eaves.map((y) => Math.max(...[1, 2, 3].map((k) => width(px.get(y - k)!))));
    eaves.forEach((y, i) => {
      // The eave's ends turn up: its lowest row (dark, a bell either side) is narrower than the tips two rows above it.
      expect(count(px.get(y)!, TEMPLE.eave), `roof ${i} upturned`).toBeLessThan(width(px.get(y - 2)!) - 4);
      // The roof overhangs the storey under it by far (the wall two rows below its eave).
      const wall = px.get(y + 2)!;
      expect(has(wall, TEMPLE.vermilion) && has(wall, TEMPLE.cream), `storey ${i} vermilion and cream`).toBe(true);
      expect(roofW[i], `roof ${i} over its storey`).toBeGreaterThanOrEqual(1.6 * width(wall));
      // …and each roof is narrower than the one below it.
      if (i > 0) expect(roofW[i], `roof ${i} narrower`).toBeLessThan(roofW[i - 1]);
    });
    expect(roofW[0]).toBe(2 * Math.round(0.17 * p.h));
    // The spire: everything above the top roof, a quarter of the height, black with nine rings, a gold jewel on top.
    const spire = rows.filter((y) => [...px.get(y)!.values()].every((c) => ([TEMPLE.spire, TEMPLE.ring, TEMPLE.gold] as string[]).includes(c)));
    expect(spire[0]).toBe(top);
    expect(spire.length).toBeGreaterThanOrEqual(0.25 * p.h);
    spire.forEach((y, i) => expect(y, "one run of rows").toBe(top + i));
    for (const y of spire) expect(width(px.get(y)!)).toBeLessThanOrEqual(6);
    expect([...px.get(top)!.values()]).toEqual([TEMPLE.gold, TEMPLE.gold]);
    const rings = spire.filter((y) => count(px.get(y)!, TEMPLE.ring) === 4);
    expect(rings).toHaveLength(9);
    // A gold bell under every tip: two per roof.
    expect(rows.reduce((n, y) => n + count(px.get(y)!, TEMPLE.gold), 0)).toBe(2 * 5 + 2);
  });

  it("the shrine: a hall on a stepped stone terrace, wider than tall — the dark roof the widest of it, upturned, gold on its ridge; vermilion pillars, white walls, a lattice door under the shimenawa and its shide; a stone lantern either side", () => {
    const cam = centred(typical);
    const p = placed(typical, "shrine");
    const px = pixels(own(near(typical, cam).of("fillRect"), cam, typical, p), cam);
    const top = H - p.h;
    const rows = Array.from({ length: p.h }, (_, i) => top + i);
    for (const y of rows) {
      const xs = [...px.get(y)!.keys()];
      expect(Math.min(...xs) + Math.max(...xs) + 1, `row ${y}`).toBe(2 * p.x);
    }
    const widest = Math.max(...rows.map((y) => width(px.get(y)!)));
    expect(widest / p.h, "wider than tall").toBeGreaterThanOrEqual(1.2);
    // The widest rows are the roof's.
    const roofs = rows.filter((y) => width(px.get(y)!) === widest);
    for (const y of roofs) expect(has(px.get(y)!, TEMPLE.roof)).toBe(true);
    // Its eave's ends turn up: the eave row (all dark) is narrower than the widest row above it.
    const eave = rows.find((y) => count(px.get(y)!, TEMPLE.eave) >= 20 && y > roofs[0])!;
    expect(width(px.get(eave)!)).toBeLessThan(widest);
    // Gold on the ridge: its top row is gold at both ends and in the middle.
    const ridge = [...px.get(top)!.entries()].filter(([, c]) => c === TEMPLE.gold || c === TEMPLE.goldShade).map(([x]) => x - p.x);
    expect(Math.min(...ridge)).toBeLessThan(-8);
    expect(Math.max(...ridge)).toBeGreaterThan(7);
    expect(ridge).toContain(-1);
    expect(ridge).toContain(0);
    // The hall under the eave: vermilion pillars (four runs of it in a row), white walls, the door bay in the middle.
    const hall = rows.filter((y) => y > eave && has(px.get(y)!, TEMPLE.cream));
    expect(hall.length).toBeGreaterThanOrEqual(5);
    const wall = px.get(hall[hall.length - 1])!;
    const xs = [...wall.keys()].sort((a, b) => a - b);
    const red = (x: number) => ([TEMPLE.vermilion, TEMPLE.vermilionShade] as string[]).includes(wall.get(x) ?? "");
    const pillars = xs.filter((x) => red(x) && !red(x - 1));
    expect(pillars).toHaveLength(4);
    expect([TEMPLE.door, TEMPLE.lattice] as string[]).toContain(wall.get(p.x));
    // The shimenawa right under the head beam, the white shide hanging from it.
    const beam = eave + 1;
    expect(count(px.get(beam)!, TEMPLE.vermilion)).toBeGreaterThan(10);
    const rope = [beam + 1, beam + 2, beam + 3].filter((y) => count(px.get(y)!, TEMPLE.rope) + count(px.get(y)!, TEMPLE.ropeShade) >= 10);
    expect(rope.length).toBeGreaterThanOrEqual(2);
    const shide = rows.filter((y) => count(px.get(y)!, TEMPLE.shide) > 0);
    expect(shide.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...shide)).toBeGreaterThan(Math.min(...rope));
    // A stone lantern either side: their fire boxes mirror each other about the centre.
    const fires = rows.flatMap((y) => [...px.get(y)!.entries()].filter(([, c]) => c === TEMPLE.fireBox).map(([x]) => x - p.x));
    expect(fires.length).toBe(8);
    expect(new Set(fires.map((x) => (x < 0 ? -1 - x : x)))).toEqual(new Set(fires.filter((x) => x >= 0)));
    // The terrace: the bottom third all stone, with steps up the middle — tread and riser.
    const terrace = rows.filter((y) => y > H - p.h / 3);
    const STONE: string[] = [TEMPLE.stone, TEMPLE.stoneShade, TEMPLE.stoneTop, TEMPLE.riser];
    for (const y of terrace) expect([...px.get(y)!.values()].every((c) => STONE.includes(c)), `terrace row ${y}`).toBe(true);
    const steps = terrace.map((y) => px.get(y)!.get(p.x));
    expect(steps.filter((c, i) => i > 0 && c !== steps[i - 1]).length).toBe(terrace.length - 1);
  });

  it("paintNearLandmarks paints the temples alone, in their colours, and puts the alpha back — the other passes paint none of them", () => {
    const ctx = near();
    expect(ctx.of("fillRect").length).toBeGreaterThan(80);
    expect(fills(ctx, DAY).length).toBe(ctx.calls.length);
    expect(ctx.globalAlpha).toBe(1);
    for (const kind of ["pagoda", "shrine"] as const) expect(own(ctx.of("fillRect"), centred(typical), typical, placed(typical, kind)).length, kind).toBeGreaterThan(40);
    expect(fills(day(), DAY)).toHaveLength(0);
    expect(fills(night("night", 0), DAY)).toHaveLength(0);
  });

  it("size: the pagoda 0.3 of the sky, never under twice the far skyline's low-city height, always under the Tower; the shrine that height in every city; both fit a street gap in the tallest city", () => {
    expect(SKYLINE_BASE).toBe(SKYLINE);
    // The shortest sky (the typical city, the HQ alone, the empty street): 0.3 of it would be 67 px
    // — five storeys of ~9 px, four rings on the spire — so the pagoda is held at twice the skyline.
    for (const world of [typical, city([]), buildCityWorld([])]) {
      expect(horizonOf(world)).toBe(240);
      expect(Math.round(0.3 * referenceHeight(horizonOf(world)))).toBe(67);
      expect(placed(world, "pagoda").h).toBe(2 * SKYLINE);
      expect(placed(world, "shrine").h).toBe(SKYLINE);
      expect(placed(world, "pagoda").h).toBeLessThan(placed(world, "tokyo-tower").h);
    }
    // A taller sky (a four-floor building): 0.3 of it, over the floor — under half the Tower, which stands
    // on 1.5× the roof rather than on the sky.
    const four = city([1, 4]);
    const ref = referenceHeight(horizonOf(four));
    expect(placed(four, "pagoda").h).toBe(Math.round(0.3 * ref));
    expect(placed(four, "pagoda").h).toBeGreaterThan(2 * SKYLINE);
    expect(placed(four, "pagoda").h / placed(four, "tokyo-tower").h).toBeGreaterThan(0.4);
    expect(placed(four, "pagoda").h / placed(four, "tokyo-tower").h).toBeLessThan(0.5);
    expect(placed(four, "shrine").h).toBe(SKYLINE);
    // A city with a seven-floor building: both capped to fit between two buildings.
    const tall = city([7, 1]);
    for (const kind of ["pagoda", "shrine"] as const) {
      const p = placed(tall, kind);
      expect(p.h, kind).toBe(kind === "pagoda" ? 176 : 48);
      expect(2 * templeArt(kind, p.h, true).hw, kind).toBeLessThanOrEqual(GAP_FIT);
      expect(placed(tall, kind).h, kind).toBeLessThan(Math.round((kind === "pagoda" ? 0.3 : 0.15) * referenceHeight(horizonOf(tall))));
    }
    // However tall the far skyline grows (render/skyline.ts): the temples stay their size.
    expect(skylineMax(horizonOf(tall))).toBeGreaterThan(SKYLINE);
    expect(placed(tall, "shrine").h).toBe(SKYLINE);
  });

  it("at Fit in every typical city and pane each temple is seen whole — on screen, no building in front of it — and never over a tower's body above the far skyline", () => {
    for (const [name, world] of TYPICAL) {
      const h0 = horizonOf(world);
      for (const [w, h, dpr] of PANES) {
        const { cam, view } = fitOf(world, w, h, dpr);
        const where = `${name} @ ${w}×${h}×${dpr}`;
        const temples = near(world, cam, sky(), view).of("fillRect");
        const towers = recorder();
        paintLandmarks(towers, cam, world, view, sky(), h0, 0);
        const haze = syOf(cam, h0 - skylineMax(h0));
        const above = (c: DrawCall) => {
          const [x, y, rw, rh] = c.args as number[];
          return [x, y, x + rw, Math.min(y + rh, haze)];
        };
        const towerRects = fills(towers, new Set([...PALETTE["tokyo-tower"], ...PALETTE.skytree])).map(above).filter(([, y0, , y1]) => y1 > y0);
        for (const kind of ["pagoda", "shrine"] as const) {
          const p = placed(world, kind);
          const art = templeArt(kind, p.h, cam.zoom >= 1);
          const x = p.x;
          expect(roofOver(world, x - art.hw, x + art.hw), `${where}: a building in front of the ${kind}`).toBe(0);
          const mine = own(temples, cam, world, p);
          const [x0, y0, x1, y1] = bbox(mine);
          expect((Math.min(x1, view.w) - Math.max(x0, 0)) / (x1 - x0), `${where}: ${kind} on screen`).toBeGreaterThanOrEqual(0.9);
          expect(y0, `${where}: ${kind} top`).toBeGreaterThanOrEqual(0);
          expect(y1, `${where}: ${kind} foot`).toBeLessThanOrEqual(view.h);
          const across = towerRects.filter(([c0, , c1]) => c0 < x1 && x0 < c1);
          const overlaps = mine
            .map(above)
            .filter(([, ya, , yb]) => yb > ya)
            .filter(([a0, b0, a1, b1]) => across.some(([c0, d0, c1, d1]) => a0 < c1 && c0 < a1 && b0 < d1 && d0 < b1));
          expect(overlaps, `${where}: the ${kind} over a tower above the skyline`).toEqual([]);
        }
      }
    }
  });

  it("the pagoda takes a gap no tower stands in — in front of Fuji, the classic picture of it — or the open street, or hugs an outer wall; the low shrine stands in front of the Tower's foot, like Zōjō-ji's hall", () => {
    const gapMid = (w: World, k: number) => {
      const b = [...w.city!.buildings].sort((p, q) => p.col - q.col);
      return ((b[k].col + b[k].w) * TILE + b[k + 1].col * TILE) / 2;
    };
    // The typical city (as much built either side): the HQ stands between the towers — the Tower in the gap
    // left of it, the Skytree over the one-floor project right of it — so Fuji, drawn smaller to fit, takes
    // the gap right of the HQ, and the pagoda stands in that gap too, in front of Fuji.
    const hqAt = [...typical.city!.buildings].sort((p, q) => p.col - q.col).findIndex((q) => q.hq);
    expect(placed(typical, "pagoda").x).toBe(gapMid(typical, hqAt));
    expect(placed(typical, "fuji").x).toBe(gapMid(typical, hqAt));
    const row = [...typical.city!.buildings].sort((p, q) => p.col - q.col);
    expect(landmarkCrown(placed(typical, "tokyo-tower")).x0).toBeGreaterThanOrEqual((row[hqAt - 1].col + row[hqAt - 1].w) * TILE);
    expect(landmarkCrown(placed(typical, "tokyo-tower")).x1).toBeLessThanOrEqual(row[hqAt].col * TILE);
    expect(landmarkCrown(placed(typical, "skytree")).x0).toBeGreaterThan(row[hqAt + 1].col * TILE);
    const [shrine, towerT] = [placed(typical, "shrine"), placed(typical, "tokyo-tower")];
    expect(Math.abs(shrine.x - towerT.x)).toBeLessThan(shrine.hw + towerT.hw);
    // HQ + 3 (1, 3, 2 floors) — one left of it, two right: the empty street left of the left one is
    // framed, so the pagoda stands there in the open, at its preferred place (a tenth of the way across
    // the frame, which reaches as far left of the HQ's middle as the last building does right of it).
    const four = city([1, 3, 2]);
    const hq = four.city!.buildings.find((q) => q.hq)!;
    const mid = (hq.col + hq.w / 2) * TILE;
    const half = Math.max(...four.city!.buildings.map((q) => (q.col + q.w) * TILE)) - mid;
    const p = placed(four, "pagoda");
    expect(p.x).toBe(Math.round(mid - half + 0.1 * 2 * half));
    expect(p.x + p.hw).toBeLessThan(Math.min(...four.city!.buildings.map((q) => q.col)) * TILE);
    // HQ + 2 three-floor projects: the Tower in the gap right of the HQ, the Skytree over the HQ (its crown
    // clears the HQ's roof — they shared that gap while the Skytree was the sky less a tile), and the low
    // shrine stands at the Tower's foot.
    const both = city([3, 3]);
    const tower = placed(both, "tokyo-tower");
    const skytree = placed(both, "skytree");
    const gap = [...both.city!.buildings].sort((a, b) => a.col - b.col);
    expect(landmarkCrown(tower).x0).toBeGreaterThanOrEqual((gap[1].col + gap[1].w) * TILE);
    expect(landmarkCrown(tower).x1).toBeLessThanOrEqual(gap[2].col * TILE);
    expect(landmarkCrown(skytree).x0).toBeGreaterThanOrEqual(gap[1].col * TILE);
    expect(landmarkCrown(skytree).x1).toBeLessThanOrEqual((gap[1].col + gap[1].w) * TILE);
    expect(Math.abs(placed(both, "shrine").x - tower.x)).toBeLessThan(tower.hw);
    // Three one-floor projects with the HQ, the widest left of it: the pagoda hugs the left outer wall —
    // the open street there is in the frame, and nearer its preferred place than any gap.
    const hug = buildCityWorld([plan(0, 1), plan(1, 1, 8), plan(2, 1)], { seats: 6 });
    const pagoda = placed(hug, "pagoda");
    const first = Math.min(...hug.city!.buildings.map((q) => q.col)) * TILE;
    expect(pagoda.x).toBe(first - templeArt("pagoda", pagoda.h, true).hw - 2);
    // The haze grows with the city (render/skyline.ts), and only a tower's body ABOVE it must stay clear:
    // in the HQ + 12 and 5 floors, the pagoda takes the gap left of the HQ though it stands within PAD of the
    // Skytree's foot — a body the 154-px haze hides, far wider than the tower above it.
    const tall = buildCityWorld([plan(0, 12), plan(1, 5)], { seats: 64 });
    expect(skylineMax(horizonOf(tall))).toBe(154);
    const tallHq = [...tall.city!.buildings].sort((a, b) => a.col - b.col).findIndex((q) => q.hq);
    const [tallPagoda, tallSkytree] = [placed(tall, "pagoda"), placed(tall, "skytree")];
    expect(tallPagoda.x).toBe(gapMid(tall, tallHq - 1));
    expect(Math.abs(tallPagoda.x - tallSkytree.x)).toBeLessThan(tallPagoda.hw + tallSkytree.hw + PAD);
    // So tall a city that the haze tops the pagoda itself (eleven floors of 26: a 221-px haze): it may
    // then stand in front of a tower's foot, like the shrine — here the Tower's, in the open street left.
    const taller = buildCityWorld([plan(0, 11, 26)], { seats: 64 });
    const [pg, tt] = [placed(taller, "pagoda"), placed(taller, "tokyo-tower")];
    expect(pg.h).toBeLessThanOrEqual(skylineMax(horizonOf(taller)));
    expect(Math.abs(pg.x - tt.x)).toBeLessThan(tt.hw);
    // The temples never overlap each other, in any typical city — nor beside a nine-floor building with no
    // HQ, where the shrine's preferred place is the pagoda's.
    const nine = buildCityWorld([plan(0, 9, 26), plan(1, 1)]);
    for (const [name, world] of [...TYPICAL, ["9 + 1 floors, no HQ", nine] as [string, World]]) {
      const [a, b] = (["pagoda", "shrine"] as const).map((k) => placed(world, k));
      expect(Math.abs(a.x - b.x), name).toBeGreaterThanOrEqual(templeArt("pagoda", a.h, true).hw + templeArt("shrine", b.h, true).hw + PAD);
    }
  });

  it("never drops a temple: one left with no free spot still stands, at its preferred place", () => {
    // The table is data (another city is one more entry). On an empty street a temple is offered only its
    // preferred place, and here a tower — placed first — stands on it, its body reaching above the haze.
    const empty = buildCityWorld([]);
    const specs: LandmarkSpec[] = [
      { kind: "tokyo-tower", layer: "tower", height: 333 / 634, prefer: 0.5 },
      { kind: "pagoda", layer: "near", height: 0.3, min: 2 * SKYLINE_BASE, cap: 176, prefer: 0.5 },
    ];
    const [tower, pagoda] = placeLandmarks(empty, horizonOf(empty), specs).placed;
    const pref = Math.round(0.5 * empty.cols * TILE);
    expect([tower.x, pagoda.x]).toEqual([pref, pref]);
    expect(pagoda.h).toBe(2 * SKYLINE_BASE);
  });

  it("at ½ the silhouettes stay — the spire's tip, the five roofs — without bells, rings, lattice or rope twist, in fewer rects, none under a pixel", () => {
    const one = near(typical, centred(typical, 1));
    const half = near(typical, centred(typical, 0.5));
    expect(half.of("fillRect").length).toBeLessThan(one.of("fillRect").length * 0.8);
    for (const c of half.of("fillRect")) {
      const [, , w, h] = c.args as number[];
      expect(w).toBeGreaterThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(1);
    }
    const cam = centred(typical, 0.5);
    const p = placed(typical, "pagoda");
    const mine = (ctx: RecordingTarget, c: Camera) => own(ctx.of("fillRect"), c, typical, p);
    expect(bbox(mine(half, cam))[1]).toBe(syOf(cam, H - p.h));
    // Five eave rows still, each one rect.
    expect(mine(half, cam).filter((c) => c.fillStyle === TEMPLE.eave && (c.args as number[])[2] >= 5)).toHaveLength(5);
    // The fine detail is gone: the bells (only the jewel is gold), the rings (one band), the lattice, the rope's twist.
    const gold = (ctx: RecordingTarget, c: Camera) => mine(ctx, c).filter((r) => r.fillStyle === TEMPLE.gold);
    expect(gold(one, centred(typical, 1)).length).toBeGreaterThanOrEqual(11);
    expect(gold(half, cam)).toHaveLength(1);
    const ring = (ctx: RecordingTarget, c: Camera) => mine(ctx, c).filter((r) => r.fillStyle === TEMPLE.ring);
    expect(ring(one, centred(typical, 1)).length).toBeGreaterThanOrEqual(10);
    expect(ring(half, cam).length).toBeLessThanOrEqual(2);
    for (const fine of [TEMPLE.lattice]) {
      expect(fills(one, new Set([fine])).length).toBeGreaterThan(0);
      expect(fills(half, new Set([fine]))).toHaveLength(0);
    }
    expect(fills(half, new Set([TEMPLE.rope])).length).toBeLessThan(fills(one, new Set([TEMPLE.rope])).length);
  });

  it("stays cheap: the two temples in under 450 rects at zoom 1 (a run repeated on the next row is one rect), all five landmarks under 2,300", () => {
    const n = near().of("fillRect").length;
    expect(n).toBeLessThan(450);
    expect(n + day().of("fillRect").length).toBeLessThan(2300);
    // A pillar is one tall rect, not one per row.
    expect(fills(near(), new Set([TEMPLE.vermilion])).some((c) => (c.args as number[])[3] >= 4)).toBe(true);
  });

  it("culls: nothing painted or lit when they are off screen, and a view of only their feet paints only their feet", () => {
    const cam = centred(typical);
    for (const pan of [50_000, -50_000]) {
      expect(near(typical, { ...cam, ox: cam.ox + pan }).calls, `pan ${pan}`).toHaveLength(0);
      expect(fills(lights("night", typical, { ...cam, ox: cam.ox + pan }), NIGHT), `pan ${pan}`).toHaveLength(0);
    }
    const low = { ...cam, oy: -(H - 20) };
    const ctx = near(typical, low, sky(), { w: VIEW.w, h: 100 });
    const ys = ctx.of("fillRect").map((c) => (c.args as number[])[1]);
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-2);
    expect(ctx.of("fillRect").length).toBeLessThan(near().of("fillRect").length / 2);
  });

  it("weather: they fade least of all — the nearest — and never to nothing", () => {
    const alpha = (_w: WeatherKind, ctx: RecordingTarget, set: Set<string>) => fills(ctx, set)[0].alpha;
    expect(alpha("clear", near(typical, centred(typical), sky("noon", "clear")), DAY)).toBe(1);
    for (const w of ["cloudy", "drizzle", "snow", "rain", "fog", "storm"] as const) {
      const a = alpha(w, near(typical, centred(typical), sky("noon", w)), DAY);
      expect(a, w).toBeGreaterThanOrEqual(alpha(w, day(typical, centred(typical), sky("noon", w)), PALETTE.skytree));
      expect(a, w).toBeGreaterThanOrEqual(0.6);
    }
    expect(alpha("fog", near(typical, centred(typical), sky("noon", "fog")), DAY)).toBeLessThan(1);
    expect(near(typical, centred(typical), sky("noon", "rain")).globalAlpha).toBe(1);
  });

  it("is deterministic and drawn once per size (the same art object every frame)", () => {
    expect(near().calls).toEqual(near().calls);
    expect(templeArt("pagoda", 96, true)).toBe(templeArt("pagoda", 96, true));
    expect(templeArt("pagoda", 96, false)).not.toBe(templeArt("pagoda", 96, true));
  });

  describe("at night", () => {
    it("lit only in the evening, at dusk and at night — the pagoda's storeys washed warm, the shrine's two lantern fires in their halos and its door — brighter as it gets dark", () => {
      for (const phase of ["dawn", "morning", "noon", "afternoon"] as const) expect(fills(lights(phase), NIGHT), phase).toHaveLength(0);
      const alphaOf = (phase: DayPhase) => fills(lights(phase), new Set([TEMPLE_LIT.wall]))[0].alpha;
      expect(alphaOf("evening")).toBeLessThan(alphaOf("dusk"));
      expect(alphaOf("dusk")).toBeLessThan(alphaOf("night"));
      expect(alphaOf("night")).toBe(1);
      const cam = centred(typical);
      const shrine = placed(typical, "shrine");
      const pagoda = placed(typical, "pagoda");
      for (const phase of ["evening", "dusk", "night"] as const) {
        const ctx = lights(phase);
        const lit = ctx.of("fillRect");
        const onPagoda = own(fills(ctx, NIGHT), cam, typical, pagoda);
        for (const c of [TEMPLE_LIT.wall, TEMPLE_LIT.panel, TEMPLE_LIT.eaves]) expect(onPagoda.some((r) => r.fillStyle === c), `${phase}: pagoda ${c}`).toBe(true);
        const onShrine = own(fills(ctx, NIGHT), cam, typical, shrine);
        expect(onShrine.some((r) => r.fillStyle === TEMPLE_LIT.door), `${phase}: shrine door`).toBe(true);
        // Two fires, mirrored about the shrine's centre, each in a halo.
        const fires = onShrine.filter((r) => r.fillStyle === TEMPLE_LIT.fire).map((r) => (r.args as number[])[0] - cam.ox - shrine.x);
        expect(fires).toHaveLength(2);
        expect(fires[0] + fires[1] + 2).toBe(0);
        expect(onShrine.filter((r) => r.fillStyle === TEMPLE_LIT.glow)).toHaveLength(2);
        // None of the day palette: what is not lit stays the graded silhouette.
        expect(fills(ctx, DAY), phase).toHaveLength(0);
        expect(lit.length).toBeGreaterThan(0);
        expect(ctx.globalAlpha).toBe(1);
      }
    });

    it("their lights never land on the street's props in front of them: each prop across the temples is a hole in the clip they are painted in", () => {
      const cam = centred(typical);
      const ctx = lights("night");
      const clips = ctx.calls.flatMap((c, i) => (c.op === "clip" ? [i] : []));
      expect(clips).toHaveLength(1); // at Fit no temple stands across a tower: only the props' clip
      const begin = ctx.calls.lastIndexOf(ctx.calls.slice(0, clips[0]).filter((c) => c.op === "beginPath").at(-1)!);
      const holes = ctx.calls.slice(begin + 1, clips[0]).map((c) => c.args as number[]);
      expect(holes[0]).toEqual([0, 0, VIEW.w, VIEW.h]);
      expect(ctx.calls[clips[0]].args).toEqual(["evenodd"]);
      // The street's props standing in front of either temple — the lamps, the shrine's sakura — are each a hole.
      const temples = (["pagoda", "shrine"] as const).map((k) => placed(typical, k));
      const front = typical.props.filter(
        (p) => ["lamp", "tree", "sakura", "vending", "torii"].includes(p.kind) && temples.some((t) => p.col * TILE < t.x + t.hw && (p.col + p.w) * TILE > t.x - t.hw),
      );
      expect(front.length).toBeGreaterThanOrEqual(2);
      for (const p of front) {
        const hole = holes.slice(1).find(([x, y, w, h]) => x <= cam.ox + p.col * TILE && x + w >= cam.ox + (p.col + p.w) * TILE && y <= cam.oy + (p.row - 1) * TILE && y + h >= cam.oy + (p.row + p.h) * TILE);
        expect(hole, `${p.kind} at col ${p.col}`).toBeDefined();
      }
      // …and none for what stands under the street — the Seats lounge's benches and its kiosk, right
      // below the temples here: every hole starts above the horizon.
      for (const [, y] of holes.slice(1)) expect(y).toBeLessThan(cam.oy + H);
      const across = (p: { col: number; w: number }) => temples.some((t) => p.col * TILE < t.x + t.hw && (p.col + p.w) * TILE > t.x - t.hw);
      expect(typical.props.filter((p) => p.kind === "bench" && across(p)).length).toBeGreaterThan(0);
      // Every temple light is painted inside that clip, and the clip is undone after.
      const restore = ctx.calls.findIndex((c, i) => i > clips[0] && c.op === "restore");
      for (const [i, c] of ctx.calls.entries()) if (c.op === "fillRect" && NIGHT.has(c.fillStyle)) expect(i > clips[0] && i < restore).toBe(true);
    });

    it("the towers' lights stay behind a temple taller than the haze whose foot stands across a tower's; with none across, they are not clipped at all", () => {
      // The HQ and three projects of one, five and ten floors: the pagoda stands at its preferred place in the
      // open street left of them all, its foot across the Tower's (clear of its body above the 130-px haze).
      const across = buildCityWorld([plan(0, 1), plan(1, 5), plan(2, 10)], { seats: 64 });
      const h0 = horizonOf(across);
      expect(skylineMax(h0)).toBe(130);
      expect(placed(across, "pagoda").x).toBe(Math.round(layoutOf(across).span[0] + 0.1 * (layoutOf(across).span[1] - layoutOf(across).span[0])));
      const pagoda = placed(across, "pagoda");
      const tower = placed(across, "tokyo-tower");
      expect(pagoda.h).toBeGreaterThan(skylineMax(h0));
      expect(Math.abs(pagoda.x - tower.x)).toBeLessThan(pagoda.hw + tower.hw);
      const view = { w: across.cols * TILE + 400, h: h0 + 200 };
      const cam = centred(across, 1, view);
      const TOWER_LIGHTS = new Set([...colours(TOKYO_TOWER_LIT), ...colours(SKYTREE_LIT)]);
      const ctx = lights("night", across, cam, "clear", view);
      const firstTowerLight = ctx.calls.findIndex((c) => c.op === "fillRect" && TOWER_LIGHTS.has(c.fillStyle));
      const clips = ctx.calls.flatMap((c, i) => (c.op === "clip" ? [i] : []));
      expect(clips).toHaveLength(2);
      expect(clips[0]).toBeLessThan(firstTowerLight);
      // Its holes are the pagoda's silhouette: from its foot to its spire's tip, as wide as its widest roof.
      const begin = ctx.calls.slice(0, clips[0]).map((c) => c.op).lastIndexOf("beginPath");
      const holes = ctx.calls.slice(begin + 2, clips[0]).map((c) => c.args as number[]);
      const hw = templeArt("pagoda", pagoda.h, true).hw;
      expect(Math.min(...holes.map((r) => r[1]))).toBe(cam.oy + h0 - pagoda.h);
      expect(Math.max(...holes.map((r) => r[1] + r[3]))).toBe(cam.oy + h0);
      expect(Math.min(...holes.map((r) => r[0]))).toBe(cam.ox + pagoda.x - hw);
      expect(Math.max(...holes.map((r) => r[0] + r[2]))).toBe(cam.ox + pagoda.x + hw);
      // The spire is a narrow hole.
      expect(holes.find((r) => r[1] === cam.oy + h0 - pagoda.h)![2]).toBeLessThanOrEqual(2);
      const restore = ctx.calls.findIndex((c, i) => i > clips[0] && c.op === "restore");
      expect(restore).toBeGreaterThan(firstTowerLight);
      expect(restore).toBeLessThan(clips[1]);
      // A temple no taller than the haze never needs a hole — the lights start above it: the typical city's
      // shrine at the Tower's foot, and the pagoda at the Tower's in a city whose 221-px haze tops it.
      const taller = buildCityWorld([plan(0, 11, 26)], { seats: 64 });
      const tallView = { w: taller.cols * TILE + 400, h: horizonOf(taller) + 200 };
      for (const [w, c, v] of [
        [typical, centred(typical), VIEW],
        [taller, centred(taller, 1, tallView), tallView],
      ] as const) {
        const night = lights("night", w, c, "clear", v);
        const firstLight = night.calls.findIndex((x) => x.op === "fillRect" && TOWER_LIGHTS.has(x.fillStyle));
        expect(firstLight).toBeGreaterThan(-1);
        expect(night.calls.slice(0, firstLight).some((x) => x.op === "clip")).toBe(false);
      }
    });

    it("a frame with the towers but no temple on screen, and one with a temple but no tower, each paints only its own lights", () => {
      // A narrow view on the Skytree of the typical city, right of the shrine at the Tower's foot.
      const skytree = placed(typical, "skytree");
      const shrine = placed(typical, "shrine");
      const narrow = { w: 80, h: H + 200 };
      const onSkytree = { zoom: 1, ox: 40 - skytree.x, oy: 100 };
      expect(shrine.x + shrine.hw).toBeLessThan(skytree.x - 40);
      const towersOnly = lights("night", typical, onSkytree, "clear", narrow);
      expect(fills(towersOnly, colours(SKYTREE_LIT)).length).toBeGreaterThan(0);
      expect(fills(towersOnly, NIGHT)).toHaveLength(0);
      expect(towersOnly.of("clip")).toHaveLength(0);
      // …and one on the pagoda, in front of Fuji in the gap right of the HQ: the Tower stands far off to its left, the Skytree past the view's right edge.
      const pagoda = placed(typical, "pagoda");
      const onPagoda = { zoom: 1, ox: 60 - pagoda.x, oy: 100 };
      const wide = { w: 120, h: H + 200 };
      const templeOnly = lights("night", typical, onPagoda, "clear", wide);
      const towersDay = recorder();
      paintLandmarks(towersDay, onPagoda, typical, wide, sky(), H, 0);
      expect(towersDay.calls, "no tower on screen").toHaveLength(0);
      expect(fills(templeOnly, new Set([...colours(SKYTREE_LIT), ...colours(TOKYO_TOWER_LIT)]))).toHaveLength(0);
      expect(fills(templeOnly, NIGHT).length).toBeGreaterThan(0);
      expect(templeOnly.of("clip")).toHaveLength(1);
    });
  });

  it("landmarkMask covers each temple exactly where it is painted; with [\"near\"] it covers only them — not Fuji, not the towers", () => {
    const cam = centred(typical);
    const amb = sky("night");
    const all = landmarkMask(cam, typical, VIEW, amb, H)!;
    const front = landmarkMask(cam, typical, VIEW, amb, H, ["near"])!;
    const painted = near(typical, cam);
    for (const kind of ["pagoda", "shrine"] as const) {
      const p = placed(typical, kind);
      const px = pixels(own(painted.of("fillRect"), cam, typical, p), cam);
      const hw = templeArt(kind, p.h, true).hw;
      let inside = 0;
      for (let y = H - p.h - 2; y < H + 2; y++)
        for (let x = p.x - hw - 2; x < p.x + hw + 2; x++) {
          const solid = px.get(y)?.has(x) ?? false;
          inside += solid ? 1 : 0;
          expect(front(x + 0.5, y + 0.5), `${kind} (${x}, ${y})`).toBe(solid);
          if (solid) expect(all(x + 0.5, y + 0.5)).toBe(true);
        }
      expect(inside, kind).toBeGreaterThan(p.h * 8);
    }
    // Fuji's peak and the Skytree's body are in the full mask only.
    for (const kind of ["fuji", "skytree"] as const) {
      const p = placed(typical, kind);
      expect(all(p.x, H - p.h + 3), kind).toBe(true);
      expect(front(p.x, H - p.h + 3), kind).toBe(false);
    }
  });
});
