import { describe, expect, it } from "vitest";

import { drawRouter, ROUTER, ROUTER_LEDS, ROUTER_RISE } from "./router";
import { recorder, type RecordingTarget } from "./testRecorder";

const X0 = 32;
const BOTTOM = 48;
const TOP = BOTTOM - 16;

const draw = (on: boolean, frame: number, zoom = 1) => {
  const ctx = recorder();
  drawRouter(ctx, { zoom, ox: 0, oy: 0 }, X0, BOTTOM, on, frame);
  return ctx;
};
const fills = (ctx: RecordingTarget) => ctx.of("fillRect").map((c) => ({ args: c.args as number[], style: c.fillStyle }));
/** The three activity LEDs' colours, left to right: 1×1 fills on the LED row, right of the power LED. */
const leds = (ctx: RecordingTarget): string[] =>
  fills(ctx)
    .filter((f) => f.args[1] === TOP + 6 && f.args[2] === 1 && f.args[3] === 1 && f.args[0] > X0 + 4)
    .map((f) => f.style);

/** "#rrggbb" → WCAG relative luminance. */
function luminance(css: string): number {
  const lin = (i: number) => {
    const s = parseInt(css.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

describe("drawRouter — a project room's Wi-Fi router", () => {
  it("is a 14×8 outlined box hung at the top of its tile: a white top over a grey front, its bottom edge just under the tile's centre line", () => {
    const f = fills(draw(false, 0));
    const find = (style: string) => f.filter((x) => x.style === style).map((x) => x.args);
    expect(find(ROUTER.outline)).toEqual([[X0 + 1, TOP + 1, 14, 8]]);
    expect(find(ROUTER.top)).toEqual([[X0 + 2, TOP + 2, 12, 3]]);
    expect(find(ROUTER.face)).toEqual([[X0 + 2, TOP + 5, 12, 3]]);
    // The room's cables meet the router at its tile's centre (x0 + 8, bottom − 8): under the box.
    const [ox, oy, ow, oh] = find(ROUTER.outline)[0];
    expect(ox <= X0 + 8 && X0 + 8 < ox + ow && oy <= BOTTOM - 8 && BOTTOM - 8 < oy + oh).toBe(true);
    expect(oy + oh).toBe(BOTTOM - 7);
  });

  it("has two antennas leaning out of its top corners, light-tipped, rising ROUTER_RISE px above the tile", () => {
    const f = fills(draw(false, 0));
    const above = f.filter((x) => x.args[1] < TOP);
    // Per antenna: the stub (from TOP − 1), the leaning part and its tip (from TOP − ROUTER_RISE).
    expect(above.map((x) => x.args)).toEqual([
      [X0 + 3, TOP - 1, 1, 2],
      [X0 + 2, TOP - ROUTER_RISE, 1, 3],
      [X0 + 2, TOP - ROUTER_RISE, 1, 1],
      [X0 + 12, TOP - 1, 1, 2],
      [X0 + 13, TOP - ROUTER_RISE, 1, 3],
      [X0 + 13, TOP - ROUTER_RISE, 1, 1],
    ]);
    expect(above.map((x) => x.style)).toEqual([ROUTER.antenna, ROUTER.antenna, ROUTER.tip, ROUTER.antenna, ROUTER.antenna, ROUTER.tip]);
    expect(ROUTER_RISE).toBeGreaterThan(0);
    expect(ROUTER_RISE).toBeLessThanOrEqual(6);
  });

  it("paints only inside its tile and the antennas' few px above it, at every zoom, on or off, every frame", () => {
    for (const on of [true, false])
      for (const zoom of [1, 2, 3, 4])
        for (const frame of [0, 1, 2]) {
          const boxes = fills(draw(on, frame, zoom)).map((x) => x.args);
          expect(boxes.length).toBeGreaterThan(ROUTER_LEDS + 6);
          for (const [x, y, w, h] of boxes) {
            expect(x).toBeGreaterThanOrEqual((X0 + 1) * zoom);
            expect(x + w).toBeLessThanOrEqual((X0 + 15) * zoom);
            expect(y).toBeGreaterThanOrEqual((TOP - ROUTER_RISE) * zoom);
            expect(y + h).toBeLessThanOrEqual((BOTTOM - 6) * zoom);
          }
        }
  });

  it("on: every activity LED is lit (link green or a flash); off: every one is dim — the power LED lit either way", () => {
    for (const frame of [0, 1, 2]) {
      const lit = leds(draw(true, frame));
      expect(lit).toHaveLength(ROUTER_LEDS);
      expect(lit.every((c) => c === ROUTER.ledOn || c === ROUTER.ledBlink)).toBe(true);
      expect(lit).toContain(ROUTER.ledOn);
      expect(lit).toContain(ROUTER.ledBlink);
      expect(leds(draw(false, frame))).toEqual(new Array(ROUTER_LEDS).fill(ROUTER.ledOff));
    }
    for (const on of [true, false]) expect(fills(draw(on, 0)).filter((x) => x.style === ROUTER.power).map((x) => x.args)).toEqual([[X0 + 4, TOP + 6, 1, 1]]);
  });

  it("on, the flashing LED moves with the frame (three distinct frames, then round again); off, nothing moves", () => {
    const calls = (on: boolean, frame: number) => JSON.stringify(draw(on, frame).calls);
    expect(new Set([0, 1, 2].map((f) => calls(true, f))).size).toBe(3);
    expect(leds(draw(true, 0))).toEqual([ROUTER.ledBlink, ROUTER.ledOn, ROUTER.ledOn]);
    expect(leds(draw(true, 1))).toEqual([ROUTER.ledOn, ROUTER.ledOn, ROUTER.ledBlink]);
    expect(leds(draw(true, 2))).toEqual([ROUTER.ledOn, ROUTER.ledBlink, ROUTER.ledOn]);
    expect(calls(true, 3)).toBe(calls(true, 0));
    expect(calls(true, -1)).toBe(calls(true, 2));
    expect(calls(true, 1.7)).toBe(calls(true, 1));
    expect(new Set([0, 1, 2, 7].map((f) => calls(false, f))).size).toBe(1);
  });

  it("reads: the outline stands ≥ 3:1 off the white top, every LED (dim ones too) ≥ 3:1 off its dark window", () => {
    expect(contrast(ROUTER.outline, ROUTER.top)).toBeGreaterThanOrEqual(3);
    expect(contrast(ROUTER.outline, ROUTER.face)).toBeGreaterThanOrEqual(3);
    for (const led of [ROUTER.power, ROUTER.ledOn, ROUTER.ledBlink]) expect(contrast(led, ROUTER.window)).toBeGreaterThanOrEqual(3);
    // Dim is dim: darker than any lit LED, yet not the window itself.
    for (const led of [ROUTER.ledOn, ROUTER.ledBlink]) expect(luminance(ROUTER.ledOff)).toBeLessThan(luminance(led));
    expect(ROUTER.ledOff).not.toBe(ROUTER.window);
  });
});
