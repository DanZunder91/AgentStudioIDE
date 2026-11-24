/**
 * Layer 5 — the City's traffic against a REAL 2D context in Chromium (render/vehicles.ts, engine/traffic.ts):
 * the depth order on the street read back as pixels (a far-lane bus in front of a near-sidewalk lamp, a
 * near-lane bus in front of a far-lane car, the far sidewalk's kiosk in front of a near-lane car), the
 * night's light (a headlamp's beam brightens the road ahead and not behind; a bus's windows are lit after
 * the grade), and the frame cost of the reference city with its traffic, at Fit and zoomed, day and night.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/render/vehicles.browser.test.tsx`
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, buildDrawList, computeAmbience, planCity } from "../engine";
import { SPEC, TrafficFx } from "../engine/traffic";
import { VillageView } from "../villageView";
import { TILE, type Ambience, type VehicleView, type VillageAgent } from "../villageTypes";
import { renderFrame, type Camera } from "./index";
import { KIOSK } from "./lift";
import { loadSprites } from "./index";
import { LIGHTS, PAINTS, drawVehicle, paintVehicleLights } from "./vehicles";

afterEach(() => {
  document.body.innerHTML = "";
});

const floors = (k: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${k}${i}`, label: `${k}${i}`, ide: true }));
const world = buildCityWorld(
  [
    { key: "gazelle", label: "gazelle", team: 4, hasIde: true, floors: floors("g", 2) },
    { key: "app", label: "app", team: 2, hasIde: true, floors: floors("a", 1) },
  ],
  { seats: 16 },
);
const street = world.city!.street;
const FAR_LANE = (street + 2) * TILE;
const NEAR_LANE = (street + 3) * TILE;
const ZOOM = 2;
const W = world.cols * TILE * ZOOM;
const H = world.rows * TILE * ZOOM;
const cam: Camera = { zoom: ZOOM, ox: 0, oy: 0 };
const LAMP_POST = "#3a3a40";

const vehicle = (extra: Partial<VehicleView>): VehicleView => {
  const kind = extra.kind ?? "car";
  return { kind, x: 0, w: SPEC[kind].len, y: FAR_LANE, dir: 1, livery: 0, odo: 0, braking: false, seed: 5, speed: 0, ...extra };
};

function canvas(w = W, h = H): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  return c.getContext("2d", { willReadFrequently: true })!;
}
/** RGB at a WORLD point (its screen pixel at the camera). */
function rgb(ctx: CanvasRenderingContext2D, wx: number, wy: number): string {
  const [r, g, b] = ctx.getImageData(wx * ZOOM, wy * ZOOM, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
const luma = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, v, i) => a + v * [0.299, 0.587, 0.114][i], 0);
function paint(vehicles: VehicleView[], amb?: Ambience): CanvasRenderingContext2D {
  const ctx = canvas();
  const items = buildDrawList(world, [], () => false, 0, null, null, [], [], [], vehicles);
  renderFrame(ctx, items, cam, null, { w: W, h: H, timeMs: 0, world, ...(amb && { ambience: amb, particles: [], flash: 0 }) });
  return ctx;
}

