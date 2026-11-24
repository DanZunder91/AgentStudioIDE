/**
 * Agent Village — ground tiles and walls.
 *
 * Outdoor ground (grass, path, water, plaza) is OUR procedural pixel art,
 * deterministic per tile (hashed from col/row/variant) so nothing shimmers.
 * Indoor floors and walls use the vendored pixel-agents grayscale tiles,
 * colourised; without the art they degrade to flat fills of the same colour.
 *
 * Tile `variant` semantics: grass — tuft/flower pattern; floor — `variant % 9`
 * picks the floor pattern and `floor(variant / 9)` the tint; path/water/plaza/road —
 * a shade seed; sky — unused (it is drawn as nothing). Any non-negative integer is valid.
 */

import { TILE, type TileKind } from "../villageTypes";
import type { Camera } from "./camera";
import { tintToCss } from "./colorize";
import { blit, hash, rect } from "./paint";
import type { DrawTarget, Hsbc, SpriteBank } from "./renderTypes";
import { WALL_SHEET } from "./sprites";

/** Floor tints, cycled by `floor(variant / 9)`: warm wood, dark wood, cool tile, rose. */
export const FLOOR_TINTS: Hsbc[] = [
  { h: 32, s: 45, b: 6, c: 0 },
  { h: 24, s: 38, b: -14, c: 10 },
  { h: 205, s: 14, b: 8, c: 0 },
  { h: 350, s: 22, b: 2, c: 0 },
];

/** The walls' colourise tint (warm plaster) — the default for a wall outside any house. */
export const WALL_TINT: Hsbc = { h: 35, s: 22, b: -18, c: 0 };

/** A house's plaster: its hue, softened so the white face reads as a pastel wall, not a slab. */
export function wallTint(hue: number | undefined): Hsbc {
  return hue === undefined ? WALL_TINT : { h: hue, s: 32, b: -30, c: -10 };
}

/** A house's street facade: the same hue, much darker (timber/brick under the wall's cap). */
export function facadeTint(hue: number | undefined): Hsbc {
  return { h: hue ?? WALL_TINT.h, s: 34, b: -150, c: 10 };
}

/** World px of a front wall's cap; the rest of its tile is facade. */
const FRONT_CAP = 7;

const GRASS = ["#4f8a3a", "#4b8537"];
const GRASS_TUFT = "#6aa84f";
const GRASS_DARK = "#3f7230";
const FLOWERS = ["#f2e46b", "#f4f1ea", "#e98ab0"];
const PATH_MORTAR = "#9c8358";
const PATH_STONE = ["#c9b187", "#c1a87c"];
const PATH_LIGHT = "#dcc79f";
const WATER = "#3b76c4";
const WATER_DEEP = "#2f63a9";
const WATER_FOAM = "#8fc1f0";
const PLAZA_MORTAR = "#878379";
const PLAZA_STONE = ["#b3afa6", "#a9a59c", "#bab6ad"];
/** The city's street. Exported for the tests. */
export const ROAD = { asphalt: "#4a4d55", grit: "#55585f", line: "#e8d27a", edge: "#3b3d44" } as const;

function grass(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  col: number,
  row: number,
  variant: number,
): void {
  const h = hash(col, row, variant);
  rect(ctx, cam, x, y, TILE, TILE, GRASS[h & 1]);
  if (variant % 4 === 3)
    rect(ctx, cam, x + ((h >>> 3) % 8), y + ((h >>> 7) % 8), 6, 4, GRASS_DARK);
  const tufts = 1 + (variant % 3);
  for (let i = 0; i < tufts; i++) {
    const th = hash(h, i, 7);
    const tx = x + (th % 13);
    const ty = y + ((th >>> 5) % 13) + 1;
    rect(ctx, cam, tx, ty, 1, 1, GRASS_TUFT);
    rect(ctx, cam, tx + 1, ty - 1, 1, 1, GRASS_TUFT);
    rect(ctx, cam, tx + 2, ty, 1, 1, GRASS_TUFT);
  }
  if (variant % 5 === 4) {
    const fx = x + 2 + ((h >>> 11) % 11);
    const fy = y + 2 + ((h >>> 15) % 11);
    const petal = FLOWERS[(h >>> 19) % FLOWERS.length];
    rect(ctx, cam, fx - 1, fy, 3, 1, petal);
    rect(ctx, cam, fx, fy - 1, 1, 3, petal);
    rect(ctx, cam, fx, fy, 1, 1, "#d98b2b");
  }
}

