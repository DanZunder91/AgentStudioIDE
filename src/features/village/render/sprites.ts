/**
 * Agent Village — the sprite bank: loads the vendored pixel-agents PNGs
 * (src/assets/pixel-agents, MIT — see its README) as Vite asset URLs, decodes
 * them, and lazily pre-renders recoloured variants (character hue shifts,
 * colourised floors/walls), cached by key.
 *
 * It must degrade, never throw: if any PNG fails to load the bank comes back
 * flagged `fallback` and the renderer paints coloured rectangles instead. If a
 * recolour needs a canvas the host does not have, that one getter falls back
 * (characters to the un-shifted sheet, floors/walls to `null`).
 */

import char0 from "../../../assets/pixel-agents/characters/char_0.png";
import char1 from "../../../assets/pixel-agents/characters/char_1.png";
import char2 from "../../../assets/pixel-agents/characters/char_2.png";
import char3 from "../../../assets/pixel-agents/characters/char_3.png";
import char4 from "../../../assets/pixel-agents/characters/char_4.png";
import char5 from "../../../assets/pixel-agents/characters/char_5.png";
import floor0 from "../../../assets/pixel-agents/floors/floor_0.png";
import floor1 from "../../../assets/pixel-agents/floors/floor_1.png";
import floor2 from "../../../assets/pixel-agents/floors/floor_2.png";
import floor3 from "../../../assets/pixel-agents/floors/floor_3.png";
import floor4 from "../../../assets/pixel-agents/floors/floor_4.png";
import floor5 from "../../../assets/pixel-agents/floors/floor_5.png";
import floor6 from "../../../assets/pixel-agents/floors/floor_6.png";
import floor7 from "../../../assets/pixel-agents/floors/floor_7.png";
import floor8 from "../../../assets/pixel-agents/floors/floor_8.png";
import wall0 from "../../../assets/pixel-agents/walls/wall_0.png";
import BIN from "../../../assets/pixel-agents/furniture/BIN.png";
import BOOKSHELF from "../../../assets/pixel-agents/furniture/BOOKSHELF.png";
import COFFEE from "../../../assets/pixel-agents/furniture/COFFEE.png";
import DESK_FRONT from "../../../assets/pixel-agents/furniture/DESK_FRONT.png";
import PC_FRONT_OFF from "../../../assets/pixel-agents/furniture/PC_FRONT_OFF.png";
import PC_FRONT_ON_1 from "../../../assets/pixel-agents/furniture/PC_FRONT_ON_1.png";
import PC_FRONT_ON_2 from "../../../assets/pixel-agents/furniture/PC_FRONT_ON_2.png";
import PC_FRONT_ON_3 from "../../../assets/pixel-agents/furniture/PC_FRONT_ON_3.png";
import PLANT from "../../../assets/pixel-agents/furniture/PLANT.png";
import SMALL_TABLE_FRONT from "../../../assets/pixel-agents/furniture/SMALL_TABLE_FRONT.png";
import SOFA_BACK from "../../../assets/pixel-agents/furniture/SOFA_BACK.png";
import SOFA_FRONT from "../../../assets/pixel-agents/furniture/SOFA_FRONT.png";
import TABLE_FRONT from "../../../assets/pixel-agents/furniture/TABLE_FRONT.png";
import WOODEN_CHAIR_BACK from "../../../assets/pixel-agents/furniture/WOODEN_CHAIR_BACK.png";
import WOODEN_CHAIR_FRONT from "../../../assets/pixel-agents/furniture/WOODEN_CHAIR_FRONT.png";
import WOODEN_CHAIR_SIDE from "../../../assets/pixel-agents/furniture/WOODEN_CHAIR_SIDE.png";

import { colorizePixels, hueShiftPixels } from "./colorize";
import type { FurnitureId, Hsbc, SpriteBank, SpriteImage } from "./renderTypes";

