import { describe, expect, it, vi } from "vitest";

import type { Prop, PropKind, PropReading } from "../villageTypes";
import type { Ambience } from "../villageTypes";
import {
  CAMPFIRE_OUT,
  LAMP_GLASS_OFF,
  LAPTOP,
  MONITOR,
  SURFACE_LIFT,
  UP_LAPTOP_LIFT,
  drawProp,
  furnitureSprite,
} from "./props";
import type { FurnitureId, SpriteBank, SpriteImage } from "./renderTypes";
import { GAUGE, RACK } from "./capacity";
import { drawHall } from "./hall";
import { drawRouter } from "./router";
import { drawSakura, drawTorii, drawVending, vendingVariant } from "./tokyoProps";
import { recorder } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };

function prop(kind: PropKind, over: Partial<Prop> = {}): Prop {
  return { id: kind, kind, col: 2, row: 3, w: 1, h: 1, ...over };
}

function bank(): SpriteBank & { furniture: ReturnType<typeof vi.fn> } {
  return {
    fallback: false,
    character: () => null,
    floor: () => null,
    wall: () => null,
    furniture: vi.fn((id: FurnitureId) => ({ id }) as unknown as SpriteImage),
  };
}

describe("furnitureSprite", () => {
  it("desk: a small table under 3 tiles wide, the long desk from 3", () => {
    expect(furnitureSprite(prop("desk", { w: 2 }), false, 0)?.id).toBe(
      "SMALL_TABLE_FRONT",
    );
    expect(furnitureSprite(prop("desk", { w: 3 }), false, 0)?.id).toBe(
      "DESK_FRONT",
    );
  });

  it("pc: off frame, or one of three on frames cycling with `frame`", () => {
    expect(furnitureSprite(prop("pc"), false, 5)?.id).toBe("PC_FRONT_OFF");
    expect(
      [0, 1, 2, 3, -1].map((f) => furnitureSprite(prop("pc"), true, f)?.id),
    ).toEqual([
      "PC_FRONT_ON_1",
      "PC_FRONT_ON_2",
      "PC_FRONT_ON_3",
      "PC_FRONT_ON_1",
      "PC_FRONT_ON_3",
    ]);
  });

  it("chair by facing; left is the side view mirrored", () => {
    expect(
      furnitureSprite(prop("chair", { facing: "down" }), false, 0),
    ).toEqual({ id: "WOODEN_CHAIR_FRONT", flip: false });
    expect(furnitureSprite(prop("chair"), false, 0)).toEqual({
      id: "WOODEN_CHAIR_FRONT",
      flip: false,
    });
    expect(furnitureSprite(prop("chair", { facing: "up" }), false, 0)).toEqual({
      id: "WOODEN_CHAIR_BACK",
      flip: false,
    });
    expect(
      furnitureSprite(prop("chair", { facing: "right" }), false, 0),
    ).toEqual({ id: "WOODEN_CHAIR_SIDE", flip: false });
    expect(
      furnitureSprite(prop("chair", { facing: "left" }), false, 0),
    ).toEqual({ id: "WOODEN_CHAIR_SIDE", flip: true });
  });

  it("sofa back when facing up, else front; the simple pieces map 1:1", () => {
    expect(furnitureSprite(prop("sofa", { facing: "up" }), false, 0)?.id).toBe(
      "SOFA_BACK",
    );
    expect(furnitureSprite(prop("sofa"), false, 0)?.id).toBe("SOFA_FRONT");
    expect(furnitureSprite(prop("plant"), false, 0)?.id).toBe("PLANT");
    expect(furnitureSprite(prop("bookshelf"), false, 0)?.id).toBe("BOOKSHELF");
    expect(furnitureSprite(prop("bin"), false, 0)?.id).toBe("BIN");
    expect(furnitureSprite(prop("coffee"), false, 0)?.id).toBe("COFFEE");
    expect(furnitureSprite(prop("table", { w: 3, h: 3 }), false, 0)?.id).toBe(
      "TABLE_FRONT",
    );
  });

  it("our own procedural props have no vendored sprite", () => {
    for (const kind of [
      "tree",
      "fountain",
      "lamp",
      "sign",
      "campfire",
      "laptop",
    ] as PropKind[]) {
      expect(furnitureSprite(prop(kind), false, 0)).toBeNull();
    }
  });
});

