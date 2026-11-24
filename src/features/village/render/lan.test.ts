/**
 * The Seats room's LAN art: a cable is 2 px across (a lit edge over a dark core) and covers
 * exactly its run plus a half-width cap at each end; a team packet is a bright square in its
 * team's hue inside a dark rim; an uplink packet is a smaller, paler, see-through glint — and
 * nothing off-screen is painted.
 */

import { describe, expect, it } from "vitest";

import type { DrawItem } from "../villageTypes";
import { hslToRgb, tintToCss } from "./colorize";
import { CABLE, CABLE_W, drawCable, drawPacket, drawWifi, PACKET, WIFI, wifiColors, wifiRadius } from "./lan";
import { recorder } from "./testRecorder";
import { FLOOR_TINTS } from "./tiles";

const cam = { zoom: 1, ox: 0, oy: 0 };
const VIEW = { w: 400, h: 300 };

type Fill = { args: number[]; style: string };

function cable(x0: number, y0: number, x1: number, y1: number, zoom = 1, view = VIEW): Fill[] {
  const ctx = recorder();
  drawCable(ctx, { ...cam, zoom }, { t: "cable", x0, y0, x1, y1 }, view);
  return ctx.of("fillRect").map((c) => ({ args: c.args as number[], style: c.fillStyle }));
}

function packet(kind: "team" | "uplink", x: number, y: number, hue = 120, zoom = 1, view = VIEW): Fill[] {
  const item: DrawItem = { t: "packet", x, y, kind, hue };
  const ctx = recorder();
  drawPacket(ctx, { ...cam, zoom }, item, view);
  return ctx.of("fillRect").map((c) => ({ args: c.args as number[], style: c.fillStyle }));
}

/** Every screen pixel a list of fills covers, as "x,y". */
function pixels(fills: Fill[]): Set<string> {
  const out = new Set<string>();
  for (const { args: [x, y, w, h] } of fills)
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) out.add(`${i},${j}`);
  return out;
}