/** Asset URLs, in sheet order. Exported for the tests (they pin that every URL is requested). */
export const CHARACTER_URLS = [char0, char1, char2, char3, char4, char5];
export const FLOOR_URLS = [
  floor0,
  floor1,
  floor2,
  floor3,
  floor4,
  floor5,
  floor6,
  floor7,
  floor8,
];
export const WALL_URL = wall0;
export const FURNITURE_URLS: Record<FurnitureId, string> = {
  DESK_FRONT,
  SMALL_TABLE_FRONT,
  TABLE_FRONT,
  PC_FRONT_OFF,
  PC_FRONT_ON_1,
  PC_FRONT_ON_2,
  PC_FRONT_ON_3,
  WOODEN_CHAIR_FRONT,
  WOODEN_CHAIR_BACK,
  WOODEN_CHAIR_SIDE,
  PLANT,
  BOOKSHELF,
  BIN,
  COFFEE,
  SOFA_FRONT,
  SOFA_BACK,
};

/** Pixel sizes of the sheets (fixed by the vendored art). */
export const CHAR_SHEET = { w: 112, h: 96, frameW: 16, frameH: 32 } as const;
export const FLOOR_SIZE = 16;
export const WALL_SHEET = { w: 64, h: 128, pieceW: 16, pieceH: 32 } as const;
export const FURNITURE_SIZE: Record<FurnitureId, { w: number; h: number }> = {
  DESK_FRONT: { w: 48, h: 32 },
  SMALL_TABLE_FRONT: { w: 32, h: 32 },
  TABLE_FRONT: { w: 48, h: 64 },
  PC_FRONT_OFF: { w: 16, h: 32 },
  PC_FRONT_ON_1: { w: 16, h: 32 },
  PC_FRONT_ON_2: { w: 16, h: 32 },
  PC_FRONT_ON_3: { w: 16, h: 32 },
  WOODEN_CHAIR_FRONT: { w: 16, h: 32 },
  WOODEN_CHAIR_BACK: { w: 16, h: 32 },
  WOODEN_CHAIR_SIDE: { w: 16, h: 32 },
  PLANT: { w: 16, h: 32 },
  BOOKSHELF: { w: 32, h: 16 },
  BIN: { w: 16, h: 16 },
  COFFEE: { w: 16, h: 16 },
  SOFA_FRONT: { w: 32, h: 16 },
  SOFA_BACK: { w: 32, h: 16 },
};

/** The minimal 2D context a recolour needs (OffscreenCanvas or a DOM canvas both fit). */
export interface PixelContext {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  getImageData(
    x: number,
    y: number,
    w: number,
    h: number,
  ): { data: Uint8ClampedArray };
  putImageData(data: { data: Uint8ClampedArray }, x: number, y: number): void;
}

/** A scratch canvas: its context (or null) and the canvas itself as a drawable source. */
export interface ScratchCanvas {
  ctx: PixelContext | null;
  image: SpriteImage;
}

/** Host hooks, injectable so jsdom tests can stand in for decode and canvas. */
export interface SpriteDeps {
  loadImage(url: string): Promise<SpriteImage>;
  makeCanvas(w: number, h: number): ScratchCanvas | null;
}

/** Decode a PNG URL: `Image` + `decode()`, upgraded to an `ImageBitmap` when the host has one. */
export async function defaultLoadImage(url: string): Promise<SpriteImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return typeof createImageBitmap === "function" ? createImageBitmap(img) : img;
}

/** An `OffscreenCanvas` where available, else a detached DOM canvas. */
export function defaultMakeCanvas(w: number, h: number): ScratchCanvas | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), {
          width: w,
          height: h,
        });
  const ctx = canvas.getContext("2d") as unknown as PixelContext | null;
  return ctx ? { ctx, image: canvas } : null;
}

interface RawSheets {
  chars: SpriteImage[];
  floors: SpriteImage[];
  wall: SpriteImage;
  furniture: Record<FurnitureId, SpriteImage>;
}

