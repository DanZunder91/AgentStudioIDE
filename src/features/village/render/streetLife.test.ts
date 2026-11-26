import { describe, expect, it, vi } from "vitest";

import { VEND, type WalkerItem } from "../engine/streetLife";
import { TILE, type Ambience, type DrawItem, type WalkerVend, type World } from "../villageTypes";
import { MARKER_EXTERNAL, MARKER_IDE } from "./characters";
import { renderFrame } from "./frame";
import type { SpriteBank, SpriteImage } from "./renderTypes";
import {
  BLINK_SEC,
  BOUNCE_SEC,
  BUTTON_UP,
  BUTTON_X,
  CAN,
  canSpot,
  COIN,
  drawVend,
  drawWalker,
  drinkColor,
  FALLBACK,
  FLASH,
  GLINT,
  HOLD,
  PAY_GLINT,
  SHADOW,
  SIP,
  TRAY,
  walkerBox,
} from "./streetLife";
import { recorder, type RecordingTarget } from "./testRecorder";
import { drawVending, VENDING, vendingVariant } from "./tokyoProps";
import { CANOPIES, SHAFT } from "./umbrella";

const cam = { zoom: 1, ox: 0, oy: 0 };
const SHEET = { sheet: true } as unknown as SpriteImage;
function bank(): SpriteBank & { character: ReturnType<typeof vi.fn> } {
  return { fallback: false, character: vi.fn(() => SHEET), floor: () => null, wall: () => null, furniture: () => null };
}

type Fill = { x: number; y: number; w: number; h: number; style: string };
const fills = (ctx: RecordingTarget): Fill[] =>
  ctx.of("fillRect").map((c) => {
    const [x, y, w, h] = c.args as number[];
    return { x, y, w, h, style: c.fillStyle };
  });
const of = (ctx: RecordingTarget, style: string) => fills(ctx).filter((f) => f.style === style);

function walker(over: Partial<WalkerItem> = {}): WalkerItem {
  return { t: "walker", id: 1, x: 100, y: 200, dir: "right", anim: "walk", frame: 1, palette: 2, hueShift: 15, sink: 0, umbrella: 0, canopy: 0, vend: null, drink: null, ...over };
}

/** A machine at x0 = 160, standing on y = 200. */
const M = { x0: 160, bottom: 200, machine: "tokyo:vending:10,12" };
const vend = (t: number, button = 2): WalkerVend => ({ ...M, button, t });

/** World rect [x, y, w, h] the sprite was blitted to (a mirrored one is drawn at 0,0 after a translate). */
function spriteRect(ctx: RecordingTarget): [number, number, number, number] {
  const [, , , , , dx, dy, dw, dh] = ctx.of("drawImage")[0].args as number[];
  const t = ctx.of("translate")[0];
  if (!t) return [dx, dy, dw, dh];
  const [tx, ty] = t.args as number[];
  return [tx - dw, ty, dw, dh];
}

/** The colour the machine's art paints at world px (x, y) (the last fill covering it), at zoom 1. */
function machinePixel(x: number, y: number, id = M.machine): string | null {
  const ctx = recorder();
  drawVending(ctx, cam, M.x0, M.bottom, vendingVariant(id), false);
  let out: string | null = null;
  for (const f of fills(ctx)) if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) out = f.style;
  return out;
}

