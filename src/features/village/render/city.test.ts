import { describe, expect, it, vi } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { citySky, SKY_BANDS } from "../engine/ambience";
import { TILE, type Ambience, type WeatherKind, type WeatherWire } from "../villageTypes";
import {
  bodyCenter,
  CITY,
  DUG,
  forEachSkylineBlock,
  forEachSkylineWindow,
  paintCityBackdrop,
  paintCityNight,
  screenRect,
  shootingStar,
  SHOOTING_MS,
  SHOOTING_PERIOD_MS,
  skylineFaceAt,
  skylineOccluders,
  STRATUM,
  STREET_H,
  TURF,
  windowLit,
} from "./city";
import type { Camera } from "./camera";
import type { GroundLayer } from "./ground";
import { landmarkMask, paintFarLandmarks, paintLandmarkLights, paintLandmarks, paintNearLandmarks } from "./landmarks";
import { hash, sx, sy } from "./paint";
import type { SpriteImage } from "./renderTypes";
import { SKYLINE_BASE, skylineMax } from "./skyline";
import { recorder, type RecordingTarget } from "./testRecorder";
import { ROAD } from "./tiles";

// Tokyo's backdrop layers (render/backdrop.ts) have suites of their own (render/backdropTowers.test.ts,
// …, city.backdrop.test.ts for the wiring); here they stand empty, so a Tokyo sky is the plain one plus
// its landmarks and its open sky.
vi.mock("./backdropTowers", () => ({ TOWERS: { paint: () => {}, paintLights: () => {}, faceAt: (s: { horizon: number }) => s.horizon } }));
vi.mock("./backdropCanyon", () => ({ CANYON: { paint: () => {}, paintLights: () => {}, faceAt: (s: { horizon: number }) => s.horizon } }));
vi.mock("./backdropApartments", () => ({ APARTMENTS: { paint: () => {}, paintLights: () => {}, faceAt: (s: { horizon: number }) => s.horizon } }));
vi.mock("./backdropShops", () => ({ SHOPS: { paint: () => {}, paintLights: () => {}, faceAt: (s: { horizon: number }) => s.horizon } }));

const world = buildCityWorld([
  { key: "p", label: "p", team: 2, hasIde: true, floors: [{ key: "floor:a", label: "a", ide: true }] },
]);
const street = world.city!.street;
/** A city with its lounge dug in under the street (the HQ's, 64 benches), the Seats hall under it. */
const lounged = buildCityWorld([{ key: "p", label: "p", team: 2, hasIde: true, floors: [{ key: "floor:a", label: "a", ide: true }] }], { seats: 64 });
const cam = { zoom: 1, ox: 0, oy: 40 };
const view = { w: world.cols * TILE, h: world.rows * TILE + 80 };

/** A sky at `hour` (local), optionally forced weather. */
function sky(hour: number, weather: WeatherKind | "auto" = "auto"): Ambience {
  return computeAmbience(new Date(2026, 9, 15, hour, 0), null, { weather, phase: "auto" });
}

const fills = (ctx: RecordingTarget, color: string) => ctx.of("fillRect").filter((c) => c.fillStyle === color);

/** Tokyo, 2026-10-19 (sunrise 05:52, sunset 17:05), at a local time. */
function tokyo(h: number, m = 0, kind: WeatherKind = "clear"): Ambience {
  const wire: WeatherWire = {
    kind,
    intensity: kind === "clear" ? 0 : 0.8,
    temperatureC: 24,
    wind: 0,
    sunriseMs: new Date(2026, 9, 19, 5, 52).getTime(),
    sunsetMs: new Date(2026, 9, 19, 17, 5).getTime(),
    place: "Tokyo",
    fetchedAtMs: 0,
  };
  return computeAmbience(new Date(2026, 9, 19, h, m), wire, { weather: "auto", phase: "auto" });
}

/** Every skyline window in a world-x span, collected. */
function windows(x0: number, x1: number, horizon = street * TILE): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  forEachSkylineWindow(x0, x1, horizon, (x, y) => out.push({ x, y }));
  return out;
}

/** The skyline walk, collected (the renderer never collects it). */
function skylineBlocks(x0: number, x1: number, horizon = street * TILE): { x: number; w: number; h: number }[] {
  const out: { x: number; w: number; h: number }[] = [];
  forEachSkylineBlock(x0, x1, horizon, (x, w, h) => out.push({ x, w, h }));
  return out;
}

/** Floors of `n`, for a building plan. */
const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/**
 * A reference city: `gazelle`, seven floors of 26 seats (57 rows, two desk rows a
 * floor), left of the centred Capacity HQ; `chat-server`, one floor, right of it. A sky of 976 px.
 */
