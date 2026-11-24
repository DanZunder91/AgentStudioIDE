/**
 * The City's yokochō — the front of its backdrop in Tokyo (ramen shops or the like in the background,
 * with neon signs for ramen and soba in katakana and sushi in hiragana; then, on E, empty space left
 * between the clusters, and karaoke added): clusters of small food shops behind the street
 * (render/backdropShops.ts), against a recording fake.
 *
 * What it must hold, whatever the city: the row is WORLD-LOCKED (a pan or a zoom never re-rolls it, nor
 * does where the walk starts or a cache starting over); nothing stands in the backdrop's open stretches
 * (`airSpans`); `faceAt` is exactly the top of what `paint` paints, and solid below it; no roof rises into
 * a landmark's crown (`roofLimit`, over a sweep of cities of 1–12 floors); nothing is painted off the
 * view; no light by day, and every light at night through `fillLit`; the same frame twice is the same
 * picture. And the four featured words — ラーメン, ソバ, すし, カラオケ — hang on big signs in the open
 * street beyond the city's ends, out of the air, in view at Fit, clear of every building, temple, street
 * prop and project neon sign.
 *
 * Expectations are written by hand or are properties; the real pixels are the browser
 * tier's (backdropShops.browser.test.tsx). */

import { describe, expect, it, vi } from "vitest";

import { buildCityWorld, computeAmbience, planCity, type CityPlan } from "../engine";
import { citySky } from "../engine/ambience";
import { artBox, dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type DayPhase, type VillageAgent, type WeatherKind, type World } from "../villageTypes";
import { VillageView } from "../villageView";
import { AIR_CHUNK, citySpan, inQuiet, quietSpans, roofLimit, SIGN_WORDS, type BackdropLightScene, type BackdropScene } from "./backdrop";
import {
  bladePlate,
  CHUNK,
  forEachShop,
  GROUND,
  HAZE,
  MAX_H,
  SHOP_DAY,
  shopHeight,
  shopPalette,
  SHOPS,
  SIGNS,
  STOREY,
  type Shop,
} from "./backdropShops";
import type { Camera } from "./camera";
import { kanaText } from "./kana";
import { landmarkCrown, landmarksFor, placeLandmarks } from "./landmarks";
import { neonSignsOf } from "./neon";
import { recorder, type RecordingTarget } from "./testRecorder";

// ───────────────────────────── a synthetic crown ─────────────────────────────

/**
 * A crown's cap the tests can place exactly (the towers grew, `towerReference`, and no shop
 * of the sweep stands exactly at a real cap any more). `roofLimit` passes straight through to
 * render/backdrop.ts — every other test sees the real landmarks — except over [x0, x1) of the one World a
 * test sets here, where it is `y`.
 */
const synthetic = vi.hoisted(() => ({ world: null as unknown, x0: 0, x1: 0, y: 0 }));
vi.mock("./backdrop", async (importOriginal) => {
  const real = await importOriginal<typeof import("./backdrop")>();
  return {
    ...real,
    roofLimit: (...args: Parameters<typeof real.roofLimit>) => {
      const [world, , , x0, x1] = args;
      return world === synthetic.world && x1 > synthetic.x0 && x0 < synthetic.x1 ? synthetic.y : real.roofLimit(...args);
    },
  };
});

// ───────────────────────────── cities ─────────────────────────────

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

/** The reference city: a seven-floor gazelle (26 sub-agents on its ground floor), the HQ, a small Agent Studio — dressed for Tokyo. */
function referenceCity(): { world: World; agents: VillageAgent[] } {
  const agents = [
    ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
    ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
    agentOf("a0", "Agent Studio", { language: "typescript" }),
    agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
  ];
  const roster = planCity(agents);
  return { world: dressWorld(buildCityWorld(roster.plans, { seats: 64 }), "Asia/Tokyo"), agents: roster.agents };
}
const reference = referenceCity().world;

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
const LANGS = ["rust", "go", "python", "typescript"];
const plan = (key: string, team: number, floors: number): CityPlan => ({ key, label: key, team, hasIde: true, floors: floorsOf(key, floors), language: LANGS[key.charCodeAt(0) % 4] });

/** A sweep of cities: one or two projects of 1–12 floors, narrow and wide, beside the HQ (and one without it). */
const SWEEP: World[] = [
  ...[1, 2, 3, 5, 7, 9, 12].flatMap((n) => [
    dressWorld(buildCityWorld([plan("a", 2, n)], { seats: 64 }), "Asia/Tokyo"),
    dressWorld(buildCityWorld([plan("a", 26, n), plan("b", 4, 1)], { seats: 64 }), "Asia/Tokyo"),
  ]),
  dressWorld(buildCityWorld([plan("a", 8, 3), plan("b", 8, 3), plan("c", 2, 1)], { seats: 64 }), "Asia/Tokyo"),
  // Crowded streets, as built on both sides of the HQ: little open street inside the frame.
  dressWorld(buildCityWorld([plan("a", 26, 2), plan("b", 26, 2), plan("c", 8, 1), plan("d", 8, 1)], { seats: 64 }), "Asia/Tokyo"),
  dressWorld(buildCityWorld([plan("a", 12, 1), plan("b", 12, 1), plan("c", 12, 1), plan("d", 12, 1), plan("e", 12, 1)], { seats: 64 }), "Asia/Tokyo"),
  // A street with room for a sign in a gap between buildings, and one where a project's neon sign stands in front of a candidate.
  dressWorld(buildCityWorld(["a", "b", "c", "d", "e"].map((k) => plan(k, 8, 2)), { seats: 64 }), "Asia/Tokyo"),
  dressWorld(buildCityWorld(["a", "b", "c"].map((k) => plan(k, 4, 1)), { seats: 64 }), "Asia/Tokyo"),
  dressWorld(buildCityWorld([plan("a", 8, 2)]), "Asia/Tokyo"),
  // Two tall, narrow projects: no shop free within a chunk of the frame — the four go looking farther.
  dressWorld(buildCityWorld([plan("a", 2, 7), plan("b", 2, 7)], { seats: 64 }), "Asia/Tokyo"),
  dressWorld(buildCityWorld([plan("a", 2, 12), plan("b", 2, 12)], { seats: 64 }), "Asia/Tokyo"),
  // A shop whose roof stands exactly at a crown's cap (allowed: only rising above it is not).
  dressWorld(buildCityWorld([plan("a", 4, 2)]), "Asia/Tokyo"),
  // A shop under a crown that loses its tank, then a storey.
  dressWorld(buildCityWorld([plan("a", 12, 1)], { seats: 64 }), "Asia/Tokyo"),
  // A project's own neon sign stands in front of the shop nearest the city's end.
  dressWorld(buildCityWorld([plan("a", 10, 1)], { seats: 64 }), "Asia/Tokyo"),
];

/** A wider sweep for the featured four: one to five projects of 1–3 floors, narrow to wide, beside the HQ. */
const MANY: World[] = [1, 2, 3].flatMap((n) =>
  [2, 4, 8, 12, 26].flatMap((t) => [1, 2, 3, 4, 5].map((k) => dressWorld(buildCityWorld(["a", "b", "c", "d", "e"].slice(0, k).map((key) => plan(key, t, n)), { seats: 64 }), "Asia/Tokyo"))),
);

const horizonOf = (w: World) => w.city!.street * TILE;

/** An ambience in Tokyo, by phase and weather. */
const tokyo = (phase: DayPhase, weather: WeatherKind = "clear"): Ambience =>
  computeAmbience(new Date(2026, 9, 26, 15, 0), null, { weather, phase }, "Asia/Tokyo");
const NOON = tokyo("noon");
const NIGHT = tokyo("night");

/** Fit (1280×800 @2x unless said otherwise), as the City's view frames it. */
function fit(world: World, a: Ambience, w = 1280, h = 800, dpr = 2): { cam: Camera; view: { w: number; h: number } } {
  const v = new VillageView(1, undefined, "city");
  v.setWorld(world);
  v.setAmbience(a);
  v.resize(w, h, dpr);
  return { cam: v.camera, view: { w: v.view.w, h: v.view.h } };
}

/** The scene `paintCityBackdrop` hands a layer for this camera. */
function sceneOf(world: World, a: Ambience | undefined, cam: Camera, view: { w: number; h: number }, ctx: RecordingTarget = recorder(), timeMs = 0): BackdropScene & { ctx: RecordingTarget } {
  return { ctx, cam, world, view, amb: a, horizon: horizonOf(world), timeMs, x0: -Math.round(cam.ox) / cam.zoom, x1: (view.w - Math.round(cam.ox)) / cam.zoom };
}

/** A light fill as `fillLit` was asked for it: the world rect and the style it was set to. */
interface Lit {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
}

