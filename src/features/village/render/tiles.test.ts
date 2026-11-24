import { describe, expect, it, vi } from "vitest";

import type { TileKind } from "../villageTypes";
import { tintToCss } from "./colorize";
import type { SpriteBank, SpriteImage } from "./renderTypes";
import { recorder } from "./testRecorder";
import {
  FLOOR_TINTS,
  ROAD,
  WALL_TINT,
  drawTile,
  drawWall,
  facadeTint,
  wallTint,
} from "./tiles";

const cam = { zoom: 2, ox: 0, oy: 0 };
const IMG = { img: true } as unknown as SpriteImage;

function bank(over: Partial<SpriteBank> = {}): SpriteBank {
  return {
    fallback: false,
    character: () => null,
    floor: vi.fn(() => IMG),
    wall: vi.fn(() => IMG),
    furniture: () => null,
    ...over,
  };
}

const tile = (kind: TileKind, variant = 0, col = 1, row = 2) => ({
  col,
  row,
  kind,
  variant,
});

/** Every fillRect stays inside the tile's screen square (procedural art never bleeds). */
function insideTile(
  ctx: ReturnType<typeof recorder>,
  col: number,
  row: number,
): boolean {
  const s = 16 * cam.zoom;
  return ctx.of("fillRect").every(({ args: [x, y, w, h] }) => {
    const [nx, ny, nw, nh] = [x, y, w, h] as number[];
    return (
      nx >= col * s &&
      ny >= row * s &&
      nx + nw <= (col + 1) * s &&
      ny + nh <= (row + 1) * s
    );
  });
}

describe("procedural ground", () => {
  it("grass: a base fill plus 1-3 tufts; variant 3 adds a dark patch, variant 4 a flower", () => {
    const counts = [0, 1, 2, 3, 4].map((v) => {
      const ctx = recorder();
      drawTile(ctx, cam, tile("grass", v), null, 0);
      expect(insideTile(ctx, 1, 2)).toBe(true);
      expect(ctx.of("fillRect")[0].args).toEqual([32, 64, 32, 32]);
      return ctx.of("fillRect").length;
    });
    // base + tufts×3 (+1 patch for v3, +3 flower for v4)
    expect(counts).toEqual([1 + 3, 1 + 6, 1 + 9, 1 + 1 + 3, 1 + 6 + 3]);
  });

  it("grass is deterministic per tile (no shimmer between frames)", () => {
    const a = recorder();
    const b = recorder();
    drawTile(a, cam, tile("grass", 2, 5, 5), null, 0);
    drawTile(b, cam, tile("grass", 2, 5, 5), null, 99_999);
    expect(a.calls).toEqual(b.calls);
  });

  it("path: running bond — even rows 2 stones per course, odd rows 3", () => {
    const even = recorder();
    drawTile(even, cam, tile("path", 0, 0, 0), null, 0);
    const odd = recorder();
    drawTile(odd, cam, tile("path", 0, 0, 1), null, 0);
    expect(even.of("fillRect")).toHaveLength(1 + 2 * 3);
    expect(odd.of("fillRect")).toHaveLength(1 + 3 * 3);
    expect(insideTile(odd, 0, 1)).toBe(true);
  });

  it("water: foam dashes drift with time", () => {
    const a = recorder();
    const b = recorder();
    drawTile(a, cam, tile("water"), null, 0);
    drawTile(b, cam, tile("water"), null, 320);
    expect(a.of("fillRect")).toHaveLength(4);
    expect(a.calls).not.toEqual(b.calls);
    expect(insideTile(b, 1, 2)).toBe(true);
  });

  it("plaza: mortar plus four flagstones", () => {
    const ctx = recorder();
    drawTile(ctx, cam, tile("plaza", 7), null, 0);
    expect(ctx.of("fillRect")).toHaveLength(5);
    expect(insideTile(ctx, 1, 2)).toBe(true);
  });

  it("a wall tile kind paints a flat base (its piece is a separate DrawItem)", () => {
    const ctx = recorder();
    drawTile(ctx, cam, tile("wall"), null, 0);
    expect(ctx.of("fillRect")).toHaveLength(1);
    expect(ctx.of("fillRect")[0].fillStyle).toBe(tintToCss(WALL_TINT));
  });

  it("negative / fractional variants are normalised", () => {
    const ctx = recorder();
    drawTile(ctx, cam, tile("grass", -3.7), null, 0);
    expect(ctx.of("fillRect").length).toBeGreaterThan(1);
  });
});

