import { describe, expect, it } from "vitest";

import { asciiWorld } from "../engine/testWorld";
import type {
  Ambience,
  House,
  Prop,
  WeatherKind,
  WeatherParticle,
} from "../villageTypes";
import {
  SKY,
  interiorRects,
  isWet,
  outdoorRect,
  paintAmbience,
  paintPuddles,
  puddlesOf,
} from "./ambience";
import { buildCityWorld } from "../engine/city";
import { buildWorld, planHouses } from "../engine/world";
import { CITY } from "./city";
import { gradeColor } from "../engine/ambience";
import { rainSlant } from "../engine/weatherFx";
import { recorder, type DrawCall } from "./testRecorder";
import { VENDING_GLOW, vendingGlow } from "./tokyoProps";

const cam = { zoom: 1, ox: 0, oy: 0 };
const view = { w: 160, h: 160 };

const amb = (over: Partial<Ambience> = {}): Ambience => ({
  phase: "afternoon",
  daylight: 0.8,
  tint: { color: "#ffc890", alpha: 0.12 },
  weather: "rain",
  intensity: 0.6,
  wind: 0,
  lightsOn: false,
  campfireLit: false,
  stayIndoors: true,
  ...over,
});

const house = (over: Partial<House> = {}): House => ({
  key: "repo",
  label: "repo",
  col: 2,
  row: 2,
  w: 3,
  h: 2,
  doorCol: 3,
  doorRow: 4,
  hasIde: false,
  ...over,
});

const prop = (kind: Prop["kind"], col: number, row: number): Prop => ({
  id: kind + col,
  kind,
  col,
  row,
  w: 1,
  h: 1,
});

/** 10×10: grass, a path row (row 6) and a plaza row (row 7). */
const ROWS = [
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "..........",
  "==========",
  "oooooooooo",
  "..........",
  "..........",
];

const world = (extra: Parameters<typeof asciiWorld>[1] = {}) =>
  asciiWorld(ROWS, extra);

const fills = (calls: DrawCall[]) => calls.filter((c) => c.op === "fillRect");

describe("isWet", () => {
  it("only rain-like weather wets the ground", () => {
    const kinds: WeatherKind[] = [
      "clear",
      "cloudy",
      "fog",
      "drizzle",
      "rain",
      "snow",
      "storm",
    ];
    expect(kinds.filter(isWet)).toEqual(["drizzle", "rain", "storm"]);
  });
});

describe("interiorRects", () => {
  it("projects visible house interiors to screen rects and skips off-screen ones", () => {
    const w = world({
      houses: [house(), house({ key: "far", col: 40, row: 40 })],
    });
    expect(interiorRects(w, { zoom: 2, ox: 3, oy: -1 }, view)).toEqual([
      [3 + 64, -1 + 64, 96, 64],
    ]);
  });
});

describe("outdoorRect", () => {
  it("is the village's rect clipped to the view; no world = the whole view", () => {
    const w = world({ houses: [] }); // 10×10 tiles = 160 world px
    // Fitted with a margin: only the map, never the backdrop around it.
    expect(outdoorRect(w, { zoom: 1, ox: 20, oy: 10 }, { w: 300, h: 200 })).toEqual([20, 10, 160, 160]);
    // Zoomed past the view: clipped to the screen.
    expect(outdoorRect(w, { zoom: 2, ox: -40, oy: -40 }, view)).toEqual([0, 0, 160, 160]);
    // Panned right off screen: nothing outdoors is visible.
    expect(outdoorRect(w, { zoom: 1, ox: 500, oy: 0 }, view)).toEqual([500, 0, 0, 160]);
    expect(outdoorRect({ ...w, cols: 0, rows: 0 }, cam, view)).toEqual([0, 0, 160, 160]);
  });
});

