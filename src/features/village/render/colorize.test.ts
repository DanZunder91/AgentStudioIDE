import { describe, expect, it } from "vitest";

import {
  adjustLightness,
  colorizePixels,
  hslToRgb,
  hueShiftPixels,
  rgbToHsl,
  tintToCss,
} from "./colorize";

describe("rgbToHsl / hslToRgb", () => {
  it("round-trips a colour in every hue sector", () => {
    const samples: [number, number, number][] = [
      [200, 40, 30], // red-ish, g > b (sector 0)
      [180, 200, 20], // yellow-green (sector 1)
      [30, 200, 90], // green (sector 2)
      [30, 120, 200], // azure (sector 3)
      [90, 30, 200], // violet (sector 4)
      [200, 30, 120], // magenta, max = r with g < b (sector 5)
    ];
    for (const [r, g, b] of samples) {
      const [h, s, l] = rgbToHsl(r, g, b);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      const back = hslToRgb(h, s, l);
      expect(back[0]).toBeCloseTo(r, -0.5);
      expect(back[1]).toBeCloseTo(g, -0.5);
      expect(back[2]).toBeCloseTo(b, -0.5);
    }
  });

  it("treats greys as hue 0, saturation 0", () => {
    expect(rgbToHsl(128, 128, 128)).toEqual([0, 0, 128 / 255]);
    expect(hslToRgb(0, 0, 0.5)).toEqual([128, 128, 128]);
  });

  it("wraps negative and >360 hues", () => {
    expect(hslToRgb(-120, 1, 0.5)).toEqual(hslToRgb(240, 1, 0.5));
    expect(hslToRgb(480, 1, 0.5)).toEqual(hslToRgb(120, 1, 0.5));
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
  });
});

describe("hueShiftPixels", () => {
  it("rotates opaque pixels and leaves transparent ones and alpha alone", () => {
    const px = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 128,
    ]);
    hueShiftPixels(px, 120);
    expect(Array.from(px.slice(0, 4))).toEqual([0, 255, 0, 255]); // red → green
    expect(Array.from(px.slice(4, 8))).toEqual([255, 0, 0, 0]); // transparent: untouched
    expect(Array.from(px.slice(8, 12))).toEqual([0, 0, 255, 128]); // green → blue, alpha kept
  });
});

describe("colorizePixels", () => {
  it("keeps luminance, replaces hue/saturation, keeps alpha, skips transparent pixels", () => {
    const px = new Uint8ClampedArray([128, 128, 128, 200, 9, 9, 9, 0]);
    colorizePixels(px, { h: 0, s: 100, b: 0, c: 0 });
    expect(px[0]).toBeGreaterThan(200); // a saturated red at mid lightness
    expect(px[1]).toBeLessThan(10);
    expect(px[3]).toBe(200);
    expect(Array.from(px.slice(4, 8))).toEqual([9, 9, 9, 0]);
  });

  it("brightness and contrast move lightness and clamp", () => {
    expect(adjustLightness(0.5, 0, 0)).toBe(0.5);
    expect(adjustLightness(0.5, 100, 0)).toBe(1);
    expect(adjustLightness(0.5, -100, 0)).toBe(0);
    expect(adjustLightness(0.9, 0, 100)).toBe(1); // contrast pushes past 1 → clamped
    expect(adjustLightness(0.1, 0, 100)).toBe(0);
  });
});

describe("tintToCss", () => {
  it("is the flat colour a colourised mid-grey takes", () => {
    expect(tintToCss({ h: 0, s: 0, b: 0, c: 0 })).toBe("rgb(128, 128, 128)");
    expect(tintToCss({ h: 120, s: 100, b: 0, c: 0 })).toBe("rgb(0, 255, 0)");
  });
});