const referenceCity = buildCityWorld(
  [
    { key: "chat-server", label: "chat-server", team: 2, hasIde: true, floors: floorsOf("t", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);

/** A low city's rule for a block's height, as ever: 35–99 % of 3 tiles, by the hash of its 8-px cell. */
const lowHeight = (x: number) => Math.round(48 * (0.35 + ((hash(Math.floor(x / 8), 7, 13) >>> 4) % 65) / 100));

/** The pixels a recording leaves (its fills, last one wins) — to compare PICTURES where the calls may differ. */
function raster(ctx: RecordingTarget, view: { w: number; h: number }): (string | undefined)[] {
  const px: (string | undefined)[] = new Array(view.w * view.h);
  for (const c of ctx.of("fillRect")) {
    const [x, y, w, h] = c.args as number[];
    for (let j = Math.max(0, y); j < Math.min(view.h, y + h); j++) for (let i = Math.max(0, x); i < Math.min(view.w, x + w); i++) px[j * view.w + i] = c.fillStyle;
  }
  return px;
}

/**
 * What the far skyline must look like, painted pixel by pixel from its blocks alone, the plain way:
 * each block's face (`w − 1` wide, a 1-px gap of sky after it) and its lit top edge, then a 1×2 pane
 * per window — columns 4 px apart from 2 px in, floors 5 px apart from 3 px under the edge — every
 * rect snapped like the renderer's. `undefined` off the blocks: the sky's, not the skyline's.
 */
function skylinePicture(blocks: { x: number; w: number; h: number }[], horizon: number, cam: Camera, view: { w: number; h: number }): (string | undefined)[] {
  const px: (string | undefined)[] = new Array(view.w * view.h);
  const fill = (wx: number, wy: number, w: number, h: number, color: string) => {
    const x = sx(cam, wx);
    const y = sy(cam, wy);
    const xe = x + Math.max(1, sx(cam, wx + w) - x);
    const ye = y + Math.max(1, sy(cam, wy + h) - y);
    for (let j = Math.max(0, y); j < Math.min(view.h, ye); j++) for (let i = Math.max(0, x); i < Math.min(view.w, xe); i++) px[j * view.w + i] = color;
  };
  for (const b of blocks) {
    fill(b.x, horizon - b.h, b.w - 1, b.h, CITY.skyline);
    fill(b.x, horizon - b.h, b.w - 1, 1, CITY.skylineEdge);
  }
  for (const b of blocks)
    for (let y = horizon - b.h + 3; y < horizon - 3; y += 5) for (let x = b.x + 2; x < b.x + b.w - 3; x += 4) fill(x, y, 1, 2, CITY.skylinePane);
  return px;
}

describe("paintCityBackdrop", () => {
  it("paints the sky in day colours, top to bottom, across the whole view — the top band running on above the world", () => {
    const ctx = recorder();
    paintCityBackdrop(ctx, sky(12), world, cam, view, 0);
    const bands = ctx.of("fillRect").filter((c) => (CITY.sky as readonly string[]).includes(c.fillStyle));
    expect(bands.map((b) => b.fillStyle)).toEqual([...CITY.sky]);
    expect(bands[0].args).toEqual([0, 0, view.w, expect.any(Number)]);
    // Contiguous, down to the street's top.
    for (let i = 1; i < bands.length; i++) expect(bands[i].args[1]).toBe((bands[i - 1].args[1] as number) + (bands[i - 1].args[3] as number));
    const last = bands.at(-1)!.args as number[];
    expect(last[1] + last[3]).toBe(cam.oy + street * TILE);
  });

  it("skips the bands that are off screen when zoomed into part of the sky", () => {
    const ctx = recorder();
    // Zoom 4 on the middle of the sky: the top bands are above the view, the bottom ones below.
    paintCityBackdrop(ctx, undefined, world, { zoom: 4, ox: 0, oy: -4 * 4 * TILE }, { w: 400, h: 200 }, 0);
    const n = ctx.of("fillRect").filter((c) => (CITY.sky as readonly string[]).includes(c.fillStyle)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(CITY.sky.length);
  });

  it("puts the sun up only by day, on an arc across the world from its left edge to its right", () => {
    const day = recorder();
    paintCityBackdrop(day, sky(12), world, cam, view, 0);
    expect(fills(day, CITY.sun).length).toBeGreaterThan(5);
    expect(fills(day, CITY.sunGlow).length).toBeGreaterThan(5);
    for (const amb of [sky(23), undefined]) {
      const ctx = recorder();
      paintCityBackdrop(ctx, amb, world, cam, view, 0);
      expect(fills(ctx, CITY.sun)).toHaveLength(0);
    }
    const rise = bodyCenter(world, 0);
    const noon = bodyCenter(world, 0.5);
    const set = bodyCenter(world, 1);
    expect(rise.x).toBeLessThan(noon.x);
    expect(noon.x).toBeLessThan(set.x);
    expect(set.x).toBeLessThan(world.cols * TILE);
    expect(noon.y).toBe(2 * TILE); // high in the sky at noon
    expect(rise.y).toBe(set.y);
    expect(rise.y).toBe(street * TILE - TILE); // behind the roofs at the ends of the day
  });

  it("brings the clouds the weather calls for (render/clouds.ts) — none in fog, grey when cloudy, more under a fuller cover, dark in a storm — drifting with the wind", () => {
    const clouds = (weather: WeatherKind, t = 0, amb = sky(12, weather)) => {
      const ctx = recorder();
      paintCityBackdrop(ctx, amb, world, cam, view, t);
      return Object.values(CITY.cloud).flatMap((color) => fills(ctx, color));
    };
    expect(clouds("fog")).toHaveLength(0);
    // Only two clouds on a cloudy day looked wrong — a cloudy sky is now mostly cloud.
    const cloudy = clouds("cloudy");
    // More than twice what its six clouds drew here before (three puffs each), in this small world's view.
    expect(cloudy.length).toBeGreaterThan(2 * 6 * 3);
    expect(cloudy.length).toBeGreaterThan(5 * clouds("clear").length);
    expect(cloudy.every((c) => c.fillStyle === CITY.cloud.grey)).toBe(true);
    // The live cloud cover (Open-Meteo's, as the cloudy sky's intensity): more cloud under a fuller one.
    expect(clouds("cloudy", 0, { ...sky(12, "cloudy"), intensity: 1 }).length).toBeGreaterThan(clouds("cloudy", 0, { ...sky(12, "cloudy"), intensity: 0.1 }).length);
    const storm = clouds("storm");
    expect(storm.length).toBeGreaterThan(0);
    expect(storm.every((c) => c.fillStyle === CITY.cloud.storm)).toBe(true);
    expect(clouds("rain").every((c) => c.fillStyle === CITY.cloud.dark)).toBe(true);
    const x = (cs: ReturnType<typeof clouds>) => cs.map((c) => c.args[0] as number);
    const later = clouds("cloudy", 10_000);
    expect(x(later)).not.toEqual(x(cloudy));
    const leftward = clouds("cloudy", 10_000, { ...sky(12, "cloudy"), wind: -0.5 });
    expect(x(leftward)).not.toEqual(x(later));
  });

  it("stands a far skyline on the horizon, the same blocks every frame, covering the whole span", () => {
    const blocks = skylineBlocks(-100, 700);
    expect(blocks[0].x).toBeLessThanOrEqual(-100);
    expect(blocks.at(-1)!.x + blocks.at(-1)!.w).toBeGreaterThanOrEqual(700);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].x).toBe(blocks[i - 1].x + blocks[i - 1].w);
    for (const b of blocks) {
      expect([16, 24, 32]).toContain(b.w);
      expect(b.h).toBeGreaterThan(0);
      expect(b.h).toBeLessThanOrEqual(3 * TILE);
    }
    expect(skylineBlocks(-100, 700)).toEqual(blocks);
    const ctx = recorder();
    paintCityBackdrop(ctx, undefined, world, cam, view, 0);
    // One face per block, standing on the street's top edge (the walls laid back between its floors
    // are the block's colour too, but stop above it), and a lit edge along its top.
    const horizon = cam.oy + street * TILE;
    const faces = fills(ctx, CITY.skyline).filter((t) => (t.args[1] as number) + (t.args[3] as number) === horizon);
    const visible = skylineBlocks(0, view.w);
    expect(faces.map((t) => t.args)).toEqual(visible.map((b) => [b.x, horizon - b.h, b.w - 1, b.h]));
    expect(fills(ctx, CITY.skylineEdge).map((t) => t.args)).toEqual(visible.map((b) => [b.x, horizon - b.h, b.w - 1, 1]));
  });

  it("runs the street on across the view: flat bands without a ground layer, copies of the world's own street with one", () => {
    const flat = recorder();
    const wide = { zoom: 1, ox: 600, oy: 0 };
    paintCityBackdrop(flat, undefined, world, wide, { w: 2000, h: 600 }, 0);
    const y = (r: number) => street * TILE + r * TILE;
    expect(fills(flat, CITY.sidewalk).map((c) => c.args)).toEqual([
      [0, y(0), 2000, TILE],
      [0, y(3), 2000, TILE],
    ]);
    expect(fills(flat, ROAD.asphalt)).toHaveLength(2);
    expect(fills(flat, ROAD.line).length).toBeGreaterThan(50);
    expect(flat.of("drawImage")).toHaveLength(0);

    // Copies of the world's own street — its four rows only, whatever lies under it in the world (the lounge).
    for (const w of [world, lounged]) {
      const layer: GroundLayer = { image: { l: 1 } as unknown as SpriteImage, w: w.cols * TILE, h: w.rows * TILE };
      const copies = recorder();
      paintCityBackdrop(copies, undefined, w, wide, { w: 2000, h: 600 }, 0, layer);
      const blits = copies.of("drawImage").map((c) => c.args);
      // k = −1, +1, … around the world (k = 0 is the world itself, painted by the frame).
      expect(blits.map((a) => a[5])).toEqual(Array.from({ length: blits.length }, (_, i) => 600 + (i === 0 ? -1 : i) * layer.w));
      expect(blits.length).toBeGreaterThanOrEqual(2);
      const top = w.city!.street * TILE;
      for (const a of blits) {
        expect(a.slice(1, 5)).toEqual([0, top, layer.w, 4 * TILE]);
        expect(a.slice(6)).toEqual([top, layer.w, 4 * TILE]);
      }
    }
    expect(STREET_H).toBe(4 * TILE);
    expect(lounged.rows * TILE - lounged.city!.street * TILE).toBeGreaterThan(STREET_H);
  });

  it("paints no street at all when it is below the view", () => {
    const ctx = recorder();
    paintCityBackdrop(ctx, undefined, world, { zoom: 2, ox: 0, oy: 0 }, { w: 300, h: 100 }, 0);
    expect(fills(ctx, CITY.sidewalk)).toHaveLength(0);
    expect(fills(ctx, CITY.sky[0]).length).toBe(1);
  });

  // Routing, not values: the colours themselves are pinned by hue in engine/ambience.test.ts.
  it("paints a sunset in twenty finer bands — citySky's, top to bottom, contiguous down to the street", () => {
    const amb = tokyo(16, 55);
    const look = citySky(amb);
    expect(new Set(look.bands).size).toBe(SKY_BANDS);
    const ctx = recorder();
    paintCityBackdrop(ctx, amb, world, cam, view, 0);
    const bands = ctx.of("fillRect").slice(0, SKY_BANDS);
    expect(bands.map((b) => b.fillStyle)).toEqual(look.bands);
    for (let i = 1; i < bands.length; i++) expect(bands[i].args[1]).toBe((bands[i - 1].args[1] as number) + (bands[i - 1].args[3] as number));
    const last = bands.at(-1)!.args as number[];
    expect(last[1] + last[3]).toBe(cam.oy + street * TILE);
  });

  it("near sunset the sun is bigger and redder, with a warm glow low on its side of the sky that fades upward", () => {
    const disc = (amb: Ambience) => {
      const ctx = recorder();
      paintCityBackdrop(ctx, amb, world, cam, view, 0);
      const rows = fills(ctx, citySky(amb).sun.color);
      return { ctx, rows, widest: Math.max(...rows.map((r) => r.args[2] as number)) };
    };
    const noon = disc(tokyo(12));
    expect(noon.widest).toBe(2 * 7 + 1);
    const late = disc(tokyo(16, 55));
    expect(late.widest).toBeGreaterThanOrEqual(2 * 10 + 1);
    expect(citySky(tokyo(16, 55)).sun.color).not.toBe(CITY.sun);
    // The glow: one wash per low band, centred on the sun, narrower and fainter going up.
    const look = citySky(tokyo(16, 55));
    const glow = fills(late.ctx, look.bloom.color);
    expect(glow.length).toBeGreaterThanOrEqual(5);
    const sunX = bodyCenter(world, tokyo(16, 55).arc!.t).x;
    for (const g of glow) expect(Math.abs((g.args[0] as number) + (g.args[2] as number) / 2 - sunX)).toBeLessThanOrEqual(1);
    for (let i = 1; i < glow.length; i++) {
      expect(glow[i].args[1] as number).toBeLessThan(glow[i - 1].args[1] as number); // going up
      expect(glow[i].args[2] as number).toBeLessThan(glow[i - 1].args[2] as number); // narrower
      expect(glow[i].alpha).toBeLessThan(glow[i - 1].alpha); // fainter
    }
    expect(glow[0].alpha).toBeCloseTo(look.bloom.alpha);
    // No glow at noon; and after sunset it stays on the side the sun went down.
    expect(noon.ctx.calls.filter((c) => c.alpha < 1 && c.op === "fillRect")).toHaveLength(0);
    const after = recorder();
    paintCityBackdrop(after, tokyo(17, 20), world, cam, view, 0);
    const dusk = fills(after, citySky(tokyo(17, 20)).bloom.color);
    expect(dusk.length).toBeGreaterThan(0);
    expect((dusk[0].args[0] as number) + (dusk[0].args[2] as number) / 2).toBe(bodyCenter(world, 1).x);
  });

  it("a golden-hour sun still shows over a one-floor roof — its arc flattens toward the ends — and drops behind the roofs just before sunset", () => {
    const b = world.city!.buildings[0];
    const roof = b.row * TILE;
    expect(street * TILE - roof).toBe(6 * TILE); // one floor: five rows and the front wall
    const golden = tokyo(16, 19);
    const c = bodyCenter(world, golden.arc!.t);
    expect(c.y - citySky(golden).sun.r).toBeLessThan(roof); // its top clears the roofline
    expect(bodyCenter(world, tokyo(17, 2).arc!.t).y).toBeGreaterThan(roof); // three minutes to go: behind it
    // The ends and the top of the arc are where they always were.
    expect(bodyCenter(world, 0.5).y).toBe(2 * TILE);
    expect(bodyCenter(world, 1).y).toBe(street * TILE - TILE);
  });

  it("lays the sky in depth order — bands, glow, sun, [far landmarks], clouds, [towers], skyline, its panes — then the street", () => {
    // A thin cloud cover: the sun and its glow still show, and there are clouds to put in their place.
    const amb = { ...tokyo(16, 19, "cloudy"), intensity: 0.2 };
    const look = citySky(amb);
    const ctx = recorder();
    paintCityBackdrop(ctx, amb, world, cam, view, 0);
    const styles = ctx.calls.map((c) => c.fillStyle);
    const lastBand = Math.max(...look.bands.map((b) => styles.lastIndexOf(b)));
    const firstGlow = styles.indexOf(look.bloom.color);
    const lastSun = styles.lastIndexOf(look.sun.core);
    const firstCloud = styles.indexOf(look.cloud.grey.body);
    expect(firstGlow).toBeGreaterThan(-1);
    expect(lastSun).toBeGreaterThan(-1);
    expect(firstCloud).toBeGreaterThan(-1);
    const firstBlock = styles.indexOf(look.skyline.block);
    const firstPane = styles.indexOf(look.skyline.pane);
    const firstStreet = styles.indexOf(CITY.sidewalk);
    expect(lastBand).toBeLessThan(firstGlow);
    expect(firstGlow).toBeLessThan(lastSun);
    // Landmarks 1 of 3 (paintFarLandmarks) slots in here: after the sun, before the clouds.
    expect(lastSun).toBeLessThan(firstCloud);
    // Landmarks 2 of 3 (paintLandmarks) slots in here: after the clouds, before the skyline.
    expect(styles.lastIndexOf(look.cloud.grey.under)).toBeLessThan(firstBlock);
    expect(firstBlock).toBeLessThan(firstPane);
    expect(firstPane).toBeLessThan(firstStreet);
  });

  it("gives every cloud a lit underside: a shade darker by day, warm at sunset", () => {
    const ctx = recorder();
    const amb = tokyo(12, 0, "cloudy");
    paintCityBackdrop(ctx, amb, world, cam, view, 0);
    const under = fills(ctx, citySky(amb).cloud.grey.under);
    const bodies = fills(ctx, citySky(amb).cloud.grey.body);
    expect(under.length).toBeGreaterThan(10);
    // One per cloud, right under its base (a pixel in from either end).
    for (const u of under) expect(bodies.some((b) => b.args[0] === (u.args[0] as number) - 1 && b.args[2] === (u.args[2] as number) + 2)).toBe(true);
    expect(citySky(tokyo(12)).cloud.light.body).toBe(CITY.cloud.light);
    expect(citySky(tokyo(17, 5)).cloud.light.under).not.toBe(citySky(tokyo(12)).cloud.light.under);
  });

  it("gives the far skyline a grid of darker panes by day — exactly a 1×2 pane per window, drawn a window column at a time", () => {
    const v = { w: 480, h: 360 };
    for (const w of [world, referenceCity]) {
      const horizon = w.city!.street * TILE;
      for (const zoom of [0.75, 0.8125, 0.9375, 1, 1.5, 2, 3]) {
        // The street 40 px above the view's bottom, panned so the view starts mid-block.
        const c = { zoom, ox: -37, oy: Math.round(v.h - 40 - horizon * zoom) };
        const ctx = recorder();
        paintCityBackdrop(ctx, undefined, w, c, v, 0);
        const got = raster(ctx, v);
        const want = skylinePicture(skylineBlocks(37 / zoom, (v.w + 37) / zoom, horizon), horizon, c, v);
        let face = 0;
        let pane = 0;
        for (let i = 0; i < want.length; i++) {
          if (want[i] === undefined) {
            // Off the blocks: never a pane.
            if (got[i] === CITY.skylinePane) throw new Error(`zoom ${zoom}: a pane off the blocks at ${i % v.w},${Math.floor(i / v.w)}`);
            continue;
          }
          face++;
          if (want[i] === CITY.skylinePane) pane++;
          if (got[i] !== want[i]) throw new Error(`zoom ${zoom}: ${got[i]} at ${i % v.w},${Math.floor(i / v.w)}, not ${want[i]}`);
        }
        expect(face).toBeGreaterThan(5000);
        expect(pane).toBeGreaterThan(face / 20);
      }
    }
    // A column at a time: in the reference city a block holds ~18 floors, and its panes take a
    // strip per column and a wall per floor, not a rect per window (a third of them, at most).
    const ctx = recorder();
    paintCityBackdrop(ctx, undefined, referenceCity, { zoom: 1, ox: 0, oy: 0 }, { w: 1664, h: referenceCity.city!.street * TILE }, 0);
    const rects = fills(ctx, CITY.skylinePane).length + fills(ctx, CITY.skyline).length;
    expect(rects).toBeLessThan(windows(0, 1664, referenceCity.city!.street * TILE).length / 3);
  });

  it("zoomed out, a block's panes merge into one faint band per floor instead of a 1-px checkerboard", () => {
    const half = { zoom: 0.5, ox: 0, oy: 20 };
    const ctx = recorder();
    paintCityBackdrop(ctx, tokyo(12), world, half, { w: view.w / 2, h: view.h / 2 }, 0);
    const strips = fills(ctx, CITY.skylinePane);
    const floors = skylineBlocks(0, view.w).reduce((n, b) => n + Math.ceil((b.h - 6) / 5), 0);
    expect(strips.length).toBe(floors);
    expect(strips.length).toBeLessThan(windows(0, view.w).length / 3);
    for (const s of strips) expect(s.alpha).toBe(0.5);
  });
});

describe("paintCityNight", () => {
  const night = (weather: WeatherKind | "auto" = "auto", t = 0) => {
    const ctx = recorder();
    paintCityNight(ctx, sky(23, weather), world, cam, view, t);
    return ctx;
  };

  it("paints nothing by day", () => {
    const ctx = recorder();
    paintCityNight(ctx, sky(12), world, cam, view, 0);
    expect(ctx.calls).toHaveLength(0);
  });

  it("scatters twinkling stars over a clear night's sky — the same ones every night, none under the street", () => {
    const stars = fills(night(), CITY.star);
    expect(stars.length).toBeGreaterThan(10);
    for (const s of stars) expect(s.args[1] as number).toBeLessThan(cam.oy + street * TILE - TILE);
    expect(fills(night(), CITY.star).map((s) => s.args)).toEqual(stars.map((s) => s.args));
    const alphas = (t: number) => fills(night("auto", t), CITY.star).map((s) => s.alpha);
    expect(alphas(1300)).not.toEqual(alphas(0));
    expect(fills(night("cloudy"), CITY.star)).toHaveLength(0);
  });

  it("raises the moon on a clear night, dims it behind clouds and hides it in the rain", () => {
    const moon = (weather: WeatherKind | "auto") => fills(night(weather), CITY.moon);
    expect(moon("auto")[0].alpha).toBeCloseTo(1);
    expect(moon("cloudy")[0].alpha).toBeCloseTo(0.45);
    expect(moon("rain")[0].alpha).toBe(0);
    expect(fills(night(), CITY.moonShade)).toHaveLength(2);
    // Fades in through dusk: a dusk sky paints it fainter than the night does.
    const dusk = recorder();
    paintCityNight(dusk, { ...sky(23), daylight: 0.4 }, world, cam, view, 0);
    expect(fills(dusk, CITY.moon)[0].alpha).toBeLessThan(0.9);
    expect(fills(dusk, CITY.moon)[0].alpha).toBeGreaterThan(0);
  });

  it("lights windows in the far skyline at night, and a sun-up night (no moon) still gets them", () => {
    const lit = fills(night(), CITY.window);
    expect(lit.length).toBeGreaterThan(5);
    for (const w of lit) expect((w.args[1] as number) + (w.args[3] as number)).toBeLessThanOrEqual(cam.oy + street * TILE);
    const ctx = recorder();
    paintCityNight(ctx, { ...sky(23), arc: { body: "sun", t: 0.5 } }, world, cam, view, 0);
    expect(fills(ctx, CITY.moon)).toHaveLength(0);
    expect(fills(ctx, CITY.window).length).toBe(lit.length);
  });
});

describe("the far skyline's lit windows through the day", () => {
  /** Lit-window fills of `paintCityNight` at a Tokyo time (in `w`, through `c`). */
  const litAt = (amb: Ambience, w = world, c = cam, v = view) => {
    const ctx = recorder();
    paintCityNight(ctx, amb, w, c, v, 0);
    return fills(ctx, CITY.window);
  };

  it("none by day; the first come on just before 4 pm (sunset 17:05), more every step after, the most at night", () => {
    const times: [number, number][] = [[12, 0], [15, 30], [16, 5], [16, 19], [16, 40], [16, 55], [17, 20], [17, 40], [21, 0]];
    const counts = times.map(([h, m]) => litAt(tokyo(h, m)).length);
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(0);
    expect(counts[3]).toBeGreaterThanOrEqual(1); // 16:19
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts.at(-1)!).toBeGreaterThan(counts[3] * 4);
    expect(counts.at(-1)!).toBeGreaterThan(windows(0, view.w).length * 0.25);
  });

  it("the same windows every evening, and every one lit at sunset is still lit at night — always in a pane of the day's grid", () => {
    const key = (c: { args: unknown[] }) => c.args.join(",");
    const sunset = new Set(litAt(tokyo(17, 5)).map(key));
    const night = new Set(litAt(tokyo(21)).map(key));
    expect(sunset.size).toBeGreaterThan(0);
    for (const k of sunset) expect(night.has(k)).toBe(true);
    expect(litAt(tokyo(21)).map(key)).toEqual([...night]);
    // Every lit window (1×2) lands on two pane pixels of the day's picture.
    const panes = recorder();
    paintCityBackdrop(panes, tokyo(12), world, cam, view, 0);
    const day = raster(panes, view);
    for (const k of night) {
      const [x, y, w, h] = k.split(",").map(Number);
      expect([w, h]).toEqual([1, 2]);
      expect([day[y * view.w + x], day[(y + 1) * view.w + x]]).toEqual([CITY.skylinePane, CITY.skylinePane]);
    }
  });

  it("a window's threshold is its own: lit at one share means lit at every higher share", () => {
    const grid = windows(-200, 900);
    expect(grid.filter((w) => windowLit(w.x, w.y, 0))).toHaveLength(0);
    expect(grid.filter((w) => windowLit(w.x, w.y, 1))).toHaveLength(grid.length);
    for (const w of grid) if (windowLit(w.x, w.y, 0.1)) expect(windowLit(w.x, w.y, 0.35)).toBe(true);
    const share = grid.filter((w) => windowLit(w.x, w.y, 0.4)).length / grid.length;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.5);
  });

  it("lights them in golden hour with no stars or moon yet — and never over a street tree or lamp standing in front", () => {
    const golden = recorder();
    paintCityNight(golden, tokyo(16, 30), world, cam, view, 0);
    expect(fills(golden, CITY.window).length).toBeGreaterThan(0);
    expect(fills(golden, CITY.star)).toHaveLength(0);
    expect(fills(golden, CITY.moon)).toHaveLength(0);
    // Two buildings: a tree and a lamp stand in the gap between them, in front of the skyline.
    const two = buildCityWorld([
      { key: "p", label: "p", team: 2, hasIde: true, floors: [{ key: "floor:a", label: "a", ide: true }] },
      { key: "q", label: "q", team: 0, hasIde: false, floors: [{ key: "floor:b", label: "b", ide: false }] },
    ]);
    const front = two.props.filter((p) => p.kind === "tree" || p.kind === "lamp").map((p) => [p.col * TILE, (p.row - 1) * TILE, p.w * TILE, (p.h + 1) * TILE]);
    expect(front.length).toBeGreaterThanOrEqual(2);
    const wide = { w: two.cols * TILE, h: two.rows * TILE };
    const flat = { zoom: 1, ox: 0, oy: 0 };
    const share = citySky(tokyo(21)).lit;
    const behind = (x: number, y: number) => front.some(([ox, oy, ow, oh]) => x + 1 > ox && x < ox + ow && y + 2 > oy && y < oy + oh);
    const all: { x: number; y: number }[] = [];
    forEachSkylineWindow(0, wide.w, two.city!.street * TILE, (x, y) => all.push({ x, y }));
    const hidden = all.filter((w) => windowLit(w.x, w.y, share) && behind(w.x, w.y));
    expect(hidden.length).toBeGreaterThan(0); // the guard has something to do
    const shown = litAt(tokyo(21), two, flat, wide).map((c) => `${c.args[0]},${c.args[1]}`);
    expect(shown).toEqual(all.filter((w) => windowLit(w.x, w.y, share) && !behind(w.x, w.y)).map((w) => `${w.x},${w.y}`));
  });
});

