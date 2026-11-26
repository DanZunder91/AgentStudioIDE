
import { act, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MachineSample, MachineStatus } from "./networkTypes";

const ipc = vi.hoisted(() => ({
  netmachineStatus: vi.fn(),
  netmachineStart: vi.fn(),
  netmachineStop: vi.fn(),
  listenSamples: vi.fn(),
  NETMACHINE_SAMPLE_EVENT: "netmachine://sample",
}));
vi.mock("./netmachineIpc", () => ipc);

import {
  MACHINE_STATUS_POLL_MS,
  acquireMachine,
  displayedSample,
  ensureMachineStatus,
  receiveSample,
  releaseMachine,
  resetMachineStore,
  revealMachinePid,
  selectApp,
  setExpanded,
  setHideListeners,
  setMachineFilter,
  setMachinePaused,
  setMachineSelection,
  sortBy,
  toggleExpanded,
  useMachineStore,
} from "./machineStore";

const ON: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };
const OFF: MachineStatus = { ...ON, running: false };
const S1: MachineSample = { tsMs: 1, apps: [] };
const S2: MachineSample = { tsMs: 2, apps: [] };

let emit: (s: MachineSample) => void = () => {};
const unlisten = vi.fn();

beforeEach(() => {
  resetMachineStore();
  vi.clearAllMocks();
  ipc.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
    emit = h;
    return unlisten;
  });
  ipc.netmachineStart.mockResolvedValue(ON);
  ipc.netmachineStop.mockResolvedValue(OFF);
  ipc.netmachineStatus.mockResolvedValue(OFF);
});
afterEach(() => resetMachineStore());

const st = () => useMachineStore.getState();
/** Let the deferred stop (one macrotask) and any promise chains run. */
const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 5)));

describe("samples", () => {
  it("each sample REPLACES the last (no merge)", () => {
    receiveSample({ tsMs: 1, apps: [{ key: "a:1" } as never] });
    receiveSample(S2);
    expect(st().latest).toBe(S2);
  });

  it("pause freezes what is displayed; resume shows the newest again", () => {
    receiveSample(S1);
    setMachinePaused(true);
    receiveSample(S2);
    expect(displayedSample(st())).toBe(S1);
    expect(st().latest).toBe(S2);
    setMachinePaused(true); // no-op: still the first frozen sample
    expect(displayedSample(st())).toBe(S1);
    setMachinePaused(false);
    expect(displayedSample(st())).toBe(S2);
    expect(st().frozen).toBeNull();
    setMachinePaused(false);
    expect(st().paused).toBe(false);
  });
});

describe("choices", () => {
  it("defaults: sort ↓/s biggest-first, all apps, Hide listeners ON", () => {
    expect(st().sort).toEqual({ key: "rateIn", dir: "desc" });
    expect(st().selection).toBeNull();
    expect(st().hideListeners).toBe(true);
  });

  it("sortBy: the same key flips; a new key starts in its natural direction", () => {
    sortBy("rateIn");
    expect(st().sort).toEqual({ key: "rateIn", dir: "asc" });
    sortBy("rateIn");
    expect(st().sort).toEqual({ key: "rateIn", dir: "desc" });
    sortBy("name");
    expect(st().sort).toEqual({ key: "name", dir: "asc" });
    sortBy("conns");
    expect(st().sort).toEqual({ key: "conns", dir: "desc" });
  });

  it("selection keeps null (all) distinct from [] (none)", () => {
    setMachineSelection([]);
    expect(st().selection).toEqual([]);
    setMachineSelection(["Safari"]);
    expect(st().selection).toEqual(["Safari"]);
    setMachineSelection(null);
    expect(st().selection).toBeNull();
  });

  it("filter, hide listeners, cursor", () => {
    setMachineFilter("slack");
    setHideListeners(false);
    selectApp("a:1");
    expect([st().filter, st().hideListeners, st().selectedKey]).toEqual(["slack", false, "a:1"]);
  });

  it("expand: toggle and explicit set (idempotent)", () => {
    toggleExpanded("a:1");
    toggleExpanded("b:2");
    expect(st().expanded).toEqual(["a:1", "b:2"]);
    toggleExpanded("a:1");
    expect(st().expanded).toEqual(["b:2"]);
    const before = st().expanded;
    setExpanded("b:2", true);
    expect(st().expanded).toBe(before);
    setExpanded("c:3", true);
    setExpanded("b:2", false);
    expect(st().expanded).toEqual(["c:3"]);
  });
});

