/** "Released outside?": every doubtful input must answer false (a false "outside" opens an
 * unwanted window). Each measured quirk (tab-tearoff.md §5) gets a case: Wayland's `(0, 0)`,
 * negative-coordinate monitors, macOS scaling the cursor by the PRIMARY monitor. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => {
  const current = {
    outerPosition: vi.fn(),
    outerSize: vi.fn(),
    scaleFactor: vi.fn(),
  };
  return {
    current,
    cursorPosition: vi.fn(),
    primaryMonitor: vi.fn(),
    getCurrentWindow: vi.fn(() => current),
  };
});
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: win.cursorPosition,
  primaryMonitor: win.primaryMonitor,
  getCurrentWindow: win.getCurrentWindow,
}));

const platform = vi.hoisted(() => ({ isMac: vi.fn(() => false) }));
vi.mock("../../features/shortcuts/shortcuts", () => platform);

import { EDGE_SLOP, probeRelease, releasedOutside, type ReleaseProbe } from "./geometry";

/** A 1280×832 window at (100, 50), physical = logical (scale 1). */
const frame = { x: 100, y: 50, width: 1280, height: 832 };
const probe = (cursor: ReleaseProbe["cursor"], over: Partial<ReleaseProbe> = {}): ReleaseProbe => ({
  cursor,
  frame,
  cursorScale: 1,
  frameScale: 1,
  ...over,
});

describe("releasedOutside", () => {
  it("is false for a release inside the window", () => {
    expect(releasedOutside(probe({ x: 640, y: 400 }))).toBe(false);
    // The title bar is part of the window: letting go on it is not "outside".
    expect(releasedOutside(probe({ x: 640, y: 55 }))).toBe(false);
  });

  it("is true past every edge", () => {
    expect(releasedOutside(probe({ x: 50, y: 400 }))).toBe(true); // left
    expect(releasedOutside(probe({ x: 1500, y: 400 }))).toBe(true); // right
    expect(releasedOutside(probe({ x: 640, y: 10 }))).toBe(true); // above
    expect(releasedOutside(probe({ x: 640, y: 1000 }))).toBe(true); // below
  });

  it("forgives a release a hair past the edge, and no further", () => {
    const right = frame.x + frame.width;
    expect(releasedOutside(probe({ x: right + EDGE_SLOP, y: 400 }))).toBe(false);
    expect(releasedOutside(probe({ x: right + EDGE_SLOP + 1, y: 400 }))).toBe(true);
    expect(releasedOutside(probe({ x: frame.x - EDGE_SLOP, y: 400 }))).toBe(false);
    expect(releasedOutside(probe({ x: frame.x - EDGE_SLOP - 1, y: 400 }))).toBe(true);
    // The slop is a parameter: zero makes the frame edge exact.
    expect(releasedOutside(probe({ x: right + 1, y: 400 }), 0)).toBe(true);
  });

  it("handles monitors at negative coordinates (left of / above the primary)", () => {
    // A release on a monitor to the LEFT of the window's monitor.
    expect(releasedOutside(probe({ x: -900, y: 300 }))).toBe(true);
    // A window that itself lives on the left monitor; a release inside it is inside.
    const leftWindow = { x: -1920, y: -200, width: 1280, height: 800 };
    expect(releasedOutside(probe({ x: -1500, y: 100 }, { frame: leftWindow }))).toBe(false);
    expect(releasedOutside(probe({ x: -100, y: 100 }, { frame: leftWindow }))).toBe(true);
    expect(releasedOutside(probe({ x: -1500, y: -500 }, { frame: leftWindow }))).toBe(true);
  });

  it("answers false for Wayland's hard-coded (0, 0) — the gesture degrades to the command", () => {
    // tao returns Ok((0, 0)) on Wayland, not an error. Here the window is placed so that
    // (0, 0) is clearly OUTSIDE it: a naive comparison would open a window every time.
    expect(releasedOutside(probe({ x: 0, y: 0 }))).toBe(false);
    // A real release one pixel off the corner is still decided normally.
    expect(releasedOutside(probe({ x: 1, y: 0 }))).toBe(true);
  });

  it("answers false when the cursor could not be read, or reads as nonsense", () => {
    expect(releasedOutside(probe(null))).toBe(false);
    expect(releasedOutside(probe({ x: Number.NaN, y: 10 }))).toBe(false);
    expect(releasedOutside(probe({ x: 10, y: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it("answers false for a frame it cannot trust", () => {
    const broken = { ...frame, width: Number.NaN };
    expect(releasedOutside(probe({ x: 5000, y: 5000 }, { frame: broken }))).toBe(false);
  });

  it("compares a mixed-DPI macOS desk in logical units", () => {
    // Primary monitor is Retina (×2): tao reports the cursor scaled by 2. The window sits
    // on a ×1 external monitor at logical (2000, 0), so its frame is in ×1 units.
    const external = { x: 2000, y: 0, width: 1000, height: 700 };
    // Cursor at logical (2500, 300) — inside the window — arrives as (5000, 600).
    const inside = probe({ x: 5000, y: 600 }, { frame: external, cursorScale: 2, frameScale: 1 });
    expect(releasedOutside(inside)).toBe(false);
    // Compared raw, that same release would read as far outside the window.
    expect(releasedOutside({ ...inside, cursorScale: 1 })).toBe(true);
    // Cursor at logical (1500, 300) — left of the window — arrives as (3000, 600).
    expect(releasedOutside(probe({ x: 3000, y: 600 }, { frame: external, cursorScale: 2 }))).toBe(true);
  });

  it("treats a nonsense scale factor as 1 rather than dividing by it", () => {
    for (const bad of [0, -2, Number.NaN]) {
      expect(releasedOutside(probe({ x: 640, y: 400 }, { cursorScale: bad, frameScale: bad }))).toBe(false);
      expect(releasedOutside(probe({ x: 5000, y: 400 }, { cursorScale: bad, frameScale: bad }))).toBe(true);
    }
  });
});

describe("probeRelease", () => {
  beforeEach(() => {
    win.cursorPosition.mockResolvedValue({ x: 3000, y: 600 });
    win.current.outerPosition.mockResolvedValue({ x: 100, y: 50 });
    win.current.outerSize.mockResolvedValue({ width: 1280, height: 832 });
    win.current.scaleFactor.mockResolvedValue(1);
    win.primaryMonitor.mockResolvedValue({ scaleFactor: 2 });
    platform.isMac.mockReturnValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it("reads the cursor and this window's frame; scales are 1 off macOS", async () => {
    await expect(probeRelease()).resolves.toEqual({
      cursor: { x: 3000, y: 600 },
      frame: { x: 100, y: 50, width: 1280, height: 832 },
      cursorScale: 1,
      frameScale: 1,
    });
    expect(win.primaryMonitor).not.toHaveBeenCalled();
  });

  it("on macOS takes the cursor's scale from the PRIMARY monitor and the frame's from the window", async () => {
    platform.isMac.mockReturnValue(true);
    win.current.scaleFactor.mockResolvedValue(1);
    const p = await probeRelease();
    expect(p?.cursorScale).toBe(2);
    expect(p?.frameScale).toBe(1);
  });

  it("falls back to 1 when macOS reports no primary monitor", async () => {
    platform.isMac.mockReturnValue(true);
    win.primaryMonitor.mockResolvedValue(null);
    expect((await probeRelease())?.cursorScale).toBe(1);
  });

  it("is null when any read fails — the caller treats that as 'not outside'", async () => {
    win.cursorPosition.mockRejectedValue(new Error("not allowed"));
    await expect(probeRelease()).resolves.toBeNull();
  });
});
