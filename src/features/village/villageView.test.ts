/** No React, no DOM canvas: the paint goes to the renderer's recording fake. */

import { describe, expect, it, vi } from "vitest";

// The real draw list, observed: the LAN tests read the events each frame hands it (its 8th argument).
vi.mock("./engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("./engine")>();
  return { ...real, buildDrawList: vi.fn(real.buildDrawList) };
});
// The backdrop's high-rises, observed: a Tokyo city paints them, any other does not (render/city.ts `backdropOf`).
const towers = vi.hoisted(() => ({ paint: vi.fn(), paintLights: vi.fn(), faceAt: (s: { horizon: number }) => s.horizon }));
vi.mock("./render/backdropTowers", () => ({ TOWERS: towers }));

import {
  buildCityWorld,
  buildDrawList,
  buildWorld,
  computeAmbience,
  isIndoorTile,
  planCity,
  planHouses,
} from "./engine";
import { MAX_TRIP } from "./engine/lan";
import { landmarkCrown, landmarksFor, placeLandmarks } from "./render/landmarks";
import { neonLayout } from "./render/neon";
import { fitCamera, type MakeLayer, type SpriteBank } from "./render";
import { sx as toSx, sy as toSy } from "./render/paint";
import { SKY } from "./render/ambience";
import { CITY } from "./render/city";
import { recorder, type RecordingTarget } from "./render/testRecorder";
import { SEAT_LIFT, TILE, type DrawItem, type LanEvent, type VillageAgent, type WeatherWire } from "./villageTypes";
import {
  activityText,
  agoText,
  citySummary,
  consoleActivityText,
  countAgents,
  planSignature,
  skySummary,
  VillageView,
  villageSummary,
} from "./villageView";

function agent(key: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: `t-${key}`,
    folder: "gazelle",
    activity: "typing",
    tool: "Edit",
    ideAgentId: key,
    lastActivityAt: 1,
    ...extra,
  };
}

/** A view showing `agents` in their own world, fitted to an 800×600 CSS box at `dpr`. */
function viewWith(agents: VillageAgent[], dpr = 1): VillageView {
  const v = new VillageView();
  v.resize(800, 600, dpr);
  v.setWorld(buildWorld(planHouses(agents)));
  v.setAgents(agents);
  return v;
}

describe("VillageView", () => {
  it("starts on the empty village with an unfitted camera and an empty view", () => {
    const v = new VillageView();
    expect(v.world.houses).toEqual([]);
    expect(v.camera).toEqual({ zoom: 1, ox: 0, oy: 0 });
    expect(v.view).toEqual({ w: 0, h: 0 });
    // A zero-size view never fits (nothing to fit into).
    v.resize(0, 0, 1);
    expect(v.camera).toEqual({ zoom: 1, ox: 0, oy: 0 });
  });

  it("sizes the backing store in device px and fits on the first measurable view", () => {
    const v = new VillageView();
    expect(v.resize(400, 300, 2)).toEqual({ w: 800, h: 600 });
    const worldW = v.world.cols * TILE;
    const { zoom, ox } = v.camera;
    expect(zoom).toBeGreaterThanOrEqual(1);
    expect(ox).toBe(Math.round((800 - worldW * zoom) / 2));
    // A nonsense DPR falls back to 1.
    expect(v.resize(10, 10, 0)).toEqual({ w: 10, h: 10 });
  });

  it("refits when the world grows, but keeps the user's camera otherwise", () => {
    const v = new VillageView();
    v.resize(800, 600, 1);
    v.pan(5, 7);
    const panned = v.camera;
    // Same world size (resize again) → no refit.
    v.resize(800, 600, 1);
    expect(v.camera).toEqual(panned);
    v.setWorld(buildWorld([]));
    expect(v.camera).toEqual(panned);
    // Many houses → a bigger world → refit.
    const many = Array.from({ length: 9 }, (_, i) => agent(`a${i}`, { folder: `f${i}` }));
    v.setWorld(buildWorld(planHouses(many)));
    expect(v.camera).not.toEqual(panned);
  });

  it("pans in device px", () => {
    const v = new VillageView();
    v.resize(100, 100, 2);
    const before = v.camera;
    v.pan(3, -4);
    expect(v.camera).toEqual({ zoom: before.zoom, ox: before.ox + 6, oy: before.oy - 8 });
  });

  it("zooms in integer steps, anchored at the cursor or the centre, and stops at the limits", () => {
    const v = new VillageView();
    // A stage exactly the empty village's size: it fits at 1 (a smaller one fits below 1 now).
    v.resize(v.world.cols * TILE, v.world.rows * TILE, 1);
    v.fit();
    const c0 = v.camera;
    expect(c0.zoom).toBe(1);
    // The world point under the anchor stays put.
    const anchor = { x: 37, y: 21 };
    const wx = (anchor.x - c0.ox) / c0.zoom;
    expect(v.zoomBy(1, anchor)).toBe(true);
    expect(v.camera.zoom).toBe(c0.zoom + 1);
    expect(Math.abs(v.camera.ox + wx * v.camera.zoom - anchor.x)).toBeLessThanOrEqual(0.5);
    // Default anchor: the view centre.
    const c1 = v.camera;
    const cx = (v.world.cols * TILE) / 2;
    const cwx = (cx - c1.ox) / c1.zoom;
    expect(v.zoomBy(-1)).toBe(true);
    expect(Math.abs(v.camera.ox + cwx * v.camera.zoom - cx)).toBeLessThanOrEqual(0.5);
    // Limits.
    for (let i = 0; i < 10; i++) v.zoomBy(-1);
    expect(v.camera.zoom).toBe(1);
    expect(v.zoomBy(-1)).toBe(false);
    for (let i = 0; i < 10; i++) v.zoomBy(1);
    expect(v.camera.zoom).toBe(8);
    expect(v.zoomBy(1)).toBe(false);
  });

  describe("Fit shows a city too big for zoom 1 — whole (a standard-DPI 1200×700 pane)", () => {
    const sub = (parent: string, n: number) =>
      Array.from({ length: n }, (_, i) => agent(`${parent}.s${i}`, { parentKey: parent }));
    /** A city view of `agents`, fitted to a 1200×700 CSS pane at dpr 1. */
    function cityOf(agents: VillageAgent[]): VillageView {
      const v = new VillageView(1, () => null, "city");
      v.setWorld(buildCityWorld(planCity(agents).plans));
      v.resize(1200, 700, 1);
      return v;
    }
    /** Buildings, signs and the street are in view; empty ground either side may be cropped. */
    function showsAll(v: VillageView): void {
      const { zoom, ox, oy } = v.camera;
      const t = v.fitTarget();
      expect(ox + t.x * zoom).toBeGreaterThanOrEqual(0);
      expect(oy + t.y * zoom).toBeGreaterThanOrEqual(0);
      expect(ox + (t.x + t.w) * zoom).toBeLessThanOrEqual(v.view.w);
      expect(oy + (t.y + t.h) * zoom).toBeLessThanOrEqual(v.view.h);
      for (const b of v.world.city!.buildings) {
        expect(ox + b.col * TILE * zoom).toBeGreaterThanOrEqual(0);
        expect(ox + (b.col + b.w) * TILE * zoom).toBeLessThanOrEqual(v.view.w);
        expect(oy + (b.row - 1) * TILE * zoom).toBeGreaterThanOrEqual(0);
      }
    }

    it("a 12-floor building: its roof sign and its street both on screen", () => {
      const v = cityOf(Array.from({ length: 12 }, (_, i) => agent(`f${i}`)));
      expect(v.world.rows * TILE).toBeGreaterThan(700); // zoom 1 would crop it
      // The largest whole sixteenth that shows it (a tile on 10 px), not a halving.
      expect(v.camera.zoom).toBe(10 / 16);
      showsAll(v);
    });

    it("eight buildings with full teams: the first and the last both on screen", () => {
      const v = cityOf(Array.from({ length: 8 }, (_, i) => [agent(`r${i}`, { folder: `p${i}` }), ...sub(`r${i}`, 8)]).flat());
      expect(v.world.city!.buildings).toHaveLength(8);
      expect(v.world.cols * TILE).toBeGreaterThan(1200);
      expect(v.camera.zoom).toBeLessThan(1);
      showsAll(v);
    });

    it("zooming out stops at the zoom that shows it all; in, it climbs back through 1 to whole steps", () => {
      const v = cityOf(Array.from({ length: 12 }, (_, i) => agent(`f${i}`)));
      expect(v.zoomBy(-1)).toBe(false); // already showing everything
      expect(v.zoomBy(1)).toBe(true);
      expect(v.camera.zoom).toBe(0.75); // the ¾ rung, then 1
      expect(v.zoomBy(1)).toBe(true);
      expect(v.camera.zoom).toBe(1);
      expect(v.zoomBy(1)).toBe(true);
      expect(v.camera.zoom).toBe(2);
      expect(v.zoomBy(-5)).toBe(true);
      expect(v.camera.zoom).toBe(10 / 16); // back down to the fit, the floor
      // A world that fits at 1 keeps 1 as the floor (no pointless overview of a small city).
      const small = cityOf([agent("a")]);
      for (let i = 0; i < 5; i++) small.zoomBy(-1);
      expect(small.camera.zoom).toBe(1);
      // The VILLAGE stops at ½: a village too big for its pane even at ½ crops there (at
      // 1 it hid the capacity houses), and zooming out goes no further.
      const village = new VillageView();
      village.setWorld(buildWorld(planHouses(Array.from({ length: 30 }, (_, i) => agent(`v${i}`, { folder: `f${i}` })))));
      village.resize(300, 200, 1);
      expect(village.world.cols * TILE * 0.5).toBeGreaterThan(300);
      expect(village.camera.zoom).toBe(0.5);
      expect(village.zoomBy(-1)).toBe(false);
      // Before the stage has a size, the floor is 1 too.
      const unsized = new VillageView(1, () => null, "city");
      unsized.zoomBy(3);
      expect(unsized.zoomBy(-5)).toBe(true);
      expect(unsized.camera.zoom).toBe(1);
    });
  });

  it("picks the character under a CSS-px pointer, honouring the DPR", () => {
    const a = agent("a");
    for (const dpr of [1, 2]) {
      const v = viewWith([a], dpr);
      const c = v.sim.characters()[0];
      const cam = v.camera;
      // A point inside the sprite box (feet at bottom-centre, 32 px tall; a sitter's raised).
      const feet = c.y - (c.seated ? SEAT_LIFT : 0);
      const sx = (cam.ox + c.x * cam.zoom) / dpr;
      const sy = (cam.oy + (feet - 8) * cam.zoom) / dpr;
      expect(v.pick(sx, sy)).toBe("a");
      expect(v.pick(-1000, -1000)).toBeNull();
    }
  });

  it("frames: ticks the sim, paints only with a context, and a pause resets the clock", () => {
    const v = viewWith([agent("a")]);
    v.frame(1000, null);
    expect(v.sim.time).toBe(0); // the first frame has no previous one → dt 0
    v.frame(1050, null);
    expect(v.sim.time).toBeCloseTo(0.05);
    v.pause();
    v.frame(99_000, null);
    expect(v.sim.time).toBeCloseTo(0.05); // not a 98 s jump

    const ctx = recorder();
    v.setBank(null);
    v.frame(99_016, ctx);
    expect(ctx.calls.length).toBeGreaterThan(0);
    expect(ctx.of("clearRect").length + ctx.of("fillRect").length).toBeGreaterThan(0);
  });

  /** A view with an injected ground canvas (a recorder), settled so spawn effects are over. */
  function settled(agents: VillageAgent[], world = buildWorld(planHouses([agent("a")]))) {
    const layers: RecordingTarget[] = [];
    const make = vi.fn<MakeLayer>(() => {
      const ctx = recorder();
      layers.push(ctx);
      return { image: { layer: layers.length } as unknown as CanvasImageSource, ctx };
    });
    const v = new VillageView(1, make);
    v.resize(800, 600, 1);
    v.setWorld(world);
    v.setAgents(agents);
    for (let t = 0; t <= 3000; t += 100) v.frame(t, null);
    return { v, make, layers };
  }

  it("paints each character through the real wiring (sim → draw list → canvas)", () => {
    const world = buildWorld(planHouses([agent("a")]));
    const { v } = settled([agent("a")], world);
    const ctx = recorder();
    v.frame(3016, ctx);
    const [c] = v.sim.characters();
    const cam = v.camera;
    // A null bank paints the character as its fallback body block at its feet.
    const bodyAt = (r: RecordingTarget) =>
      r
        .of("fillRect")
        .filter(
          (f) =>
            f.args[0] === toSx(cam, Math.round(c.x) - 4) &&
            f.args[1] === toSy(cam, Math.round(c.y) - 18 - (c.seated ? SEAT_LIFT : 0)) &&
            f.args[2] === 8 * cam.zoom &&
            f.args[3] === 16 * cam.zoom,
        );
    expect(bodyAt(ctx)).toHaveLength(1);
    // …and its name label is on the canvas.
    expect(ctx.of("fillText").map((t) => t.args[0])).toContain("t-a");

    // The same world with nobody in it has no such block.
    const empty = settled([], world).v;
    const none = recorder();
    empty.frame(3016, none);
    expect(empty.camera).toEqual(cam);
    expect(bodyAt(none)).toHaveLength(0);
    expect(none.of("fillText").map((t) => t.args[0])).not.toContain("t-a");
  });

  it("always labels the hovered character, even one the crowd's label layout dropped", () => {
    // Ten sub-agents of an unknown parent crowd round the plaza (seated ones each get room).
    const agents = [agent("a"), ...Array.from({ length: 10 }, (_, i) => agent(`s${i}`, { parentKey: "ghost" }))];
    const v = viewWith(agents);
    const drawn = (): string[] => {
      const ctx = recorder();
      v.frame(1000, ctx);
      return ctx.of("fillText").map((t) => t.args[0] as string);
    };
    const before = drawn();
    const dropped = agents.find((a) => !before.includes(a.title));
    expect(dropped).toBeDefined(); // ten sub-agents in a huddle: not every tag fits
    v.setHovered(dropped!.key);
    expect(drawn()).toContain(dropped!.title);
    v.setHovered(null);
    expect(drawn()).not.toContain(dropped!.title);
  });

  it("draws labels at the device pixel ratio", () => {
    const ctx = recorder();
    const v = viewWith([agent("a")], 2);
    v.frame(1000, ctx);
    const size = Number(/^(\d+)px/.exec(ctx.of("fillText").find((t) => t.args[0] === "t-a")!.font)![1]);
    expect(size % 2).toBe(0);
    expect(size).toBeGreaterThanOrEqual(20);
  });

  it("paints the ground once per world and art bank, then blits it each frame", () => {
    const { v, make, layers } = settled([agent("a")]);
    const frame = (t: number): RecordingTarget => {
      const ctx = recorder();
      v.frame(t, ctx);
      return ctx;
    };
    const first = frame(4000);
    const second = frame(4016);
    expect(make).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledWith(v.world.cols * TILE, v.world.rows * TILE);
    expect(layers[0].of("fillRect").length).toBeGreaterThan(100); // the grass, once
    // Each frame: ONE drawImage of the layer, scaled to the zoom — not the tile fills.
    const blit = second.of("drawImage");
    expect(blit[0].args.slice(0, 1)).toEqual([{ layer: 1 }]);
    expect(blit[0].args.slice(7)).toEqual([v.world.cols * TILE * v.camera.zoom, v.world.rows * TILE * v.camera.zoom]);
    expect(second.of("fillRect").length).toBeLessThan(layers[0].of("fillRect").length);
    expect(first.of("drawImage")).toHaveLength(1);

    // A new bank (art loaded) repaints it; a new world too.
    const bank: SpriteBank = { fallback: true, character: () => null, floor: () => null, wall: () => null, furniture: () => null };
    v.setBank(bank);
    frame(4032); // a fallback bank is the same "no art" as null → no repaint
    expect(make).toHaveBeenCalledTimes(1);
    const art: SpriteBank = { ...bank, fallback: false };
    v.setBank(art);
    frame(4048);
    expect(make).toHaveBeenCalledTimes(2);
    v.setWorld(buildWorld(planHouses([agent("a"), agent("b", { folder: "other" })])));
    frame(4064);
    frame(4080);
    expect(make).toHaveBeenCalledTimes(3);
  });

  it("without a canvas for the ground it paints the tiles, and does not retry every frame", () => {
    const make = vi.fn<MakeLayer>(() => null);
    const v = new VillageView(1, make);
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("a")])));
    const ctx = recorder();
    v.frame(0, ctx);
    v.frame(16, recorder());
    expect(make).toHaveBeenCalledTimes(1);
    expect(ctx.of("drawImage")).toHaveLength(0);
    expect(ctx.of("fillRect").length).toBeGreaterThan(100);
  });
});