describe("paintAmbience", () => {
  it("clips to the screen minus every house interior (even-odd), then grades and restores", () => {
    const ctx = recorder();
    const w = world({
      houses: [house(), house({ key: "b", col: 6, row: 0, w: 2, h: 2 })],
    });
    paintAmbience(ctx, amb({ weather: "clear" }), [], 0, w, cam, view, 0);
    const ops = ctx.calls.map((c) => c.op);
    expect(ops.slice(0, 6)).toEqual([
      "save",
      "beginPath",
      "rect",
      "rect",
      "rect",
      "clip",
    ]);
    expect(ctx.of("rect").map((c) => c.args)).toEqual([
      [0, 0, 160, 160],
      [32, 32, 48, 32],
      [96, 0, 32, 32],
    ]);
    expect(ctx.of("clip")[0].args).toEqual(["evenodd"]);
    expect(fills(ctx.calls)).toEqual([
      expect.objectContaining({
        args: [0, 0, 160, 160],
        fillStyle: "#ffc890",
        alpha: 0.12,
      }),
    ]);
    expect(ops[ops.length - 1]).toBe("restore");
    expect(ctx.globalAlpha).toBe(1);
  });

  it("no tint and clear skies paint nothing but the clip", () => {
    const ctx = recorder();
    paintAmbience(
      ctx,
      amb({ weather: "clear", tint: { color: "#000", alpha: 0 } }),
      [],
      0,
      world(),
      cam,
      view,
      0,
    );
    expect(fills(ctx.calls)).toHaveLength(0);
  });

  it("caps a tint alpha above 1 and adds an overcast veil scaled by intensity", () => {
    const ctx = recorder();
    paintAmbience(
      ctx,
      amb({
        weather: "storm",
        intensity: 1,
        tint: { color: "#123", alpha: 3 },
      }),
      [],
      0,
      world(),
      cam,
      view,
      0,
    );
    const [tint, veil] = fills(ctx.calls);
    expect(tint.alpha).toBe(1);
    expect(veil).toMatchObject({ fillStyle: SKY.veil, alpha: 0.24 });
  });

  it("rain: thin streaks, straight without wind, at most three stepped segments in a gale", () => {
    const drop: WeatherParticle = {
      kind: "rain",
      x: 50,
      y: 50,
      size: 8,
      alpha: 0.5,
    };
    const calm = recorder();
    paintAmbience(
      calm,
      amb({ tint: { color: "#000", alpha: 0 }, weather: "drizzle" }),
      [drop],
      0,
      world(),
      cam,
      view,
      0,
    );
    const calmRain = fills(calm.calls).filter((c) => c.fillStyle === SKY.rain);
    expect(calmRain.map((c) => c.args)).toEqual([[50, 42, 1, 8]]);
    expect(calmRain[0].alpha).toBe(0.5);

    const gale = recorder();
    paintAmbience(
      gale,
      amb({ wind: 1, tint: { color: "#000", alpha: 0 } }),
      [{ ...drop, alpha: 2 }],
      0,
      world(),
      cam,
      view,
      0,
    );
    const segs = fills(gale.calls).filter((c) => c.fillStyle === SKY.rain);
    expect(segs).toHaveLength(3);
    // Blowing right: the tail (top) sits upwind, to the left; the head is at the drop.
    expect(segs.map((c) => (c.args as number[])[0])).toEqual([47, 49, 50]);
    expect(segs.reduce((n, c) => n + (c.args as number[])[3], 0)).toBe(8);
    expect(segs[0].alpha).toBe(1);
  });

  it("rain streaks follow the WeatherFx geometry: tail at x − rainSlant·size, head at the drop, no empty segment", () => {
    for (const [wind, size] of [[1, 4], [1, 8], [-1, 12], [0.4, 3], [1, 1]] as const) {
      const ctx = recorder();
      paintAmbience(
        ctx,
        amb({ wind, tint: { color: "#000", alpha: 0 } }),
        [{ kind: "rain", x: 80, y: 80, size, alpha: 1 }],
        0,
        world(),
        cam,
        view,
        0,
      );
      const segs = fills(ctx.calls)
        .filter((c) => c.fillStyle === SKY.rain)
        .map((c) => c.args as number[]);
      for (const [, , , h] of segs) expect(h).toBeGreaterThanOrEqual(1);
      expect(segs.reduce((n, a) => n + a[3], 0)).toBe(size);
      expect(segs[0][1]).toBe(80 - size);
      expect(segs[segs.length - 1][0]).toBe(80); // head on the drop
      if (segs.length > 1) expect(segs[0][0]).toBe(80 + Math.round(-rainSlant(wind) * size));
    }
  });

  it("splash rings and snow flakes, culling particles outside the view", () => {
    const list: WeatherParticle[] = [
      { kind: "splash", x: 20, y: 20, size: 0.2, alpha: 1 },
      { kind: "splash", x: 40, y: 40, size: 2, alpha: -1 },
      { kind: "snow", x: 60, y: 60, size: 1, alpha: 1 },
      { kind: "snow", x: 70, y: 70, size: 2, alpha: 1 },
      { kind: "rain", x: 900, y: 900, size: 6, alpha: 1 },
    ];
    const ctx = recorder();
    paintAmbience(
      ctx,
      amb({ weather: "snow", intensity: 0, tint: { color: "#000", alpha: 0 } }),
      list,
      0,
      world(),
      cam,
      view,
      0,
    );
    const splash = fills(ctx.calls).filter((c) => c.fillStyle === SKY.splash);
    expect(splash.map((c) => c.args)).toEqual([
      [20, 20, 1, 1],
      [38, 40, 1, 1],
      [42, 40, 1, 1],
      [39, 39, 3, 1],
    ]);
    expect(splash[1].alpha).toBe(0);
    expect(
      fills(ctx.calls)
        .filter((c) => c.fillStyle === SKY.snow)
        .map((c) => c.args),
    ).toEqual([
      [60, 60, 1, 1],
      [70, 70, 2, 2],
    ]);
    expect(
      fills(ctx.calls).filter((c) => c.fillStyle === SKY.rain),
    ).toHaveLength(0);
  });

  it("particles snap to the integer screen grid at zoom", () => {
    const ctx = recorder();
    const z = { zoom: 3, ox: 0.4, oy: 0 };
    paintAmbience(
      ctx,
      amb({ tint: { color: "#000", alpha: 0 } }),
      [{ kind: "snow", x: 10.4, y: 5.6, size: 2, alpha: 1 }],
      0,
      world(),
      z,
      view,
      0,
    );
    const [flake] = fills(ctx.calls).filter((c) => c.fillStyle === SKY.snow);
    expect(flake.args).toEqual([30, 18, 6, 6]);
  });

  it("lights on: a Tokyo vending machine glows — the on-screen ones only, and none by day", () => {
    const w = world({ props: [prop("vending", 4, 6), prop("vending", 60, 60)] });
    const paint = (lightsOn: boolean) => {
      const ctx = recorder();
      paintAmbience(ctx, amb({ weather: "clear", lightsOn, campfireLit: true, tint: { color: "#000", alpha: 0 } }), [], 0, w, cam, view, 0);
      return fills(ctx.calls).filter((c) => c.fillStyle === VENDING_GLOW);
    };
    const want = recorder();
    vendingGlow(want, cam, 4 * 16, 7 * 16);
    expect(paint(true)).toEqual(fills(want.calls));
    expect(paint(true).length).toBeGreaterThan(0);
    expect(paint(false)).toEqual([]);
  });

  it("lights on: lamp halos, the lit campfire and every door spill warm light (only on-screen ones)", () => {
    const w = world({
      houses: [
        house(),
        house({ key: "off", col: 40, row: 40, doorCol: 41, doorRow: 42 }),
      ],
      props: [
        prop("lamp", 1, 8),
        prop("campfire", 7, 8),
        prop("lamp", 50, 50),
        prop("tree", 0, 0),
      ],
    });
    const lit = recorder();
    paintAmbience(
      lit,
      amb({
        weather: "clear",
        lightsOn: true,
        campfireLit: true,
        tint: { color: "#000", alpha: 0 },
      }),
      [],
      0,
      w,
      cam,
      view,
      0,
    );
    const colors = fills(lit.calls).map((c) => c.fillStyle);
    expect(colors.filter((c) => c === SKY.lamp)).toHaveLength(7); // one lamp on screen: 3 crossed pairs + ground pool
    expect(colors.filter((c) => c === SKY.fire)).toHaveLength(6);
    expect(colors.filter((c) => c === SKY.door)).toHaveLength(4); // one door on screen
    // The door spill starts at the door tile and widens below it.
    const door = fills(lit.calls)
      .filter((c) => c.fillStyle === SKY.door)
      .map((c) => c.args as number[]);
    expect(door[0]).toEqual([3 * 16 + 2, 4 * 16 + 2, 12, 14]);

    const out = recorder();
    paintAmbience(
      out,
      amb({
        weather: "clear",
        lightsOn: true,
        campfireLit: false,
        tint: { color: "#000", alpha: 0 },
      }),
      [],
      0,
      w,
      cam,
      view,
      0,
    );
    expect(
      fills(out.calls).filter((c) => c.fillStyle === SKY.fire),
    ).toHaveLength(0);

    const day = recorder();
    paintAmbience(
      day,
      amb({
        weather: "clear",
        lightsOn: false,
        tint: { color: "#000", alpha: 0 },
      }),
      [],
      0,
      w,
      cam,
      view,
      0,
    );
    expect(fills(day.calls)).toHaveLength(0);
  });

  it("fog: a veil plus drifting bands that move with time and wind", () => {
    const bands = (t: number, wind: number) => {
      const ctx = recorder();
      paintAmbience(
        ctx,
        amb({ weather: "fog", wind, tint: { color: "#000", alpha: 0 } }),
        [],
        0,
        world(),
        cam,
        view,
        t,
      );
      return fills(ctx.calls).filter((c) => c.fillStyle === SKY.fog);
    };
    const a = bands(0, 0);
    expect(a).toHaveLength(1 + 3 * 2 * 2);
    expect(a[0].args).toEqual([0, 0, 160, 160]);
    for (const c of a)
      for (const n of c.args as number[])
        expect(Number.isInteger(n)).toBe(true);
    const later = bands(5000, 0);
    expect(later[1].args[0]).not.toBe(a[1].args[0]);
    const back = bands(5000, -1);
    expect(back[1].args[0]).not.toBe(later[1].args[0]);
  });

  it("lightning brightens the outdoors by `flash`, capped", () => {
    const flash = (f: number) => {
      const ctx = recorder();
      paintAmbience(
        ctx,
        amb({ weather: "clear", tint: { color: "#000", alpha: 0 } }),
        [],
        f,
        world(),
        cam,
        view,
        0,
      );
      return fills(ctx.calls).filter((c) => c.fillStyle === SKY.flash);
    };
    expect(flash(0)).toHaveLength(0);
    expect(flash(0.5)[0]).toMatchObject({
      args: [0, 0, 160, 160],
      alpha: 0.275,
    });
    expect(flash(4)[0].alpha).toBe(0.55);
  });
});

