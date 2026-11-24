/**
 * Layer 5 — the City's yokochō, the front of its backdrop in Tokyo (ramen shops or the like in the
 * background, with neon signs for ramen and soba in katakana and sushi in hiragana; then
 * empty space left between the clusters, and karaoke added), against a REAL 2D context in Chromium.
 *
 * The jsdom suite (backdropShops.test.ts) proves the layout, the rects and the lights asked for; only
 * real pixels can prove what the canvas makes of them: that the row's face is exactly what `faceAt`
 * says — nothing painted above it (nor in the air, where it is the street's top), every pixel below it
 * down to the street opaque — at Fit and zoomed in; that a pan moves the picture by exactly the pan
 * and a zoom keeps every world pixel its colour; and, in the real frame of the reference city, that
 * the four featured words light up in their neon colours at Fit by night, and that nothing of the row ever
 * shows in front of a building or a temple, nor in the open sky between its clusters. *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/backdropShops.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type DayPhase, type VillageAgent, type World } from "../villageTypes";
import { VillageView } from "../villageView";
import { inAir, type BackdropScene } from "./backdrop";
import { bladePlate, forEachShop, MAX_H, SHOPS, SIGNS, type Shop } from "./backdropShops";
import type { Camera } from "./camera";
import { KANA_H, kanaText } from "./kana";
import { landmarkMask } from "./landmarks";

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
/** The reference city: a seven-floor gazelle, the HQ, a small Agent Studio — dressed for Tokyo. */
const roster = planCity([
  ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
  ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
  agentOf("a0", "Agent Studio", { language: "typescript" }),
  agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
]);
const world: World = dressWorld(buildCityWorld(roster.plans, { seats: 64 }), "Asia/Tokyo");
const horizon = world.city!.street * TILE;
const tokyo = (phase: DayPhase): Ambience => computeAmbience(new Date(2026, 9, 26, 15, 0), null, { weather: "clear", phase }, "Asia/Tokyo");
const NOON = tokyo("noon");
const NIGHT = tokyo("night");
const buildings = world.city!.buildings.map((b) => [b.col * TILE, b.row * TILE, b.w * TILE, horizon - b.row * TILE] as const);

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

const sceneOf = (ctx: CanvasRenderingContext2D, cam: Camera, view: { w: number; h: number }, amb: Ambience = NOON): BackdropScene => ({
  ctx,
  cam,
  world,
  view,
  amb,
  horizon,
  timeMs: 0,
  x0: -Math.round(cam.ox) / cam.zoom,
  x1: (view.w - Math.round(cam.ox)) / cam.zoom,
});

/** The layer alone on a transparent canvas: world x ∈ [x0, x0 + w/zoom), the street's top 40 px above the bottom. */
function layerAlone(x0: number, zoom: number, w: number, h = 300) {
  const ctx = canvas(w, h);
  const cam: Camera = { zoom, ox: -x0 * zoom, oy: h - 40 - horizon * zoom };
  const s = sceneOf(ctx, cam, { w, h });
  SHOPS.paint(s);
  return { ctx, cam, s, data: ctx.getImageData(0, 0, w, h).data };
}

describe("the row's face, in real pixels", () => {
  for (const [label, x0, zoom, w] of [
    ["Fit (zoom 1), across the whole street", -600, 1, 2800],
    ["zoomed in on the open street (zoom 2)", 1150, 2, 1400],
  ] as const)
    it(`${label}: nothing above faceAt, everything opaque from it down to the street (but behind a building)`, () => {
      const { cam, s, data } = layerAlone(x0, zoom, w);
      const h = 300;
      let solid = 0;
      for (let px = 0; px < w; px++) {
        const wx = Math.floor((px - cam.ox) / zoom);
        const face = SHOPS.faceAt(s, wx);
        const faceRow = cam.oy + face * zoom;
        const street = cam.oy + horizon * zoom;
        for (let py = 0; py < h; py++) {
          const a = data[(py * w + px) * 4 + 3];
          const wy = Math.floor((py - cam.oy) / zoom);
          if (py < faceRow || py >= street) {
            if (a !== 0) throw new Error(`painted above the face at world (${wx}, ${wy}), face ${face}`);
            continue;
          }
          if (buildings.some(([bx, by, bw]) => wx >= bx && wx < bx + bw && wy >= by)) continue;
          if (a !== 255) throw new Error(`a hole in the face at world (${wx}, ${wy}), face ${face}`);
          solid++;
        }
      }
      expect(solid).toBeGreaterThan(w * 20);
    });
});

describe("world-locked, in real pixels", () => {
  it("a pan moves the picture by exactly the pan", () => {
    const a = layerAlone(1150, 1, 1200);
    const b = layerAlone(1150 + 137, 1, 1200);
    // Column px of b is column px + 137 of a.
    for (let py = 0; py < 300; py += 1)
      for (let px = 0; px < 1200 - 137; px++) {
        const i = (py * 1200 + px) * 4;
        const j = (py * 1200 + px + 137) * 4;
        if (b.data[i] !== a.data[j] || b.data[i + 1] !== a.data[j + 1] || b.data[i + 2] !== a.data[j + 2] || b.data[i + 3] !== a.data[j + 3])
          throw new Error(`pixel (${px}, ${py}) moved`);
      }
  });

  it("a zoom keeps every world pixel its colour (zoom 2 and 3: the same detail)", () => {
    const z2 = layerAlone(1150, 2, 1600, 2 * MAX_H + 80);
    const z3 = layerAlone(1150, 3, 2400, 3 * MAX_H + 80);
    let n = 0;
    for (let wx = 1150; wx < 1950; wx++)
      for (let wy = horizon - MAX_H; wy < horizon; wy++) {
        const p2 = ((z2.cam.oy + wy * 2) * 1600 + (wx - 1150) * 2) * 4;
        const p3 = ((z3.cam.oy + wy * 3) * 2400 + (wx - 1150) * 3) * 4;
        for (let k = 0; k < 4; k++) if (z2.data[p2 + k] !== z3.data[p3 + k]) throw new Error(`world (${wx}, ${wy}) changed colour`);
        n++;
      }
    expect(n).toBe(800 * MAX_H);
  });
});