describe("drawProp — vendored furniture", () => {
  it("anchors to the footprint bottom, centred across it", () => {
    const b = bank();
    const ctx = recorder();
    // 3×1 desk → DESK_FRONT 48×32: x = 2*16, y = 4*16 - 32.
    drawProp(
      ctx,
      cam,
      { prop: prop("desk", { w: 3 }), on: false, frame: 0 },
      b,
      0,
    );
    expect(ctx.of("drawImage")[0].args.slice(1)).toEqual([
      0, 0, 48, 32, 32, 32, 48, 32,
    ]);
    const ctx2 = recorder();
    // 2×1 bookshelf 32×16 → centred exactly; 1×1 plant 16×32 rises one tile.
    drawProp(ctx2, cam, { prop: prop("plant"), on: false, frame: 0 }, b, 0);
    expect(ctx2.of("drawImage")[0].args.slice(5)).toEqual([32, 32, 16, 32]);
  });

  it("surface items (pc, coffee) are lifted onto the desk top", () => {
    const b = bank();
    for (const kind of ["pc", "coffee"] as PropKind[]) {
      const ctx = recorder();
      drawProp(ctx, cam, { prop: prop(kind), on: true, frame: 1 }, b, 0);
      const [, , , , h, , dy] = ctx.of("drawImage")[0].args as number[];
      expect(dy).toBe(4 * 16 - h - SURFACE_LIFT);
    }
    expect(b.furniture).toHaveBeenCalledWith("PC_FRONT_ON_2");
  });

  it("the team table's 48×64 art rises one tile above its 3×3 footprint", () => {
    const ctx = recorder();
    drawProp(
      ctx,
      cam,
      { prop: prop("table", { w: 3, h: 3 }), on: false, frame: 0 },
      bank(),
      0,
    );
    // x = 2*16, bottom = (3+3)*16 = 96 → y = 96 - 64
    expect(ctx.of("drawImage")[0].args.slice(1)).toEqual([
      0, 0, 48, 64, 32, 32, 48, 64,
    ]);
  });

  it("a left-facing chair is drawn mirrored through a transform", () => {
    const ctx = recorder();
    drawProp(
      ctx,
      cam,
      { prop: prop("chair", { facing: "left" }), on: false, frame: 0 },
      bank(),
      0,
    );
    expect(ctx.calls.map((c) => c.op)).toEqual([
      "save",
      "translate",
      "scale",
      "drawImage",
      "restore",
    ]);
    expect(ctx.of("scale")[0].args).toEqual([-1, 1]);
  });

  it("a capacity rack or gauge draws its own art (render/capacity.ts), never the furniture bank", () => {
    for (const [kind, w, color] of [["rack", 1, RACK.cabinet], ["gauge", 2, GAUGE.plinth]] as const) {
      const ctx = recorder();
      const b = bank();
      drawProp(ctx, cam, { prop: prop(kind, { w }), on: false, frame: 0 }, b, 0);
      expect(b.furniture).not.toHaveBeenCalled();
      expect(ctx.of("fillRect").some((c) => c.fillStyle === color)).toBe(true);
    }
  });

  it("degrades to a footprint-sized block without art", () => {
    const empty = { ...bank(), furniture: vi.fn(() => null) };
    for (const b of [null, empty]) {
      const ctx = recorder();
      drawProp(
        ctx,
        cam,
        { prop: prop("sofa", { w: 2 }), on: false, frame: 0 },
        b,
        0,
      );
      expect(ctx.of("drawImage")).toHaveLength(0);
      expect(ctx.of("fillRect")[0].args).toEqual([32, 48, 32, 16]);
    }
  });
});

