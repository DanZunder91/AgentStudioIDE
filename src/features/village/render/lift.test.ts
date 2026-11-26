import { describe, expect, it } from "vitest";

import { buildCityWorld, planCity } from "../engine/city";
import { liftShafts } from "../engine/drawList";
import { TILE, type Ambience, type CharacterView, type DrawItem, type Prop, type VillageAgent } from "../villageTypes";
import { paintAmbience } from "./ambience";
import { headTop } from "./characters";
import { renderFrame } from "./frame";
import { CAR, CAR_H, CAR_W, DOOR_H, drawCar, drawKiosk, drawShaft, KIOSK, KIOSK_RISE, kioskGlow, kioskGlowBox, SHAFT, SHAFT_GLOW, shaftGlow, shaftGlowBox } from "./lift";
import { drawProp } from "./props";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
type Fill = { x: number; y: number; w: number; h: number; style: string };
const fills = (ctx: RecordingTarget): Fill[] =>
  ctx.of("fillRect").map((c) => {
    const [x, y, w, h] = c.args as number[];
    return { x, y, w, h, style: c.fillStyle };
  });
const of = (ctx: RecordingTarget, style: string) => fills(ctx).filter((f) => f.style === style);
/** Every fill lies inside [x0, x1) × [y0, y1). */
const within = (fs: Fill[], x0: number, y0: number, x1: number, y1: number) => fs.every((f) => f.x >= x0 && f.y >= y0 && f.x + f.w <= x1 && f.y + f.h <= y1);

const shaft = (over: Partial<Extract<DrawItem, { t: "shaft" }>> = {}): Extract<DrawItem, { t: "shaft" }> => ({ t: "shaft", col: 3, top: 2, bottom: 9, stops: [3, 8], ...over });

describe("drawShaft", () => {
  it("is a dark strip over its column and rows, edged darker, between two light rails, a tie across them on every row", () => {
    const ctx = recorder();
    drawShaft(ctx, cam, shaft());
    const x0 = 3 * TILE;
    expect(of(ctx, SHAFT.edge)).toEqual([{ x: x0 + 1, y: 2 * TILE, w: 14, h: 8 * TILE, style: SHAFT.edge }]);
    expect(of(ctx, SHAFT.back)).toEqual([{ x: x0 + 2, y: 2 * TILE, w: 12, h: 8 * TILE, style: SHAFT.back }]);
    expect(of(ctx, SHAFT.rail).map((f) => [f.x, f.w, f.y, f.h])).toEqual([
      [x0 + 3, 1, 2 * TILE, 8 * TILE],
      [x0 + 12, 1, 2 * TILE, 8 * TILE],
    ]);
    expect(of(ctx, SHAFT.tie).map((f) => f.y)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((r) => r * TILE + 7));
    // All of it inside its own column and rows.
    expect(within(fills(ctx), x0 + 1, 2 * TILE, x0 + 15, 10 * TILE)).toBe(true);
  });

  it("has a landing door at each stop, standing on that row's floor line — its two leaves split by a seam, a call lamp over it", () => {
    const ctx = recorder();
    drawShaft(ctx, cam, shaft());
    const x0 = 3 * TILE;
    const floors = [4 * TILE, 9 * TILE];
    expect(of(ctx, SHAFT.frame).map((f) => [f.x, f.y + f.h, f.w, f.h])).toEqual(floors.map((fl) => [x0 + 2, fl, 12, DOOR_H]));
    expect(of(ctx, SHAFT.leaf).map((f) => [f.y + f.h, f.x, f.w])).toEqual(floors.map((fl) => [fl, x0 + 3, 10]));
    expect(of(ctx, SHAFT.seam).map((f) => [f.x, f.w])).toEqual([
      [x0 + 7, 2],
      [x0 + 7, 2],
    ]);
    // The lamp just above each door; a door is as tall as a standing character (its head top 29 px up is under the frame's top).
    expect(of(ctx, SHAFT.lamp).map((f) => f.y)).toEqual(floors.map((fl) => fl - DOOR_H - 2));
    expect(DOOR_H).toBeLessThan(29 + 1);
    expect(DOOR_H).toBeGreaterThan(20);
    // Doors are drawn over the strip: every door piece comes after the rails.
    const ops = fills(ctx).map((f) => f.style);
    expect(ops.lastIndexOf(SHAFT.rail)).toBeLessThan(ops.indexOf(SHAFT.frame));
  });

  it("without stops draws no door", () => {
    const ctx = recorder();
    drawShaft(ctx, cam, shaft({ stops: [] }));
    expect(of(ctx, SHAFT.frame)).toEqual([]);
    expect(of(ctx, SHAFT.lamp)).toEqual([]);
  });
});