describe("drawWalker: the person", () => {
  it("is its sheet's walk frame, feet on (x, y), with a shadow — and no agent marker, no bubble", () => {
    const b = bank();
    const ctx = recorder();
    drawWalker(ctx, cam, walker(), b, 0);
    expect(b.character).toHaveBeenCalledWith(2, 15);
    const img = ctx.of("drawImage");
    expect(img).toHaveLength(1);
    // Walk frame 1 → sheet column 1; facing right → row 2; 16 × 32 from (x − 8, y − 31).
    expect(img[0].args).toEqual([SHEET, 16, 64, 16, 32, 92, 169, 16, 32]);
    expect(of(ctx, SHADOW)).toEqual([{ x: 95, y: 198, w: 10, h: 2, style: SHADOW }]);
    expect(of(ctx, MARKER_IDE)).toHaveLength(0);
    expect(of(ctx, MARKER_EXTERNAL)).toHaveLength(0);
    expect(fills(ctx)).toHaveLength(1);
  });

  it("heading left is the right-facing frame mirrored; standing at a machine it is the idle pose", () => {
    const ctx = recorder();
    drawWalker(ctx, cam, walker({ dir: "left", frame: 2 }), bank(), 0);
    expect(ctx.of("scale")[0].args).toEqual([-1, 1]);
    expect(ctx.of("drawImage")[0].args.slice(1, 5)).toEqual([32, 64, 16, 32]);
    const idle = recorder();
    drawWalker(idle, cam, walker({ anim: "idle", frame: 3 }), bank(), 0);
    expect(idle.of("drawImage")[0].args.slice(1, 3)).toEqual([16, 64]);
  });

  it("on the subway stairs it is drawn `sink` px lower and cut at the sidewalk: no shadow, only the rows still above it — none at all once under", () => {
    for (const sink of [1, 10, 31]) {
      const ctx = recorder();
      drawWalker(ctx, cam, walker({ sink }), bank(), 0);
      const [, , sy, , sh, , dy, , dh] = ctx.of("drawImage")[0].args as number[];
      expect(sy).toBe(64);
      expect(sh).toBe(32 - sink);
      expect(dy).toBe(200 + sink - 31);
      expect(dh).toBe(32 - sink);
      // The cut is the feet's line: nothing drawn below y + 1.
      expect(dy + dh).toBe(201);
      expect(of(ctx, SHADOW)).toHaveLength(0);
    }
    const gone = recorder();
    drawWalker(gone, cam, walker({ sink: 32 }), bank(), 0);
    expect(gone.calls).toHaveLength(0);
  });

  it("without art it is a plain body and head — cut on the stairs the same way", () => {
    const ctx = recorder();
    drawWalker(ctx, cam, walker(), null, 0);
    const body = FALLBACK.body[2];
    expect(of(ctx, body)).toEqual([{ x: 96, y: 182, w: 8, h: 16, style: body }]);
    expect(of(ctx, FALLBACK.head)).toEqual([{ x: 97, y: 171, w: 6, h: 7, style: FALLBACK.head }]);
    // 10 px down: the body's last rows are under the sidewalk.
    const low = recorder();
    drawWalker(low, cam, walker({ sink: 10 }), null, 0);
    expect(of(low, body)).toEqual([{ x: 96, y: 192, w: 8, h: 9, style: body }]);
    expect(of(low, FALLBACK.head)).toEqual([{ x: 97, y: 181, w: 6, h: 7, style: FALLBACK.head }]);
    // 25 px down: only the head's top shows; the body is gone.
    const lower = recorder();
    drawWalker(lower, cam, walker({ sink: 25 }), null, 0);
    expect(of(lower, body)).toHaveLength(0);
    expect(of(lower, FALLBACK.head)).toEqual([{ x: 97, y: 196, w: 6, h: 5, style: FALLBACK.head }]);
    // 30 px down: nothing.
    const under = recorder();
    drawWalker(under, cam, walker({ sink: 30, palette: -1 }), null, 0);
    expect(of(under, FALLBACK.head)).toHaveLength(0);
    // A negative or large palette wraps.
    const wrap = recorder();
    drawWalker(wrap, cam, walker({ palette: 7 }), null, 0);
    expect(of(wrap, FALLBACK.body[1])).toHaveLength(1);
  });

  it("its umbrella: the stick behind it, the canopy over it; none when closed", () => {
    const ctx = recorder();
    drawWalker(ctx, cam, walker({ umbrella: 1, canopy: 3 }), bank(), 0);
    const order = ctx.calls.map((c) => (c.op === "drawImage" ? "sprite" : c.op === "fillRect" && c.fillStyle === SHAFT ? "shaft" : c.op === "fillRect" && c.fillStyle === CANOPIES[3].cloth ? "cloth" : null)).filter(Boolean);
    expect(order[0]).toBe("shaft");
    expect(order.indexOf("sprite")).toBeGreaterThan(0);
    expect(order.lastIndexOf("cloth")).toBeGreaterThan(order.indexOf("sprite"));
    expect(order.indexOf("cloth")).toBeGreaterThan(order.indexOf("sprite"));
    const none = recorder();
    drawWalker(none, cam, walker({ umbrella: 0, canopy: 3 }), bank(), 0);
    expect(of(none, SHAFT)).toHaveLength(0);
    expect(of(none, CANOPIES[3].cloth)).toHaveLength(0);
  });

  it("its umbrella leans with the wind the frame hands it", () => {
    const centre = (wind: number) => {
      const ctx = recorder();
      drawWalker(ctx, cam, walker({ umbrella: 1 }), bank(), wind);
      const top = of(ctx, CANOPIES[0].cloth)[0];
      return top.x + (top.w - 1) / 2;
    };
    expect(centre(1)).toBe(centre(0) - 2);
  });

  it("its can, after the sprite: at its hand in front of it, or raised to its mouth for a sip — in the drink's colour", () => {
    for (const [dir, sign] of [["right", 1], ["left", -1]] as const)
      for (const sip of [false, true]) {
        const ctx = recorder();
        const drink = { machine: M.machine, button: 4, sip };
        drawWalker(ctx, cam, walker({ dir, drink }), bank(), 0);
        const color = drinkColor(drink);
        const body = of(ctx, color);
        const top = of(ctx, CAN.top);
        expect(body).toHaveLength(1);
        expect(top).toHaveLength(1);
        const at = sip ? SIP : HOLD;
        expect(body[0].y).toBe(200 - at.up);
        expect([body[0].w, body[0].h]).toEqual([CAN.w, CAN.h]);
        // In front of the body: right of x heading right, left of it heading left.
        const near = sign > 0 ? body[0].x : body[0].x + body[0].w - 1;
        expect(near).toBe(100 + sign * at.dx);
        expect(top[0]).toMatchObject({ x: body[0].x, y: body[0].y, w: CAN.w, h: 1 });
        const sprite = ctx.calls.findIndex((c) => c.op === "drawImage");
        const can = ctx.calls.findIndex((c) => c.op === "fillRect" && c.fillStyle === color);
        expect(can).toBeGreaterThan(sprite);
      }
    // Sipping, the can is higher — at the mouth.
    expect(SIP.up).toBeGreaterThan(HOLD.up);
    expect(canSpot(100, 200, 1, true).y).toBeLessThan(canSpot(100, 200, 1, false).y);
  });

  it("walkerBox holds everything it draws — umbrella in a gale, can, a purchase on its machine", () => {
    const cases: WalkerItem[] = [
      walker({ umbrella: 1, canopy: 1, drink: { machine: M.machine, button: 0, sip: true } }),
      walker({ dir: "left", umbrella: 1, canopy: 5, drink: { machine: M.machine, button: 3, sip: false } }),
      walker({ x: M.x0 - 6, vend: vend(VEND.take + 0.01), umbrella: 1 }),
      walker({ x: M.x0 + TILE + 6, dir: "left", vend: vend(VEND.flash), umbrella: 1 }),
      walker({ x: M.x0 + TILE + 6, dir: "left", vend: vend(PAY_GLINT[0]) }),
    ];
    for (const w of cases)
      for (const wind of [-1, 0, 1]) {
        const ctx = recorder();
        drawWalker(ctx, cam, w, bank(), wind);
        const [bx, by, bw, bh] = walkerBox(w);
        for (const f of fills(ctx)) {
          expect(f.x).toBeGreaterThanOrEqual(bx);
          expect(f.y).toBeGreaterThanOrEqual(by);
          expect(f.x + f.w).toBeLessThanOrEqual(bx + bw);
          expect(f.y + f.h).toBeLessThanOrEqual(by + bh);
        }
        const [dx, dy, dw, dh] = spriteRect(ctx);
        expect(dx).toBeGreaterThanOrEqual(bx);
        expect(dy).toBeGreaterThanOrEqual(by);
        expect(dx + dw).toBeLessThanOrEqual(bx + bw);
        expect(dy + dh).toBeLessThanOrEqual(by + bh);
      }
    // A plain walker's box is no wider than it needs.
    expect(walkerBox(walker())[2]).toBeLessThan(walkerBox(walker({ vend: vend(0) }))[2]);
  });
});

