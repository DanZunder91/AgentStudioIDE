import { describe, expect, it, vi } from "vitest";

import {
  clipLabel,
  drawLabel,
  LABEL_GAP,
  layoutLabel,
  overlaps,
  paintLabel,
  placeLabels,
  type Box,
} from "./labels";
import { recorder } from "./testRecorder";

describe("clipLabel", () => {
  it("keeps short text and ellipsises long text at 28 chars (or the given cap)", () => {
    expect(clipLabel("short")).toBe("short");
    const long = "x".repeat(40);
    expect(clipLabel(long)).toHaveLength(28);
    expect(clipLabel(long).endsWith("…")).toBe(true);
    expect(clipLabel(long, 18)).toHaveLength(18);
  });

  it("keeps agent tags compact (18 chars) and house boards up to 28", () => {
    const ctx = recorder();
    const cam = { zoom: 1, ox: 0, oy: 0 };
    expect(
      layoutLabel(ctx, cam, 0, 0, "happy-dancing-turtle-extra", "agent")!.text,
    ).toBe("happy-dancing-tur…");
    expect(
      layoutLabel(ctx, cam, 0, 0, "happy-dancing-turtle-extra", "house")!.text,
    ).toBe("happy-dancing-turtle-extra");
  });
});

describe("drawLabel", () => {
  it("draws a dark backing box then the text, centred on x and hanging from y, at screen scale", () => {
    const ctx = recorder();
    drawLabel(ctx, { zoom: 2, ox: 10, oy: 0 }, 50, 40, "  Explore  ", "agent");
    const [box] = ctx.of("fillRect");
    const [text] = ctx.of("fillText");
    // screen (110, 80); "Explore" = 42 px wide + 2×3 pad = 48; height 10 + 4.
    expect(box.args).toEqual([86, 80, 48, 14]);
    expect(box.fillStyle).toMatch(/rgba/);
    expect(text.args).toEqual(["Explore", 110, 87]);
    expect(text.font).toMatch(/^10px /);
    expect(ctx.textAlign).toBe("center");
    expect(ctx.textBaseline).toBe("middle");
  });

  it("house labels are bold and larger; everything grows 2 px from zoom 4", () => {
    const ctx = recorder();
    drawLabel(ctx, { zoom: 4, ox: 0, oy: 0 }, 0, 0, "repo", "house");
    expect(ctx.of("fillText")[0].font).toMatch(/^bold 14px /);
    const agent = recorder();
    drawLabel(agent, { zoom: 4, ox: 0, oy: 0 }, 0, 0, "repo", "agent");
    expect(agent.of("fillText")[0].font).toMatch(/^12px /);
  });

  it("measures each (font, text) once, not every frame — and stays bounded", () => {
    const ctx = recorder();
    const measure = vi.spyOn(ctx, "measureText");
    const cam = { zoom: 1, ox: 0, oy: 0 };
    for (let i = 0; i < 5; i++)
      drawLabel(ctx, cam, 0, 0, "cached-once", "agent");
    expect(measure).toHaveBeenCalledTimes(1);
    drawLabel(ctx, cam, 0, 0, "cached-once", "house"); // another font → measured
    expect(measure).toHaveBeenCalledTimes(2);
    // Past the cap the cache starts over instead of growing without end.
    for (let i = 0; i < 600; i++) drawLabel(ctx, cam, 0, 0, `n${i}`, "agent");
    measure.mockClear();
    drawLabel(ctx, cam, 0, 0, "cached-once", "agent");
    expect(measure).toHaveBeenCalledTimes(1);
    // Every draw still uses the right width.
    expect(ctx.of("fillRect").at(-1)!.args[2]).toBe(
      "cached-once".length * 6 + 6,
    );
  });

  it("draws nothing for blank text", () => {
    const ctx = recorder();
    drawLabel(ctx, { zoom: 1, ox: 0, oy: 0 }, 0, 0, "   ", "agent");
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("layoutLabel", () => {
  it("centres a house board on its anchor and scales every label by the pixel ratio", () => {
    const ctx = recorder();
    const cam = { zoom: 2, ox: 0, oy: 0 };
    // "repo" bold 12 px: 24 + 2×5 pad = 34 wide, 16 tall, centred on (100, 60).
    expect(layoutLabel(ctx, cam, 50, 30, "repo", "house")!.box).toEqual({
      x: 83,
      y: 52,
      w: 34,
      h: 16,
    });
    // At 2× the font, padding and height double (and zoom 8 at 2× is "zoom 4" → +2 px).
    const hi = layoutLabel(
      ctx,
      { zoom: 8, ox: 0, oy: 0 },
      0,
      0,
      "repo",
      "agent",
      2,
    )!;
    expect(hi.font).toMatch(/^24px /);
    expect(hi.box.h).toBe(24 + 8);
    expect(hi.box.w).toBe(24 + 2 * 6);
    // A nonsense ratio falls back to 1.
    expect(layoutLabel(ctx, cam, 0, 0, "repo", "agent", 0)!.font).toMatch(
      /^10px /,
    );
    expect(layoutLabel(ctx, cam, 0, 0, "  ", "agent")).toBeNull();
  });
});

describe("paintLabel", () => {
  it("frames a house board with a 1 px border; agent tags have none", () => {
    const ctx = recorder();
    const strokes: unknown[][] = [];
    ctx.strokeRect = (...args) => strokes.push(args);
    const cam = { zoom: 1, ox: 0, oy: 0 };
    const house = layoutLabel(ctx, cam, 0, 0, "repo", "house")!;
    paintLabel(ctx, house, { x: 10, y: 20, w: 30, h: 16 });
    expect(strokes).toEqual([[10.5, 20.5, 29, 15]]);
    expect(ctx.of("fillRect")[0].args).toEqual([10, 20, 30, 16]);
    expect(ctx.of("fillText")[0].args).toEqual(["repo", 25, 28]);
    paintLabel(ctx, layoutLabel(ctx, cam, 0, 0, "a", "agent")!, {
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
    expect(strokes).toHaveLength(1);
  });
});

describe("label collision avoidance", () => {
  const box = (x: number, y: number, w = 40, h = 14): Box => ({ x, y, w, h });

  it("overlaps() treats boxes closer than the gap as colliding", () => {
    expect(overlaps(box(0, 0), box(10, 5))).toBe(true);
    expect(overlaps(box(0, 0), box(40 + LABEL_GAP, 0))).toBe(false);
    expect(overlaps(box(0, 0), box(40 + LABEL_GAP - 1, 0))).toBe(true);
    expect(overlaps(box(0, 0), box(0, 14 + LABEL_GAP))).toBe(false);
    expect(overlaps(box(0, 20), box(0, 0))).toBe(false);
    expect(overlaps(box(50, 0), box(0, 0))).toBe(false);
  });

  it("places greedily in rank order: keeps clear labels, nudges one line down, then drops", () => {
    const placed = placeLabels([
      { box: box(0, 0), force: false }, // first: placed as is
      { box: box(100, 0), force: false }, // clear of it: placed as is
      { box: box(10, 0), force: false }, // collides → nudged one line down
      { box: box(20, 0), force: false }, // collides at both spots → dropped
    ]);
    expect(placed).toEqual([
      box(0, 0),
      box(100, 0),
      box(10, 14 + LABEL_GAP),
      null,
    ]);
  });

  it("always places forced labels (house boards, the hovered tag) where they are, and others avoid them", () => {
    const placed = placeLabels([
      { box: box(0, 0), force: true },
      { box: box(5, 0), force: true }, // forced over the first — still drawn, unmoved
      { box: box(10, 0), force: false }, // must avoid both → one line down
    ]);
    expect(placed).toEqual([box(0, 0), box(5, 0), box(10, 16)]);
    expect(placeLabels([])).toEqual([]);
  });
});

describe("the city's labels", () => {
  const cam = { zoom: 2, ox: 10, oy: 0 };

  it("a floor plate STARTS at its anchor (the floor's left wall) and is centred on it vertically", () => {
    const ctx = recorder();
    // anchor (50, 40) → screen (110, 80); "zsh" = 18 px + 2×4 pad = 26 wide; 10 px + 4 = 14 tall.
    const plate = layoutLabel(ctx, cam, 50, 40, "zsh", "floor")!;
    expect(plate.box).toEqual({ x: 110, y: 73, w: 26, h: 14 });
    expect(plate.font).toMatch(/^10px /);
    // A long tab name is clipped, but plates have more room than an agent's tag.
    expect(layoutLabel(ctx, cam, 0, 0, "x".repeat(40), "floor")!.text).toHaveLength(24);
  });

  it("a plate with a world width cap never spills past it at a small zoom: clipped, or not drawn", () => {
    const ctx = recorder();
    const small = { zoom: 0.5, ox: 0, oy: 0 };
    // 160 world px at ½ = 80 screen px: 8 px of pad leaves 72 px = 12 characters (6 px each).
    const plate = layoutLabel(ctx, small, 0, 0, "quiet-running-otter", "floor", 1, 160)!;
    expect(plate.text).toBe("quiet-runni…");
    expect(plate.box.w).toBeLessThanOrEqual(80);
    // Room to spare: the whole name.
    expect(layoutLabel(ctx, small, 0, 0, "zsh", "floor", 1, 160)!.text).toBe("zsh");
    // No room even for one letter and an ellipsis: no plate at all.
    expect(layoutLabel(ctx, small, 0, 0, "zsh", "floor", 1, 16)).toBeNull();
    // At a whole zoom the cap is wide enough not to matter.
    expect(layoutLabel(ctx, cam, 0, 0, "quiet-running-otter", "floor", 1, 160)!.text).toBe("quiet-running-otter");
  });

  it("a civic board (capacity house / HQ plate) is a bold 11 px slate plate CENTRED on its anchor, with a border", () => {
    const ctx = recorder();
    const strokes: unknown[][] = [];
    ctx.strokeRect = (...args) => strokes.push(args);
    // "Seats 3/10" = 10 chars × 6 px = 60 + 2×5 pad = 70 wide; 11 px + 4 = 15 tall; centred on (110, 80).
    const civic = layoutLabel(ctx, cam, 50, 40, "Seats 3/10", "civic")!;
    expect(civic.box).toEqual({ x: 75, y: 73, w: 70, h: 15 });
    expect(civic.font).toMatch(/^bold 11px /);
    paintLabel(ctx, civic, civic.box);
    expect(strokes).toHaveLength(1);
    expect(ctx.of("fillRect").at(-1)!.fillStyle).toBe("#2c3e5a");
  });

  it("a gauge caption is a small 9 px tag CENTRED on its anchor, with no border", () => {
    const ctx = recorder();
    const strokes: unknown[][] = [];
    ctx.strokeRect = (...args) => strokes.push(args);
    // "5h 41%" = 6 chars × 6 px = 36 + 2×3 pad = 42 wide; 9 px + 4 = 13 tall; centred on (110, 80).
    const g = layoutLabel(ctx, cam, 50, 40, "5h 41%", "gauge")!;
    expect(g.box).toEqual({ x: 89, y: 74, w: 42, h: 13 });
    expect(g.font).toMatch(/^9px /);
    paintLabel(ctx, g, g.box);
    expect(strokes).toHaveLength(0);
  });

  it("paints a floor plate on its dark backing, framed by a border", () => {
    const ctx = recorder();
    const strokes: unknown[][] = [];
    ctx.strokeRect = (...args) => strokes.push(args);
    const plate = layoutLabel(ctx, cam, 0, 0, "zsh", "floor")!;
    paintLabel(ctx, plate, plate.box);
    expect(strokes).toHaveLength(1);
    expect(ctx.of("fillRect").at(-1)!.fillStyle).toBe("rgba(38, 30, 24, 0.84)");
    expect(ctx.of("fillText").map((t) => t.args[0])).toEqual(["zsh"]);
  });
});
