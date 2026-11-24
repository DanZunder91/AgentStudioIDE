import { describe, expect, it } from "vitest";

import type { Camera } from "./camera";
import { recorder, type DrawCall } from "./testRecorder";
import {
  drawSakura,
  drawTorii,
  drawVending,
  PETAL_COLUMN,
  PETAL_PERIOD,
  PETALS,
  SAKURA,
  sakuraPetals,
  TORII,
  TORII_HEIGHT,
  TORII_PILLARS,
  VENDING,
  VENDING_GLOW,
  vendingGlow,
  vendingGlowBox,
  vendingVariant,
} from "./tokyoProps";

const cam: Camera = { zoom: 1, ox: 0, oy: 0 };
const X0 = 32;
const BOTTOM = 96;

/** A fill as a world-px box (zoom 1, no offset: screen px are world px). */
const box = (c: DrawCall) => {
  const [x, y, w, h] = c.args as number[];
  return { x, y, w, h, color: c.fillStyle };
};
const fills = (draw: (ctx: ReturnType<typeof recorder>) => void) => {
  const ctx = recorder();
  draw(ctx);
  return ctx.of("fillRect").map(box);
};
const within = (b: { x: number; y: number; w: number; h: number }, left: number, top: number, right: number, bottom: number) =>
  b.x >= left && b.y >= top && b.x + b.w <= right && b.y + b.h <= bottom;
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const lum = (c: string) => {
  const [r, g, b] = rgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("sakuraPetals — the falling petals", () => {
  it("a handful per tree, each 1–2 px, pink, inside the fall column under the canopy", () => {
    for (const t of [0, 0.37, 1.2, 2.9, 3.99, 17.5, -3.3]) {
      const petals = sakuraPetals(X0, BOTTOM, t);
      expect(petals).toHaveLength(PETALS);
      for (const p of petals) {
        expect(p.w * p.h).toBeGreaterThanOrEqual(1);
        expect(p.w * p.h).toBeLessThanOrEqual(2);
        expect([SAKURA.petal, SAKURA.petalPale]).toContain(p.color);
        expect(within(p, X0 + PETAL_COLUMN.left, BOTTOM + PETAL_COLUMN.top, X0 + PETAL_COLUMN.right, BOTTOM + PETAL_COLUMN.bottom), `t=${t} ${JSON.stringify(p)}`).toBe(true);
      }
    }
  });

  it("they move with time: half a second later most petals are somewhere else", () => {
    for (const t of [0, 0.8, 2.25]) {
      const a = sakuraPetals(X0, BOTTOM, t);
      const b = sakuraPetals(X0, BOTTOM, t + 0.5);
      const moved = a.filter((p, i) => p.x !== b[i].x || p.y !== b[i].y).length;
      expect(moved, `t=${t}`).toBeGreaterThanOrEqual(PETALS / 2);
    }
  });

  it("they loop: exactly the same petals one period later, and every period after", () => {
    for (const t of [0.1, 1.3, 2.7, 3.6]) {
      expect(sakuraPetals(X0, BOTTOM, t + PETAL_PERIOD)).toEqual(sakuraPetals(X0, BOTTOM, t));
      expect(sakuraPetals(X0, BOTTOM, t + 5 * PETAL_PERIOD)).toEqual(sakuraPetals(X0, BOTTOM, t));
    }
  });

  it("each petal falls from the canopy to the ground — down all the way, drifting sideways and swaying — then rests there", () => {
    const steps = 400;
    for (let k = 0; k < PETALS; k++) {
      const track = Array.from({ length: steps }, (_, i) => sakuraPetals(X0, BOTTOM, (i * PETAL_PERIOD) / steps)[k]);
      const ys = track.map((p) => p.y);
      expect(Math.min(...ys), `petal ${k} starts up in the canopy`).toBeLessThanOrEqual(BOTTOM - 19);
      expect(Math.max(...ys), `petal ${k} lands on the ground`).toBeGreaterThanOrEqual(BOTTOM - 3);
      // Down only: from its highest point the y never decreases until it is back at the top.
      const start = ys.indexOf(Math.min(...ys));
      const cycle = [...ys.slice(start), ...ys.slice(0, start)];
      let jumps = 0;
      for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[i - 1]) jumps++;
      expect(jumps, `petal ${k} only ever falls`).toBe(0);
      // Sideways: its x changes direction (sways) and it spends a while lying still on the ground.
      // (x is whole px: compare the moves it actually makes, skipping the samples where it stays put.)
      const moves = track.slice(1).map((p, i) => Math.sign(p.x - track[i].x)).filter((s) => s !== 0);
      const turns = moves.slice(1).filter((s, i) => s !== moves[i]).length;
      expect(turns, `petal ${k} sways`).toBeGreaterThanOrEqual(2);
      expect(moves.filter((s) => s > 0).length, `petal ${k} drifts right on the whole`).toBeGreaterThan(moves.filter((s) => s < 0).length);
      const still = track.filter((p, i) => i > 0 && p.x === track[i - 1].x && p.y === track[i - 1].y && p.y >= BOTTOM - 3).length;
      expect(still, `petal ${k} rests on the ground`).toBeGreaterThan(steps * 0.1);
    }
  });

  it("never in step: the petals of one tree are at different points of their fall, and two trees differ", () => {
    const a = sakuraPetals(X0, BOTTOM, 1);
    expect(new Set(a.map((p) => p.y)).size).toBeGreaterThan(2);
    const b = sakuraPetals(X0 + 64, BOTTOM, 1).map((p) => ({ ...p, x: p.x - 64 }));
    expect(b).not.toEqual(a);
  });
});

