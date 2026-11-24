/**
 * Layer 5 — the shop signs' pixel kana in a REAL canvas (neon signs for
 * ramen and soba in katakana, sushi in hiragana).
 *
 * The jsdom suite (kana.test.ts) proves the runs paint the art; only a real 2D context can prove
 * the art reaches the screen intact once the engine's snapping `rect` (render/paint.ts) scales it:
 * every world pixel a crisp, uniform block — no anti-aliased edge, no stroke lost or doubled — at
 * a typical Fit (@2x a world px is one device px) and zoomed in on the street.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/kana.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { SIGN_WORDS } from "./backdrop";
import type { Camera } from "./camera";
import { KANA_H, KANA_W, kanaText, type Run } from "./kana";
import { rect, sx, sy } from "./paint";

afterEach(() => {
  document.body.innerHTML = "";
});

const INK = [255, 95, 168]; // a neon pink
const NIGHT = [21, 18, 28];
const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** World px where the text's top-left sits (odd, so the snapping has something to do). */
const X0 = 5;
const Y0 = 3;

/** `text` painted through the engine's `rect` at `zoom`, on a night canvas with a margin all round. */
function paintSign(text: string, vertical: boolean, zoom: number) {
  const t = kanaText(text, vertical);
  const cam: Camera = { zoom, ox: 7.4, oy: 2.6 };
  const canvas = document.createElement("canvas");
  canvas.width = sx(cam, X0 + t.w + 4);
  canvas.height = sy(cam, Y0 + t.h + 4);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = hex(NIGHT);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [dx, dy, w, h] of t.runs) rect(ctx, cam, X0 + dx, Y0 + dy, w, h, hex(INK));
  return { t, cam, img: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/** The runs as a `w×h` raster, `X`/`.` — the bitmap the screen must show. */
function raster(runs: readonly Run[], w: number, h: number): string[] {
  const cells = Array.from({ length: h }, () => Array<string>(w).fill("."));
  for (const [x, y, rw, rh] of runs) for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) cells[j][i] = "X";
  return cells.map((r) => r.join(""));
}

/**
 * Read the screen back as world pixels: each world pixel's snapped screen block must be ONE colour
 * — all ink or all night — or it is reported as `?`.
 */
function readBack({ t, cam, img }: ReturnType<typeof paintSign>): string[] {
  const px = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  const rows: string[] = [];
  for (let j = 0; j < t.h; j++) {
    let row = "";
    for (let i = 0; i < t.w; i++) {
      const seen = new Set<string>();
      for (let y = sy(cam, Y0 + j); y < sy(cam, Y0 + j + 1); y++)
        for (let x = sx(cam, X0 + i); x < sx(cam, X0 + i + 1); x++) seen.add(px(x, y).join());
      row += seen.size !== 1 ? "?" : seen.has(INK.join()) ? "X" : seen.has(NIGHT.join()) ? "." : "?";
    }
    rows.push(row);
  }
  return rows;
}

/** How many pixels of the canvas outside the text's snapped box are not night (none should be). */
function inkOutside({ t, cam, img }: ReturnType<typeof paintSign>): number {
  const [bx0, by0, bx1, by1] = [sx(cam, X0), sy(cam, Y0), sx(cam, X0 + t.w), sy(cam, Y0 + t.h)];
  let n = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (x >= bx0 && x < bx1 && y >= by0 && y < by1) continue;
      if (img.data[(y * img.width + x) * 4] !== NIGHT[0]) n++;
    }
  return n;
}

describe("the kana in a real canvas", () => {
  it("paints every sign word, both ways, as crisp whole pixels at Fit (×1) and zoomed (×2, ×3)", () => {
    for (const zoom of [1, 2, 3])
      for (const { text } of SIGN_WORDS)
        for (const vertical of [false, true]) {
          const s = paintSign(text, vertical, zoom);
          const what = `${text} ${vertical ? "vertical" : "horizontal"} ×${zoom}`;
          expect(readBack(s), what).toEqual(raster(s.t.runs, s.t.w, s.t.h));
          expect(inkOutside(s), what).toBe(0);
        }
  });

  it("shows バー both ways: the dakuten's two ticks apart from the body, ー lying flat — and turned to ｜ on a blade sign", () => {
    // At Fit (×1: one device px a world px, @2x) — the size the user sees first.
    expect(readBack(paintSign("バー", false, 1))).toEqual([
      ".....X.X.........",
      ".....X.X.........",
      "..X..............",
      "..X..X....XXXXXX.",
      ".X....X..........",
      ".X....X..........",
      "X......X.........",
      "X......X.........",
    ]);
    expect(readBack(paintSign("バー", true, 3))).toEqual([
      ".....X.X",
      ".....X.X",
      "..X.....",
      "..X..X..",
      ".X....X.",
      ".X....X.",
      "X......X",
      "X......X",
      "........",
      "........",
      "....X...",
      "....X...",
      "....X...",
      "....X...",
      "....X...",
      "....X...",
      "........",
    ]);
  });

  it("shows すし — the hiragana sushi — with す's loop open and し's curve", () => {
    const rows = readBack(paintSign("すし", false, 2));
    expect(rows).toHaveLength(KANA_H);
    expect(rows.map((r) => r.slice(0, KANA_W))).toEqual([
      "....X...",
      "XXXXXXXX",
      "....X...",
      "..XXX...",
      ".X..X...",
      "..XXX...",
      "....X...",
      "...X....",
    ]);
    expect(rows.map((r) => r.slice(KANA_W + 1))).toEqual([
      ".X......",
      ".X......",
      ".X......",
      ".X......",
      ".X......",
      ".X.....X",
      ".X....X.",
      "..XXXX..",
    ]);
  });
});
