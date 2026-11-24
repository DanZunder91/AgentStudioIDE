import { describe, expect, it, vi } from "vitest";

import { asciiWorld } from "../engine/testWorld";
import type { Ambience, CharacterView, DrawItem } from "../villageTypes";
import { buildCityWorld } from "../engine";
import { SKY } from "./ambience";
import { CITY } from "./city";
import { renderFrame } from "./index";
import { METER_TONE } from "./capacity";
import { CABLE, teamPacketColors, uplinkPacketColor, wifiColors, wifiRadius } from "./lan";
import { CAMPFIRE_OUT } from "./props";
import type { SpriteBank, SpriteImage } from "./renderTypes";
import { recorder } from "./testRecorder";

const IMG = { img: true } as unknown as SpriteImage;

function bank(fallback = false): SpriteBank {
  return {
    fallback,
    character: vi.fn(() => IMG),
    floor: vi.fn(() => IMG),
    wall: vi.fn(() => IMG),
    furniture: vi.fn(() => IMG),
  };
}

const character: CharacterView = {
  key: "a",
  x: 40,
  y: 40,
  dir: "down",
  anim: "idle",
  frame: 0,
  palette: 0,
  hueShift: 0,
  seated: false,
  origin: "external",
  isSubagent: true,
  activity: "waiting",
  label: "Explore",
  tool: null,
  bubble: "waiting",
  bubbleAlpha: 1,
  fx: null,
};

const items: DrawItem[] = [
  { t: "tile", col: 0, row: 0, kind: "grass", variant: 0 },
  { t: "tile", col: 1, row: 0, kind: "floor", variant: 0 },
  { t: "wall", col: 2, row: 1, mask: 0 },
  {
    t: "prop",
    prop: { id: "d", kind: "desk", col: 0, row: 1, w: 2, h: 1 },
    on: false,
    frame: 0,
  },
  { t: "character", c: character },
  { t: "bubble", c: character },
  { t: "label", x: 40, y: 10, text: "repo", tone: "house" },
];

