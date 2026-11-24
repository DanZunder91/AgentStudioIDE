/**
 * Agent Village — per-pixel recolouring of RGBA buffers (pure, no DOM).
 *
 * Two operations, both run once per variant and cached by the sprite bank:
 *   - `hueShiftPixels` rotates every opaque pixel's hue (character diversity
 *     beyond the six pre-coloured sheets);
 *   - `colorizePixels` is Photoshop-style "Colorize": luminance is kept, hue
 *     and saturation are replaced, then contrast/brightness adjust lightness —
 *     one grayscale floor or wall tile serves every colour.
 */

import type { Hsbc } from "./renderTypes";

/** RGB 0..255 → HSL (h 0..360, s/l 0..1). */
export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** HSL (h any degrees, s/l 0..1) → RGB 0..255 (rounded). */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(hh);
  const [r, g, b] =
    sector === 0
      ? [c, x, 0]
      : sector === 1
        ? [x, c, 0]
        : sector === 2
          ? [0, c, x]
          : sector === 3
            ? [0, x, c]
            : sector === 4
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Rotate the hue of every non-transparent pixel by `deg`, in place. */
export function hueShiftPixels(data: Uint8ClampedArray, deg: number): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const [r, g, b] = hslToRgb(h + deg, s, l);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Lightness after contrast `c` and brightness `b` (both -100..100), clamped. */
export function adjustLightness(l: number, b: number, c: number): number {
  return clamp01(clamp01(0.5 + (l - 0.5) * ((100 + c) / 100)) + b / 200);
}

/** Photoshop-style Colorize of every non-transparent pixel, in place (alpha kept). */
export function colorizePixels(data: Uint8ClampedArray, tint: Hsbc): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const lum =
      (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    const [r, g, b] = hslToRgb(
      tint.h,
      tint.s / 100,
      adjustLightness(lum, tint.b, tint.c),
    );
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** The flat colour a colourised mid-grey takes — the fallback fill when the sprite is unavailable. */
export function tintToCss(tint: Hsbc): string {
  const [r, g, b] = hslToRgb(
    tint.h,
    tint.s / 100,
    adjustLightness(0.5, tint.b, tint.c),
  );
  return `rgb(${r}, ${g}, ${b})`;
}
