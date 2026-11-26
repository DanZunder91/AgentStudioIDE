/** Draw calls through the recording fake; the real pixels are lounge.browser.test.tsx's. */

import { describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, computeAmbience, planCity } from "../engine";
import { VillageView } from "../villageView";
import { SIT_OFFSET } from "../engine/sim";
import { TILE, type Ambience, type CharacterView, type DrawItem, type PropReading } from "../villageTypes";
import { drawCharacter } from "./characters";
import { renderFrame } from "./frame";
import {
  BENCH,
  BENCH_SEATS,
  drawBench,
  drawLounge,
  FRIEZE,
  lampCols,
  LOUNGE,
  POSE_COL,
  SITTER_TOP,
  SNORE,
} from "./lounge";
import { drawProp } from "./props";
import type { SpriteBank, SpriteImage } from "./renderTypes";
import { recorder, type DrawCall } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
const X0 = 5 * TILE;
const BOTTOM = 9 * TILE;
const night = { phase: "night" } as Ambience;
const day = { phase: "noon" } as Ambience;

/** A bank whose character sheets are tagged with the look asked for (the blit's image says which). */
function bank(): SpriteBank {
  return {
    fallback: false,
    character: (palette, hueShift) => ({ sheet: `${palette}/${hueShift}` }) as unknown as SpriteImage,
    floor: () => null,
    wall: () => null,
    furniture: () => null,
  };
}

const waiter = (pose: "still" | "shift" | "read", palette = 2, hueShift = 15): PropReading => ({ kind: "waiter", palette, hueShift, pose });

function bench(index: number, reading?: PropReading, b: SpriteBank | null = bank(), timeMs = 0, amb?: Ambience) {
  const ctx = recorder();
  drawBench(ctx, cam, X0, BOTTOM, index, reading, b, timeMs, amb);
  return ctx;
}

/** World-px boxes [x, y, w, h] of a recording's fills (zoom 1, no offset: screen = world). */
const boxes = (calls: DrawCall[]) => calls.filter((c) => c.op === "fillRect").map((c) => c.args as number[]);