describe("the far skyline grows with the city (the buildings behind look somewhat bigger)", () => {
  const tallH = referenceCity.city!.street * TILE;

  it("a low city's heights stay on the 3-tile rule — 35–99 % of 48 px by each block's own hash, 16–32 px wide — and none of it shows above 3 tiles", () => {
    // The HQ alone (or with one-floor projects), three floors, and the tallest sky still drawn at 3 tiles.
    for (const horizon of [240, 320, 336]) {
      expect(skylineMax(horizon)).toBe(SKYLINE_BASE);
      const blocks = skylineBlocks(-3000, 3000, horizon);
      for (const b of blocks) {
        expect(b.h).toBe(lowHeight(b.x));
        expect([16, 24, 32]).toContain(b.w);
      }
      expect(Math.max(...blocks.map((b) => b.h))).toBe(48);
    }
    // The picture: its blocks' faces, edges and panes, and no skyline colour anywhere off them.
    const v = { w: 480, h: 360 };
    const horizon = street * TILE;
    const haze: string[] = [CITY.skyline, CITY.skylineEdge, CITY.skylinePane];
    for (const zoom of [0.75, 1, 2]) {
      const c = { zoom, ox: -37, oy: Math.round(v.h - 40 - horizon * zoom) };
      const ctx = recorder();
      paintCityBackdrop(ctx, undefined, world, c, v, 0);
      const got = raster(ctx, v);
      const want = skylinePicture(skylineBlocks(37 / zoom, (v.w + 37) / zoom), horizon, c, v);
      for (let i = 0; i < want.length; i++)
        if (want[i] === undefined ? haze.includes(got[i] as string) : got[i] !== want[i]) throw new Error(`zoom ${zoom}: ${got[i]} at ${i % v.w},${Math.floor(i / v.w)}, not ${want[i]}`);
    }
  });

  it("is WORLD-LOCKED: the blocks over any world x are the same whatever span is walked — wherever the view starts, however wide it is", () => {
    for (const horizon of [240, 528, tallH, 1008]) {
      const truth = skylineBlocks(-8000, 8000, horizon);
      for (let x0 = -3000; x0 < 3000; x0 += 13)
        for (const s of [x0, x0 + 0.37])
          for (const span of [1, 97, 1280 / 0.625]) {
            // Exactly the blocks of the whole street that reach into [s, s + span): the first holds s.
            const want = truth.filter((b) => b.x + b.w > s && b.x < s + span);
            expect(skylineBlocks(s, s + span, horizon)).toEqual(want);
            expect(want[0].x).toBeLessThanOrEqual(s);
          }
    }
  });

  it("…and so is its picture: whatever the zoom, pan or view, its faces are the same world blocks — and panned N px it moves exactly N px", () => {
    const v = { w: 400, h: 300 };
    for (const w of [world, referenceCity]) {
      const horizon = w.city!.street * TILE;
      const truth = skylineBlocks(-5000, 8000, horizon);
      const camAt = (zoom: number, ox: number) => ({ zoom, ox, oy: Math.round(v.h - 40 - horizon * zoom) });
      for (const zoom of [0.5, 0.6875, 1, 2, 2.5, 3])
        for (const ox of [0, -37, -333, 512, -1999]) {
          const c = camAt(zoom, ox);
          const ctx = recorder();
          paintCityBackdrop(ctx, undefined, w, c, v, 0);
          const faces = fills(ctx, CITY.skyline).filter((f) => (f.args[1] as number) + (f.args[3] as number) === sy(c, horizon));
          const [x0, x1] = [-Math.round(ox) / zoom, (v.w - Math.round(ox)) / zoom];
          const want = truth
            .filter((b) => b.x + b.w > x0 && b.x < x1)
            .map((b) => [sx(c, b.x), sy(c, horizon - b.h), Math.max(1, sx(c, b.x + b.w - 1) - sx(c, b.x)), sy(c, horizon) - sy(c, horizon - b.h)]);
          expect(faces.map((f) => f.args), `zoom ${zoom}, ox ${ox}`).toEqual(want);
        }
      // Panned by N world px (N × zoom screen px): the band is the same picture, moved by exactly that.
      const wide = { w: 1280, h: v.h };
      for (const [zoom, n] of [[1, 50], [1, 200], [2.5, 50], [2.5, 200]]) {
        const a = camAt(zoom, -100);
        const b = camAt(zoom, -100 - n * zoom);
        const pa = recorder();
        const pb = recorder();
        paintCityBackdrop(pa, undefined, w, a, wide, 0);
        paintCityBackdrop(pb, undefined, w, b, wide, 0);
        const [ra, rb] = [raster(pa, wide), raster(pb, wide)];
        const d = n * zoom;
        let panes = 0;
        for (let y = Math.max(0, sy(a, horizon - skylineMax(horizon))); y < sy(a, horizon); y++)
          for (let x = d; x < wide.w; x++) {
            if (rb[y * wide.w + x - d] !== ra[y * wide.w + x]) throw new Error(`zoom ${zoom}, panned ${n}: ${x},${y}`);
            if (ra[y * wide.w + x] === CITY.skylinePane) panes++;
          }
        expect(panes, `zoom ${zoom}, panned ${n}`).toBeGreaterThan(200);
      }
    }
  });

  it("a tall city's reaches skylineMax: 144 px over gazelle's 976-px sky (3× the old), its blocks 35–99 % of it", () => {
    expect(tallH).toBe(976);
    expect(skylineMax(tallH)).toBe(144);
    const blocks = skylineBlocks(-2000, 4000, tallH);
    const hs = blocks.map((b) => b.h);
    expect(Math.max(...hs)).toBeLessThanOrEqual(144);
    expect(Math.max(...hs)).toBeGreaterThanOrEqual(140);
    expect(Math.min(...hs)).toBeGreaterThanOrEqual(Math.round(0.35 * 144));
    // Not three times as many blocks: the same walk, so as varied as ever.
    expect(new Set(hs).size).toBeGreaterThan(40);
  });

  it("…and a little wider, by the square root, on a grid of whole windows: never needles, never the slabs of a close-up", () => {
    const widths = (horizon: number) => [...new Set(skylineBlocks(-2000, 4000, horizon).map((b) => b.w))].sort((a, b) => a - b);
    // The grid widens once the skyline is ~1.56× (√ → 1.25, rounding 2 → 2.5 to 3 steps of 4 px).
    expect(widths(512)).toEqual([16, 24, 32]); // 74 px tall: 1.54×
    expect(widths(528)).toEqual([24, 36, 48]); // 77 px tall: 1.6×
    expect(widths(tallH)).toEqual([24, 36, 48]); // 144 px: 3×, √3 = 1.73
    expect(widths(1008)).toEqual([32, 48, 64]); // 149 px: 3.1×
    // On their grid, edge to edge.
    const blocks = skylineBlocks(-2000, 4000, tallH);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].x).toBe(blocks[i - 1].x + blocks[i - 1].w);
    for (const b of blocks) expect(Math.abs(b.x % 12)).toBe(0);
    // At most 6× as tall as wide (at the old widths, 9×: needles); a low city's at most 3×.
    const slender = (bs: { w: number; h: number }[]) => Math.max(...bs.map((b) => b.h / b.w));
    expect(slender(blocks)).toBeLessThanOrEqual(6);
    expect(slender(blocks)).toBeGreaterThan(5);
    expect(slender(skylineBlocks(-2000, 4000, street * TILE))).toBeLessThanOrEqual(3);
  });

  it("a taller block simply has more floors of windows — the same 4-px columns from 2 px in, the same 5-px floors", () => {
    const blocks = skylineBlocks(0, 1664, tallH);
    const grid = windows(0, 1664, tallH);
    for (const b of blocks) {
      const mine = grid.filter((w) => w.x >= b.x && w.x < b.x + b.w);
      const cols = [...new Set(mine.map((w) => w.x))];
      const floors = [...new Set(mine.map((w) => w.y))];
      expect(cols).toEqual(Array.from({ length: Math.ceil((b.w - 5) / 4) }, (_, j) => b.x + 2 + 4 * j));
      expect(floors).toEqual(Array.from({ length: Math.ceil((b.h - 6) / 5) }, (_, k) => tallH - b.h + 3 + 5 * k));
      expect(mine).toHaveLength(cols.length * floors.length);
    }
    const most = (h: number) => Math.max(...skylineBlocks(0, 1664, h).map((b) => Math.ceil((b.h - 6) / 5)));
    expect(most(street * TILE)).toBeLessThanOrEqual(9);
    expect(most(tallH)).toBeGreaterThanOrEqual(26);
  });

  it("at night its taller blocks light up to their tops: above the old 3 tiles, never above skylineMax — the same share as a low city's", () => {
    const v = { w: 1664, h: 300 };
    const c = { zoom: 1, ox: 0, oy: 250 - tallH };
    const ctx = recorder();
    paintCityNight(ctx, tokyo(21), referenceCity, c, v, 0);
    const lit = fills(ctx, CITY.window).map((f) => (f.args[1] as number) - c.oy);
    expect(lit.filter((y) => y < tallH - 3 * TILE).length).toBeGreaterThan(lit.length / 3);
    expect(Math.min(...lit)).toBeGreaterThan(tallH - skylineMax(tallH));
    const share = (n: number, h: number) => n / windows(0, v.w, h).length;
    const low = recorder();
    paintCityNight(low, tokyo(21), world, { zoom: 1, ox: 0, oy: 0 }, { w: v.w, h: street * TILE + 10 }, 0);
    expect(Math.abs(share(lit.length, tallH) - share(fills(low, CITY.window).length, street * TILE))).toBeLessThan(0.05);
  });

  it("lit windows are tested only against what stands in front of the skyline: the street's trees and lamps — never the lounge under the street", () => {
    for (const w of [lounged, referenceCity]) {
      const boxes = skylineOccluders(w);
      const front = w.props.filter((p) => p.kind === "tree" || p.kind === "lamp");
      expect(front.length).toBeGreaterThanOrEqual(4);
      // Each reaches a tile above its footprint (tall art), down to its foot.
      expect(boxes).toEqual(front.map((p) => [p.col * TILE, (p.row - 1) * TILE, p.w * TILE, (p.h + 1) * TILE]));
      // There was something to leave out: a bench per seat, the lounge's lift and the Seats hall under the
      // lounge, all under the street.
      expect(w.props.filter((p) => p.kind === "bench")).toHaveLength(64);
      expect(w.props.some((p) => p.kind === "lift")).toBe(true);
      expect(w.props.filter((p) => p.kind === "hall").map((p) => p.row > w.city!.street + 3)).toEqual([true]);
      // Worked out once per world.
      expect(skylineOccluders(w)).toBe(boxes);
      // The line is the street's top: a lamp moved down onto the first lane (its art's top on that
      // line) is wholly below it; one tile up, on the far sidewalk, it reaches over it.
      const lamp = front.find((p) => p.kind === "lamp")!;
      const s = w.city!.street;
      const moved = (row: number) => skylineOccluders({ ...w, props: [...w.props, { ...lamp, col: lamp.col + 1, row }] }).length - boxes.length;
      expect([moved(s + 1), moved(s)]).toEqual([0, 1]);
    }
  });

  it("walks none of it when its band is off screen — zoomed in on gazelle's upper floors, or down on the lounge — and all of it while one row shows", () => {
    const v = { w: 400, h: 300 };
    const top = skylineMax(tallH);
    /** The skyline's own rects at a zoom-2 camera `oy`: blocks, edges, panes by day; lit windows at night. */
    const drawn = (oy: number) => {
      const c = { zoom: 2, ox: 0, oy };
      const day = recorder();
      paintCityBackdrop(day, tokyo(12), referenceCity, c, v, 0);
      const night = recorder();
      paintCityNight(night, tokyo(21), referenceCity, c, v, 0);
      return [fills(day, CITY.skyline).length + fills(day, CITY.skylineEdge).length + fills(day, CITY.skylinePane).length, fills(night, CITY.window).length];
    };
    // The street's top at the view's top: the band is just above it (looking down on the lounge).
    expect(drawn(-2 * tallH)).toEqual([0, 0]);
    // One row of it in view, at the very top — or at the very bottom, its top row.
    for (const [d, n] of [drawn(-2 * tallH + 1), drawn(v.h - 1 - 2 * (tallH - top))]) {
      expect(d).toBeGreaterThan(100);
      expect(n).toBeGreaterThan(10);
    }
    // Its top at the view's bottom: the band is just below it (looking at gazelle's upper floors).
    expect(drawn(v.h - 2 * (tallH - top))).toEqual([0, 0]);
  });
});

