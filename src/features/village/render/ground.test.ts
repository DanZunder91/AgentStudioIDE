import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrawItem } from "../villageTypes";
import { defaultMakeLayer, isCachedGround, paintGround } from "./ground";
import { recorder, type RecordingTarget } from "./testRecorder";

const tiles: DrawItem[] = [
  { t: "tile", col: 0, row: 0, kind: "grass", variant: 0 },
  { t: "tile", col: 1, row: 0, kind: "water", variant: 0 },
  { t: "tile", col: 0, row: 1, kind: "plaza", variant: 1 },
  { t: "wall", col: 1, row: 1, mask: 0 },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("paintGround", () => {
  it("paints every non-water tile once, at zoom 1 in world px, smoothing off", () => {
    let layer: RecordingTarget | null = null;
    const make = vi.fn((_w: number, _h: number) => {
      layer = recorder();
      return {
        image: { tag: "ground" } as unknown as CanvasImageSource,
        ctx: layer,
      };
    });
    const got = paintGround(make, tiles, 2, 2, null);
    expect(make).toHaveBeenCalledWith(32, 32);
    expect(got).toEqual({ image: { tag: "ground" }, w: 32, h: 32 });
    const fills = layer!.of("fillRect");
    expect(fills.length).toBeGreaterThan(2);
    expect(fills.every((f) => !f.smoothing)).toBe(true);
    // Grass (0,0) and plaza (0,16) are in the layer; the water tile at (16,0) is not.
    expect(
      fills.some((f) => f.args[0] === 0 && f.args[1] === 0 && f.args[2] === 16),
    ).toBe(true);
    expect(
      fills.some(
        (f) => f.args[0] === 0 && f.args[1] === 16 && f.args[2] === 16,
      ),
    ).toBe(true);
    expect(fills.some((f) => f.args[0] === 16 && f.args[1] === 0)).toBe(false);
  });

  it("is null when the host cannot make a canvas, and never makes a 0×0 one", () => {
    const make = vi.fn(() => null);
    expect(paintGround(make, [], 0, 0, null)).toBeNull();
    expect(make).toHaveBeenCalledWith(1, 1);
  });

  it("caches exactly the static tiles", () => {
    expect(tiles.map(isCachedGround)).toEqual([true, false, true, false]);
  });
});

describe("defaultMakeLayer", () => {
  it("uses an OffscreenCanvas where there is one", () => {
    const ctx = recorder();
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext(): unknown {
        return ctx;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    const got = defaultMakeLayer(40, 20);
    expect(got?.ctx).toBe(ctx);
    expect(got?.image).toMatchObject({ width: 40, height: 20 });
  });

  it("falls back to a detached DOM canvas, and to null without a 2D context", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const ctx = recorder();
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    const got = defaultMakeLayer(8, 4);
    expect(got?.image).toBeInstanceOf(HTMLCanvasElement);
    expect(got?.image).toMatchObject({ width: 8, height: 4 });
    spy.mockImplementation(() => null);
    expect(defaultMakeLayer(8, 4)).toBeNull();
  });
});
