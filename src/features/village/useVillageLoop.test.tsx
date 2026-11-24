/**
 * The village's rAF loop and its visibility gate: frames flow only while running,
 * stop (with `onStop`) on pause and unmount, and always call the LATEST callback.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLogStore } from "../logs/logStore";
import { LOOP_MAX_FAILURES, LOOP_RETRY_MS, useAnimationLoop, useDocumentVisible } from "./useVillageLoop";

let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;

function flush(now: number): void {
  const due = [...queue.values()];
  queue = new Map();
  for (const cb of due) cb(now);
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  queue = new Map();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => queue.delete(id)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setHidden(false);
});

describe("useAnimationLoop", () => {
  it("runs while running, with the latest callback, and stops on pause and unmount", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stop = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ cb, running }: { cb: (t: number) => void; running: boolean }) => useAnimationLoop(cb, running, stop),
      { initialProps: { cb: a, running: true } },
    );
    flush(16);
    flush(32);
    expect(a.mock.calls).toEqual([[16], [32]]);

    rerender({ cb: b, running: true });
    flush(48);
    expect(b).toHaveBeenCalledWith(48);
    expect(a).toHaveBeenCalledTimes(2);

    rerender({ cb: b, running: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
    flush(64);
    expect(b).toHaveBeenCalledTimes(1);

    rerender({ cb: b, running: true });
    flush(80);
    expect(b).toHaveBeenCalledTimes(2);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(queue.size).toBe(0);
  });

  it("keeps running after a frame throws — one bad frame must not freeze the canvas for good", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cb = vi.fn((now: number) => {
      if (now === 16) throw new Error("boom");
    });
    const { unmount } = renderHook(() => useAnimationLoop(cb, true));
    flush(16);
    expect(error).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(1);
    flush(32);
    expect(cb).toHaveBeenLastCalledWith(32);
    unmount();
    expect(queue.size).toBe(0);
    error.mockRestore();
  });

  it("a frame that ALWAYS throws is reported once, then retried once a second — never an error flood or a busy loop", () => {
    // Only the timers: the rAF queue stays this file's manual one.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useLogStore.getState().clear();
    let broken = true;
    const cb = vi.fn(() => {
      if (broken) throw new Error("bad sprite");
    });
    const stop = vi.fn();
    const { unmount } = renderHook(() => useAnimationLoop(cb, true, stop));
    for (let i = 1; i <= LOOP_MAX_FAILURES; i++) flush(16 * i);
    expect(cb).toHaveBeenCalledTimes(LOOP_MAX_FAILURES);
    // Backed off: no frame queued until the retry is due.
    expect(queue.size).toBe(0);
    vi.advanceTimersByTime(LOOP_RETRY_MS - 1);
    expect(queue.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(queue.size).toBe(1);
    flush(2000); // still broken: back off again
    expect(queue.size).toBe(0);
    // One report for the whole streak — in the console and in the app's diagnostics log.
    expect(error).toHaveBeenCalledTimes(1);
    expect(useLogStore.getState().entries.filter((e) => e.source === "village")).toEqual([
      expect.objectContaining({ level: "error", message: "A frame failed to paint", detail: "Error: bad sprite" }),
    ]);
    // It recovers: the next retry paints, and the loop is back on every frame.
    broken = false;
    vi.advanceTimersByTime(LOOP_RETRY_MS);
    flush(3000);
    expect(queue.size).toBe(1);
    flush(3016);
    expect(cb).toHaveBeenLastCalledWith(3016);
    // A NEW streak is reported again.
    broken = true;
    flush(3032);
    expect(error).toHaveBeenCalledTimes(2);
    // Unmounting mid back-off cancels the pending retry.
    for (let i = 1; i < LOOP_MAX_FAILURES; i++) flush(3032 + 16 * i);
    expect(queue.size).toBe(0);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LOOP_RETRY_MS * 5);
    expect(queue.size).toBe(0);
    error.mockRestore();
    vi.useRealTimers();
  });

  it("schedules nothing while not running, and onStop is optional", () => {
    const cb = vi.fn();
    const { rerender, unmount } = renderHook(({ running }) => useAnimationLoop(cb, running), {
      initialProps: { running: false },
    });
    expect(queue.size).toBe(0);
    rerender({ running: true });
    flush(1);
    expect(cb).toHaveBeenCalledTimes(1);
    unmount();
    expect(queue.size).toBe(0);
  });
});

describe("useDocumentVisible", () => {
  it("tracks document.hidden and unsubscribes on unmount", () => {
    setHidden(true);
    const { result, unmount } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(false);
    act(() => setHidden(false));
    expect(result.current).toBe(true);
    act(() => setHidden(true));
    expect(result.current).toBe(false);
    const remove = vi.spyOn(document, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    remove.mockRestore();
  });
});
