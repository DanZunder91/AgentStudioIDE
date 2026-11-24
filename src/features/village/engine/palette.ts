/**
 * Character palette diversity (pixel-agents' `pickDiversePalette`, reimplemented).
 *
 * There are six base character sheets. EVERY character — root or sub-agent —
 * gets its own look: the first six on screen each get a distinct base (0..5, in
 * arrival order); after that a newcomer takes the least-used base plus a hue
 * shift of at least 45°, chosen so no live character already wears that exact
 * (base, hue) while another one is free — a parent and its sub-agents never
 * read as clones. The shift starts from a hash of the agent key — not the
 * PRNG — so the same agent looks the same across sims and reloads.
 */

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

/**
 * Pick a look for agent `key`, given the looks of the characters already on screen
 * (roots and sub-agents alike; departing ones excluded by the caller).
 */
export function pickPalette(key: string, used: readonly PaletteChoice[]): PaletteChoice {
  const counts = new Array<number>(PALETTE_COUNT).fill(0);
  for (const u of used) counts[u.palette]++;
  let palette = 0;
  for (let i = 1; i < PALETTE_COUNT; i++) if (counts[i] < counts[palette]) palette = i;
  if (counts[palette] === 0) return { palette, hueShift: 0 };
  // 45..315° — never close enough to 0/360 to be mistaken for the unshifted base —
  // in HUE_STEP steps: each distinct (palette, hue) is a cached recoloured sheet in
  // the sprite bank, so the hue set is kept small (6 × 19 sheets at most). Probe from
  // the key's slot to the first hue nobody on this base wears; all taken → the key's.
  const taken = new Set<number>();
  for (const u of used) if (u.palette === palette) taken.add(u.hueShift);
  const start = hashString(key) % HUE_SLOTS;
  for (let i = 0; i < HUE_SLOTS; i++) {
    const hueShift = 45 + HUE_STEP * ((start + i) % HUE_SLOTS);
    if (!taken.has(hueShift)) return { palette, hueShift };
  }
  return { palette, hueShift: 45 + HUE_STEP * start };
}
