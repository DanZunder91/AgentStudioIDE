/** Every engine random decision goes through here so a seeded `VillageSim` replays exactly (tests
 * depend on it). Never call `Math.random` in the engine. */

/** A PRNG returning a float in [0, 1). */
export type Rng = () => number;

/** mulberry32: tiny, fast, good-enough 32-bit PRNG (public-domain algorithm). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over UTF-16 code units → unsigned 32-bit. Stable across runs and platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash of a tile coordinate → unsigned 32-bit (grass/floor variety, tree scatter). */
export function hash2(col: number, row: number): number {
  let h = (Math.imul(col, 374761393) + Math.imul(row, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform float in [min, max). */
export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in [min, max] (inclusive). */
export function intRange(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