/** The whole village, in world px — what `visibleWorldRect` returns when it is all on screen. */
const wholeWorld = (v: VillageView) => ({ x: 0, y: 0, w: v.world.cols * TILE, h: v.world.rows * TILE });

describe("VillageView — the camera follows the stage until the user moves it (the blank-village bug)", () => {
  // A fresh split hands its new pane a sliver first: the camera fitted to that must re-fit when the
  // stage grows, or the village sits top-left at zoom 1, behind the HUD.
  it("re-fits when the stage grows after a tiny first measure", () => {
    const v = new VillageView();
    v.resize(2, 2, 2);
    v.resize(800, 600, 2);
    expect(v.visibleWorldRect()).toEqual(wholeWorld(v));
    const { zoom, ox, oy } = v.camera;
    expect(zoom).toBe(Math.floor(Math.min(1600 / (v.world.cols * TILE), 1200 / (v.world.rows * TILE))));
    expect(ox).toBe(Math.round((1600 - v.world.cols * TILE * zoom) / 2));
    expect(oy).toBe(Math.round((1200 - v.world.rows * TILE * zoom) / 2));
  });

  it("a Fit pressed while the stage is hidden (0×0) does not pin the camera to nothing", () => {
    const v = new VillageView();
    v.fit();
    expect(v.camera).toEqual({ zoom: 1, ox: 0, oy: 0 });
    v.resize(800, 600, 2);
    expect(v.visibleWorldRect()).toEqual(wholeWorld(v));
  });

  it("re-fits a world that SHRINKS while the camera is untouched", () => {
    const v = new VillageView();
    v.resize(800, 600, 2);
    v.setWorld(buildWorld(planHouses(Array.from({ length: 30 }, (_, i) => agent(`a${i}`, { folder: `f${i}` })))));
    v.setWorld(buildWorld(planHouses([agent("a")])));
    expect(v.visibleWorldRect()).toEqual(wholeWorld(v));
    expect(v.camera).toEqual(fitCamera(v.world.cols * TILE, v.world.rows * TILE, 1600, 1200));
  });

  it("keeps the user's camera through resizes and world changes once they pan or zoom", () => {
    const v = new VillageView();
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("a"), agent("b", { folder: "other" })])));
    v.zoomBy(2);
    const zoomed = v.camera;
    v.resize(900, 650, 1);
    expect(v.camera).toEqual(zoomed); // a zoom alone takes the camera over…
    v.pan(-30, 12);
    const mine = v.camera;
    v.resize(800, 600, 1);
    expect(v.camera).toEqual(mine); // …and so does a pan
    v.setWorld(buildWorld(planHouses([agent("a")]))); // smaller, but still on screen
    expect(v.camera).toEqual(mine);
    // Fit hands the camera back to the stage: the next resize follows it again (a press
    // without a move — a zero pan — is not a pan).
    v.fit();
    v.pan(0, 0);
    v.resize(400, 300, 1);
    expect(v.camera).toEqual(fitCamera(v.world.cols * TILE, v.world.rows * TILE, 400, 300, 0.5));
    // A zoom at the limit moves nothing, so the camera still follows.
    for (let i = 0; i < 10; i++) v.zoomBy(-1);
    v.fit();
    expect(v.zoomBy(-1)).toBe(false);
    v.resize(500, 300, 1);
    expect(v.camera).toEqual(fitCamera(v.world.cols * TILE, v.world.rows * TILE, 500, 300, 0.5));
  });

  it("still re-fits a world that grows TALLER (same width) under the user's camera", () => {
    const v = new VillageView();
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("r")])));
    v.pan(4, 4);
    const cols = v.world.cols;
    const subs = Array.from({ length: 9 }, (_, i) => agent(`s${i}`, { parentKey: "r" }));
    v.setWorld(buildWorld(planHouses([agent("r"), ...subs])));
    expect(v.world.cols).toBe(cols); // only the house got taller
    // Too tall for 1, whole at 15/16: the village may go as low as ¾ to be seen whole.
    expect(v.camera).toEqual(fitCamera(cols * TILE, v.world.rows * TILE, 800, 600, 0.75));
    expect(v.camera.zoom).toBe(15 / 16);
  });

  it("re-fits a world that would leave the user's camera showing none of it, either way off", () => {
    const tall = [agent("r"), ...Array.from({ length: 60 }, (_, i) => agent(`s${i}`, { parentKey: "r" }))];
    for (const [dx, dy] of [
      [0, -100_000], // looking far below the village
      [-100_000, 0], // …or far to its right
    ]) {
      const v = new VillageView();
      v.resize(800, 600, 1);
      v.setWorld(buildWorld(planHouses(tall)));
      v.zoomBy(3);
      v.pan(dx, dy);
      const seen = v.visibleWorldRect();
      expect(seen.w * seen.h).toBe(0);
      v.setWorld(buildWorld(planHouses([agent("r")])));
      expect(v.visibleWorldRect()).toEqual(wholeWorld(v));
    }
  });
});

