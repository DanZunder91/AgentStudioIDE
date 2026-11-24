import { describe, expect, it, vi } from "vitest";

import { SEAT_LIFT, type CharacterView } from "../villageTypes";
import {
  MARKER_EXTERNAL,
  MARKER_IDE,
  characterBox,
  characterFrame,
  drawBubble,
  drawCharacter,
  headTop,
} from "./characters";
import type { SpriteBank, SpriteImage } from "./renderTypes";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
const SHEET = { sheet: true } as unknown as SpriteImage;

function view(over: Partial<CharacterView> = {}): CharacterView {
  return {
    key: "a",
    x: 100,
    y: 80,
    dir: "down",
    anim: "idle",
    frame: 0,
    palette: 0,
    hueShift: 0,
    seated: false,
    origin: "ide",
    isSubagent: false,
    activity: "idle",
    label: "a",
    tool: null,
    bubble: null,
    bubbleAlpha: 0,
    fx: null,
    ...over,
  };
}

function bank(): SpriteBank & { character: ReturnType<typeof vi.fn> } {
  return {
    fallback: false,
    character: vi.fn(() => SHEET),
    floor: () => null,
    wall: () => null,
    furniture: () => null,
  };
}

/** All pixels (world coords at zoom 1) painted with `color`. */
const pixelsOf = (ctx: RecordingTarget, color: string) =>
  ctx
    .of("fillRect")
    .filter((c) => c.fillStyle === color)
    .map((c) => c.args.slice(0, 2));

describe("characterFrame", () => {
  it("walk cycles 0,1,2,1; idle is col 1; type 3-4; read 5-6", () => {
    expect(
      [0, 1, 2, 3, 4, -1].map(
        (frame) => characterFrame({ dir: "down", anim: "walk", frame }).col,
      ),
    ).toEqual([0, 1, 2, 1, 0, 1]);
    expect(characterFrame({ dir: "down", anim: "idle", frame: 3 }).col).toBe(1);
    expect(
      [0, 1, 2].map(
        (frame) => characterFrame({ dir: "up", anim: "type", frame }).col,
      ),
    ).toEqual([3, 4, 3]);
    expect(
      [0, 1].map(
        (frame) => characterFrame({ dir: "up", anim: "read", frame }).col,
      ),
    ).toEqual([5, 6]);
  });

  it("rows: down 0, up 1, right 2, left 2 mirrored", () => {
    expect(
      characterFrame({ dir: "down", anim: "idle", frame: 0 }),
    ).toMatchObject({ row: 0, flip: false });
    expect(characterFrame({ dir: "up", anim: "idle", frame: 0 })).toMatchObject(
      { row: 1, flip: false },
    );
    expect(
      characterFrame({ dir: "right", anim: "idle", frame: 0 }),
    ).toMatchObject({ row: 2, flip: false });
    expect(
      characterFrame({ dir: "left", anim: "idle", frame: 0 }),
    ).toMatchObject({ row: 2, flip: true });
  });
});

describe("characterBox", () => {
  it("is exactly where the sprite frame is blitted — standing, seated, at a fractional position", () => {
    for (const c of [view(), view({ seated: true }), view({ x: 100.6, y: 79.4 })]) {
      const ctx = recorder();
      drawCharacter(ctx, { zoom: 1, ox: 0, oy: 0 }, c, bank());
      expect(characterBox(c)).toEqual(ctx.of("drawImage")[0].args.slice(5));
    }
  });
});

