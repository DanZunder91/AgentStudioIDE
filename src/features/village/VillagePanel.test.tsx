/**
 * VillagePanel — the wiring: data hook → VillageView → canvas, plus HUD, hover card,
 * click-to-select, pan/zoom/fit, and the loop's pause/teardown.
 *
 * Seams: `useVillageAgents` is mocked (its own tests live in villageModel.test.tsx), the
 * sprite loader is mocked (jsdom cannot decode PNGs), `getContext` returns the renderer's
 * recording fake (or null, the jsdom default), rAF is a manual queue, and the
 * ResizeObserver captures its callback so a test can "resize" the stage. The engine,
 * the renderer and `VillageView` are real; `VillageView.prototype.pick` is spied where a
 * test needs a character under the pointer (its geometry is pinned in villageView.test).
 * The Seats hall's `/context` read (both pictures: the Village's Seats house and the City's hall
 * under the lounge) is mocked at the IPC call (`contextUsage`); the app store's selection and the
 * context store are real (the hook's own tests: useHallAgent.test.tsx).
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  state: {
    agents: [] as import("./villageTypes").VillageAgent[],
    externalError: null as string | null,
    lastScanAt: null as number | null,
  },
  useVillageAgents: vi.fn(),
}));
const sprites = vi.hoisted(() => ({ loadSprites: vi.fn() }));
const ipc = vi.hoisted(() => ({ focusExternalAgent: vi.fn(), machineCapacity: vi.fn() }));
const logsFocus = vi.hoisted(() => ({ focusLogSource: vi.fn() }));
const ctxIpc = vi.hoisted(() => ({
  contextUsage: vi.fn<(agentId: string) => Promise<import("../context/contextTypes").ContextUsage>>(),
}));
const sky = vi.hoisted(() => ({
  state: {
    weather: null as import("./villageTypes").WeatherWire | null,
    weatherError: null as string | null,
    override: { weather: "auto", phase: "auto" } as import("./useVillageAmbience").AmbienceOverride,
    setOverride: (() => {}) as (o: import("./useVillageAmbience").AmbienceOverride) => void,
    now: new Date(2026, 9, 14, 15, 0, 0),
  },
}));

// Spread the real module: the city's console model borrows its `folderOf` (a `vi.mock` factory does not grow new exports).
vi.mock("./villageModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./villageModel")>()),
  useVillageAgents: model.useVillageAgents,
}));
// The sky hook's polling/storage has its own tests (useVillageAmbience.test.ts); here it is
// a fixed state so the panel's wiring is pinned at a known local time.
vi.mock("./useVillageAmbience", async (importOriginal) => {
  const real = await importOriginal<typeof import("./useVillageAmbience")>();
  return { ...real, useVillageAmbience: () => sky.state };
});
vi.mock("./villageIpc", async (importOriginal) => {
  const real = await importOriginal<typeof import("./villageIpc")>();
  return { ...real, focusExternalAgent: ipc.focusExternalAgent, machineCapacity: ipc.machineCapacity };
});
// The theme's own placements are tested in streetTheme.test.ts; here only that the panel dresses
// every world it builds for THIS machine's time zone, and shows the dressed one.
const theme = vi.hoisted(() => ({ calls: [] as { zone: string | undefined; out: unknown }[] }));
vi.mock("./engine/streetTheme", async (importOriginal) => {
  const real = await importOriginal<typeof import("./engine/streetTheme")>();
  return {
    ...real,
    dressWorld: (world: Parameters<typeof real.dressWorld>[0], zone: string | undefined) => {
      const out = real.dressWorld(world, zone);
      theme.calls.push({ zone, out });
      return out;
    },
  };
});
vi.mock("../agentlogs/agentLogsFocus", () => logsFocus);
// The Seats hall reads the selected agent's `/context` (one CLI process per read): the IPC call is
// the seam; the context store above it is real.
vi.mock("../context/contextIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/contextIpc")>()),
  contextUsage: ctxIpc.contextUsage,
}));
// The real draw list, observed: the LAN seam test reads the events each frame hands it (its 8th argument).
vi.mock("./engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("./engine")>();
  return { ...real, buildDrawList: vi.fn(real.buildDrawList) };
});
vi.mock("./render", async (importOriginal) => {
  const real = await importOriginal<typeof import("./render")>();
  return { ...real, loadSprites: sprites.loadSprites };
});

import { useAppStore } from "../../app/store";
import { asAgentId, type AgentNode } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetContextStore, useContextStore } from "../context/contextStore";
import type { ContextUsage } from "../context/contextTypes";
import { buildDrawList } from "./engine";
import { useUsageStore } from "../usage/usageStore";
import { resetStore } from "../../test/store-harness";
import { CITY } from "./render/city";
import { recorder, type RecordingTarget } from "./render/testRecorder";
import { CAPACITY_POLL_MS } from "./useMachineCapacity";
import type { VillageAgent } from "./villageTypes";
import { VillagePanel } from "./VillagePanel";
import { VillageView, WHEEL_IDLE_MS } from "./villageView";

function agent(key: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: `title-${key}`,
    folder: "gazelle",
    activity: "typing",
    tool: "Edit",
    ideAgentId: `id-${key}`,
    lastActivityAt: Date.now() - 3 * 60_000,
    ...extra,
  };
}

// ── rAF queue ──
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flush(now: number): void {
  const due = [...frames.values()];
  frames = new Map();
  for (const cb of due) cb(now);
}

// ── ResizeObserver capture ──
const ro = { cb: null as ResizeObserverCallback | null, disconnect: vi.fn(), observe: vi.fn() };
class CapturingRO {
  constructor(cb: ResizeObserverCallback) {
    ro.cb = cb;
  }
  observe = ro.observe;
  unobserve(): void {}
  disconnect = ro.disconnect;
}
function resizeTo(width: number, height: number): void {
  act(() => ro.cb?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let ctx: RecordingTarget | null;
const selectAgent = vi.fn();

beforeEach(() => {
  resetStore();
  const s = useAppStore.getState();
  useAppStore.setState({ agentActions: { ...s.agentActions, selectAgent } });
  selectAgent.mockReset();
  model.state = { agents: [], externalError: null, lastScanAt: null };
  model.useVillageAgents.mockReset();
  model.useVillageAgents.mockImplementation(() => model.state);
  sky.state = {
    weather: null,
    weatherError: null,
    override: { weather: "auto", phase: "auto" },
    setOverride: vi.fn(),
    now: new Date(2026, 9, 14, 15, 0, 0),
  };
  ipc.focusExternalAgent.mockReset();
  ipc.focusExternalAgent.mockResolvedValue(undefined);
  ipc.machineCapacity.mockReset();
  ipc.machineCapacity.mockRejectedValue("unsupported");
  ctxIpc.contextUsage.mockReset();
  ctxIpc.contextUsage.mockReturnValue(new Promise(() => {}));
  sprites.loadSprites.mockReset();
  sprites.loadSprites.mockResolvedValue(null);
  frames = new Map();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal("ResizeObserver", CapturingRO);
  ro.cb = null;
  ro.disconnect.mockReset();
  ro.observe.mockReset();
  ctx = recorder();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  resetContextStore();
  resetFleetStore();
  useUsageStore.setState({ snapshot: null, error: null, loading: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

function canvas(): HTMLCanvasElement {
  return screen.getByTestId("village-canvas") as HTMLCanvasElement;
}

async function mount(): Promise<ReturnType<typeof render>> {
  const r = render(<VillagePanel />);
  await act(async () => {}); // let the sprite promise settle
  return r;
}

describe("VillagePanel — shell", () => {
  it("renders the empty village: HUD counts, accessible summary and the empty state", async () => {
    await mount();
    expect(screen.getByTestId("village-panel")).toBeInTheDocument();
    expect(screen.getByTestId("village-hud")).toHaveTextContent("0 in IDE · 0 outside · 0 active");
    expect(canvas()).toHaveAttribute("role", "img");
    expect(canvas()).toHaveAttribute(
      "aria-label",
      "Agent Village: 0 in the IDE, 0 outside the IDE, 0 active — Afternoon",
    );
    expect(screen.getByTestId("village-empty")).toHaveTextContent(
      "No agents running — launch one with + or run claude in any terminal",
    );
    expect(model.useVillageAgents).toHaveBeenCalledWith({ includeExternal: true });
  });

  it("counts agents and hides the empty state once there are any", async () => {
    model.state = {
      ...model.state,
      agents: [agent("a"), agent("b", { origin: "external", ideAgentId: null, activity: "idle" })],
    };
    await mount();
    expect(screen.getByTestId("village-hud")).toHaveTextContent("1 in IDE · 1 outside · 1 active");
    expect(screen.queryByTestId("village-empty")).toBeNull();
  });

  it("toggles agents outside the IDE", async () => {
    await mount();
    const sw = screen.getByRole("switch", { name: "Show agents outside the IDE" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(model.useVillageAgents).toHaveBeenLastCalledWith({ includeExternal: false });
  });

  it("shows a scan error inline, coded and non-blocking", async () => {
    model.state = { ...model.state, externalError: "io" };
    await mount();
    expect(screen.getByTestId("village-error")).toHaveTextContent(
      "Couldn't scan agents outside the IDE (io)",
    );
    expect(canvas()).toBeInTheDocument();
  });
});

describe("VillagePanel — sky", () => {
  const rain = {
    kind: "rain" as const,
    intensity: 0.7,
    temperatureC: 18.4,
    wind: 0.2,
    sunriseMs: null,
    sunsetMs: null,
    place: "Tokyo",
    fetchedAtMs: 0,
  };

  it("a rainy afternoon: the chip, the accessible name and the view's ambience", async () => {
    sky.state = { ...sky.state, weather: rain };
    const setAmbience = vi.spyOn(VillageView.prototype, "setAmbience");
    await mount();
    expect(canvas().getAttribute("aria-label")).toMatch(/— Raining · afternoon$/);
    const chip = screen.getByTestId("village-sky");
    expect(chip).toHaveAttribute("data-weather", "rain");
    expect(chip).toHaveAttribute("data-phase", "afternoon");
    expect(chip).toHaveTextContent("Rain · 15:00 · Afternoon · 18°C · Tokyo");
    expect(screen.getByTestId("village-hud")).toContainElement(chip);
    const amb = setAmbience.mock.lastCall![0];
    expect(amb).toMatchObject({ phase: "afternoon", weather: "rain", stayIndoors: true });
  });

  it("an override wins over the live sky; with neither, only the time is named", async () => {
    sky.state = { ...sky.state, override: { weather: "storm", phase: "night" } };
    const { rerender } = await mount();
    expect(canvas().getAttribute("aria-label")).toMatch(/— Stormy · night$/);
    sky.state = { ...sky.state, override: { weather: "auto", phase: "auto" }, now: new Date(2026, 9, 14, 9, 0, 0) };
    rerender(<VillagePanel />);
    expect(canvas().getAttribute("aria-label")).toMatch(/— Morning$/);
  });

  it("recomputes the sky only when its inputs change", async () => {
    const setAmbience = vi.spyOn(VillageView.prototype, "setAmbience");
    const { rerender } = await mount();
    const n = setAmbience.mock.calls.length;
    rerender(<VillagePanel />);
    expect(setAmbience.mock.calls.length).toBe(n);
    sky.state = { ...sky.state, weather: rain };
    rerender(<VillagePanel />);
    expect(setAmbience.mock.calls.length).toBe(n + 1);
  });

  it("paints the sky into the frame (the outdoor mask is clipped)", async () => {
    sky.state = { ...sky.state, weather: rain };
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    resizeTo(300, 200);
    flush(1000);
    flush(1016);
    expect(ctx!.of("clip").length).toBeGreaterThan(0);
  });
});

describe("VillagePanel — canvas and loop", () => {
  it("sizes the backing store to CSS × DPR and paints each frame, characters included", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    resizeTo(300, 200);
    expect(canvas().width).toBe(600);
    expect(canvas().height).toBe(400);
    expect(ro.observe).toHaveBeenCalled();
    flush(1000);
    const before = ctx!.of("clearRect").length;
    flush(1016);
    // A frame per rAF tick, and the agent reached it: its name label is painted.
    expect(ctx!.of("clearRect").length).toBe(before + 1);
    expect(ctx!.of("fillText").map((t) => t.args[0])).toContain("title-a");
  });

  it("publishes where the capacity buildings are on screen, rewriting it only when it changes", async () => {
    const set = vi.spyOn(HTMLCanvasElement.prototype, "setAttribute");
    const writes = (): number => set.mock.calls.filter((c) => c[0] === "data-capacity-boxes").length;
    const boxes = (): { kind: string; x: number; y: number; w: number; h: number }[] =>
      JSON.parse(canvas().getAttribute("data-capacity-boxes") ?? "null") as never;
    const shown = vi.spyOn(VillageView.prototype, "capacityBoxes");
    await mount();
    resizeTo(1200, 900);
    flush(1000);
    expect(boxes().map((b) => b.kind).sort()).toEqual(["memory", "seats", "usage"]);
    expect(boxes()).toEqual(shown.mock.results.at(-1)!.value);
    expect(writes()).toBe(1);
    // Same camera, same boxes: the attribute is not rewritten every frame.
    flush(1016);
    flush(1032);
    expect(writes()).toBe(1);
    // Zoomed in: the buildings moved, and the attribute follows on the next frame.
    const before = canvas().getAttribute("data-capacity-boxes");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    flush(1048);
    expect(canvas().getAttribute("data-capacity-boxes")).not.toBe(before);
    expect(writes()).toBe(2);
    // The City's HQ floors, its lounge under the street and the Seats hall under that replace the village's houses.
    fireEvent.click(screen.getByRole("radio", { name: "City" }));
    resizeTo(1200, 900);
    flush(1064);
    expect(boxes()).toEqual(shown.mock.results.at(-1)!.value);
    expect(boxes().map((b) => b.kind).sort()).toEqual(["lounge", "memory", "seats", "usage"]);
  });

  it("publishes where the neon signs are on screen, rewriting it only when it changes", async () => {
    const set = vi.spyOn(HTMLCanvasElement.prototype, "setAttribute");
    const writes = (): number => set.mock.calls.filter((c) => c[0] === "data-neon-boxes").length;
    const signs = (): { building: string; language: string }[] =>
      JSON.parse(canvas().getAttribute("data-neon-boxes") ?? "null") as never;
    const shown = vi.spyOn(VillageView.prototype, "neonBoxes");
    window.localStorage.setItem("agentstudio.village.mode", "city");
    model.state = { ...model.state, agents: [agent("a", { language: "rust" })] };
    await mount();
    resizeTo(1200, 900);
    flush(1000);
    expect(signs().map((b) => [b.building, b.language])).toEqual([["gazelle", "rust"]]);
    expect(signs()).toEqual(shown.mock.results.at(-1)!.value);
    const once = writes();
    flush(1016);
    flush(1032);
    expect(writes()).toBe(once);
    // Zoomed in: the sign moved, and the attribute follows.
    const before = canvas().getAttribute("data-neon-boxes");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    flush(1048);
    expect(canvas().getAttribute("data-neon-boxes")).not.toBe(before);
    expect(writes()).toBe(once + 1);
  });

  it("publishes where the skyline landmarks' crowns are on screen, rewriting it only when it changes", async () => {
    // This machine's zone is whatever the test host's is: the views get a Tokyo sky, so the City has landmarks.
    const real = VillageView.prototype.setAmbience;
    vi.spyOn(VillageView.prototype, "setAmbience").mockImplementation(function (this: VillageView, amb) {
      real.call(this, { ...amb, zone: "Asia/Tokyo" });
    });
    const set = vi.spyOn(HTMLCanvasElement.prototype, "setAttribute");
    const writes = (): number => set.mock.calls.filter((c) => c[0] === "data-landmark-boxes").length;
    const crowns = (): { kind: string; x: number; y: number; w: number; h: number }[] =>
      JSON.parse(canvas().getAttribute("data-landmark-boxes") ?? "null") as never;
    const shown = vi.spyOn(VillageView.prototype, "landmarkBoxes");
    window.localStorage.setItem("agentstudio.village.mode", "city");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    resizeTo(1200, 900);
    flush(1000);
    expect(crowns().map((b) => b.kind)).toEqual(["fuji", "skytree", "tokyo-tower"]);
    expect(crowns()).toEqual(shown.mock.results.at(-1)!.value);
    const once = writes();
    flush(1016);
    flush(1032);
    expect(writes()).toBe(once);
    // Zoomed in: the crowns moved with the street, and the attribute follows.
    const before = canvas().getAttribute("data-landmark-boxes");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    flush(1048);
    expect(canvas().getAttribute("data-landmark-boxes")).not.toBe(before);
    expect(writes()).toBe(once + 1);
    expect(crowns()).toEqual(shown.mock.results.at(-1)!.value);
  });

  it("hands the loaded sprite bank to the view", async () => {
    const bank = { fallback: true } as never;
    sprites.loadSprites.mockResolvedValue(bank);
    const setBank = vi.spyOn(VillageView.prototype, "setBank");
    await mount();
    expect(setBank).toHaveBeenCalledWith(bank);
  });

  it("drops a sprite bank that arrives after unmount", async () => {
    let resolve!: (b: unknown) => void;
    sprites.loadSprites.mockReturnValue(new Promise((r) => (resolve = r)));
    const setBank = vi.spyOn(VillageView.prototype, "setBank");
    const { unmount } = render(<VillagePanel />);
    unmount();
    await act(async () => resolve({ fallback: true }));
    expect(setBank).not.toHaveBeenCalled();
  });

  it("still works without a 2D context (the jsdom default)", async () => {
    ctx = null;
    const frame = vi.spyOn(VillageView.prototype, "frame");
    await mount();
    flush(10);
    expect(frame).toHaveBeenCalledWith(10, null);
    expect(screen.getByTestId("village-hud")).toBeInTheDocument();
  });

  it("pauses while the document is hidden and resumes when visible", async () => {
    const pause = vi.spyOn(VillageView.prototype, "pause");
    const frame = vi.spyOn(VillageView.prototype, "frame");
    await mount();
    expect(frames.size).toBe(1);
    setHidden(true);
    expect(frames.size).toBe(0);
    expect(pause).toHaveBeenCalledTimes(1);
    flush(5);
    expect(frame).not.toHaveBeenCalled();
    setHidden(false);
    expect(frames.size).toBe(1);
    flush(6);
    expect(frame).toHaveBeenCalledTimes(1);
  });

  it("tears everything down on unmount", async () => {
    const { unmount } = await mount();
    const c = canvas();
    const remove = vi.spyOn(c, "removeEventListener");
    unmount();
    expect(frames.size).toBe(0);
    expect(ro.disconnect).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
  });

  it("rebuilds the world only when the house plan changes", async () => {
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    const setAgents = vi.spyOn(VillageView.prototype, "setAgents");
    model.state = { ...model.state, agents: [agent("a")] };
    const { rerender } = await mount();
    const worlds = setWorld.mock.calls.length;
    model.state = { ...model.state, agents: [agent("a", { activity: "idle", tool: null })] };
    rerender(<VillagePanel />);
    expect(setWorld.mock.calls.length).toBe(worlds);
    expect(setAgents).toHaveBeenLastCalledWith(model.state.agents);
    model.state = { ...model.state, agents: [agent("a"), agent("b", { folder: "other" })] };
    rerender(<VillagePanel />);
    expect(setWorld.mock.calls.length).toBe(worlds + 1);
  });
});

describe("VillagePanel — camera", () => {
  it("zooms with the wheel, anchored at the cursor, and swallows the scroll", async () => {
    const zoomBy = vi.spyOn(VillageView.prototype, "zoomBy");
    await mount();
    const up = new WheelEvent("wheel", { deltaY: -120, clientX: 40, clientY: 30, cancelable: true });
    canvas().dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(zoomBy).toHaveBeenLastCalledWith(1, { x: 40, y: 30 });
    canvas().dispatchEvent(new WheelEvent("wheel", { deltaY: 120, clientX: 1, clientY: 2, cancelable: true }));
    expect(zoomBy).toHaveBeenLastCalledWith(-1, { x: 1, y: 2 });
    zoomBy.mockClear();
    canvas().dispatchEvent(new WheelEvent("wheel", { deltaX: 50, deltaY: 0, cancelable: true }));
    expect(zoomBy).not.toHaveBeenCalled();
  });

  it("accumulates small trackpad deltas into one zoom step per wheel notch", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const zoomBy = vi.spyOn(VillageView.prototype, "zoomBy");
    await mount();
    const wheel = (deltaY: number, deltaMode = 0): void => {
      canvas().dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, cancelable: true }));
    };
    // A flick: 20 events of -6 px = 120 px → two steps, not twenty.
    for (let i = 0; i < 20; i++) wheel(-6);
    expect(zoomBy).toHaveBeenCalledTimes(2);
    expect(zoomBy.mock.calls.every((c) => c[0] === 1)).toBe(true);
    // Line mode: 3 lines = 48 px is below one step; a 4th line crosses it.
    zoomBy.mockClear();
    now += 1_000;
    wheel(3, 1);
    expect(zoomBy).not.toHaveBeenCalled();
    wheel(1, 1);
    expect(zoomBy).toHaveBeenCalledTimes(1);
    expect(zoomBy).toHaveBeenLastCalledWith(-1, expect.anything());
    // A pause drops the remainder: 40 px, a pause, 40 px is no step.
    zoomBy.mockClear();
    wheel(-40);
    now += WHEEL_IDLE_MS + 1;
    wheel(-40);
    expect(zoomBy).not.toHaveBeenCalled();
    // An unknown deltaMode counts as pixels.
    wheel(-20, 7);
    expect(zoomBy).toHaveBeenCalledTimes(1);
  });

  it("has zoom-out, zoom-in and Fit buttons", async () => {
    const zoomBy = vi.spyOn(VillageView.prototype, "zoomBy");
    const fit = vi.spyOn(VillageView.prototype, "fit");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomBy).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomBy).toHaveBeenLastCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(fit).toHaveBeenCalled();
  });

  it("pans by dragging; a drag is never a click", async () => {
    const pan = vi.spyOn(VillageView.prototype, "pan");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    const c = canvas();
    fireEvent.mouseDown(c, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(c, { clientX: 12, clientY: 10 }); // within the slop
    expect(c.className).not.toContain("grabbing");
    fireEvent.mouseMove(c, { clientX: 30, clientY: 25 });
    expect(pan.mock.calls).toEqual([
      [2, 0],
      [18, 15],
    ]);
    expect(c.className).toContain("village__canvas--grabbing");
    expect(screen.queryByTestId("village-card")).toBeNull();
    fireEvent.mouseMove(c, { clientX: 31, clientY: 25 });
    expect(pan).toHaveBeenLastCalledWith(1, 0);
    fireEvent.mouseUp(c, { clientX: 31, clientY: 25 });
    expect(selectAgent).not.toHaveBeenCalled();
    expect(c.className).not.toContain("grabbing");
  });

  it("ignores non-primary buttons", async () => {
    const pan = vi.spyOn(VillageView.prototype, "pan");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    fireEvent.mouseDown(canvas(), { button: 2, clientX: 1, clientY: 1 });
    fireEvent.mouseMove(canvas(), { clientX: 50, clientY: 50 });
    fireEvent.mouseUp(canvas(), { clientX: 50, clientY: 50 });
    expect(pan).not.toHaveBeenCalled();
    expect(selectAgent).not.toHaveBeenCalled();
  });
});

describe("VillagePanel — hover and click", () => {
  it("shows an IDE agent's card on hover, with a pointer cursor", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 20, clientY: 30 });
    const card = screen.getByTestId("village-card");
    expect(card).toHaveTextContent("title-a");
    expect(card).toHaveTextContent("Folder gazelle");
    expect(card).toHaveTextContent("In the IDE");
    expect(card).toHaveTextContent("Typing · Edit");
    expect(card).toHaveTextContent("Last active 3 min ago");
    expect(card).toHaveTextContent("Click to open");
    expect(card.style.left).toBe("34px");
    expect(card.style.top).toBe("44px");
    expect(canvas().className).toContain("village__canvas--pointer");
  });

  it("shows an external agent's card without the click hint or a last-active line", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("ext:k");
    model.state = {
      ...model.state,
      agents: [agent("ext:k", { origin: "external", ideAgentId: null, lastActivityAt: null, tool: null })],
    };
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 1, clientY: 1 });
    const card = screen.getByTestId("village-card");
    expect(card).toHaveTextContent("Outside the IDE");
    expect(card).not.toHaveTextContent("Click to open");
    expect(card).not.toHaveTextContent("Last active");
    expect(canvas().className).not.toContain("pointer");
  });

  it("hides the card off a character, for a vanished agent, and on leave", async () => {
    const pick = vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 1, clientY: 1 });
    expect(screen.getByTestId("village-card")).toBeInTheDocument();
    pick.mockReturnValue(null);
    fireEvent.mouseMove(canvas(), { clientX: 2, clientY: 2 });
    expect(screen.queryByTestId("village-card")).toBeNull();
    pick.mockReturnValue("gone"); // a despawning character no longer in the list
    fireEvent.mouseMove(canvas(), { clientX: 3, clientY: 3 });
    expect(screen.queryByTestId("village-card")).toBeNull();
    pick.mockReturnValue("a");
    fireEvent.mouseMove(canvas(), { clientX: 4, clientY: 4 });
    fireEvent.mouseLeave(canvas());
    expect(screen.queryByTestId("village-card")).toBeNull();
  });

  it("clicking an IDE character selects its agent", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(canvas(), { clientX: 5, clientY: 5 });
    expect(selectAgent).toHaveBeenCalledWith("id-a");
  });

  it("shows an outside agent's app on its card, with a pointer cursor", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("ext:k");
    model.state = {
      ...model.state,
      agents: [agent("ext:k", { origin: "external", ideAgentId: null, host: "iTerm2" })],
    };
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 1, clientY: 1 });
    const card = screen.getByTestId("village-card");
    expect(card).toHaveTextContent("Running in iTerm2 — click to switch");
    expect(card).not.toHaveTextContent("Outside the IDE");
    expect(canvas().className).toContain("village__canvas--pointer");
  });

  it("clicking an outside character with a known app focuses it by its Rust key", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("ext:0123abcd");
    model.state = {
      ...model.state,
      agents: [agent("ext:0123abcd", { origin: "external", ideAgentId: null, host: "Terminal" })],
    };
    await mount();
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(canvas(), { clientX: 5, clientY: 5 });
    expect(ipc.focusExternalAgent).toHaveBeenCalledWith("0123abcd");
    expect(selectAgent).not.toHaveBeenCalled();
    await act(async () => {});
    expect(screen.queryByTestId("village-focus-error")).toBeNull();
  });

  it("shows a failed focus inline, coded, and clears it on the next try", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("ext:k");
    model.state = {
      ...model.state,
      agents: [agent("ext:k", { origin: "external", ideAgentId: null, host: "iTerm2" })],
    };
    ipc.focusExternalAgent.mockRejectedValueOnce("no-host: /Users/x/secret");
    await mount();
    const click = async (): Promise<void> => {
      fireEvent.mouseDown(canvas(), { button: 0, clientX: 5, clientY: 5 });
      fireEvent.mouseUp(canvas(), { clientX: 5, clientY: 5 });
      await act(async () => {});
    };
    await click();
    const err = screen.getByTestId("village-focus-error");
    expect(err).toHaveTextContent("Couldn't switch to that agent's app (no-host)");
    expect(err).not.toHaveTextContent("secret");
    expect(canvas()).toBeInTheDocument();
    await click();
    expect(screen.queryByTestId("village-focus-error")).toBeNull();
    expect(ipc.focusExternalAgent).toHaveBeenCalledTimes(2);
  });

  it("clicking an external character, empty ground or a stray mouseup selects nothing", async () => {
    const pick = vi.spyOn(VillageView.prototype, "pick").mockReturnValue("ext:k");
    model.state = {
      ...model.state,
      agents: [agent("ext:k", { origin: "external", ideAgentId: null }), agent("x", { ideAgentId: null })],
    };
    await mount();
    const click = (): void => {
      fireEvent.mouseDown(canvas(), { button: 0, clientX: 5, clientY: 5 });
      fireEvent.mouseUp(canvas(), { clientX: 5, clientY: 5 });
    };
    click();
    pick.mockReturnValue(null);
    click();
    pick.mockReturnValue("x"); // an IDE character without an agent id
    click();
    fireEvent.mouseUp(canvas(), { clientX: 5, clientY: 5 }); // no press first
    expect(selectAgent).not.toHaveBeenCalled();
    // An outside character with no known app has nothing to focus.
    expect(ipc.focusExternalAgent).not.toHaveBeenCalled();
  });

  it("a mouse leave mid-drag ends the drag", async () => {
    const pan = vi.spyOn(VillageView.prototype, "pan");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    await mount();
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseLeave(canvas());
    fireEvent.mouseMove(canvas(), { clientX: 40, clientY: 40 });
    expect(pan).not.toHaveBeenCalled();
  });
});

describe("VillagePanel — Village | City", () => {
  /** A plain console tab in the store (its PTY has not opened: the registry knows nothing yet). */
  function console1(): void {
    useAppStore.setState({
      tabs: { ["tab-c1" as never]: { id: "tab-c1" as never, kind: "terminal", title: "zsh", ref: { kind: "terminal", terminalId: "c1" as never } } },
    });
  }
  const mode = () => screen.getByRole("radiogroup", { name: "Picture" });
  const pick = (name: "Village" | "City") => fireEvent.click(screen.getByRole("radio", { name }));

  it("shows the village by default, switches to the city on request, and remembers the choice", async () => {
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    expect(screen.getByRole("radio", { name: "Village" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("village-panel")).toHaveAttribute("data-mode", "village");
    expect(screen.getByTestId("village-hud")).toContainElement(mode());
    pick("City");
    expect(screen.getByRole("radio", { name: "City" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Village" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("village-panel")).toHaveAttribute("data-mode", "city");
    expect(window.localStorage.getItem("agentstudio.village.mode")).toBe("city");
    expect(canvas().getAttribute("aria-label")).toBe(
      "Agent City: 1 building, 1 floor (0 consoles); 1 agents in the IDE, 0 outside the IDE, 1 active — Afternoon",
    );
    expect(screen.getByTestId("village-hud")).toHaveTextContent("1 in IDE · 0 outside · 1 active · 0 consoles");
    pick("Village");
    expect(canvas().getAttribute("aria-label")).toMatch(/^Agent Village: /);
    expect(window.localStorage.getItem("agentstudio.village.mode")).toBe("village");
  });

  it("opens in the city when that is what the viewer chose last", async () => {
    window.localStorage.setItem("agentstudio.village.mode", "city");
    await mount();
    expect(screen.getByRole("radio", { name: "City" })).toHaveAttribute("aria-checked", "true");
  });

  it("builds the city: every root agent and console a floor, the sim seated by floor, in a view of its own", async () => {
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    const setAgents = vi.spyOn(VillageView.prototype, "setAgents");
    console1();
    model.state = { ...model.state, agents: [agent("a"), agent("s", { parentKey: "a" })] };
    await mount();
    const village = setWorld.mock.contexts.at(-1) as VillageView;
    pick("City");
    await act(async () => {});
    const cityView = setWorld.mock.contexts.at(-1) as VillageView;
    expect(cityView).not.toBe(village);
    expect(cityView.scene).toBe("city");
    const world = setWorld.mock.lastCall![0];
    // Plus the Capacity HQ — its Memory and Usage floors — the lounge under the street
    // and the Seats hall under the lounge (in both views): no one's.
    expect(world.city!.buildings.map((b) => b.key).sort()).toEqual(["Terminals", "cap/hq", "gazelle"]);
    expect(world.houses.filter((h) => !h.capacity).map((h) => h.label).sort()).toEqual(["title-a", "zsh"]);
    expect(world.houses.filter((h) => h.capacity).map((h) => [h.capacity, h.key, h.label])).toEqual([
      ["memory", "cap/memory", "Memory"],
      ["usage", "cap/usage", "Usage"],
      ["lounge", "cap/lounge", "Lounge"],
      ["seats", "cap/seats", "Seats"],
    ]);
    expect(world.city!.lounge!.key).toBe("cap/lounge");
    const seated = setAgents.mock.lastCall![0];
    // "Terminals" sorts before "gazelle" (code-unit order, the village's rule).
    expect(seated.map((a) => [a.key, a.parentKey, a.folder])).toEqual([
      ["term:c1", null, "floor:term:c1"],
      ["a", null, "floor:a"],
      ["s", "a", "floor:a"],
    ]);
    expect(screen.getByTestId("village-hud")).toHaveTextContent("· 1 consoles");
    expect(screen.queryByTestId("village-empty")).toBeNull();
  });

  it("rebuilds the city only when its shape changes — not on a sub-agent who fits the desks already there", async () => {
    window.localStorage.setItem("agentstudio.village.mode", "city");
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    const sub = (k: string) => agent(k, { parentKey: "a" });
    model.state = { ...model.state, agents: [agent("a"), sub("s1")] };
    const { rerender } = await mount();
    const worlds = setWorld.mock.calls.length;
    // A second sub-agent takes the other seat of the same desk of two: same building, same world.
    model.state = { ...model.state, agents: [agent("a"), sub("s1"), sub("s2")] };
    rerender(<VillagePanel />);
    expect(setWorld.mock.calls.length).toBe(worlds);
    // A third needs a second desk — a wider building, so a new world.
    model.state = { ...model.state, agents: [agent("a"), sub("s1"), sub("s2"), sub("s3")] };
    rerender(<VillagePanel />);
    expect(setWorld.mock.calls.length).toBe(worlds + 1);
  });

  it("hovering a console shows a console's card; clicking it brings its terminal tab to the front", async () => {
    console1();
    window.localStorage.setItem("agentstudio.village.mode", "city");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("term:c1");
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 3, clientY: 3 });
    const card = screen.getByTestId("village-card");
    expect(card).toHaveTextContent("zsh");
    expect(card).toHaveTextContent("Folder Terminals");
    expect(card).toHaveTextContent("Console in the IDE");
    expect(card).toHaveTextContent("At the prompt");
    expect(card).toHaveTextContent("Click to open");
    expect(canvas().className).toContain("village__canvas--pointer");
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 3, clientY: 3 });
    fireEvent.mouseUp(canvas(), { clientX: 3, clientY: 3 });
    expect(logsFocus.focusLogSource).toHaveBeenCalledWith({ terminalId: "c1", agentId: null });
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("an empty city says nothing is running — and paints its street and sky regardless", async () => {
    window.localStorage.setItem("agentstudio.village.mode", "city");
    await mount();
    expect(screen.getByTestId("village-empty")).toHaveTextContent("Nothing running — open a terminal, or launch an agent with +");
    resizeTo(300, 200);
    flush(1000);
    flush(1016);
    // The city's sky (its top bands may sit above a small view) and its street.
    const styles = new Set(ctx!.of("fillRect").map((f) => f.fillStyle));
    expect(CITY.sky.some((c) => styles.has(c))).toBe(true);
    expect(styles.has(CITY.sidewalk)).toBe(true);
  });

  it("keeps each picture's own camera, and drops the card of a character from the other picture", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    resizeTo(600, 400);
    const zoomBy = vi.spyOn(VillageView.prototype, "zoomBy");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomBy.mock.results[0].value).toBe(true);
    const zoomedView = zoomBy.mock.contexts[0] as VillageView;
    const zoomed = zoomedView.camera;
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    fireEvent.mouseMove(canvas(), { clientX: 3, clientY: 3 });
    expect(screen.getByTestId("village-card")).toBeInTheDocument();
    pick("City");
    expect(screen.queryByTestId("village-card")).toBeNull();
    pick("Village");
    const village = setWorld.mock.contexts.at(-1) as VillageView;
    expect(village.scene).toBe("village");
    expect(village).toBe(zoomedView);
    expect(village.camera).toEqual(zoomed); // the zoom from before the round trip
  });
});

