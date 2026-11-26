import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ machineCapacity: vi.fn() }));
vi.mock("./villageIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./villageIpc")>()),
  machineCapacity: ipc.machineCapacity,
}));

import { CAPACITY_POLL_MS, useMachineCapacity } from "./useMachineCapacity";
import type { MachineCapacityWire } from "./villageTypes";

const sample = (cpus: number): MachineCapacityWire => ({
  logicalCpus: cpus,
  totalMemBytes: 1,
  availableMemBytes: 1,
  agents: null,
  sampledAtMs: cpus,
});

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  ipc.machineCapacity.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMachineCapacity", () => {
  it("reads at once, then every CAPACITY_POLL_MS", async () => {
    ipc.machineCapacity.mockResolvedValueOnce(sample(4)).mockResolvedValueOnce(sample(8));
    const { result } = renderHook(() => useMachineCapacity(true));
    expect(result.current).toEqual({ sample: null, error: null });
    await act(async () => {});
    expect(result.current).toEqual({ sample: sample(4), error: null });
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS);
    });
    expect(ipc.machineCapacity).toHaveBeenCalledTimes(2);
    expect(result.current.sample).toEqual(sample(8));
  });

  it("does nothing while disabled, and starts when enabled", async () => {
    ipc.machineCapacity.mockResolvedValue(sample(2));
    const { result, rerender } = renderHook(({ on }) => useMachineCapacity(on), { initialProps: { on: false } });
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS * 3);
    });
    expect(ipc.machineCapacity).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => {});
    expect(result.current.sample).toEqual(sample(2));
  });

  it("keeps the last good sample through a failure, with its code; a success clears the code", async () => {
    ipc.machineCapacity
      .mockResolvedValueOnce(sample(4))
      .mockRejectedValueOnce("unsupported: no table")
      .mockResolvedValueOnce(sample(6));
    const { result } = renderHook(() => useMachineCapacity(true));
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS);
    });
    expect(result.current).toEqual({ sample: sample(4), error: "unsupported" });
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS);
    });
    expect(result.current).toEqual({ sample: sample(6), error: null });
  });

  it("never starts a read while one is outstanding", async () => {
    const slow = deferred<MachineCapacityWire>();
    ipc.machineCapacity.mockReturnValueOnce(slow.promise).mockResolvedValue(sample(3));
    const { result } = renderHook(() => useMachineCapacity(true));
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS * 2);
    });
    expect(ipc.machineCapacity).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve(sample(1));
    });
    expect(result.current.sample).toEqual(sample(1));
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS);
    });
    expect(ipc.machineCapacity).toHaveBeenCalledTimes(2);
  });

  it("stops polling on disable and unmount, and drops replies (good or bad) that land after", async () => {
    const late = deferred<MachineCapacityWire>();
    ipc.machineCapacity.mockReturnValueOnce(late.promise);
    const { result, rerender, unmount } = renderHook(({ on }) => useMachineCapacity(on), { initialProps: { on: true } });
    rerender({ on: false });
    await act(async () => {
      late.resolve(sample(9));
    });
    expect(result.current.sample).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS * 2);
    });
    expect(ipc.machineCapacity).toHaveBeenCalledTimes(1);

    const bad = deferred<MachineCapacityWire>();
    ipc.machineCapacity.mockReturnValueOnce(bad.promise);
    rerender({ on: true });
    unmount();
    await act(async () => {
      bad.reject("unknown");
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_POLL_MS * 2);
    });
    expect(ipc.machineCapacity).toHaveBeenCalledTimes(2);
  });
});