/** The night pass's scene, its `fillLit` recording every light (world px). */
function lightScene(world: World, a: Ambience, cam: Camera, view: { w: number; h: number }, opts: { lit?: number; timeMs?: number } = {}) {
  const ctx = recorder();
  const fills: Lit[] = [];
  const s: BackdropLightScene = {
    ...sceneOf(world, a, cam, view, ctx, opts.timeMs ?? 0),
    amb: a,
    dark: 1,
    lit: opts.lit ?? citySky(a).lit,
    fillLit: (x, y, w, h) => fills.push({ x, y, w, h, color: String(ctx.fillStyle), alpha: ctx.globalAlpha }),
    hidden: () => false,
  };
  return { s, ctx, fills };
}

/** A recorder that also logs every `fillStyle` and `globalAlpha` it is set to: a pass that walks nothing sets neither. */
function counting(): { ctx: RecordingTarget; sets: string[] } {
  const ctx = recorder();
  const sets: string[] = [];
  let fill = ctx.fillStyle;
  let alpha = ctx.globalAlpha;
  Object.defineProperty(ctx, "fillStyle", { get: () => fill, set: (v) => (sets.push(`fill ${v}`), (fill = v)) });
  Object.defineProperty(ctx, "globalAlpha", { get: () => alpha, set: (v) => (sets.push(`alpha ${v}`), (alpha = v)) });
  return { ctx, sets };
}

/** Every shop over [x0, x1), in a fresh array. */
function shopsOver(world: World, a: Ambience | undefined, x0: number, x1: number): Shop[] {
  const out: Shop[] = [];
  forEachShop(world, a, x0, x1, (s) => out.push(s));
  return out;
}

/** A shop's settled facts (no art). */
const facts = (s: Shop) => [s.x, s.w, s.storeys, s.roof, s.board, s.kind, s.word, s.signLeft, s.big];

/** A recorded fill as a world rect, for a camera with whole-pixel offsets and a whole zoom. */
const worldRect = (cam: Camera, args: unknown[]) => {
  const [x, y, w, h] = args as number[];
  return { x: (x - cam.ox) / cam.zoom, y: (y - cam.oy) / cam.zoom, w: w / cam.zoom, h: h / cam.zoom };
};