describe("drawBench — a lounge seat, one of four in a row", () => {
  it("an empty seat stays inside its own tile: backrest slats, a seat, its dark front edge", () => {
    for (let i = 0; i < BENCH_SEATS; i++) {
      const fills = bench(i).of("fillRect");
      expect(fills.length).toBeGreaterThan(0);
      for (const [x, y, w, h] of boxes(fills)) {
        expect(x).toBeGreaterThanOrEqual(X0);
        expect(x + w).toBeLessThanOrEqual(X0 + TILE);
        expect(y).toBeGreaterThanOrEqual(BOTTOM - TILE);
        expect(y + h).toBeLessThanOrEqual(BOTTOM);
      }
      const styles = fills.map((c) => c.fillStyle);
      expect(styles).toContain(BENCH.wood);
      expect(styles).toContain(BENCH.woodDark);
      expect(bench(i).of("drawImage")).toHaveLength(0);
    }
  });

  it("four seats in a row read as ONE bench: its slats and seat run unbroken, ends and legs only where a bench has them", () => {
    /** The x-runs a colour covers at world row y across four seats laid side by side. */
    const covered = (y: number, color: string) => {
      const xs = new Set<number>();
      for (let i = 0; i < BENCH_SEATS; i++) {
        const ctx = recorder();
        drawBench(ctx, cam, X0 + i * TILE, BOTTOM, 8 + i, undefined, null, 0);
        for (const c of ctx.of("fillRect")) {
          const [x, cy, w, h] = c.args as number[];
          if (c.fillStyle === color && y >= cy && y < cy + h) for (let k = x; k < x + w; k++) xs.add(k);
        }
      }
      return [...xs].sort((a, b) => a - b);
    };
    const run = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);
    // The seat body and both slats: from a px inside the bench's left end to a px inside its right end.
    for (const y of [BOTTOM - 8, BOTTOM - 14, BOTTOM - 11]) expect(covered(y, BENCH.wood)).toEqual(run(X0 + 1, X0 + 4 * TILE - 1));
    // Legs (metal, below the seat): under both ends and a pair straddling the middle — nowhere else.
    const legs = covered(BOTTOM - 3, BENCH.metal);
    expect(legs).toEqual([X0 + 2, X0 + 3, X0 + 2 * TILE - 1, X0 + 2 * TILE, X0 + 4 * TILE - 4, X0 + 4 * TILE - 3]);
    // Armrests: a post at each end only.
    expect(covered(BOTTOM - 8, BENCH.metal)).toEqual([X0 + 1, X0 + 4 * TILE - 2]);
  });

  it("a waiter sits on it facing us: its own sheet and hue, the pose's frame, where a sim character seated there is drawn", () => {
    for (const pose of ["still", "shift", "read"] as const) {
      const blits = bench(1, waiter(pose)).of("drawImage");
      expect(blits).toHaveLength(1);
      const [img, srcX, srcY, sw, sh, dx, dy] = blits[0].args as [{ sheet: string }, number, number, number, number, number, number];
      expect([img.sheet, srcX, srcY, sw, sh]).toEqual(["2/15", POSE_COL[pose] * 16, 0, 16, 32]);
      expect([dx, dy]).toEqual([X0, BOTTOM - SITTER_TOP]);
    }
    expect([POSE_COL.still, POSE_COL.shift, POSE_COL.read]).toEqual([3, 4, 5]);
    // The same spot characters.ts draws a character seated on this tile (feet at its bottom + SIT_OFFSET).
    const seated: CharacterView = {
      key: "s", x: X0 + 8, y: BOTTOM + SIT_OFFSET, dir: "down", anim: "type", frame: 0, palette: 2, hueShift: 15, seated: true,
      origin: "ide", isSubagent: false, activity: "typing", label: "", tool: null, bubble: null, bubbleAlpha: 0, fx: null,
    };
    const sim = recorder();
    drawCharacter(sim, cam, seated, bank());
    expect(sim.of("drawImage")[0].args).toEqual(bench(1, waiter("still")).of("drawImage")[0].args);
    // Its bench is drawn first, the sitter over it.
    const calls = bench(1, waiter("still")).calls;
    expect(calls.findIndex((c) => c.op === "drawImage")).toBeGreaterThan(calls.map((c) => c.fillStyle).lastIndexOf(BENCH.wood));
  });

  it("no waiter without a waiter reading (a held seat, a claimed one, or a rack's reading by mistake)", () => {
    expect(bench(0).calls).toEqual(bench(0, { kind: "gauge", meter: null }).calls);
    expect(bench(0).of("drawImage")).toHaveLength(0);
  });

  it("at night every waiter dozes: sitting still whatever its pose, a small 'z' over its head, bobbing — inside the tile above", () => {
    for (const pose of ["still", "shift", "read"] as const) {
      const ctx = bench(0, waiter(pose), bank(), 0, night);
      expect((ctx.of("drawImage")[0].args[1] as number) / 16).toBe(POSE_COL.still);
      const z = ctx.of("fillRect").filter((c) => c.fillStyle === SNORE);
      expect(z).toHaveLength(3);
      for (const [x, y, w, h] of boxes(z)) {
        expect(x).toBeGreaterThanOrEqual(X0);
        expect(x + w).toBeLessThanOrEqual(X0 + TILE);
        expect(y).toBeGreaterThanOrEqual(BOTTOM - 2 * TILE);
        expect(y + h).toBeLessThanOrEqual(BOTTOM - SITTER_TOP + 6); // above the head's top
      }
    }
    const zy = (t: number) => boxes(bench(0, waiter("still"), bank(), t, night).of("fillRect").filter((c) => c.fillStyle === SNORE))[0][1];
    expect(zy(0)).not.toBe(zy(700));
    expect(zy(0)).toBe(zy(1400));
    // By day, and without a sky, nobody sleeps.
    for (const amb of [day, undefined]) {
      const ctx = bench(0, waiter("read"), bank(), 0, amb);
      expect((ctx.of("drawImage")[0].args[1] as number) / 16).toBe(POSE_COL.read);
      expect(ctx.of("fillRect").some((c) => c.fillStyle === SNORE)).toBe(false);
    }
    // An empty seat at night: no "z" in the air.
    expect(bench(0, undefined, bank(), 0, night).of("fillRect").some((c) => c.fillStyle === SNORE)).toBe(false);
  });

  it("without art: a body in its sheet's colour and a head, over the bench — never a blit", () => {
    for (const b of [null, { ...bank(), character: () => null }]) {
      const ctx = bench(3, waiter("read", 1), b);
      expect(ctx.of("drawImage")).toHaveLength(0);
      const fills = ctx.of("fillRect").map((c) => c.fillStyle);
      expect(fills).toContain("#3d6fc4");
      expect(fills).toContain("#f1c9a5");
    }
    expect(bench(3, waiter("read", 4), null).of("fillRect").map((c) => c.fillStyle)).toContain("#9b59b6");
  });

  it("drawProp draws a bench prop with drawBench: its seat number, its reading, the bank, the clock and the sky", () => {
    const prop = { id: "cap/seats:bench:6", kind: "bench" as const, col: 5, row: 8, w: 1, h: 1, facing: "down" as const, capacity: "seats" as const, index: 6 };
    for (const amb of [night, day, undefined])
      for (const reading of [waiter("shift"), undefined]) {
        const via = recorder();
        drawProp(via, cam, { prop, on: false, frame: 0, ...(reading && { reading }) }, bank(), 1400, amb);
        const direct = recorder();
        drawBench(direct, cam, X0, BOTTOM, 6, reading, bank(), 1400, amb);
        expect(via.calls).toEqual(direct.calls);
      }
  });
});