/** "#rrggbb" or "rgb(r, g, b)" → [r, g, b]. */
function rgbOf(css: string): number[] {
  if (css.startsWith("#")) return [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));
  return css.match(/\d+/g)!.slice(0, 3).map(Number);
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, ≥ 1. */
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** "hsl(h, s%, l%)" / "hsla(h, s%, l%, a)" → its parts. */
function hsl(css: string): { h: number; s: number; l: number; a: number } {
  const m = css.match(/^hsla?\((-?[\d.]+), ([\d.]+)%, ([\d.]+)%(?:, ([\d.]+))?\)$/);
  if (!m) throw new Error(`not an hsl colour: ${css}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

describe("drawCable", () => {
  it("a horizontal run: exactly its length plus a 1-px cap each end, 2 px across — the lit edge on top, the core under it", () => {
    const expected = [
      { args: [9, 19, 32, 1], style: CABLE.shine },
      { args: [9, 20, 32, 1], style: CABLE.core },
    ];
    expect(cable(10, 20, 40, 20)).toEqual(expected);
    expect(cable(40, 20, 10, 20)).toEqual(expected); // either direction
    expect(CABLE_W).toBe(2);
  });

  it("a vertical run: the lit edge on the left, the core on the right", () => {
    const expected = [
      { args: [29, 4, 1, 42], style: CABLE.shine },
      { args: [30, 4, 1, 42], style: CABLE.core },
    ];
    expect(cable(30, 5, 30, 45)).toEqual(expected);
    expect(cable(30, 45, 30, 5)).toEqual(expected);
  });

  it("two runs meeting at a corner close the joint — no notch, nothing outside the two cables", () => {
    const px = pixels([...cable(10, 20, 40, 20), ...cable(40, 20, 40, 60)]);
    for (const p of ["39,19", "40,19", "39,20", "40,20"]) expect(px.has(p)).toBe(true);
    // 32×2 + 2×42 − the shared 2×2 corner.
    expect(px.size).toBe(64 + 84 - 4);
  });

  it("reads on every room floor and the door threshold: both colours darker than every floor tint, the core by ≥ 3:1", () => {
    const core = rgbOf(CABLE.core);
    const shine = rgbOf(CABLE.shine);
    expect(luminance(core)).toBeLessThan(luminance(shine));
    for (const tint of FLOOR_TINTS) {
      const floor = rgbOf(tintToCss(tint));
      expect(luminance(shine)).toBeLessThan(luminance(floor));
      expect(contrast(core, floor)).toBeGreaterThanOrEqual(3);
    }
  });

  it("scales with the zoom; at ½ (the Village's Fit floor) the core is painted last, so it is the row that shows", () => {
    expect(cable(10, 20, 40, 20, 2).map((f) => f.args)).toEqual([
      [18, 38, 64, 2],
      [18, 40, 64, 2],
    ]);
    // Rows 20 (lit edge) and 21 (core) both snap to screen row 10 at ½.
    const half = cable(10, 21, 40, 21, 0.5);
    expect(half.map((f) => f.args[1])).toEqual([10, 10]);
    expect(half.at(-1)!.style).toBe(CABLE.core);
    for (const f of half) expect(f.args[3]).toBeGreaterThanOrEqual(1);
    // A vertical run the same way: its core column last.
    expect(cable(21, 10, 21, 40, 0.5).at(-1)!.style).toBe(CABLE.core);
  });

  it("paints nothing off-screen; a run that crosses the edge still paints", () => {
    expect(cable(-100, 20, -10, 20)).toEqual([]);
    expect(cable(10, 500, 40, 500)).toEqual([]);
    expect(cable(500, 10, 500, 40)).toEqual([]);
    expect(cable(-100, 20, 50, 20)).toHaveLength(2);
    expect(cable(30, -50, 30, 10)).toHaveLength(2);
  });
});

describe("drawPacket", () => {
  it("a team packet: a 3×3 body inside a 1-px rim, centred on (x, y) — the body painted last", () => {
    const fills = packet("team", 20, 30, 200);
    expect(fills.map((f) => f.args)).toEqual([
      [18, 28, 5, 5],
      [19, 29, 3, 3],
    ]);
    expect(PACKET).toMatchObject({ body: 3, rim: 1 });
    const [rim, body] = fills.map((f) => hsl(f.style));
    expect(body.l).toBeGreaterThan(rim.l);
  });

  it("its colour follows the team's hue — two hues, two colours — with a much darker rim of the same hue", () => {
    const a = packet("team", 20, 30, 30);
    const b = packet("team", 20, 30, 200);
    expect(a[1].style).not.toBe(b[1].style);
    expect(hsl(a[1].style).h).toBe(30);
    expect(hsl(b[1].style).h).toBe(200);
    expect(hsl(a[0].style).h).toBe(30);
    expect(hsl(b[0].style).h).toBe(200);
  });

  it("whatever the hue, the body stands ≥ 3:1 off the cable's core and off its own rim", () => {
    const core = rgbOf(CABLE.core);
    for (let hue = 0; hue < 360; hue += 15) {
      const [rim, body] = packet("team", 20, 30, hue).map((f) => hsl(f.style));
      const bodyRgb = hslToRgb(body.h, body.s / 100, body.l / 100);
      expect(contrast(bodyRgb, core)).toBeGreaterThanOrEqual(3);
      expect(contrast(bodyRgb, hslToRgb(rim.h, rim.s / 100, rim.l / 100))).toBeGreaterThanOrEqual(3);
    }
  });

  it("an uplink is quieter: a 2×2 dot exactly over the cable, no rim, paler, less saturated and see-through", () => {
    const up = packet("uplink", 20, 30, 200);
    expect(up.map((f) => f.args)).toEqual([[19, 29, 2, 2]]);
    // The same 2 px across as the cable centred on that row.
    const run = pixels(cable(10, 30, 40, 30));
    for (const p of pixels(up)) expect(run.has(p)).toBe(true);
    const quiet = hsl(up[0].style);
    const loud = hsl(packet("team", 20, 30, 200)[1].style);
    expect(quiet.h).toBe(200);
    expect(quiet.l).toBeGreaterThan(loud.l);
    expect(quiet.s).toBeLessThan(loud.s);
    expect(quiet.a).toBeLessThan(1);
    expect(pixels(up).size).toBeLessThan(pixels(packet("team", 20, 30, 200)).size);
  });

  it("scales with the zoom; at ½ each keeps a whole pixel and the team body is painted last", () => {
    expect(packet("team", 20, 30, 200, 2).map((f) => f.args)).toEqual([
      [36, 56, 10, 10],
      [38, 58, 6, 6],
    ]);
    expect(packet("uplink", 20, 30, 200, 2).map((f) => f.args)).toEqual([[38, 58, 4, 4]]);
    const half = packet("team", 21, 31, 200, 0.5);
    expect(half.at(-1)!.style).toBe(packet("team", 21, 31, 200)[1].style); // the body, not the rim
    for (const f of [...half, ...packet("uplink", 21, 31, 200, 0.5)]) {
      expect(f.args[2]).toBeGreaterThanOrEqual(1);
      expect(f.args[3]).toBeGreaterThanOrEqual(1);
    }
  });

  it("paints nothing off-screen; one whose rim alone is in view still paints", () => {
    expect(packet("team", -10, 30)).toEqual([]);
    expect(packet("team", 20, 400)).toEqual([]);
    expect(packet("uplink", 20, -5)).toEqual([]);
    expect(packet("uplink", 401, 30)).toEqual([]);
    expect(packet("team", -1, 30)).toHaveLength(2);
    expect(packet("uplink", 0, 30)).toHaveLength(1);
  });
});

describe("drawWifi — a Wi-Fi pulse (a project room's boss ↔ its router)", () => {
  function wifi(x: number, y: number, phase: number, hue = 200, zoom = 1, view = VIEW): Fill[] {
    const ctx = recorder();
    drawWifi(ctx, { ...cam, zoom }, { t: "wifi", x, y, phase, hue }, view);
    return ctx.of("fillRect").map((c) => ({ args: c.args as number[], style: c.fillStyle }));
  }
  /** The cells (world = screen px at zoom 1) of one colour, as [dx, dy] from (x, y). */
  const cells = (fills: Fill[], style: string, x: number, y: number): number[][] =>
    [...pixels(fills.filter((f) => f.style === style))].map((k) => k.split(",").map(Number)).map(([a, b]) => [a - x, b - y]);
  const radiusOf = (c: number[][]) => Math.max(...c.map(([dx]) => dx));

  it("the radius grows with the phase in whole px, from WIFI.minR just sent to WIFI.maxR fully spread", () => {
    expect(wifiRadius(0)).toBe(WIFI.minR);
    expect(wifiRadius(1)).toBe(WIFI.maxR);
    expect(WIFI.maxR).toBeLessThanOrEqual(16); // a pulse stays about a tile across
    let last = 0;
    for (let p = 0; p <= 1; p += 0.05) {
      const r = wifiRadius(p);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(wifiRadius(-3)).toBe(WIFI.minR);
    expect(wifiRadius(7)).toBe(WIFI.maxR);
  });

  it("is a closed 1-px ring of that radius round (x, y), a dark rim one px further out — the ring painted last", () => {
    for (const phase of [0, 0.3, 0.6, 0.95]) {
      const r = wifiRadius(phase);
      const f = wifi(100, 80, phase);
      const c = wifiColors(200, phase);
      const ring = cells(f, c.ring, 100, 80);
      const rim = cells(f, c.rim, 100, 80);
      expect(radiusOf(ring)).toBe(r);
      expect(radiusOf(rim)).toBe(r + 1);
      // Every cell lies on its circle, within half a pixel; the four compass cells are there.
      for (const [dx, dy] of ring) expect(Math.abs(Math.hypot(dx, dy) - r)).toBeLessThanOrEqual(0.5);
      for (const [dx, dy] of rim) expect(Math.abs(Math.hypot(dx, dy) - (r + 1))).toBeLessThanOrEqual(0.5);
      const has = (set: number[][], dx: number, dy: number) => set.some(([a, b]) => a === dx && b === dy);
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) expect(has(ring, dx, dy)).toBe(true);
      // Closed: every cell has a ring neighbour on each side (8-connected), so no gap breaks it.
      for (const [dx, dy] of ring) {
        const n = ring.filter(([a, b]) => (a !== dx || b !== dy) && Math.abs(a - dx) <= 1 && Math.abs(b - dy) <= 1).length;
        expect(n).toBeGreaterThanOrEqual(2);
      }
      // The rim never paints over the ring, and the ring's rects come after every rim rect.
      expect(ring.filter(([a, b]) => has(rim, a, b))).toEqual([]);
      const lastRim = f.map((x) => x.style).lastIndexOf(c.rim);
      expect(f.slice(lastRim + 1).every((x) => x.style === c.ring)).toBe(true);
      expect(f.at(-1)!.style).toBe(c.ring);
      // Pixel rects only: one row each.
      for (const x of f) expect(x.args[3]).toBe(1);
    }
  });

  it("fades as it spreads: fully opaque just sent, ever fainter, gone at 1 (and for a phase that is not a number)", () => {
    const alphas = [0, 0.25, 0.5, 0.75, 0.99].map((p) => hsl(wifiColors(200, p).ring).a);
    expect(alphas[0]).toBe(1);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThan(alphas[i - 1]);
    const rims = [0, 0.5, 0.99].map((p) => hsl(wifiColors(200, p).rim).a);
    expect(rims[1]).toBeLessThan(rims[0]);
    expect(rims[2]).toBeLessThan(rims[1]);
    // What is painted is what was computed for that phase.
    expect(new Set(wifi(100, 80, 0.5).map((x) => x.style))).toEqual(new Set(Object.values(wifiColors(200, 0.5))));
    expect(wifi(100, 80, 1)).toEqual([]);
    expect(wifi(100, 80, 1.5)).toEqual([]);
    expect(wifi(100, 80, Number.NaN)).toEqual([]);
    expect(wifi(100, 80, 0.999).length).toBeGreaterThan(0);
  });

  it("takes the team's hue — two hues, two colours — a pale ring over a dark rim, ≥ 3:1 apart at every hue", () => {
    const a = wifiColors(30, 0);
    const b = wifiColors(200, 0);
    expect(a.ring).not.toBe(b.ring);
    expect(hsl(a.ring).h).toBe(30);
    expect(hsl(a.rim).h).toBe(30);
    expect(hsl(b.ring).h).toBe(200);
    expect(hsl(b.rim).h).toBe(200);
    for (let hue = 0; hue < 360; hue += 15) {
      const { ring, rim } = wifiColors(hue, 0);
      const r = hsl(ring);
      const m = hsl(rim);
      expect(r.l).toBeGreaterThanOrEqual(70); // pale
      expect(m.l).toBeLessThan(r.l);
      expect(contrast(hslToRgb(r.h, r.s / 100, r.l / 100), hslToRgb(m.h, m.s / 100, m.l / 100))).toBeGreaterThanOrEqual(3);
    }
  });

  it("scales with the zoom; at ½ every rect keeps a whole pixel and the ring still comes last", () => {
    const one = wifi(100, 80, 0.3);
    const two = wifi(100, 80, 0.3, 200, 2);
    expect(two.map((x) => x.args)).toEqual(one.map((x) => x.args.map((v) => v * 2)));
    const half = wifi(101, 81, 0.3, 200, 0.5);
    for (const x of half) {
      expect(x.args[2]).toBeGreaterThanOrEqual(1);
      expect(x.args[3]).toBeGreaterThanOrEqual(1);
    }
    expect(half.at(-1)!.style).toBe(wifiColors(200, 0.3).ring);
  });

  it("paints nothing off-screen; one whose rim alone is in view still paints", () => {
    const r = wifiRadius(0.3);
    expect(wifi(-r - 3, 80, 0.3)).toEqual([]);
    expect(wifi(100, VIEW.h + r + 2, 0.3)).toEqual([]);
    expect(wifi(VIEW.w + r + 2, 80, 0.3)).toEqual([]);
    expect(wifi(100, -r - 3, 0.3)).toEqual([]);
    expect(wifi(-r - 1, 80, 0.3).length).toBeGreaterThan(0);
    expect(wifi(100, VIEW.h + r, 0.3).length).toBeGreaterThan(0);
  });
});
