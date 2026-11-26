/** The City's far skyline. Its tallest block is a share of the city's sky, never under
 * `SKYLINE_BASE`; tower night lights start above it and temples compare against it, but temple
 * sizes stay pinned to `SKYLINE_BASE` to fit the street's 4-tile gap between buildings. */

import { TILE } from "../villageTypes";

/** The far skyline's tallest block in a low city (3 tiles): the floor of `skylineMax`, and what the temples are sized against. */
export const SKYLINE_BASE = 3 * TILE;

/** The share of the city's sky (less a tile) the far skyline's tallest block reaches. */
export const SKYLINE_SHARE = 0.15;

/** The far skyline's tallest block (world px) in a city whose horizon — the street's top edge — is at `horizonY`. */
export function skylineMax(horizonY: number): number {
  return Math.max(SKYLINE_BASE, Math.round(SKYLINE_SHARE * (horizonY - TILE)));
}