describe("in the reference city's frame", () => {
  /**
   * A frame of the reference city at Fit (1280×800 @2x), after the street has filled — the real
   * pipeline, its Tokyo backdrop and all; `shops: false` the same frame with this layer's paint and
   * lights left out (its face still cutting the canyon's lights), so a difference is this layer's own.
   */
  function frame(amb: Ambience, shops = true) {
    const { paint, paintLights } = SHOPS;
    if (!shops) {
      SHOPS.paint = () => {};
      SHOPS.paintLights = () => {};
    }
    try {
      const v = new VillageView(1, undefined, "city");
      v.setWorld(world);
      v.setAgents(roster.agents);
      v.setAmbience(amb);
      v.resize(1280, 800, 2);
      const ctx = canvas(v.view.w, v.view.h);
      for (let t = 0; t < 10_000; t += 100) v.frame(360_000 + t, null);
      v.frame(370_000, ctx);
      return { cam: v.camera, view: v.view, w: v.view.w, h: v.view.h, data: ctx.getImageData(0, 0, v.view.w, v.view.h).data };
    } finally {
      Object.assign(SHOPS, { paint, paintLights });
    }
  }

  const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

  it("by night, ラーメン, ソバ, すし and カラオケ glow in their neon tubes at Fit", () => {
    const f = frame(NIGHT);
    const four: Shop[] = [];
    forEachShop(world, NIGHT, -600, 2200, (s) => {
      if (s.featured) four.push(s);
    });
    expect(four.map((s) => s.word).sort()).toEqual(["すし", "カラオケ", "ソバ", "ラーメン"]);
    for (const shop of four) {
      const word = shop.word as string;
      const [px, py] = bladePlate(shop, horizon) as number[];
      const [r, g, b] = rgb(SIGNS[word].tube);
      // Every pixel of every run of the kana (twice the size, 3 px in from the plate's edge), in the view.
      let lit = 0;
      let all = 0;
      [...word].forEach((ch, i) => {
        for (const [rx, ry, rw, rh] of kanaText(ch, true).runs)
          for (let x = 0; x < rw * 2; x++)
            for (let y = 0; y < rh * 2; y++) {
              const sxp = Math.floor(f.cam.ox + (px + 3 + rx * 2 + x) * f.cam.zoom);
              const syp = Math.floor(f.cam.oy + (py + 3 + i * (KANA_H + 1) * 2 + ry * 2 + y) * f.cam.zoom);
              const k = (syp * f.w + sxp) * 4;
              all++;
              if (f.data[k] === r && f.data[k + 1] === g && f.data[k + 2] === b) lit++;
            }
      });
      // A passer-by may walk in front of its lowest kana, or a kana stutter: most of it shines.
      expect(lit / all).toBeGreaterThan(0.6);
    }
  });

  it("by night, no light of the row lands on a temple standing in front of it", () => {
    const a = frame(NIGHT, false);
    const b = frame(NIGHT);
    const temple = landmarkMask(a.cam, world, a.view, NIGHT, horizon, ["near"]) as (x: number, y: number) => boolean;
    let n = 0;
    for (let x = 600; x < 1100; x++)
      for (let y = horizon - MAX_H; y < horizon; y++) {
        if (!temple(x, y)) continue;
        const k = (Math.floor(a.cam.oy + y * a.cam.zoom) * a.w + Math.floor(a.cam.ox + x * a.cam.zoom)) * 4;
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) throw new Error(`a light on a temple at world (${x}, ${y})`);
        n++;
      }
    expect(n).toBeGreaterThan(500);
  });

  for (const [label, amb] of [
    ["by day", NOON],
    ["by night", NIGHT],
  ] as const)
    it(`${label}, nothing of the row shows in front of a building: inside every one, the frame is the one without it`, () => {
      const a = frame(amb, false);
      const b = frame(amb);
      let n = 0;
      for (const [bx, by, bw, bh] of buildings)
        for (let x = bx; x < bx + bw; x += 3)
          for (let y = Math.max(by, horizon - MAX_H - 8); y < by + bh; y += 3) {
            const sxp = Math.floor(a.cam.ox + x * a.cam.zoom);
            const syp = Math.floor(a.cam.oy + y * a.cam.zoom);
            const k = (syp * a.w + sxp) * 4;
            if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) throw new Error(`the row shows in a building at world (${x}, ${y})`);
            n++;
          }
      expect(n).toBeGreaterThan(1000);
      // …and outside them, the row is there — but in the air, where the frame is the one without it.
      let differ = 0;
      for (let x = 1200; x < 2000; x += 2) {
        const k = (Math.floor(a.cam.oy + (horizon - 30) * a.cam.zoom) * a.w + Math.floor(a.cam.ox + x * a.cam.zoom)) * 4;
        const same = a.data[k] === b.data[k] && a.data[k + 1] === b.data[k + 1] && a.data[k + 2] === b.data[k + 2];
        if (inAir(x, x + 1) && !same) throw new Error(`the row shows in the air at world x ${x}`);
        if (!same) differ++;
      }
      expect(differ).toBeGreaterThan(150);
    });
});