/** Cobbles in running bond: odd rows are offset by half a stone. */
function path(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  col: number,
  row: number,
  variant: number,
): void {
  rect(ctx, cam, x, y, TILE, TILE, PATH_MORTAR);
  const h = hash(col, row, variant);
  const stones: [number, number, number][] =
    row % 2 === 0
      ? [
          [1, 1, 6],
          [9, 1, 6],
        ]
      : [
          [0, 1, 3],
          [5, 1, 6],
          [13, 1, 3],
        ];
  stones.forEach(([sx0, sy0, w], i) => {
    rect(ctx, cam, x + sx0, y + sy0, w, 6, PATH_STONE[(h >>> i) & 1]);
    rect(ctx, cam, x + sx0, y + 9, w, 6, PATH_STONE[(h >>> (i + 3)) & 1]);
    rect(ctx, cam, x + sx0, y + sy0, 1, 1, PATH_LIGHT);
  });
}

/** Water: two depth bands and foam dashes that drift with time (≈ 3 steps a second). */
function water(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  col: number,
  row: number,
  timeMs: number,
): void {
  rect(ctx, cam, x, y, TILE, TILE, WATER);
  rect(ctx, cam, x, y + 10, TILE, 6, WATER_DEEP);
  const phase = Math.floor(timeMs / 320);
  const h = hash(col, row, 3);
  for (let i = 0; i < 2; i++) {
    const wx = (h + phase * 2 + i * 7) % 12;
    rect(ctx, cam, x + wx, y + 4 + i * 6, 4, 1, WATER_FOAM);
  }
}

/** Plaza: four flagstones per tile with mortar joints. */
function plaza(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  col: number,
  row: number,
  variant: number,
): void {
  rect(ctx, cam, x, y, TILE, TILE, PLAZA_MORTAR);
  const h = hash(col, row, variant);
  for (let i = 0; i < 4; i++) {
    const shade = PLAZA_STONE[(h >>> (i * 2)) % PLAZA_STONE.length];
    rect(ctx, cam, x + (i % 2) * 8, y + Math.floor(i / 2) * 8, 7, 7, shade);
  }
}

/**
 * The city's asphalt: specks of grit, a dark kerb line on the even (upper) lane, and a
 * dashed yellow centre line along the odd one's top edge — dashes every other tile, so
 * two lanes read as one road.
 */
function road(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  col: number,
  row: number,
  variant: number,
): void {
  rect(ctx, cam, x, y, TILE, TILE, ROAD.asphalt);
  const h = hash(col, row, variant);
  rect(ctx, cam, x + (h % 13), y + 3 + ((h >>> 4) % 10), 2, 1, ROAD.grit);
  rect(ctx, cam, x + ((h >>> 8) % 14), y + 2 + ((h >>> 12) % 12), 1, 1, ROAD.grit);
  if (row % 2 === 0) rect(ctx, cam, x, y, TILE, 1, ROAD.edge);
  else if (col % 2 === 0) rect(ctx, cam, x + 3, y, 10, 1, ROAD.line);
}

function floor(
  ctx: DrawTarget,
  cam: Camera,
  x: number,
  y: number,
  variant: number,
  bank: SpriteBank | null,
): void {
  const tint = FLOOR_TINTS[Math.floor(variant / 9) % FLOOR_TINTS.length];
  const img = bank?.floor(variant % 9, tint) ?? null;
  if (img) blit(ctx, cam, img, 0, 0, TILE, TILE, x, y);
  else rect(ctx, cam, x, y, TILE, TILE, tintToCss(tint));
}

