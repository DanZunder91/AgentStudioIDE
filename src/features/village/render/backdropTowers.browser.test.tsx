/** Real pixels for the towers (HIGH) layer. "Without the towers" is always the SAME Tokyo frame
 * with this layer stubbed out, never another zone's (which would lose the landmarks too).
 * Run with `npx vitest run --config vitest.browser.config.ts <this file>`. */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { TILE, type Ambience, type DayPhase, type WeatherKind, type World } from "../villageTypes";
import { VillageView } from "../villageView";
import { inAir, type BackdropScene } from "./backdrop";
import { CANYON } from "./backdropCanyon";
import { SHOPS } from "./backdropShops";
import { forEachTower, TOWERS, type Tower } from "./backdropTowers";
import type { Camera } from "./camera";
import { paintCityBackdrop, paintCityNight, skylineFaceAt } from "./city";
import { landmarkCrown, landmarkMask, landmarksFor, placeLandmarks } from "./landmarks";
import { sx, sy } from "./paint";

afterEach(() => {
  document.body.innerHTML = "";
});

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
const plan = (i: number, floors: number, team = 2) => ({ key: `p${i}`, label: `p${i}`, team, hasIde: true, floors: floorsOf(`p${i}`, floors) });
/** The reference city: gazelle, seven floors of 26 seats, left of the HQ; chat-server, one floor, right (a sky of 976 px). */
const reference = buildCityWorld(
  [
    { key: "chat-server", label: "chat-server", team: 2, hasIde: true, floors: floorsOf("t", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);
/** A real-shaped city: Agent Studio (1 floor), the HQ, gazelle (5 floors, the tallest), workspace (1 floor). */
const real = buildCityWorld(
  [
    { key: "gazelle", label: "gazelle", team: 12, hasIde: true, floors: floorsOf("g", 5) },
    { key: "Agent Studio", label: "Agent Studio", team: 16, hasIde: true, floors: floorsOf("a", 1) },
    { key: "workspace", label: "workspace", team: 2, hasIde: true, floors: floorsOf("w", 1) },
  ],
  { seats: 64 },
);
const horizonOf = (w: World) => w.city!.street * TILE;
const sky = (phase: DayPhase, weather: WeatherKind = "clear"): Ambience =>
  computeAmbience(new Date(2026, 9, 27, 13, 0), null, { weather, phase }, "Asia/Tokyo");

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

/** The camera and backing-store size of the City fitted into a CSS w × h pane at `dpr`. */
function fitOf(world: World, w: number, h: number, dpr: number): { cam: Camera; view: { w: number; h: number } } {
  const v = new VillageView(1, () => null, "city");
  v.setWorld(world);
  v.resize(w, h, dpr);
  return { cam: v.camera, view: v.view };
}

function sceneOf(ctx: CanvasRenderingContext2D, world: World, amb: Ambience | undefined, cam: Camera, view: { w: number; h: number }): BackdropScene {
  return { ctx, cam, world, view, amb, horizon: horizonOf(world), timeMs: 0, x0: -Math.round(cam.ox) / cam.zoom, x1: (view.w - Math.round(cam.ox)) / cam.zoom };
}

/** Run `f` with this layer's `paint` and/or `paintLights` stubbed out, then put them back. */
function without<T>(parts: { paint?: boolean; lights?: boolean }, f: () => T): T {
  const { paint, paintLights } = TOWERS;
  if (parts.paint) TOWERS.paint = () => {};
  if (parts.lights) TOWERS.paintLights = () => {};
  try {
    return f();
  } finally {
    TOWERS.paint = paint;
    TOWERS.paintLights = paintLights;
  }
}

/** The RGBA of every pixel of a canvas. */
const pixels = (ctx: CanvasRenderingContext2D) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;

describe("the layer alone, on a clear canvas", () => {
  const W = 2560;
  const H = 1100;
  const noon = sky("noon");

  it("paints its face exactly: each column's first opaque pixel is faceAt, opaque down to the street (left of the world, nothing in front)", () => {
    // World x −2600 … −40, its sky shown 900 px over the world's top: the tallest towers rise past it.
    const OY = 900;
    const cam: Camera = { zoom: 1, ox: 2600, oy: OY };
    const horizon = horizonOf(reference);
    const ctx = canvas(W, OY + horizon);
    const s = sceneOf(ctx, reference, noon, cam, { w: W, h: OY + horizon });
    TOWERS.paint(s);
    const d = pixels(ctx);
    const alpha = (X: number, y: number) => d[((y + OY) * W + X) * 4 + 3];
    let standing = 0;
    for (let X = 0; X < W; X++) {
      const face = TOWERS.faceAt(s, X - cam.ox);
      let first = horizon;
      for (let y = -OY; y < horizon; y++)
        if (alpha(X, y) !== 0) {
          first = y;
          break;
        }
      expect(first).toBe(face);
      for (let y = face; y < horizon; y++) expect(alpha(X, y)).toBe(255);
      if (face < horizon) standing++;
    }
    expect(standing).toBeGreaterThan(400);
  }, 120_000);

  it("is world-locked and deterministic: a pan moves every pixel by exactly the pan, a zoom keeps every world pixel's colour, a second paint is the same", () => {
    const paint = (cam: Camera) => {
      const ctx = canvas(W, H);
      TOWERS.paint(sceneOf(ctx, reference, noon, cam, { w: W, h: H }));
      return pixels(ctx);
    };
    const a = paint({ zoom: 1, ox: 448, oy: 0 });
    expect(paint({ zoom: 1, ox: 448, oy: 0 })).toEqual(a);
    const at = (d: Uint8ClampedArray, X: number, Y: number) => [...d.slice((Y * W + X) * 4, (Y * W + X) * 4 + 4)];
    // Panned 37 px left and 11 down: world (x, y) is at screen (x + 411, y + 11).
    const b = paint({ zoom: 1, ox: 411, oy: 11 });
    let painted = 0;
    for (let Y = 0; Y < H - 11; Y += 3)
      for (let X = 37; X < W; X += 3) {
        expect(at(b, X - 37, Y + 11)).toEqual(at(a, X, Y));
        if (at(a, X, Y)[3]) painted++;
      }
    expect(painted).toBeGreaterThan(20_000);
    // Zoomed ×2 about world (300, 400): world (x, y) is at screen 2x − 600, 2y − 800.
    const c = paint({ zoom: 2, ox: -600, oy: -800 });
    for (let wy = 400; wy < 400 + H / 2; wy += 3)
      for (let wx = 300; wx < 300 + W / 2; wx += 3) {
        const one = at(a, wx + 448, wy);
        for (const [dx, dy] of [
          [0, 0],
          [1, 1],
        ])
          expect(at(c, 2 * wx - 600 + dx, 2 * wy - 800 + dy)).toEqual(one);
      }
  }, 120_000);
});

describe("in the real backdrop and night pass", () => {
  it("never paints over Fuji's snow cap: the cap's pixels are the same with the towers as without, in cities of 1–12 floors", () => {
    const noon = sky("noon");
    for (const world of [reference, buildCityWorld([plan(0, 1)], { seats: 64 }), buildCityWorld([plan(0, 12), plan(1, 3)], { seats: 64 }), buildCityWorld([plan(0, 5), plan(1, 9, 26)])]) {
      const { cam, view } = fitOf(world, 1280, 800, 2);
      const draw = () => {
        const ctx = canvas(view.w, view.h);
        paintCityBackdrop(ctx, noon, world, cam, view, 0, null);
        return ctx;
      };
      const [plain, towers] = [without({ paint: true }, draw), draw()];
      const fuji = placeLandmarks(world, horizonOf(world), landmarksFor("Asia/Tokyo")).placed.find((p) => p.spec.kind === "fuji")!;
      const crown = landmarkCrown(fuji);
      const [X, Y] = [sx(cam, crown.x0), sy(cam, crown.top)];
      const [w, h] = [sx(cam, crown.x1) - X, sy(cam, crown.bottom) - Y];
      expect(w * h).toBeGreaterThan(1000);
      expect(towers.getImageData(X, Y, w, h).data).toEqual(plain.getImageData(X, Y, w, h).data);
      // …while the towers do stand in this city's sky.
      expect(pixels(towers)).not.toEqual(pixels(plain));
    }
  }, 120_000);

  it("lights nothing at noon; at night every lit pixel is on a tower's face (or a beacon's glow at its edge) — never on the haze, the canyon or the shops, a landmark, or a building", () => {
    const { cam, view } = fitOf(reference, 1280, 800, 2);
    const horizon = horizonOf(reference);
    /** The real backdrop, then the real night pass — with the towers' lights, or with them stubbed out. */
    const night = (amb: Ambience, lights: boolean) => {
      const ctx = canvas(view.w, view.h);
      paintCityBackdrop(ctx, amb, reference, cam, view, 0, null);
      without({ lights: !lights }, () => paintCityNight(ctx, amb, reference, cam, view, 0));
      return pixels(ctx);
    };
    const noon = sky("noon");
    expect(night(noon, true)).toEqual(night(noon, false));
    // A rainy night: no stars, no moon — so the night passes differ by the towers' lights alone.
    const rain = sky("night", "rain");
    const [lit, dark] = [night(rain, true), night(rain, false)];
    const s = sceneOf(canvas(1, 1), reference, rain, cam, view);
    const front = landmarkMask(cam, reference, view, rain, horizon, ["tower", "near"])!;
    const walls = reference.city!.buildings.map((b) => [b.col * TILE, b.row * TILE, (b.col + b.w) * TILE] as const);
    let n = 0;
    for (let Y = 0; Y < view.h; Y++)
      for (let X = 0; X < view.w; X++) {
        const i = (Y * view.w + X) * 4;
        if (lit[i] === dark[i] && lit[i + 1] === dark[i + 1] && lit[i + 2] === dark[i + 2]) continue;
        n++;
        const [x, y] = [X - Math.round(cam.ox), Y - Math.round(cam.oy)];
        // Above the haze (none stands in the open sky), and above the canyon and the shops, which stand in front.
        expect(y).toBeLessThan(inAir(x, x + 1) ? horizon : skylineFaceAt(x, horizon));
        expect(y).toBeLessThan(Math.min(CANYON.faceAt(s, x), SHOPS.faceAt(s, x)));
        expect(front(x, y)).toBe(false);
        for (const [x0, top, x1] of walls) expect(x >= x0 && x < x1 && y >= top).toBe(false);
        const face = Math.min(...[-2, -1, 0, 1, 2].map((d) => TOWERS.faceAt(s, x + d)));
        expect(y).toBeGreaterThanOrEqual(face - 2);
      }
    expect(n).toBeGreaterThan(1_000); // single windows since the calm pass: ≈ 3,300 px at Fit @2x
  }, 120_000);

  it("hides nothing it culls: through every building of the world, the full frame is the same with the towers as without — by day and at night", () => {
    for (const amb of [sky("noon"), sky("night")]) {
      const view = new VillageView(1, () => null, "city");
      view.setWorld(reference);
      view.setAmbience(amb);
      view.resize(1280, 800, 2);
      const frame = () => {
        const ctx = canvas(view.view.w, view.view.h);
        view.frame(400_000, ctx);
        return ctx;
      };
      const [plain, towers] = [without({ paint: true, lights: true }, frame), frame()];
      const cam = view.camera;
      for (const b of reference.city!.buildings) {
        const [X, Y] = [sx(cam, b.col * TILE), sy(cam, b.row * TILE)];
        const [w, h] = [sx(cam, (b.col + b.w) * TILE) - X, sy(cam, horizonOf(reference)) - Y];
        expect(towers.getImageData(X, Y, w, h).data).toEqual(plain.getImageData(X, Y, w, h).data);
      }
      // …and towers do stand behind gazelle, the tallest.
      const gazelle = reference.city!.buildings.reduce((p, q) => (q.row < p.row ? q : p));
      const behind: Tower[] = [];
      forEachTower(sceneOf(plain, reference, amb, cam, view.view), gazelle.col * TILE, (gazelle.col + gazelle.w) * TILE, (t) => behind.push(t));
      expect(behind.length).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe("the layer's frame cost (the real-shaped city)", () => {
  it("is bounded at Fit and zoomed, by day and at night", () => {
    const reference = real;
    const results: string[] = [];
    const median = (f: () => void) => {
      const runs: number[] = [];
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 40; i++) f();
        runs.push((performance.now() - t0) / 40);
      }
      return runs.sort((a, b) => a - b)[3];
    };
    for (const [label, w, h, dpr, zoomed] of [
      ["Fit 1280×800 @2x", 1280, 800, 2, false],
      ["Fit 1280×800 @1x", 1280, 800, 1, false],
      ["×2 on the street, 1280×800 @1x", 1280, 800, 1, true],
    ] as const) {
      const fit = fitOf(reference, w, h, dpr);
      const cam: Camera = zoomed ? { zoom: 2, ox: -1200, oy: -2 * (horizonOf(reference) - 300) } : fit.cam;
      const view = fit.view;
      const ctx = canvas(view.w, view.h);
      for (const phase of ["noon", "night"] as const) {
        const amb = sky(phase);
        const s = sceneOf(ctx, reference, amb, cam, view);
        const layer = median(() => TOWERS.paint(s));
        const backdrop = () => paintCityBackdrop(ctx, amb, reference, cam, view, 0, null);
        const nightPass = () => paintCityNight(ctx, amb, reference, cam, view, 0);
        const day = median(backdrop) - without({ paint: true }, () => median(backdrop));
        const lights = median(nightPass) - without({ lights: true }, () => median(nightPass));
        results.push(`${label} (zoom ${cam.zoom}), ${phase}: the day pass alone ${layer.toFixed(3)} ms, + ${day.toFixed(3)} ms to the backdrop, + ${lights.toFixed(3)} ms to the night pass`);
        // A loose bound (the budget is 0.5 ms each at Fit, measured in the PR): a busy machine must not flake it.
        expect(layer).toBeLessThan(3);
        expect(lights).toBeLessThan(3);
      }
    }
    console.log(`[towers frame cost]\n${results.join("\n")}`);
  }, 120_000);
});