describe("drawProp — our own art", () => {
  const kinds: [PropKind, Partial<Prop>][] = [
    ["tree", { w: 2, h: 2 }],
    ["fountain", { w: 3, h: 3 }],
    ["lamp", {}],
    ["campfire", {}],
  ];

  it.each(kinds)(
    "%s draws procedurally (no images, no art needed)",
    (kind, over) => {
      const ctx = recorder();
      drawProp(
        ctx,
        cam,
        { prop: prop(kind, over), on: false, frame: 0 },
        null,
        0,
      );
      expect(ctx.of("drawImage")).toHaveLength(0);
      expect(ctx.of("fillRect").length).toBeGreaterThan(3);
    },
  );

  it("fountain and campfire animate with time and frame", () => {
    for (const [kind, over] of [kinds[1], kinds[3]]) {
      const frames = [0, 140, 280, 420].map((t) => {
        const ctx = recorder();
        drawProp(
          ctx,
          cam,
          { prop: prop(kind, over), on: false, frame: 0 },
          null,
          t,
        );
        return JSON.stringify(ctx.calls);
      });
      expect(new Set(frames).size).toBeGreaterThan(1);
      const byFrame = recorder();
      drawProp(
        byFrame,
        cam,
        { prop: prop(kind, over), on: false, frame: 1 },
        null,
        0,
      );
      expect(JSON.stringify(byFrame.calls)).toBe(frames[1]);
    }
  });

  it("lamp glow is a rounded halo, not a pale square: its bounding box corners stay unlit", () => {
    const ctx = recorder();
    drawProp(ctx, cam, { prop: prop("lamp"), on: false, frame: 0 }, null, 0);
    const glow = ctx
      .of("fillRect")
      .filter((c) => c.fillStyle.startsWith("rgba(255, 224, 138"));
    expect(glow.length).toBeGreaterThan(1);
    const boxes = glow.map((c) => c.args as number[]);
    const left = Math.min(...boxes.map(([x]) => x));
    const top = Math.min(...boxes.map(([, y]) => y));
    const lit = (px: number, py: number) =>
      boxes.some(
        ([x, y, w, h]) => px >= x && px < x + w && py >= y && py < y + h,
      );
    expect(lit(left, top)).toBe(false);
    expect(lit(left + 6, top + 6)).toBe(true);
  });

  it("sign draws only its board — the house name is the engine's one `house` label", () => {
    // Drawing the folder here too painted every house name twice (and this copy,
    // inside the z-sorted prop pass, could be hidden behind characters and trees).
    const ctx = recorder();
    drawProp(
      ctx,
      cam,
      { prop: prop("sign", { label: "agentstudio" }), on: false, frame: 0 },
      null,
      0,
    );
    expect(ctx.of("fillText")).toHaveLength(0);
    expect(ctx.of("fillRect").length).toBeGreaterThan(3);
  });
});

describe("drawProp — ambience (lamps and the campfire)", () => {
  const sky = (lightsOn: boolean, campfireLit: boolean): Ambience => ({
    phase: "afternoon",
    daylight: 0.8,
    tint: { color: "#000", alpha: 0 },
    weather: "rain",
    intensity: 0.5,
    wind: 0,
    lightsOn,
    campfireLit,
    stayIndoors: false,
  });
  const fillsOf = (kind: PropKind, amb?: Ambience, t = 0) => {
    const ctx = recorder();
    drawProp(ctx, cam, { prop: prop(kind), on: false, frame: 0 }, null, t, amb);
    return ctx;
  };

  it("a lamp is lit (glass + halo) only with lightsOn; without ambience it keeps the lit look", () => {
    const off = fillsOf("lamp", sky(false, true))
      .of("fillRect")
      .map((c) => c.fillStyle);
    expect(off).toContain(LAMP_GLASS_OFF);
    expect(off.some((c) => c.startsWith("rgba(255, 224, 138"))).toBe(false);
    const on = fillsOf("lamp", sky(true, true))
      .of("fillRect")
      .map((c) => c.fillStyle);
    expect(on).toContain("#ffe08a");
    expect(
      fillsOf("lamp")
        .of("fillRect")
        .map((c) => c.fillStyle),
    ).toEqual(on);
  });

  it("a campfire the rain put out: charred logs, no flame, a wisp of smoke that drifts", () => {
    const out = fillsOf("campfire", sky(true, false));
    const colors = out.of("fillRect").map((c) => c.fillStyle);
    expect(colors).toContain(CAMPFIRE_OUT.logs);
    expect(colors).not.toContain("#e8662a");
    const smoke = out
      .of("fillRect")
      .filter((c) => c.fillStyle === CAMPFIRE_OUT.smoke);
    expect(smoke.map((c) => c.alpha)).toEqual([1, 0.7, 1 - 2 * 0.3]);
    expect(out.globalAlpha).toBe(1);
    const later = fillsOf("campfire", sky(true, false), 140)
      .of("fillRect")
      .filter((c) => c.fillStyle === CAMPFIRE_OUT.smoke);
    expect(later.map((c) => c.args)).not.toEqual(smoke.map((c) => c.args));
    expect(
      fillsOf("campfire", sky(false, true))
        .of("fillRect")
        .map((c) => c.fillStyle),
    ).toContain("#e8662a");
  });
});

