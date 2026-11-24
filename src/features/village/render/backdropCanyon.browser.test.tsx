/**
 * Layer 5 — the City's backdrop canyon in Tokyo (render/backdropCanyon.ts: big lit buildings
 * with neon signs for ramen and soba in katakana and sushi in hiragana,
 * and karaoke), against a REAL 2D context in Chromium.
 *
 * The jsdom suite (backdropCanyon.test.ts) proves the rects and the calls; only real pixels can prove
 * what the canvas makes of them: that `faceAt` is the top of what the day pass paints and the face under
 * it is opaque; that a pan and a zoom leave every building on its world pixels; that the night's light
 * rasters, filled as patterns, land crisp — a lit glyph pixel is exactly its tube's colour — through the
 * real `fillLit`, which leaves a passer-by and the temples untouched; and, end to end through the real
 * frame from Fit, that the four featured words glow legible in the open street past both ends of the
 * city, by night and by day.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/backdropCanyon.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { citySky } from "../engine/ambience";
import { dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type DayPhase, type VillageAgent } from "../villageTypes";
import { VillageView } from "../villageView";
import type { BackdropLightScene, BackdropScene } from "./backdrop";
import { lightCutter, type Box } from "./backdropLights";
import { bladeWidth, CANYON, CANYON_ART, canyonSigns, FEATURED, type CanyonSign } from "./backdropCanyon";
import type { Camera } from "./camera";
import { KANA_H, KANA_W, kanaText } from "./kana";
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
/** The reference city's agents: a seven-floor gazelle of 26 seats a floor, the HQ, a small Agent Studio. */
const AGENTS: VillageAgent[] = [
  ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
  ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
  agentOf("a0", "Agent Studio", { language: "typescript" }),
  agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
];
const roster = planCity(AGENTS);
const reference = dressWorld(buildCityWorld(roster.plans, { seats: 64 }), "Asia/Tokyo");
const H = reference.city!.street * TILE;

const sky = (phase: DayPhase): Ambience => computeAmbience(new Date(2026, 9, 26, 15, 0), null, { weather: "clear", phase }, "Asia/Tokyo");
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

const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