describe("VillageView — sky", () => {
  const rain: WeatherWire = {
    kind: "rain",
    intensity: 0.7,
    temperatureC: 18,
    wind: 0.3,
    sunriseMs: null,
    sunsetMs: null,
    place: "Tokyo",
    fetchedAtMs: 0,
  };
  const afternoon = new Date(2026, 9, 14, 15, 0, 0);
  const rainyAfternoon = computeAmbience(afternoon, rain, { weather: "auto", phase: "auto" });

  it("draws no sky until an ambience arrives", () => {
    const v = viewWith([agent("a")]);
    expect(v.ambience).toBeNull();
    const ctx = recorder();
    v.frame(0, ctx);
    v.frame(16, ctx);
    expect(ctx.of("clip")).toHaveLength(0);
  });

  it("hands the ambience to the sim and paints the sky clipped around the houses", () => {
    const v = viewWith([agent("a")]);
    const set = vi.spyOn(v.sim, "setAmbience");
    v.setAmbience(rainyAfternoon);
    expect(set).toHaveBeenCalledWith(rainyAfternoon);
    expect(v.ambience).toBe(rainyAfternoon);
    for (let t = 0; t <= 2000; t += 50) v.frame(t, null); // let the rain fill the view
    const ctx = recorder();
    v.frame(2016, ctx);
    // The outdoor mask (evenodd clip with the interiors cut out), then the streaks.
    expect(ctx.of("clip").length).toBeGreaterThan(0);
    expect(ctx.of("fillRect").some((c) => c.fillStyle === SKY.rain)).toBe(true);
  });

  it("rains only outdoors and only over the visible village", () => {
    const v = viewWith([agent("a")]);
    v.setAmbience(rainyAfternoon);
    for (let t = 0; t <= 3000; t += 50) v.frame(t, null);
    const drops = (v as unknown as { fx: { particles(): { x: number; y: number }[] } }).fx.particles();
    expect(drops.length).toBeGreaterThan(0);
    const { cols, rows } = v.world;
    for (const p of drops) {
      expect(isIndoorTile(v.world, Math.floor(p.x / TILE), Math.floor(p.y / TILE))).toBe(false);
      // Wind spawns drops a little upwind, so they slant INTO the view; never far off it.
      expect(p.x).toBeGreaterThanOrEqual(-4 * TILE);
      expect(p.x).toBeLessThanOrEqual((cols + 4) * TILE);
      expect(p.y).toBeLessThanOrEqual((rows + 1) * TILE);
    }
  });

  it("the visible rect is the camera's view clipped to the village", () => {
    const v = new VillageView();
    expect(v.visibleWorldRect()).toEqual({ x: 0, y: 0, w: 0, h: 0 }); // no view yet
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("a")])));
    const { cols, rows } = v.world;
    // Fitted: the whole village is on screen, and nothing outside it counts.
    expect(v.visibleWorldRect()).toEqual({ x: 0, y: 0, w: cols * TILE, h: rows * TILE });
    v.zoomBy(3);
    const r = v.visibleWorldRect();
    expect(r.w).toBeLessThan(cols * TILE);
    expect(r.x).toBeGreaterThan(0);
    v.pan(100_000, 0); // the village dragged off screen to the right
    expect(v.visibleWorldRect().w).toBe(0);
  });
});

describe("HUD helpers", () => {
  it("counts by origin and activity", () => {
    const agents = [
      agent("a", { activity: "typing" }),
      agent("b", { activity: "idle" }),
      agent("c", { origin: "external", activity: "waiting", ideAgentId: null }),
      agent("d", { origin: "external", activity: "done", ideAgentId: null }),
      agent("e", { activity: "reading" }),
      agent("f", { activity: "thinking" }),
      agent("g", { activity: "error" }),
    ];
    const c = countAgents(agents);
    expect(c).toEqual({ ide: 5, outside: 2, active: 4 });
    expect(villageSummary(c)).toBe("Agent Village: 5 in the IDE, 2 outside the IDE, 4 active");
    expect(countAgents([])).toEqual({ ide: 0, outside: 0, active: 0 });
  });

  it("words the sky for the accessible name", () => {
    expect(skySummary("rain", "afternoon")).toBe("Raining · afternoon");
    expect(skySummary("clear", "night")).toBe("Clear · night");
    expect(skySummary("storm", "dusk")).toBe("Stormy · dusk");
    expect(skySummary("snow", "morning")).toBe("Snowing · morning");
    expect(skySummary("fog", "dawn")).toBe("Foggy · dawn");
    expect(skySummary("drizzle", "noon")).toBe("Drizzling · noon");
    expect(skySummary("cloudy", "evening")).toBe("Cloudy · evening");
    expect(skySummary(null, "afternoon")).toBe("Afternoon");
    const c = { ide: 1, outside: 2, active: 1 };
    expect(villageSummary(c, { weather: "rain", phase: "afternoon" })).toBe(
      "Agent Village: 1 in the IDE, 2 outside the IDE, 1 active — Raining · afternoon",
    );
  });

  it("signs a plan by value", () => {
    const p = planHouses([agent("a")]);
    expect(planSignature(p)).toBe(planSignature(planHouses([agent("b")])));
    expect(planSignature(p)).not.toBe(planSignature(planHouses([agent("a", { folder: "x" })])));
  });

  it("words an activity, with its tool when known", () => {
    expect(activityText("typing", "Edit")).toBe("Typing · Edit");
    expect(activityText("waiting", null)).toBe("Waiting for you");
    expect(["reading", "thinking", "idle", "done", "error"].map((a) => activityText(a as never, null))).toEqual([
      "Reading",
      "Thinking",
      "Idle",
      "Done",
      "Error",
    ]);
  });

  it("says how long ago", () => {
    const now = 10_000_000;
    expect(agoText(now - 5_000, now)).toBe("just now");
    expect(agoText(now + 5_000, now)).toBe("just now");
    expect(agoText(now - 42_000, now)).toBe("42s ago");
    expect(agoText(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(agoText(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(agoText(now - 4 * 86_400_000, now)).toBe("4 d ago");
  });
});

describe("VillageView — the city", () => {
  const roster = planCity([
    agent("lead", { activity: "idle" }),
    agent("s0", { parentKey: "lead" }),
    agent("term:1", { ideAgentId: null, consoleId: "1", activity: "typing" }),
  ]);
  const rain: WeatherWire = {
    kind: "rain",
    intensity: 0.9,
    temperatureC: 12,
    wind: 0,
    sunriseMs: null,
    sunsetMs: null,
    place: "Tokyo",
    fetchedAtMs: 0,
  };

  function cityView(): VillageView {
    const v = new VillageView(1, () => null, "city");
    v.resize(800, 600, 1);
    v.setWorld(buildCityWorld(roster.plans));
    v.setAgents(roster.agents);
    return v;
  }

  it("paints Tokyo's backdrop in a Tokyo city — and the haze alone anywhere else", () => {
    const v = cityView();
    towers.paint.mockClear();
    v.setAmbience(computeAmbience(new Date(2026, 9, 15, 15, 0), null, { weather: "clear", phase: "auto" }, "Europe/Madrid"));
    v.frame(0, recorder());
    expect(towers.paint).not.toHaveBeenCalled();
    v.setAmbience(computeAmbience(new Date(2026, 9, 15, 15, 0), null, { weather: "clear", phase: "auto" }, "Asia/Tokyo"));
    v.frame(16, recorder());
    expect(towers.paint).toHaveBeenCalledTimes(1);
  });

  it("starts on an empty street, and its leaders keep their desks (nobody wanders a floor)", () => {
    const empty = new VillageView(1, () => null, "city");
    expect(empty.scene).toBe("city");
    expect(empty.world.city?.buildings).toEqual([]);
    expect(new VillageView().scene).toBe("village");
    const v = cityView();
    for (let t = 0; t <= 90_000; t += 100) v.frame(t, null);
    expect(v.sim.characters().every((c) => c.seated)).toBe(true);
  });

  it("rains across the whole view — the sky has no edge — but splashes only on the street and the roofs", () => {
    const v = cityView();
    v.zoomBy(-5); // zoom 1: the view is wider than the world
    v.setAmbience(computeAmbience(new Date(2026, 9, 15, 15, 0), rain, { weather: "auto", phase: "auto" }));
    for (let t = 0; t <= 4000; t += 50) v.frame(t, null);
    const ps = (v as unknown as { fx: { particles(): { kind: string; x: number; y: number }[] } }).fx.particles();
    const { street, buildings } = v.world.city!;
    expect(ps.some((p) => p.kind === "rain" && (p.x < 0 || p.x > v.world.cols * TILE))).toBe(true);
    const roofs = buildings.map((b) => b.row * TILE);
    for (const p of ps.filter((q) => q.kind === "splash")) {
      const onStreet = p.y >= street * TILE && p.y < (street + 4) * TILE;
      expect(onStreet || roofs.some((y) => p.y >= y && p.y < y + TILE)).toBe(true);
    }
    expect(ps.some((p) => p.kind === "splash")).toBe(true);
    // …and never inside a building.
    for (const p of ps) expect(isIndoorTile(v.world, Math.floor(p.x / TILE), Math.floor(p.y / TILE))).toBe(false);
  });

  it("paints the city's sky under its world", () => {
    const v = cityView();
    const ctx = recorder();
    v.frame(0, ctx);
    expect(ctx.of("fillRect")[0].fillStyle).toBe(CITY.sky[0]);
  });

  it("goes back to the village's weather rules for a village world", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("a")])));
    v.setAmbience(computeAmbience(new Date(2026, 9, 15, 15, 0), rain, { weather: "auto", phase: "auto" }));
    for (let t = 0; t <= 2000; t += 50) v.frame(t, null);
    const ps = (v as unknown as { fx: { particles(): { x: number }[] } }).fx.particles();
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.x).toBeGreaterThanOrEqual(-4 * TILE);
  });
});