describe("drawProp — laptop (our own art)", () => {
  const draw = (facing: Prop["facing"], on: boolean, frame = 0, zoom = 1) => {
    const ctx = recorder();
    drawProp(
      ctx,
      { zoom, ox: 0, oy: 0 },
      { prop: prop("laptop", { facing }), on, frame },
      bank(),
      0,
    );
    return ctx;
  };
  const fills = (ctx: ReturnType<typeof recorder>) =>
    ctx.of("fillRect").map((c) => c.fillStyle);

  it("needs no vendored art", () => {
    const b = bank();
    const ctx = recorder();
    drawProp(
      ctx,
      cam,
      { prop: prop("laptop", { facing: "up" }), on: true, frame: 0 },
      b,
      0,
    );
    expect(ctx.of("drawImage")).toHaveLength(0);
    expect(b.furniture).not.toHaveBeenCalled();
  });

  it.each(["up", "down"] as const)(
    "facing %s: lit and glowing when on, dark when off",
    (facing) => {
      const on = fills(draw(facing, true));
      const off = fills(draw(facing, false));
      expect(on).toContain(LAPTOP.screenOn);
      expect(on).toContain(LAPTOP.glow);
      expect(off).not.toContain(LAPTOP.screenOn);
      expect(off).not.toContain(LAPTOP.glow);
      expect(off).not.toContain(LAPTOP.text);
    },
  );

  it("screen-side laptop shows a dark screen when off and flickering text when on", () => {
    expect(fills(draw("up", false))).toContain(LAPTOP.screenOff);
    const frames = [0, 1, 2].map((f) =>
      JSON.stringify(draw("up", true, f).calls),
    );
    expect(new Set(frames).size).toBe(3);
  });

  it("stays inside its tile, lifted onto the table, and scales with zoom", () => {
    for (const facing of ["up", "down"] as const) {
      for (const zoom of [1, 2, 3, 4]) {
        const boxes = draw(facing, true, 0, zoom)
          .of("fillRect")
          .map((c) => c.args as number[]);
        for (const [x, y, w, h] of boxes) {
          expect(x).toBeGreaterThanOrEqual(2 * 16 * zoom);
          expect(x + w).toBeLessThanOrEqual(3 * 16 * zoom);
          // never below the tile's bottom; the screen-side one rises into the table's middle row
          expect(y + h).toBeLessThanOrEqual(4 * 16 * zoom);
          expect(y).toBeGreaterThanOrEqual((4 * 16 - 32) * zoom);
        }
      }
    }
    const up = draw("up", false)
      .of("fillRect")
      .map((c) => c.args as number[]);
    expect(Math.max(...up.map(([, y, , h]) => y + h))).toBe(
      4 * 16 - UP_LAPTOP_LIFT - 7,
    );
  });
});

