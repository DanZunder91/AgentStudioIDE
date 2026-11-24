/**
 * Agent Village — the CITY's far skyline: the hazy blocks on the horizon behind the street, sized
 * to the city (next to a 7-floor building that dwarfed them, the buildings behind must look
 * somewhat bigger).
 *
 * The blocks used to top out at a fixed 3 tiles, whatever the city. That suits a city of one- and
 * two-floor buildings, but next to a building of seven tall floors (a sky of ~60 tiles) they shrink
 * to a strip of gravel. Now the tallest block is a share of the city's sky (the sky less a tile, the
 * same reference the landmarks are sized by), never under the old 3 tiles: a low city is drawn
 * exactly as before, and a tall one gets a skyline in proportion.
 *
 * Two things that used to read the fixed height now read this one: the night lighting of the towers
 * starts above it (a light painted after the grade must not land on the haze in front of a tower's
 * foot), and a temple counts as "no taller than the haze" against it. The temples' own SIZES stay
 * pinned to `SKYLINE_BASE`: they must fit the street's 4-tile gap between two buildings, however tall
 * the city.
 */

import { TILE } from "../villageTypes";

/** The far skyline's tallest block in a low city (3 tiles): the floor of `skylineMax`, and what the temples are sized against. */
export const SKYLINE_BASE = 3 * TILE;

/** The share of the city's sky (less a tile) the far skyline's tallest block reaches. */
export const SKYLINE_SHARE = 0.15;

/** The far skyline's tallest block (world px) in a city whose horizon — the street's top edge — is at `horizonY`. */
export function skylineMax(horizonY: number): number {
  return Math.max(SKYLINE_BASE, Math.round(SKYLINE_SHARE * (horizonY - TILE)));
}
