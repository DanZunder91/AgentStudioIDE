import { describe, expect, it } from "vitest";

import { TILE } from "../villageTypes";
import { SKYLINE_BASE, SKYLINE_SHARE, skylineMax } from "./skyline";

describe("skylineMax", () => {
  it("keeps a low city's skyline at the old 3 tiles, and grows it with a tall city's sky", () => {
    expect(SKYLINE_BASE).toBe(3 * TILE);
    // A low city (HQ + one-floor projects: a sky of 240 px) is drawn exactly as before.
    for (const horizon of [64, 240, 336]) expect(skylineMax(horizon)).toBe(SKYLINE_BASE);
    // Past the point where the share passes 3 tiles, it is the share of the sky less a tile, rounded.
    expect(skylineMax(16 + SKYLINE_BASE / SKYLINE_SHARE + 16)).toBe(Math.round(SKYLINE_SHARE * (SKYLINE_BASE / SKYLINE_SHARE + 16)));
    // Rounded to the nearest px (0.15 × 384 = 57.6).
    expect(skylineMax(400)).toBe(58);
    // A seven-floor gazelle: a horizon of 976 px → 144 px of skyline (9 tiles).
    expect(skylineMax(976)).toBe(144);
    // Monotonic: a taller sky never gets a lower skyline.
    for (let h = 0; h < 2000; h += 16) expect(skylineMax(h + 16)).toBeGreaterThanOrEqual(skylineMax(h));
  });
});