describe("renderFrame", () => {
  it("clears, turns smoothing off, then paints every item in the engine's order", () => {
    const ctx = recorder();
    ctx.globalAlpha = 0.3;
    const b = bank();
    renderFrame(ctx, items, { zoom: 2, ox: 0, oy: 0 }, b, { w: 400, h: 300 });
    expect(ctx.calls[0]).toMatchObject({
      op: "clearRect",
      args: [0, 0, 400, 300],
      alpha: 1,
      smoothing: false,
    });
    expect(b.floor).toHaveBeenCalled();
    expect(b.wall).toHaveBeenCalled();
    expect(b.furniture).toHaveBeenCalledWith("SMALL_TABLE_FRONT");
    expect(b.character).toHaveBeenCalledWith(0, 0);
    // order: floor image, wall image, desk image, character image, then bubble rects, then label text last
    const imgs = ctx.of("drawImage").map((c) => c.args[0]);
    expect(imgs).toHaveLength(4);
    const ops = ctx.calls.map((c) => c.op);
    expect(ops[ops.length - 1]).toBe("fillText");
    expect(ctx.of("fillText")[0].args[0]).toBe("repo");
    expect(ctx.calls.every((c) => !c.smoothing)).toBe(true);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("a fallback (or null) bank paints rectangles instead of sprites", () => {
    for (const b of [bank(true), null]) {
      const ctx = recorder();
      renderFrame(ctx, items, { zoom: 1, ox: 0, oy: 0 }, b, {
        w: 400,
        h: 300,
        timeMs: 1000,
      });
      expect(ctx.of("drawImage")).toHaveLength(0);
      expect(ctx.of("fillRect").length).toBeGreaterThan(10);
    }
  });

  it("skips tiles and walls that are entirely off-screen", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [
        { t: "tile", col: 50, row: 0, kind: "plaza", variant: 0 },
        { t: "tile", col: -2, row: 0, kind: "plaza", variant: 0 },
        { t: "tile", col: 0, row: 40, kind: "plaza", variant: 0 },
        { t: "tile", col: 0, row: -2, kind: "plaza", variant: 0 },
        { t: "wall", col: 0, row: 30, mask: 0 },
        { t: "wall", col: 0, row: -1, mask: 0 },
      ],
      { zoom: 1, ox: 0, oy: 0 },
      bank(),
      { w: 160, h: 160 },
    );
    expect(ctx.calls.map((c) => c.op)).toEqual(["clearRect"]);
  });

  it("with a cached ground layer: one blit, no static tiles, water still per frame", () => {
    const ctx = recorder();
    const ground = {
      image: { ground: true } as unknown as SpriteImage,
      w: 64,
      h: 48,
    };
    renderFrame(
      ctx,
      [
        { t: "tile", col: 0, row: 0, kind: "grass", variant: 0 },
        { t: "tile", col: 1, row: 0, kind: "floor", variant: 0 },
        { t: "tile", col: 2, row: 0, kind: "water", variant: 0 },
      ],
      { zoom: 3, ox: 10.4, oy: -5 },
      bank(),
      { w: 400, h: 300, ground },
    );
    const [blit, ...rest] = ctx.of("drawImage");
    // Whole layer → its world rect at the zoom, snapped like every other draw.
    expect(blit.args).toEqual([ground.image, 0, 0, 64, 48, 10, -5, 192, 144]);
    expect(rest).toHaveLength(0); // the floor tile came from the layer, not the bank
    // Only the water tile is painted: its fills start at its x (10 + 32·3).
    const xs = new Set(ctx.of("fillRect").map((f) => f.args[0] as number));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(10 + 32 * 3);
  });

  it("a torii whose footprint is just below the view still paints its top beam (its art rises ~3 tiles)", () => {
    const view = { w: 200, h: 200 };
    // Footprint row 14 = y 224..240, under the 200-px view; its beam rises 43 px to y 197 — on screen.
    const torii: DrawItem = { t: "prop", prop: { id: "g", kind: "torii", col: 2, row: 14, w: 3, h: 1 }, on: false, frame: 0 };
    const ctx = recorder();
    renderFrame(ctx, [torii], { zoom: 1, ox: 0, oy: 0 }, null, view);
    expect(ctx.calls.some((c) => c.op === "fillRect")).toBe(true);
    // A tree that far down has nothing on screen: the wider reach is the torii's alone.
    const tree: DrawItem = { t: "prop", prop: { id: "t", kind: "tree", col: 2, row: 14, w: 2, h: 2 }, on: false, frame: 0 };
    const none = recorder();
    renderFrame(none, [tree], { zoom: 1, ox: 0, oy: 0 }, null, view);
    expect(none.calls.map((c) => c.op)).toEqual(["clearRect"]);
  });

  it("culls characters, bubbles, labels and props that are off-screen", () => {
    const far = { ...character, x: 5000, y: 5000 };
    const view = { w: 200, h: 200 };
    const off: DrawItem[] = [
      { t: "character", c: far },
      { t: "bubble", c: far },
      { t: "label", x: 5000, y: 100, text: "right", tone: "agent" },
      { t: "label", x: -400, y: 100, text: "left", tone: "agent" },
      { t: "label", x: 100, y: -60, text: "above", tone: "agent" },
      { t: "label", x: 100, y: 260, text: "below", tone: "agent" },
      {
        t: "prop",
        prop: { id: "t", kind: "tree", col: 40, row: 40, w: 2, h: 2 },
        on: false,
        frame: 0,
      },
    ];
    const ctx = recorder();
    renderFrame(ctx, off, { zoom: 1, ox: 0, oy: 0 }, null, view);
    expect(ctx.calls.map((c) => c.op)).toEqual(["clearRect"]);

    // Just inside the edges, everything paints: a label whose anchor is a little off
    // the left edge still shows its right half; a tree whose crown alone is in view.
    const edge: DrawItem[] = [
      { t: "character", c: { ...character, x: 196, y: 230 } },
      { t: "bubble", c: { ...character, x: 196, y: 230 } },
      { t: "label", x: -100, y: 1, text: "edge", tone: "agent" },
      { t: "label", x: 100, y: 190, text: "low", tone: "agent" },
      {
        t: "prop",
        prop: { id: "t", kind: "tree", col: 2, row: 13, w: 2, h: 2 },
        on: false,
        frame: 0,
      },
    ];
    const ctx2 = recorder();
    renderFrame(ctx2, edge, { zoom: 1, ox: 0, oy: 0 }, null, view);
    // (agent tags paint in reverse rank order — see the label placement tests)
    expect(
      ctx2
        .of("fillText")
        .map((t) => t.args[0])
        .sort(),
    ).toEqual(["edge", "low"]);
    expect(ctx2.of("fillRect").length).toBeGreaterThan(10);
  });

  it("lays labels out together: forced ones stay, the rest dodge or drop, the hovered tag paints on top", () => {
    const ctx = recorder();
    const at = (
      text: string,
      tone: "house" | "agent",
      y: number,
      priority?: number,
    ): DrawItem =>
      priority === undefined
        ? { t: "label", x: 100, y, text, tone }
        : { t: "label", x: 100, y, text, tone, priority };
    renderFrame(
      ctx,
      [
        at("board", "house", 50), // forced (a house): box y 42..58
        at("hover", "agent", 52, 0), // forced (hovered), right over the board
        at("waits", "agent", 100, 1), // clear: stays put
        at("root1", "agent", 104, 2), // collides with "waits" → one line down
        at("root2", "agent", 100, 2), // collides at both spots → dropped
        at("subby", "agent", 160, 3), // clear
      ],
      { zoom: 1, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    const texts = ctx.of("fillText").map((t) => [t.args[0], t.args[2]]);
    // the board first, then agent tags in reverse rank (the hovered one last, on top)
    expect(texts).toEqual([
      ["board", 50],
      ["subby", 167],
      ["root1", 104 + 14 + 2 + 7],
      ["waits", 107],
      ["hover", 59],
    ]);
  });

  it("capacity boards and gauge captions are forced like house boards; a floor plate in their way is dropped", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [
        // Each forced label comes AFTER one it collides with — the first label is placed
        // where it is whether forced or not, so only a later one can show the forcing.
        { t: "label", x: 100, y: 40, text: "gazelle", tone: "house" },
        { t: "label", x: 100, y: 50, text: "Seats 2/4", tone: "civic" },
        { t: "label", x: 100, y: 52, text: "5h 41%", tone: "gauge" },
        { t: "label", x: 100, y: 51, text: "zsh", tone: "floor", priority: 2 },
      ],
      { zoom: 1, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    // Every board at its own anchor (text y = its box's middle), none nudged a line down as
    // an unforced label would be — the text alone cannot tell (a nudged label is still drawn).
    expect(ctx.of("fillText").map((t) => [t.args[0], t.args[2]])).toEqual([
      ["gazelle", 40],
      ["Seats 2/4", 51],
      ["5h 41%", 53],
    ]);
  });

  it("paints a context bar (meter) where it is, and culls one off-screen", () => {
    const ctx = recorder();
    const meter = (x: number): DrawItem => ({ t: "meter", x, y: 20, w: 14, fill: 1, tone: "danger" });
    renderFrame(ctx, [meter(10), meter(900)], { zoom: 1, ox: 0, oy: 0 }, null, { w: 400, h: 300 });
    const fills = ctx.of("fillRect").filter((c) => c.fillStyle === METER_TONE.danger);
    expect(fills.map((c) => c.args)).toEqual([[10, 20, 14, 2]]);
  });

  it("paints the Seats LAN: a cable where it runs, both packet kinds where they are, the off-screen ones culled", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [
        { t: "tile", col: 0, row: 0, kind: "floor", variant: 0 },
        { t: "cable", x0: 10, y0: 20, x1: 40, y1: 20 },
        { t: "cable", x0: 900, y0: 20, x1: 990, y1: 20 },
        { t: "packet", x: 20, y: 20, kind: "team", hue: 200 },
        { t: "packet", x: 30, y: 20, kind: "uplink", hue: 200 },
        { t: "packet", x: 20, y: 900, kind: "team", hue: 200 },
        { t: "packet", x: 900, y: 20, kind: "uplink", hue: 200 },
      ],
      { zoom: 1, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    const fills = ctx.of("fillRect");
    const at = (style: string) => fills.flatMap((c, i) => (c.fillStyle === style ? [{ i, args: c.args }] : []));
    expect(at(CABLE.shine).map((f) => f.args)).toEqual([[9, 19, 32, 1]]);
    expect(at(CABLE.core).map((f) => f.args)).toEqual([[9, 20, 32, 1]]);
    const team = at(teamPacketColors(200).body);
    const up = at(uplinkPacketColor(200));
    expect(team.map((f) => f.args)).toEqual([[19, 19, 3, 3]]);
    expect(up.map((f) => f.args)).toEqual([[29, 19, 2, 2]]);
    // In the engine's order: the cable under the packets.
    expect(at(CABLE.core)[0].i).toBeLessThan(team[0].i);
  });

  it("paints a project room's Wi-Fi pulses where they are, in the engine's order, the off-screen ones culled", () => {
    const ctx = recorder();
    const r = wifiRadius(0.3);
    renderFrame(
      ctx,
      [
        { t: "tile", col: 0, row: 0, kind: "floor", variant: 0 },
        { t: "packet", x: 20, y: 20, kind: "team", hue: 200 },
        { t: "wifi", x: 60, y: 40, phase: 0.3, hue: 120 },
        { t: "wifi", x: 900, y: 40, phase: 0.3, hue: 120 },
        { t: "wifi", x: 60, y: -50, phase: 0.3, hue: 120 },
        { t: "wifi", x: 100, y: 40, phase: 0.3, hue: 300 },
      ],
      { zoom: 1, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    const fills = ctx.of("fillRect");
    const at = (style: string) => fills.flatMap((c, i) => (c.fillStyle === style ? [{ i, args: c.args as number[] }] : []));
    const green = at(wifiColors(120, 0.3).ring);
    const pink = at(wifiColors(300, 0.3).ring);
    // One ring each for the two on screen — spanning exactly 2r + 1 px round its centre — none for the culled ones.
    const span = (cells: { args: number[] }[]) => [Math.min(...cells.map((c) => c.args[0])), Math.max(...cells.map((c) => c.args[0] + c.args[2]))];
    expect(span(green)).toEqual([60 - r, 60 + r + 1]);
    expect(span(pink)).toEqual([100 - r, 100 + r + 1]);
    expect(green.every((c) => c.args[1] >= 40 - r && c.args[1] <= 40 + r)).toBe(true);
    expect(at(wifiColors(120, 0.3).rim).length).toBeGreaterThan(0);
    // In the engine's order: after the packet, the first pulse before the second.
    expect(green[0].i).toBeGreaterThan(at(teamPacketColors(200).body)[0].i);
    expect(pink[0].i).toBeGreaterThan(green[green.length - 1].i);
  });

  it("paints a city's floor plates and HQ plate with the boards — before any agent tag", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [
        { t: "label", x: 100, y: 20, text: "gazelle", tone: "house" },
        { t: "label", x: 20, y: 60, text: "zsh", tone: "floor", priority: 2 },
        { t: "label", x: 300, y: 90, text: "Seats 3/10", tone: "civic" },
        { t: "label", x: 200, y: 200, text: "hover", tone: "agent", priority: 0 },
      ],
      { zoom: 1, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    expect(ctx.of("fillText").map((t) => t.args[0])).toEqual(["gazelle", "zsh", "Seats 3/10", "hover"]);
  });

  it("hands a plate's width cap to the layout: a long floor name is clipped to its floor at ½", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [{ t: "label", x: 20, y: 60, text: "quiet-running-otter", tone: "floor", priority: 2, maxW: 160 }],
      { zoom: 0.5, ox: 0, oy: 0 },
      null,
      { w: 400, h: 300 },
    );
    expect(ctx.of("fillText").map((t) => t.args[0])).toEqual(["quiet-runni…"]);
  });

  it("gives a city its sky first: after the clear, before the ground layer and the world", () => {
    const ctx = recorder();
    const world = buildCityWorld([]);
    const layer = { image: { layer: true } as unknown as SpriteImage, w: world.cols * 16, h: world.rows * 16 };
    renderFrame(ctx, [{ t: "wall", col: 1, row: 1, mask: 0 }], { zoom: 1, ox: 700, oy: 0 }, null, {
      w: 2000,
      h: 400,
      world,
      ground: layer,
    });
    const styles = ctx.calls.map((c) => c.fillStyle);
    const blits = ctx.calls.flatMap((c, i) => (c.op === "drawImage" && c.args[0] === layer.image ? [i] : []));
    expect(ctx.calls[0].op).toBe("clearRect");
    expect(styles.indexOf(CITY.sky[0])).toBe(1);
    // The world is 640 px wide in a 2000 px view: copies of its street left and right of it,
    // then the world's own ground on top — all after the sky.
    expect(blits.length).toBeGreaterThanOrEqual(3);
    expect(blits[0]).toBeGreaterThan(styles.lastIndexOf(CITY.sky[CITY.sky.length - 1]));
    expect(ctx.calls[blits.at(-1)!].args.slice(5)).toEqual([700, 0, layer.w, layer.h]);
    // Without a city there is no sky to paint.
    const plain = recorder();
    renderFrame(plain, [], { zoom: 1, ox: 0, oy: 0 }, null, { w: 100, h: 100, world: asciiWorld(["..."]) });
    expect(plain.calls.map((c) => c.fillStyle)).not.toContain(CITY.sky[0]);
  });

  it("scales labels by the view's pixel ratio", () => {
    const ctx = recorder();
    const blank: DrawItem = {
      t: "label",
      x: 10,
      y: 10,
      text: "  ",
      tone: "agent",
    }; // measured to nothing: skipped
    renderFrame(
      ctx,
      [blank, { t: "label", x: 10, y: 10, text: "a", tone: "agent" }],
      { zoom: 2, ox: 0, oy: 0 },
      null,
      {
        w: 400,
        h: 300,
        pixelRatio: 2,
      },
    );
    expect(ctx.of("fillText").map((t) => t.args[0])).toEqual(["a"]);
    expect(ctx.of("fillText")[0].font).toMatch(/^20px /);
  });

  it("draws a wall whose upper half alone is in view", () => {
    const ctx = recorder();
    renderFrame(
      ctx,
      [{ t: "wall", col: 0, row: 10, mask: 0 }],
      { zoom: 1, ox: 0, oy: 0 },
      bank(),
      { w: 160, h: 150 },
    );
    expect(ctx.of("drawImage")).toHaveLength(1);
  });

  describe("ambience", () => {
    const sky: Ambience = {
      phase: "afternoon",
      daylight: 0.8,
      tint: { color: "#ffc890", alpha: 0.2 },
      weather: "rain",
      intensity: 0.5,
      wind: 0,
      lightsOn: true,
      campfireLit: false,
      stayIndoors: true,
    };
    const fire: DrawItem = {
      t: "prop",
      prop: { id: "f", kind: "campfire", col: 1, row: 1, w: 1, h: 1 },
      on: false,
      frame: 0,
    };
    const pathWorld = asciiWorld(["====", "====", "====", "===="]);
    const paths: DrawItem[] = pathWorld.tiles.map((_, i) => ({
      t: "tile",
      col: i % 4,
      row: Math.floor(i / 4),
      kind: "path",
      variant: 0,
    }));

    it("puddles go down after the ground, the sky after the world and before bubbles and labels", () => {
      const ctx = recorder();
      renderFrame(
        ctx,
        [
          ...paths,
          fire,
          { t: "character", c: { ...character, bubble: null } },
          { t: "bubble", c: character },
          { t: "label", x: 40, y: 10, text: "repo", tone: "house" },
        ],
        { zoom: 1, ox: 0, oy: 0 },
        null,
        {
          w: 400,
          h: 300,
          ambience: sky,
          particles: [{ kind: "rain", x: 30, y: 30, size: 6, alpha: 0.5 }],
          flash: 0.5,
          world: pathWorld,
          timeMs: 0,
        },
      );
      const ops = ctx.calls.map((c) => c.op);
      const styles = ctx.calls.map((c) => c.fillStyle);
      const firstPuddle = styles.indexOf(SKY.puddle);
      expect(firstPuddle).toBeGreaterThan(0);
      // the put-out campfire (charred logs) is painted after the puddles
      expect(styles.indexOf(CAMPFIRE_OUT.logs)).toBeGreaterThan(firstPuddle);
      const clip = ops.indexOf("clip");
      expect(clip).toBeGreaterThan(styles.indexOf(CAMPFIRE_OUT.logs));
      expect(styles.indexOf(SKY.rain)).toBeGreaterThan(clip);
      expect(styles.indexOf(SKY.flash)).toBeGreaterThan(
        styles.indexOf(SKY.rain),
      );
      // bubble rects and the label come after the sky
      expect(ops.indexOf("fillText")).toBeGreaterThan(
        ops.lastIndexOf("restore"),
      );
      expect(ops.filter((o) => o === "clip")).toHaveLength(1);
      expect(ops[ops.length - 1]).toBe("fillText");
    });

    it("the Seats LAN never triggers the sky: puddles before its cables, the grade after its packets — at the first bubble, as before", () => {
      const lan: DrawItem[] = [
        { t: "packet", x: 20, y: 20, kind: "team", hue: 200 },
        { t: "packet", x: 30, y: 20, kind: "uplink", hue: 200 },
      ];
      const ctx = recorder();
      renderFrame(
        ctx,
        [
          ...paths,
          { t: "cable", x0: 10, y0: 20, x1: 40, y1: 20 },
          fire,
          { t: "character", c: { ...character, bubble: null } },
          ...lan,
          { t: "bubble", c: character },
          { t: "label", x: 40, y: 10, text: "repo", tone: "house" },
        ],
        { zoom: 1, ox: 0, oy: 0 },
        null,
        { w: 400, h: 300, ambience: sky, world: pathWorld, timeMs: 0 },
      );
      const ops = ctx.calls.map((c) => c.op);
      // Fills only: any other call carries whatever fillStyle was left set.
      const styles = ctx.calls.map((c) => (c.op === "fillRect" ? c.fillStyle : ""));
      const firstPuddle = styles.indexOf(SKY.puddle);
      const cable = styles.indexOf(CABLE.core);
      const clip = ops.indexOf("clip");
      expect(firstPuddle).toBeGreaterThan(0);
      expect(cable).toBeGreaterThan(styles.lastIndexOf(SKY.puddle));
      expect(styles.indexOf(CAMPFIRE_OUT.logs)).toBeGreaterThan(cable);
      // The grade lands after the scene AND the packets, exactly once, before the label.
      expect(clip).toBeGreaterThan(styles.lastIndexOf(uplinkPacketColor(200)));
      expect(clip).toBeGreaterThan(styles.lastIndexOf(teamPacketColors(200).body));
      expect(styles.indexOf(teamPacketColors(200).body)).toBeGreaterThan(styles.indexOf(CAMPFIRE_OUT.logs));
      expect(ops.filter((o) => o === "clip")).toHaveLength(1);
      expect(ops.indexOf("fillText")).toBeGreaterThan(clip);

      // With no bubble or label at all, the grade still waits for the end of the frame.
      const bare = recorder();
      renderFrame(bare, [...paths, { t: "cable", x0: 10, y0: 20, x1: 40, y1: 20 }, ...lan], { zoom: 1, ox: 0, oy: 0 }, null, {
        w: 400,
        h: 300,
        ambience: sky,
        world: pathWorld,
      });
      const bareStyles = bare.calls.map((c) => (c.op === "fillRect" ? c.fillStyle : ""));
      expect(bare.calls.map((c) => c.op).indexOf("clip")).toBeGreaterThan(bareStyles.lastIndexOf(uplinkPacketColor(200)));
      expect(bare.of("clip")).toHaveLength(1);
    });

    it("a Wi-Fi pulse is indoor traffic too: it never triggers the sky — the grade comes after it, once, at the first bubble", () => {
      const pulse: DrawItem = { t: "wifi", x: 30, y: 30, phase: 0.2, hue: 200 };
      const ring = wifiColors(200, 0.2).ring;
      const ctx = recorder();
      renderFrame(
        ctx,
        [...paths, fire, { t: "character", c: { ...character, bubble: null } }, pulse, { t: "bubble", c: character }, { t: "label", x: 40, y: 10, text: "repo", tone: "house" }],
        { zoom: 1, ox: 0, oy: 0 },
        null,
        { w: 400, h: 300, ambience: sky, world: pathWorld, timeMs: 0 },
      );
      const ops = ctx.calls.map((c) => c.op);
      const styles = ctx.calls.map((c) => (c.op === "fillRect" ? c.fillStyle : ""));
      const clip = ops.indexOf("clip");
      expect(styles.indexOf(ring)).toBeGreaterThan(styles.indexOf(CAMPFIRE_OUT.logs));
      expect(clip).toBeGreaterThan(styles.lastIndexOf(ring));
      expect(ops.filter((o) => o === "clip")).toHaveLength(1);
      expect(ops.indexOf("fillText")).toBeGreaterThan(clip);

      // A frame of ground and a pulse: the puddles before it, the grade only at the end of the frame.
      const bare = recorder();
      renderFrame(bare, [...paths, pulse], { zoom: 1, ox: 0, oy: 0 }, null, { w: 400, h: 300, ambience: sky, world: pathWorld });
      const bareOps = bare.calls.map((c) => c.op);
      const bareStyles = bare.calls.map((c) => (c.op === "fillRect" ? c.fillStyle : ""));
      expect(bareStyles.indexOf(ring)).toBeGreaterThan(bareStyles.lastIndexOf(SKY.puddle));
      expect(bareOps.indexOf("clip")).toBeGreaterThan(bareStyles.lastIndexOf(ring));
      expect(bare.of("clip")).toHaveLength(1);
    });

    it("a frame of nothing but ground still gets puddles and the sky (once each); no world = all outdoors", () => {
      const ctx = recorder();
      renderFrame(ctx, paths, { zoom: 1, ox: 0, oy: 0 }, null, {
        w: 64,
        h: 64,
        ambience: sky,
        world: pathWorld,
      });
      expect(ctx.of("clip")).toHaveLength(1);
      expect(ctx.of("fillRect").some((c) => c.fillStyle === SKY.puddle)).toBe(
        true,
      );
      const bare = recorder();
      renderFrame(bare, [], { zoom: 1, ox: 0, oy: 0 }, null, {
        w: 64,
        h: 64,
        ambience: sky,
      });
      expect(bare.of("rect").map((c) => c.args)).toEqual([[0, 0, 64, 64]]);
      expect(bare.of("fillRect")[0]).toMatchObject({
        fillStyle: "#ffc890",
        alpha: 0.2,
      });
    });

    it("without ambience nothing changes: no clip, the campfire burns", () => {
      const ctx = recorder();
      renderFrame(ctx, [...paths, fire], { zoom: 1, ox: 0, oy: 0 }, null, {
        w: 64,
        h: 64,
      });
      expect(ctx.of("clip")).toHaveLength(0);
      expect(ctx.of("fillRect").map((c) => c.fillStyle)).toContain("#e8662a");
    });
  });
});