describe("drawCar", () => {
  const rider = { x: 100, y: 200 };
  it("its back: a lit wall and a ceiling light inside the car's box, behind the rider", () => {
    const ctx = recorder();
    drawCar(ctx, cam, { t: "car", ...rider, part: "back" });
    expect(of(ctx, CAR.wall)).toEqual([{ x: 94, y: 171, w: 12, h: 27, style: CAR.wall }]);
    expect(of(ctx, CAR.light)).toEqual([{ x: 96, y: 171, w: 8, h: 1, style: CAR.light }]);
    expect(of(ctx, CAR.frame)).toEqual([]);
  });

  it("its front: lintel, sill and posts round a CAR_W × CAR_H box standing on the rider's feet — the rider's head and body fit inside", () => {
    const ctx = recorder();
    drawCar(ctx, cam, { t: "car", ...rider, part: "front" });
    const box = { x0: rider.x - CAR_W / 2, y0: rider.y - CAR_H, x1: rider.x + CAR_W / 2, y1: rider.y };
    expect(of(ctx, CAR.frame).map((f) => [f.x, f.y, f.w, f.h])).toEqual([
      [box.x0, box.y0, CAR_W, 2],
      [box.x0, box.y1 - 2, CAR_W, 2],
      [box.x0, box.y0 + 2, 1, CAR_H - 4],
      [box.x1 - 1, box.y0 + 2, 1, CAR_H - 4],
    ]);
    expect(of(ctx, CAR.wall)).toEqual([]);
    // The rider's head top (a standing character's) is below the lintel; its 8-px body between the posts.
    const head = headTop({ y: rider.y, seated: false });
    expect(head).toBeGreaterThanOrEqual(box.y0 + 2);
    expect(rider.x - 4).toBeGreaterThan(box.x0);
    expect(rider.x + 4).toBeLessThan(box.x1 - 1);
  });

  it("snaps a rider between pixels to whole ones", () => {
    const ctx = recorder();
    drawCar(ctx, cam, { t: "car", x: 100.4, y: 199.6, part: "back" });
    expect(of(ctx, CAR.wall)[0]).toMatchObject({ x: 94, y: 171 });
  });
});

describe("drawKiosk — the lounge lift's booth on the far sidewalk", () => {
  const x0 = 64;
  const bottom = 160;
  const paint = (lit: boolean) => {
    const ctx = recorder();
    drawKiosk(ctx, cam, x0, bottom, lit);
    return ctx;
  };

  it("a glass booth two tiles tall under a canopy, posts either side, on a plinth — all within its column", () => {
    const ctx = paint(false);
    expect(KIOSK_RISE).toBe(TILE);
    const top = bottom - 2 * TILE;
    expect(within(fills(ctx), x0, top, x0 + TILE, bottom)).toBe(true);
    expect(of(ctx, KIOSK.canopy)).toEqual([{ x: x0, y: top, w: TILE, h: 5, style: KIOSK.canopy }]);
    expect(of(ctx, KIOSK.plinth)).toEqual([{ x: x0, y: bottom - 2, w: TILE, h: 2, style: KIOSK.plinth }]);
    expect(of(ctx, KIOSK.post).map((f) => f.x)).toEqual([x0 + 1, x0 + 13]);
    expect(of(ctx, KIOSK.glass)).toHaveLength(1);
    // The up / down sign: two arrows of 4 px each on the canopy.
    const sign = of(ctx, KIOSK.sign);
    expect(sign.reduce((n, f) => n + f.w * f.h, 0)).toBe(8);
    expect(sign.every((f) => f.y > top && f.y < top + 4)).toBe(true);
  });

  it("lit at night: its glass glows warm and its sign too; by day neither", () => {
    const night = paint(true);
    expect(of(night, KIOSK.glassLit)).toHaveLength(1);
    expect(of(night, KIOSK.glass)).toEqual([]);
    expect(of(night, KIOSK.signLit)).toHaveLength(4);
    expect(of(night, KIOSK.sign)).toEqual([]);
    expect(of(paint(false), KIOSK.glassLit)).toEqual([]);
  });

  it("its light pool stays in kioskGlowBox", () => {
    const ctx = recorder();
    kioskGlow(ctx, cam, x0, bottom);
    const [x, y, w, h] = kioskGlowBox(x0, bottom);
    expect(of(ctx, KIOSK.glow)).toHaveLength(3);
    expect(within(fills(ctx), x, y, x + w, y + h)).toBe(true);
    // It reaches the sidewalk either side of the booth and up past its canopy.
    expect(x).toBeLessThan(x0);
    expect(x + w).toBeGreaterThan(x0 + TILE);
    expect(y).toBeLessThanOrEqual(bottom - 2 * TILE);
  });

  it("drawProp draws a `lift` prop as the kiosk — lit only when the night lights are on", () => {
    const prop: Prop = { id: "k", kind: "lift", col: 4, row: 9, w: 1, h: 1 };
    const draw = (ambience?: Ambience) => {
      const ctx = recorder();
      drawProp(ctx, cam, { prop, on: false, frame: 0 }, null, 0, ambience);
      return ctx;
    };
    const want = recorder();
    drawKiosk(want, cam, 4 * TILE, 10 * TILE, false);
    expect(fills(draw())).toEqual(fills(want));
    const sky = (lightsOn: boolean) => ({ lightsOn }) as Ambience;
    expect(of(draw(sky(true)), KIOSK.glassLit)).toHaveLength(1);
    expect(of(draw(sky(false)), KIOSK.glassLit)).toEqual([]);
  });
});