describe("drawSakura", () => {
  const all = fills((ctx) => drawSakura(ctx, cam, X0, BOTTOM, 1.5));
  const petals = sakuraPetals(X0, BOTTOM, 1.5);
  const tree = all.slice(0, all.length - PETALS);

  it("a pink canopy in layers — deep shade underneath, pink, light, pale, white blossoms — on a dark trunk", () => {
    const colours = new Set(tree.map((b) => b.color));
    for (const c of [SAKURA.deep, SAKURA.shade, SAKURA.pink, SAKURA.light, SAKURA.pale, SAKURA.white, SAKURA.trunk, SAKURA.bark]) expect(colours).toContain(c);
    // Pinks: red over green and blue, every layer; the trunk is dark.
    for (const c of [SAKURA.shade, SAKURA.pink, SAKURA.light, SAKURA.pale]) {
      const [r, g, b] = rgb(c);
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThanOrEqual(b);
    }
    expect(lum(SAKURA.trunk)).toBeLessThan(60);
    // The shade is under the pink: its lowest row is below the pink's.
    const low = (c: string) => Math.max(...tree.filter((b) => b.color === c).map((b) => b.y + b.h));
    expect(low(SAKURA.shade)).toBeGreaterThan(low(SAKURA.pink));
    // Lighter towards the top: the pale layer's highest row is above the shade's.
    const high = (c: string) => Math.min(...tree.filter((b) => b.color === c).map((b) => b.y));
    expect(high(SAKURA.pale)).toBeLessThan(high(SAKURA.shade));
  });

  it("the trunk is crooked — its segments do not all stand in one column — and the canopy is painted over its top", () => {
    const trunk = tree.filter((b) => b.color === SAKURA.trunk && b.w <= 7 && b.h >= 5);
    expect(new Set(trunk.map((b) => b.x)).size).toBeGreaterThanOrEqual(3);
    const firstCanopy = tree.findIndex((b) => b.color === SAKURA.shade);
    const lastTrunkBody = Math.max(...trunk.map((b) => tree.indexOf(b)));
    expect(lastTrunkBody).toBeLessThan(firstCanopy);
  });

  it("the falling petals are painted last, over the canopy, exactly where sakuraPetals puts them", () => {
    expect(all.slice(-PETALS)).toEqual(petals.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, color: p.color })));
  });

  it("stays inside its art: the 2×2 footprint and the canopy ~5 px above it; the petals inside their column", () => {
    for (const b of tree) expect(within(b, X0, BOTTOM - 37, X0 + 32, BOTTOM), JSON.stringify(b)).toBe(true);
    expect(Math.min(...tree.map((b) => b.y))).toBe(BOTTOM - 37);
  });

  it("only the petals move: two times paint the same tree, different petals", () => {
    const later = fills((ctx) => drawSakura(ctx, cam, X0, BOTTOM, 2.1));
    expect(later.slice(0, later.length - PETALS)).toEqual(tree);
    expect(later.slice(-PETALS)).not.toEqual(all.slice(-PETALS));
  });
});