const wrap = (i: number, n: number): number => ((Math.trunc(i) % n) + n) % n;

/** A bank with no art: the renderer draws every sprite as a coloured rectangle. */
export function fallbackBank(): SpriteBank {
  return {
    fallback: true,
    character: () => null,
    floor: () => null,
    wall: () => null,
    furniture: () => null,
  };
}

/** Build a bank over decoded sheets; recoloured variants render lazily and are cached by key. */
export function createBank(
  raw: RawSheets,
  makeCanvas: SpriteDeps["makeCanvas"],
): SpriteBank {
  const cache = new Map<string, SpriteImage | null>();

  /** Copy `src` into a scratch canvas, run `edit` over its pixels, cache the result (null if no canvas). */
  const variant = (
    key: string,
    src: SpriteImage,
    w: number,
    h: number,
    edit: (px: Uint8ClampedArray) => void,
  ): SpriteImage | null => {
    if (cache.has(key)) return cache.get(key) as SpriteImage | null;
    let out: SpriteImage | null = null;
    try {
      const scratch = makeCanvas(w, h);
      if (scratch?.ctx) {
        scratch.ctx.drawImage(src, 0, 0);
        const data = scratch.ctx.getImageData(0, 0, w, h);
        edit(data.data);
        scratch.ctx.putImageData(data, 0, 0);
        out = scratch.image;
      }
    } catch {
      out = null; // a tainted or unsupported canvas: degrade, never throw mid-frame
    }
    cache.set(key, out);
    return out;
  };

  const tintKey = (t: Hsbc): string => `${t.h},${t.s},${t.b},${t.c}`;

  return {
    fallback: false,
    character(palette, hueShift) {
      const p = wrap(palette, raw.chars.length);
      const hue = wrap(hueShift, 360);
      const base = raw.chars[p];
      if (hue === 0) return base;
      return (
        variant(`char-${p}-${hue}`, base, CHAR_SHEET.w, CHAR_SHEET.h, (px) =>
          hueShiftPixels(px, hue),
        ) ?? base
      );
    },
    floor(pattern, tint) {
      const p = wrap(pattern, raw.floors.length);
      return variant(
        `floor-${p}-${tintKey(tint)}`,
        raw.floors[p],
        FLOOR_SIZE,
        FLOOR_SIZE,
        (px) => colorizePixels(px, tint),
      );
    },
    wall(tint) {
      return variant(
        `wall-${tintKey(tint)}`,
        raw.wall,
        WALL_SHEET.w,
        WALL_SHEET.h,
        (px) => colorizePixels(px, tint),
      );
    },
    furniture(id) {
      return raw.furniture[id];
    },
  };
}

/**
 * Load and decode every vendored PNG. Resolves to a working bank, or — if any
 * image fails to load — to a `fallback` bank. Never rejects.
 */
export async function loadSprites(
  deps: Partial<SpriteDeps> = {},
): Promise<SpriteBank> {
  const loadImage = deps.loadImage ?? defaultLoadImage;
  const makeCanvas = deps.makeCanvas ?? defaultMakeCanvas;
  try {
    const furnitureIds = Object.keys(FURNITURE_URLS) as FurnitureId[];
    const [chars, floors, [wall], furn] = await Promise.all([
      Promise.all(CHARACTER_URLS.map(loadImage)),
      Promise.all(FLOOR_URLS.map(loadImage)),
      Promise.all([loadImage(WALL_URL)]),
      Promise.all(furnitureIds.map((id) => loadImage(FURNITURE_URLS[id]))),
    ]);
    const furniture = Object.fromEntries(
      furnitureIds.map((id, i) => [id, furn[i]]),
    ) as Record<FurnitureId, SpriteImage>;
    return createBank({ chars, floors, wall, furniture }, makeCanvas);
  } catch {
    return fallbackBank();
  }
}
