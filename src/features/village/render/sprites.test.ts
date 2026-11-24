import { afterEach, describe, expect, it, vi } from "vitest";

import type { FurnitureId, SpriteImage } from "./renderTypes";
import {
  CHARACTER_URLS,
  FLOOR_URLS,
  FURNITURE_SIZE,
  FURNITURE_URLS,
  WALL_URL,
  createBank,
  defaultLoadImage,
  defaultMakeCanvas,
  fallbackBank,
  loadSprites,
  type PixelContext,
  type ScratchCanvas,
} from "./sprites";

/** A stand-in decoded image, tagged with its URL. */
const img = (url: string): SpriteImage => ({ url }) as unknown as SpriteImage;

/** A fake scratch canvas whose pixels are one opaque red pixel per call. */
function fakeCanvas(): {
  make: (w: number, h: number) => ScratchCanvas;
  made: { w: number; h: number; ctx: PixelContext; image: SpriteImage }[];
} {
  const made: {
    w: number;
    h: number;
    ctx: PixelContext;
    image: SpriteImage;
  }[] = [];
  return {
    made,
    make: (w, h) => {
      const data = {
        data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]),
      };
      const ctx: PixelContext = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => data),
        putImageData: vi.fn(),
      };
      const entry = { w, h, ctx, image: img(`canvas-${made.length}`) };
      made.push(entry);
      return { ctx, image: entry.image };
    },
  };
}