describe("HUD helpers — the city", () => {
  it("words the city for the canvas's accessible name, singular where it is one", () => {
    const c = { ide: 2, outside: 1, active: 2 };
    expect(citySummary({ buildings: 3, floors: 5, consoles: 2 }, c, { weather: "rain", phase: "night" })).toBe(
      "Agent City: 3 buildings, 5 floors (2 consoles); 2 agents in the IDE, 1 outside the IDE, 2 active — Raining · night",
    );
    expect(citySummary({ buildings: 1, floors: 1, consoles: 1 }, c, { weather: null, phase: "noon" })).toBe(
      "Agent City: 1 building, 1 floor (1 console); 2 agents in the IDE, 1 outside the IDE, 2 active — Noon",
    );
  });

  it("words a console's activity like a shell", () => {
    expect(consoleActivityText("typing")).toBe("Running a command");
    expect(consoleActivityText("thinking")).toBe("Running claude");
    expect(consoleActivityText("idle")).toBe("At the prompt");
  });

  it("signs a city plan by value too", () => {
    const a = planCity([agent("a")]).plans;
    expect(planSignature(a)).toBe(planSignature(planCity([agent("a")]).plans));
    expect(planSignature(a)).not.toBe(planSignature(planCity([agent("a"), agent("b")]).plans));
  });
});