describe("the night sky stays behind the far skyline", () => {
  /** Is world (x, y) on a block's face (its 1-px gap of sky excluded)? */
  const onFace = (blocks: { x: number; w: number; h: number }[], horizon: number, x: number, y: number) =>
    blocks.some((b) => x >= b.x && x < b.x + b.w - 1 && y >= horizon - b.h);

  it("skylineFaceAt is the top of the block standing at x — and the street's top in each block's 1-px gap of sky", () => {
    for (const horizon of [240, 976, 1008]) {
      const blocks = skylineBlocks(-2000, 2000, horizon);
      for (const b of blocks.slice(1, -1)) {
        for (let x = b.x; x < b.x + b.w - 1; x++) expect(skylineFaceAt(x, horizon)).toBe(horizon - b.h);
        expect(skylineFaceAt(b.x + b.w - 1, horizon)).toBe(horizon);
      }
    }
  });

  it("no star is painted on a block's face — though the star field puts some there — in a low city and a tall one; the open sky in its band keeps its stars", () => {
    for (const w of [world, referenceCity]) {
      const horizon = w.city!.street * TILE;
      const v = { w: w.cols * TILE, h: 400 };
      // The street's top at screen y 300, the view starting at world x 0.
      const c = { zoom: 1, ox: 0, oy: 300 - horizon };
      const blocks = skylineBlocks(0, v.w, horizon);
      const ctx = recorder();
      paintCityNight(ctx, tokyo(21), w, c, v, 0);
      const stars = fills(ctx, CITY.star).map((f) => [(f.args[0] as number) - c.ox, (f.args[1] as number) - c.oy]);
      expect(stars.length).toBeGreaterThan(20);
      expect(stars.filter(([x, y]) => onFace(blocks, horizon, x, y))).toEqual([]);
      // In the skyline's band, stars still shine over its gaps and shorter blocks.
      expect(stars.filter(([, y]) => y >= horizon - skylineMax(horizon) && y < horizon).length).toBeGreaterThan(0);
      // The star field itself (a star in one 32-px cell in three, at a hashed spot) puts some on the faces.
      let hidden = 0;
      for (let r = 0; r * 32 < horizon - TILE; r++)
        for (let k = 0; k * 32 < v.w; k++) {
          const hh = hash(k, r, 71);
          if (hh % 3 === 0 && onFace(blocks, horizon, k * 32 + ((hh >>> 3) % 32), r * 32 + ((hh >>> 9) % 32))) hidden++;
        }
      expect(hidden).toBeGreaterThan(0);
    }
  });

  it("a star that falls exactly on a block's top row — its lit edge — is behind the block too; one just above it shines", () => {
    /** A city (the street moved, nothing else) whose sky puts a star of the field `dy` px from a block's top, over its face. */
    const cityWith = (dy: number) => {
      for (let h = 400; h < 4000; h += 16) {
        const blocks = skylineBlocks(0, 2000, h);
        for (let r = 0; r * 32 < h - TILE; r++)
          for (let k = 0; k * 32 < 2000; k++) {
            const hh = hash(k, r, 71);
            const x = k * 32 + ((hh >>> 3) % 32);
            const y = r * 32 + ((hh >>> 9) % 32);
            if (hh % 3 === 0 && blocks.some((b) => x >= b.x && x < b.x + b.w - 1 && y === h - b.h + dy)) return { h, x, y };
          }
      }
      throw new Error(`no star ${dy} px from a block's top`);
    };
    for (const [dy, shown] of [[0, false], [-1, true]] as const) {
      const { h, x, y } = cityWith(dy);
      const city = { ...world, city: { ...world.city!, street: h / TILE } };
      const ctx = recorder();
      paintCityNight(ctx, tokyo(21), city, { zoom: 1, ox: 0, oy: 0 }, { w: 2000, h: h + 10 }, 0);
      const stars = fills(ctx, CITY.star).map((f) => `${f.args[0]},${f.args[1]}`);
      expect(stars.length).toBeGreaterThan(50);
      expect(stars.includes(`${x},${y}`), `the star ${dy} px from the top, sky of ${h}`).toBe(shown);
    }
  });

  it("the moon rises and sets behind its blocks: hidden while its centre is on a block's face, up once it clears them", () => {
    for (const w of [world, referenceCity]) {
      const horizon = w.city!.street * TILE;
      const v = { w: w.cols * TILE, h: w.rows * TILE };
      const flat = { zoom: 1, ox: 0, oy: 0 };
      const blocks = skylineBlocks(0, v.w, horizon);
      const moon = (t: number) => {
        const ctx = recorder();
        paintCityNight(ctx, { ...tokyo(21), arc: { body: "moon", t } }, w, flat, v, 0);
        return fills(ctx, CITY.moon).length;
      };
      // From moonrise: behind a block first, then clear of the skyline.
      const ts = Array.from({ length: 80 }, (_, i) => i / 2000);
      const behind = ts.filter((t) => onFace(blocks, horizon, bodyCenter(w, t).x, bodyCenter(w, t).y));
      const clear = ts.filter((t) => !onFace(blocks, horizon, bodyCenter(w, t).x, bodyCenter(w, t).y));
      expect(behind.length).toBeGreaterThan(0);
      expect(clear.length).toBeGreaterThan(0);
      for (const t of behind) expect(moon(t), `t ${t}`).toBe(0);
      for (const t of clear) expect(moon(t), `t ${t}`).toBeGreaterThan(0);
    }
  });
});