describe("drawLounge — the hall, dressed", () => {
  const world = buildCityWorld(planCity([]).plans, { seats: 64 });
  const item = buildDrawList(world, [], () => false, 0).find((i): i is Extract<DrawItem, { t: "lounge" }> => i.t === "lounge")!;
  const draw = (it: Extract<DrawItem, { t: "lounge" }> = item) => {
    const ctx = recorder();
    drawLounge(ctx, cam, it);
    return ctx;
  };
  const x0 = item.col * TILE;
  const x1 = (item.col + item.w) * TILE;

  it("stays inside the hall — its back wall's face to its last aisle — and out of the lift's column and the aisle either side", () => {
    const all = boxes(draw().calls);
    expect(all.length).toBeGreaterThan(0);
    for (const [x, y, w, h] of all) {
      expect(x).toBeGreaterThanOrEqual(x0);
      expect(x + w).toBeLessThanOrEqual(x1);
      expect(y).toBeGreaterThanOrEqual(item.row * TILE);
      expect(y + h).toBeLessThanOrEqual((item.row + 2 + 2 * item.benchRows) * TILE);
      const clear = x + w <= (item.lift - 1) * TILE || x >= (item.lift + 2) * TILE;
      expect(clear, `[${x}, ${x + w})`).toBe(true);
    }
  });

  it("a frieze along the back wall's face, in each half", () => {
    // On the face of the back wall (its row), never down in the headroom over the sitters' heads.
    const band = boxes(draw().of("fillRect").filter((c) => c.fillStyle === LOUNGE.frieze || c.fillStyle === LOUNGE.friezeEdge));
    expect(band.length).toBeGreaterThanOrEqual(6);
    for (const [, y, , h] of band.filter(([, , w]) => w > TILE)) {
      expect(y).toBeGreaterThanOrEqual(item.row * TILE);
      expect(y + h).toBeLessThanOrEqual((item.row + 1) * TILE);
    }
    const frieze = boxes(draw().of("fillRect").filter((c) => c.fillStyle === LOUNGE.frieze));
    expect(frieze).toEqual([
      [x0, item.row * TILE + FRIEZE + 1, (item.lift - 1) * TILE - x0, 2],
      [(item.lift + 2) * TILE, item.row * TILE + FRIEZE + 1, x1 - (item.lift + 2) * TILE, 2],
    ]);
  });

  it("a wainscot behind every bench row, a plant at both ends of it — one more of each when the lounge grows a row", () => {
    for (const rows of [4, 5]) {
      const ctx = draw({ ...item, benchRows: rows });
      const panels = boxes(ctx.of("fillRect").filter((c) => c.fillStyle === LOUNGE.panel));
      expect(panels).toHaveLength(2 * rows);
      for (let k = 0; k < rows; k++) {
        const top = (item.row + 2 + 2 * k) * TILE + 5;
        expect(panels.filter((p) => p[1] === top)).toHaveLength(2);
      }
      const pots = boxes(ctx.of("fillRect").filter((c) => c.fillStyle === LOUNGE.pot));
      expect(pots).toEqual(
        Array.from({ length: rows }, (_, k) => [
          [x0 + 4, (item.row + 3 + 2 * k) * TILE - 6, 8, 5],
          [x1 - TILE + 4, (item.row + 3 + 2 * k) * TILE - 6, 8, 5],
        ]).flat(),
      );
    }
  });

  it("its lamps hang in the hall's end columns and between each side's benches — over no seat, and lit", () => {
    const seatCols = new Set(world.props.filter((p) => p.kind === "bench").map((p) => p.col));
    const cols = lampCols(item);
    expect(cols).toEqual([item.col, item.lift - 6, item.lift + 6, item.col + item.w - 1]);
    for (const c of cols) expect(seatCols.has(c), `col ${c}`).toBe(false);
    // Each lamp's bulb, in its column, just under the back wall.
    const bulbs = boxes(draw().of("fillRect").filter((c) => c.fillStyle === LOUNGE.bulb));
    expect(bulbs.map(([x]) => Math.floor(x / TILE))).toEqual(cols);
    for (const [, y] of bulbs) expect(Math.floor(y / TILE)).toBe(item.row + 1);
  });

  it("renderFrame paints a `lounge` item with drawLounge — and not at all off screen", () => {
    const view = { w: 2000, h: 2000 };
    const framed = recorder();
    renderFrame(framed, [item], cam, null, view);
    const direct = recorder();
    drawLounge(direct, cam, item);
    // (The frame turns smoothing off first; the rest of each call is the same.)
    const fills = (ctx: ReturnType<typeof recorder>) => ctx.of("fillRect").map(({ args, fillStyle, alpha }) => ({ args, fillStyle, alpha }));
    expect(fills(framed)).toEqual(fills(direct));
    // Its last aisle's bottom just above the view's top: nothing; one px of it on screen: all of it.
    const bottom = (item.row + 2 + 2 * item.benchRows) * TILE;
    for (const [oy, n] of [
      [-bottom, 0],
      [-bottom + 1, direct.of("fillRect").length],
    ] as const) {
      const ctx = recorder();
      renderFrame(ctx, [item], { zoom: 1, ox: 0, oy }, null, view);
      expect(ctx.of("fillRect")).toHaveLength(n);
    }
  });
});