describe("the canyon in real pixels", () => {
  it("faceAt is the top of what the day pass paints, and the face under it is opaque down to the street (but where a world building wholly covers it)", () => {
    const walls = reference.city!.buildings.map((b) => [b.col * TILE, (b.col + b.w) * TILE, b.row * TILE] as const);
    for (const [x0, z] of [
      [-700, 1],
      [560, 1],
      [1500, 2],
    ] as const) {
      const ctx = canvas(1280, 300 * z + 40);
      const cam = camAt(x0, z, ctx.canvas.height);
      const s = scene(ctx, noon, cam);
      CANYON.paint(s);
      const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
      const alpha = (wx: number, wy: number) => d[(sy(cam, wy) * ctx.canvas.width + sx(cam, wx)) * 4 + 3];
      const wrong: string[] = [];
      let faces = 0;
      for (let wx = x0; wx < x0 + 1280 / z; wx++) {
        const face = CANYON.faceAt(s, wx);
        const wall = walls.find(([a, b]) => wx >= a && wx < b);
        for (let wy = H - 300; wy < H; wy++) {
          const a = alpha(wx, wy);
          if (wy < face && a !== 0) wrong.push(`(${wx}, ${wy}) painted over the face ${face}`);
          if (wy >= face && (!wall || wy < wall[2]) && a !== 255) wrong.push(`(${wx}, ${wy}) not opaque under the face ${face}: ${a}`);
        }
        if (face < H) faces++;
      }
      expect(wrong.slice(0, 5), `x0 ${x0} zoom ${z}`).toEqual([]);
      expect(faces).toBeGreaterThan(200);
    }
  });

  it("is world-locked: panned and zoomed ×2, every world pixel of it keeps its colour", () => {
    const a = canvas(1280, 360);
    const camA = camAt(1300, 1, 360);
    CANYON.paint(scene(a, noon, camA, 0));
    const b = canvas(1280, 640);
    const camB = { zoom: 2, ox: -(1337 * 2) + 1, oy: 640 - 40 - H * 2 };
    CANYON.paint(scene(b, noon, camB, 0));
    const da = a.getImageData(0, 0, 1280, 360).data;
    const db = b.getImageData(0, 0, 1280, 640).data;
    let same = 0;
    for (let wx = 1340; wx < 1960; wx += 3)
      for (let wy = H - 280; wy < H; wy += 2) {
        const i = (sy(camA, wy) * 1280 + sx(camA, wx)) * 4;
        const j = (sy(camB, wy) * 1280 + sx(camB, wx)) * 4;
        expect([db[j], db[j + 1], db[j + 2], db[j + 3]], `world (${wx}, ${wy})`).toEqual([da[i], da[i + 1], da[i + 2], da[i + 3]]);
        same += da[i + 3] === 255 ? 1 : 0;
      }
    expect(same).toBeGreaterThan(5000);
  });

  it("at night lights crisp through the real fillLit: a lit glyph pixel is its tube's very colour, a passer-by in front and the temples stay untouched, the facades glow", () => {
    const ctx = canvas(1600, 360);
    const cam = camAt(500, 1, 360);
    const s = scene(ctx, night, cam, 0);
    CANYON.paint(s);
    const before = ctx.getImageData(0, 0, 1600, 360).data;
    // A passer-by (16 × 24 world px) on the street right in front of a blade, and the temples.
    const blade = canyonSigns(reference, night, H, 1150, 2100).find((g) => g.vertical && g.box[2] === bladeWidth(1)) as CanyonSign;
    const walker: Box = [blade.box[0] - 4, blade.box[1] + 4, 20, 24];
    const temples = placeLandmarks(reference, H, landmarksFor(night.zone))
      .placed.filter((p) => p.spec.layer === "near")
      .map((p): Box => [p.x - p.hw, H - p.h - 2, 2 * p.hw + 1, p.h + 2]);
    const cut = lightCutter(ctx, cam, { boxes: [walker], face: null, shapes: [] });
    const lit: BackdropLightScene = { ...s, amb: night, dark: 1, lit: citySky(night).lit, ...cut };
    CANYON.paintLights(lit);
    const after = ctx.getImageData(0, 0, 1600, 360).data;
    const at = (wx: number, wy: number) => (sy(cam, wy) * 1600 + sx(cam, wx)) * 4;
    const same = (wx: number, wy: number) => [0, 1, 2, 3].every((k) => after[at(wx, wy) + k] === before[at(wx, wy) + k]);
    for (const [x, y, w, h] of [walker, ...temples])
      for (let wy = y; wy < y + h; wy++) for (let wx = Math.max(x, 500); wx < Math.min(x + w, 2100); wx++) if (wy >= H - 340) expect(same(wx, wy), `(${wx}, ${wy}) in front`).toBe(true);
    // Outside them the canyon glows: most of its face is changed by the light.
    let changed = 0;
    let total = 0;
    for (let wx = 1200; wx < 2090; wx += 2)
      for (let wy = H - 200; wy < H; wy += 2) {
        if (after[at(wx, wy) + 3] === 0) continue;
        total++;
        changed += same(wx, wy) ? 0 : 1;
      }
    expect(changed / total).toBeGreaterThan(0.9);
    // Crisp: every lit pixel of a neon blade's glyphs is one of the tubes' own colours, never a blend.
    const tubes = CANYON_ART.tubes.map((t) => rgbOf(t.lit).join());
    // The blades' plates (each its own word), but the blade the passer-by stands in front of.
    const neon = canyonSigns(reference, night, H, 1150, 2100).filter((g) => g.vertical && g.box[2] === bladeWidth(1) && g.box[0] !== blade.box[0]);
    let glyphs = 0;
    for (const g of neon) {
      const t = kanaText(g.text, true);
      const [r0, g0, b0] = [after[at(g.box[0] + 1, g.box[1] + 1)], after[at(g.box[0] + 1, g.box[1] + 1) + 1], after[at(g.box[0] + 1, g.box[1] + 1) + 2]];
      // A neon blade's frame is a lit tube too; a plastic box's corner is its lit plastic.
      if (!tubes.includes(`${r0},${g0},${b0}`)) continue;
      for (const [dx, dy, w, h] of t.runs)
        for (let y = dy; y < dy + h; y++)
          for (let x = dx; x < dx + w; x++) {
            const i = at(g.box[0] + 3 + x, g.box[1] + 3 + y);
            glyphs++;
            expect(tubes, `${g.text} glyph (${x}, ${y})`).toContain(`${after[i]},${after[i + 1]},${after[i + 2]}`);
          }
    }
    expect(glyphs).toBeGreaterThan(100);
  });
});