describe("paintPuddles", () => {
  it("dry weather: nothing", () => {
    const ctx = recorder();
    paintPuddles(ctx, amb({ weather: "snow" }), world(), cam, view, 0);
    expect(ctx.calls).toHaveLength(0);
  });

  it("rain: puddles only on path/plaza tiles, stable per tile, with rings that change over time", () => {
    const at = (t: number) => {
      const ctx = recorder();
      paintPuddles(ctx, amb(), world(), cam, view, t);
      return ctx;
    };
    const ctx = at(0);
    const puddles = ctx
      .of("fillRect")
      .filter((c) => c.fillStyle === SKY.puddle);
    expect(puddles.length).toBeGreaterThan(0);
    for (const p of puddles) {
      const [, y, , h] = p.args as number[];
      // rows 6 (path) and 7 (plaza) only
      expect(y).toBeGreaterThanOrEqual(6 * 16 - 1);
      expect(y + h).toBeLessThanOrEqual(8 * 16);
    }
    expect(
      ctx.of("fillRect").filter((c) => c.fillStyle === SKY.ripple).length,
    ).toBe((puddles.length / 2) * 4);
    expect(ctx.globalAlpha).toBe(1);
    // Puddles stay put; ripples move.
    const again = at(0)
      .of("fillRect")
      .map((c) => c.args);
    expect(again).toEqual(ctx.of("fillRect").map((c) => c.args));
    const later = at(300)
      .of("fillRect")
      .filter((c) => c.fillStyle === SKY.ripple)
      .map((c) => c.args);
    expect(later).not.toEqual(
      ctx
        .of("fillRect")
        .filter((c) => c.fillStyle === SKY.ripple)
        .map((c) => c.args),
    );
  });

  it("only visits on-screen tiles", () => {
    const ctx = recorder();
    paintPuddles(
      ctx,
      amb({ weather: "storm" }),
      world(),
      { zoom: 2, ox: -1000, oy: -1000 },
      view,
      0,
    );
    expect(ctx.calls).toHaveLength(0);
    const partial = recorder();
    paintPuddles(
      partial,
      amb({ weather: "drizzle" }),
      world(),
      { zoom: 1, ox: 10, oy: 10 },
      { w: 40, h: 40 },
      0,
    );
    expect(partial.calls).toHaveLength(0); // rows 0..1 only: all grass
  });

  it("is laid out once per world and painted in colour batches (a fixed few style changes per frame)", () => {
    const big = buildWorld(
      planHouses(
        Array.from({ length: 20 }, (_, i) => ({
          key: `a${i}`,
          parentKey: null,
          origin: "external" as const,
          title: `a${i}`,
          folder: `f${i}`,
          activity: "idle" as const,
          tool: null,
          ideAgentId: null,
          lastActivityAt: null,
        })),
      ),
    );
    expect(puddlesOf(big)).toBe(puddlesOf(big)); // cached per World
    expect(puddlesOf(big).length).toBeGreaterThan(50);
    const ctx = recorder();
    let styles = 0;
    let alphas = 0;
    let fs = ctx.fillStyle;
    let ga = ctx.globalAlpha;
    Object.defineProperty(ctx, "fillStyle", { get: () => fs, set: (v) => { styles++; fs = v; } });
    Object.defineProperty(ctx, "globalAlpha", { get: () => ga, set: (v) => { alphas++; ga = v; } });
    paintPuddles(ctx, amb(), big, cam, { w: 4000, h: 4000 }, 123);
    expect(ctx.of("fillRect").length).toBeGreaterThan(300);
    expect(styles).toBe(3);
    expect(alphas).toBe(5);
    expect(ga).toBe(1);
  });
});