describe("screenRect", () => {
  it("maps a world-px rect through the camera", () => {
    expect(screenRect({ zoom: 3, ox: 10, oy: -5 }, 4, 8, 16, 2)).toEqual([22, 19, 48, 6]);
  });
});

describe("the city's landmarks in the backdrop and the night pass (render/landmarks.ts)", () => {
  /** The same Tokyo sky, with and without the machine's zone. */
  const zoned = (h: number, m = 0): Ambience => ({ ...tokyo(h, m), zone: "Asia/Tokyo" });
  const horizon = street * TILE;
  const calls = (paint: (ctx: RecordingTarget) => void) => {
    const ctx = recorder();
    paint(ctx);
    return ctx.calls.map((c) => JSON.stringify(c));
  };
  /** Where `part` sits, contiguous, inside `whole` (-1: nowhere). */
  const at = (whole: string[], part: string[]) => {
    for (let i = 0; i + part.length <= whole.length; i++) if (part.every((p, k) => whole[i + k] === p)) return i;
    return -1;
  };

  it("Fuji after the sky and sun but before the clouds; the towers after the clouds, before the skyline blocks", () => {
    // Cloudy, so there are clouds between the two layers.
    const amb: Ambience = { ...tokyo(12, 0, "cloudy"), zone: "Asia/Tokyo" };
    const plain = calls((c) => paintCityBackdrop(c, tokyo(12, 0, "cloudy"), world, cam, view, 0));
    // The clip round Tokyo's open sky (the haze is not painted there) is not a landmark's: left out.
    const CLIP = new Set(["save", "beginPath", "rect", "clip", "restore"]);
    const all = calls((c) => paintCityBackdrop(c, amb, world, cam, view, 0)).filter((c) => !CLIP.has(JSON.parse(c).op));
    expect(plain.some((c) => CLIP.has(JSON.parse(c).op))).toBe(false);
    const far = calls((c) => paintFarLandmarks(c, cam, world, view, amb, horizon));
    const towers = calls((c) => paintLandmarks(c, cam, world, view, amb, horizon, 0));
    const near = calls((c) => paintNearLandmarks(c, cam, world, view, amb, horizon, 0));
    expect(far.length).toBeGreaterThan(0);
    expect(towers.length).toBeGreaterThan(0);
    expect(near.length).toBeGreaterThan(0);
    const i = at(all, far);
    const j = at(all, towers);
    const k = at(all, near);
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i + far.length - 1);
    // The temples come after the towers AND after the skyline's blocks (they stand in front of its haze).
    expect(k).toBeGreaterThan(j + towers.length - 1);
    const blocks = all.map((c, n) => (c.includes(JSON.stringify(citySky(amb).skyline.block)) ? n : -1)).filter((n) => n >= 0);
    expect(blocks.length).toBeGreaterThan(0);
    expect(k).toBeGreaterThan(Math.max(...blocks));
    // Take all three out again and the backdrop is exactly the one without a zone.
    expect([
      ...all.slice(0, i),
      ...all.slice(i + far.length, j),
      ...all.slice(j + towers.length, k),
      ...all.slice(k + near.length),
    ]).toEqual(plain);
    // Something is painted between the two layers (the clouds) — they are separate layers, not one block.
    expect(j - (i + far.length)).toBeGreaterThan(0);
  });

  it("at night: the landmarks' own lights are painted, and no star or moon shows through their silhouettes", () => {
    const amb = zoned(21);
    const night = calls((c) => paintCityNight(c, amb, world, cam, view, 0));
    const lights = calls((c) => paintLandmarkLights(c, cam, world, view, amb, horizon, 0));
    expect(lights.length).toBeGreaterThan(0);
    expect(at(night, lights)).toBeGreaterThanOrEqual(0);
    const behind = landmarkMask(cam, world, view, amb, horizon)!;
    const ctx = recorder();
    paintCityNight(ctx, amb, world, cam, view, 0);
    const stars = fills(ctx, CITY.star).map((c) => c.args as number[]);
    expect(stars.length).toBeGreaterThan(0);
    // Screen → world: zoom 1, the camera 40 px down.
    expect(stars.filter(([x, y]) => behind(x, y - 40))).toEqual([]);
    // Without the zone the same night has stars there (the mask is what hides them).
    const bare = recorder();
    paintCityNight(bare, tokyo(21), world, cam, view, 0);
    expect(fills(bare, CITY.star).some((c) => behind((c.args as number[])[0], (c.args as number[])[1] - 40))).toBe(true);
  });

  it("by day nothing is lit, and no zone means no landmarks at all", () => {
    expect(calls((c) => paintLandmarkLights(c, cam, world, view, zoned(12), horizon, 0))).toEqual([]);
    expect(calls((c) => paintCityBackdrop(c, tokyo(12), world, cam, view, 0))).toEqual(
      calls((c) => paintCityBackdrop(c, { ...tokyo(12), zone: "Europe/Paris" }, world, cam, view, 0)),
    );
  });
});

