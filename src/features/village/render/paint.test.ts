/**
 * The painting primitives' screen snap: every world position lands on a whole screen
 * pixel — at a whole zoom (exactly `round(ox) + round(wx) * zoom`, as ever) and at an
 * overview zoom below 1, where a plain product would start art on half pixels.
 */

import { describe, expect, it } from "vitest";

import { onScreen, rect, sx, sy } from "./paint";
import { recorder } from "./testRecorder";

describe("sx / sy", () => {
  it("at a whole zoom: the rounded origin plus the rounded world px times the zoom", () => {
    const cam = { zoom: 3, ox: 10.4, oy: -4.6 };
    expect([sx(cam, 5), sy(cam, 5)]).toEqual([25, 10]);
    expect([sx(cam, 5.4), sy(cam, 5.6)]).toEqual([25, 13]);
  });

  it("below 1: still whole screen pixels (an odd world px at ½ floors, never 0.5)", () => {
    const half = { zoom: 0.5, ox: 7, oy: 3 };
    expect([sx(half, 16), sx(half, 17), sy(half, 33)]).toEqual([15, 15, 19]);
    const eighth = { zoom: 0.125, ox: 0, oy: 0 };
    // A tile edge (16 px) at ⅛ is exactly 2 screen px: the overview grid stays even.
    expect([sx(eighth, 16), sx(eighth, 32), sx(eighth, 15)]).toEqual([2, 4, 1]);
    for (const wx of [1, 3, 9, 27, 101]) expect(Number.isInteger(sx(half, wx))).toBe(true);
  });

  it("onScreen tests against the snapped position", () => {
    const cam = { zoom: 0.5, ox: 0, oy: 0 };
    const view = { w: 100, h: 100 };
    expect(onScreen(cam, view, 199, 0, 1, 1)).toBe(true); // x 99
    expect(onScreen(cam, view, 200, 0, 16, 16)).toBe(false); // x 100: just past the edge
    expect(onScreen(cam, view, -20, -20, 16, 16)).toBe(false); // ends at -2
  });
});

describe("rect — whole screen pixels at every zoom", () => {
  const box = (zoom: number, wx: number, wy: number, w: number, h: number): unknown[] => {
    const ctx = recorder();
    rect(ctx, { zoom, ox: 0, oy: 0 }, wx, wy, w, h, "#fff");
    return ctx.of("fillRect")[0].args;
  };

  it("at a whole zoom it is exactly the art scaled, as ever", () => {
    expect(box(3, 2, 5, 6, 1)).toEqual([6, 15, 18, 3]);
  });

  it("below 1 its edges snap like positions do, and a 1-px LED or 2-px meter keeps at least 1 px", () => {
    // 9/16 (the E2E city's Fit): a 6×1 rack LED and a 2-px context bar — never 0.56 or 1.1 px.
    expect(box(9 / 16, 16, 32, 6, 1)).toEqual([9, 18, 3, 1]);
    expect(box(9 / 16, 16, 32, 20, 2)).toEqual([9, 18, 11, 1]);
    for (const [wx, w] of [[3, 7], [17, 1], [100, 33]])
      for (const v of box(9 / 16, wx, wx, w, w)) expect(Number.isInteger(v as number)).toBe(true);
    // Neighbours share an edge: no seam, no overlap.
    const [ax, , aw] = box(9 / 16, 10, 0, 7, 1) as number[];
    const [bx] = box(9 / 16, 17, 0, 5, 1) as number[];
    expect(ax + aw).toBe(bx);
    // A zero-size rect stays zero.
    expect(box(0.5, 4, 4, 0, 3)).toEqual([2, 2, 0, 1]);
  });
});

