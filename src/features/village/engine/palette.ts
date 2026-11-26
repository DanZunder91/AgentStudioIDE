/** pixel-agents' `pickDiversePalette`, reimplemented: six bases, then the least-used base plus a
 * hue shift no live character wears while one is free. The shift starts from a hash of the key (not
 * the PRNG), so an agent looks the same across sims and reloads. */

import { hashString } from "./rng";

export const PALETTE_COUNT = 6;
/** Hue shifts are multiples of this (degrees) — see `pickPalette`. */
export const HUE_STEP = 15;
/** 45 + 15·18 = 315: the number of distinct shifted hues. */
const HUE_SLOTS = 19;

export interface PaletteChoice {
  palette: number;
  hueShift: number;
}

/** `used`: the looks on screen, roots and sub-agents alike (the caller drops departing ones). */
export function pickPalette(key: string, used: readonly PaletteChoice[]): PaletteChoice {
  const counts = new Array<number>(PALETTE_COUNT).fill(0);
  for (const u of used) counts[u.palette]++;
  let palette = 0;
  for (let i = 1; i < PALETTE_COUNT; i++) if (counts[i] < counts[palette]) palette = i;
  if (counts[palette] === 0) return { palette, hueShift: 0 };
  // 45..315° in HUE_STEP steps: never mistaken for the unshifted base, and few hues since each
  // (palette, hue) is a cached sheet (6 × 19 at most). Probe from the key's slot; all taken: key's.
  const taken = new Set<number>();
  for (const u of used) if (u.palette === palette) taken.add(u.hueShift);
  const start = hashString(key) % HUE_SLOTS;
  for (let i = 0; i < HUE_SLOTS; i++) {
    const hueShift = 45 + HUE_STEP * ((start + i) % HUE_SLOTS);
    if (!taken.has(hueShift)) return { palette, hueShift };
  }
  return { palette, hueShift: 45 + HUE_STEP * start };
}
