/**
 * A passer-by's umbrella (render/umbrella.ts): the stick behind the holder, the canopy over its head —
 * as wide as it is open, leaning into the wind, in one of six canopies (one of them clear).
 */

import { describe, expect, it } from "vitest";

import { CANOPIES as ENGINE_CANOPIES } from "../engine/streetLife";
import { CANOPIES, CLEAR_ALPHA, DOME, drawCanopy, drawShaft, HAND, lean, RIM, SHAFT, TIP, TOP } from "./umbrella";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
type Fill = { x: number; y: number; w: number; h: number; style: string; alpha: number };
const fills = (ctx: RecordingTarget): Fill[] =>
  ctx.of("fillRect").map((c) => {
    const [x, y, w, h] = c.args as number[];
    return { x, y, w, h, style: c.fillStyle, alpha: c.alpha };
  });

/** Feet of the holder. */
const X = 100;
const Y = 200;

describe("drawCanopy", () => {
  it("draws nothing while closed", () => {
    const ctx = recorder();
    drawCanopy(ctx, cam, X, Y, 1, 0, 0, 0);
    expect(ctx.calls).toHaveLength(0);
  });

  it("open, it is a dome over the head — 19 px across at the rim, narrowing to its top — centred on the stick, a pixel in front of the body", () => {
    for (const dir of [1, -1] as const) {
      const ctx = recorder();
      drawCanopy(ctx, cam, X, Y, dir, 1, 0, 0);
      const c = CANOPIES[0];
      const cloth = fills(ctx).filter((f) => f.style === c.cloth);
      const cx = X + dir;
      // One row of cloth per dome row, top to rim, each centred on the stick.
      expect(cloth.map((f) => [f.y, f.w, f.x + (f.w - 1) / 2])).toEqual(DOME.map((h, r) => [Y - TOP + r, 2 * h + 1, cx]));
      expect(cloth[cloth.length - 1].y).toBe(Y - RIM);
      expect(cloth[cloth.length - 1].w).toBe(19);
      // A dome: every row at least as wide as the one above.
      for (let i = 1; i < cloth.length; i++) expect(cloth[i].w).toBeGreaterThanOrEqual(cloth[i - 1].w);
      // Over the head (whose top is ≥ 27 px above the feet), never on the face.
      for (const f of fills(ctx)) expect(f.y + f.h).toBeLessThanOrEqual(Y - 29);
      // The ribs' tips on the rim, at its ends and halfway; the shine on the second row's left; the ferrule on top.
      expect(fills(ctx).filter((f) => f.style === c.rib).map((f) => [f.x - cx, f.y])).toEqual([-9, -5, 5, 9].map((dx) => [dx, Y - RIM]));
      expect(fills(ctx).filter((f) => f.style === c.shine)).toEqual([{ x: cx - 5 + 1, y: Y - TOP + 1, w: 2, h: 1, style: c.shine, alpha: 1 }]);
      expect(fills(ctx).filter((f) => f.style === SHAFT)).toEqual([{ x: cx, y: Y - TIP, w: 1, h: 1, style: SHAFT, alpha: 1 }]);
    }
  });

  it("opening, it is narrower: half open, half as wide — never under a pixel either side", () => {
    const half = recorder();
    drawCanopy(half, cam, X, Y, 1, 0.5, 1, 0);
    const rim = fills(half).filter((f) => f.style === CANOPIES[1].cloth).pop()!;
    expect(rim.w).toBe(2 * Math.round(9 * 0.5) + 1);
    const bud = recorder();
    drawCanopy(bud, cam, X, Y, 1, 0.01, 1, 0);
    for (const f of fills(bud).filter((g) => g.style === CANOPIES[1].cloth)) expect(f.w).toBe(3);
    // Past 1 is fully open.
    const over = recorder();
    drawCanopy(over, cam, X, Y, 1, 1.5, 1, 0);
    expect(fills(over).filter((f) => f.style === CANOPIES[1].cloth).pop()!.w).toBe(19);
  });

  it("leans into the wind: its top two rows shift against the way the rain blows; calm, it stands straight", () => {
    expect(lean(0)).toBe(0);
    expect(lean(0.2)).toBe(0);
    expect(lean(0.3)).toBe(-1);
    expect(lean(1)).toBe(-2);
    expect(lean(-1)).toBe(2);
    const rows = (wind: number) => {
      const ctx = recorder();
      drawCanopy(ctx, cam, X, Y, 1, 1, 2, wind);
      return fills(ctx).filter((f) => f.style === CANOPIES[2].cloth).map((f) => f.x + (f.w - 1) / 2 - (X + 1));
    };
    expect(rows(0)).toEqual([0, 0, 0, 0, 0]);
    expect(rows(1)).toEqual([-2, -1, 0, 0, 0]);
    expect(rows(-1)).toEqual([2, 1, 0, 0, 0]);
  });

  it("six canopies, by index (wrapped either way) — the engine draws from the same six; the clear one's cloth is see-through, its ribs are not", () => {
    expect(CANOPIES).toHaveLength(ENGINE_CANOPIES);
    expect(new Set(CANOPIES.map((c) => c.cloth)).size).toBe(6);
    const clothOf = (i: number) => {
      const ctx = recorder();
      drawCanopy(ctx, cam, X, Y, 1, 1, i, 0);
      return fills(ctx)[0];
    };
    expect(clothOf(6).style).toBe(CANOPIES[0].cloth);
    expect(clothOf(-1).style).toBe(CANOPIES[5].cloth);
    const clear = CANOPIES.findIndex((c) => c.clear);
    expect(clear).toBeGreaterThanOrEqual(0);
    const ctx = recorder();
    drawCanopy(ctx, cam, X, Y, 1, 1, clear, 0);
    for (const f of fills(ctx)) expect(f.alpha).toBe(f.style === CANOPIES[clear].cloth ? CLEAR_ALPHA : 1);
    expect(ctx.globalAlpha).toBe(1);
    // Every other canopy is opaque.
    const red = recorder();
    drawCanopy(red, cam, X, Y, 1, 1, 0, 0);
    for (const f of fills(red)) expect(f.alpha).toBe(1);
  });
});

describe("drawShaft", () => {
  it("is a one-pixel stick from the rim down to the hand, on the canopy's centre", () => {
    for (const dir of [1, -1] as const) {
      const ctx = recorder();
      drawShaft(ctx, cam, X, Y, dir);
      expect(fills(ctx)).toEqual([{ x: X + dir, y: Y - RIM + 1, w: 1, h: RIM - 1 - HAND, style: SHAFT, alpha: 1 }]);
    }
  });
});