describe("drawVending", () => {
  const paint = (variant: number, lightsOn: boolean) => fills((ctx) => drawVending(ctx, cam, X0, BOTTOM, variant, lightsOn));

  it("variant 0 is the blue machine, 1 the red one — the body is the largest fill", () => {
    for (const v of [0, 1] as const) {
      const body = paint(v, false).reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      expect(body.color).toBe(VENDING.body[v].base);
    }
    const [br, , bb] = rgb(VENDING.body[0].base);
    expect(bb).toBeGreaterThan(br);
    const [rr, , rb] = rgb(VENDING.body[1].base);
    expect(rr).toBeGreaterThan(rb);
  });

  it("a lit window of bottles: three shelves of five, a cap on each, at least four drink colours", () => {
    const f = paint(0, false);
    const bottles = f.filter((b) => b.w === 1 && b.h === 2 && (VENDING.bottles as readonly string[]).includes(b.color));
    expect(bottles).toHaveLength(15);
    expect(new Set(bottles.map((b) => b.color)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(bottles.map((b) => b.y)).size).toBe(3);
    for (const b of bottles) expect(f.some((c) => c.color === VENDING.cap && c.x === b.x && c.y === b.y - 1)).toBe(true);
    const glass = f.find((b) => b.color === VENDING.glassDay)!;
    for (const b of bottles) expect(within(b, glass.x, glass.y, glass.x + glass.w, glass.y + glass.h)).toBe(true);
    // The red machine stocks them in another order.
    const red = paint(1, false).filter((b) => b.w === 1 && b.h === 2 && (VENDING.bottles as readonly string[]).includes(b.color));
    expect(red.map((b) => b.color)).not.toEqual(bottles.map((b) => b.color));
  });

  it("the window stands out from the body, and is brighter at night; the buttons light up at night", () => {
    for (const v of [0, 1]) {
      expect(lum(VENDING.glassDay) - lum(VENDING.body[v].base)).toBeGreaterThan(80);
      const day = paint(v, false);
      const night = paint(v, true);
      expect(day.some((b) => b.color === VENDING.glassDay)).toBe(true);
      expect(night.some((b) => b.color === VENDING.glassNight)).toBe(true);
      expect(day.filter((b) => b.color === VENDING.button)).toHaveLength(5);
      expect(night.filter((b) => b.color === VENDING.buttonLit)).toHaveLength(5);
    }
    expect(lum(VENDING.glassNight)).toBeGreaterThan(lum(VENDING.glassDay));
  });

  it("the coin panel and the dark pickup slot under the window", () => {
    const f = paint(0, false);
    const glass = f.find((b) => b.color === VENDING.glassDay)!;
    const slot = f.find((b) => b.color === VENDING.slot && b.w >= 10)!;
    expect(slot.y).toBeGreaterThan(glass.y + glass.h);
    expect(lum(VENDING.slot)).toBeLessThan(40);
    const coin = f.find((b) => b.color === VENDING.coin)!;
    expect(coin.y).toBeGreaterThan(glass.y + glass.h);
    expect(f.some((b) => b.color === VENDING.slot && within(b, coin.x, coin.y, coin.x + coin.w, coin.y + coin.h))).toBe(true);
  });

  it("one tile wide, two tall: inside its art box, standing on its footprint's bottom edge", () => {
    for (const v of [0, 1])
      for (const on of [false, true]) {
        const f = paint(v, on);
        for (const b of f) expect(within(b, X0, BOTTOM - 32, X0 + 16, BOTTOM), JSON.stringify(b)).toBe(true);
        expect(Math.max(...f.map((b) => b.y + b.h))).toBe(BOTTOM);
        expect(Math.min(...f.map((b) => b.y))).toBeLessThan(BOTTOM - 16);
      }
  });

  it("vendingVariant: the same id always the same look; both looks turn up across a street's ids", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `tokyo:vending:${i},21`);
    expect(ids.map(vendingVariant)).toEqual(ids.map(vendingVariant));
    expect(new Set(ids.map(vendingVariant))).toEqual(new Set([0, 1]));
  });
});