describe("floor", () => {
  it("uses the colourised vendored pattern: variant % 9 picks the pattern, variant / 9 the tint", () => {
    const b = bank();
    const ctx = recorder();
    drawTile(ctx, cam, tile("floor", 11), b, 0);
    expect(b.floor).toHaveBeenCalledWith(2, FLOOR_TINTS[1]);
    expect(ctx.of("drawImage")[0].args).toEqual([
      IMG,
      0,
      0,
      16,
      16,
      32,
      64,
      32,
      32,
    ]);
  });

  it("degrades to a flat tint fill without art", () => {
    for (const b of [null, bank({ floor: () => null })]) {
      const ctx = recorder();
      drawTile(ctx, cam, tile("floor", 0), b, 0);
      expect(ctx.of("drawImage")).toHaveLength(0);
      expect(ctx.of("fillRect")[0].fillStyle).toBe(tintToCss(FLOOR_TINTS[0]));
    }
  });
});

describe("drawWall", () => {
  it("picks the auto-tile piece by mask and draws it 2 tiles tall, bottom on the tile", () => {
    const b = bank();
    const ctx = recorder();
    drawWall(ctx, cam, { col: 3, row: 4, mask: 6 /* E|S */ }, b);
    expect(b.wall).toHaveBeenCalledWith(WALL_TINT);
    // mask 6 → sheet cell (2, 1) → src (32, 32); world y = 5*16 - 32 = 48.
    expect(ctx.of("drawImage")[0].args).toEqual([
      IMG,
      32,
      32,
      16,
      32,
      96,
      96,
      32,
      64,
    ]);
  });

  it("masks to 4 bits", () => {
    const ctx = recorder();
    drawWall(ctx, cam, { col: 0, row: 1, mask: 16 + 15 }, bank());
    expect(ctx.of("drawImage")[0].args.slice(1, 3)).toEqual([48, 96]);
  });

  it("degrades to a top face and a front face", () => {
    const ctx = recorder();
    drawWall(ctx, cam, { col: 0, row: 1, mask: 0 }, null);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([
      [0, 0, 32, 32],
      [0, 32, 32, 32],
    ]);
  });

  it("tints a house's walls with its hue: pastel plaster, a much darker facade", () => {
    expect(wallTint(undefined)).toBe(WALL_TINT);
    expect(wallTint(95)).toEqual({ h: 95, s: 32, b: -30, c: -10 });
    expect(facadeTint(95).h).toBe(95);
    expect(facadeTint(undefined).h).toBe(WALL_TINT.h);
    expect(facadeTint(95).b).toBeLessThan(wallTint(95).b);
  });

  it("caps a house's back wall (no wall below) with a dark eave; side pieces get none", () => {
    const b = bank();
    const back = recorder();
    drawWall(back, cam, { col: 3, row: 4, mask: 2 | 8, hue: 42 }, b);
    expect(b.wall).toHaveBeenCalledWith(wallTint(42));
    expect(b.wall).toHaveBeenCalledWith(facadeTint(42));
    // full 16×32 piece, then its 7 px cap again from the dark sheet
    expect(back.of("drawImage").map((c) => c.args.slice(1, 9))).toEqual([
      [32, 64, 16, 32, 96, 96, 32, 64],
      [32, 64, 16, 7, 96, 96, 32, 14],
    ]);
    const side = recorder();
    drawWall(side, cam, { col: 3, row: 4, mask: 1 | 4, hue: 42 }, b);
    expect(side.of("drawImage")).toHaveLength(1);
    // A plain (house-less) wall never gets an eave.
    const plain = recorder();
    drawWall(plain, cam, { col: 3, row: 4, mask: 2 | 8 }, b);
    expect(plain.of("drawImage")).toHaveLength(1);
    // …and an eave whose recolour is unavailable is simply skipped.
    const noEave = recorder();
    drawWall(
      noEave,
      cam,
      { col: 3, row: 4, mask: 2 | 8, hue: 42 },
      bank({ wall: vi.fn((t) => (t.b === wallTint(42).b ? IMG : null)) }),
    );
    expect(noEave.of("drawImage")).toHaveLength(1);
  });

  it("draws a front (street) wall inside its own tile: the cap, then the darker facade from the piece's bottom", () => {
    const b = bank();
    const ctx = recorder();
    drawWall(
      ctx,
      cam,
      { col: 3, row: 4, mask: 2 | 8, hue: 12, front: true },
      b,
    );
    expect(b.wall).toHaveBeenCalledWith(wallTint(12));
    expect(b.wall).toHaveBeenCalledWith(facadeTint(12));
    // mask 10 → src (32, 64). Cap 7 px at the tile top (y 64), facade = the piece's last 9 rows below it.
    expect(ctx.of("drawImage").map((c) => c.args.slice(1, 9))).toEqual([
      [32, 64, 16, 7, 96, 128, 32, 14],
      [32, 64 + 32 - 9, 16, 9, 96, 128 + 14, 32, 18],
    ]);
    // Nothing reaches above its own tile (it must not cover the room's last row).
    for (const c of ctx.of("drawImage"))
      expect(c.args[6] as number).toBeGreaterThanOrEqual(4 * 16 * cam.zoom);
  });

  it("degrades a front wall to a flat cap and facade inside its tile", () => {
    for (const b of [null, bank({ wall: vi.fn(() => null) })]) {
      const ctx = recorder();
      drawWall(ctx, cam, { col: 0, row: 1, mask: 2, hue: 12, front: true }, b);
      expect(ctx.of("fillRect").map((c) => [c.args, c.fillStyle])).toEqual([
        [[0, 32, 32, 14], tintToCss(wallTint(12))],
        [[0, 46, 32, 18], tintToCss(facadeTint(12))],
      ]);
    }
  });
});