describe("sampling lifecycle", () => {
  it("acquire listens FIRST, then starts, and stores the returned status", async () => {
    const order: string[] = [];
    ipc.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
      order.push("listen");
      emit = h;
      return unlisten;
    });
    ipc.netmachineStart.mockImplementation(async () => {
      order.push("start");
      return ON;
    });
    acquireMachine();
    await settle();
    expect(order).toEqual(["listen", "start"]);
    expect(st().status).toBe(ON);
    emit(S1);
    expect(st().latest).toBe(S1);
  });

  it("release stops exactly once, after a macrotask, and drops the stale live sample", async () => {
    acquireMachine();
    await settle();
    receiveSample(S1);
    releaseMachine();
    expect(ipc.netmachineStop).not.toHaveBeenCalled();
    await settle();
    expect(ipc.netmachineStop).toHaveBeenCalledTimes(1);
    expect(st().status).toBe(OFF);
    expect(st().latest).toBeNull();
  });

  it("a paused (frozen) sample survives the stop", async () => {
    acquireMachine();
    await settle();
    receiveSample(S1);
    setMachinePaused(true);
    releaseMachine();
    await settle();
    expect(displayedSample(st())).toBe(S1);
  });

  it("re-acquire inside the grace period cancels the stop and does not restart", async () => {
    acquireMachine();
    releaseMachine();
    acquireMachine();
    await settle();
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(1);
    expect(ipc.netmachineStop).not.toHaveBeenCalled();
  });

  it("two holders: only the last release stops", async () => {
    acquireMachine();
    acquireMachine();
    releaseMachine();
    await settle();
    expect(ipc.netmachineStop).not.toHaveBeenCalled();
    releaseMachine();
    await settle();
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(1);
    expect(ipc.netmachineStop).toHaveBeenCalledTimes(1);
  });

  it("each real visit starts once and stops once; the listener is made once", async () => {
    for (let i = 0; i < 3; i++) {
      acquireMachine();
      await settle();
      releaseMachine();
      await settle();
    }
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(3);
    expect(ipc.netmachineStop).toHaveBeenCalledTimes(3);
    expect(ipc.listenSamples).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode's double mount: one start, no stop; unmount: one stop", async () => {
    function Holder(): null {
      useEffect(() => {
        acquireMachine();
        return releaseMachine;
      }, []);
      return null;
    }
    const view = render(
      <StrictMode>
        <Holder />
      </StrictMode>,
    );
    await settle();
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(1);
    expect(ipc.netmachineStop).not.toHaveBeenCalled();
    view.unmount();
    await settle();
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(1);
    expect(ipc.netmachineStop).toHaveBeenCalledTimes(1);
  });

  it("a failed listen is reported, does not start, and is retried on the next visit", async () => {
    ipc.listenSamples.mockRejectedValueOnce(new Error("no event bus"));
    acquireMachine();
    await settle();
    expect(st().statusError).toBe("no event bus");
    expect(ipc.netmachineStart).not.toHaveBeenCalled();
    releaseMachine();
    await settle();
    acquireMachine();
    await settle();
    expect(ipc.listenSamples).toHaveBeenCalledTimes(2);
    expect(ipc.netmachineStart).toHaveBeenCalledTimes(1);
    expect(st().statusError).toBeNull();
  });

  it("a failed start or stop is shown (string rejections too)", async () => {
    ipc.netmachineStart.mockRejectedValueOnce("nettop exited");
    acquireMachine();
    await settle();
    expect(st().statusError).toBe("nettop exited");
    ipc.netmachineStop.mockRejectedValueOnce(new Error("stop failed"));
    releaseMachine();
    await settle();
    expect(st().statusError).toBe("stop failed");
  });

  it("reset tears down the subscription and a pending stop", async () => {
    acquireMachine();
    await settle();
    releaseMachine();
    resetMachineStore();
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(ipc.netmachineStop).not.toHaveBeenCalled();
  });
});