describe("the street's depth, painted", () => {
  it("a far-lane bus passes in front of a lamp on the near sidewalk", () => {
    const lamp = world.props.find((p) => p.kind === "lamp" && p.col > 2)!;
    const post = { x: lamp.col * TILE + 7, y: (street + 1) * TILE - 6 };
    expect(rgb(paint([]), post.x, post.y)).toBe(LAMP_POST);
    // The bus's pillar between its first two windows (lx 10) right over the post.
    expect(rgb(paint([vehicle({ kind: "bus", x: post.x - 10 })]), post.x, post.y)).toBe(PAINTS.bus[0].body);
  });

  it("a near-lane bus passes in front of a far-lane car", () => {
    const car = vehicle({ x: 300, livery: 3 });
    const at = { x: 305, y: FAR_LANE - 10 };
    expect(rgb(paint([car]), at.x, at.y)).toBe(PAINTS.car[3].body);
    // Driving left, the bus's pillar at lx 10 is 53 px from its left end.
    const bus = vehicle({ kind: "bus", dir: -1, y: NEAR_LANE, x: at.x - 53 });
    expect(rgb(paint([car, bus]), at.x, at.y)).toBe(PAINTS.bus[0].body);
    expect(rgb(paint([bus, car]), at.x, at.y)).toBe(PAINTS.bus[0].body); // whatever order they come in
  });

  it("the far sidewalk's kiosk stands in front of a near-lane car", () => {
    const kiosk = world.props.find((p) => p.kind === "lift")!;
    const x0 = kiosk.col * TILE;
    const car = vehicle({ dir: -1, y: NEAR_LANE, x: x0 - 10, livery: 4 });
    const ctx = paint([car]);
    expect(rgb(ctx, x0 + 1, NEAR_LANE - 10)).toBe(KIOSK.post);
    // The car is there, behind it: its body shows just left of the kiosk.
    expect(rgb(ctx, x0 - 5, NEAR_LANE - 10)).toBe(PAINTS.car[4].body);
  });
});

describe("the night, painted", () => {
  const night = computeAmbience(new Date(2026, 9, 26, 23, 0), null, { weather: "clear", phase: "auto" });
  it("a headlamp's beam brightens the road ahead of a car, not behind it; its lamps and tail lights are lit", () => {
    // A spot of the far lane where, with no car, the road 10 px ahead of a car's front and 10 px behind its
    // rear is the same colour (no lamp, kiosk or door light on either).
    const empty = paint([], night);
    const y = FAR_LANE - 2;
    let x = 40;
    while (rgb(empty, x + 38 + 10, y) !== rgb(empty, x - 10, y)) x += 4;
    const car = vehicle({ x, livery: 2 });
    const ctx = paint([car], night);
    expect(luma(rgb(ctx, x + 38 + 10, y))).toBeGreaterThan(luma(rgb(ctx, x - 10, y)) + 8);
    expect(rgb(ctx, x - 10, y)).toBe(rgb(empty, x - 10, y));
    expect(rgb(ctx, x + 36, FAR_LANE - 12)).toBe(LIGHTS.head);
    expect(rgb(ctx, x, FAR_LANE - 12)).toBe(LIGHTS.tail);
    // By day, no beam: ahead is the road.
    const day = computeAmbience(new Date(2026, 9, 26, 12, 0), null, { weather: "clear", phase: "auto" });
    expect(rgb(paint([car], day), x + 38 + 10, y)).toBe(rgb(paint([], day), x + 38 + 10, y));
  });

  it("a bus's windows are lit after the grade — the exact window light — with its passengers dark against them", () => {
    const x = 120;
    const bus = vehicle({ kind: "bus", x, seed: 3 });
    const ctx = paint([bus], night);
    // The first window's top-right corner (lx 9, 26 px up): clear of any passenger.
    expect(rgb(ctx, x + 9, FAR_LANE - 26)).toBe(LIGHTS.window);
    // By day the same pixel is the glass's highlight line, graded by nothing.
    expect(rgb(paint([bus]), x + 9, FAR_LANE - 26)).not.toBe(LIGHTS.window);
  });
});