describe("the city's ground", () => {
  it("sky is drawn as nothing at all: the city's sky backdrop shows through it", () => {
    const ctx = recorder();
    drawTile(ctx, cam, tile("sky", 3), bank(), 0);
    expect(ctx.calls).toHaveLength(0);
  });

  it("road: asphalt with grit, the kerb along an even row's top, centre dashes on every other tile of an odd row", () => {
    const fills = (col: number, row: number) => {
      const ctx = recorder();
      drawTile(ctx, cam, tile("road", 1, col, row), null, 0);
      expect(insideTile(ctx, col, row)).toBe(true);
      return ctx.of("fillRect");
    };
    const kerb = fills(3, 4);
    expect(kerb[0]).toMatchObject({ fillStyle: ROAD.asphalt, args: [3 * 32, 4 * 32, 32, 32] });
    expect(kerb.filter((f) => f.fillStyle === ROAD.grit)).toHaveLength(2);
    expect(kerb.at(-1)).toMatchObject({ fillStyle: ROAD.edge, args: [3 * 32, 4 * 32, 32, 2] });
    expect(kerb.some((f) => f.fillStyle === ROAD.line)).toBe(false);
    // The second lane: a dash at the top of even columns (an even tile width keeps them in step).
    expect(fills(4, 5).at(-1)).toMatchObject({ fillStyle: ROAD.line, args: [4 * 32 + 6, 5 * 32, 20, 2] });
    const plain = fills(3, 5).map((f) => f.fillStyle);
    expect(plain).not.toContain(ROAD.line);
    expect(plain).not.toContain(ROAD.edge);
    // The grit is stable per tile (the hash), so nothing shimmers frame to frame.
    expect(fills(3, 4)).toEqual(kerb);
  });
});
