/**
 * Layer 5 — the whole village tab in Chromium: real ResizeObserver, real
 * devicePixelRatio, real requestAnimationFrame, real sprite decoding, real 2D
 * context. The jsdom suite pins the wiring through fakes; only this tier can prove
 * the panel actually puts the village on screen at the stage's size.
 *
 * Only the data hooks are mocked (they would need a Tauri backend): the agents, and the
 * sky (live weather + clock), pinned to a fixed local time so frames are reproducible.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/village/VillagePanel.browser.test.tsx`
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fitCamera } from "./render";
import { VillageView } from "./villageView";
import { TILE, type CharacterView, type VillageAgent, type WeatherWire } from "./villageTypes";

const model = vi.hoisted(() => ({ agents: [] as VillageAgent[] }));
vi.mock("./villageModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./villageModel")>()),
  useVillageAgents: () => ({ agents: model.agents, externalError: null, lastScanAt: null }),
}));
const sky = vi.hoisted(() => ({
  weather: null as import("./villageTypes").WeatherWire | null,
  now: new Date(2026, 9, 14, 12, 30),
}));
vi.mock("./useVillageAmbience", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useVillageAmbience")>()),
  useVillageAmbience: () => ({
    weather: sky.weather,
    weatherError: null,
    override: { weather: "auto", phase: "auto" },
    setOverride: () => {},
    now: sky.now,
  }),
}));

const RAIN: WeatherWire = {
  kind: "rain",
  intensity: 0.7,
  temperatureC: 18,
  wind: 0.2,
  sunriseMs: null,
  sunsetMs: null,
  place: "Tokyo",
  fetchedAtMs: 0,
};

import { VillagePanel } from "./VillagePanel";

afterEach(() => {
  // `captureFrames` spies on VillageView.prototype.frame: a spy left over would be the
  // "original" the next test's spy calls — itself — and recurse until the stack blows.
  vi.restoreAllMocks();
  window.localStorage.clear();
  sky.weather = null;
  sky.now = new Date(2026, 9, 14, 12, 30);
  cleanup();
  document.body.innerHTML = "";
});

function agent(key: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: key,
    folder: "gazelle",
    activity: "typing",
    tool: "Edit",
    ideAgentId: key,
    lastActivityAt: Date.now(),
    ...extra,
  };
}

/** Resolve after `n` real animation frames. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (): void => {
      if (--n <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** What one real frame put on the canvas, captured right after `VillageView.frame` painted it. */
interface Snapshot {
  view: VillageView;
  pixels: Uint8ClampedArray;
  width: number;
  chars: CharacterView[];
}

/** Wrap the real `frame` so a test can grab the canvas at the exact frame the sim state is from. */
function captureFrames(): { next: () => Promise<Snapshot> } {
  const original = VillageView.prototype.frame;
  let want: ((s: Snapshot) => void) | null = null;
  vi.spyOn(VillageView.prototype, "frame").mockImplementation(function (this: VillageView, now, ctx) {
    original.call(this, now, ctx);
    if (!want || !ctx) return;
    const real = ctx as unknown as CanvasRenderingContext2D;
    const { width, height } = real.canvas;
    const done = want;
    want = null;
    done({ view: this, pixels: real.getImageData(0, 0, width, height).data, width, chars: this.sim.characters() });
  });
  return { next: () => new Promise((resolve) => (want = resolve)) };
}

/** Fraction of pixels in a screen box that differ between two snapshots of one canvas. */
function changed(a: Snapshot, b: Snapshot, box: { x: number; y: number; w: number; h: number }): number {
  let diff = 0;
  let total = 0;
  for (let y = Math.max(0, box.y); y < box.y + box.h; y++)
    for (let x = Math.max(0, box.x); x < Math.min(a.width, box.x + box.w); x++) {
      const i = (y * a.width + x) * 4;
      if (i + 3 >= a.pixels.length) continue;
      total++;
      if (a.pixels[i] !== b.pixels[i] || a.pixels[i + 1] !== b.pixels[i + 1] || a.pixels[i + 2] !== b.pixels[i + 2]) diff++;
    }
  return total ? diff / total : 0;
}