const overlaps = (a: readonly number[], b: readonly number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** The building boxes [x, y, w, h] of a world. */
const buildingBoxes = (w: World) => w.city!.buildings.map((b) => [b.col * TILE, b.row * TILE, b.w * TILE, horizonOf(w) - b.row * TILE]);

/** A wide camera at zoom `z` with the street's top 450 screen px from the view's top (the whole row in view up to zoom 3). */
const camAt = (world: World, z: number, ox: number): Camera => ({ zoom: z, ox, oy: 450 - horizonOf(world) * z });

// ───────────────────────────── the words ─────────────────────────────

describe("the signs", () => {
  it("every word a sign may spell has its colours, and every shop's word and rooftop board is one of them", () => {
    const words = SIGN_WORDS.map((w) => w.text);
    expect(Object.keys(SIGNS).sort()).toEqual([...words].sort());
    for (const w of words) expect(kanaText(w, true).runs.length).toBeGreaterThan(0);
    const shops = shopsOver(reference, NOON, -4 * CHUNK, 120 * CHUNK);
    for (const s of shops) {
      if (s.word) expect(words).toContain(s.word);
      if (s.roof === "board") expect(words).toContain(s.board);
    }
    // All of the featured words show up along the row: katakana for ramen and soba, hiragana for sushi.
    expect(new Set(shops.map((s) => s.word))).toEqual(new Set(["ラーメン", "ソバ", "すし", "カレー", "コーヒー", "カラオケ", "バー", null]));
    expect(new Set(shops.filter((s) => s.roof === "board").map((s) => s.board)).size).toBeGreaterThan(2);
  });

  it("a blade plate is the kana, 1 px of air and a 1-px rim (twice the size for a big one), hung from 20 px above the street", () => {
    const s = { x: 100, w: 48, word: "ラーメン", big: false, signLeft: true };
    expect(bladePlate(s, 500)).toEqual([101, 500 - 20 - (35 + 4), 12, 39]);
    expect(bladePlate({ ...s, signLeft: false }, 500)).toEqual([100 + 48 - 1 - 12, 441, 12, 39]);
    expect(bladePlate({ ...s, big: true }, 500)).toEqual([101, 500 - 20 - (70 + 6), 22, 76]);
    expect(bladePlate({ ...s, word: "すし" }, 500)).toEqual([101, 500 - 20 - 21, 12, 21]);
    expect(bladePlate({ ...s, word: null }, 500)).toBeNull();
  });

  it("a shop's height: storeys of 2 tiles, then its kawara, or its parapet and what stands on it", () => {
    const body = GROUND + STOREY;
    expect(shopHeight({ storeys: 2, roof: "grey", board: "" })).toBe(body + 9);
    expect(shopHeight({ storeys: 2, roof: "blue", board: "" })).toBe(body + 9);
    expect(shopHeight({ storeys: 2, roof: "flat", board: "" })).toBe(body + 3);
    expect(shopHeight({ storeys: 2, roof: "tank", board: "" })).toBe(body + 15);
    expect(shopHeight({ storeys: 2, roof: "stair", board: "" })).toBe(body + 12);
    expect(shopHeight({ storeys: 3, roof: "board", board: "バー" })).toBe(GROUND + 2 * STOREY + 3 + 4 + 14);
    expect(MAX_H).toBe(GROUND + 2 * STOREY + 3 + 4 + 14);
  });
});

// ───────────────────────────── the row ─────────────────────────────

describe("the row", () => {
  it("is clusters of 2–3-storey shops 24–72 px wide, wall to wall but for a narrow alley now and then — open sky only in the air", () => {
    const shops = shopsOver(reference, undefined, 2000, 2000 + 8 * CHUNK);
    for (const s of shops) {
      expect(s.w % 8).toBe(0);
      expect(s.w).toBeGreaterThanOrEqual(24);
      expect(s.w).toBeLessThanOrEqual(72);
      expect([2, 3]).toContain(s.storeys);
    }
    const pairs = shops.slice(1).map((s, i) => ({ prev: shops[i], next: s, gap: s.x - shops[i].x - shops[i].w }));
    // Between two shops with no open stretch between them, an alley at most…
    const street = pairs.filter((p) => !inQuiet(reference, p.prev.x + p.prev.w, p.next.x));
    expect(Math.min(...street.map((p) => p.gap))).toBe(0);
    expect(Math.max(...street.map((p) => p.gap))).toBe(16);
    expect(street.filter((p) => p.gap === 0).length).toBeGreaterThan(street.length / 2);
    // …and every stretch of open sky a cluster's end.
    expect(pairs.length - street.length).toBe(quietSpans(reference, 2000, 2000 + 8 * CHUNK).length);
    // Laid out afresh from the left edge of every 256-px chunk: a shop always starts there, but in the air…
    expect(CHUNK).toBe(256);
    for (let c = Math.ceil(2000 / CHUNK); c < 2000 / CHUNK + 8; c++) if (!inQuiet(reference, c * CHUNK, c * CHUNK + 72)) expect(shops.some((s) => s.x === c * CHUNK)).toBe(true);
    // …an alley of 1 or 2 units now and then inside a chunk, and the narrowest shops are bars, izakaya or a ramen counter.
    const alleys = street.filter((p) => Math.floor(p.prev.x / CHUNK) === Math.floor(p.next.x / CHUNK)).map((p) => p.gap);
    expect(new Set(alleys.filter((g) => g > 0))).toEqual(new Set([8, 16]));
    const long = shopsOver(reference, undefined, 2000, 2000 + 40 * CHUNK);
    // Over a long stretch too: never a gap wider than an alley but at a quiet stretch.
    const gaps = long.slice(1).filter((sh, i) => !inQuiet(reference, long[i].x + long[i].w, sh.x)).map((sh) => sh.x - long[long.indexOf(sh) - 1].x - long[long.indexOf(sh) - 1].w);
    expect(Math.max(...gaps)).toBe(16);
    expect(new Set(long.map((s) => s.roof))).toEqual(new Set(["grey", "blue", "flat", "tank", "stair", "board"]));
    expect(new Set(long.map((s) => s.storeys))).toEqual(new Set([2, 3]));
    for (const sh of long) if (sh.w === 24) expect(["bar", "izakaya", "ramen"]).toContain(sh.kind);
  });

  it("is world-locked: where the walk starts, or a cache starting over, never changes a shop", () => {
    const a = shopsOver(reference, NOON, 300, 1700).map(facts);
    expect(shopsOver(reference, NOON, -3000, 5000).map(facts).filter((f) => (f[0] as number) < 1700 && (f[0] as number) + (f[1] as number) > 300)).toEqual(a);
    // A walk starting or ending inside a shop takes it.
    const sh = shopsOver(reference, NOON, 1500, 1700)[1];
    expect(shopsOver(reference, NOON, sh.x + 5, sh.x + 6)).toEqual([sh]);
    expect(shopsOver(reference, NOON, sh.x + sh.w - 1, sh.x + sh.w)).toEqual([sh]);
    expect(shopsOver(reference, NOON, sh.x + sh.w, sh.x + sh.w + 1)).not.toContain(sh);
    // Settled once: a second walk is the very same shops (their art compiled once, not a frame).
    const first = shopsOver(reference, NOON, 300, 1700);
    shopsOver(reference, NOON, 300, 1700).forEach((sh, i) => expect(sh).toBe(first[i]));
    // Walk far enough that the chunk cache starts over (it keeps 256 chunks), then come back: settled afresh, the same.
    shopsOver(reference, NOON, 100_000, 100_000 + 300 * CHUNK);
    const again = shopsOver(reference, NOON, 300, 1700);
    expect(again.map(facts)).toEqual(a);
    expect(again[0]).not.toBe(first[0]);
    // A second World of the same plans has the same row.
    expect(shopsOver(referenceCity().world, NOON, 300, 1700).map(facts)).toEqual(a);
  });

  it("builds nothing in the city's own span — its street's gaps stay calm, and nothing stands behind a building", () => {
    const [c0, c1] = citySpan(reference) as [number, number];
    const shops = shopsOver(reference, NOON, -2000, 4000);
    for (const s of shops) expect(s.x + s.w <= c0 || s.x >= c1).toBe(true);
    expect(shops.some((s) => s.x + s.w <= c0)).toBe(true);
    expect(shops.some((s) => s.x >= c1)).toBe(true);
    const { cam, view } = fit(reference, NOON);
    const s = sceneOf(reference, NOON, cam, view);
    for (let x = c0; x < c1; x++) expect(SHOPS.faceAt(s, x)).toBe(horizonOf(reference));
    SHOPS.paint(s);
    expect(s.ctx.of("fillRect").length).toBeGreaterThan(100);
    for (const c of s.ctx.of("fillRect")) {
      const r = worldRect(cam, c.args);
      expect(r.x + r.w <= c0 || r.x >= c1).toBe(true);
    }
  });
});

// ───────────────────────────── the day pass ─────────────────────────────

describe("paint", () => {
  it("paints the row in opaque day colours, all of them the weather's hazed palette", () => {
    const { cam, view } = fit(reference, NOON);
    const s = sceneOf(reference, NOON, cam, view);
    s.ctx.globalAlpha = 0.4;
    SHOPS.paint(s);
    const fills = s.ctx.of("fillRect");
    expect(fills.length).toBeGreaterThan(500);
    const clear = new Set(shopPalette("clear"));
    for (const c of fills) {
      expect(c.alpha).toBe(1);
      expect(clear.has(c.fillStyle)).toBe(true);
    }
  });

  it("paints nothing off the view, and only what stands in the view's span", () => {
    const { cam, view } = fit(reference, NOON);
    for (const dx of [0, -700, 913]) {
      const c2 = { ...cam, ox: cam.ox + dx };
      const s = sceneOf(reference, NOON, c2, view);
      SHOPS.paint(s);
      expect(s.ctx.of("fillRect").length).toBeGreaterThan(0);
      for (const c of s.ctx.of("fillRect")) {
        const [x, y, w, h] = c.args as number[];
        expect(x + w > 0 && y + h > 0 && x < view.w && y < view.h).toBe(true);
      }
    }
  });

  it("paints nothing above or below the view when it cuts through the row", () => {
    const view = { w: 1280, h: 800 };
    for (const oy of [-(horizonOf(reference) - 40) * 2, 800 - (horizonOf(reference) - 60) * 2]) {
      const s = sceneOf(reference, NOON, { zoom: 2, ox: -2 * 1200, oy }, view);
      SHOPS.paint(s);
      expect(s.ctx.of("fillRect").length).toBeGreaterThan(50);
      for (const c of s.ctx.of("fillRect")) {
        const [, y, , h] = c.args as number[];
        expect(y + h > 0 && y < view.h).toBe(true);
      }
    }
  });

  it("paints nothing when the row's band is off screen — zoomed on gazelle's top, or on the lounge under the street", () => {
    const view = { w: 1280, h: 800 };
    for (const oy of [800 - (horizonOf(reference) - MAX_H) * 2, -horizonOf(reference) * 2]) {
      const { ctx, sets } = counting();
      SHOPS.paint(sceneOf(reference, NOON, { zoom: 2, ox: -200, oy }, view, ctx));
      // Not a shop walked: not a colour set, nor the alpha.
      expect(ctx.calls).toHaveLength(0);
      expect(sets).toEqual([]);
    }
    // One row of the band in view is enough to paint (its lowest: every shop reaches it).
    const s = sceneOf(reference, NOON, { zoom: 2, ox: -2400, oy: -(horizonOf(reference) - 1) * 2 }, view);
    SHOPS.paint(s);
    expect(s.ctx.of("fillRect").length).toBeGreaterThan(0);
  });

  it("is world-locked under a pan (the same rects, moved by the pan) and a zoom (the same world rects at the same detail)", () => {
    const view = { w: 9000, h: 900 };
    const at = (cam: Camera) => {
      const s = sceneOf(reference, NOON, cam, view);
      SHOPS.paint(s);
      return s.ctx.of("fillRect").map((c) => ({ ...worldRect(cam, c.args), color: c.fillStyle }));
    };
    const key = (r: { x: number; y: number; w: number; h: number; color: string }) => `${r.x},${r.y},${r.w},${r.h},${r.color}`;
    const a = at(camAt(reference, 2, 4000));
    const b = at(camAt(reference, 2, 4000 - 137));
    const inBoth = (r: { x: number; w: number }) => r.x >= -1931 && r.x + r.w <= 2431;
    expect(b.filter(inBoth).map(key)).toEqual(a.filter(inBoth).map(key));
    const c = at(camAt(reference, 3, 6000));
    const span3 = (r: { x: number; w: number }) => r.x >= -1900 && r.x + r.w <= 900;
    expect(c.filter(span3).map(key)).toEqual(a.filter(span3).map(key));
    // Zoomed out to 1 (a coarser detail), what it draws is a subset of what zoom 2 draws.
    const all2 = new Set(a.map(key));
    const one = at(camAt(reference, 1, 2000)).filter(span3);
    expect(one.length).toBeLessThan(a.filter(span3).length);
    for (const r of one) expect(all2.has(key(r))).toBe(true);
  });

  it("is deterministic: the same frame twice, or of a second World of the same plans, is the same calls", () => {
    const { cam, view } = fit(reference, NOON);
    const a = sceneOf(reference, NOON, cam, view);
    const b = sceneOf(reference, NOON, cam, view);
    const c = sceneOf(referenceCity().world, NOON, cam, view);
    SHOPS.paint(a);
    SHOPS.paint(b);
    SHOPS.paint(c);
    expect(b.ctx.calls).toEqual(a.ctx.calls);
    expect(c.ctx.calls).toEqual(a.ctx.calls);
  });

  it("draws less detail zoomed out: a small sign's kana a block a glyph below ¾, its runs from ¾; a big sign's runs at every zoom", () => {
    const shops = shopsOver(reference, NOON, -500, 4000);
    const small = shops.find((s) => s.word && !s.big && s.x > 1200) as Shop;
    const big = shops.find((s) => s.big) as Shop;
    const horizon = horizonOf(reference);
    const names = Object.keys(SHOP_DAY);
    /** The fills in a sign's kana colour over its plate, at zoom z. */
    const kana = (shop: Shop, z: number) => {
      const cam = camAt(reference, z, 1200);
      const s = sceneOf(reference, NOON, cam, { w: 4000, h: 900 });
      SHOPS.paint(s);
      const [px, py, pw, ph] = bladePlate(shop, horizon) as number[];
      const color = shopPalette("clear")[names.indexOf(SIGNS[shop.word as string].text)];
      return s.ctx
        .of("fillRect")
        .filter((c) => c.fillStyle === color)
        .map((c) => worldRect(cam, c.args))
        .filter((r) => r.x >= px - 1 && r.y >= py - 1 && r.x + r.w <= px + pw + 1 && r.y + r.h <= py + ph + 1);
    };
    const glyphs = [...(small.word as string)].length;
    expect(kana(small, 0.5)).toHaveLength(glyphs);
    expect(kana(small, 1).length).toBeGreaterThan(glyphs);
    expect(kana(big, 0.5).length).toBeGreaterThan([...(big.word as string)].length);
    expect(kana(big, 0.5)).toHaveLength(kana(big, 1).length);
  });

  it("dresses each kind's front: its noren's dye, its lanterns or its awning, and its sign in the kind's colours", () => {
    const names = Object.keys(SHOP_DAY);
    const col = (n: keyof typeof SHOP_DAY) => shopPalette("clear")[names.indexOf(n)];
    const horizon = horizonOf(reference);
    const cam = camAt(reference, 2, -2 * 1180);
    const s = sceneOf(reference, NOON, cam, { w: 2 * 4000, h: 900 });
    SHOPS.paint(s);
    const fills = s.ctx.of("fillRect").map((c) => ({ ...worldRect(cam, c.args), color: c.fillStyle }));
    /** The colours drawn over a shop's ground floor, and over its plate. */
    const at = (x0: number, y0: number, x1: number, y1: number) =>
      new Set(fills.filter((f) => f.x >= x0 && f.x + f.w <= x1 && f.y >= y0 && f.y + f.h <= y1).map((f) => f.color));
    const dress: Record<string, (keyof typeof SHOP_DAY)[]> = {
      ramen: ["norenRed", "frontWood"],
      soba: ["norenIndigo", "frontWood"],
      sushi: ["norenWhite", "frontWood"],
      bar: ["norenNavy", "frontDark"],
      izakaya: ["norenBrown", "lantern", "frontWood"],
      curry: ["awningOrange", "awningCream", "frontCafe"],
      coffee: ["awningBrown", "awningCream", "frontCafe"],
      karaoke: ["glassDoor", "frontNight"],
    };
    const lanterns = new Map<string, number>();
    let seen = 0;
    forEachShop(reference, NOON, 1180, 5000, (shop) => {
      seen++;
      const front = at(shop.x, horizon - GROUND, shop.x + shop.w, horizon);
      for (const c of dress[shop.kind]) expect([shop.kind, c, front.has(col(c))]).toEqual([shop.kind, c, true]);
      if (front.has(col("lantern")) || front.has(col("lanternWhite"))) lanterns.set(shop.kind, (lanterns.get(shop.kind) ?? 0) + 1);
      const plate = bladePlate(shop, horizon);
      if (!plate) return;
      const onPlate = at(plate[0], plate[1], plate[0] + plate[2], plate[1] + plate[3]);
      expect(onPlate.has(col(SIGNS[shop.word as string].plate as keyof typeof SHOP_DAY))).toBe(true);
      expect(onPlate.has(col(SIGNS[shop.word as string].text as keyof typeof SHOP_DAY))).toBe(true);
    });
    expect(seen).toBeGreaterThan(20);
    // Red chōchin at the ramen and sushi shops, white ones at the soba shops — where the front has room.
    expect(lanterns.get("ramen")).toBeGreaterThan(0);
    expect(lanterns.get("soba")).toBeGreaterThan(0);
    expect(lanterns.has("curry")).toBe(false);
    expect(lanterns.has("karaoke")).toBe(false);
  });

  it("is hazier in rain and hazier still in fog, the lanterns, noren, awnings and signs half as much", () => {
    const names = Object.keys(SHOP_DAY);
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const dist = (a: string, b: string) => rgb(a).reduce((t, v, i) => t + Math.abs(v - rgb(b)[i]), 0);
    const toHaze = (w: WeatherKind, name: string) => dist(shopPalette(w)[names.indexOf(name)], HAZE);
    for (const name of ["wallCream", "frontWood", "lantern", "ramenPlate"]) {
      expect(toHaze("rain", name)).toBeLessThan(toHaze("clear", name));
      expect(toHaze("fog", name)).toBeLessThan(toHaze("rain", name));
    }
    // The wall's own colour has moved a fifth of the way… the lantern's a tenth (to the rounding).
    const moved = (name: string) => dist(shopPalette("clear")[names.indexOf(name)], SHOP_DAY[name as keyof typeof SHOP_DAY]) / dist(SHOP_DAY[name as keyof typeof SHOP_DAY], HAZE);
    expect(moved("wallCream")).toBeCloseTo(0.15, 1);
    expect(moved("lantern")).toBeCloseTo(0.075, 1);
    expect(shopPalette("rain")).toBe(shopPalette("rain"));
    // Every colour the day pass uses in fog is the fog palette's.
    const { cam, view } = fit(reference, NOON);
    const s = sceneOf(reference, tokyo("noon", "fog"), cam, view);
    SHOPS.paint(s);
    const fog = new Set(shopPalette("fog"));
    for (const c of s.ctx.of("fillRect")) expect(fog.has(c.fillStyle)).toBe(true);
  });
});

// ───────────────────────────── the face ─────────────────────────────

describe("faceAt", () => {
  /**
   * The day pass rastered (whole zoom, whole offsets: every fill maps back to whole world px), and
   * per column: nothing painted above the face, and everything from the face down to the street
   * painted — or behind a building, where nothing of the row is drawn.
   */
  function checkFace(world: World, a: Ambience | undefined, z: number, x0: number, x1: number): void {
    const horizon = horizonOf(world);
    const cam: Camera = { zoom: z, ox: -x0 * z, oy: 400 - horizon * z };
    const view = { w: (x1 - x0) * z, h: 600 };
    const s = sceneOf(world, a, cam, view);
    SHOPS.paint(s);
    const W = x1 - x0;
    const grid = new Uint8Array(W * MAX_H);
    for (const c of s.ctx.of("fillRect")) {
      const r = worldRect(cam, c.args);
      for (let x = Math.max(r.x, x0); x < Math.min(r.x + r.w, x1); x++)
        for (let y = r.y; y < r.y + r.h; y++) {
          expect(y).toBeGreaterThanOrEqual(SHOPS.faceAt(s, x));
          grid[(x - x0) * MAX_H + horizon - 1 - y] = 1;
        }
    }
    const boxes = buildingBoxes(world);
    let solid = 0;
    for (let x = x0; x < x1; x++) {
      const face = SHOPS.faceAt(s, x);
      expect(face).toBeLessThanOrEqual(horizon);
      expect(horizon - face).toBeLessThanOrEqual(MAX_H);
      for (let y = face; y < horizon; y++) {
        if (boxes.some(([bx, by, bw]) => x >= bx && x < bx + bw && y >= by)) continue;
        expect(grid[(x - x0) * MAX_H + horizon - 1 - y]).toBe(1);
        solid++;
      }
    }
    expect(solid).toBeGreaterThan(0);
  }

  it("is the top of what paint paints, and the face below it is solid — at zoom 1 and 2, in the reference city", () => {
    checkFace(reference, NOON, 1, -600, 2200);
    checkFace(reference, NOON, 2, 1100, 1700);
  });

  it("…and in a low city, where roofs come down under the crowns, and with no landmarks at all", () => {
    checkFace(SWEEP[0], NOON, 1, -400, 1200);
    checkFace(SWEEP[0], undefined, 1, -400, 1200);
  });

  it("stands a flat roof's tank, stair house or signboard 2 px in from both ends of its parapet", () => {
    const s = sceneOf(reference, NOON, { zoom: 1, ox: 0, oy: 0 }, { w: 100, h: 100 });
    const horizon = horizonOf(reference);
    const shops = shopsOver(reference, NOON, 2000, 2000 + 60 * CHUNK).filter((sh) => ["tank", "stair", "board"].includes(sh.roof));
    expect(shops.length).toBeGreaterThan(10);
    const parapet = (sh: Shop) => horizon - shopHeight({ ...sh, roof: "flat" });
    let left = 0;
    let right = 0;
    for (const sh of shops) {
      for (const x of [sh.x, sh.x + 1, sh.x + sh.w - 2, sh.x + sh.w - 1]) expect(SHOPS.faceAt(s, x)).toBe(parapet(sh));
      if (SHOPS.faceAt(s, sh.x + 2) < parapet(sh)) left++;
      if (SHOPS.faceAt(s, sh.x + sh.w - 3) < parapet(sh)) right++;
    }
    // …and some stand right at either edge: the room it leaves is used.
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it("…and over a rooftop signboard: its frame and plate are the face", () => {
    const board = shopsOver(reference, NOON, 2000, 2000 + 100 * CHUNK).find((sh) => sh.roof === "board") as Shop;
    checkFace(reference, NOON, 1, board.x - 40, board.x + board.w + 40);
    checkFace(reference, NOON, 2, board.x - 40, board.x + board.w + 40);
  });

  it("is the street's top in an alley, and a pure function of world x", () => {
    const s = sceneOf(reference, NOON, { zoom: 1, ox: 0, oy: 0 }, { w: 100, h: 100 });
    const shops = shopsOver(reference, NOON, 2000, 2000 + 4 * CHUNK);
    const alley = shops.slice(1).find((sh, i) => sh.x > shops[i].x + shops[i].w) as Shop;
    expect(SHOPS.faceAt(s, alley.x - 1)).toBe(horizonOf(reference));
    expect(SHOPS.faceAt(s, alley.x + 0.5)).toBeLessThan(horizonOf(reference));
    expect(SHOPS.faceAt(s, alley.x + 0.5)).toBe(SHOPS.faceAt(s, alley.x));
  });
});

// ───────────────────────────── the landmarks ─────────────────────────────

describe("the landmarks' crowns", () => {
  it("no roof, tank or signboard rises into Fuji's or a tower's crown, in a sweep of cities of 1–12 floors — shops come down, or out, under them", () => {
    let lowered = 0;
    let oneStorey = 0;
    let lowest = Infinity;
    for (const world of [reference, ...SWEEP]) {
      const horizon = horizonOf(world);
      const layout = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo"));
      const crowns = layout.placed.filter((p) => p.spec.layer !== "near").map(landmarkCrown);
      expect(crowns.length).toBe(3);
      const [s0, s1] = layout.span;
      const s = sceneOf(world, NOON, { zoom: 1, ox: 0, oy: 0 }, { w: 10, h: 10 });
      for (let x = s0 - CHUNK; x < s1 + CHUNK; x++) {
        const face = SHOPS.faceAt(s, x);
        const limit = roofLimit(world, NOON, horizon, x, x + 1, ["far", "tower"]);
        expect(face).toBeGreaterThanOrEqual(limit);
        lowest = Math.min(lowest, horizon - limit);
        for (const c of crowns) if (x >= c.x0 && x < c.x1) expect(face).toBeGreaterThan(c.bottom);
      }
      // What the same street would stand without the landmarks: the shops the crowns brought down.
      const free = new Map(shopsOver(world, undefined, s0 - 2 * CHUNK, s1 + 2 * CHUNK).map((sh) => [sh.x, sh]));
      const capped = new Map(shopsOver(world, NOON, s0 - 2 * CHUNK, s1 + 2 * CHUNK).map((sh) => [sh.x, sh]));
      for (const [x, sh] of capped) {
        expect(sh.storeys).toBeGreaterThanOrEqual(1);
        // Brought down no further than the cap asks: the step before (its rooftop extra back, or a storey) would rise into it.
        const was = free.get(x) as Shop;
        // A rooftop tank, stair house or signboard goes before any storey does.
        if (!sh.featured && !was.featured && sh.storeys < was.storeys) expect(["grey", "blue", "flat"]).toContain(sh.roof);
        if (!sh.featured && !was.featured && shopHeight(sh) < shopHeight(was)) {
          const taller = sh.storeys < was.storeys ? { ...sh, storeys: sh.storeys + 1 } : { ...sh, roof: was.roof };
          expect(horizon - shopHeight(taller)).toBeLessThan(roofLimit(world, NOON, horizon, x, x + sh.w, ["far", "tower"]));
        }
        if (!sh.featured && !was.featured && shopHeight(sh) < shopHeight(was)) lowered++;
        if (sh.storeys === 1) {
          oneStorey++;
          expect(sh.word).toBeNull();
        }
      }
    }
    expect(lowered).toBeGreaterThan(0);
    expect(oneStorey).toBeGreaterThan(0);
    // The lowest cap of all (the Tower's, in the shortest sky) still leaves room for one storey under kawara: no shop ever has to go…
    expect(shopHeight({ storeys: 1, roof: "grey", board: "" })).toBeLessThanOrEqual(lowest);
    // …and it does bite: two storeys would not fit under it.
    expect(shopHeight({ storeys: 2, roof: "flat", board: "" })).toBeGreaterThan(lowest);
  });

  it("a roof may stand exactly at a crown's cap; a px under it and the shop gives up its rooftop extra first, then storeys — never more than it must", () => {
    // A shop with a tank on three storeys, out in the open street, far from any real crown (and beyond the featured four's search).
    const target = shopsOver(reference, NOON, 3000, 12000).find((sh) => sh.storeys === 3 && sh.roof === "tank" && sh.word) as Shop;
    const horizon = horizonOf(reference);
    const full = shopHeight(target);
    /** The target as it settles in a fresh World under a synthetic cap allowing `room` px above the street. */
    const under = (room: number): Shop => {
      const world = referenceCity().world;
      Object.assign(synthetic, { world, x0: target.x, x1: target.x + target.w, y: horizon - room });
      try {
        return shopsOver(world, NOON, target.x, target.x + 1)[0];
      } finally {
        synthetic.world = null;
      }
    };
    // Exactly at the cap: it stands as it is.
    expect(facts(under(full))).toEqual(facts(target));
    // A px under: the tank goes, the three storeys stay — and so for a stair house or a signboard.
    const tankless = under(full - 1);
    expect([tankless.storeys, tankless.roof]).toEqual([3, "flat"]);
    for (const roof of ["stair", "board"] as const) {
      const other = shopsOver(reference, NOON, 3000, 3000 + 200 * CHUNK).find((sh) => sh.storeys === 3 && sh.roof === roof) as Shop;
      const world = referenceCity().world;
      Object.assign(synthetic, { world, x0: other.x, x1: other.x + other.w, y: horizon - shopHeight(other) + 1 });
      try {
        const bare = shopsOver(world, NOON, other.x, other.x + 1)[0];
        expect([bare.storeys, bare.roof]).toEqual([3, "flat"]);
      } finally {
        synthetic.world = null;
      }
    }
    // Under the flat roof too: a storey goes — exactly at the cap again, two storeys stand.
    const flat3 = shopHeight({ storeys: 3, roof: "flat", board: "" });
    expect([under(flat3 - 1).storeys, under(flat3 - 1).roof]).toEqual([2, "flat"]);
    const flat2 = shopHeight({ storeys: 2, roof: "flat", board: "" });
    expect(under(flat2).storeys).toBe(2);
    // Down to one storey, its blade sign gone with the upper floors.
    const one = under(flat2 - 1);
    expect([one.storeys, one.roof, one.word]).toEqual([1, "flat", null]);
    expect(facts(under(full + 50))).toEqual(facts(target));
  });

  it("a zone without landmarks caps nothing; coming back to Tokyo, the same row as before", () => {
    const world = SWEEP[0];
    const before = shopsOver(world, NOON, -500, 1500).map(facts);
    const bare = shopsOver(world, { ...NOON, zone: "Europe/Paris" }, -500, 1500);
    expect(bare.map(facts)).not.toEqual(before);
    expect(shopsOver(world, NOON, -500, 1500).map(facts)).toEqual(before);
  });
});

// ───────────────────────────── the featured four ─────────────────────────────

describe("the featured four — ラーメン, ソバ, すし, and カラオケ", () => {
  /** What stands in front of the row: buildings, temples, the street's props above the street, the projects' neon signs. */
  function inFront(world: World): number[][] {
    const horizon = horizonOf(world);
    return [
      ...buildingBoxes(world),
      ...placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo"))
        .placed.filter((p) => p.spec.layer === "near")
        .map((p) => [p.x - p.hw, horizon - p.h, 2 * p.hw + 1, p.h]),
      ...world.props.map(artBox).filter((b) => b.row * TILE < horizon).map((b) => [b.col * TILE, b.row * TILE, b.w * TILE, b.h * TILE]),
      ...neonSignsOf(world).map((l) => [...l.sign.box]),
    ];
  }

  const fourOf = (world: World, a: Ambience | undefined) => {
    const [s0, s1] = placeLandmarks(world, horizonOf(world), landmarksFor(a?.zone)).span;
    return shopsOver(world, a, s0 - 4 * CHUNK, s1 + 4 * CHUNK).filter((s) => s.featured);
  };

  it("hang on big signs, three storeys up, in the open street beyond the reference city — out of the air, clear of everything in front, in view at every Fit", () => {
    const four = fourOf(reference, NOON);
    expect(new Map(four.map((s) => [s.word, s.kind]))).toEqual(
      new Map([
        ["ラーメン", "ramen"],
        ["ソバ", "soba"],
        ["すし", "sushi"],
        ["カラオケ", "karaoke"],
      ]),
    );
    // The four-kana words choose first, so they take the fronts nearest the city's end.
    const end = Math.max(...buildingBoxes(reference).map((b) => b[0] + b[2]));
    const d = (w: string) => (four.find((s) => s.word === w) as Shop).x - end;
    expect(Math.max(d("ラーメン"), d("カラオケ"))).toBeLessThan(Math.min(d("ソバ"), d("すし")));
    // カラオケ in magenta, its kana white: a karaoke front, glass doors and no noren.
    expect(SIGNS["カラオケ"]).toMatchObject({ plate: "karaokePlate", text: "karaokeText" });
    expect(SHOP_DAY.karaokePlate).toBe("#c42a88");
    expect(SHOP_DAY.karaokeText).toBe("#fff6fb");
    const horizon = horizonOf(reference);
    const ends = buildingBoxes(reference);
    const e0 = Math.min(...ends.map((b) => b[0]));
    const e1 = Math.max(...ends.map((b) => b[0] + b[2]));
    const [s0, s1] = placeLandmarks(reference, horizon, landmarksFor("Asia/Tokyo")).span;
    const front = inFront(reference);
    for (const s of four) {
      // Raised to three storeys to hold it (no crown caps the open street here), and out of the air.
      expect(s.big).toBe(true);
      expect(s.storeys).toBe(3);
      expect(inQuiet(reference, s.x, s.x + s.w)).toBe(false);
      const p = bladePlate(s, horizon) as number[];
      expect(p[2]).toBe(22);
      expect(p[1]).toBeGreaterThanOrEqual(horizon - GROUND - (s.storeys - 1) * STOREY);
      expect(p[0] >= e1 || p[0] + p[2] <= e0).toBe(true);
      expect(p[0] >= s0 && p[0] + p[2] <= s1).toBe(true);
      for (const b of front) expect(overlaps(p, b)).toBe(false);
      for (const [w, h, dpr] of [
        [1280, 800, 2],
        [1280, 800, 1],
        [1280, 720, 1],
        [900, 700, 2],
      ]) {
        const { cam, view } = fit(reference, NOON, w, h, dpr);
        expect(cam.ox + p[0] * cam.zoom).toBeGreaterThanOrEqual(0);
        expect(cam.ox + (p[0] + p[2]) * cam.zoom).toBeLessThanOrEqual(view.w);
        expect(cam.oy + p[1] * cam.zoom).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("…are the nearest such shops to the city's ends: no clear candidate stands nearer", () => {
    const horizon = horizonOf(reference);
    const e1 = Math.max(...buildingBoxes(reference).map((b) => b[0] + b[2]));
    const four = fourOf(reference, NOON);
    const far = Math.max(...four.map((s) => (bladePlate(s, horizon) as number[])[0]));
    // Every shop wide enough between the city's end and the farthest of the four, but not one of them, is ruled out by something in front (the air already took the rest).
    const front = inFront(reference);
    for (const s of shopsOver(reference, NOON, e1, far)) {
      if (s.featured || s.w < 40) continue;
      const p = bladePlate({ ...s, word: "ラーメン", big: true }, horizon) as number[];
      if (p[0] < e1 || p[0] > far) continue;
      expect(front.some((b) => overlaps(p, b))).toBe(true);
    }
  });

  it("are found in every city of the sweep, out of the air and clear of everything in front — beyond the ends and in view at Fit wherever the street has room — and in a street with no building at all", () => {
    const bad: string[] = [];
    let crowded = 0;
    for (const world of SWEEP) {
      const four = fourOf(world, NOON);
      expect(four.map((s) => s.word).sort()).toEqual(["すし", "カラオケ", "ソバ", "ラーメン"]);
      const horizon = horizonOf(world);
      const [s0, s1] = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).span;
      const ends = buildingBoxes(world);
      const e0 = Math.min(...ends.map((b) => b[0]));
      const e1 = Math.max(...ends.map((b) => b[0] + b[2]));
      for (const s of four) {
        expect(inQuiet(world, s.x, s.x + s.w)).toBe(false);
        const p = bladePlate(s, horizon) as number[];
        for (const b of inFront(world)) expect(overlaps(p, b)).toBe(false);
      }
      // Beyond the city's ends, inside its frame, wherever the street has room there for four signs (even the longest, ラーメン, on the usual plate).
      const front = inFront(world);
      const room = shopsOver(world, NOON, s0, s1).filter((sh) => {
        if (sh.storeys < 2) return false;
        const p = bladePlate({ ...sh, word: "ラーメン", big: false }, horizon) as number[];
        return p[0] >= s0 && p[0] + p[2] <= s1 && (p[0] >= e1 || p[0] + p[2] <= e0) && !front.some((b) => overlaps(p, b));
      });
      if (room.length >= 4) {
        for (const sh of four) {
          const p = bladePlate(sh, horizon) as number[];
          if (!(p[0] >= s0 && p[0] + p[2] <= s1 && (p[0] >= e1 || p[0] + p[2] <= e0))) bad.push(`${SWEEP.indexOf(world)} ${sh.word} not beyond the ends`);
          // …and so in view at Fit.
          for (const { cam, view } of [fit(world, NOON), fit(world, NOON, 1280, 800, 1)])
            if (cam.ox + p[0] * cam.zoom < 0 || cam.ox + (p[0] + p[2]) * cam.zoom > view.w) bad.push(`${SWEEP.indexOf(world)} ${sh.word} out of view`);
        }
        // There ラーメン, choosing first, always finds a front tall enough for its big sign — even under Fuji in the shortest sky.
        if (!four.find((sh) => sh.word === "ラーメン")?.big) bad.push(`${SWEEP.indexOf(world)} small ramen`);
      } else crowded++;
    }
    // The air leaves many streets too little room beyond their ends for four; enough still have it to hold the rule.
    expect(crowded).toBeGreaterThan(0);
    expect(SWEEP.length - crowded).toBeGreaterThan(5);
    expect(bad).toEqual([]);
    // A street with no building at all — bare, or dressed for Tokyo: the four stand nearest the middle of its frame.
    for (const [empty, a] of [
      [buildCityWorld([]), undefined],
      [buildCityWorld([]), NOON],
      [dressWorld(buildCityWorld([]), "Asia/Tokyo"), NOON],
    ] as const) {
      const four = fourOf(empty, a);
      expect(four.map((s) => s.word).sort()).toEqual(["すし", "カラオケ", "ソバ", "ラーメン"]);
      const [f0, f1] = placeLandmarks(empty, horizonOf(empty), landmarksFor(a?.zone)).span;
      // Gathered about the middle: nearer it, on the whole, than either end of the frame.
      const mean = (at: number) => four.reduce((t, sh) => t + Math.abs(sh.x + sh.w / 2 - at), 0) / four.length;
      expect(mean((f0 + f1) / 2)).toBeLessThan(Math.min(mean(f0), mean(f1)));
    }
  });

  it("over a wider sweep of streets: a big sign only on a shop wide enough for it and a door, the nearer end first, ラーメン big wherever there is room", () => {
    const bad: string[] = [];
    for (const world of MANY) {
      const four = fourOf(world, NOON);
      const i = MANY.indexOf(world);
      if (four.length !== 4) bad.push(`${i} found ${four.length}`);
      const horizon = horizonOf(world);
      const [s0, s1] = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).span;
      const ends = buildingBoxes(world);
      const e0 = Math.min(...ends.map((b) => b[0]));
      const e1 = Math.max(...ends.map((b) => b[0] + b[2]));
      const front = inFront(world);
      for (const sh of four) {
        if (sh.big && sh.w < 40) bad.push(`${i} big on ${sh.w} px`);
        if (inQuiet(world, sh.x, sh.x + sh.w)) bad.push(`${i} in a quiet stretch`);
        const p = bladePlate(sh, horizon) as number[];
        if (front.some((b) => overlaps(p, b))) bad.push(`${i} ${sh.word} hidden`);
      }
      // A word past the frame stands on the side whose end is nearer: no clear shop as near on the other side was passed over.
      const beyond = (p: number[]) => p[0] >= e1 || p[0] + p[2] <= e0;
      const dist = (p: number[]) => (p[0] >= e1 ? p[0] - e1 : e0 - p[0]);
      const room = shopsOver(world, NOON, s0, s1).filter((sh) => {
        if (sh.storeys < 2 || sh.w < 40) return false;
        const p = bladePlate({ ...sh, word: "ラーメン", big: false }, horizon) as number[];
        return p[0] >= s0 && p[0] + p[2] <= s1 && beyond(p) && !front.some((b) => overlaps(p, b));
      });
      if (room.length >= 4) {
        if (!four.find((sh) => sh.word === "ラーメン")?.big) bad.push(`${i} small ramen`);
        for (const sh of four) if (!beyond(bladePlate(sh, horizon) as number[])) bad.push(`${i} ${sh.word} not beyond`);
      }
      // A word that had to go past the frame took the clear shop nearest its own end of the city, on either side.
      const outside = (p: number[]) => p[0] + p[2] <= s0 || p[0] >= s1;
      const all = shopsOver(world, NOON, s0 - 4 * CHUNK, s1 + 4 * CHUNK);
      for (const sh of four) {
        const p = bladePlate(sh, horizon) as number[];
        if (!outside(p)) continue;
        for (const other of all) {
          if (other.featured || (sh.big ? other.w < 40 : other.storeys < 2)) continue;
          // The picker looks three chunks past the frame either side, no farther.
          if (other.x < (Math.floor(s0 / CHUNK) - 3) * CHUNK || Math.floor(other.x / CHUNK) * CHUNK >= s1 + 3 * CHUNK) continue;
          // As able to hang it: for a big sign three storeys under any crown's cap (a kawara roof stays, a flat one's extras go).
          const raised = { ...other, storeys: 3, roof: other.roof === "grey" || other.roof === "blue" ? other.roof : ("flat" as const) };
          if (sh.big && horizon - shopHeight(raised) < roofLimit(world, NOON, horizon, other.x, other.x + other.w, ["far", "tower"])) continue;
          const q = bladePlate({ ...other, word: sh.word, big: sh.big }, horizon) as number[];
          if (!outside(q) || front.some((b) => overlaps(q, b))) continue;
          if (dist(q) < dist(p)) bad.push(`${i} ${sh.word} at ${dist(p)} passed over ${other.x} at ${dist(q)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ───────────────────────────── the night pass ─────────────────────────────

describe("paintLights", () => {
  it("lights nothing by day — it does not even touch the context", () => {
    const { cam, view } = fit(reference, NOON);
    const { s, fills } = lightScene(reference, NOON, cam, view);
    const { ctx, sets } = counting();
    SHOPS.paintLights({ ...s, ctx });
    expect(fills).toHaveLength(0);
    expect(ctx.calls).toHaveLength(0);
    expect(sets).toEqual([]);
  });

  it("at night lights every shop front, lantern, sign and some windows — all through fillLit, none painted directly, alpha left at 1", () => {
    const { cam, view } = fit(reference, NIGHT);
    const { s, ctx, fills } = lightScene(reference, NIGHT, cam, view);
    SHOPS.paintLights(s);
    expect(ctx.of("fillRect")).toHaveLength(0);
    expect(fills.length).toBeGreaterThan(300);
    expect(ctx.globalAlpha).toBe(1);
    const colors = new Set(fills.map((f) => f.color));
    // The featured four: ramen's yellow tubes on a red glow, soba's white on indigo, sushi's red on white, karaoke's white on magenta.
    for (const w of ["ラーメン", "ソバ", "すし", "カラオケ"]) {
      expect(colors.has(SIGNS[w].tube)).toBe(true);
      expect(colors.has(SIGNS[w].glow)).toBe(true);
    }
    // No upstairs window shines through a blade sign; no light is asked for wholly behind a building.
    const horizon = horizonOf(reference);
    const plates = shopsOver(reference, NIGHT, -600, 2200).flatMap((sh) => (bladePlate(sh, horizon) ? [bladePlate(sh, horizon) as number[]] : []));
    for (const f of fills.filter((g) => g.color === "#e6cf98" || g.color === "#d6e0e8")) for (const p of plates) expect(overlaps([f.x, f.y, f.w, f.h], p)).toBe(false);
    for (const f of fills) for (const [bx, by, bw] of buildingBoxes(reference)) expect(f.x >= bx && f.x + f.w <= bx + bw && f.y >= by).toBe(false);
    // A small sign's kana light up as their runs, not as blocks.
    const small = shopsOver(reference, NIGHT, 1200, 2000).find((sh) => sh.word && !sh.big) as Shop;
    const [px, py, pw, ph] = bladePlate(small, horizon) as number[];
    const tubes = fills.filter((f) => f.color === SIGNS[small.word as string].tube && f.x >= px && f.y >= py && f.x < px + pw && f.y < py + ph);
    expect(tubes.length).toBeGreaterThan([...(small.word as string)].length);
    expect(tubes.every((f) => f.w * f.h < 36)).toBe(true);
    // No light off the view.
    for (const f of fills) {
      const x = cam.ox + f.x * cam.zoom;
      const y = cam.oy + f.y * cam.zoom;
      expect(x + Math.max(1, f.w * cam.zoom) > 0 && y + f.h * cam.zoom > 0 && x < view.w && y < view.h).toBe(true);
    }
  });

  it("lights only within the row's face — a light never lands on the sky above a roof", () => {
    const { cam, view } = fit(reference, NIGHT);
    const { s, fills } = lightScene(reference, NIGHT, cam, view);
    SHOPS.paintLights(s);
    // The halos may spill a few px off a plate or lantern, into the air beside a shop: never above the row's tallest.
    for (const f of fills) expect(f.y).toBeGreaterThanOrEqual(horizonOf(reference) - MAX_H - 3);
  });

  it("upstairs, single windows in a dim warm (some a cool white), 20–35 % lit at full night, a floor in four vacant — never lit", () => {
    const { cam, view } = fit(reference, NIGHT);
    const day = { ...NIGHT, daylight: 1 };
    const lights = (lit: number) => {
      const { s, fills } = lightScene(reference, day, cam, view, { lit });
      SHOPS.paintLights(s);
      return fills;
    };
    // Every window that ever lights (the share 1)…
    const all = lights(2);
    expect(lights(1 / 0.7).length).toBe(all.length);
    const night = lights(citySky(NIGHT).lit).length / all.length;
    expect(night).toBeGreaterThan(0.2);
    expect(night).toBeLessThan(0.35);
    for (const f of all) {
      expect(f.alpha).toBe(0.75);
      expect(f.w * f.h).toBe(80);
    }
    const warm = all.filter((f) => f.color === "#e6cf98").length;
    expect(warm / all.length).toBeGreaterThan(0.6);
    expect(all.length - warm).toBe(all.filter((f) => f.color === "#d6e0e8").length);
    // …is fewer than the windows there are: a floor in four stands vacant.
    const s = sceneOf(reference, NOON, cam, view);
    SHOPS.paint(s);
    const names = Object.keys(SHOP_DAY);
    const panes = new Set(["glass", "frosted"].map((n) => shopPalette("clear")[names.indexOf(n)]));
    const windows = s.ctx.of("fillRect").filter((c) => panes.has(c.fillStyle)).length;
    expect(all.length / windows).toBeGreaterThan(0.6);
    expect(all.length / windows).toBeLessThan(0.9);
  });

  it("windows come on one by one as the share rises — each lit at a lower share stays lit — and none at 0", () => {
    const { cam, view } = fit(reference, NIGHT);
    const day = { ...NIGHT, daylight: 1 };
    const windowsAt = (lit: number) => {
      const { s, fills } = lightScene(reference, day, cam, view, { lit });
      SHOPS.paintLights(s);
      return new Set(fills.map((f) => `${f.x},${f.y}`));
    };
    expect(windowsAt(0).size).toBe(0);
    // In full daylight (no neon) only windows: never an invisible light handed to fillLit.
    const { s, fills } = lightScene(reference, day, cam, view, { lit: 0.3 });
    SHOPS.paintLights(s);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f.alpha).toBeGreaterThan(0);
    const few = windowsAt(0.2);
    const more = windowsAt(0.6);
    const all = windowsAt(1.4);
    expect(few.size).toBeGreaterThan(0);
    expect(more.size).toBeGreaterThan(few.size);
    expect(all.size).toBeGreaterThan(more.size);
    for (const k of few) expect(more.has(k)).toBe(true);
    for (const k of more) expect(all.has(k)).toBe(true);
  });

  it("leaves the alpha at 1 when it is done, even at dusk", () => {
    const { cam, view } = fit(reference, NIGHT);
    const { s, ctx, fills } = lightScene(reference, { ...NIGHT, daylight: 0.5 }, cam, view, { lit: 0 });
    SHOPS.paintLights(s);
    expect(fills.length).toBeGreaterThan(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("rises with the neon's strength: none in full daylight, part-way at dusk, full at night", () => {
    const { cam, view } = fit(reference, NIGHT);
    const alphaOf = (daylight: number) => {
      const { s, fills } = lightScene(reference, { ...NIGHT, daylight }, cam, view, { lit: 0 });
      SHOPS.paintLights(s);
      return fills.length ? Math.max(...fills.map((f) => f.alpha)) : 0;
    };
    expect(alphaOf(0.9)).toBe(0);
    expect(alphaOf(0.5)).toBeGreaterThan(0.3);
    expect(alphaOf(0.5)).toBeLessThan(0.6);
    expect(alphaOf(0.15)).toBe(1);
  });

  it("now and then one of a sign's kana stutters out — a whole glyph, for a blink, the same at the same moment", () => {
    const shop = shopsOver(reference, NIGHT, -500, 2200).find((sh) => sh.word === "ラーメン" && sh.big) as Shop;
    const [px, py, pw, ph] = bladePlate(shop, horizonOf(reference)) as number[];
    // A view of that one shop.
    const cam = { zoom: 1, ox: -shop.x + 10, oy: 200 - horizonOf(reference) };
    const view = { w: shop.w + 20, h: 260 };
    const runs = (t: number) => {
      const { s, fills } = lightScene(reference, NIGHT, cam, view, { timeMs: t });
      SHOPS.paintLights(s);
      return fills.filter((f) => f.color === SIGNS["ラーメン"].tube && f.x >= px && f.x < px + pw && f.y >= py && f.y < py + ph).length;
    };
    const perGlyph = [..."ラーメン"].map((ch) => kanaText(ch, true).runs.length);
    const full = perGlyph.reduce((a, b) => a + b, 0);
    const counts: number[] = [];
    for (let t = 0; t < 240_000; t += 75) counts.push(runs(t));
    const out = counts.filter((n) => n < full);
    expect(Math.max(...counts)).toBe(full);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(counts.length / 20);
    for (const n of out) expect(perGlyph).toContain(full - n);
    const t = counts.findIndex((n) => n < full) * 75;
    expect(runs(t)).toBe(counts[t / 75]);
  });

  it("zoomed out, a small sign's kana light as a block a glyph; a big sign's tubes stay whole", () => {
    const cam = camAt(reference, 0.5, 600);
    const view = { w: 2000, h: 600 };
    const { s, fills } = lightScene(reference, NIGHT, cam, view);
    SHOPS.paintLights(s);
    const blocks = fills.filter((f) => f.w === 6 && f.h === 6 && f.alpha === 1);
    expect(blocks.length).toBeGreaterThan(5);
    const big = shopsOver(reference, NIGHT, -500, 2200).find((sh) => sh.big) as Shop;
    const [px, py, pw, ph] = bladePlate(big, horizonOf(reference)) as number[];
    const tubes = fills.filter((f) => f.color === SIGNS[big.word as string].tube && f.x > px && f.x < px + pw && f.y > py && f.y < py + ph);
    expect(tubes.length).toBeGreaterThan([...(big.word as string)].length);
  });

  it("lights nothing when the row's band is off screen — not even touching the context — and nothing above or below a view cutting through it", () => {
    const view = { w: 1280, h: 800 };
    const { s, fills } = lightScene(reference, NIGHT, { zoom: 2, ox: -200, oy: -horizonOf(reference) * 2 }, view);
    const { ctx, sets } = counting();
    SHOPS.paintLights({ ...s, ctx });
    expect(fills).toHaveLength(0);
    expect(sets).toEqual([]);
    for (const oy of [-(horizonOf(reference) - 40) * 2, 800 - (horizonOf(reference) - 60) * 2]) {
      const cam = { zoom: 2, ox: -2 * 1200, oy };
      const cut = lightScene(reference, NIGHT, cam, view);
      SHOPS.paintLights(cut.s);
      expect(cut.fills.length).toBeGreaterThan(20);
      for (const f of cut.fills) expect(oy + (f.y + f.h) * 2 > 0 && oy + f.y * 2 < view.h).toBe(true);
    }
  });

  it("is deterministic", () => {
    const { cam, view } = fit(reference, NIGHT);
    const a = lightScene(reference, NIGHT, cam, view, { timeMs: 1234 });
    const b = lightScene(reference, NIGHT, cam, view, { timeMs: 1234 });
    SHOPS.paintLights(a.s);
    SHOPS.paintLights(b.s);
    expect(b.fills).toEqual(a.fills);
  });
});

// ───────────────────────────── the quiet stretches ─────────────────────────────

describe("the quiet stretches — open sky between the clusters, and the city's own span (empty space between clusters, and a calm span)", () => {
  it("builds no shop touching one: there the street's top is the face, all across", () => {
    const x0 = -3 * AIR_CHUNK;
    const x1 = 20 * AIR_CHUNK;
    const shops = shopsOver(reference, NOON, x0, x1);
    for (const sh of shops) expect(inQuiet(reference, sh.x, sh.x + sh.w)).toBe(false);
    const s = sceneOf(reference, NOON, { zoom: 1, ox: 0, oy: 0 }, { w: 10, h: 10 });
    const quiet = quietSpans(reference, x0, x1);
    expect(quiet.length).toBeGreaterThan(15);
    for (const [a, b] of quiet) for (let x = Math.max(a, x0); x < Math.min(b, x1); x++) expect(SHOPS.faceAt(s, x)).toBe(horizonOf(reference));
    // …and right up to it: a cluster's end shop stands within a shop's width of the stretch, on either side.
    const edges = quiet.filter(([a, b]) => a > x0 + 100 && b < x1 - 100);
    const near = (x: number) => shops.some((sh) => Math.abs(sh.x - x) <= 72 || Math.abs(sh.x + sh.w - x) <= 72);
    expect(edges.filter(([a, b]) => near(a) && near(b)).length).toBeGreaterThan(edges.length / 2);
  });

  it("paints nothing there and lights nothing there — every light through fillLit", () => {
    const horizon = horizonOf(reference);
    const x0 = -600;
    const x1 = 2200;
    const cam: Camera = { zoom: 1, ox: -x0, oy: 400 - horizon };
    const view = { w: x1 - x0, h: 600 };
    const s = sceneOf(reference, NOON, cam, view);
    SHOPS.paint(s);
    const fills = s.ctx.of("fillRect").map((c) => worldRect(cam, c.args));
    expect(fills.length).toBeGreaterThan(300);
    for (const r of fills) expect(inQuiet(reference, r.x, r.x + r.w)).toBe(false);
    const night = lightScene(reference, NIGHT, cam, view);
    SHOPS.paintLights(night.s);
    expect(night.ctx.of("fillRect")).toHaveLength(0);
    expect(night.fills.length).toBeGreaterThan(150);
    // A halo may reach a few px past its shop, never into the middle of a stretch.
    for (const f of night.fills) for (const [a, b] of quietSpans(reference, f.x, f.x + f.w)) expect(f.x + f.w <= a + 4 || f.x >= b - 4).toBe(true);
  });
});

// ───────────────────────────── the calm pass ─────────────────────────────

describe("the calm pass — a hierarchy, not wallpaper (at ×2 by night, the busier row looked overloaded)", () => {
  const long = shopsOver(reference, NOON, 2000, 2000 + 200 * CHUNK);

  it("hangs a small blade on about one shop in three — the featured four always — and a signboard on about one roof in eighteen", () => {
    const able = long.filter((sh) => !sh.featured && sh.storeys > 1 && sh.kind !== "izakaya");
    const share = able.filter((sh) => sh.word).length / able.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.42);
    for (const sh of long) if (sh.word && !sh.featured) expect(sh.blade).toBe(true);
    const boards = long.filter((sh) => sh.roof === "board").length / long.length;
    expect(boards).toBeGreaterThan(0.025);
    expect(boards).toBeLessThan(0.08);
    for (const sh of shopsOver(reference, NOON, 1184, 1616)) if (sh.featured) expect(sh.word).not.toBeNull();
  });

  it("puts a halo round the four featured big signs only, and a faint one (≤ 0.15); the other signs light their plate and tubes alone", () => {
    const horizon = horizonOf(reference);
    const x0 = 1100;
    const x1 = 4000;
    const cam: Camera = { zoom: 1, ox: -x0, oy: 400 - horizon };
    const view = { w: x1 - x0, h: 600 };
    const { s, fills } = lightScene(reference, NIGHT, cam, view);
    SHOPS.paintLights(s);
    const shops = shopsOver(reference, NIGHT, x0, x1);
    let halos = 0;
    for (const sh of shops) {
      const p = bladePlate(sh, horizon);
      if (!p) continue;
      const glow = SIGNS[sh.word as string].glow;
      // Lights in its glow colour reaching past the plate's edge: its halo.
      const out = fills.filter((f) => f.color === glow && (f.x < p[0] || f.y < p[1] || f.x + f.w > p[0] + p[2] || f.y + f.h > p[1] + p[3]) && overlaps([f.x, f.y, f.w, f.h], p));
      if (sh.big) {
        expect(out.length).toBe(2);
        for (const f of out) expect(f.alpha).toBeLessThanOrEqual(0.15);
        halos += out.length;
      } else expect(out).toHaveLength(0);
    }
    expect(halos).toBe(8);
    // A plate glows back-lit: the four's brightly, the others' dimmer.
    for (const sh of shops) {
      const p = bladePlate(sh, horizon);
      if (!p) continue;
      const plate = fills.find((f) => f.color === SIGNS[sh.word as string].glow && f.x === p[0] + 1 && f.y === p[1] + 1) as Lit;
      expect(plate.alpha).toBe(sh.big ? 0.85 : 0.6);
    }
    // The lanterns keep a faint halo, no more.
    const lanternHalos = fills.filter((f) => f.color === "#ff5030" || f.color === "#ffe0a0");
    expect(lanternHalos.length).toBeGreaterThan(5);
    for (const f of lanternHalos) expect(f.alpha).toBeLessThanOrEqual(0.15);
    // The shop fronts glow, but modestly: no front light brighter than 0.85.
    const fronts = fills.filter((f) => !Object.values(SIGNS).some((g) => g.tube === f.color || g.glow === f.color));
    for (const f of fronts) expect(f.alpha).toBeLessThanOrEqual(0.85);
  });
});