/** One ground tile. */
export function drawTile(
  ctx: DrawTarget,
  cam: Camera,
  item: { col: number; row: number; kind: TileKind; variant: number },
  bank: SpriteBank | null,
  timeMs: number,
): void {
  const { col, row, variant } = item;
  const x = col * TILE;
  const y = row * TILE;
  const v = Math.max(0, Math.trunc(variant));
  switch (item.kind) {
    case "grass":
      return grass(ctx, cam, x, y, col, row, v);
    case "path":
      return path(ctx, cam, x, y, col, row, v);
    case "water":
      return water(ctx, cam, x, y, col, row, timeMs);
    case "plaza":
      return plaza(ctx, cam, x, y, col, row, v);
    case "floor":
      return floor(ctx, cam, x, y, v, bank);
    case "wall":
      // A wall tile underneath a wall piece: just a flat base; the piece is a separate DrawItem.
      return rect(ctx, cam, x, y, TILE, TILE, tintToCss(WALL_TINT));
    case "road":
      return road(ctx, cam, x, y, col, row, v);
    case "sky":
      // Nothing: the city's sky backdrop (render/city.ts) is painted under the world.
      return;
  }
}

/**
 * One wall piece from the 4×4 auto-tile sheet (mask N=1 E=2 S=4 W=8 → sheet
 * cell `mask % 4, mask / 4`), colourised with its house's hue. Pieces are 16×32:
 * drawn 2 tiles tall, bottom on the tile's bottom edge — except a `front` (street)
 * wall, which stays inside its own tile: the piece's cap, then a darker facade strip
 * cut from the piece's bottom (so a door gap keeps its outlined jambs). A 2-tile
 * front wall would hide the room's last row behind a blank slab.
 */
export function drawWall(
  ctx: DrawTarget,
  cam: Camera,
  item: {
    col: number;
    row: number;
    mask: number;
    hue?: number;
    front?: boolean;
  },
  bank: SpriteBank | null,
): void {
  const mask = item.mask & 15;
  const x = item.col * TILE;
  const tint = wallTint(item.hue);
  const img = bank?.wall(tint) ?? null;
  const srcX = (mask % 4) * WALL_SHEET.pieceW;
  const srcY = Math.floor(mask / 4) * WALL_SHEET.pieceH;
  if (item.front) {
    const y = item.row * TILE;
    const facade = bank?.wall(facadeTint(item.hue)) ?? null;
    const rest = TILE - FRONT_CAP;
    if (img && facade) {
      blit(ctx, cam, img, srcX, srcY, WALL_SHEET.pieceW, FRONT_CAP, x, y);
      blit(
        ctx,
        cam,
        facade,
        srcX,
        srcY + WALL_SHEET.pieceH - rest,
        WALL_SHEET.pieceW,
        rest,
        x,
        y + FRONT_CAP,
      );
      return;
    }
    rect(ctx, cam, x, y, TILE, FRONT_CAP, tintToCss(tint));
    rect(
      ctx,
      cam,
      x,
      y + FRONT_CAP,
      TILE,
      rest,
      tintToCss(facadeTint(item.hue)),
    );
    return;
  }
  const y = (item.row + 1) * TILE - WALL_SHEET.pieceH;
  if (img) {
    blit(ctx, cam, img, srcX, srcY, WALL_SHEET.pieceW, WALL_SHEET.pieceH, x, y);
    // A house's back wall (no wall below it) wears its cap in the facade's dark timber:
    // an eave line that frames the house top and bottom alike.
    const eave =
      item.hue !== undefined && (mask & 4) === 0
        ? (bank?.wall(facadeTint(item.hue)) ?? null)
        : null;
    if (eave)
      blit(ctx, cam, eave, srcX, srcY, WALL_SHEET.pieceW, FRONT_CAP, x, y);
    return;
  }
  rect(ctx, cam, x, y, TILE, TILE, "#e3dccd"); // top face
  rect(ctx, cam, x, y + TILE, TILE, TILE, tintToCss(tint)); // front face
}
