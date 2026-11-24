/**
 * Layer 5 — the City's lifts against a REAL 2D context in Chromium (render/lift.ts): the shaft really
 * covers the back wall it crosses, a rider really stands inside its car, and the lounge's kiosk stands
 * on the far sidewalk — read back as pixels from a real commute (engine/sim.ts + engine/commute.ts).
 * No sky (no ambience), so every colour is the art's own: nothing grades it.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/lift.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, planCity, VillageSim } from "../engine";
import { TILE, type CharacterView, type DrawItem, type VillageAgent } from "../villageTypes";
import { renderFrame, type Camera } from "./index";
import { CAR, KIOSK, SHAFT } from "./lift";

afterEach(() => {
  document.body.innerHTML = "";
});

const ZOOM = 2;
const agent = (key: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
  key,
  parentKey: null,
  origin: "ide",
  title: key,
  folder: "gazelle",
  activity: "typing",
  tool: null,
  ideAgentId: key,
  lastActivityAt: null,
  ...extra,
});
// Gazelle has two floors; its team works on the upper one, so the lift crosses the ground floor's back wall.
const roster = planCity([agent("g0"), agent("g"), agent("g.s0", { parentKey: "g", folder: "x" })]);
const world = buildCityWorld(roster.plans, { seats: 16 });
const city = world.city!;
const gazelle = city.buildings.find((b) => b.key === "gazelle")!;
const lift = gazelle.lift!;
const W = world.cols * TILE * ZOOM;
const H = world.rows * TILE * ZOOM;
const cam: Camera = { zoom: ZOOM, ox: 0, oy: 0 };

function canvas(): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  document.body.appendChild(c);
  return c.getContext("2d", { willReadFrequently: true })!;
}
/** RGB at a WORLD point (its screen pixel at the camera). */
function rgb(ctx: CanvasRenderingContext2D, wx: number, wy: number): string {
  const [r, g, b] = ctx.getImageData(wx * ZOOM, wy * ZOOM, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function paint(items: DrawItem[]): CanvasRenderingContext2D {
  const ctx = canvas();
  renderFrame(ctx, items, cam, null, { w: W, h: H, timeMs: 0, world });
  return ctx;
}
function sim(): VillageSim {
  const s = new VillageSim({ seed: 1, stayPut: true });
  s.setWorld(world);
  s.setLoungeSeats(new Map([["g0", 0], ["g", 1], ["g.s0", 2]]));
  s.setAgents(roster.agents);
  return s;
}
const list = (s: VillageSim) => buildDrawList(world, s.characters(), (id) => s.pcOn(id), s.time);

describe("the lifts, painted", () => {
  it("the building's shaft runs OVER the back wall it crosses — without it that pixel is the wall's", () => {
    const s = sim();
    for (let i = 0; i < 300; i++) s.tick(0.1); // everyone at work: nobody in a lift
    // The ground floor's back wall: the first wall tile up the lift's column above the door.
    let wall = lift.bottom - 1;
    while (world.tiles[wall * world.cols + lift.col] !== "wall") wall--;
    expect(wall).toBeGreaterThan(lift.top); // between the floors, inside the shaft's span
    // Sample: mid-column (clear of the rails at +3 and +12), 2 px into the row (clear of the tie at
    // +7); landing doors stand on the stop rows' floor lines, two rows and more below a back wall.
    const [x, y] = [lift.col * TILE + 8, wall * TILE + 2];
    const items = list(s);
    expect(rgb(paint(items), x, y)).toBe(SHAFT.back);
    const without = rgb(
      paint(items.filter((i) => i.t !== "shaft")),
      x,
      y,
    );
    expect(without).not.toBe(SHAFT.back);
  });

  it("a rider stands inside its car: the car's back behind it, its frame round it, in the shaft", () => {
    const s = sim();
    let rider: CharacterView | undefined;
    for (let t = 0; t < 20 && !rider; t += 1 / 60) {
      s.tick(1 / 60);
      const v = s.characters().find((c) => c.key === "g.s0")!;
      if (v.riding && v.x === lift.col * TILE + 8 && v.y < (lift.bottom - 2) * TILE) rider = v;
    }
    expect(rider).toBeDefined();
    const { x, y } = rider!;
    const ctx = paint(list(s));
    // The cab's back wall beside the rider (the no-art body is 8 px wide: x − 4 .. x + 4).
    expect(rgb(ctx, x + 5, Math.round(y) - 20)).toBe(CAR.wall);
    // Its frame: a post at either side, the lintel over its head.
    expect(rgb(ctx, x - 7, Math.round(y) - 15)).toBe(CAR.frame);
    expect(rgb(ctx, x + 6, Math.round(y) - 15)).toBe(CAR.frame);
    expect(rgb(ctx, x, Math.round(y) - 30)).toBe(CAR.frame);
    // The rider itself, drawn over the car's back: its body is neither the cab nor the shaft.
    const body = rgb(ctx, x, Math.round(y) - 10);
    expect([CAR.wall, CAR.light, SHAFT.back, SHAFT.edge]).not.toContain(body);
  });

  it("the lounge's kiosk stands on the far sidewalk, its canopy on top", () => {
    const s = sim();
    const ctx = paint(list(s));
    const kiosk = world.props.find((p) => p.kind === "lift")!;
    expect(kiosk.row).toBe(city.street + 3);
    // The canopy: the top 4 px of the booth's two tiles, clear of the sign's arrows at x0 + 4..11.
    expect(rgb(ctx, kiosk.col * TILE + 1, (kiosk.row - 1) * TILE + 2)).toBe(KIOSK.canopy);
    expect(rgb(ctx, kiosk.col * TILE + 1, kiosk.row * TILE + 10)).toBe(KIOSK.post);
  });
});