describe("shooting stars — one every five minutes on a clear night", () => {
  const span = { x0: 0, x1: 640 };

  it("exactly one crossing per 5-minute window, each SHOOTING_MS long, at a moment that differs between windows", () => {
    const starts: number[] = [];
    let was = false;
    for (let t = 0; t < 3 * SHOOTING_PERIOD_MS; t += 50) {
      const on = shootingStar(t, span, 0, 200) !== null;
      if (on && !was) starts.push(t);
      was = on;
    }
    expect(starts).toHaveLength(3);
    starts.forEach((t, i) => expect(Math.floor(t / SHOOTING_PERIOD_MS)).toBe(i));
    expect(new Set(starts.map((t) => t % SHOOTING_PERIOD_MS)).size).toBe(3);
    // Each lasts its 1.2 s, give or take the 50 ms sampling.
    for (const t of starts) {
      expect(shootingStar(t + SHOOTING_MS - 60, span, 0, 200)).not.toBeNull();
      expect(shootingStar(t + SHOOTING_MS + 60, span, 0, 200)).toBeNull();
    }
  });

  it("starts in the middle of the view, high in the sky, and falls along a straight line", () => {
    for (let n = 0; n < 40; n++) {
      // The first instant this window's star is up.
      let t = n * SHOOTING_PERIOD_MS;
      while (!shootingStar(t, span, 0, 200)) t += 25;
      const a = shootingStar(t, span, 0, 200)!;
      const b = shootingStar(t + 600, span, 0, 200)!;
      expect(a.x).toBeGreaterThanOrEqual(span.x0 + 0.2 * 640 - 3);
      expect(a.x).toBeLessThanOrEqual(span.x0 + 0.8 * 640 + 3);
      expect(a.y).toBeLessThan(200 * 0.45);
      expect(b.y).toBeGreaterThan(a.y); // falling…
      expect(Math.abs(b.x - a.x)).toBeGreaterThan(0); // …and sideways
      expect((b.y - a.y) / (b.x - a.x)).toBeCloseTo(a.dy / a.dx, 6); // in a straight line
    }
  });

  it("paintCityNight draws it on a clear night (its 2-px head), not by day nor through clouds", () => {
    let t = 0;
    while (!shootingStar(t, { x0: worldXOf(0), x1: worldXOf(view.w) }, 0, street * TILE - TILE)) t += 25;
    const heads = (amb: Ambience) => {
      const ctx = recorder();
      paintCityNight(ctx, amb, world, cam, view, t + 400);
      return fills(ctx, CITY.star).filter((c) => (c.args as number[])[2] === 2);
    };
    expect(heads(tokyo(21))).toHaveLength(1);
    expect(heads(tokyo(12))).toEqual([]);
    expect(heads(tokyo(21, 0, "cloudy"))).toEqual([]);
  });
});