describe("drawProp — a city leader's workstation: its monitor from behind, its keyboard in front of the leader (our own art)", () => {
  const lead = (): Prop => ({ ...prop("monitor"), w: 2 });
  const draw = (on: boolean, zoom = 1, frame = 0) => {
    const ctx = recorder();
    const b = bank();
    drawProp(ctx, { zoom, ox: 0, oy: 0 }, { prop: lead(), on, frame }, b, 0);
    return { ctx, b };
  };
  const fills = (ctx: ReturnType<typeof recorder>) => ctx.of("fillRect").map((c) => c.fillStyle);
  const rectsOf = (ctx: ReturnType<typeof recorder>, color: string) => ctx.of("fillRect").filter((c) => c.fillStyle === color).map((c) => c.args as number[]);

  it("needs no vendored art: a back panel on a stand, its LED and glow only while its owner works", () => {
    const on = draw(true);
    const off = draw(false);
    expect(on.ctx.of("drawImage")).toHaveLength(0);
    expect(on.b.furniture).not.toHaveBeenCalled();
    expect(fills(on.ctx)).toEqual(expect.arrayContaining([MONITOR.glow, MONITOR.shell, MONITOR.rim, MONITOR.vent, MONITOR.ledOn]));
    expect(fills(on.ctx)).not.toContain(MONITOR.ledOff);
    expect(fills(off.ctx)).toContain(MONITOR.ledOff);
    expect(fills(off.ctx)).not.toContain(MONITOR.ledOn);
    expect(fills(off.ctx)).not.toContain(MONITOR.glow);
  });

  it("stands the monitor on the back of the big desk in its own (left) column, and scales with zoom", () => {
    for (const zoom of [1, 3]) {
      const monitorColours = new Set<string>([MONITOR.glow, MONITOR.shell, MONITOR.rim, MONITOR.vent, MONITOR.ledOn]);
      const parts = draw(true, zoom).ctx.of("fillRect").filter((c) => monitorColours.has(c.fillStyle)).map((c) => c.args as number[]);
      expect(parts.length).toBeGreaterThan(5);
      for (const [x, y, w, h] of parts) {
        expect(x).toBeGreaterThanOrEqual(2 * 16 * zoom);
        expect(x + w).toBeLessThanOrEqual(3 * 16 * zoom);
        // on the desk's top, never down its front: the desk art's board is ~5 px above the tile
        expect(y + h).toBeLessThanOrEqual((4 * 16 - 17) * zoom);
        expect(y).toBeGreaterThanOrEqual((4 * 16 - 32) * zoom);
      }
    }
  });

  it("lays the keyboard on the board in the right tile — the leader's column — low, so the face shows over it and the hands rest on it", () => {
    for (const zoom of [1, 3]) {
      const { ctx } = draw(false, zoom);
      const [board] = rectsOf(ctx, MONITOR.keyboard);
      const [x, y, w, h] = board;
      // Centred in the next column (where the leader sits), 12 px wide.
      expect(x + w / 2).toBe((3 * 16 + 8) * zoom);
      expect(w).toBe(12 * zoom);
      // On the board: from 20 px over the tile's bottom to 17 (its shadow below it), never down the desk's front.
      expect([y, y + h]).toEqual([(4 * 16 - 20) * zoom, (4 * 16 - 17) * zoom]);
      expect(rectsOf(ctx, MONITOR.keys)).toHaveLength(1);
      expect(rectsOf(ctx, MONITOR.keyShadow)).toHaveLength(1);
    }
  });

  it("lights one key while its owner types, hopping along the keys with the frames — none when idle", () => {
    expect(rectsOf(draw(false).ctx, MONITOR.keyLit)).toEqual([]);
    const at = (frame: number) => rectsOf(draw(true, 1, frame).ctx, MONITOR.keyLit);
    const xs = [0, 1, 2, 3, 4].map((f) => at(f)[0][0]);
    expect(xs).toEqual([0, 1, 2, 3, 4].map((i) => 16 * 3 + 3 + 2 * i));
    expect(at(5)).toEqual(at(0));
    // Always on the key row, inside the keys.
    const [keys] = rectsOf(draw(true).ctx, MONITOR.keys);
    for (let f = 0; f < 5; f++) {
      const [x, y, w] = at(f)[0];
      expect(y).toBe(keys[1]);
      expect(x).toBeGreaterThanOrEqual(keys[0]);
      expect(x + w).toBeLessThanOrEqual(keys[0] + keys[2]);
    }
  });
});



