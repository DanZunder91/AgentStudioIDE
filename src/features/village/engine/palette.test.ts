import { describe, expect, it } from "vitest";
import { HUE_STEP, PALETTE_COUNT, pickPalette, type PaletteChoice } from "./palette";

const base = (palettes: number[]): PaletteChoice[] => palettes.map((palette) => ({ palette, hueShift: 0 }));

describe("pickPalette", () => {
  it("gives the first six agents distinct unshifted palettes, in order", () => {
    const used: PaletteChoice[] = [];
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const p = pickPalette(`agent-${i}`, used);
      expect(p).toEqual({ palette: i, hueShift: 0 });
      used.push(p);
    }
  });

  it("then picks the least-used base with a ≥45° hue shift derived from the key", () => {
    const used = base([0, 1, 2, 3, 4, 5, 0, 2]);
    const p = pickPalette("seventh", used);
    expect(p.palette).toBe(1);
    expect(p.hueShift).toBeGreaterThanOrEqual(45);
    expect(p.hueShift).toBeLessThanOrEqual(315);
    expect(pickPalette("seventh", used)).toEqual(p);
    // Different keys spread over the hue wheel — on a bounded set of 19 steps, so the
    // sprite bank's recoloured-sheet cache stays small however many agents come and go.
    const hues = new Set(Array.from({ length: 2000 }, (_, i) => pickPalette(`k${i}`, used).hueShift));
    expect(hues.size).toBe(19);
    for (const h of hues) {
      expect((h - 45) % HUE_STEP).toBe(0);
      expect(h).toBeGreaterThanOrEqual(45);
      expect(h).toBeLessThanOrEqual(315);
    }
  });

  it("fills a gap left by a departed agent before shifting hues", () => {
    expect(pickPalette("x", base([0, 1, 2, 4, 5]))).toEqual({ palette: 3, hueShift: 0 });
  });

  it("never repeats a look someone on screen already wears while a free one is left", () => {
    // Many characters at once (a parent and a swarm of sub-agents): all distinct.
    const used: PaletteChoice[] = [];
    for (let i = 0; i < PALETTE_COUNT * 20; i++) used.push(pickPalette(`same-ish-${i % 3}`, used));
    expect(new Set(used.map((u) => `${u.palette}/${u.hueShift}`)).size).toBe(used.length);
    // The key's own slot is skipped when taken: same key, different result.
    const first = pickPalette("k", base([0, 1, 2, 3, 4, 5]));
    const second = pickPalette("k", [...base([0, 1, 2, 3, 4, 5]), first]);
    expect(second.palette).toBe(1);
    const third = pickPalette("k", [...base([0, 1, 2, 3, 4, 5]), first, second, { palette: 2, hueShift: 45 }, { palette: 3, hueShift: 45 }, { palette: 4, hueShift: 45 }, { palette: 5, hueShift: 45 }]);
    expect(third).toMatchObject({ palette: first.palette });
    expect(third.hueShift).not.toBe(first.hueShift);
  });

  it("falls back to the key's hue once every hue on the base is taken", () => {
    const full: PaletteChoice[] = [];
    for (let i = 0; i < 19; i++) full.push({ palette: 0, hueShift: 45 + HUE_STEP * i });
    for (let p = 1; p < PALETTE_COUNT; p++) for (let i = 0; i < 20; i++) full.push({ palette: p, hueShift: 0 });
    full.push({ palette: 0, hueShift: 0 });
    const got = pickPalette("k", full);
    expect(got.palette).toBe(0);
    expect(got).toEqual(pickPalette("k", full));
    expect(got.hueShift).toBeGreaterThanOrEqual(45);
  });
});