/** World x under screen x for the test camera (zoom 1). */
function worldXOf(x: number): number {
  return x - Math.round(cam.ox);
}

describe("the temples hide the far skyline's lit windows behind them", () => {
  it("at night no lit window is painted inside a temple's silhouette — though windows are lit there without the temples — in a low city and a tall one", () => {
    const amb = { ...tokyo(21), zone: "Asia/Tokyo" };
    for (const w of [world, referenceCity]) {
      const horizon = w.city!.street * TILE;
      const v = { w: w.cols * TILE, h: w.rows * TILE + 80 };
      const front = landmarkMask(cam, w, v, amb, horizon, ["near"])!;
      expect(front).not.toBeNull();
      const lit = (a: Ambience) => {
        const ctx = recorder();
        paintCityNight(ctx, a, w, cam, v, 0);
        // Screen → world: zoom 1, the camera 40 px down; a window is 1×2.
        return fills(ctx, CITY.window).map((c) => c.args as number[]).filter(([x, y]) => front(x, y - 40) || front(x, y - 39));
      };
      expect(lit(amb)).toEqual([]);
      expect(lit(tokyo(21)).length).toBeGreaterThan(0);
    }
  });
});

describe("a shooting star passes BEHIND the landmarks", () => {
  it("the part of its run over a landmark's silhouette is not painted; the rest is", () => {
    const amb = { ...tokyo(21), zone: "Asia/Tokyo" };
    const horizon = street * TILE;
    const behind = landmarkMask(cam, world, view, amb, horizon)!;
    const span = { x0: worldXOf(0), x1: worldXOf(view.w) };
    const skyTop = Math.max(Math.max(-32 * 4, -Math.round(cam.oy) / cam.zoom), 0);
    // Find a moment whose star has its head behind a landmark (Fuji, the towers or a temple).
    let hit: number | null = null;
    for (let n = 0; n < 400 && hit === null; n++)
      for (let t = n * SHOOTING_PERIOD_MS; t < (n + 1) * SHOOTING_PERIOD_MS; t += 1000) {
        let u = t;
        while (u < t + 1000 && !shootingStar(u, span, skyTop, horizon - TILE)) u += 40;
        const s = shootingStar(u, span, skyTop, horizon - TILE);
        if (s && behind(s.x, s.y)) {
          hit = u;
          break;
        }
        if (s) break;
      }
    expect(hit).not.toBeNull();
    const s = shootingStar(hit!, span, skyTop, horizon - TILE)!;
    const ctx = recorder();
    paintCityNight(ctx, amb, world, cam, view, hit!);
    // Its head (2 px wide) is behind the landmark: not painted. Screen = world, 40 px down.
    const heads = fills(ctx, CITY.star).filter((c) => (c.args as number[])[2] === 2);
    expect(heads).toEqual([]);
    expect(behind(s.x, s.y)).toBe(true);
  });
});