describe("VillagePanel in a real browser", () => {
  it("sizes the canvas to the stage × DPR and paints the village with its characters", async () => {
    model.agents = [agent("a"), agent("ext:b", { origin: "external", folder: "other", ideAgentId: null })];
    // A rainy afternoon.
    sky.weather = RAIN;
    sky.now = new Date(2026, 9, 14, 15, 30);
    const host = document.createElement("div");
    host.style.cssText = "width: 480px; height: 320px; position: relative;";
    document.body.appendChild(host);
    render(<VillagePanel />, { container: host });

    const canvas = screen.getByTestId("village-canvas") as HTMLCanvasElement;
    // Sprites decode asynchronously; give the loop time to pick them up.
    await vi.waitFor(() => expect(canvas.width).toBe(Math.round(480 * devicePixelRatio)), { timeout: 2000 });
    expect(canvas.height).toBe(Math.round(320 * devicePixelRatio));
    await frames(30);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) painted++;
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    // The fitted world covers most of the stage, and it is pixel art, not a flat fill.
    expect(painted / (canvas.width * canvas.height)).toBeGreaterThan(0.5);
    expect(colours.size).toBeGreaterThan(20);
    expect(canvas).toHaveAttribute(
      "aria-label",
      "Agent Village: 1 in the IDE, 1 outside the IDE, 2 active — Raining · afternoon",
    );
    expect(screen.getByTestId("village-sky")).toHaveTextContent("Rain · 15:30 · Afternoon · 18°C · Tokyo");
    // Nothing selected in the rail: the Seats hall has no context window to seat — '?', never a 0.
    // No machine sample (no Tauri backend here) and no usage reading: '?' too. The Village has no lounge.
    expect(screen.getByTestId("village-capacity")).toHaveTextContent(/^Seats \? · Memory \? · Usage \? · \?$/);
  });

  it("puts each character on the canvas — its sprite box changes when the agent leaves", async () => {
    // Idle: no desk, no PC screen under the character to flicker on its own.
    model.agents = [agent("a", { activity: "idle", tool: null })];
    const capture = captureFrames();
    const host = document.createElement("div");
    host.style.cssText = "width: 480px; height: 320px; position: relative;";
    document.body.appendChild(host);
    render(<VillagePanel />, { container: host });
    await frames(40); // sprites decoded, spawn effect over

    const withAgent = await capture.next();
    const [c] = withAgent.chars;
    expect(c.key).toBe("a");
    const cam = withAgent.view.camera;
    const box = {
      x: Math.round(cam.ox) + (Math.round(c.x) - TILE / 2) * cam.zoom,
      y: Math.round(cam.oy) + (Math.round(c.y) - 2 * TILE) * cam.zoom,
      w: TILE * cam.zoom,
      h: 2 * TILE * cam.zoom,
    };

    // Same world, same camera, the agent gone (despawned): only the character changes.
    withAgent.view.setAgents([]);
    await frames(90);
    const without = await capture.next();
    expect(without.chars).toEqual([]);
    expect(without.view.camera).toEqual(cam);
    expect(changed(withAgent, without, box)).toBeGreaterThan(0.15);
  });
});

/** Fraction of the canvas that is painted (any alpha) and its distinct colours. */
function coverage(canvas: HTMLCanvasElement): { painted: number; colours: number } {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  const colours = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) painted++;
    colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return { painted: painted / (canvas.width * canvas.height), colours: colours.size };
}

describe("VillagePanel in a real browser — the blank village", () => {
  it("mounted into a sliver of a pane that then grows (a fresh split), the village still fills the stage", async () => {
    model.agents = [agent("a", { activity: "idle", tool: null })];
    const capture = captureFrames();
    const host = document.createElement("div");
    host.style.cssText = "width: 2px; height: 2px; position: relative;";
    document.body.appendChild(host);
    render(<VillagePanel />, { container: host });
    await frames(5);
    host.style.width = "480px";
    host.style.height = "320px";
    const canvas = screen.getByTestId("village-canvas") as HTMLCanvasElement;
    await vi.waitFor(() => expect(canvas.width).toBe(Math.round(480 * devicePixelRatio)), { timeout: 2000 });
    await frames(10);
    const snap = await capture.next();
    const { cols, rows } = snap.view.world;
    // The camera is fitted to the GROWN stage, not to the 2 px sliver it first measured — below
    // the HUD (it used to sit on the top-left house's board): a village too big for the room
    // under the HUD starts right under it.
    const hud = screen.getByTestId("village-hud");
    const top = Math.round((hud.offsetTop + hud.offsetHeight + 6) * devicePixelRatio);
    expect(top).toBeGreaterThan(40 * devicePixelRatio);
    expect(top).toBeLessThanOrEqual(canvas.height / 2);
    // The village's Fit floor is ½: the largest sixteenth that shows it whole, else ½
    // with the world's top no lower than the HUD's edge and its bottom no higher than the stage's.
    const fit = fitCamera(cols * TILE, rows * TILE, canvas.width, canvas.height - top, 0.5);
    const cam = snap.view.camera;
    expect([cam.zoom, cam.ox]).toEqual([fit.zoom, fit.ox]);
    if (rows * TILE * cam.zoom <= canvas.height - top) expect(cam.oy).toBe(fit.oy + top);
    else {
      expect(cam.oy).toBeLessThanOrEqual(top);
      expect(cam.oy + rows * TILE * cam.zoom).toBeGreaterThanOrEqual(canvas.height);
    }
    // …so the canvas is the village, not a dark backdrop with a corner of it behind the HUD.
    expect(coverage(canvas).painted).toBeGreaterThan(0.5);
  });
});