describe("drawVend: a purchase on the machine", () => {
  const holder = { x: M.x0 - 6, y: 200, dir: 1 as const };
  const draw = (t: number, button = 2) => {
    const ctx = recorder();
    drawVend(ctx, cam, vend(t, button), holder);
    return ctx;
  };

  it("lands on the machine's own art: its coin slot, its buttons, its pickup tray", () => {
    // The coin slot and the button row, as the machine paints them.
    expect(machinePixel(M.x0 + COIN.dx, M.bottom - COIN.up)).toBe(VENDING.slot);
    expect(machinePixel(M.x0 + COIN.dx, M.bottom - COIN.up + 1)).toBe(VENDING.slot);
    for (const dx of BUTTON_X) expect(machinePixel(M.x0 + dx, M.bottom - BUTTON_UP)).toBe(VENDING.button);
    // Every pixel of the tray's can is in the pickup slot.
    for (let dx = 0; dx < CAN.w; dx++)
      for (let dy = 0; dy < CAN.h; dy++) expect([VENDING.slot, VENDING.slotEdge]).toContain(machinePixel(M.x0 + TRAY.dx + dx, M.bottom - TRAY.up + dy));
  });

  it("the drink is the bottle in the machine's bottom row above the pressed button — by the machine's own art, either colour of machine", () => {
    const red = "tokyo:vending:10,12";
    const blue = [...Array(50).keys()].map((i) => `tokyo:vending:${i},3`).find((id) => vendingVariant(id) !== vendingVariant(red))!;
    for (const id of [red, blue])
      for (let b = 0; b < BUTTON_X.length; b++) expect(drinkColor({ machine: id, button: b }), `${id} ${b}`).toBe(machinePixel(M.x0 + BUTTON_X[b], M.bottom - 17, id));
  });

  it("paying: nothing, then the coin slot glints", () => {
    expect(draw(0).calls).toHaveLength(0);
    expect(draw(PAY_GLINT[0] - 0.01).calls).toHaveLength(0);
    expect(fills(draw(PAY_GLINT[0]))).toEqual([{ x: M.x0 + COIN.dx, y: M.bottom - COIN.up, w: 1, h: 2, style: GLINT }]);
    expect(fills(draw(PAY_GLINT[1] - 0.01))).toHaveLength(1);
    expect(draw(PAY_GLINT[1]).calls).toHaveLength(0);
    expect(PAY_GLINT[1]).toBeLessThanOrEqual(VEND.flash);
  });

  it("then the pressed button blinks white — on, off, on — until the can drops", () => {
    const lit = (t: number, b = 2) => of(draw(t, b), FLASH);
    expect(lit(VEND.flash - 0.01)).toHaveLength(0);
    expect(lit(VEND.flash)).toEqual([{ x: M.x0 + BUTTON_X[2] - 1, y: M.bottom - BUTTON_UP, w: 3, h: 1, style: FLASH }]);
    expect(lit(VEND.flash, 4)[0].x).toBe(M.x0 + BUTTON_X[4] - 1);
    expect(lit(VEND.flash + BLINK_SEC * 0.5)).toHaveLength(1);
    expect(lit(VEND.flash + BLINK_SEC * 1.5)).toHaveLength(0);
    expect(lit(VEND.flash + BLINK_SEC * 2.5)).toHaveLength(1);
    expect(lit(VEND.drop)).toHaveLength(0);
  });

  it("then the can lies in the tray — a bounce as it lands — until the buyer takes it", () => {
    const color = drinkColor(vend(0));
    const canAt = (t: number) => of(draw(t), color);
    expect(canAt(VEND.drop - 0.01)).toHaveLength(0);
    expect(canAt(VEND.drop)).toEqual([{ x: M.x0 + TRAY.dx, y: M.bottom - TRAY.up - 1, w: CAN.w, h: CAN.h, style: color }]);
    expect(canAt(VEND.drop + BOUNCE_SEC + 0.01)).toEqual([{ x: M.x0 + TRAY.dx, y: M.bottom - TRAY.up, w: CAN.w, h: CAN.h, style: color }]);
    expect(canAt(VEND.take - 0.01)[0].y).toBe(M.bottom - TRAY.up);
    expect(of(draw(VEND.drop + BOUNCE_SEC + 0.01), CAN.top)).toHaveLength(1);
  });

  it("then it travels from the tray to the buyer's hand; once held it is the buyer's drink, not the machine's", () => {
    const color = drinkColor(vend(0));
    const canAt = (t: number) => of(draw(t), color)[0];
    const hand = canSpot(holder.x, holder.y, holder.dir, false);
    expect(canAt(VEND.take)).toMatchObject({ x: M.x0 + TRAY.dx, y: M.bottom - TRAY.up });
    const path = [0.25, 0.5, 0.75, 0.99].map((k) => canAt(VEND.take + k * (VEND.took - VEND.take)));
    // Monotone towards the hand.
    let prev = canAt(VEND.take);
    for (const p of path) {
      expect(Math.abs(p.x - hand.x)).toBeLessThanOrEqual(Math.abs(prev.x - hand.x));
      expect(Math.abs(p.y - hand.y)).toBeLessThanOrEqual(Math.abs(prev.y - hand.y));
      prev = p;
    }
    expect(Math.abs(path[3].x - hand.x)).toBeLessThanOrEqual(1);
    expect(draw(VEND.took).calls).toHaveLength(0);
    expect(draw(VEND.leave).calls).toHaveLength(0);
  });

  it("drawWalker draws the purchase BEFORE the buyer (on the machine behind it)", () => {
    const ctx = recorder();
    drawWalker(ctx, cam, walker({ x: holder.x, vend: vend(VEND.flash) }), bank(), 0);
    const flash = ctx.calls.findIndex((c) => c.op === "fillRect" && c.fillStyle === FLASH);
    expect(flash).toBeGreaterThanOrEqual(0);
    expect(flash).toBeLessThan(ctx.calls.findIndex((c) => c.op === "drawImage"));
  });
});