describe("VillagePanel — capacity", () => {
  const GB = 1024 ** 3;
  const sample = {
    logicalCpus: 6,
    totalMemBytes: 16 * GB,
    availableMemBytes: 4 * GB,
    agents: { sessions: 2, claudeProcesses: 3, claudeRssBytes: GB, toolProcesses: 4, toolRssBytes: GB },
    sampledAtMs: 0,
  };

  /** A pointer move over the canvas (what is under it is decided by the test's `pick` / `pickCapacity` spies). */
  function hover(x = 10, y = 20): void {
    fireEvent.mouseMove(canvas(), { clientX: x, clientY: y });
  }

  /** A root agent in the app store, selected in the rail (the hall's agent). */
  function selectRoot(id: string, title: string): void {
    const node: AgentNode = { ...wireAgent({ id: asAgentId(id), title }), childIds: [], sessionId: null, expanded: false, unread: 0 };
    act(() => {
      useAppStore.setState((s) => {
        s.agents[node.id] = node;
        s.rootAgentIds.push(node.id);
        s.selection.selectedAgentId = node.id;
      });
    });
  }

  /** A realistic `/context` reading: 23 seats taken, 7 reserved, 170 free (capacityModel.test seats it by hand). */
  const REFERENCE: ContextUsage = {
    model: "claude-opus-5-5",
    usedTokens: 109_900,
    windowTokens: 1_000_000,
    usedPercent: 11,
    categories: [
      { key: "system-prompt", label: "System prompt", tokens: 4_200, percent: 0.4 },
      { key: "system-tools", label: "System tools", tokens: 20_200, percent: 2.0 },
      { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
      { key: "memory-files", label: "Memory files", tokens: 2_100, percent: 0.2 },
      { key: "skills", label: "Skills", tokens: 6_800, percent: 0.7 },
      { key: "messages", label: "Messages", tokens: 75_900, percent: 7.6 },
      { key: "free-space", label: "Free space", tokens: 857_100, percent: 85.7 },
      { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
    ],
    measuredAtMs: 0,
  };

  it("reads machine_capacity and builds the Seats house as the context hall — 'Seats ?' with nothing selected", async () => {
    ipc.machineCapacity.mockResolvedValue(sample);
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    // The figures in words describe the canvas (assistive tech, and the E2E's handle).
    const words = screen.getByTestId("village-capacity");
    expect(words).toHaveTextContent("Seats ? · Memory 2.0 GB · Usage ? · ?");
    expect(canvas()).toHaveAttribute("aria-describedby", words.id);
    expect(ipc.machineCapacity).toHaveBeenCalled();
    const world = setWorld.mock.lastCall![0];
    // One hall prop fills the Seats house — no desks or PCs any more, whatever the machine.
    expect(world.props.filter((p) => p.capacity === "seats").map((p) => p.kind)).toEqual(["hall"]);
    expect(world.props.some((p) => p.kind === "pc" && p.capacity === "seats")).toBe(false);
    expect(world.houses.filter((h) => h.capacity).map((h) => h.label)).toEqual(["Seats", "Memory", "Usage"]);
    // Nothing selected: nothing to read.
    expect(ctxIpc.contextUsage).not.toHaveBeenCalled();
  });

  it("the hall seats the SELECTED agent's context window: read once, then 'Seats 23/200' and its card", async () => {
    let land!: (u: ContextUsage) => void;
    ctxIpc.contextUsage.mockReturnValue(new Promise<ContextUsage>((r) => (land = r)));
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("seats");
    const setCapacity = vi.spyOn(VillageView.prototype, "setCapacity");
    selectRoot("root-a", "gazelle");
    await mount();
    expect(ctxIpc.contextUsage.mock.calls).toEqual([["root-a"]]);
    // In flight: still no reading — '?', and the card says it is reading.
    const words = screen.getByTestId("village-capacity");
    expect(words).toHaveTextContent(/^Seats \? · /);
    hover();
    expect(screen.getByTestId("village-capacity-card")).toHaveTextContent("Reading gazelle's context window…");

    await act(async () => land(REFERENCE));
    expect(words).toHaveTextContent(/^Seats 23\/200 · Memory \? · Usage \? · \?$/);
    expect(setCapacity.mock.lastCall![0].hallAgent).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
    const view = setCapacity.mock.contexts.at(-1) as VillageView;
    expect(view.capacityFrame!.desks).toEqual([]);
    expect(view.capacityFrame!.hall!.cells).toHaveLength(200);
    expect(view.capacityFrame!.hall!.usedPct).toBe(11);
    hover();
    const card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveTextContent("Seats — gazelle's context window");
    expect(card).toHaveTextContent("23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free");
    expect(card).toHaveTextContent("claude-opus-5-5 · 109.9k / 1m tokens (11%)");
    expect(card).toHaveTextContent("Messages: 75.9k tokens (7.6%)");
    // The same reading on re-render: no second process.
    expect(ctxIpc.contextUsage).toHaveBeenCalledTimes(1);
  });

  it("the City reads the hall's agent too (the hall is in both views) — 'Seats 23/200' beside 'Lounge 0/64' — and the Village shows the same reading", async () => {
    ctxIpc.contextUsage.mockResolvedValue(REFERENCE);
    window.localStorage.setItem("agentstudio.village.mode", "city");
    const setCapacity = vi.spyOn(VillageView.prototype, "setCapacity");
    selectRoot("root-a", "gazelle");
    await mount();
    expect(ctxIpc.contextUsage.mock.calls).toEqual([["root-a"]]);
    expect(screen.getByTestId("village-capacity")).toHaveTextContent(/^Seats 23\/200 · Memory \? · Usage \? · \? · Lounge 0\/64$/);
    const cityView = setCapacity.mock.contexts.at(-1) as VillageView;
    expect(cityView.scene).toBe("city");
    expect(setCapacity.mock.lastCall![0].hallAgent).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
    expect(cityView.capacityFrame!.hall.cells).toHaveLength(200);
    expect(cityView.capacityFrame!.hall.usedPct).toBe(11);
    expect(cityView.capacityFrame!.desks).toHaveLength(64);
    fireEvent.click(screen.getByRole("radio", { name: "Village" }));
    await act(async () => {});
    // The same selection: no second process, the same board — and no lounge in the Village.
    expect(ctxIpc.contextUsage.mock.calls).toEqual([["root-a"]]);
    expect(screen.getByTestId("village-capacity")).toHaveTextContent(/^Seats 23\/200 · Memory \? · Usage \? · \?$/);
  });

  it("reads the hall's agent only while the panel is on screen — in either picture", async () => {
    ctxIpc.contextUsage.mockResolvedValue(REFERENCE);
    window.localStorage.setItem("agentstudio.village.mode", "city");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    selectRoot("root-a", "gazelle");
    await mount();
    expect(ctxIpc.contextUsage).not.toHaveBeenCalled();
    setHidden(false);
    await act(async () => {});
    expect(ctxIpc.contextUsage.mock.calls).toEqual([["root-a"]]);
  });

  it("in the City the lounge under the street has a fixed 64 benches — 'Lounge N/64', its own card — and the Seats are the hall in both pictures", async () => {
    ipc.machineCapacity.mockResolvedValue(sample);
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    const pickCap = vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("lounge");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    const words = screen.getByTestId("village-capacity");
    expect(words).toHaveTextContent(/^Seats \? · Memory 2\.0 GB · Usage \? · \?$/);
    fireEvent.click(screen.getByRole("radio", { name: "City" }));
    const city = setWorld.mock.lastCall![0];
    expect(city.city).toBeDefined();
    // A fixed 64 benches — whatever the machine (6 CPUs: an estimate of 4).
    expect(city.props.filter((p) => p.kind === "bench" && p.capacity === "lounge")).toHaveLength(64);
    // …and under it the Seats hall, one hall prop, as in the Village.
    expect(city.props.filter((p) => p.capacity === "seats").map((p) => p.kind)).toEqual(["hall"]);
    expect(words).toHaveTextContent(/^Seats \? · Memory 2\.0 GB · Usage \? · \? · Lounge 1\/64$/);
    hover();
    let card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveAttribute("data-kind", "lounge");
    expect(card).toHaveTextContent("Lounge — agents at once");
    expect(card).toHaveTextContent("1 of 64 benches taken · 1 active · 63 free");
    expect(card).toHaveTextContent("Estimate: min(16, max(2, 6 CPUs − 2)) = 4");
    // The City's Seats card is the hall's: nothing selected yet.
    pickCap.mockReturnValue("seats");
    hover();
    card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveAttribute("data-kind", "seats");
    expect(card).toHaveTextContent("Seats — context window");
    expect(card).toHaveTextContent("No agent selected — select one in the agent rail to seat its context window here");
    expect(card).not.toHaveTextContent("benches");
    // The view draws both: the lounge's 64 benches, the holder on one, and the hall with no reading.
    const view = setWorld.mock.contexts.at(-1) as VillageView;
    expect(view.capacityFrame!.desks).toHaveLength(64);
    expect(view.capacityFrame!.desks[0]).toEqual({ key: "a", activity: "typing", parentKey: null });
    expect(view.capacityFrame!.hall).toEqual({ cells: null, usedPct: null, tone: "unknown" });
    expect(view.capacityFrame!.captions.seats).toBe("Seats ?");
    expect(view.capacityFrame!.captions.lounge).toBe("Lounge 1/64");
    fireEvent.click(screen.getByRole("radio", { name: "Village" }));
    expect(words).toHaveTextContent(/^Seats \? · Memory 2\.0 GB · Usage \? · \?$/);
    const village = setWorld.mock.lastCall![0];
    expect(village.city).toBeUndefined();
    expect(village.props.filter((p) => p.capacity === "seats").map((p) => p.kind)).toEqual(["hall"]);
    expect(village.props.some((p) => p.capacity === "lounge")).toBe(false);
  });

  it("dresses the world it shows for this machine's time zone (the Tokyo theme where it applies)", async () => {
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    theme.calls.length = 0;
    await mount();
    expect(theme.calls.length).toBeGreaterThan(0);
    const last = theme.calls[theme.calls.length - 1];
    expect(last.zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(setWorld.mock.lastCall![0]).toBe(last.out);
  });

  it("without a machine sample the Seats hall is still there — its card is about the selection, not the machine", async () => {
    const setWorld = vi.spyOn(VillageView.prototype, "setWorld");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("seats");
    await mount();
    expect(setWorld.mock.lastCall![0].props.filter((p) => p.capacity === "seats").map((p) => p.kind)).toEqual(["hall"]);
    hover();
    const card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveAttribute("data-kind", "seats");
    expect(card).toHaveTextContent("No agent selected — select one in the agent rail to seat its context window here");
    expect(card).not.toHaveTextContent("Couldn't read this machine");
  });

  it("hovering a capacity building shows its card — exact numbers, the source, and 'estimate' for the seats", async () => {
    ipc.machineCapacity.mockResolvedValue(sample);
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    const pickCap = vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("seats");
    model.state = { ...model.state, agents: [agent("a"), agent("b", { activity: "idle" })] };
    await mount();
    hover(30, 40);
    let card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveTextContent("Seats — context window");
    expect(card).toHaveTextContent("estimate");
    expect(card).toHaveTextContent("No agent selected — select one in the agent rail to seat its context window here");
    expect(card).toHaveTextContent("claude /context for the agent selected in the rail");
    expect(card.style.left).toBe("44px");
    expect(card.style.top).toBe("54px");

    pickCap.mockReturnValue("memory");
    hover();
    card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveTextContent("Agents: 2.0 GB resident — 2 sessions, 3 claude processes, 4 tool processes");
    expect(card).toHaveTextContent("In use (everything): 12.0 GB of 16.0 GB · 4.0 GB available");
    expect(card).not.toHaveTextContent("estimate");

    act(() => {
      useUsageStore.setState({
        snapshot: { windows: [{ key: "current-session", label: "Current session", usedPct: 41, resetsAtMs: null }], fetchedAtMs: Date.now() },
      });
    });
    pickCap.mockReturnValue("usage");
    hover();
    card = screen.getByTestId("village-capacity-card");
    expect(card).toHaveTextContent("5-hour session: 41% used");
    expect(card).toHaveTextContent("Week (all models): no reading");
    expect(card).toHaveTextContent("Updated just now");
  });

  it("the capacity card goes away over a character, off the building, on leave, on a drag and on a picture switch", async () => {
    const pickChar = vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    const pickCap = vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("usage");
    model.state = { ...model.state, agents: [agent("a")] };
    await mount();
    const shown = () => screen.queryByTestId("village-capacity-card");
    hover();
    expect(shown()).toBeInTheDocument();
    pickChar.mockReturnValue("a");
    hover();
    expect(shown()).toBeNull();
    expect(screen.getByTestId("village-card")).toBeInTheDocument();
    pickChar.mockReturnValue(null);
    pickCap.mockReturnValue(null);
    hover();
    expect(shown()).toBeNull();
    pickCap.mockReturnValue("usage");
    hover();
    fireEvent.mouseLeave(canvas());
    expect(shown()).toBeNull();
    hover();
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 10, clientY: 20 });
    fireEvent.mouseMove(canvas(), { clientX: 40, clientY: 60 });
    expect(shown()).toBeNull();
    fireEvent.mouseUp(canvas(), { clientX: 40, clientY: 60 });
    hover();
    expect(shown()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "City" }));
    expect(shown()).toBeNull();
  });

  it("an agent's card carries its context line when the context card has a reading — and nothing otherwise", async () => {
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("a");
    model.state = { ...model.state, agents: [agent("a"), agent("b")] };
    act(() => {
      useContextStore.setState({
        entries: {
          "id-a": {
            data: { model: "m", usedTokens: 290_700, windowTokens: 1_000_000, usedPercent: 29, categories: [], measuredAtMs: Date.now() },
            error: null,
            loading: false,
          },
        },
      });
    });
    await mount();
    fireEvent.mouseMove(canvas(), { clientX: 1, clientY: 1 });
    expect(screen.getByTestId("village-card-context")).toHaveTextContent("Context 29% · 290.7k / 1m · measured just now");
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue("b");
    fireEvent.mouseMove(canvas(), { clientX: 2, clientY: 2 });
    expect(screen.getByTestId("village-card")).toHaveTextContent("title-b");
    expect(screen.queryByTestId("village-card-context")).toBeNull();
  });

  it("the City's lounge card follows the outside-agents toggle — and says so (the Seats hall, in either picture, is one agent's window)", async () => {
    ipc.machineCapacity.mockResolvedValue(sample);
    vi.spyOn(VillageView.prototype, "pick").mockReturnValue(null);
    const pickCap = vi.spyOn(VillageView.prototype, "pickCapacity").mockReturnValue("seats");
    const setCapacity = vi.spyOn(VillageView.prototype, "setCapacity");
    await mount();
    expect(setCapacity.mock.lastCall![0].includesOutside).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Show agents outside the IDE" }));
    expect(setCapacity.mock.lastCall![0].includesOutside).toBe(false);
    hover();
    expect(screen.getByTestId("village-capacity-card")).not.toHaveTextContent("Counting");
    fireEvent.click(screen.getByRole("radio", { name: "City" }));
    // The City's Seats card is the hall's too: no counting row.
    hover();
    expect(screen.getByTestId("village-capacity-card")).toHaveAttribute("data-kind", "seats");
    expect(screen.getByTestId("village-capacity-card")).not.toHaveTextContent("Counting");
    pickCap.mockReturnValue("lounge");
    hover();
    expect(screen.getByTestId("village-capacity-card")).toHaveTextContent(
      "Counting IDE agents only — outside agents are hidden (HUD toggle)",
    );
  });

  it("ages the context readings on the sky's clock", async () => {
    const setCapacity = vi.spyOn(VillageView.prototype, "setCapacity");
    await mount();
    expect(setCapacity.mock.lastCall![0].nowMs).toBe(sky.state.now.getTime());
  });

  it("polls machine_capacity only while the document is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      ipc.machineCapacity.mockResolvedValue(sample);
      await mount();
      const reads = (): number => ipc.machineCapacity.mock.calls.length;
      const first = reads();
      expect(first).toBeGreaterThan(0);
      await act(async () => {
        vi.advanceTimersByTime(CAPACITY_POLL_MS);
      });
      expect(reads()).toBe(first + 1);
      setHidden(true);
      await act(async () => {
        vi.advanceTimersByTime(CAPACITY_POLL_MS * 3);
      });
      expect(reads()).toBe(first + 1);
      setHidden(false);
      await act(async () => {});
      expect(reads()).toBe(first + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the view a fresh capacity input when the usage or context store changes", async () => {
    const setCapacity = vi.spyOn(VillageView.prototype, "setCapacity");
    await mount();
    const calls = setCapacity.mock.calls.length;
    act(() => {
      useUsageStore.setState({ error: "timeout" });
    });
    expect(setCapacity.mock.calls.length).toBe(calls + 1);
    expect(setCapacity.mock.lastCall![0].usageError).toBe("timeout");
  });

  it("keeps the world clear of the HUD at Fit: the inset follows the HUD's measured bottom edge", async () => {
    const setInset = vi.spyOn(VillageView.prototype, "setInset");
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(8);
    await mount();
    // jsdom lays nothing out: a HUD of no height reserves nothing.
    expect(setInset).toHaveBeenLastCalledWith(0);
    height.mockReturnValue(90);
    const hud = screen.getByTestId("village-hud");
    act(() => ro.cb?.([{ target: hud, contentRect: { width: 300, height: 90 } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(setInset).toHaveBeenLastCalledWith(8 + 90 + 6);
    expect(ro.observe).toHaveBeenCalledWith(hud);
  });
});

describe("VillagePanel — the LANs' traffic (the seam: data hook → view → draw list)", () => {
  const pick = (name: "Village" | "City") => fireEvent.click(screen.getByRole("radio", { name }));
  /** What the last painted frame handed the draw list: [kind, key] per event. */
  const lastEvents = () => vi.mocked(buildDrawList).mock.lastCall![7]!.map((e) => [e.kind, e.key]);

  it("in both pictures, what the agents do reaches the draw list as events — and only what happens on screen", async () => {
    vi.mocked(buildDrawList).mockClear();
    model.state = { ...model.state, agents: [agent("a", { toolCalls: 1 })] };
    const { rerender } = await mount();
    flush(10);
    expect(lastEvents()).toEqual([]); // opening the Village is no burst
    model.state = { ...model.state, agents: [agent("a", { toolCalls: 3 }), agent("s", { parentKey: "a" })] };
    rerender(<VillagePanel />);
    flush(26);
    expect(lastEvents()).toEqual([
      ["tool", "a"],
      ["tool", "a"],
      ["task", "s"],
    ]);

    // The City is a view of its own, handed the ROSTER: its first one is a baseline too…
    pick("City");
    await act(async () => {});
    flush(42);
    expect(lastEvents()).toEqual([]);
    // …and the counts survive the roster's rewrite (a nested sub-agent hangs under its floor's leader).
    model.state = {
      ...model.state,
      agents: [agent("a", { toolCalls: 4 }), agent("s", { parentKey: "a" }), agent("n", { parentKey: "s" })],
    };
    rerender(<VillagePanel />);
    flush(58);
    // The City has a Seats lounge: n appears on its bench and commutes to its desk, and its task is
    // stamped when it first SITS there (villageView `setAgents`) — so only a's call is on the wire yet…
    expect(lastEvents()).toEqual([["tool", "a"]]);
    // …until n sits down (a city trip takes ≲ 12 s; frames 100 ms apart, the sim's largest tick).
    let t = 58;
    while (t < 15_000 && !lastEvents().some(([kind]) => kind === "task")) flush((t += 100));
    expect(lastEvents()).toContainEqual(["task", "n"]);

    // Back to the Village: its clock stood still while it was away, so its own packets carry on where
    // they were — and what changed meanwhile (a's call, n's task) is no stale burst.
    pick("Village");
    await act(async () => {});
    flush(74);
    expect(lastEvents()).toEqual([
      ["tool", "a"],
      ["tool", "a"],
      ["task", "s"],
    ]);
  });
});