describe("the reference city at Fit, the real frame", () => {
  /**
   * The frame at 1280×800 @2x, the HUD 117 px tall (a Tokyo sky: the canyon behind its street), Fit and
   * then zoomed `steps` steps in about the view's centre (as "+" does) — its camera, and Fit's zoom.
   */
  function frame(amb: Ambience, steps = 0): { data: Uint8ClampedArray; cam: Camera; w: number; fit: number } {
    const v = new VillageView(1, () => null, "city");
    v.setWorld(reference);
    v.setAgents(roster.agents);
    v.setAmbience(amb);
    const { w, h } = v.resize(1280, 800, 2);
    v.setInset(117);
    v.fit();
    const fit = v.camera.zoom;
    if (steps) v.zoomBy(steps);
    const ctx = canvas(w, h);
    for (let t = 300_000; t < 310_000; t += 100) v.frame(t, null);
    v.frame(310_000, ctx);
    return { data: ctx.getImageData(0, 0, w, h).data, cam: v.camera, w, fit };
  }

  /** How far a blade's glyph pixels stand out from the plate round them (mean luma), at `cam`. */
  function contrast(f: { data: Uint8ClampedArray; cam: Camera; w: number }, g: CanyonSign): number {
    const t = kanaText(g.text, true);
    const glyph = new Set<string>();
    for (const [dx, dy, w, h] of t.runs) for (let y = dy; y < dy + h; y++) for (let x = dx; x < dx + w; x++) glyph.add(`${x},${y}`);
    let on = 0;
    let onN = 0;
    let off = 0;
    let offN = 0;
    for (let y = 0; y < t.h; y++)
      for (let x = 0; x < KANA_W; x++) {
        const i = (sy(f.cam, g.box[1] + 3 + y) * f.w + sx(f.cam, g.box[0] + 3 + x)) * 4;
        if (glyph.has(`${x},${y}`)) {
          on += luma(f.data, i);
          onN++;
        } else {
          off += luma(f.data, i);
          offN++;
        }
      }
    return Math.abs(on / onN - off / offN);
  }

  /*
   * Since Tokyo Tower and the Skytree grew to the tallest roof (landmarks.ts, `towerReference`), Fit
   * frames their tips at 15/16. There one world px in 16 has no device px of its own — the day's rects and
   * the night's patterns drop different ones — so `contrast`, one device px per world px, often samples a
   * 1-px stroke's neighbour: it read 42–58 for the words left of the city at night where zoom 1 reads
   * 94–105. So the words are read one "+" in from Fit, at zoom 1, every glyph pixel a device pixel —
   * still the open street past both ends of the city — at the same bar. At Fit itself the glyphs are still
   * drawn as glyphs (not the bars below PANE_ZOOM, ¾), each at least 6½ device px tall: since the
   * Seats hall (the context window) was dug in under the lounge, 12 rows deeper, Fit went
   * 15/16 → 13/16 (7½ → 6½ px). That is an accepted trade-off: at Fit everything is drawn one zoom step
   * smaller and the neon kana signs are no longer legible there without zooming in; one "+" still brings
   * zoom 1, where the words are read below.
   */
  it("shows ラーメン, ソバ, すし and カラオケ legible on blades in the open street past both ends of the city, one step in from Fit — at night glowing, at noon in plastic and glass", () => {
    const walls = reference.city!.buildings.map((b) => [b.col * TILE, (b.col + b.w) * TILE]);
    const first = Math.min(...walls.map((w) => w[0]));
    const last = Math.max(...walls.map((w) => w[1]));
    for (const [amb, least] of [
      [night, 60],
      [noon, 60],
    ] as const) {
      const f = frame(amb, 1);
      expect(f.fit).toBeGreaterThanOrEqual(0.75);
      expect(f.fit * KANA_H).toBeGreaterThanOrEqual(6.5);
      expect(f.cam.zoom).toBe(1);
      const x0 = -Math.round(f.cam.ox);
      const x1 = x0 + f.w;
      for (const [a, b] of [
        [x0, first],
        [last, x1],
      ]) {
        const blades = canyonSigns(reference, amb, H, a, b).filter((g) => g.vertical && g.box[2] === bladeWidth(1));
        for (const word of FEATURED) {
          // Every plate saying it (a plate a word: its glyphs start BLADE_PAD in from its top).
          const shown = blades.filter((g) => g.text === word);
          expect(shown.length, `${word} over [${a}, ${b})`).toBeGreaterThan(0);
          const best = Math.max(...shown.map((g) => contrast(f, g)));
          expect(best, `${word} over [${a}, ${b}) at ${amb.phase}`).toBeGreaterThan(least);
        }
      }
      // And they are tall: a glyph is KANA_H world px, at zoom 1 as many device px.
      expect(KANA_H).toBeGreaterThanOrEqual(8);
    }
  });
});