describe("renderFrame: a walker item", () => {
  const world: World = { cols: 20, rows: 20, tiles: new Array(400).fill("grass"), houses: [], props: [], seats: [], plaza: { col: 0, row: 0 } };
  const view = { w: 320, h: 320, world };
  const amb = (wind: number): Ambience => ({ phase: "noon", daylight: 1, tint: { color: "#000000", alpha: 0 }, weather: "rain", intensity: 0.7, wind, lightsOn: false, campfireLit: false, stayIndoors: false });

  it("is drawn when its box is on screen, culled when not; its umbrella leans with the sky's wind", () => {
    const b = bank();
    const on = recorder();
    renderFrame(on, [walker({ umbrella: 1 }) as DrawItem], cam, b, view);
    expect(on.of("drawImage")).toHaveLength(1);
    const off = recorder();
    renderFrame(off, [walker({ x: 400 }) as DrawItem], cam, b, view);
    expect(off.of("drawImage")).toHaveLength(0);
    // Just off the left edge, but its umbrella's rim reaches in: drawn. A little further, culled.
    const edge = recorder();
    renderFrame(edge, [walker({ x: -10, umbrella: 1 }) as DrawItem], cam, b, view);
    expect(edge.of("drawImage")).toHaveLength(1);
    expect(of(edge, CANOPIES[0].cloth).some((f) => f.x + f.w > 0)).toBe(true);
    const gone = recorder();
    renderFrame(gone, [walker({ x: -14, umbrella: 1 }) as DrawItem], cam, b, view);
    expect(gone.of("drawImage")).toHaveLength(0);
    const top = (wind: number) => {
      const ctx = recorder();
      renderFrame(ctx, [walker({ umbrella: 1 }) as DrawItem], cam, b, { ...view, ambience: amb(wind), particles: [] });
      const t = of(ctx, CANOPIES[0].cloth)[0];
      return t.x;
    };
    expect(top(1)).toBe(top(0) - 2);
    // No sky: calm.
    const calm = recorder();
    renderFrame(calm, [walker({ umbrella: 1 }) as DrawItem], cam, b, view);
    expect(of(calm, CANOPIES[0].cloth)[0].x).toBe(top(0));
  });
});