describe("the city's sky", () => {
  const cityWorld = buildCityWorld([
    {
      key: "p",
      label: "p",
      team: 2,
      hasIde: true,
      floors: [
        { key: "floor:a", label: "a", ide: true },
        { key: "floor:b", label: "b", ide: true },
      ],
    },
    { key: "q", label: "q", team: 0, hasIde: false, floors: [{ key: "floor:c", label: "c", ide: false }] },
  ]);
  const wide = { w: cityWorld.cols * 16 + 200, h: cityWorld.rows * 16 + 100 };
  const night = amb({ phase: "night", daylight: 0.15, weather: "clear", intensity: 0, lightsOn: true, arc: { body: "moon", t: 0.4 } });

  it("grades the WHOLE view — a city's sky has no edge — with every floor's room cut out", () => {
    expect(outdoorRect(cityWorld, cam, wide)).toEqual([0, 0, wide.w, wide.h]);
    const ctx = recorder();
    paintAmbience(ctx, amb(), [], 0, cityWorld, cam, wide, 0);
    const ops = ctx.calls.map((c) => c.op);
    const firstClip = ops.indexOf("clip");
    const rects = ctx.calls.slice(0, firstClip).filter((c) => c.op === "rect").map((c) => c.args);
    expect(rects[0]).toEqual([0, 0, wide.w, wide.h]);
    expect(rects.slice(1)).toEqual(interiorRects(cityWorld, cam, wide));
    expect(rects).toHaveLength(1 + cityWorld.houses.length);
    expect(ctx.calls[firstClip].args).toEqual(["evenodd"]);
  });

  it("then gives its open sky the night: a second clip — above the street, minus every building — round the stars and moon", () => {
    const ctx = recorder();
    paintAmbience(ctx, night, [], 0, cityWorld, cam, wide, 0);
    const ops = ctx.calls.map((c) => c.op);
    const second = ops.indexOf("clip", ops.indexOf("clip") + 1);
    expect(second).toBeGreaterThan(0);
    const sky = ctx.calls.slice(ops.lastIndexOf("beginPath", second), second).filter((c) => c.op === "rect").map((c) => c.args);
    expect(sky[0]).toEqual([0, 0, wide.w, cityWorld.city!.street * 16]);
    expect(sky.slice(1)).toEqual(cityWorld.city!.buildings.map((b) => [b.col * 16, b.row * 16, b.w * 16, b.h * 16]));
    const styles = ctx.calls.map((c) => c.fillStyle);
    expect(styles.indexOf(CITY.moon)).toBeGreaterThan(second);
    // The night sky is painted after the grade: stars are never tinted dark.
    expect(styles.indexOf(CITY.moon)).toBeGreaterThan(styles.indexOf(night.tint.color));
    // The village has no sky to light up.
    const village = recorder();
    paintAmbience(village, night, [], 0, world({ houses: [house()] }), cam, view, 0);
    expect(village.of("clip")).toHaveLength(1);
  });

  it("at night lights every floor's window frame and each building's street door — not the floors' doors", () => {
    const ctx = recorder();
    paintAmbience(ctx, night, [], 0, cityWorld, cam, wide, 0);
    expect(fills(ctx.calls).filter((c) => c.fillStyle === SKY.window)).toHaveLength(cityWorld.houses.length);
    const doors = fills(ctx.calls).filter((c) => c.fillStyle === SKY.door);
    expect(doors).toHaveLength(4 * cityWorld.city!.buildings.length);
    const b = cityWorld.city!.buildings[0];
    expect(doors[0].args).toEqual([b.doorCol * 16 + 2, (b.row + b.h) * 16 - 16 + 2, 12, 14]);
    // A floor off screen gets no glow.
    const ctx2 = recorder();
    paintAmbience(ctx2, night, [], 0, cityWorld, { zoom: 1, ox: -b.col * 16 - b.w * 16 - 4, oy: 0 }, { w: 40, h: wide.h }, 0);
    expect(fills(ctx2.calls).filter((c) => c.fillStyle === SKY.window).length).toBeLessThan(cityWorld.houses.length);
  });

  it("puddles the road as well as the sidewalks", () => {
    const kinds = new Set(puddlesOf(cityWorld).map((p) => cityWorld.tiles[p.row * cityWorld.cols + p.col]));
    expect(kinds).toEqual(new Set(["path", "road"]));
  });
});