describe("frame cost — the reference city with its traffic", () => {
  const agentOf = (key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
    key,
    parentKey: null,
    origin: "ide",
    title: key,
    folder,
    activity: "typing",
    tool: null,
    ideAgentId: key,
    lastActivityAt: null,
    ...extra,
  });
  function referenceAgents(): VillageAgent[] {
    const agents: VillageAgent[] = [];
    for (let i = 0; i < 7; i++) agents.push(agentOf(`g${i}`, "gazelle"));
    for (let i = 0; i < 26; i++) agents.push(agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", activity: i % 3 ? "typing" : "done" }));
    agents.push(agentOf("a0", "Agent Studio"));
    agents.push(agentOf("a0.s0", "Agent Studio", { parentKey: "a0" }));
    return agents;
  }

  it("Fit and 3×, day and night: the traffic adds a sliver of a frame", async () => {
    const bank = await loadSprites();
    const rows: string[] = [];
    for (const zoomSteps of [0, 3])
      for (const hour of [12, 23]) {
        const agents = referenceAgents();
        const roster = planCity(agents);
        const view = new VillageView(5, undefined, "city");
        view.setWorld(buildCityWorld(roster.plans, { seats: 64 }));
        view.setAgents(roster.agents);
        view.setCapacity({ machine: null, machineError: null, agents, includesOutside: true, usage: null, usageError: null, context: {}, nowMs: 0, lounge: true });
        view.setBank(bank);
        view.setAmbience(computeAmbience(new Date(2026, 9, 26, hour, 0), null, { weather: "clear", phase: "auto" }, "Asia/Tokyo"));
        const { w, h } = view.resize(1280, 800, 1);
        for (let i = 0; i < zoomSteps; i++) view.zoomBy(1);
        const ctx = canvas(w, h);
        let t = 0;
        for (; t < 60_000; t += 33) view.frame(t, null); // a minute of traffic first
        const fx = (view as unknown as { traffic: TrafficFx }).traffic;
        // The whole frame with its traffic, and with the traffic switched off (the same view, stubbed).
        const N = 240;
        const time = (): number => {
          const a = performance.now();
          for (let i = 0; i < N; i++) view.frame((t += 16), ctx);
          return (performance.now() - a) / N;
        };
        // Interleaved, best of three each, so warm-up and GC do not land on one side.
        const holder = view as unknown as { traffic: Pick<TrafficFx, "update" | "vehicles"> };
        const off = { update: () => {}, vehicles: () => [] };
        let withMs = Infinity;
        let withoutMs = Infinity;
        for (let k = 0; k < 3; k++) {
          holder.traffic = fx;
          withMs = Math.min(withMs, time());
          holder.traffic = off;
          withoutMs = Math.min(withoutMs, time());
        }
        holder.traffic = fx;
        // The traffic alone, many times over (the clock is too coarse for one): its update, and painting
        // the most it shows at once — a handful of six, one of each look, bodies and night lights.
        const chars = view.sim.characters();
        const span = { x0: -view.camera.ox / view.camera.zoom, x1: (w - view.camera.ox) / view.camera.zoom };
        const M = 4000;
        const b = performance.now();
        for (let i = 0; i < M; i++) fx.update(1 / 60, view.world, view.ambience, chars, span);
        const updateUs = ((performance.now() - b) / M) * 1000;
        const road = (view.world.city!.street + 2) * TILE;
        const six: VehicleView[] = (["car", "kei", "taxi", "taxi", "bus", "car"] as const).map((kind, i) =>
          vehicle({ kind, livery: i % 2, x: span.x0 + 40 + i * ((span.x1 - span.x0 - 120) / 6), y: road + (i % 2) * TILE, dir: i % 2 ? -1 : 1, speed: 90 }),
        );
        const P = 1000;
        const c = performance.now();
        for (let i = 0; i < P; i++) {
          for (const v of six) drawVehicle(ctx, view.camera, v, true);
          paintVehicleLights(ctx, view.camera, { w, h }, six);
        }
        const paintUs = ((performance.now() - c) / P) * 1000;
        rows.push(
          `${zoomSteps ? "zoom 3×" : "Fit"} ${hour === 12 ? "day" : "night"}: frame ${withMs.toFixed(2)} ms with traffic, ${withoutMs.toFixed(2)} ms without; ` +
            `traffic update ${updateUs.toFixed(1)} µs; six vehicles painted (bodies, spray, lights) ${paintUs.toFixed(1)} µs`,
        );
        expect(updateUs).toBeLessThan(100);
        expect(paintUs).toBeLessThan(500);
      }
    console.log(`[traffic frame cost]\n${rows.join("\n")}`);
  }, 120_000);
});