function raw() {
  const furniture = Object.fromEntries(
    (Object.keys(FURNITURE_URLS) as FurnitureId[]).map((id) => [id, img(id)]),
  ) as Record<FurnitureId, SpriteImage>;
  return {
    chars: CHARACTER_URLS.map(img),
    floors: FLOOR_URLS.map(img),
    wall: img("wall"),
    furniture,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("vendored asset URLs", () => {
  it("names 6 character sheets, 9 floors, 1 wall sheet and a sized entry per furniture PNG", () => {
    expect(CHARACTER_URLS).toHaveLength(6);
    expect(FLOOR_URLS).toHaveLength(9);
    expect(WALL_URL).toMatch(/wall_0\.png/);
    for (const url of [...CHARACTER_URLS, ...FLOOR_URLS])
      expect(url).toMatch(/\.png/);
    expect(Object.keys(FURNITURE_SIZE).sort()).toEqual(
      Object.keys(FURNITURE_URLS).sort(),
    );
  });
});

describe("loadSprites", () => {
  it("decodes every vendored PNG and returns a working bank", async () => {
    const loadImage = vi.fn(async (url: string) => img(url));
    const bank = await loadSprites({
      loadImage,
      makeCanvas: fakeCanvas().make,
    });
    expect(bank.fallback).toBe(false);
    expect(loadImage).toHaveBeenCalledTimes(
      6 + 9 + 1 + Object.keys(FURNITURE_URLS).length,
    );
    expect(bank.furniture("PC_FRONT_ON_2")).toEqual(
      img(FURNITURE_URLS.PC_FRONT_ON_2),
    );
    expect(bank.character(2, 0)).toEqual(img(CHARACTER_URLS[2]));
  });

  it("degrades to a fallback bank when any image fails to load", async () => {
    const loadImage = vi.fn(async (url: string) => {
      if (url === WALL_URL) throw new Error("404");
      return img(url);
    });
    const bank = await loadSprites({ loadImage });
    expect(bank.fallback).toBe(true);
    expect(bank.character(0, 0)).toBeNull();
    expect(bank.floor(0, { h: 0, s: 0, b: 0, c: 0 })).toBeNull();
    expect(bank.wall({ h: 0, s: 0, b: 0, c: 0 })).toBeNull();
    expect(bank.furniture("BIN")).toBeNull();
  });

  it("with the default decoder in jsdom (no Image.decode) it degrades instead of rejecting", async () => {
    await expect(loadSprites()).resolves.toMatchObject({ fallback: true });
  });
});

describe("createBank", () => {
  const tint = { h: 30, s: 40, b: 0, c: 0 };

  it("character: hue 0 is the sheet itself; a shift renders once, recoloured, then comes from cache", () => {
    const canvas = fakeCanvas();
    const bank = createBank(raw(), canvas.make);
    expect(bank.character(7, 0)).toEqual(img(CHARACTER_URLS[1])); // palette wraps
    expect(bank.character(-1, 360)).toEqual(img(CHARACTER_URLS[5])); // 360° ≡ 0
    const shifted = bank.character(0, 120);
    expect(shifted).toBe(canvas.made[0].image);
    expect(canvas.made[0]).toMatchObject({ w: 112, h: 96 });
    const { ctx } = canvas.made[0];
    expect(ctx.drawImage).toHaveBeenCalledWith(img(CHARACTER_URLS[0]), 0, 0);
    const written = vi.mocked(ctx.putImageData).mock.calls[0][0].data;
    expect(Array.from(written.slice(0, 4))).toEqual([0, 255, 0, 255]); // red rotated 120° → green
    expect(bank.character(0, 480)).toBe(shifted); // 480 ≡ 120: same cache entry
    expect(canvas.made).toHaveLength(1);
  });

  it("character: without a canvas, a hue shift falls back to the unshifted sheet", () => {
    const bank = createBank(raw(), () => null);
    expect(bank.character(3, 90)).toEqual(img(CHARACTER_URLS[3]));
  });

  it("character: a canvas that throws (tainted) also falls back, and the failure is cached", () => {
    const make = vi.fn(() => {
      throw new Error("SecurityError");
    });
    const bank = createBank(raw(), make);
    expect(bank.character(0, 45)).toEqual(img(CHARACTER_URLS[0]));
    expect(bank.character(0, 45)).toEqual(img(CHARACTER_URLS[0]));
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("floor and wall are colourised per tint and cached by key", () => {
    const canvas = fakeCanvas();
    const bank = createBank(raw(), canvas.make);
    const f = bank.floor(10, tint); // pattern wraps 10 → 1
    expect(canvas.made[0]).toMatchObject({ w: 16, h: 16 });
    expect(canvas.made[0].ctx.drawImage).toHaveBeenCalledWith(
      img(FLOOR_URLS[1]),
      0,
      0,
    );
    expect(bank.floor(1, { ...tint })).toBe(f);
    expect(bank.floor(1, { ...tint, h: 200 })).not.toBe(f);
    const w = bank.wall(tint);
    expect(canvas.made[2]).toMatchObject({ w: 64, h: 128 });
    expect(bank.wall(tint)).toBe(w);
    expect(canvas.made).toHaveLength(3);
  });

  it("floor and wall without a canvas are null (renderer paints flat colour)", () => {
    const bank = createBank(raw(), () => ({ ctx: null, image: img("x") }));
    expect(bank.floor(0, tint)).toBeNull();
    expect(bank.wall(tint)).toBeNull();
  });

  it("furniture returns the decoded PNG unmodified", () => {
    const bank = createBank(raw(), () => null);
    expect(bank.furniture("SOFA_BACK")).toEqual(img("SOFA_BACK"));
  });

  it("fallbackBank is flagged and empty", () => {
    expect(fallbackBank().fallback).toBe(true);
  });
});

describe("defaultLoadImage", () => {
  class FakeImage {
    src = "";
    decode = vi.fn(async () => undefined);
  }

  it("decodes through Image.decode and upgrades to an ImageBitmap when available", async () => {
    const bitmap = { bitmap: true };
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    await expect(defaultLoadImage("/a.png")).resolves.toBe(bitmap);
    const decoded = createImageBitmap.mock.calls[0] as unknown as [FakeImage];
    expect(decoded[0].src).toBe("/a.png");
    expect(decoded[0].decode).toHaveBeenCalled();
  });

  it("returns the decoded <img> itself without createImageBitmap", async () => {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("createImageBitmap", undefined);
    const out = (await defaultLoadImage("/b.png")) as unknown as FakeImage;
    expect(out).toBeInstanceOf(FakeImage);
    expect(out.src).toBe("/b.png");
  });

  it("rejects when decoding fails (loadSprites turns that into the fallback bank)", async () => {
    class Broken extends FakeImage {
      decode = vi.fn(async () => {
        throw new Error("EncodingError");
      });
    }
    vi.stubGlobal("Image", Broken);
    await expect(defaultLoadImage("/c.png")).rejects.toThrow("EncodingError");
  });
});

describe("defaultMakeCanvas", () => {
  it("prefers OffscreenCanvas", () => {
    const ctx = { drawImage: vi.fn() };
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext = vi.fn(() => ctx);
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    const out = defaultMakeCanvas(16, 32);
    expect(out?.ctx).toBe(ctx);
    expect(out?.image).toBeInstanceOf(FakeOffscreen);
    expect(out?.image).toMatchObject({ width: 16, height: 32 });
  });

  it("falls back to a detached DOM canvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const ctx = {};
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as never,
    );
    const out = defaultMakeCanvas(8, 4);
    expect(out?.ctx).toBe(ctx);
    expect(out?.image).toBeInstanceOf(HTMLCanvasElement);
    expect(out?.image).toMatchObject({ width: 8, height: 4 });
  });

  it("is null when the host has no 2D context (jsdom)", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(defaultMakeCanvas(8, 8)).toBeNull();
  });
});