describe("the lounge stays dry", () => {
  it("a storm over a city with its lounge on screen: no drop, streak or splash ever below the far sidewalk — none in the ground, none in the lounge", () => {
    const v = new VillageView(1, () => null, "city");
    v.resize(1600, 1200, 1);
    v.setWorld(buildCityWorld(planCity([]).plans, { seats: 80 }));
    const { street } = v.world.city!;
    const lounge = v.world.houses.find((h) => h.capacity === "seats")!;
    // The whole lounge and the ground round it are in view.
    const cam = v.camera;
    expect(cam.oy + (lounge.row + lounge.h + 1) * TILE * cam.zoom).toBeLessThanOrEqual(1200);
    const storm = computeAmbience(new Date(2026, 9, 15, 15, 0), null, { weather: "storm", phase: "auto" });
    v.setAmbience(storm);
    const ground = (street + 4) * TILE;
    let seen = 0;
    for (let t = 0; t <= 6000; t += 50) {
      v.frame(t, null);
      const ps = (v as unknown as { fx: { particles(): { kind: string; y: number; size: number }[] } }).fx.particles();
      seen += ps.length;
      for (const p of ps) expect(p.y, p.kind).toBeLessThan(ground);
    }
    expect(seen).toBeGreaterThan(1000);
  });
});
