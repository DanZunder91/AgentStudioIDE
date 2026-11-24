import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_FIT_ZOOM,
  MIN_ZOOM,
  SUB_ZOOMS,
  clampZoom,
  fitCamera,
  screenToWorld,
  stepZoom,
  worldToScreen,
} from "./camera";
import * as api from "./index";

describe("clampZoom", () => {
  it("rounds to an integer inside 1..8", () => {
    expect(clampZoom(2.4)).toBe(2);
    expect(clampZoom(2.6)).toBe(3);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-5)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });

  it("maps non-finite input to the minimum", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("projection", () => {
  const cam = { zoom: 3, ox: 10, oy: -4 };

  it("world → screen scales by zoom and adds the origin offset", () => {
    expect(worldToScreen(cam, 16, 32)).toEqual({ x: 58, y: 92 });
  });

  it("screen → world is the exact inverse", () => {
    const s = worldToScreen(cam, 7.5, 21);
    expect(screenToWorld(cam, s.x, s.y)).toEqual({ x: 7.5, y: 21 });
    expect(screenToWorld(cam, 10, -4)).toEqual({ x: 0, y: 0 });
  });
});

describe("fitCamera", () => {
  it("picks the largest integer zoom that fits and centres the world", () => {
    // 320×160 world in an 1000×700 view: zoom 3 (960×480), centred.
    expect(fitCamera(320, 160, 1000, 700)).toEqual({
      zoom: 3,
      ox: 20,
      oy: 110,
    });
  });

  it("never goes below 1 by default — an oversized world overflows symmetrically (the village)", () => {
    expect(fitCamera(2000, 1000, 1000, 700)).toEqual({
      zoom: 1,
      ox: -500,
      oy: -150,
    });
  });

  it("with a lower floor, goes below 1 in whole sixteenths so ALL of an oversized world shows (a tall city at dpr 1)", () => {
    // 2000×1000 in 1000×700: zoom 1 would crop it; ½ shows it whole (1000×500), centred.
    expect(fitCamera(2000, 1000, 1000, 700, MIN_FIT_ZOOM)).toEqual({ zoom: 0.5, ox: 0, oy: 100 });
    // A little over the view: 13/16 (16-px tiles on 13 whole pixels), not ½.
    expect(fitCamera(1200, 100, 1000, 700, MIN_FIT_ZOOM).zoom).toBe(13 / 16);
    // Just over twice the view: 7/16 — always whole sixteenths, never 0.49.
    expect(fitCamera(2001, 100, 1000, 700, MIN_FIT_ZOOM).zoom).toBe(7 / 16);
    for (const w of [1001, 1300, 1777, 3000, 7000]) expect((fitCamera(w, 100, 1000, 700, MIN_FIT_ZOOM).zoom * 16) % 1).toBe(0);
    expect(fitCamera(100, 5000, 1000, 700, MIN_FIT_ZOOM).zoom).toBe(0.125);
    // The floor given is honoured…
    expect(fitCamera(100, 5000, 1000, 700, 0.5).zoom).toBe(0.5);
    // …but never below ⅛ (past it the world overflows symmetrically), nor above 1.
    expect(fitCamera(16_000, 800, 1000, 700, 0)).toEqual({ zoom: MIN_FIT_ZOOM, ox: -500, oy: 300 });
    expect(fitCamera(2000, 1000, 1000, 700, 4).zoom).toBe(1);
    // A 0×0 view is no reason for NaN (the view guards it, but the maths must hold).
    expect(fitCamera(320, 160, 0, 0, MIN_FIT_ZOOM).zoom).toBe(MIN_FIT_ZOOM);
  });

  it("caps at the maximum zoom for a tiny world", () => {
    expect(fitCamera(16, 16, 4000, 4000).zoom).toBe(MAX_ZOOM);
  });

  it("survives a degenerate zero-sized world", () => {
    expect(fitCamera(0, 0, 100, 100)).toEqual({ zoom: 8, ox: 50, oy: 50 });
  });
});

describe("stepZoom", () => {
  it("steps whole zooms from 1 up, the ¾ / ½ / ¼ / ⅛ rungs below 1, capped at MAX_ZOOM", () => {
    expect(stepZoom(2, 1)).toBe(3);
    expect(stepZoom(3, -2)).toBe(1);
    expect(stepZoom(7, 5)).toBe(MAX_ZOOM);
    expect(stepZoom(0.25, 1, 0.25)).toBe(0.5);
    expect(stepZoom(0.5, 1, 0.25)).toBe(0.75);
    expect(stepZoom(0.75, 1, 0.25)).toBe(1);
    expect(stepZoom(0.25, 4, 0.25)).toBe(2);
    expect(SUB_ZOOMS.map((z) => 16 * z)).toEqual([12, 8, 4, 2]); // every rung keeps a tile on whole pixels
    // Below the default floor, any step lands on 1 at least.
    expect(stepZoom(0.25, 1)).toBe(MIN_ZOOM);
  });

  it("stops zooming out at the floor: MIN_ZOOM by default, lower only when asked, never below ⅛", () => {
    expect(stepZoom(1, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(2, -5)).toBe(MIN_ZOOM);
    expect(stepZoom(1, -1, 0.25)).toBe(0.75);
    expect(stepZoom(1, -2, 0.25)).toBe(0.5);
    expect(stepZoom(1, -5, 0.25)).toBe(0.25);
    expect(stepZoom(1, -9, 0)).toBe(MIN_FIT_ZOOM);
  });
});

describe("public API barrel", () => {
  it("exports exactly the renderer surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "clampZoom",
        "defaultMakeLayer",
        "fitCamera",
        "isWet",
        "loadSprites",
        "paintAmbience",
        "paintGround",
        "paintPuddles",
        "renderFrame",
        "screenToWorld",
        "worldToScreen",
      ].sort(),
    );
  });
});