describe("VillagePanel in a real browser — the city", () => {
  it("paints a city at the stage's size: a sky over the roofs, the street below, the floors in between", async () => {
    window.localStorage.setItem("agentstudio.village.mode", "city");
    model.agents = [agent("a"), agent("s", { parentKey: "a", activity: "reading", tool: "Read" })];
    sky.now = new Date(2026, 9, 15, 12, 0);
    const capture = captureFrames();
    const host = document.createElement("div");
    host.style.cssText = "width: 480px; height: 320px; position: relative;";
    document.body.appendChild(host);
    render(<VillagePanel />, { container: host });
    const canvas = screen.getByTestId("village-canvas") as HTMLCanvasElement;
    await vi.waitFor(() => expect(canvas.width).toBe(Math.round(480 * devicePixelRatio)), { timeout: 2000 });
    await frames(30);
    const snap = await capture.next();
    expect(snap.view.scene).toBe("city");
    // The sky backdrop runs to every edge: the whole canvas is painted, and it is pixel art.
    const { painted, colours } = coverage(canvas);
    expect(painted).toBe(1);
    expect(colours).toBeGreaterThan(30);
    // Top row: day sky (blue-dominant) from edge to edge.
    for (const x of [2, Math.floor(snap.width / 2), snap.width - 2]) {
      const i = (2 * snap.width + x) * 4;
      expect(snap.pixels[i + 2]).toBeGreaterThan(snap.pixels[i]);
    }
    // The City has both: the Seats hall — under the lounge, nothing
    // selected: '?' — and the lounge, where the leader and its sub-agent hold two of the 64 benches.
    expect(snap.view.world.props.filter((p) => p.capacity === "seats").map((p) => p.kind)).toEqual(["hall"]);
    expect(snap.view.world.props.filter((p) => p.kind === "bench" && p.capacity === "lounge")).toHaveLength(64);
    expect(screen.getByTestId("village-capacity")).toHaveTextContent(/^Seats \? · Memory \? · Usage \? · \? · Lounge 2\/64$/);
    // The leader is seated at its desk from the start. Its sub-agent has a desk of its own on the
    // leader's floor, but in a City with a lounge it first rides up from its bench
    // (engine/commute.ts, ≤ 12 s). Run the sim on (in its largest steps) and it sits there.
    const sim = snap.view.sim;
    expect(snap.chars.find((c) => c.key === "a")?.seated).toBe(true);
    expect(sim.seatFor("a")?.id).toBe("floor:a:lead");
    expect(sim.seatFor("s")?.id).toBe("floor:a:team:0");
    for (let i = 0; i < 150 && sim.seating().length < 2; i++) sim.tick(0.1);
    expect(sim.characters().map((c) => [c.key, c.seated])).toEqual([
      ["a", true],
      ["s", true],
    ]);
    expect(sim.seating().map((x) => [x.key, x.seatId])).toEqual([
      ["a", "floor:a:lead"],
      ["s", "floor:a:team:0"],
    ]);
    expect(canvas.getAttribute("aria-label")).toMatch(/^Agent City: 1 building, 1 floor \(0 consoles\);/);
    expect(screen.getByRole("radio", { name: "City" })).toHaveAttribute("aria-checked", "true");
  });
});