describe("vendingGlow — the machine's light at night", () => {
  it("a halo of crossed bands round the window plus a pool on the ground, all in the glow colour, inside vendingGlowBox", () => {
    const f = fills((ctx) => vendingGlow(ctx, cam, X0, BOTTOM));
    expect(f).toHaveLength(7);
    for (const b of f) expect(b.color).toBe(VENDING_GLOW);
    const [x, y, w, h] = vendingGlowBox(X0, BOTTOM);
    for (const b of f) expect(within(b, x, y, x + w, y + h), JSON.stringify(b)).toBe(true);
    // The box is tight: something touches each of its edges.
    expect(Math.min(...f.map((b) => b.x))).toBe(x);
    expect(Math.min(...f.map((b) => b.y))).toBe(y);
    expect(Math.max(...f.map((b) => b.x + b.w))).toBe(x + w);
    expect(Math.max(...f.map((b) => b.y + b.h))).toBe(y + h);
    // Centred on the machine's window.
    const glass = fills((ctx) => drawVending(ctx, cam, X0, BOTTOM, 0, true)).find((b) => b.color === VENDING.glassNight)!;
    const core = f.slice(0, 2);
    for (const b of core) {
      expect(Math.abs(b.x + b.w / 2 - (glass.x + glass.w / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(b.y + b.h / 2 - (glass.y + glass.h / 2))).toBeLessThanOrEqual(1);
    }
  });

  it("is translucent: the night grade shows through it", () => {
    expect(VENDING_GLOW).toMatch(/^rgba\(.*, 0\.\d+\)$/);
  });
});

describe("drawTorii", () => {
  const f = fills((ctx) => drawTorii(ctx, cam, X0, BOTTOM));

  it("two vermilion pillars on black feet, three tiles apart, symmetric about the middle tile", () => {
    const pillars = f.filter((b) => b.color === TORII.vermilion && b.h >= 30);
    expect(pillars.map((b) => b.x - X0)).toEqual([...TORII_PILLARS]);
    const [l, r] = pillars;
    expect(l.x + l.w / 2 - X0 + (r.x + r.w / 2 - X0)).toBe(48); // centres mirror about x0 + 24
    for (const p of pillars) {
      const foot = f.find((b) => b.color === TORII.black && b.y + b.h === BOTTOM && b.x <= p.x && b.x + b.w >= p.x + p.w);
      expect(foot, `foot under the pillar at ${p.x}`).toBeDefined();
    }
    const [r0, g0, b0] = rgb(TORII.vermilion);
    expect(r0).toBeGreaterThan(2 * g0);
    expect(r0).toBeGreaterThan(2 * b0);
  });

  it("the nuki crosses through both pillars; the kasagi on top is black, the topmost and widest, its ends turned up", () => {
    const pillars = f.filter((b) => b.color === TORII.vermilion && b.h >= 30);
    const nuki = f.find((b) => b.color === TORII.vermilion && b.w >= 36 && b.y > BOTTOM - 32)!;
    expect(nuki.x).toBeLessThan(pillars[0].x);
    expect(nuki.x + nuki.w).toBeGreaterThan(pillars[1].x + pillars[1].w);
    const kasagi = f.filter((b) => b.color === TORII.black && b.y < BOTTOM - 36);
    const widest = kasagi.reduce((a, b) => (b.w > a.w ? b : a));
    expect(widest.w).toBe(Math.max(...f.map((b) => b.w)));
    // The ends: black blocks at both outer edges, higher than the beam's middle.
    const ends = kasagi.filter((b) => b.y === BOTTOM - TORII_HEIGHT);
    expect(ends.map((b) => [b.x - X0, b.x + b.w - X0])).toEqual([
      [0, 4],
      [44, 48],
    ]);
    expect(Math.min(...ends.map((b) => b.y))).toBeLessThan(widest.y);
    // A plaque on the centre strut, between the two beams.
    const plaque = f.find((b) => b.color === TORII.plaque)!;
    expect(plaque.x + plaque.w / 2 - X0).toBe(24);
    expect(plaque.y).toBeGreaterThan(widest.y);
    expect(plaque.y + plaque.h).toBeLessThanOrEqual(nuki.y);
  });

  it("three tiles wide, rising ~2¾ tiles: inside its art box, on its footprint's bottom edge", () => {
    for (const b of f) expect(within(b, X0, BOTTOM - TORII_HEIGHT, X0 + 48, BOTTOM), JSON.stringify(b)).toBe(true);
    expect(Math.min(...f.map((b) => b.y))).toBe(BOTTOM - TORII_HEIGHT);
    expect(Math.max(...f.map((b) => b.y + b.h))).toBe(BOTTOM);
    // Within the two tiles of art above its footprint the engine reserves (streetTheme's ART_ABOVE).
    expect(TORII_HEIGHT).toBeLessThanOrEqual(3 * 16);
  });
});

describe("all three on the camera", () => {
  it("scale and offset with it like every prop (zoom 3, an offset origin)", () => {
    const z: Camera = { zoom: 3, ox: 11, oy: -7 };
    const shot = (draw: (ctx: ReturnType<typeof recorder>, c: Camera) => void, c: Camera) => {
      const ctx = recorder();
      draw(ctx, c);
      return ctx.of("fillRect").map((call) => call.args as number[]);
    };
    for (const draw of [
      (ctx: ReturnType<typeof recorder>, c: Camera) => drawSakura(ctx, c, X0, BOTTOM, 0.7),
      (ctx: ReturnType<typeof recorder>, c: Camera) => drawVending(ctx, c, X0, BOTTOM, 1, true),
      (ctx: ReturnType<typeof recorder>, c: Camera) => drawTorii(ctx, c, X0, BOTTOM),
    ]) {
      const one = shot(draw, cam);
      const three = shot(draw, z);
      expect(three).toEqual(one.map(([x, y, w, h]) => [11 + 3 * x, -7 + 3 * y, 3 * w, 3 * h]));
    }
  });
});