describe("ensureMachineStatus", () => {
  it("fetches once, coalesces concurrent calls, and skips when known", async () => {
    const a = ensureMachineStatus();
    const b = ensureMachineStatus();
    expect(a).toBe(b);
    await a;
    expect(st().status).toBe(OFF);
    await ensureMachineStatus();
    expect(ipc.netmachineStatus).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a status a start already delivered", async () => {
    let resolve: (s: MachineStatus) => void = () => {};
    ipc.netmachineStatus.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const p = ensureMachineStatus();
    acquireMachine();
    await settle();
    resolve(OFF);
    await p;
    expect(st().status).toBe(ON);
  });

  it("a failure is shown and not sticky", async () => {
    ipc.netmachineStatus.mockRejectedValueOnce(new Error("boom"));
    await ensureMachineStatus();
    expect(st().statusError).toBe("boom");
    await ensureMachineStatus();
    expect(st().status).toBe(OFF);
    expect(ipc.netmachineStatus).toHaveBeenCalledTimes(2);
  });
});

describe("status poll while open (a dead sampler is said, not frozen)", () => {
  it("re-reads the status every poll interval while held, and stops polling once released", async () => {
    vi.useFakeTimers();
    try {
      acquireMachine();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const died: MachineStatus = { ...ON, running: false, reason: "nettop stopped unexpectedly (exit status: 1)." };
      ipc.netmachineStatus.mockResolvedValue(died);
      await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_STATUS_POLL_MS); });
      expect(ipc.netmachineStatus).toHaveBeenCalledTimes(1);
      expect(st().status).toEqual(died);

      ipc.netmachineStatus.mockRejectedValue(new Error("ipc gone"));
      await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_STATUS_POLL_MS); });
      expect(st().statusError).toMatch(/ipc gone/);

      releaseMachine();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const calls = ipc.netmachineStatus.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_STATUS_POLL_MS * 3); });
      expect(ipc.netmachineStatus).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revealMachinePid (a dev app card's “connections →”)", () => {
  const app = (name: string, pid: number) => ({ key: `${name}:${pid}`, name, pid }) as never;
  const WITH: MachineSample = { tsMs: 3, apps: [app("curl", 7), app("node", 42)] };

  it("finds the row by PID in the newest sample: selects and expands it, undoing every narrowing that could hide it", () => {
    receiveSample(WITH);
    setMachineSelection(["curl"]);
    setMachineFilter("zzz");
    setHideListeners(true);
    setMachinePaused(true);
    toggleExpanded("curl:7");
    revealMachinePid(42);
    expect(st().selectedKey).toBe("node:42");
    expect(st().expanded).toEqual(["curl:7", "node:42"]);
    expect(st().selection).toBeNull();
    expect(st().filter).toBe("");
    expect(st().hideListeners).toBe(false);
    expect(st().paused).toBe(false);
    expect(st().frozen).toBeNull();
    expect(st().pendingPid).toBeNull();
    // Already expanded: not added twice.
    revealMachinePid(42);
    expect(st().expanded).toEqual(["curl:7", "node:42"]);
  });

  it("with no sample yet (Whole Mac not sampling), the FIRST sample that has the pid reveals it", () => {
    revealMachinePid(42);
    expect(st().pendingPid).toBe(42);
    expect(st().selectedKey).toBeNull();
    receiveSample({ tsMs: 1, apps: [app("curl", 7)] });
    expect(st().pendingPid).toBe(42);
    expect(st().selectedKey).toBeNull();
    receiveSample(WITH);
    expect(st().selectedKey).toBe("node:42");
    expect(st().expanded).toEqual(["node:42"]);
    expect(st().pendingPid).toBeNull();
    // Resolved once: a later sample does not re-select after the user moved on.
    selectApp("curl:7");
    receiveSample({ ...WITH, tsMs: 4 });
    expect(st().selectedKey).toBe("curl:7");
  });

  it("the user moving the cursor first cancels a reveal that is still waiting", () => {
    revealMachinePid(42);
    selectApp("curl:7");
    expect(st().pendingPid).toBeNull();
    receiveSample(WITH);
    expect(st().selectedKey).toBe("curl:7");
  });
});
