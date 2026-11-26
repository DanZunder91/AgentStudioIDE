/** Browser tier: `npx vitest run --config vitest.browser.config.ts <this file>`. */

import { afterEach, describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { StreetLife, VEND, type WalkerItem } from "../engine/streetLife";
import { dressWorld } from "../engine/streetTheme";
import { TILE, type Ambience, type VillageAgent, type WeatherKind } from "../villageTypes";
import { VillageView } from "../villageView";
import type { Camera } from "./camera";
import { MARKER_EXTERNAL, MARKER_IDE } from "./characters";
import { loadSprites, type SpriteBank } from "./index";
import { onScreen } from "./paint";
import { BUTTON_UP, BUTTON_X, CAN, drawWalker, drinkColor, FLASH, TRAY, walkerBox } from "./streetLife";
import { drawVending, vendingVariant } from "./tokyoProps";
import { CANOPIES, RIM } from "./umbrella";

afterEach(() => {
  document.body.innerHTML = "";
});

const Z = 4;
const BG = "#204060";
const rgbOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** A canvas of world px [x0, x0 + w) × [y0, y0 + h) at zoom Z, filled with BG. */
function canvasOver(x0: number, y0: number, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w * Z;
  c.height = h * Z;
  document.body.appendChild(c);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, c.width, c.height);
  const cam: Camera = { zoom: Z, ox: -x0 * Z, oy: -y0 * Z };
  /** The RGB at the middle of world px (wx, wy). */
  const at = (wx: number, wy: number) => Array.from(ctx.getImageData((wx - x0) * Z + Z / 2, (wy - y0) * Z + Z / 2, 1, 1).data.slice(0, 3));
  /** Every distinct RGB in a world rect. */
  const colours = (wx: number, wy: number, ww: number, wh: number) => {
    const d = ctx.getImageData((wx - x0) * Z, (wy - y0) * Z, ww * Z, wh * Z).data;
    const out = new Set<string>();
    for (let i = 0; i < d.length; i += 4) out.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return out;
  };
  return { ctx, cam, at, colours };
}

function walker(over: Partial<WalkerItem> = {}): WalkerItem {
  return { t: "walker", id: 1, x: 40, y: 60, dir: "right", anim: "walk", frame: 0, palette: 1, hueShift: 0, sink: 0, umbrella: 0, canopy: 0, vend: null, drink: null, ...over };
}

let bank: SpriteBank;
const sprites = async () => (bank ??= await loadSprites());

describe("a passer-by, painted", () => {
  it("is a real sprite — many colours where it stands — and wears no agent marker", async () => {
    const { ctx, cam, colours } = canvasOver(0, 0, 80, 80);
    drawWalker(ctx, cam, walker(), await sprites(), 0);
    const body = colours(32, 30, 16, 30);
    expect(body.size).toBeGreaterThan(6);
    const all = colours(0, 0, 80, 80);
    for (const m of [MARKER_IDE, MARKER_EXTERNAL]) expect(all.has(rgbOf(m).join(","))).toBe(false);
  });

  it("its umbrella's cloth covers the head from above, rim to top; the clear one shows the sky through it", async () => {
    const b = await sprites();
    const { ctx, cam, at } = canvasOver(0, 0, 80, 80);
    drawWalker(ctx, cam, walker({ umbrella: 1, canopy: 0 }), b, 0);
    // Over the head's middle (the stick's column is x + 1), the rim and the row over it are the red cloth.
    expect(at(41 - 4, 60 - RIM)).toEqual(rgbOf(CANOPIES[0].cloth));
    expect(at(41 + 4, 60 - RIM - 1)).toEqual(rgbOf(CANOPIES[0].cloth));
    // Clear: neither the cloth nor the background, a mix of both.
    const clear = CANOPIES.findIndex((c) => c.clear);
    const two = canvasOver(0, 0, 80, 80);
    drawWalker(two.ctx, two.cam, walker({ umbrella: 1, canopy: clear }), b, 0);
    const px = two.at(41 - 4, 60 - RIM - 1);
    expect(px).not.toEqual(rgbOf(CANOPIES[clear].cloth));
    expect(px).not.toEqual(rgbOf(BG));
    for (let k = 0; k < 3; k++) {
      expect(px[k]).toBeGreaterThan(Math.min(rgbOf(BG)[k], rgbOf(CANOPIES[clear].cloth)[k]) - 1);
      expect(px[k]).toBeLessThan(Math.max(rgbOf(BG)[k], rgbOf(CANOPIES[clear].cloth)[k]) + 1);
    }
  });

  it("going down the subway stairs it shows nothing below the sidewalk's line — only its upper body above it", async () => {
    const { ctx, cam, colours } = canvasOver(0, 0, 80, 100);
    drawWalker(ctx, cam, walker({ sink: 16 }), await sprites(), 0);
    // Below the line: untouched background.
    expect([...colours(24, 61, 32, 39)]).toEqual([rgbOf(BG).join(",")]);
    // Above it: the head and shoulders.
    expect(colours(32, 45, 16, 15).size).toBeGreaterThan(4);
  });

  it("buying, the machine's pressed button flashes white and then a can lies in its tray", async () => {
    const id = "tokyo:vending:3,3";
    const x0 = 40;
    const bottom = 60;
    const paint = async (t: number) => {
      const c = canvasOver(0, 0, 80, 80);
      drawVending(c.ctx, c.cam, x0, bottom, vendingVariant(id), false);
      drawWalker(c.ctx, c.cam, walker({ x: x0 - 6, anim: "idle", vend: { x0, bottom, machine: id, button: 1, t } }), await sprites(), 0);
      return c;
    };
    const flash = await paint(VEND.flash);
    expect(flash.at(x0 + BUTTON_X[1], bottom - BUTTON_UP)).toEqual(rgbOf(FLASH));
    const before = await paint(0);
    expect(before.at(x0 + BUTTON_X[1], bottom - BUTTON_UP)).not.toEqual(rgbOf(FLASH));
    const tray = await paint(VEND.take - 0.05);
    expect(tray.at(x0 + TRAY.dx, bottom - TRAY.up + CAN.h - 1)).toEqual(rgbOf(drinkColor({ machine: id, button: 1 })));
    expect(before.at(x0 + TRAY.dx, bottom - TRAY.up + CAN.h - 1)).not.toEqual(rgbOf(drinkColor({ machine: id, button: 1 })));
  });
});