describe("the City sky's inverse grade is the painter's grade", () => {
  const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  /** Source-over of `src` at `alpha` onto an opaque `dst`. */
  const over = (dst: number[], src: string, alpha: number) => rgb(src).map((v, i) => v * alpha + dst[i] * (1 - alpha));

  it("gradeColor is exactly paintAmbience's tint fill then veil fill, composited over the pixel", () => {
    for (const a of [
      amb({ weather: "storm", intensity: 0.5, tint: { color: "#ff7a30", alpha: 0.24 } }),
      amb({ weather: "rain", intensity: 1, tint: { color: "#0b1640", alpha: 0.55 } }),
      amb({ weather: "clear", intensity: 0, tint: { color: "#ff8e42", alpha: 0.188 } }),
    ]) {
      const ctx = recorder();
      paintAmbience(ctx, a, [], 0, world(), cam, view, 0);
      // The first full-view fills are the grade: the tint, then the veil when the weather has one.
      const grade = fills(ctx.calls).filter((c) => c.args[2] === view.w && c.args[3] === view.h);
      expect(grade.length).toBe(a.weather === "clear" ? 1 : 2);
      for (const paint of ["#4c8ddf", "#ffbe68", "#060a20"]) {
        let px = rgb(paint);
        for (const g of grade) px = over(px, g.fillStyle, g.alpha);
        expect([paint, rgb(gradeColor(a, paint))]).toEqual([paint, px.map((v) => Math.round(v))]);
      }
    }
  });
});