describe("renderFrame — shafts and cars", () => {
  const view = { w: 320, h: 320 };
  const rider: CharacterView = {
    key: "r",
    x: 56,
    y: 120,
    dir: "down",
    anim: "idle",
    frame: 0,
    palette: 0,
    hueShift: 0,
    seated: false,
    origin: "ide",
    isSubagent: true,
    activity: "typing",
    label: "r",
    tool: null,
    bubble: null,
    bubbleAlpha: 0,
    fx: null,
    riding: true,
  };

  it("paints a shaft, then the car's back, the rider and the car's front, in that order", () => {
    const ctx = recorder();
    const items: DrawItem[] = [shaft(), { t: "car", x: 56, y: 120, part: "back" }, { t: "character", c: rider }, { t: "car", x: 56, y: 120, part: "front" }];
    renderFrame(ctx, items, cam, null, view);
    const styles = fills(ctx).map((f) => f.style);
    const back = styles.indexOf(CAR.wall);
    const front = styles.indexOf(CAR.frame);
    expect(styles.indexOf(SHAFT.back)).toBeGreaterThanOrEqual(0);
    expect(styles.lastIndexOf(SHAFT.lamp)).toBeLessThan(back);
    // The rider (its fallback body, no art) between the two.
    const body = fills(ctx).findIndex((f, i) => i > back && f.style !== CAR.wall && f.style !== CAR.light && f.w === 8 && f.h === 16);
    expect(body).toBeGreaterThan(back);
    expect(body).toBeLessThan(front);
  });

  it("culls a shaft and a car that are off screen", () => {
    const ctx = recorder();
    renderFrame(ctx, [shaft({ col: 40 }), shaft({ top: 30, bottom: 40 }), { t: "car", x: 900, y: 120, part: "back" }, { t: "car", x: 56, y: 900, part: "front" }], cam, null, view);
    expect(fills(ctx).filter((f) => f.style === SHAFT.back || f.style === CAR.wall || f.style === CAR.frame)).toEqual([]);
    // …and one just on screen at a corner is drawn.
    const edge = recorder();
    renderFrame(edge, [shaft({ col: 19, top: 19, bottom: 25 }), { t: "car", x: 320 + 6, y: 320 + 30, part: "back" }], cam, null, view);
    expect(fills(edge).filter((f) => f.style === SHAFT.back)).toHaveLength(1);
    expect(fills(edge).filter((f) => f.style === CAR.wall)).toHaveLength(1);
  });
});

describe("the night lights — the kiosk and the shafts glow", () => {
  const agent = (key: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({ key, parentKey: null, origin: "ide", title: key, folder: "gazelle", activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null, ...extra });
  const roster = planCity([agent("g"), agent("g2"), agent("g.s0", { parentKey: "g", folder: "x" })]);
  const world = buildCityWorld(roster.plans, { seats: 16 });
  const big = { w: world.cols * TILE, h: world.rows * TILE };
  const sky = (lightsOn: boolean): Ambience => ({
    phase: lightsOn ? "night" : "noon",
    daylight: lightsOn ? 0.1 : 1,
    tint: { color: "#000", alpha: 0 },
    weather: "clear",
    intensity: 0,
    wind: 0,
    lightsOn,
    campfireLit: true,
    stayIndoors: false,
  });
  const paint = (lightsOn: boolean, v = big) => {
    const ctx = recorder();
    paintAmbience(ctx, sky(lightsOn), [], 0, world, cam, v, 0);
    return ctx;
  };

  it("at night every shaft glows over its column, and the kiosk's light pools on the far sidewalk", () => {
    const ctx = paint(true);
    const shafts = liftShafts(world);
    expect(shafts).toHaveLength(2);
    const want = recorder();
    for (const s of shafts) shaftGlow(want, cam, s);
    expect(of(ctx, SHAFT_GLOW)).toEqual(of(want, SHAFT_GLOW));
    expect(of(ctx, SHAFT_GLOW).map((f) => [f.x, f.y, f.w, f.h])).toEqual(shafts.map((s) => shaftGlowBox(s)));
    const kiosk = world.props.find((p) => p.kind === "lift")!;
    const k = recorder();
    kioskGlow(k, cam, kiosk.col * TILE, (kiosk.row + 1) * TILE);
    expect(of(ctx, KIOSK.glow)).toEqual(of(k, KIOSK.glow));
  });

  it("by day, nothing; off screen, nothing", () => {
    expect(of(paint(false), SHAFT_GLOW)).toEqual([]);
    expect(of(paint(false), KIOSK.glow)).toEqual([]);
    const corner = paint(true, { w: 8, h: 8 });
    expect(of(corner, SHAFT_GLOW)).toEqual([]);
    expect(of(corner, KIOSK.glow)).toEqual([]);
  });
});