describe("drawProp — the Village's Seats hall (render/hall.ts)", () => {
  /** A hall prop at (2, 3): the whole 13 × 9 interior under the decor row, as engine/world.ts places it. */
  const hall = prop("hall", { w: 13, h: 9, capacity: "seats" });
  const reading: PropReading = {
    kind: "hall",
    hall: { cells: ["messages", "free-space", "autocompact-buffer"], usedPct: 11, tone: "ok" },
  };
  const viaProp = (timeMs: number, b: ReturnType<typeof bank> | null = bank(), r: PropReading | undefined = reading) => {
    const ctx = recorder();
    drawProp(ctx, cam, { prop: hall, on: false, frame: 0, reading: r }, b, timeMs);
    return { ctx };
  };
  const direct = (timeMs: number, r: PropReading | undefined = reading) => {
    const ctx = recorder();
    // The footprint's left (2 × 16) and bottom ((3 + 9) × 16), world px.
    drawHall(ctx, cam, 32, 192, r, timeMs);
    return ctx;
  };

  it("is drawHall at the footprint's left/bottom with the item's reading and the clock — never a sprite, never the fallback block", () => {
    for (const b of [bank(), null])
      for (const r of [reading, undefined])
        for (const t of [0, 3500, 61_250]) expect(viaProp(t, b, r).ctx.calls).toEqual(direct(t, r).calls);
    const b = bank();
    const { ctx } = viaProp(0, b);
    expect(b.furniture).not.toHaveBeenCalled();
    expect(ctx.of("drawImage")).toHaveLength(0);
    expect(furnitureSprite(hall, false, 0)).toBeNull();
    // Not the footprint-sized block a prop without art degrades to (13 × 9 tiles in its fallback colour).
    expect(ctx.of("fillRect").some((c) => c.args[2] === 208 && c.args[3] === 144)).toBe(false);
    expect(ctx.of("fillRect").some((c) => c.fillStyle === "#6a1f2b" && c.args[2] === 208)).toBe(false);
    // The reading really reaches it: the messages seat's shirt is purple.
    expect(ctx.of("fillRect").some((c) => c.fillStyle === "#a371f7")).toBe(true);
  });

  it("the clock reaches it in ms: the audience shifts in its seats as time passes, the same at the same time", () => {
    const full: PropReading = { kind: "hall", hall: { cells: new Array(200).fill("messages"), usedPct: 100, tone: "danger" } };
    const at = (t: number) => JSON.stringify(viaProp(t, bank(), full).ctx.calls);
    expect(at(1234)).toBe(at(1234));
    // Over a minute (sampled every quarter second) somebody shifts: the frames are not all the same.
    expect(new Set(Array.from({ length: 240 }, (_, k) => at(k * 250))).size).toBeGreaterThan(1);
  });
});

describe("drawProp — a project room's Wi-Fi router (render/router.ts)", () => {
  const viaProp = (on: boolean, frame: number, b: ReturnType<typeof bank> | null = bank()) => {
    const ctx = recorder();
    drawProp(ctx, cam, { prop: prop("router"), on, frame }, b, 0);
    return ctx;
  };
  const direct = (on: boolean, frame: number) => {
    const ctx = recorder();
    drawRouter(ctx, cam, 2 * 16, 4 * 16, on, frame);
    return ctx;
  };

  it("is drawRouter at the footprint's left/bottom with the item's `on` and `frame` — never a sprite, never the fallback block", () => {
    for (const b of [bank(), null])
      for (const on of [true, false])
        for (const frame of [0, 1, 2]) expect(viaProp(on, frame, b).calls).toEqual(direct(on, frame).calls);
    expect(viaProp(true, 0).of("drawImage")).toHaveLength(0);
    expect(furnitureSprite(prop("router"), true, 0)).toBeNull();
  });
});

describe("drawProp — the Tokyo theme's props (render/tokyoProps.ts)", () => {
  const night = { lightsOn: true } as Ambience;
  const day = { lightsOn: false } as Ambience;
  const viaProp = (kind: "sakura" | "vending" | "torii", timeMs: number, amb?: Ambience) => {
    const ctx = recorder();
    drawProp(ctx, cam, { prop: prop(kind, { id: `k:${kind}` }), on: false, frame: 0 }, bank(), timeMs, amb);
    return ctx.calls;
  };
  const direct = (paint: (ctx: ReturnType<typeof recorder>) => void) => {
    const ctx = recorder();
    paint(ctx);
    return ctx.calls;
  };

  it("sakura: drawSakura at the footprint with the clock in seconds (its petals fall with time)", () => {
    expect(viaProp("sakura", 2500)).toEqual(direct((c) => drawSakura(c, cam, 2 * 16, (3 + 1) * 16, 2.5)));
    expect(viaProp("sakura", 2500)).not.toEqual(viaProp("sakura", 3100));
  });

  it("vending: drawVending with the variant from its id, lit by the ambience's lights", () => {
    for (const amb of [day, night, undefined])
      expect(viaProp("vending", 0, amb)).toEqual(
        direct((c) => drawVending(c, cam, 2 * 16, (3 + 1) * 16, vendingVariant("k:vending"), amb?.lightsOn ?? false)),
      );
    expect(viaProp("vending", 0, night)).not.toEqual(viaProp("vending", 0, day));
  });

  it("torii: drawTorii at the footprint — never a sprite, never the fallback block", () => {
    expect(viaProp("torii", 0)).toEqual(direct((c) => drawTorii(c, cam, 2 * 16, (3 + 1) * 16)));
    expect(furnitureSprite(prop("torii"), false, 0)).toBeNull();
  });
});
