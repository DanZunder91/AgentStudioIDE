/** The backdrop alone at foggy noon with no time zone, so every pixel in the skyline's band is a
 * sky band's or the skyline's exact colour. Browser tier:
 * `npx vitest run --config vitest.browser.config.ts <this file>`. */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { citySky } from "../engine/ambience";
import { TILE, type Ambience, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { CITY, forEachSkylineBlock, paintCityBackdrop, paintCityNight, windowLit } from "./city";
import { sx, sy } from "./paint";
import { skylineMax } from "./skyline";

afterEach(() => {
  document.body.innerHTML = "";
});

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/** A low city: the Capacity HQ and two one-floor projects (a sky of 240 px). */
const low = buildCityWorld(
  [
    { key: "a", label: "a", team: 2, hasIde: true, floors: floorsOf("a", 1) },
    { key: "b", label: "b", team: 4, hasIde: true, floors: floorsOf("b", 1) },
  ],
  { seats: 64 },
);
/** The reference city: gazelle, seven floors of 26 seats, left of the HQ; chat-server, one floor, right (a sky of 976 px). */
const referenceCity = buildCityWorld(
  [
    { key: "chat-server", label: "chat-server", team: 2, hasIde: true, floors: floorsOf("t", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);
const horizonOf = (w: World) => w.city!.street * TILE;
const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

const fog = computeAmbience(new Date(2026, 9, 19, 12, 0), null, { weather: "fog", phase: "auto" });
/** A rainy night: lit windows, and neither stars nor a moon (rain hides both) to tell apart from them. */
const rain = computeAmbience(new Date(2026, 9, 19, 23, 0), null, { weather: "rain", phase: "auto" });
/** A clear night: stars. */
const clear = computeAmbience(new Date(2026, 9, 19, 23, 0), null, { weather: "clear", phase: "auto" });

const VW = 1280;
const VH = 400;

function canvas(): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = VW;
  c.height = VH;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

/** A camera at `zoom` with the street's top 60 px above the view's bottom, the view starting mid-block. */
const camAt = (w: World, zoom: number): Camera => ({ zoom, ox: -37, oy: Math.round(VH - 60 - horizonOf(w) * zoom) });

/** A world-px rect snapped like the renderer's (`paint.ts`), in the current style. */
function fillWorld(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  ctx.fillRect(x, y, Math.max(1, sx(cam, wx + w) - x), Math.max(1, sy(cam, wy + h) - y));
}

/** The world-x span the renderer walks for this camera (the view's left edge to its right). */
const spanOf = (cam: Camera) => [(0 - Math.round(cam.ox)) / cam.zoom, (VW - Math.round(cam.ox)) / cam.zoom] as const;

/** The blocks the renderer walks for this camera. */
function blocksOf(w: World, cam: Camera): { x: number; w: number; h: number }[] {
  const [x0, x1] = spanOf(cam);
  const out: { x: number; w: number; h: number }[] = [];
  forEachSkylineBlock(x0, x1, horizonOf(w), (x, bw, h) => out.push({ x, w: bw, h }));
  return out;
}

/** Is this pixel (of `d`, at byte `i`) one of the skyline's own colours by day? */
function isHaze(d: number[], i: number): boolean {
  const look = citySky(fog);
  return [look.skyline.block, look.skyline.edge, look.skyline.pane].map(rgbOf).some(([r, g, b]) => d[i] === r && d[i + 1] === g && d[i + 2] === b);
}

/** Reference: the sky bands and `blocks` painted the plain way (a rect per block and edge, 1×2 per
 * pane; zoomed out, a band per floor at half alpha) in `amb`'s sky colours. */
function reference(blocks: { x: number; w: number; h: number }[], horizon: number, cam: Camera, amb: Ambience): CanvasRenderingContext2D {
  const ctx = canvas();
  const look = citySky(amb);
  const n = look.bands.length;
  for (let i = 0; i < n; i++) {
    const top = i === 0 ? 0 : sy(cam, (horizon * i) / n);
    ctx.fillStyle = look.bands[i];
    ctx.fillRect(0, top, VW, sy(cam, (horizon * (i + 1)) / n) - top);
  }
  for (const b of blocks) {
    ctx.fillStyle = look.skyline.block;
    fillWorld(ctx, cam, b.x, horizon - b.h, b.w - 1, b.h);
    ctx.fillStyle = look.skyline.edge;
    fillWorld(ctx, cam, b.x, horizon - b.h, b.w - 1, 1);
  }
  ctx.fillStyle = look.skyline.pane;
  if (cam.zoom < 0.75) ctx.globalAlpha = 0.5;
  for (const b of blocks)
    for (let y = horizon - b.h + 3; y < horizon - 3; y += 5)
      if (cam.zoom < 0.75) fillWorld(ctx, cam, b.x + 2, y, b.w - 5, 2);
      else for (let x = b.x + 2; x < b.x + b.w - 3; x += 4) fillWorld(ctx, cam, x, y, 1, 2);
  ctx.globalAlpha = 1;
  return ctx;
}

/** The backdrop as the renderer paints it. */
function backdrop(w: World, cam: Camera, amb: Ambience): CanvasRenderingContext2D {
  const ctx = canvas();
  paintCityBackdrop(ctx, amb, w, cam, { w: VW, h: VH }, 0, null);
  return ctx;
}

/** Rows [y0, y1) of the view, every channel. */
const rows = (ctx: CanvasRenderingContext2D, y0: number, y1: number) => Array.from(ctx.getImageData(0, y0, VW, y1 - y0).data);

/** The first byte where two pictures differ, as "x,y: [rgba] vs [rgba]" (null: identical). */
function firstDiff(a: number[], b: number[], y0: number): string | null {
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      const p = i - (i % 4);
      return `${(p / 4) % VW},${y0 + Math.floor(p / 4 / VW)}: [${a.slice(p, p + 4)}] vs [${b.slice(p, p + 4)}]`;
    }
  return null;
}


describe("the far skyline in a real canvas", () => {
  it("a low city's skyline is its blocks painted the plain way, a pane at a time — and never over 3 tiles — at ½, ¾, 1, 1.5 and 3", () => {
    const horizon = horizonOf(low);
    expect(skylineMax(horizon)).toBe(48);
    for (const zoom of [0.5, 0.75, 1, 1.5, 3]) {
      const cam = camAt(low, zoom);
      const blocks = blocksOf(low, cam);
      expect(Math.max(...blocks.map((b) => b.h))).toBeLessThanOrEqual(48);
      // Everything from 4 tiles above the street (well over 3) down to it.
      const y0 = Math.max(0, sy(cam, horizon - 4 * TILE));
      const y1 = sy(cam, horizon);
      const got = rows(backdrop(low, cam, fog), y0, y1);
      expect(firstDiff(got, rows(reference(blocks, horizon, cam, fog), y0, y1), y0), `zoom ${zoom}`).toBeNull();
      // Nothing of it above 3 tiles, and not vacuous: the band below holds the haze, panes among it.
      const cap = sy(cam, horizon - 3 * TILE) - y0;
      const pane = rgbOf(citySky(fog).skyline.pane);
      let panes = 0;
      for (let i = 0; i < got.length; i += 4) {
        if (Math.floor(i / 4 / VW) < cap && isHaze(got, i)) throw new Error(`zoom ${zoom}: haze above 3 tiles at ${(i / 4) % VW}`);
        if (got[i] === pane[0] && got[i + 1] === pane[1] && got[i + 2] === pane[2]) panes++;
      }
      if (zoom >= 0.75) expect(panes, `zoom ${zoom}`).toBeGreaterThan(200);
    }
  });

  it("a tall city's skyline reaches skylineMax (144 px over a 976-px sky), and is its own blocks painted a pane at a time", () => {
    const horizon = horizonOf(referenceCity);
    expect(skylineMax(horizon)).toBe(144);
    const look = citySky(fog);
    const haze = [look.skyline.block, look.skyline.edge, look.skyline.pane].map(rgbOf);
    for (const zoom of [1, 2]) {
      const cam = camAt(referenceCity, zoom);
      const ctx = backdrop(referenceCity, cam, fog);
      // The highest skyline pixel in the view, in world px above the street.
      const y0 = 0;
      const y1 = sy(cam, horizon);
      const d = rows(ctx, y0, y1);
      let topRow = y1;
      for (let i = 0; i < d.length; i += 4) {
        const y = Math.floor(i / 4 / VW);
        if (y < topRow && haze.some(([r, g, b]) => d[i] === r && d[i + 1] === g && d[i + 2] === b)) topRow = y;
      }
      const reach = (y1 - topRow) / zoom;
      expect(reach, `zoom ${zoom}`).toBeLessThanOrEqual(144);
      expect(reach, `zoom ${zoom}`).toBeGreaterThan(130);
      // …and that is the skyline the walk describes, painted plainly.
      const band = Math.max(0, sy(cam, horizon - 160));
      expect(firstDiff(rows(ctx, band, y1), rows(reference(blocksOf(referenceCity, cam), horizon, cam, fog), band, y1), band), `zoom ${zoom}`).toBeNull();
    }
  });

  it("moves exactly with the street: panned 50 or 200 px, at zoom 1 and 2.5, the reference city's skyline is the same picture moved by exactly the pan", () => {
    const horizon = horizonOf(referenceCity);
    for (const zoom of [1, 2.5])
      for (const n of [50, 200]) {
        const a = { zoom, ox: -100, oy: Math.round(VH - 60 - horizon * zoom) };
        const b = { ...a, ox: a.ox - n * zoom };
        const y0 = Math.max(0, sy(a, horizon - skylineMax(horizon)));
        const y1 = sy(a, horizon);
        const [pa, pb] = [rows(backdrop(referenceCity, a, fog), y0, y1), rows(backdrop(referenceCity, b, fog), y0, y1)];
        const d = n * zoom;
        let haze = 0;
        for (let y = 0; y < y1 - y0; y++)
          for (let x = d; x < VW; x++) {
            const i = (y * VW + x) * 4;
            const j = (y * VW + x - d) * 4;
            if (pa[i] !== pb[j] || pa[i + 1] !== pb[j + 1] || pa[i + 2] !== pb[j + 2] || pa[i + 3] !== pb[j + 3])
              throw new Error(`zoom ${zoom}, panned ${n}: ${x},${y0 + y} moved`);
            if (isHaze(pa, i)) haze++;
          }
        expect(haze, `zoom ${zoom}, panned ${n}`).toBeGreaterThan(10_000);
      }
  });

  it("…and zoomed 1 → 2.5 around gazelle (its middle, its right wall) or the HQ, every block and every gap of sky between two stays on the same world x", () => {
    const horizon = horizonOf(referenceCity);
    const [g, hq] = [referenceCity.city!.buildings.find((b) => b.key === "gazelle")!, referenceCity.city!.buildings.find((b) => b.hq)!];
    // Wheel-zoom anchors 60 px above the street, kept at a screen point as a wheel zoom keeps them (two
    // pointer positions: the view's left edge moves by a different world distance for each).
    for (const [px, ax] of [[500, (g.col + g.w / 2) * TILE], [777, (g.col + g.w) * TILE + 37], [500, (hq.col + hq.w / 2) * TILE]]) {
      const ay = horizon - 60;
      const at = (zoom: number): Camera => ({ zoom, ox: Math.round(px - ax * zoom), oy: Math.round(200 - ay * zoom) });
      const [one, near] = [at(1), at(2.5)];
      // A row 20 px above the street, where every block's face stands (a block is ≥ 50 px tall here).
      const probe = horizon - 20;
      const row = (cam: Camera) => rows(backdrop(referenceCity, cam, fog), sy(cam, probe), sy(cam, probe) + 1);
      const [r1, r2] = [row(one), row(near)];
      let gaps = 0;
      let faces = 0;
      for (let wx = Math.ceil(spanOf(near)[0]); wx < Math.floor(spanOf(near)[1]); wx++) {
        const face = isHaze(r1, sx(one, wx) * 4);
        expect(isHaze(r2, sx(near, wx) * 4), `anchor ${ax}, world x ${wx}`).toBe(face);
        if (face) faces++;
        else gaps++;
      }
      expect(gaps).toBeGreaterThan(8);
      expect(faces).toBeGreaterThan(400);
    }
  });

  it("at night every lit window lands on a block's pane — up its taller floors, never on open sky", () => {
    for (const w of [low, referenceCity]) {
      const horizon = horizonOf(w);
      const cam = camAt(w, 1);
      const day = rows(backdrop(w, cam, fog), 0, VH);
      const night = canvas();
      paintCityNight(night, rain, w, cam, { w: VW, h: VH }, 0);
      const n = rows(night, 0, VH);
      const win = rgbOf(CITY.window);
      const pane = rgbOf(citySky(fog).skyline.pane);
      let lit = 0;
      let high = 0;
      for (let i = 0; i < n.length; i += 4) {
        if (n[i + 3] === 0) continue;
        // Nothing but lit windows tonight (rain: no stars, no moon; no zone: no landmark lights).
        expect([n[i], n[i + 1], n[i + 2], n[i + 3]]).toEqual([...win, 255]);
        expect([day[i], day[i + 1], day[i + 2]], `${(i / 4) % VW},${Math.floor(i / 4 / VW)}`).toEqual(pane);
        lit++;
        if (Math.floor(i / 4 / VW) < sy(cam, horizon - 3 * TILE)) high++;
      }
      expect(lit).toBeGreaterThan(100);
      // In the tall city most of them are higher than the old skyline ever reached.
      if (w === referenceCity) expect(high).toBeGreaterThan(lit / 3);
      else expect(high).toBe(0);
      // A window's threshold is its own: the lit set is a share of the panes, not all of them.
      const [x0, x1] = spanOf(cam);
      let total = 0;
      forEachSkylineBlock(x0, x1, horizon, (bx, bw, bh) => {
        for (let y = horizon - bh + 3; y < horizon - 3; y += 5) for (let x = bx + 2; x < bx + bw - 3; x += 4) total += windowLit(x, y, 1) ? 1 : 0;
      });
      expect(lit / 2).toBeLessThan(total * 0.8);
    }
  });

  it("no star shines in front of a block, in a low city or a tall one — though stars shine in the skyline's band, over its gaps and lower blocks", () => {
    for (const w of [low, referenceCity]) {
      const horizon = horizonOf(w);
      const cam = camAt(w, 1);
      const day = rows(backdrop(w, cam, fog), 0, VH);
      const night = canvas();
      paintCityNight(night, clear, w, cam, { w: VW, h: VH }, 0);
      const n = rows(night, 0, VH);
      let stars = 0;
      let low = 0;
      for (let i = 0; i < n.length; i += 4) {
        // A star's pale white (the moon's disc is creamier, its glow bluer, a lit window yellow).
        if (n[i + 3] === 0 || n[i] < 236 || n[i + 1] < 236 || n[i + 2] < 236) continue;
        stars++;
        expect(isHaze(day, i), `a star on a block at ${(i / 4) % VW},${Math.floor(i / 4 / VW)}`).toBe(false);
        if (Math.floor(i / 4 / VW) >= sy(cam, horizon - skylineMax(horizon))) low++;
      }
      expect(stars).toBeGreaterThan(20);
      expect(low).toBeGreaterThan(0);
    }
  });
});