describe("the ground under the street — the field the lounge is dug into", () => {
  const W = 2000;
  const H = 1200;
  /** The backdrop of `w` at `cam` (no ground layer), recorded. */
  const paint = (w = lounged, c = { zoom: 1, ox: 0, oy: 0 }) => {
    const ctx = recorder();
    paintCityBackdrop(ctx, undefined, w, c, { w: W, h: H }, 0);
    return ctx;
  };
  const top = (w = lounged) => (w.city!.street + 4) * TILE;

  it("turf along the top, right under the far sidewalk, then soil in bands darkening with depth — across the whole view, down to its bottom", () => {
    for (const w of [world, lounged]) {
      const ctx = paint(w);
      const g = top(w);
      // The same ground whether or not a lounge is dug into it: it starts at the street, not at the world's end.
      expect(fills(ctx, CITY.verge).map((c) => c.args)).toEqual([[0, g, W, TURF]]);
      const bands = CITY.soil.map((color) => fills(ctx, color).map((c) => c.args as number[]));
      bands.forEach((b) => expect(b).toHaveLength(1));
      let y = g + TURF;
      bands.forEach(([[x, by, bw, bh]], i) => {
        expect([x, by, bw]).toEqual([0, y, W]);
        expect(bh).toBe(i === bands.length - 1 ? H - y : STRATUM);
        y += bh;
      });
      expect(y).toBe(H);
    }
    // Darker going down.
    const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b);
    for (let i = 1; i < CITY.soil.length; i++) expect(lum(CITY.soil[i])).toBeLessThan(lum(CITY.soil[i - 1]));
    // No green field any more below the world: the only turf is the strip at the top.
    expect(fills(paint(), CITY.verge)).toHaveLength(1);
  });

  it("scrolled into the soil, the bands still follow the world (their tops above the view are clipped by it) — and a street below the view has no ground either", () => {
    const deep = paint(lounged, { zoom: 1, ox: 0, oy: -(top() + 3 * STRATUM) });
    // Only the deepest band is on screen, from above the view's top to its bottom.
    const last = fills(deep, CITY.soil[CITY.soil.length - 1]);
    expect(last).toHaveLength(1);
    expect(last[0].args[3]).toBe(H - (last[0].args[1] as number));
    for (const color of CITY.soil.slice(0, 2)) expect(fills(deep, color)).toHaveLength(0);
    const below = paint(lounged, { zoom: 1, ox: 0, oy: H });
    for (const color of [CITY.verge, ...CITY.soil, CITY.pebble, CITY.blade, CITY.dug]) expect(fills(below, color)).toHaveLength(0);
    // The ground's top on screen, its deeper bands below the view: only what is on screen is filled.
    const shallow = paint(lounged, { zoom: 1, ox: 0, oy: H - top() - TURF - 10 });
    expect(fills(shallow, CITY.soil[0]).map((c) => c.args)).toEqual([[0, H - 10, W, STRATUM]]); // the canvas clips its foot
    for (const color of CITY.soil.slice(1)) expect(fills(shallow, color), color).toHaveLength(0);
    // The street on screen, the ground starting right at the view's bottom: the street, and no ground.
    const edge = paint(lounged, { zoom: 1, ox: 0, oy: H - top() });
    expect(fills(edge, CITY.sidewalk)).toHaveLength(2);
    for (const color of [CITY.verge, ...CITY.soil, CITY.pebble, CITY.blade, CITY.dug]) expect(fills(edge, color), color).toHaveLength(0);
  });

  it("blades of grass on the turf and pebbles in the soil, the same every frame, never on the street — none zoomed out", () => {
    const ctx = paint();
    const g = top();
    const blades = fills(ctx, CITY.blade).map((c) => c.args as number[]);
    const pebbles = fills(ctx, CITY.pebble).map((c) => c.args as number[]);
    // One 4-px cell in three, give or take: a sprinkle, not a hedge.
    expect(blades.length).toBeGreaterThan(W / 4 / 6);
    expect(blades.length).toBeLessThan(W / 4 / 2);
    expect(pebbles.length).toBeGreaterThan(50);
    for (const [, y, , h] of blades) expect([y, y + h]).toEqual([g - 1, g + 2]);
    for (const [, y] of pebbles) expect(y).toBeGreaterThan(g + TURF);
    expect(fills(paint(), CITY.pebble).map((c) => c.args)).toEqual(pebbles);
    // At ½ they would be specks: none (the bands and the turf stay).
    const half = paint(lounged, { zoom: 0.5, ox: 0, oy: 0 });
    expect([fills(half, CITY.blade).length, fills(half, CITY.pebble).length]).toEqual([0, 0]);
    expect(fills(half, CITY.verge)).toHaveLength(1);
  });

  it("darker, freshly dug soil round the lounge's outer walls — painted over the soil, and only where there is a lounge", () => {
    const h = lounged.houses.find((x) => x.capacity === "lounge")!;
    const ctx = paint();
    // The lounge's, first; the subway dug in under it (render/subway.ts) adds its own after it — along
    // its tunnel and round its stairwell.
    const [lx, ly, lw, lh] = [(h.col - 1) * TILE - DUG, h.row * TILE - DUG, (h.w + 2) * TILE + 2 * DUG, (h.h + 1) * TILE + 2 * DUG];
    expect(fills(ctx, CITY.dug).map((c) => c.args)[0]).toEqual([lx, ly, lw, lh]);
    // …none of which is round the lounge.
    for (const c of fills(ctx, CITY.dug).slice(1)) {
      const [x, y, w] = c.args as number[];
      expect(x + w <= lx || x >= lx + lw || y >= ly + lh).toBe(true);
    }
    const styles = ctx.calls.map((c) => c.fillStyle);
    expect(styles.indexOf(CITY.dug)).toBeGreaterThan(styles.lastIndexOf(CITY.pebble));
    expect(fills(paint(world), CITY.dug)).toHaveLength(0);
  });
});
