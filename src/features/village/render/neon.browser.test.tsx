/**
 * Layer 5 — the City's neon signs against a REAL 2D context in Chromium (a building's neon is in
 * the style of its language — gazelle is Rust, so its sign is Rust's).
 *
 * The jsdom suite (neon.test.ts) proves the rects, colours and order through a recording fake;
 * only real pixels can prove the light LANDS: that at night the tubes stay bright on a street the
 * grade has darkened, and that the sign's colour really tints the wall beside it and the sidewalk
 * under it — while the rooms stay exactly as lit. End to end through the seam: the agents'
 * `language` → `planCity` → `buildCityWorld` → the draw list → the frame.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/neon.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, computeAmbience, planCity } from "../engine";
import { neonAnchor } from "../engine/drawList";
import { hashString } from "../engine/rng";
import type { Ambience, VillageAgent, World } from "../villageTypes";
import { renderFrame, type Camera } from "./index";
import { NEON, neonFlicker, neonLayout, type NeonLayout } from "./neon";

afterEach(() => {
  document.body.innerHTML = "";
});

const Z = 2;
const OY = 64;
const cam: Camera = { zoom: Z, ox: 0, oy: OY };

const agent = (key: string, folder: string, language: string | null): VillageAgent => ({
  key,
  parentKey: null,
  origin: "ide",
  title: key,
  folder,
  activity: "idle",
  tool: null,
  ideAgentId: key,
  lastActivityAt: null,
  language,
});

/** gazelle (Rust) and web (TypeScript) — or the same street with no language known anywhere. */
function city(known: boolean): World {
  const roster = planCity([agent("g", "gazelle", known ? "rust" : null), agent("w", "web", known ? "typescript" : null)]);
  return buildCityWorld(roster.plans);
}

const noon = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "auto" });
const night = computeAmbience(new Date(2026, 9, 15, 23, 0), null, { weather: "clear", phase: "auto" });

/** A time at which `building`'s sign of `letters` letters is steady (no tube stuttering). */
function steady(building: string, letters: number): number {
  const seed = hashString(building);
  for (let t = 0; ; t += 25) if (neonFlicker(seed, t, letters) === -1) return t;
}

function paint(world: World, amb: Ambience, timeMs: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = world.cols * 16 * Z;
  canvas.height = world.rows * 16 * Z + OY;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  renderFrame(ctx, buildDrawList(world, [], () => false, 0), cam, null, {
    w: canvas.width,
    h: canvas.height,
    timeMs,
    ambience: amb,
    world,
  });
  return ctx;
}

/** RGB at a WORLD point (the screen pixel at its top-left). */
const at = (ctx: CanvasRenderingContext2D, wx: number, wy: number): number[] =>
  Array.from(ctx.getImageData(wx * Z + 1, OY + wy * Z + 1, 1, 1).data).slice(0, 3);
const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("the neon signs in a real canvas", () => {
  const lit = city(true);
  const dark = city(false);
  const gazelle = lit.city!.buildings.find((b) => b.key === "gazelle")!;
  const sign = neonLayout({ ...neonAnchor(gazelle), language: "rust", building: "gazelle" }) as NeonLayout;
  const t = steady("gazelle", 4);
  // R's top bar (the first rect of the first letter) and the dark glass right of the R's stem.
  const [tx, ty] = sign.letters[0][0];
  const glass = [sign.px + 5, sign.py + 6];

  it("the seam: the agents' language reaches each project building, and its sign", () => {
    expect(lit.city!.buildings.filter((b) => !b.hq).map((b) => [b.key, b.language])).toEqual([
      ["gazelle", "rust"],
      ["web", "typescript"],
    ]);
    expect(dark.city!.buildings.every((b) => !b.language)).toBe(true);
    const items = buildDrawList(lit, [], () => false, 0).filter((d) => d.t === "neon");
    expect(items.map((d) => d.t === "neon" && d.language)).toEqual(["rust", "typescript"]);
  });

  it("by day: an orange RUST in tubes on dark glass, hanging off gazelle' right wall", () => {
    const ctx = paint(lit, noon, t);
    const [r, g, b] = at(ctx, tx, ty);
    expect(r).toBeGreaterThan(200);
    expect(r > g && g > b).toBe(true);
    expect(lum(at(ctx, glass[0], glass[1]))).toBeLessThan(60);
    // The street with no language: no sign there at all — the gap's air shows instead.
    expect(at(paint(dark, noon, t), tx, ty)).not.toEqual([r, g, b]);
  });

  it("at night the tubes still shine on a darkened facade, and their light tints the wall and the sidewalk", () => {
    const withSign = paint(lit, night, t);
    const without = paint(dark, night, t);
    // The tube: still bright orange after the night grade.
    const tube = at(withSign, tx, ty);
    expect(lum(tube)).toBeGreaterThan(120);
    expect(tube[0]).toBeGreaterThan(200);
    // The wall beside the sign (mid-column, clear of the bracket): warmer and brighter in its light.
    const wall = [sign.wall - 8, sign.py + Math.floor(sign.ph / 2)];
    const [wr, , wb] = at(withSign, wall[0], wall[1]);
    const [nr, , nb] = at(without, wall[0], wall[1]);
    expect(wr).toBeGreaterThan(nr + 4);
    expect(wr - wb).toBeGreaterThan(nr - nb);
    // The sidewalk under the sign: a pool of orange.
    const walk = [sign.px + 6, lit.city!.street * 16 + 1];
    const [sr, , sb] = at(withSign, walk[0], walk[1]);
    const [or, , ob] = at(without, walk[0], walk[1]);
    expect(sr).toBeGreaterThan(or + 4);
    expect(sr - sb).toBeGreaterThan(or - ob);
  });

  it("by day it throws no light: the wall beside it is untouched", () => {
    const wall = [sign.wall - 8, sign.py + Math.floor(sign.ph / 2)];
    expect(at(paint(lit, noon, t), wall[0], wall[1])).toEqual(at(paint(dark, noon, t), wall[0], wall[1]));
  });

  it("the rooms stay exactly as lit: no neon light inside a floor", () => {
    const withSign = paint(lit, night, t);
    const without = paint(dark, night, t);
    for (const h of lit.houses) {
      const x = h.col * 16 * Z;
      const y = OY + h.row * 16 * Z;
      const w = h.w * 16 * Z;
      const hh = h.h * 16 * Z;
      expect(Array.from(withSign.getImageData(x, y, w, hh).data)).toEqual(Array.from(without.getImageData(x, y, w, hh).data));
    }
  });

  it("TypeScript's sign is blue", () => {
    const web = lit.city!.buildings.find((b) => b.key === "web")!;
    const ts = neonLayout({ ...neonAnchor(web), language: "typescript", building: "web" }) as NeonLayout;
    const [x, y] = ts.letters[0][0];
    const when = steady("web", 2);
    const [r, g, b] = at(paint(lit, noon, when), x, y);
    expect(NEON.typescript.label).toBe("TS");
    expect(b).toBeGreaterThan(r + 60);
    // The tube's own colour (a clear noon grades nothing) — not the blue sky behind where it hangs.
    const near = (p: number[], c: string) => p.every((v, i) => Math.abs(v - parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16)) <= 6);
    expect(near([r, g, b], NEON.typescript.letter)).toBe(true);
    expect(near(at(paint(dark, noon, when), x, y), NEON.typescript.letter)).toBe(false);
  });
});