describe("drawCharacter", () => {
  it("blits the 16×32 frame with its feet on (x, y), with the hue-shifted sheet", () => {
    const b = bank();
    const ctx = recorder();
    drawCharacter(
      ctx,
      { zoom: 3, ox: 5, oy: 7 },
      view({ anim: "walk", frame: 2, dir: "up", palette: 4, hueShift: 90 }),
      b,
    );
    expect(b.character).toHaveBeenCalledWith(4, 90);
    // col 2, row 1 → src (32, 32); world (92, 49) → screen (5 + 276, 7 + 147).
    expect(ctx.of("drawImage")[0].args).toEqual([
      SHEET,
      32,
      32,
      16,
      32,
      281,
      154,
      48,
      96,
    ]);
    expect(ctx.of("fillRect")[0].fillStyle).toMatch(/rgba\(0, 0, 0/); // ground shadow first
  });

  it("snaps fractional positions to whole art pixels", () => {
    const ctx = recorder();
    drawCharacter(ctx, cam, view({ x: 100.4, y: 79.6 }), bank());
    expect(ctx.of("drawImage")[0].args.slice(5, 7)).toEqual([92, 49]);
  });

  it("left-facing frames are mirrored; seated characters cast no shadow", () => {
    const ctx = recorder();
    drawCharacter(
      ctx,
      cam,
      view({ dir: "left", seated: true, anim: "type" }),
      bank(),
    );
    expect(ctx.calls.slice(0, 5).map((c) => c.op)).toEqual([
      "save",
      "translate",
      "scale",
      "drawImage",
      "restore",
    ]);
    expect(ctx.of("drawImage")[0].args.slice(1, 3)).toEqual([48, 64]);
  });

  it("IDE agents get an accent-blue diamond above the head, external agents a grey one", () => {
    const ide = recorder();
    drawCharacter(ide, cam, view({ origin: "ide" }), bank());
    const ext = recorder();
    drawCharacter(ext, cam, view({ origin: "external" }), bank());
    const diamond = pixelsOf(ide, MARKER_IDE);
    expect(diamond).toHaveLength(5);
    expect(pixelsOf(ext, MARKER_EXTERNAL)).toEqual(diamond);
    // apex 7 px above the head top
    expect(diamond[0]).toEqual([100, headTop(view()) - 7]);
  });

  it("seated characters are raised so the head clears the chair back (sprite, head and marker)", () => {
    expect(headTop(view({ seated: true }))).toBe(headTop(view()) - SEAT_LIFT);
    const standing = recorder();
    drawCharacter(standing, cam, view(), bank());
    const seated = recorder();
    drawCharacter(seated, cam, view({ seated: true }), bank());
    const dy = (r: RecordingTarget) => r.of("drawImage")[0].args[6] as number;
    expect(dy(seated)).toBe(dy(standing) - SEAT_LIFT * cam.zoom);
    // …and so is the no-art body block.
    const body = (r: RecordingTarget) =>
      r
        .of("fillRect")
        .find((f) => f.args[2] === 8 * cam.zoom && f.args[3] === 16 * cam.zoom)!
        .args[1] as number;
    const s0 = recorder();
    drawCharacter(s0, cam, view(), null);
    const s1 = recorder();
    drawCharacter(s1, cam, view({ seated: true }), null);
    expect(body(s1)).toBe(body(s0) - SEAT_LIFT * cam.zoom);
  });

  it("without art: a coloured body + head block, still marked", () => {
    for (const b of [null, { ...bank(), character: vi.fn(() => null) }]) {
      const ctx = recorder();
      drawCharacter(ctx, cam, view({ palette: 7 }), b);
      expect(ctx.of("drawImage")).toHaveLength(0);
      expect(ctx.of("fillRect")[1].fillStyle).toBe("#3d6fc4"); // palette 7 wraps → 1
      expect(pixelsOf(ctx, MARKER_IDE)).toHaveLength(5);
    }
  });

  it("without art a spawn fades in and a despawn fades out; no marker during the effect", () => {
    const spawn = recorder();
    drawCharacter(spawn, cam, view({ fx: { kind: "spawn", t: 0.25 } }), null);
    expect(spawn.of("fillRect").map((c) => c.alpha)).toEqual([0.25, 0.25]);
    const despawn = recorder();
    drawCharacter(despawn, cam, view({ fx: { kind: "despawn", t: 2 } }), null);
    expect(despawn.of("fillRect").map((c) => c.alpha)).toEqual([0, 0]);
    expect(despawn.globalAlpha).toBe(1);
  });
});

describe("matrix rain spawn/despawn", () => {
  /** Total sprite rows drawn (sum of column-slice heights) and the rows touched. */
  function slices(ctx: RecordingTarget) {
    const imgs = ctx.of("drawImage");
    const rows = imgs.reduce((n, c) => n + (c.args[4] as number), 0);
    const maxRow = Math.max(
      -1,
      ...imgs.map((c) => (c.args[2] as number) + (c.args[4] as number) - 1),
    );
    return {
      count: imgs.length,
      rows,
      maxRow,
      srcCols: new Set(imgs.map((c) => c.args[1] as number)),
    };
  }

  it("spawn at t=1 reveals the whole frame — all 16 columns × all 32 rows (not 24)", () => {
    const ctx = recorder();
    drawCharacter(ctx, cam, view({ fx: { kind: "spawn", t: 1 } }), bank());
    const s = slices(ctx);
    expect(s.rows).toBe(16 * 32);
    expect(s.maxRow).toBe(31);
    expect(s.srcCols.size).toBe(16);
    expect(ctx.of("save")).toHaveLength(0); // column slices, never a transform
  });

  it("spawn at t=0 shows no sprite; despawn at t=1 has consumed it all", () => {
    const start = recorder();
    drawCharacter(start, cam, view({ fx: { kind: "spawn", t: 0 } }), bank());
    expect(slices(start).rows).toBe(0);
    const end = recorder();
    drawCharacter(end, cam, view({ fx: { kind: "despawn", t: 1.5 } }), bank());
    expect(slices(end).rows).toBe(0);
    expect(end.of("fillRect")).toHaveLength(0);
  });

  it("mid-effect: green rain trails a bright head, top-to-bottom, with fading alpha", () => {
    for (const kind of ["spawn", "despawn"] as const) {
      const ctx = recorder();
      drawCharacter(ctx, cam, view({ fx: { kind, t: 0.5 } }), bank());
      const heads = pixelsOf(ctx, "#ccffcc");
      expect(heads.length).toBeGreaterThan(0);
      const rain = ctx.of("fillRect").filter((c) => c.fillStyle !== "#ccffcc");
      expect(rain.length).toBeGreaterThan(0);
      expect(new Set(rain.map((c) => c.alpha)).size).toBeGreaterThan(1);
      expect(rain.every((c) => c.alpha > 0 && c.alpha <= 1)).toBe(true);
      const { rows } = slices(ctx);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(16 * 32);
      expect(ctx.globalAlpha).toBe(1);
    }
  });

  it("despawn at t=0 still shows (almost) the whole sprite; spawn progresses monotonically", () => {
    const ctx = recorder();
    drawCharacter(ctx, cam, view({ fx: { kind: "despawn", t: 0 } }), bank());
    expect(slices(ctx).rows).toBeGreaterThan(16 * 30);
    const revealed = [0.2, 0.4, 0.6, 0.8, 1].map((t) => {
      const c = recorder();
      drawCharacter(c, cam, view({ fx: { kind: "spawn", t } }), bank());
      return slices(c).rows;
    });
    expect([...revealed].sort((a, b) => a - b)).toEqual(revealed);
  });

  it("a mirrored character reads its columns right-to-left", () => {
    const ctx = recorder();
    drawCharacter(
      ctx,
      cam,
      view({ dir: "left", fx: { kind: "spawn", t: 1 } }),
      bank(),
    );
    const first = ctx.of("drawImage")[0].args;
    // displayed column 0 comes from source column 15 of the right-facing frame (row 2, col 1).
    expect(first[1]).toBe(16 + 15);
    expect(first[5]).toBe(92);
  });
});

describe("drawBubble", () => {
  it("nothing without a bubble or at zero alpha", () => {
    const ctx = recorder();
    drawBubble(ctx, cam, view());
    drawBubble(ctx, cam, view({ bubble: "done", bubbleAlpha: 0 }));
    expect(ctx.calls).toHaveLength(0);
  });

  it.each([
    ["waiting", "#d9a400", 3],
    ["done", "#2e9e44", 7],
    ["error", "#d33a3a", 2],
  ] as const)(
    "%s: a framed bubble over the marker with its icon, at bubbleAlpha",
    (bubble, color, n) => {
      const ctx = recorder();
      drawBubble(ctx, cam, view({ bubble, bubbleAlpha: 0.6 }));
      const icon = ctx.of("fillRect").filter((c) => c.fillStyle === color);
      expect(icon).toHaveLength(n);
      expect(ctx.of("fillRect").every((c) => c.alpha === 0.6)).toBe(true);
      expect(ctx.globalAlpha).toBe(1);
      // the bubble's box sits entirely above the marker's apex
      const box = ctx.of("fillRect")[0].args as number[];
      expect(box[1] + box[3]).toBeLessThanOrEqual(headTop(view()) - 7);
    },
  );

  it("caps alpha at 1", () => {
    const ctx = recorder();
    drawBubble(ctx, cam, view({ bubble: "error", bubbleAlpha: 3 }));
    expect(ctx.of("fillRect")[0].alpha).toBe(1);
  });
});