// ───────────────────────────── the frame cost ─────────────────────────────

const agentOf = (key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
  key, parentKey: null, origin: "ide", title: key, folder, activity: "typing", tool: null, ideAgentId: key, lastActivityAt: null, ...extra,
});
/** The reference city: gazelle (seven floors, 26 sub-agents), a small Agent Studio, the HQ between them, in Tokyo. */
const agents: VillageAgent[] = [];
for (let i = 0; i < 7; i++) agents.push(agentOf(`g${i}`, "gazelle"));
for (let i = 0; i < 26; i++) agents.push(agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0" }));
agents.push(agentOf("a0", "Agent Studio"));
const roster = planCity(agents);
const world = dressWorld(buildCityWorld(roster.plans, { seats: 64 }), "Asia/Tokyo");
const sky = (hour: number, weather: WeatherKind): Ambience => computeAmbience(new Date(2026, 9, 26, hour, 0), null, { weather, phase: "auto" }, "Asia/Tokyo");

describe("the street's frame cost (the reference city)", () => {
  it("walking and painting every passer-by costs well under a millisecond, at Fit and zoomed 2–3×, day, night and rain", async () => {
    const b = await sprites();
    const results: string[] = [];
    for (const [name, amb] of [
      ["day", sky(13, "clear")],
      ["night", sky(23, "clear")],
      ["rain", sky(13, "rain")],
    ] as const)
      for (const [steps, dpr] of [[0, 1], [0, 2], [3, 1], [4, 1]] as const) {
        const view = new VillageView(1, () => null, "city");
        view.setWorld(world);
        view.setAgents(roster.agents);
        view.setBank(b);
        view.setAmbience(amb);
        const { w, h } = view.resize(1280, 800, dpr);
        view.setInset(117);
        // Zoomed on the HQ's door (the crossing): the busiest stretch of street.
        const lift = world.city!.lounge!.lift;
        for (let i = 0; i < steps; i++) {
          const c = view.camera;
          view.zoomBy(1, { x: c.ox + (lift.col + 0.5) * TILE * c.zoom, y: c.oy + (world.city!.street + 2) * TILE * c.zoom });
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        document.body.appendChild(c);
        const ctx = c.getContext("2d")!;
        for (let t = 0; t < 60_000; t += 100) view.frame(t, null);
        view.frame(60_000, ctx);
        const street = (view as unknown as { street: StreetLife }).street;
        const cam = view.camera;
        const x0 = -cam.ox / cam.zoom;
        const x1 = (w - cam.ox) / cam.zoom;
        const runs: number[] = [];
        let drawn = 0;
        let clock = 60_000;
        for (let r = 0; r < 7; r++) {
          const t0 = performance.now();
          for (let i = 0; i < 40; i++) {
            clock += 1000 / 60;
            street.update(1 / 60, world, amb, x0, x1, clock);
            drawn = 0;
            for (const it of street.walkers())
              if (onScreen(cam, { w, h }, ...walkerBox(it))) {
                drawWalker(ctx, cam, it, b, amb.wind);
                drawn++;
              }
          }
          // Make the canvas raster what was queued, so the paint is in the measure too.
          ctx.getImageData(0, 0, 1, 1);
          runs.push((performance.now() - t0) / 40);
        }
        runs.sort((p, q) => p - q);
        const ms = runs[3];
        const where = steps > 0 ? `zoom ${cam.zoom} on the HQ` : `Fit 1280×800@${dpr} (zoom ${cam.zoom})`;
        results.push(`${name} ${where}: ${ms.toFixed(3)} ms, ${street.walkers().length} walking, ${drawn} on screen`);
        expect(ms).toBeLessThan(1);
      }
    console.log(`[street life frame cost]\n${results.join("\n")}`);
  });
});
