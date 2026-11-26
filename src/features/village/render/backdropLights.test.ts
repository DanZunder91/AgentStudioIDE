/** Proved on recorded pixels at zoom 1 with no offset, so a world pixel is a canvas pixel. */

import { describe, expect, it, vi } from "vitest";

import { lightCutter, subtract, type Box, type InFront } from "./backdropLights";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
const NONE: InFront = { boxes: [], face: null, shapes: [] };

/** The set of pixels the recording filled, as "x,y". */
function lit(ctx: RecordingTarget): Set<string> {
  const out = new Set<string>();
  for (const c of ctx.of("fillRect")) {
    const [x, y, w, h] = c.args as number[];
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.add(`${i},${j}`);
  }
  return out;
}

/** Every pixel of `r` for which `keep` holds. */
function pixels(r: Box, keep: (x: number, y: number) => boolean = () => true): Set<string> {
  const out = new Set<string>();
  for (let j = r[1]; j < r[1] + r[3]; j++) for (let i = r[0]; i < r[0] + r[2]; i++) if (keep(i, j)) out.add(`${i},${j}`);
  return out;
}

const inBox = (b: Box, x: number, y: number) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];

describe("subtract", () => {
  it("leaves a rect the box misses whole, and none of one the box covers", () => {
    expect(subtract([0, 0, 4, 4], [4, 0, 2, 2])).toEqual([[0, 0, 4, 4]]);
    expect(subtract([0, 0, 4, 4], [0, 4, 4, 2])).toEqual([[0, 0, 4, 4]]);
    expect(subtract([2, 2, 2, 2], [0, 0, 8, 8])).toEqual([]);
  });

  it("splits round a box inside it: above, below, left, right — exactly the pixels outside it", () => {
    const r: Box = [0, 0, 10, 8];
    const box: Box = [3, 2, 4, 3];
    const parts = subtract(r, box);
    expect(parts).toEqual([
      [0, 0, 10, 2],
      [0, 5, 10, 3],
      [0, 2, 3, 3],
      [7, 2, 3, 3],
    ]);
    const covered = new Set(parts.flatMap((p) => [...pixels(p)]));
    expect(covered).toEqual(pixels(r, (x, y) => !inBox(box, x, y)));
  });

  it("keeps only the sides the box leaves when it hangs over an edge", () => {
    expect(subtract([0, 0, 10, 8], [-2, -2, 5, 20])).toEqual([[3, 0, 7, 8]]);
    expect(subtract([0, 0, 10, 8], [-2, 6, 20, 5])).toEqual([[0, 0, 10, 6]]);
  });
});