describe("VillageView — capacity", () => {
  const GB = 1024 ** 3;
  const machine = {
    logicalCpus: 6,
    totalMemBytes: 16 * GB,
    availableMemBytes: 8 * GB,
    agents: { sessions: 1, claudeProcesses: 1, claudeRssBytes: GB, toolProcesses: 0, toolRssBytes: 0 },
    sampledAtMs: 0,
  };
  const input = (agents: VillageAgent[]) => ({
    machine,
    machineError: null,
    agents,
    includesOutside: true,
    usage: null,
    usageError: null,
    context: {},
    nowMs: 0,
  });

  it("computes the capacity frame from its inputs: both views have the Seats hall; only the City has the lounge, which keeps its holders in place between calls", () => {
    const v = new VillageView();
    expect(v.capacityFrame).toBeNull();
    v.setCapacity(input([agent("a"), agent("b")]));
    // The Village: no desk for anyone, no lounge board, and a hall with no reading (nothing selected).
    expect(v.capacityFrame!.desks).toEqual([]);
    expect(v.capacityFrame!.hall).toEqual({ cells: null, usedPct: null, tone: "unknown" });
    expect([v.capacityFrame!.captions.seats, v.capacityFrame!.captions.lounge]).toEqual(["Seats ?", ""]);
    // The City: the same hall (nothing selected), and the lounge — a bench per holder of its 64, kept between calls.
    const city = new VillageView(1, () => null, "city");
    city.setCapacity({ ...input([agent("a"), agent("b")]), lounge: true });
    expect(city.capacityFrame!.desks.slice(0, 3).map((d) => d?.key ?? null)).toEqual(["a", "b", null]);
    expect(city.capacityFrame!.desks).toHaveLength(64);
    expect(city.capacityFrame!.hall).toEqual({ cells: null, usedPct: null, tone: "unknown" });
    expect([city.capacityFrame!.captions.seats, city.capacityFrame!.captions.lounge]).toEqual(["Seats ?", "Lounge 2/64"]);
    city.setCapacity({ ...input([agent("b"), agent("c")]), lounge: true });
    expect(city.capacityFrame!.desks.slice(0, 3).map((d) => d?.key ?? null)).toEqual(["c", "b", null]);
  });

  it("hands the draw list the frame with its hall — the selected agent's context window, seat by seat — and no LAN desks", () => {
    const v = new VillageView(1, () => null);
    v.resize(800, 600, 1);
    const live = [agent("a"), agent("s", { parentKey: "a" })];
    v.setWorld(buildWorld(planHouses(live), { seats: 4 }));
    v.setAgents(live);
    // a's context: 10% messages (20 seats), 80% free (160), 10% autocompact buffer (20) of a 1,000-token window.
    const data = {
      model: "m",
      usedTokens: 100,
      windowTokens: 1000,
      usedPercent: 10,
      categories: [
        { key: "messages", label: "Messages", tokens: 100, percent: 10 },
        { key: "free-space", label: "Free space", tokens: 800, percent: 80 },
        { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 100, percent: 10 },
      ],
      measuredAtMs: 0,
    };
    v.setCapacity({ ...input(live), context: { a: { data, error: null, loading: false } }, hallAgent: { kind: "ready", agentId: "a", label: "a" } });
    const draw = vi.mocked(buildDrawList);
    draw.mockClear();
    v.frame(0, recorder());
    const cap = draw.mock.lastCall![5]!;
    expect(Object.keys(cap).sort()).toEqual(["claims", "frame", "seatOf"]);
    expect(cap.frame).toBe(v.capacityFrame);
    expect(cap.frame.desks).toEqual([]);
    const hall = cap.frame.hall!;
    expect([hall.usedPct, hall.tone, hall.cells!.length]).toEqual([10, "ok", 200]);
    expect(hall.cells!.slice(0, 20).every((c) => c === "messages")).toBe(true);
    expect(hall.cells!.slice(20, 180).every((c) => c === "free-space")).toBe(true);
    expect(hall.cells!.slice(180).every((c) => c === "autocompact-buffer")).toBe(true);
    // The hall prop the draw list emits carries that very hall.
    const items = draw.mock.results[draw.mock.results.length - 1].value as DrawItem[];
    const prop = items.find((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop" && i.prop.kind === "hall")!;
    expect(prop.reading).toEqual({ kind: "hall", hall });
    expect((prop.reading as { hall: unknown }).hall).toBe(hall);
    // s finishing changes no seat in the Village: there are none to free.
    v.setCapacity({ ...input([agent("a"), agent("s", { parentKey: "a", activity: "done" })]), context: { a: { data, error: null, loading: false } }, hallAgent: { kind: "ready", agentId: "a", label: "a" } });
    expect(v.capacityFrame!.desks).toEqual([]);
    expect(v.capacityFrame!.hall!.cells!.length).toBe(200);
  });

  it("paints the capacity buildings and the desks' context bars through the real wiring", () => {
    const v = new VillageView(1, () => null);
    v.resize(1600, 1400, 1);
    const agents = [agent("a")];
    v.setWorld(buildWorld(planHouses(agents), { seats: 4 }));
    v.setAgents(agents);
    v.setCapacity({ ...input(agents), context: { a: { data: { model: "m", usedTokens: 1, windowTokens: 2, usedPercent: 50, categories: [], measuredAtMs: 0 }, error: null, loading: false } } });
    const ctx = recorder();
    v.frame(0, ctx);
    const texts = ctx.of("fillText").map((c) => c.args[0]);
    // No agent selected for the hall: its board says so — never a count of desks.
    expect(texts).toEqual(expect.arrayContaining(["Seats ?", "Memory 1.0 GB", "Usage ? · ?", "5h ?", "week ?"]));
    expect(texts.some((t) => /^Seats \d+\/4$/.test(String(t)))).toBe(false);
    // The context bar's warn fill (50 %: amber on the context card's bands).
    expect(ctx.of("fillRect").some((c) => c.fillStyle === "#e3b341")).toBe(true);
  });

  it("picks the capacity building under the pointer: a village house with its walls, board and door spot", () => {
    const v = new VillageView();
    v.resize(4000, 4000, 2);
    v.setWorld(buildWorld([], { seats: 4 }));
    const cam = v.camera;
    const css = (col: number, row: number) => ({ x: (cam.ox + (col * TILE + 8) * cam.zoom) / 2, y: (cam.oy + (row * TILE + 8) * cam.zoom) / 2 });
    for (const h of v.world.houses) {
      const inside = css(h.col + 2, h.row + 1);
      expect(v.pickCapacity(inside.x, inside.y)).toBe(h.capacity);
      const board = css(h.col - 1, h.row - 2);
      expect(v.pickCapacity(board.x, board.y)).toBe(h.capacity);
      const door = css(h.col + h.w, h.doorRow + 1);
      expect(v.pickCapacity(door.x, door.y)).toBe(h.capacity);
      const below = css(h.doorCol, h.doorRow + 2);
      expect(v.pickCapacity(below.x, below.y)).toBeNull();
    }
    const grass = css(0, 0);
    expect(v.pickCapacity(grass.x, grass.y)).toBeNull();
  });

  it("picks a city HQ floor by its slab, wall and room — not a project's floor", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(4000, 4000, 1);
    const roster = planCity([agent("a")]);
    v.setWorld(buildCityWorld(roster.plans, { seats: 2 }));
    const cam = v.camera;
    const css = (col: number, row: number) => ({ x: cam.ox + (col * TILE + 8) * cam.zoom, y: cam.oy + (row * TILE + 8) * cam.zoom });
    for (const h of v.world.houses) {
      for (const [c, r] of [
        [h.col, h.row - 1],
        [h.col + h.w - 1, h.row + h.h - 1],
      ]) {
        const p = css(c, r);
        expect(v.pickCapacity(p.x, p.y)).toBe(h.capacity ?? null);
      }
      const outside = css(h.col - 1, h.row);
      expect(v.pickCapacity(outside.x, outside.y)).toBeNull();
    }
  });

  it("reports each capacity building's box on screen in CSS px — the same box the pointer picks", () => {
    const v = new VillageView();
    v.resize(2000, 2000, 2);
    v.setWorld(buildWorld([], { seats: 4 }));
    const boxes = v.capacityBoxes();
    expect(boxes.map((b) => b.kind)).toEqual(v.world.houses.filter((h) => h.capacity).map((h) => h.capacity));
    expect(boxes.map((b) => b.kind).sort()).toEqual(["memory", "seats", "usage"]);
    const cam = v.camera;
    for (const b of boxes) {
      const h = v.world.houses.find((x) => x.capacity === b.kind)!;
      // Walls + board + door spot, mapped through the camera and halved (DPR 2), whole CSS px.
      const x0 = (cam.ox + (h.col - 1) * TILE * cam.zoom) / 2;
      const y0 = (cam.oy + (h.row - 2) * TILE * cam.zoom) / 2;
      expect(b).toEqual({
        kind: b.kind,
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.round((cam.ox + (h.col + h.w + 1) * TILE * cam.zoom) / 2) - Math.round(x0),
        h: Math.round((cam.oy + (h.doorRow + 2) * TILE * cam.zoom) / 2) - Math.round(y0),
      });
      expect(v.pickCapacity(b.x + 1, b.y + 1)).toBe(b.kind);
      expect(v.pickCapacity(b.x + b.w - 1, b.y + b.h - 1)).toBe(b.kind);
    }
  });

  it("clips a capacity box to the canvas and leaves out a building that is off screen", () => {
    const v = new VillageView();
    v.resize(2000, 2000, 1);
    v.setWorld(buildWorld([], { seats: 4 }));
    const first = v.capacityBoxes()[0];
    // Pan so the first box's left edge is 10 px off the canvas's left side.
    v.pan(-(first.x + 10), 0);
    const clipped = v.capacityBoxes()[0];
    expect(clipped.x).toBe(0);
    expect(clipped.w).toBe(first.w - 10);
    // …and its bottom past the canvas's bottom edge.
    v.pan(0, 2000 - first.y - 5);
    const low = v.capacityBoxes()[0];
    expect(low.y + low.h).toBe(2000);
    expect(low.h).toBe(5);
    // Everything far off to the left: nothing on screen.
    v.pan(-100_000, 0);
    expect(v.capacityBoxes()).toEqual([]);
  });

  it("reports each neon sign the draw list hangs, on screen in CSS px — none for the HQ, a building with no language, or a language with no style", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(4000, 4000, 2);
    const roster = planCity([
      agent("a", { folder: "alpha", language: "rust" }),
      agent("b", { folder: "beta", language: "klingon" }),
      agent("c", { folder: "gamma" }),
    ]);
    v.setWorld(buildCityWorld(roster.plans, { seats: 64 }));
    const boxes = v.neonBoxes();
    expect(boxes.map((b) => [b.building, b.language])).toEqual([["alpha", "rust"]]);
    // The very item the draw list paints, its art's box through the camera, halved (DPR 2), whole CSS px.
    const items = buildDrawList(v.world, [], () => false, 0);
    const sign = items.find((i): i is Extract<DrawItem, { t: "neon" }> => i.t === "neon" && i.building === "alpha")!;
    const [x, y, w, h] = neonLayout(sign)!.box;
    const cam = v.camera;
    const x0 = Math.round((cam.ox + x * cam.zoom) / 2);
    const y0 = Math.round((cam.oy + y * cam.zoom) / 2);
    expect(boxes[0]).toEqual({
      building: "alpha",
      language: "rust",
      x: x0,
      y: y0,
      w: Math.round((cam.ox + (x + w) * cam.zoom) / 2) - x0,
      h: Math.round((cam.oy + (y + h) * cam.zoom) / 2) - y0,
    });
    // "klingon" is hung (it has a language) but has no style: it paints nothing, so it has no box.
    expect(items.some((i) => i.t === "neon" && i.building === "beta")).toBe(true);
    // Clipped to the canvas; off screen, left out; the village has none.
    v.pan(-(boxes[0].x + 2), 0);
    expect(v.neonBoxes()[0]).toMatchObject({ x: 0, w: boxes[0].w - 2 });
    v.pan(-100_000, 0);
    expect(v.neonBoxes()).toEqual([]);
    const village = new VillageView();
    village.resize(2000, 2000, 1);
    village.setWorld(buildWorld([], { seats: 4 }));
    expect(village.neonBoxes()).toEqual([]);
  });

  it("reports each skyline landmark's CROWN on screen in CSS px — Fuji's snow cap, the towers' tips to their lowest deck; never a temple; none outside Tokyo, before any sky, or in the village", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(1600, 1200, 2);
    v.setWorld(buildCityWorld(planCity([agent("a", { folder: "alpha" }), agent("b", { folder: "beta" })]).plans, { seats: 64 }));
    const tokyo = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "noon" }, "Asia/Tokyo");
    // No sky yet, then another city's: no landmarks.
    expect(v.landmarkBoxes()).toEqual([]);
    v.setAmbience({ ...tokyo, zone: "Europe/Paris" });
    expect(v.landmarkBoxes()).toEqual([]);
    v.setAmbience(tokyo);
    const crowns = placeLandmarks(v.world, v.world.city!.street * TILE, landmarksFor("Asia/Tokyo")).placed.filter((p) => p.spec.layer !== "near");
    /** Each crown through the camera, halved (DPR 2), whole CSS px, clipped to the 1600×1200 canvas; off it, left out. */
    const expected = () =>
      crowns.flatMap((p) => {
        const c = landmarkCrown(p);
        const cam = v.camera;
        const css = (wx: number, wy: number) => [Math.round((cam.ox + wx * cam.zoom) / 2), Math.round((cam.oy + wy * cam.zoom) / 2)];
        const [a, b] = css(c.x0, c.top);
        const [d, e] = css(c.x1, c.bottom);
        const [x0, y0, x1, y1] = [Math.max(0, a), Math.max(0, b), Math.min(1600, d), Math.min(1200, e)];
        return x1 > x0 && y1 > y0 ? [{ kind: p.spec.kind, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }] : [];
      });
    const boxes = v.landmarkBoxes();
    expect(boxes.map((b) => b.kind)).toEqual(["fuji", "skytree", "tokyo-tower"]);
    expect(boxes).toEqual(expected());
    for (const b of boxes) expect(b.w * b.h, b.kind).toBeGreaterThan(20);
    // Zoomed in on the HQ's right wall: still the crowns through the camera — they zoom with the street.
    const hq = v.world.city!.buildings.find((b) => b.hq)!;
    for (let i = 0; i < 2; i++) v.zoomBy(1, { x: (v.camera.ox + (hq.col + hq.w) * TILE * v.camera.zoom) / 2, y: 600 });
    expect(v.camera.zoom).toBeGreaterThanOrEqual(3);
    const zoomed = v.landmarkBoxes();
    expect(zoomed.length).toBeGreaterThan(0);
    expect(zoomed).toEqual(expected());
    // Clipped to the canvas; off screen, left out.
    v.fit();
    const first = v.landmarkBoxes()[0];
    v.pan(-(first.x + 3), 0);
    expect(v.landmarkBoxes()[0]).toMatchObject({ kind: first.kind, x: 0, w: first.w - 3 });
    v.pan(-100_000, 0);
    expect(v.landmarkBoxes()).toEqual([]);
    // The village has no skyline.
    const village = new VillageView();
    village.resize(2000, 2000, 1);
    village.setWorld(buildWorld([], { seats: 4 }));
    village.setAmbience(tokyo);
    expect(village.landmarkBoxes()).toEqual([]);
  });

  it("frames the tallest landmark's tip at Fit (a tile over it), and refits a following camera when the zone brings a skyline", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(3200, 900, 1); // a short, wide pane: the roof rule alone cut the Skytree's tip off
    const roster = planCity([agent("a", { folder: "alpha" }), agent("b", { folder: "beta" })]);
    v.setWorld(buildCityWorld(roster.plans, { seats: 64 }));
    const roofTop = Math.min(...v.world.city!.buildings.map((b) => b.row));
    // No skyline yet: FIT_SKY (2) rows over the tallest roof.
    expect(v.fitTarget().y).toBe((roofTop - 2) * TILE);
    const before = v.camera;
    const tokyo = computeAmbience(new Date(2026, 9, 15, 12, 0), null, { weather: "clear", phase: "noon" }, "Asia/Tokyo");
    v.setAmbience(tokyo);
    const placed = placeLandmarks(v.world, v.world.city!.street * TILE, landmarksFor("Asia/Tokyo")).placed;
    const tip = Math.min(...placed.map((p) => p.base - p.h));
    // The Skytree stands 1.5× the tallest roof — the HQ's
    // 176 px — and the world keeps only 4 sky rows over that roof: its tip is above the world's top (row 0)…
    expect(tip).toBeLessThan(0);
    expect(tip).toBeLessThan((roofTop - 2) * TILE);
    // …so the frame now starts on the row a tile over it, past the world's top, and the following camera was
    // refitted to show it.
    expect(v.fitTarget().y).toBe((Math.floor(tip / TILE) - 1) * TILE);
    expect(v.fitTarget().y).toBeLessThan(0);
    expect(v.camera).not.toEqual(before);
    expect(v.camera.oy + tip * v.camera.zoom).toBeGreaterThanOrEqual(0);
    // In a HEIGHT-bound pane — exactly the frame's height, at zoom 1 — the tip is still in the view, a tile
    // under its top edge (a frame stopped at the world's top would leave it 24 px over the view).
    const tight = new VillageView(1, () => null, "city");
    tight.resize(3200, 900, 1);
    tight.setWorld(v.world);
    tight.setAmbience(tokyo);
    const frame = tight.fitTarget();
    tight.resize(3200, frame.h, 1);
    tight.fit();
    expect(3200 / frame.w).toBeGreaterThan(1); // the width to spare: the height binds
    expect(tight.camera.zoom).toBe(1);
    expect(tight.camera.oy).toBe(-frame.y);
    expect(tight.camera.oy + tip).toBeGreaterThanOrEqual(TILE);
    expect(tight.camera.oy + tip).toBeLessThan(2 * TILE);
    // The same zone again, or a camera the user moved: left alone.
    const fitted = v.camera;
    const refit = vi.spyOn(v, "fit");
    v.setAmbience({ ...tokyo, phase: "evening" });
    expect(v.camera).toEqual(fitted);
    expect(refit).not.toHaveBeenCalled(); // the sky changes every minute: not a refit each time
    refit.mockRestore();
    v.pan(10, 0);
    const moved = v.camera;
    v.setAmbience({ ...tokyo, zone: "Europe/Paris" });
    expect(v.camera).toEqual(moved);
    // Back at Fit outside Tokyo: the roof rule again.
    v.fit();
    expect(v.fitTarget().y).toBe((roofTop - 2) * TILE);
    // The roof rule alone never frames above the world's top: a roof a row under it (no city the engine builds
    // has one: it keeps 4 sky rows over the tallest) frames from row 0, not from FIT_SKY rows over it.
    const low = buildCityWorld(roster.plans, { seats: 64 });
    low.city!.buildings[0].row = 1;
    const roofs = new VillageView(1, () => null, "city");
    roofs.resize(3200, 900, 1);
    roofs.setWorld(low);
    expect(roofs.fitTarget().y).toBe(0);
    expect(roofs.fitTarget().h).toBe(low.rows * TILE);
  });

  it("reports the city HQ's two floors (slab to room), its lounge (the soil over its back wall to its last aisle) and the Seats hall under it — no project floor", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(4000, 4000, 1);
    v.setWorld(buildCityWorld(planCity([agent("a", { folder: "a" }), agent("b", { folder: "b" })]).plans, { seats: 64 }));
    const boxes = v.capacityBoxes();
    expect(boxes.map((b) => b.kind)).toEqual(["memory", "usage", "lounge", "seats"]);
    const cam = v.camera;
    for (const b of boxes) {
      const h = v.world.houses.find((x) => x.capacity === b.kind)!;
      expect(b.x).toBe(Math.round(cam.ox + h.col * TILE * cam.zoom));
      expect(b.y).toBe(Math.round(cam.oy + (h.row - 1) * TILE * cam.zoom));
      expect(b.w).toBe(Math.round(h.w * TILE * cam.zoom));
      expect(b.h).toBe(Math.round((h.h + 1) * TILE * cam.zoom));
      expect(v.pickCapacity(b.x + b.w / 2, b.y + b.h / 2)).toBe(b.kind);
    }
    // The lounge's box is under the street — from the soil row below the far sidewalk (its board) down
    // to its last aisle, its whole width — and whole on screen at Fit.
    const loungeBox = boxes[2];
    const { street } = v.world.city!;
    const lounge = v.world.houses.find((x) => x.capacity === "lounge")!;
    expect(loungeBox.y).toBe(Math.round(cam.oy + (street + 4) * TILE * cam.zoom));
    expect(loungeBox.y + loungeBox.h).toBe(Math.round(cam.oy + (lounge.row + lounge.h) * TILE * cam.zoom));
    expect(loungeBox.w).toBe(Math.round(23 * TILE * cam.zoom));
    expect(v.pickCapacity(loungeBox.x + 1, loungeBox.y + 1)).toBe("lounge");
    expect(v.pickCapacity(loungeBox.x + 1, loungeBox.y - 1)).toBeNull(); // the far sidewalk above it
    // The Seats hall's box: from the row of earth under the lounge's floor wall (its board) through its
    // top wall and its 9 rows — 11 rows — and its 13 columns, centred on the lift.
    const hallBox = boxes[3];
    const lift = v.world.city!.lounge!.lift.col;
    const earth = lounge.row + lounge.h + 1;
    expect(hallBox).toEqual({
      kind: "seats",
      x: Math.round(cam.ox + (lift - 6) * TILE * cam.zoom),
      y: Math.round(cam.oy + earth * TILE * cam.zoom),
      w: Math.round(13 * TILE * cam.zoom),
      h: Math.round(11 * TILE * cam.zoom),
    });
    expect(v.pickCapacity(hallBox.x + 1, hallBox.y + 1)).toBe("seats");
    // The lounge's floor wall, between the two boxes, answers neither.
    expect(v.pickCapacity(cam.ox + (lift + 0.5) * TILE * cam.zoom, cam.oy + (earth - 0.5) * TILE * cam.zoom)).toBeNull();
  });

  it("Fit keeps the world below the HUD's inset, in device px; with no inset it fits as before", () => {
    const v = new VillageView();
    v.resize(800, 900, 2);
    v.setWorld(buildWorld(planHouses([agent("a")])));
    const plain = v.camera;
    expect(plain).toEqual(fitCamera(v.world.cols * TILE, v.world.rows * TILE, 1600, 1800));
    v.setInset(100);
    const worldH = v.world.rows * TILE;
    const fit = fitCamera(v.world.cols * TILE, worldH, 1600, 1600);
    expect(v.camera).toEqual({ zoom: fit.zoom, ox: fit.ox, oy: fit.oy + 200 });
    expect(v.camera.oy).toBeGreaterThanOrEqual(200);
    // A resize at another DPR rescales the inset.
    v.resize(800, 900, 1);
    expect(v.camera.oy).toBeGreaterThanOrEqual(100);
    // Negative insets count as none.
    v.setInset(-5);
    expect(v.camera).toEqual(fitCamera(v.world.cols * TILE, worldH, 800, 900));
  });

  it("a world taller than the room below the HUD starts right under it, not centred behind it", () => {
    const v = new VillageView();
    v.resize(400, 300, 1);
    v.setWorld(buildWorld(planHouses(["a", "b", "c", "d", "e"].map((k) => agent(k, { folder: k })))));
    v.setInset(60);
    expect(v.camera.zoom).toBe(0.5); // too tall even at the village's floor (½)
    expect(v.world.rows * TILE * 0.5).toBeGreaterThan(240);
    expect(v.camera.oy).toBe(60);
    // The inset never takes more than half the view.
    v.setInset(1000);
    expect(v.camera.oy).toBe(150);
  });

  describe("village Fit keeps the capacity houses on screen", () => {
    /** Every capacity house, walls and name board included, lies inside the view below the inset. */
    function capacityHousesOnScreen(v: VillageView, w: number, h: number, inset: number): void {
      const cam = v.camera;
      const civic = v.world.houses.filter((x) => x.capacity);
      expect(civic.map((x) => x.capacity)).toEqual(["seats", "memory", "usage"]);
      for (const house of civic) {
        const x0 = cam.ox + (house.col - 1) * TILE * cam.zoom;
        const x1 = cam.ox + (house.col + house.w + 1) * TILE * cam.zoom;
        const y0 = cam.oy + (house.row - 2) * TILE * cam.zoom;
        const y1 = cam.oy + (house.row + house.h + 1) * TILE * cam.zoom;
        expect([house.capacity, x0 >= 0, x1 <= w, y0 >= inset, y1 <= h]).toEqual([house.capacity, true, true, true, true]);
      }
    }

    it("the E2E scene (2 projects, 14 seats, a ~720 px pane under the HUD): whole, at a sixteenth below ¾", () => {
      const v = new VillageView();
      v.resize(720, 600, 1);
      v.setInset(130);
      const agents = [agent("ide", { folder: "workspace" }), ...["o1", "o2", "o3", "o4", "o5"].map((k) => agent(k, { folder: "docs-site", origin: "external" }))];
      v.setWorld(buildWorld(planHouses(agents), { seats: 14 }));
      expect(v.world.cols * TILE).toBeGreaterThan(720);
      expect(v.camera.zoom).toBeLessThan(0.75);
      expect(v.camera.zoom).toBeGreaterThanOrEqual(0.5);
      expect((v.camera.zoom * 16) % 1).toBe(0);
      capacityHousesOnScreen(v, 720, 600, 130);
    });

    it("a village too big even at ½ crops at ½ — framed on the civic row, never cutting a capacity house", () => {
      const v = new VillageView();
      v.resize(720, 600, 1);
      v.setInset(130);
      v.setWorld(buildWorld(planHouses(Array.from({ length: 100 }, (_, i) => agent(`v${i}`, { folder: `f${i}` }))), { seats: 16 }));
      expect(v.world.rows * TILE * 0.5).toBeGreaterThan(470);
      // Top-anchored under the HUD, the civic row would start below the pane's bottom edge.
      const civicTop = Math.min(...v.world.houses.filter((x) => x.capacity).map((x) => x.row));
      expect(130 + civicTop * TILE * 0.5).toBeGreaterThan(600);
      expect(v.camera.zoom).toBe(0.5);
      capacityHousesOnScreen(v, 720, 600, 130);
      expect(v.zoomBy(-1)).toBe(false); // ½ is the village's floor
    });
  });

  it("with the capacity HQ, a city's Fit is centred on the HQ — as far either side as the farther end of what is built, plus a tile of air — so the HQ is the middle of the view", () => {
    const sub = (parent: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${parent}.s${i}`, { parentKey: parent, folder: `p-${parent}` }));
    const root = (key: string) => agent(key, { folder: `p-${key}` });
    const shapes: [string, VillageAgent[]][] = [
      ["the HQ alone", []],
      ["one project, right of the HQ", [root("a")]],
      ["one wide project (a 24-seat team), right of it", [root("a"), ...sub("a", 24)]],
      ["a small one right, a wide one left", [root("a"), root("b"), ...sub("b", 12)]],
      ["three, two right and one left", [root("a"), root("b"), root("c")]],
      ["six with teams", ["a", "b", "c", "d", "e", "f"].flatMap((k, i) => [root(k), ...sub(k, 2 * i)])],
    ];
    for (const [name, agents] of shapes) {
      const v = new VillageView(1, () => null, "city");
      v.setWorld(buildCityWorld(planCity(agents).plans, { seats: 16 }));
      const { city, cols, rows, tiles } = v.world;
      const hq = city!.buildings.find((b) => b.hq)!;
      const t = v.fitTarget();
      const mid = (hq.col + hq.w / 2) * TILE;
      // Centred on the HQ.
      expect(t.x + t.w / 2, name).toBe(mid);
      // Its farther end: a tile beyond the farthest wall of any building or of the lounge under the
      // street (its wall tiles, below the far sidewalk).
      const under: number[] = [];
      tiles.forEach((k, i) => {
        if (k === "wall" && Math.floor(i / cols) > city!.street + 3) under.push(i % cols);
      });
      expect(under.length, name).toBeGreaterThan(0);
      const left = Math.min(...city!.buildings.map((b) => b.col), ...under) * TILE;
      const right = Math.max(...city!.buildings.map((b) => b.col + b.w), ...under.map((c) => c + 1)) * TILE;
      expect(t.w / 2, name).toBe(Math.max(mid - left, right - mid) + TILE);
      // Inside the world (built round the HQ, with a margin wider than the air), down to its bottom.
      expect(t.x, name).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w, name).toBeLessThanOrEqual(cols * TILE);
      expect(t.y, name).toBe((Math.min(...city!.buildings.map((b) => b.row)) - 2) * TILE);
      expect(t.y + t.h, name).toBe(rows * TILE);
      // The Seats hall under the lounge — its walls a column either side of its 13, its board on the row
      // over its top wall, its floor wall 10 rows under that wall — lies inside the world and the frame.
      const hall = v.world.houses.find((x) => x.capacity === "seats")!;
      expect([hall.col - 1 >= 0, hall.col + 13 < cols, hall.row + 10 < rows], name).toEqual([true, true, true]);
      expect((hall.col - 1) * TILE, name).toBeGreaterThanOrEqual(t.x);
      expect((hall.col + 14) * TILE, name).toBeLessThanOrEqual(t.x + t.w);
      expect((hall.row - 1) * TILE, name).toBeGreaterThanOrEqual(t.y);
      expect((hall.row + 11) * TILE, name).toBeLessThanOrEqual(t.y + t.h);
      // At Fit the HQ's middle is the view's middle (to the pixel of rounding).
      v.resize(720, 500, 1);
      const { zoom, ox } = v.camera;
      expect(Math.abs(ox + mid * zoom - 360), name).toBeLessThanOrEqual(1);
    }
    // The HQ alone: the lounge under the street (25 tiles wall to wall) is wider than the HQ (14) — it sets the frame.
    const alone = new VillageView(1, () => null, "city");
    alone.setWorld(buildCityWorld([], { seats: 16 }));
    const hq = alone.world.city!.buildings[0];
    expect(alone.fitTarget().w).toBeGreaterThan((hq.w + 2) * TILE);
    // Its walls run 12 tiles left of the lift column and to 13 tiles right of the HQ's middle (the lift's
    // left edge): 13, plus a tile of air, either side — the narrower Seats hall under it (15) does not set it.
    expect(alone.fitTarget().w).toBe(28 * TILE);
    expect(alone.fitTarget().x).toBe((hq.col + 7 - 14) * TILE);
    // One wide project right of the HQ: the empty street left of the HQ is framed too, as wide as that project's side.
    const wide = new VillageView(1, () => null, "city");
    wide.setWorld(buildCityWorld(planCity(shapes[2][1]).plans, { seats: 16 }));
    const [first] = wide.world.city!.buildings;
    expect(first.hq).toBe(true);
    expect(wide.fitTarget().x).toBeLessThan((first.col - 20) * TILE);
  });

  it("a city without the HQ: Fit frames its buildings and street, cropping empty ground either side", () => {
    const v = new VillageView(1, () => null, "city");
    const roster = planCity([agent("a", { folder: "pa" }), agent("b", { folder: "pb" }), agent("c", { folder: "pc" })]);
    v.setWorld(buildCityWorld(roster.plans));
    expect(v.world.city!.buildings.some((b) => b.hq)).toBe(false);
    const t = v.fitTarget();
    const b = v.world.city!.buildings;
    expect(t.x).toBe((b[0].col - 1) * TILE);
    expect(t.x + t.w).toBe((b[b.length - 1].col + b[b.length - 1].w + 1) * TILE);
    expect(t.y).toBe((Math.min(...b.map((x) => x.row)) - 2) * TILE);
    expect(t.y + t.h).toBe(v.world.rows * TILE);
    expect(t.w).toBeLessThan(v.world.cols * TILE);
    // In a ~720 px pane it is drawn at zoom 1, not halved into a sliver.
    v.resize(720, 500, 1);
    expect(v.camera.zoom).toBe(1);
    expect(v.camera.ox + t.x).toBe(Math.round((720 - t.w) / 2));
    // An empty street (no buildings) still frames the whole world; the village always does.
    const empty = new VillageView(1, () => null, "city");
    expect(empty.fitTarget()).toEqual({ x: 0, y: 0, w: empty.world.cols * TILE, h: empty.world.rows * TILE });
    const village = new VillageView();
    expect(village.fitTarget()).toEqual({ x: 0, y: 0, w: village.world.cols * TILE, h: village.world.rows * TILE });
  });
});

describe("VillageView — the LANs' traffic: events from the agents it is handed", () => {
  const sub = (key: string, parentKey: string, extra: Partial<VillageAgent> = {}) => agent(key, { parentKey, ...extra });

  /** A view on screen showing `agents` (handed before its first frame, as the panel does), run for
   * `seconds`. `step` runs frames 100 ms apart (the sim's largest tick); `sent` paints one more
   * (the draw list is only built with a canvas) and returns the events it was handed. */
  function onScreen(agents: VillageAgent[], seconds = 1) {
    const v = new VillageView(1, () => null);
    v.resize(800, 600, 1);
    v.setWorld(buildWorld(planHouses([agent("r"), agent("q", { folder: "other" })])));
    v.setAgents(agents);
    let ms = 0;
    v.frame(ms, null);
    const step = (s: number): void => {
      for (let i = 0; i < Math.round(s * 10); i++) v.frame((ms += 100), null);
    };
    const sent = (): readonly LanEvent[] => {
      const draw = vi.mocked(buildDrawList);
      draw.mockClear();
      v.frame((ms += 100), recorder());
      expect(draw).toHaveBeenCalledTimes(1);
      return draw.mock.lastCall![7]!;
    };
    step(seconds);
    return { v, step, sent };
  }

  it("the first roster sends nothing — even on a view already on screen, with teams, finished ones and counts", () => {
    const { v, sent } = onScreen([]); // framed, before any agents
    v.setAgents([agent("r", { toolCalls: 7 }), sub("s", "r", { toolCalls: 3 }), sub("d", "r", { activity: "done" })]);
    expect(sent()).toEqual([]);
  });

  it("a sub-agent arriving under an agent already there is given a task, at the sim clock now", () => {
    const { v, sent } = onScreen([agent("r")]);
    const now = v.sim.time;
    expect(now).toBeGreaterThan(0.5);
    v.setAgents([agent("r"), sub("s", "r")]);
    expect(sent()).toEqual([{ kind: "task", key: "s", at: now }]);
    // Seen again, it is not a new task.
    v.setAgents([agent("r"), sub("s", "r")]);
    expect(sent()).toHaveLength(1);
  });

  it("a root arriving, or a whole tree at once (an external scan's first report), is no task", () => {
    const { v, sent } = onScreen([agent("r")]);
    v.setAgents([agent("r"), agent("x"), sub("x.1", "x"), sub("x.2", "x"), sub("orphan", "ghost")]);
    expect(sent()).toEqual([]);
  });

  it("a sub-agent whose activity turns done or error sends ONE result; a root's or a re-finish sends none", () => {
    const team = (s: VillageAgent["activity"], t: VillageAgent["activity"], r: VillageAgent["activity"] = "typing") => [
      agent("r", { activity: r }),
      sub("s", "r", { activity: s }),
      sub("t", "r", { activity: t }),
    ];
    const { v, sent } = onScreen(team("typing", "waiting"));
    const now = v.sim.time;
    v.setAgents(team("done", "error", "done"));
    expect(sent()).toEqual([
      { kind: "result", key: "s", at: now },
      { kind: "result", key: "t", at: now },
    ]);
    // done → error is not a second result; idle is not a result at all.
    v.setAgents(team("error", "error", "idle"));
    expect(sent()).toHaveLength(2);
    const other = onScreen(team("idle", "reading"));
    other.v.setAgents(team("idle", "idle"));
    expect(other.sent()).toEqual([]);
  });

  it("tool calls: +1 → one packet, +3 → three a fraction of a second apart, +10 → only five", () => {
    const counts = (a: number, b: number, c: number) => [
      agent("a", { toolCalls: a }),
      agent("b", { toolCalls: b, folder: "other" }),
      sub("c", "a", { toolCalls: c }),
    ];
    const { v, sent } = onScreen(counts(2, 0, 4));
    const now = v.sim.time;
    v.setAgents(counts(3, 3, 14));
    const out = sent();
    const of = (key: string) => out.filter((e) => e.key === key);
    expect(out.every((e) => e.kind === "tool")).toBe(true);
    expect(of("a")).toEqual([{ kind: "tool", key: "a", at: now }]);
    expect(of("b")).toHaveLength(3);
    expect(of("c")).toHaveLength(5); // the burst cap: the LAN shows calls being made, not each one
    for (const burst of [of("b"), of("c")]) {
      expect(burst[0].at).toBe(now);
      for (let i = 1; i < burst.length; i++) {
        const gap = burst[i].at - burst[i - 1].at;
        expect(gap).toBeGreaterThanOrEqual(0.2); // never on top of each other on the cable…
        expect(gap).toBeLessThanOrEqual(0.5); // …but one burst, not a trickle
      }
    }
  });

  it("a rise while packets still wait goes after them, and never more than five wait at once", () => {
    const { v, step, sent } = onScreen([agent("a", { toolCalls: 0 })]);
    const t0 = v.sim.time;
    v.setAgents([agent("a", { toolCalls: 5 })]);
    v.setAgents([agent("a", { toolCalls: 10 })]); // the same instant: all five slots are taken
    const first = sent().map((e) => e.at);
    expect(first).toHaveLength(5);
    step(0.5); // t0 + 0.6 (with `sent`'s frame): three have left, two still wait — off any slot's edge
    v.setAgents([agent("a", { toolCalls: 15 })]);
    const after = sent().map((e) => e.at);
    expect(after).toHaveLength(8);
    // Queued behind the last one, the same gap on: nothing overlaps.
    const gap = first[1] - first[0];
    const tail = after.slice(5);
    expect(tail[0]).toBeCloseTo(first[4] + gap, 9);
    expect(tail[2] - tail[1]).toBeCloseTo(gap, 9);
    expect(first[0]).toBe(t0);
  });

  it("an unknown count sends nothing — before or after — and neither does a count that falls", () => {
    const { v, sent } = onScreen([agent("a"), agent("b", { toolCalls: 9 })]);
    v.setAgents([agent("a", { toolCalls: 4 }), agent("b")]);
    v.setAgents([agent("a", { toolCalls: 1 }), agent("b", { toolCalls: 12 })]);
    expect(sent()).toEqual([]);
    // From the fallen count on, a rise is a rise.
    v.setAgents([agent("a", { toolCalls: 2 }), agent("b", { toolCalls: 12 })]);
    expect(sent().map((e) => e.key)).toEqual(["a"]);
  });

  it("an agent that vanishes sends nothing", () => {
    const { v, sent } = onScreen([agent("r", { toolCalls: 1 }), sub("s", "r", { toolCalls: 2 })]);
    v.setAgents([]);
    expect(sent()).toEqual([]);
  });

  it("off screen — paused, or not framed yet — changes only become the baseline: no stale burst on return", () => {
    const { v, step, sent } = onScreen([agent("r", { toolCalls: 1 })]);
    v.pause(); // the other picture took the canvas, or the window was hidden
    v.setAgents([agent("r", { toolCalls: 6 }), sub("s", "r")]);
    v.setAgents([agent("r", { toolCalls: 9 }), sub("s", "r", { activity: "done" })]);
    step(0.1); // back on screen
    expect(sent()).toEqual([]);
    // Diffed against what it last saw while away: only what happens from now on.
    v.setAgents([agent("r", { toolCalls: 10 }), sub("s", "r", { activity: "done" }), sub("u", "r")]);
    expect(sent().map((e) => [e.kind, e.key])).toEqual([
      ["tool", "r"],
      ["task", "u"],
    ]);
  });

  it("keeps an event for a full round trip, then prunes it", () => {
    const { v, step, sent } = onScreen([agent("r")]);
    v.setAgents([agent("r"), sub("s", "r")]);
    step(2 * MAX_TRIP); // the task down and an answer back can both still be on the cable
    expect(sent()).toHaveLength(1);
    step(1.5);
    expect(sent()).toEqual([]);
  });
});

describe("VillageView — the city's commuters and the lounge", () => {
  /** As the panel hands a city its inputs: it has the lounge. */
  const input = (agents: VillageAgent[]) => ({
    machine: null,
    machineError: null,
    agents,
    includesOutside: true,
    usage: null,
    usageError: null,
    context: {},
    nowMs: 0,
    lounge: true,
  });
  const raw = (subActivity: VillageAgent["activity"]) => [agent("g"), agent("g.s0", { parentKey: "g", activity: subActivity })];

  it("hands the sim each holder's bench — its desk number — so a newcomer appears on that bench, in the panel's order (world, agents, capacity)", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(800, 600, 1);
    const roster = planCity(raw("typing"));
    const world = buildCityWorld(roster.plans, { seats: 16 });
    v.setWorld(world);
    v.setAgents(roster.agents);
    v.setCapacity(input(raw("typing")));
    expect(v.capacityFrame!.desks.slice(0, 3).map((d) => d?.key ?? null)).toEqual(["g", "g.s0", null]);
    const bench = world.props.find((p) => p.kind === "bench" && p.index === 1)!;
    const sub = v.sim.characters().find((c) => c.key === "g.s0")!;
    expect([sub.x, sub.seated]).toEqual([bench.col * TILE + TILE / 2, true]);
  });

  it("passes the sim's lounge claims to the draw list each frame — kept while the agent that finished walks back", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(800, 600, 1);
    const roster = planCity(raw("typing"));
    v.setWorld(buildCityWorld(roster.plans, { seats: 16 }));
    v.setAgents(roster.agents);
    v.setCapacity(input(raw("typing")));
    const claimsAt = (ms: number) => {
      const draw = vi.mocked(buildDrawList);
      draw.mockClear();
      v.frame(ms, recorder());
      return [...draw.mock.lastCall![5]!.claims!];
    };
    expect(claimsAt(0)).toEqual([1]);
    for (let ms = 100; ms < 600; ms += 100) v.frame(ms, null); // it appears, then sets off
    expect(v.sim.characters().find((c) => c.key === "g.s0")!.anim).toBe("walk");
    expect(claimsAt(600)).toEqual([1]); // away from its bench, which stays its own
    // It finishes: the capacity frame frees its desk at once, but it still claims its bench.
    v.setAgents(planCity(raw("done")).agents);
    v.setCapacity(input(raw("done")));
    expect(v.capacityFrame!.desks[1]).toBeNull();
    expect(claimsAt(700)).toEqual([1]);
  });
});

describe("VillageView — LAN events in a city with a lounge: real communication, from the desk", () => {
  const lead = () => agent("g", { toolCalls: 0 });
  const sub = (extra: Partial<VillageAgent> = {}) => agent("g.s0", { parentKey: "g", toolCalls: 0, ...extra });

  /** A city view on screen; `show` hands it a roster as the panel does (the world first, then the agents). */
  function cityOnScreen(seats: number | null = 16) {
    const v = new VillageView(1, () => null, "city");
    v.resize(800, 600, 1);
    const show = (agents: VillageAgent[]) => {
      const roster = planCity(agents);
      v.setWorld(seats === null ? buildCityWorld(roster.plans) : buildCityWorld(roster.plans, { seats }));
      v.setAgents(roster.agents);
    };
    let ms = 0;
    v.frame(ms, null);
    /** One painted frame 100 ms on: the events the draw list was handed, and what it drew. */
    const paint = (): { events: readonly LanEvent[]; items: DrawItem[] } => {
      const draw = vi.mocked(buildDrawList);
      draw.mockClear();
      v.frame((ms += 100), recorder());
      return { events: draw.mock.lastCall![7]!, items: draw.mock.results[0].value as DrawItem[] };
    };
    const seated = () => v.sim.seating().some((a) => a.key === "g.s0");
    return { v, show, paint, seated };
  }

  it("a sub-agent's TASK is stamped when it first sits at its desk — not when it appears on its bench — and its packet then runs to its PC", () => {
    const { v, show, paint, seated } = cityOnScreen();
    show([lead()]);
    paint();
    show([lead(), sub()]);
    // On its bench and on its way: no task yet.
    let first: { events: readonly LanEvent[]; items: DrawItem[] } | null = null;
    let at = -1;
    for (let i = 0; i < 150 && !first; i++) {
      const f = paint();
      if (seated()) {
        first = f;
        at = v.sim.time;
      } else expect(f.events).toEqual([]);
    }
    expect(first).not.toBeNull();
    expect(at).toBeGreaterThan(3); // it really commuted first
    expect(first!.events).toEqual([{ kind: "task", key: "g.s0", at }]);
    // The packet is under way from its parent to its PC the frames after.
    const next = paint();
    expect(next.items.some((i) => i.t === "packet" && i.kind === "team")).toBe(true);
    // Stamped once.
    for (let i = 0; i < 3; i++) expect(paint().events.filter((e) => e.kind === "task")).toHaveLength(1);
  });

  it("TOOL calls made while it is not at its desk are dropped (not deferred); seated, each call is sent", () => {
    const { show, paint, seated } = cityOnScreen();
    show([lead(), sub()]); // the first roster: a baseline
    paint();
    paint();
    expect(seated()).toBe(false);
    show([lead(), sub({ toolCalls: 2 })]);
    for (let i = 0; i < 150 && !seated(); i++) expect(paint().events).toEqual([]);
    expect(seated()).toBe(true);
    for (let i = 0; i < 10; i++) expect(paint().events).toEqual([]); // nothing was kept for later
    show([lead(), sub({ toolCalls: 3 })]);
    expect(paint().events.map((e) => [e.kind, e.key])).toEqual([["tool", "g.s0"]]);
  });

  it("a RESULT from its desk is sent (it stays seated for the beat); one that finishes on its way, never at its desk, sends none — and gets no task", () => {
    const desk = cityOnScreen();
    desk.show([lead(), sub()]);
    for (let i = 0; i < 150 && !desk.seated(); i++) desk.paint();
    const now = desk.v.sim.time;
    desk.show([lead(), sub({ activity: "done" })]);
    expect(desk.paint().events).toEqual([{ kind: "result", key: "g.s0", at: now }]);

    const away = cityOnScreen();
    away.show([lead()]);
    away.paint();
    away.show([lead(), sub()]);
    for (let i = 0; i < 20; i++) away.paint(); // two seconds: on its way
    away.show([lead(), sub({ activity: "error" })]);
    for (let i = 0; i < 150; i++) expect(away.paint().events).toEqual([]);
    expect(away.seated()).toBe(false);
  });

  it("a sub-agent removed before it sits never gets its task — not even when it comes back with a whole new tree", () => {
    const { show, paint, seated } = cityOnScreen();
    show([lead()]);
    paint();
    show([lead(), sub()]);
    paint();
    show([]);
    paint();
    // Back, parent and all at once (a first report): no task for it, now or when it sits.
    show([lead(), sub()]);
    for (let i = 0; i < 150; i++) expect(paint().events).toEqual([]);
    expect(seated()).toBe(true);
  });

  it("without a lounge (a city without capacity) nothing changes: the task is stamped when the sub-agent appears, its calls as they come", () => {
    const { v, show, paint } = cityOnScreen(null);
    show([lead()]);
    paint();
    const now = v.sim.time;
    show([lead(), sub({ toolCalls: 1 })]);
    expect(paint().events).toEqual([{ kind: "task", key: "g.s0", at: now }]);
    show([lead(), sub({ toolCalls: 2, activity: "done" })]);
    expect(paint().events.map((e) => [e.kind, e.key])).toEqual([
      ["task", "g.s0"],
      ["result", "g.s0"],
      ["tool", "g.s0"],
    ]);
  });
});
