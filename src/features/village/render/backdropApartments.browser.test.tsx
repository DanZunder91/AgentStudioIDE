/** Real pixels for the apartments layer (the jsdom suite proves layout and calls): faces, pan and
 * zoom, night lights through the real `fillLit`, and the cost at Fit.
 * Run with `npx vitest run --config vitest.browser.config.ts <this file>`. */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { citySky } from "../engine/ambience";
import { dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type DayPhase, type VillageAgent } from "../villageTypes";
import { VillageView } from "../villageView";
import { quietSpans, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { APARTMENT_LIT, APARTMENTS, apartmentsIn } from "./backdropApartments";
import { lightCutter, type Box } from "./backdropLights";
import type { Camera } from "./camera";
import { paintCityBackdrop, paintCityNight } from "./city";
import { landmarksFor, placeLandmarks } from "./landmarks";
import { sx, sy } from "./paint";

afterEach(() => {
  document.body.innerHTML = "";
});

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
/** The reference city's agents: a seven-floor gazelle, the HQ, Agent Studio, payments and website. */
const AGENTS: VillageAgent[] = [
  ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
  ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
  agentOf("a0", "Agent Studio", { language: "typescript" }),
  agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
  agentOf("p0", "payments", { language: "python" }),
  agentOf("w0", "website", { language: "typescript" }),
];
const roster = planCity(AGENTS);
const reference = dressWorld(buildCityWorld(roster.plans, { seats: 64 }), "Asia/Tokyo");
const H = reference.city!.street * TILE;
const walls = reference.city!.buildings.map((b) => [b.col * TILE, (b.col + b.w) * TILE, b.row * TILE] as const);
/** The quiet stretches as the apartments lay them out: two less than 48 px apart are one (render/backdropApartments.ts `SLIVER`). */
const quiet = quietSpans(reference, -3000, 5000).reduce<[number, number][]>((out, [a, b]) => {
  const last = out[out.length - 1];
  if (last && a - last[1] < 48) last[1] = b;
  else out.push([a, b]);
  return out;
}, []);
/** Is screen column X in a quiet stretch padded by `PAD` (2 px)? Mapped like the renderer's `sx`
 * snap: below zoom 1 a world px may own no screen px, so dividing by zoom would misattribute. */
const inQuietScreen = (cam: Camera, X: number) => quiet.some(([a, b]) => X >= sx(cam, a - 2) && X < Math.max(sx(cam, b + 2), sx(cam, b + 1) + 1));

const sky = (phase: DayPhase, weather: Ambience["weather"] = "clear"): Ambience =>
  computeAmbience(new Date(2026, 9, 27, 15, 0), null, { weather, phase }, "Asia/Tokyo");
const noon = sky("noon");
const night = sky("night");

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** The day pass's scene, as render/city.ts builds it. */
function scene(ctx: CanvasRenderingContext2D, amb: Ambience, cam: Camera, timeMs = 0): BackdropScene {
  const view = { w: ctx.canvas.width, h: ctx.canvas.height };
  const ox = Math.round(cam.ox);
  return { ctx, cam, world: reference, view, amb, horizon: H, timeMs, x0: -ox / cam.zoom, x1: (view.w - ox) / cam.zoom };
}

/** A camera at `z` whose view starts at world x `x0`, the street's top `below` px above the view's bottom. */
const camAt = (x0: number, z: number, viewH: number, below = 20): Camera => ({ zoom: z, ox: -x0 * z, oy: viewH - below - H * z });

/** Run `f` with the apartments' passes switched off — and its face, the street's top everywhere. */
function without<T>(off: { paint?: boolean; lights?: boolean; face?: boolean }, f: () => T): T {
  const { paint, paintLights, faceAt } = APARTMENTS;
  if (off.paint) APARTMENTS.paint = () => {};
  if (off.lights) APARTMENTS.paintLights = () => {};
  if (off.face) APARTMENTS.faceAt = (s) => s.horizon;
  try {
    return f();
  } finally {
    Object.assign(APARTMENTS, { paint, paintLights, faceAt });
  }
}

const rgbOf = (c: string) => c.match(/\d+(\.\d+)?/g)!.map(Number);

describe("the apartments in real pixels", () => {
  it("faceAt is the top of what the day pass paints, and the face under it is opaque down to the street (but where a world building covers it)", () => {
    for (const [x0, z] of [
      [-560, 1],
      [700, 1],
      [1500, 2],
    ] as const) {
      const ctx = canvas(1280, 260 * z + 40);
      const cam = camAt(x0, z, ctx.canvas.height);
      const s = scene(ctx, noon, cam);
      APARTMENTS.paint(s);
      const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
      const alpha = (wx: number, wy: number) => d[(sy(cam, wy) * ctx.canvas.width + sx(cam, wx)) * 4 + 3];
      const wrong: string[] = [];
      let faces = 0;
      for (let wx = x0; wx < x0 + 1280 / z; wx++) {
        const face = APARTMENTS.faceAt(s, wx);
        const wall = walls.find(([a, b]) => wx >= a && wx < b);
        for (let wy = H - 260; wy < H; wy++) {
          const a = alpha(wx, wy);
          if (wy < face && a !== 0) wrong.push(`(${wx}, ${wy}) painted over the face ${face}`);
          if (wy >= face && (!wall || wy < wall[2]) && a !== 255) wrong.push(`(${wx}, ${wy}) not opaque under the face ${face}: ${a}`);
        }
        if (face < H) faces++;
      }
      expect(wrong.slice(0, 5), `x0 ${x0} zoom ${z}`).toEqual([]);
      expect(faces).toBeGreaterThan(z === 1 ? 200 : 60);
    }
  });

  it("is world-locked: panned and zoomed ×2, every world pixel of it keeps its colour", () => {
    const a = canvas(1280, 300);
    const camA = camAt(1250, 1, 300);
    APARTMENTS.paint(scene(a, noon, camA));
    const b = canvas(1280, 540);
    const camB = { zoom: 2, ox: -(1337 * 2) + 1, oy: 540 - 40 - H * 2 };
    APARTMENTS.paint(scene(b, noon, camB));
    const da = a.getImageData(0, 0, 1280, 300).data;
    const db = b.getImageData(0, 0, 1280, 540).data;
    let opaque = 0;
    for (let wx = 1340; wx < 1960; wx += 3)
      for (let wy = H - 240; wy < H; wy += 2) {
        const i = (sy(camA, wy) * 1280 + sx(camA, wx)) * 4;
        const j = (sy(camB, wy) * 1280 + sx(camB, wx)) * 4;
        expect([db[j], db[j + 1], db[j + 2], db[j + 3]], `world (${wx}, ${wy})`).toEqual([da[i], da[i + 1], da[i + 2], da[i + 3]]);
        opaque += da[i + 3] === 255 ? 1 : 0;
      }
    expect(opaque).toBeGreaterThan(3000);
  });

  it("at night lights its windows crisp through the real fillLit — never a vacant home's, never over a passer-by or a temple", () => {
    const ctx = canvas(1600, 300);
    const cam = camAt(560, 1, 300);
    const s = scene(ctx, night, cam);
    APARTMENTS.paint(s);
    const before = ctx.getImageData(0, 0, 1600, 300).data;
    const homes = apartmentsIn(reference, night, H, 560, 2160).flatMap((p) => p.homes);
    // A passer-by (16 × 24 world px) in front of a lit window, and the temples.
    const at = (wx: number, wy: number) => (sy(cam, wy) * 1600 + sx(cam, wx)) * 4;
    const lit = (wx: number, wy: number, t: Uint8ClampedArray) => [0, 1, 2].some((k) => t[at(wx, wy) + k] !== before[at(wx, wy) + k]);
    const temples = placeLandmarks(reference, H, landmarksFor(night.zone))
      .placed.filter((p) => p.spec.layer === "near")
      .map((p): Box => [p.x - p.hw, H - p.h - 2, 2 * p.hw + 1, p.h + 2]);
    const paintAt = (boxes: Box[]) => {
      const c = canvas(1600, 300);
      c.putImageData(new ImageData(new Uint8ClampedArray(before), 1600, 300), 0, 0);
      const cut = lightCutter(c, cam, { boxes, face: null, shapes: [] });
      const l: BackdropLightScene = { ...scene(c, night, cam), amb: night, dark: 1, lit: citySky(night).lit, ...cut };
      APARTMENTS.paintLights(l);
      return c.getImageData(0, 0, 1600, 300).data;
    };
    const open = paintAt([]);
    const win = homes.find((h) => !h.vacant && h.windows.some(([x, y]) => x > 1700 && x < 2100 && lit(x + 1, y + 1, open)))!.windows.find(([x, y]) => lit(x + 1, y + 1, open))!;
    const walker: Box = [win[0] - 6, win[1] - 8, 16, 24];
    const after = paintAt([walker]);
    const same = (wx: number, wy: number) => !lit(wx, wy, after);
    for (const [x, y, w, h] of [walker, ...temples])
      for (let wy = Math.max(y, H - 280); wy < y + h; wy++) for (let wx = Math.max(x, 560); wx < Math.min(x + w, 2160); wx++) expect(same(wx, wy), `(${wx}, ${wy}) in front`).toBe(true);
    // A vacant home stays dark; a lit window is lit whole, and not a pixel round it.
    let vacant = 0;
    let crisp = 0;
    for (const h of homes)
      for (const [x, y, w, hh] of h.windows) {
        if (x < 560 || x + w > 2160 || walls.some(([a, b, top]) => x + w > a && x < b && y + hh > top)) continue;
        if (temples.some(([tx, ty, tw, th]) => x < tx + tw && tx < x + w && y < ty + th && ty < y + hh)) continue;
        if (h.vacant) {
          for (let wy = y; wy < y + hh; wy++) for (let wx = x; wx < x + w; wx++) expect(same(wx, wy), `vacant (${wx}, ${wy})`).toBe(true);
          vacant++;
          continue;
        }
        if (!lit(x, y, after) || overlap(walker, [x - 1, y - 1, w + 2, hh + 2])) continue;
        for (let wy = y - 1; wy <= y + hh; wy++)
          for (let wx = x - 1; wx <= x + w; wx++) {
            const inside = wx >= x && wx < x + w && wy >= y && wy < y + hh;
            expect(lit(wx, wy, after), `(${wx}, ${wy}) of the window at (${x}, ${y})`).toBe(inside);
          }
        crisp++;
      }
    expect(vacant).toBeGreaterThan(30);
    expect(crisp).toBeGreaterThan(60);
    // A warm window: 0.85 of #e6cf98 over its facade's pane.
    const warm = rgbOf(APARTMENT_LIT.warm);
    let warmSeen = 0;
    for (const h of homes)
      for (const [x, y] of h.windows) {
        if (x < 560 || x > 2150 || !lit(x, y, after)) continue;
        const i = at(x, y);
        const blend = [0, 1, 2].map((k) => Math.round(warm[k] * 0.85 + before[i + k] * 0.15));
        if ([0, 1, 2].every((k) => Math.abs(after[i + k] - blend[k]) <= 1)) warmSeen++;
      }
    expect(warmSeen).toBeGreaterThan(30);
  });
});

const overlap = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

describe("the reference city at Fit, the real frame", () => {
  /** The frame at 1280×800 @2x, the HUD 117 px tall — and its camera. */
  function frame(amb: Ambience): { data: Uint8ClampedArray; cam: Camera; w: number } {
    const v = new VillageView(1, () => null, "city");
    v.setWorld(reference);
    v.setAgents(roster.agents);
    v.setAmbience(amb);
    const { w, h } = v.resize(1280, 800, 2);
    v.setInset(117);
    v.fit();
    const ctx = canvas(w, h);
    v.frame(400_000, ctx);
    return { data: ctx.getImageData(0, 0, w, h).data, cam: v.camera, w };
  }

  it("changes nothing outside the quiet stretches (and the slivers between two of them), by day or at night — and lights nothing at noon", () => {
    for (const amb of [noon, night]) {
      const on = frame(amb);
      const off = without({ paint: true, lights: true }, () => frame(amb));
      const { cam, w } = on;
      let changed = 0;
      const outside: string[] = [];
      for (let Y = sy(cam, H - 260); Y < sy(cam, H); Y++)
        for (let X = 0; X < w; X++) {
          const i = (Y * w + X) * 4;
          if (on.data[i] === off.data[i] && on.data[i + 1] === off.data[i + 1] && on.data[i + 2] === off.data[i + 2]) continue;
          changed++;
          if (!inQuietScreen(cam, X)) outside.push(`screen ${X} (world ≈ ${((X - Math.round(cam.ox)) / cam.zoom).toFixed(1)}, zoom ${cam.zoom})`);
        }
      expect(outside.slice(0, 5)).toEqual([]);
      expect(changed).toBeGreaterThan(50_000);
    }
    // At noon the night pass adds nothing.
    const lights = frame(noon).data;
    const dark = without({ lights: true }, () => frame(noon)).data;
    let differ = 0;
    for (let i = 0; i < lights.length; i++) if (lights[i] !== dark[i]) differ++;
    expect(differ).toBe(0);
  }, 120_000);
});

describe("the layer's frame cost (the reference city)", () => {
  it("is bounded at Fit and zoomed, by day and at night", () => {
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
      const v = new VillageView(1, () => null, "city");
      v.resize(w, h, dpr);
      v.setInset(117);
      v.setWorld(reference);
      v.setAmbience(noon);
      v.fit();
      const cam: Camera = zoomed ? { zoom: 2, ox: -1200, oy: -2 * (H - 300) } : v.camera;
      const view = v.view;
      const ctx = canvas(view.w, view.h);
      for (const phase of ["noon", "night"] as const) {
        const amb = sky(phase);
        const backdrop = () => paintCityBackdrop(ctx, amb, reference, cam, view, 0, null);
        const nightPass = () => paintCityNight(ctx, amb, reference, cam, view, 0);
        backdrop();
        nightPass();
        const day = median(backdrop) - without({ paint: true }, () => median(backdrop));
        const lights = median(nightPass) - without({ lights: true }, () => median(nightPass));
        // Its face too: the stars, the haze's lit windows and the towers' lights ask it thousands of times a night frame.
        const all = median(nightPass) - without({ lights: true, face: true }, () => median(nightPass));
        results.push(`${label} (zoom ${cam.zoom}), ${phase}: + ${day.toFixed(3)} ms to the backdrop, + ${lights.toFixed(3)} ms to the night pass (+ ${all.toFixed(3)} ms with its face)`);
        // A loose bound (the budget is 0.3 ms each at Fit, measured in the PR): a busy machine must not flake it.
        expect(day).toBeLessThan(3);
        expect(lights).toBeLessThan(3);
        expect(all).toBeLessThan(3);
      }
    }
    console.log(`[apartments frame cost]\n${results.join("\n")}`);
  }, 120_000);
});