describe("lightCutter", () => {
  it("fills a rect with nothing in front as ONE fill, in the current style and alpha", () => {
    const ctx = recorder();
    ctx.fillStyle = "#ffcc00";
    ctx.globalAlpha = 0.5;
    lightCutter(ctx, cam, NONE).fillLit(2, 3, 5, 4);
    expect(ctx.of("fillRect").map((c) => [c.args, c.fillStyle, c.alpha])).toEqual([[[2, 3, 5, 4], "#ffcc00", 0.5]]);
  });

  it("snaps to the camera like `rect`: zoom and offset", () => {
    const ctx = recorder();
    lightCutter(ctx, { zoom: 2, ox: 10, oy: -4 }, NONE).fillLit(1, 1, 3, 2);
    expect(ctx.of("fillRect")[0].args).toEqual([12, -2, 6, 4]);
  });

  it("leaves out every box in front — a passer-by in front of a lit shop front leaves a hole of exactly its box", () => {
    const walker: Box = [5, 2, 3, 6];
    const lamp: Box = [12, 0, 2, 10];
    const ctx = recorder();
    lightCutter(ctx, cam, { ...NONE, boxes: [walker, lamp] }).fillLit(0, 0, 20, 8);
    expect(lit(ctx)).toEqual(pixels([0, 0, 20, 8], (x, y) => !inBox(walker, x, y) && !inBox(lamp, x, y)));
  });

  it("splits round a box flush with the light's left or right edge without a sliver on that side", () => {
    for (const box of [
      [0, 2, 3, 3],
      [7, 2, 3, 3],
    ] as Box[]) {
      const ctx = recorder();
      lightCutter(ctx, cam, { ...NONE, boxes: [box] }).fillLit(0, 0, 10, 6);
      expect(lit(ctx)).toEqual(pixels([0, 0, 10, 6], (x, y) => !inBox(box, x, y)));
      expect(ctx.of("fillRect").every((c) => (c.args[2] as number) > 0)).toBe(true);
    }
  });

  it("never cuts round a box or a shape that only touches the light's edge", () => {
    const hit = vi.fn(() => true);
    const ctx = recorder();
    const cut = lightCutter(ctx, cam, {
      boxes: [
        [10, 0, 4, 4],
        [0, 4, 10, 4],
      ],
      face: null,
      shapes: [
        { box: [-4, 0, 4, 4], hit },
        { box: [0, -4, 10, 4], hit },
      ],
    });
    cut.fillLit(0, 0, 10, 4);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([[0, 0, 10, 4]]);
    expect(hit).not.toHaveBeenCalled();
  });

  it("never paints a light narrower than one screen pixel as nothing, zoomed out", () => {
    const ctx = recorder();
    lightCutter(ctx, { zoom: 0.5, ox: 0, oy: 0 }, NONE).fillLit(2, 2, 1, 1);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([[1, 1, 1, 1]]);
  });

  it("cuts at the face, column by column, a run of equal cuts one rect — and nothing where the face is above the light", () => {
    const face = (x: number) => (x < 4 ? 5 : x < 8 ? 2 : -10);
    const ctx = recorder();
    lightCutter(ctx, cam, { ...NONE, face }).fillLit(0, 0, 12, 8);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([
      [0, 0, 4, 5],
      [4, 0, 4, 2],
    ]);
  });

  it("cuts a face that rises and falls again, and lights to the rect's bottom where the face is below it", () => {
    const face = (x: number) => (x === 3 ? 1 : 100);
    const ctx = recorder();
    lightCutter(ctx, cam, { ...NONE, face }).fillLit(0, 0, 6, 4);
    expect(lit(ctx)).toEqual(pixels([0, 0, 6, 4], (x, y) => x !== 3 || y < 1));
  });

  it("tests pixel by pixel only where a landmark's box overlaps the light", () => {
    const box: Box = [10, 0, 4, 8];
    const hit = (x: number, y: number) => x >= 11 && x < 13 && y >= 2;
    let tested = 0;
    const counted = (x: number, y: number) => {
      tested++;
      return hit(x, y);
    };
    const away = recorder();
    lightCutter(away, cam, { ...NONE, shapes: [{ box, hit: counted }] }).fillLit(0, 0, 8, 8);
    expect(tested).toBe(0);
    expect(away.of("fillRect").map((c) => c.args)).toEqual([[0, 0, 8, 8]]);
    const over = recorder();
    lightCutter(over, cam, { ...NONE, shapes: [{ box, hit: counted }] }).fillLit(8, 0, 8, 4);
    expect(tested).toBeGreaterThan(0);
    expect(lit(over)).toEqual(pixels([8, 0, 8, 4], (x, y) => !hit(x, y)));
    // A run of uncovered pixels in a row is one rect.
    expect(over.of("fillRect").map((c) => c.args)).toEqual([
      [8, 0, 8, 1],
      [8, 1, 8, 1],
      [8, 2, 3, 1],
      [13, 2, 3, 1],
      [8, 3, 3, 1],
      [13, 3, 3, 1],
    ]);
  });

  it("cuts a shape that is one run a row a row at a time: the pixels pixel-by-pixel would leave, in a rect per run of alike rows", () => {
    // A tower widening downward: nothing above row 2, then [5 − ⌊y/2⌋, 6 + ⌊y/2⌋).
    const row = (y: number): [number, number] | null => (y < 2 ? null : [5 - (y >> 1), 6 + (y >> 1)]);
    const hit = (x: number, y: number) => {
      const r = row(y);
      return r !== null && x >= r[0] && x < r[1];
    };
    const box: Box = [0, 0, 12, 12];
    const byPixel = recorder();
    lightCutter(byPixel, cam, { ...NONE, shapes: [{ box, hit }] }).fillLit(0, 0, 12, 8);
    const byRow = recorder();
    const cut = lightCutter(byRow, cam, { ...NONE, shapes: [{ box, hit: () => true, row }] });
    cut.fillLit(0, 0, 12, 8);
    expect(lit(byRow)).toEqual(lit(byPixel));
    expect(byRow.of("fillRect").map((c) => c.args)).toEqual([
      [0, 0, 12, 2],
      [0, 2, 4, 2],
      [7, 2, 5, 2],
      [0, 4, 3, 2],
      [8, 4, 4, 2],
      [0, 6, 2, 2],
      [9, 6, 3, 2],
    ]);
    // `hidden` reads the row too (its pixel test, `hit`, says "everywhere" and is not asked).
    expect(cut.hidden(4, 2)).toBe(true);
    expect(cut.hidden(6, 2)).toBe(true);
    expect(cut.hidden(7, 2)).toBe(false);
    expect(cut.hidden(3, 2)).toBe(false);
    expect(cut.hidden(4, 1)).toBe(false);
  });

  it("leaves a light that misses a one-run-a-row shape's box whole, and cuts only the pieces that meet it", () => {
    const row = (): [number, number] => [0, 100];
    const ctx = recorder();
    lightCutter(ctx, cam, { boxes: [[4, 0, 2, 4]], face: null, shapes: [{ box: [8, 0, 4, 4], hit: () => true, row }] }).fillLit(0, 0, 8, 4);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([
      [0, 0, 4, 4],
      [6, 0, 2, 4],
    ]);
  });

  it("leaves whole a row whose run lies wholly left or right of the light, though the shape's box meets it", () => {
    const row = (y: number): [number, number] => (y === 0 ? [0, 5] : [20, 30]);
    const ctx = recorder();
    lightCutter(ctx, cam, { boxes: [[100, 0, 4, 4]], face: null, shapes: [{ box: [0, 0, 30, 4], hit: () => true, row }] }).fillLit(8, 0, 6, 2);
    expect(ctx.of("fillRect").map((c) => c.args)).toEqual([[8, 0, 6, 2]]);
  });

  it("cuts a light's left end, its right end, or all of it, where a row's run reaches past its edge", () => {
    const cases: [[number, number], number[][]][] = [
      [[-5, 10], [[10, 0, 4, 1]]],
      [[8, 10], [[10, 0, 4, 1]]],
      [[12, 50], [[8, 0, 4, 1]]],
      [[12, 14], [[8, 0, 4, 1]]],
      [[0, 50], []],
    ];
    for (const [run, rects] of cases) {
      const ctx = recorder();
      lightCutter(ctx, cam, { ...NONE, shapes: [{ box: [0, 0, 60, 4], hit: () => true, row: () => run }] }).fillLit(8, 0, 6, 1);
      expect(ctx.of("fillRect").map((c) => c.args)).toEqual(rects);
    }
  });

  it("looks the face up once per column a frame, however many lights stand in that column", () => {
    const face = vi.fn((x: number) => (x < 3 ? 2 : 50));
    const cut = lightCutter(recorder(), cam, { ...NONE, face });
    for (let y = 0; y < 10; y += 2) cut.fillLit(0, y, 6, 1);
    expect(face.mock.calls.map(([x]) => x).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cut.hidden(1, 3)).toBe(true);
    expect(face).toHaveBeenCalledTimes(6);
  });

  it("applies all three together", () => {
    const boxes: Box[] = [[0, 6, 3, 2]];
    const face = (x: number) => (x >= 14 ? 3 : 100);
    const hit = (x: number, y: number) => x === 8 && y === 1;
    const ctx = recorder();
    lightCutter(ctx, cam, { boxes, face, shapes: [{ box: [8, 1, 1, 1], hit }] }).fillLit(0, 0, 16, 8);
    expect(lit(ctx)).toEqual(pixels([0, 0, 16, 8], (x, y) => !inBox(boxes[0], x, y) && y < face(x) && !hit(x, y)));
  });

  it("`hidden` says the same as `fillLit` leaves out", () => {
    const front: InFront = {
      boxes: [[2, 2, 2, 2]],
      face: (x) => (x > 9 ? 4 : 100),
      shapes: [{ box: [6, 0, 2, 8], hit: (x, y) => x === 6 && y % 2 === 0 }],
    };
    const ctx = recorder();
    const cut = lightCutter(ctx, cam, front);
    cut.fillLit(0, 0, 12, 8);
    expect(lit(ctx)).toEqual(pixels([0, 0, 12, 8], (x, y) => !cut.hidden(x, y)));
    expect(cut.hidden(3, 3)).toBe(true);
    expect(cut.hidden(10, 4)).toBe(true);
    expect(cut.hidden(10, 3)).toBe(false);
    expect(cut.hidden(6, 2)).toBe(true);
    expect(cut.hidden(6, 3)).toBe(false);
    expect(lightCutter(ctx, cam, NONE).hidden(0, 0)).toBe(false);
  });
});
