/**
 * procsStore — the poll lifecycle, streams and the restart flow, through the REAL IPC seam
 * (`installTauriMock`), so every assertion is on the exact command + args Rust receives.
 */

import { act, renderHook } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

import {
  acquireProcs,
  cancelRestart,
  confirmRestart,
  dismissStreamError,
  pickAndStream,
  pollProcsOnce,
  releaseProcs,
  requestRestart,
  resetProcsStore,
  runtimeSectionOpen,
  selectDevApp,
  toggleRuntimeSection,
  selectedDevApp,
  startStream,
  stopStream,
  streamsOf,
  useProcsPolling,
  useProcsStore,
  useSelectedDevApp,
} from "./procsStore";
import type { DevApp, ProcsList } from "./procsTypes";

const APP: DevApp = {
  key: "web:42",
  pid: 42,
  runtime: "node",
  name: "web",
  exe: "/usr/local/bin/node",
  argv: ["node", "server.js"],
  cwd: "/w/web",
  startedMs: 1_000,
  ports: [3000],
  console: "terminal",
  logFiles: [{ path: "/w/web/logs/app.log", kind: "log" }],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
};
const DOCKER: DevApp = { ...APP, key: "c:abc", pid: null, runtime: "docker", name: "pg", containerId: "abc123", logFiles: [] };
const LIST: ProcsList = { available: true, reason: null, apps: [APP, DOCKER] };

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
  resetProcsStore();
});
afterEach(() => {
  resetProcsStore();
  ipc.reset();
  vi.useRealTimers();
});

const s = () => useProcsStore.getState();
const cmds = () => ipc.calls().map((c) => [c.cmd, c.args]);

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.handle("procs_list", () => LIST);
  });

  it("polls immediately, every 3 s while held, and stops after release", async () => {
    acquireProcs();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.calls("procs_list")).toHaveLength(1);
    expect(s().list).toEqual(LIST);
    expect(s().polledAtMs).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(ipc.calls("procs_list")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.calls("procs_list")).toHaveLength(2);

    releaseProcs();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(ipc.calls("procs_list")).toHaveLength(2);
  });

  it("a StrictMode unmount → remount keeps ONE interval (no restart, no stop)", async () => {
    acquireProcs();
    releaseProcs();
    acquireProcs();
    await vi.advanceTimersByTimeAsync(3_000);
    // 1 immediate + 1 tick. A restart on re-acquire would make it 3 (two immediates or two intervals).
    expect(ipc.calls("procs_list")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ipc.calls("procs_list")).toHaveLength(3);
    // And the real unmount stops it: a re-acquire that started a SECOND interval would leak one here.
    releaseProcs();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(ipc.calls("procs_list")).toHaveLength(3);
  });

  it("keeps polling while a second holder remains", async () => {
    acquireProcs();
    acquireProcs();
    releaseProcs();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ipc.calls("procs_list")).toHaveLength(2);
  });

  it("useProcsPolling under StrictMode polls once up front and stops on unmount", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const { unmount } = renderHook(() => useProcsPolling(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.calls("procs_list")).toHaveLength(1);
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ipc.calls("procs_list")).toHaveLength(1);
  });

  it("skips a tick while the previous scan is still in flight", async () => {
    let resolve: (v: ProcsList) => void = () => {};
    ipc.handle("procs_list", () => new Promise<ProcsList>((r) => (resolve = r)));
    acquireProcs();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ipc.calls("procs_list")).toHaveLength(1);
    resolve(LIST);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ipc.calls("procs_list")).toHaveLength(2);
  });
});

describe("pollProcsOnce errors", () => {
  it("records a failure, keeps the last list, and a later success clears it (not sticky)", async () => {
    ipc.handle("procs_list", () => LIST);
    await pollProcsOnce();
    ipc.handle("procs_list", () => {
      throw new Error("scan failed");
    });
    await pollProcsOnce();
    expect(s().listError).toBe("scan failed");
    expect(s().list).toEqual(LIST);
    ipc.handle("procs_list", () => LIST);
    await pollProcsOnce();
    expect(s().listError).toBeNull();
  });

  it("stringifies a non-Error rejection", async () => {
    ipc.handle("procs_list", () => Promise.reject("plain"));
    await pollProcsOnce();
    expect(s().listError).toBe("plain");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "nope"],
    ["an object without apps", { available: true, reason: null }],
  ])("a reply that is not a list (%s) is an error, never stored as the list", async (_name, reply) => {
    ipc.handle("procs_list", () => reply);
    await pollProcsOnce();
    expect(s().list).toBeNull();
    expect(s().listError).toBe("procs_list returned no list");
  });
});

describe("selection", () => {
  it("resolves the selected key against the latest list, and is null once the app is gone", async () => {
    ipc.handle("procs_list", () => LIST);
    await pollProcsOnce();
    expect(selectedDevApp(s())).toBeNull();
    selectDevApp("web:42");
    expect(selectedDevApp(s())).toBe(APP);
    ipc.handle("procs_list", () => ({ ...LIST, apps: [DOCKER] }));
    await pollProcsOnce();
    expect(selectedDevApp(s())).toBeNull();
    expect(s().selectedKey).toBe("web:42");
  });

  it("useSelectedDevApp follows the store", async () => {
    ipc.handle("procs_list", () => LIST);
    await pollProcsOnce();
    const { result } = renderHook(() => useSelectedDevApp());
    expect(result.current).toBeNull();
    act(() => selectDevApp("c:abc"));
    expect(result.current).toBe(DOCKER);
  });

  it("is null before any list", () => {
    selectDevApp("web:42");
    expect(selectedDevApp(s())).toBeNull();
  });
});

describe("streams", () => {
  beforeEach(() => {
    ipc.handle("logstream_tail_app", (a) => ({ key: `tail:${String(a.path)}`, source: "web · app.log" }));
    ipc.handle("logstream_tail_docker", () => ({ key: "tail:docker", source: "pg · docker" }));
    ipc.handle("logstream_untail", () => true);
  });

  it("tails a file by pid + path, records Rust's key, and resolves to the source", async () => {
    await expect(startStream(APP, "/w/web/logs/app.log")).resolves.toBe("web · app.log");
    expect(cmds()).toEqual([["logstream_tail_app", { pid: 42, path: "/w/web/logs/app.log" }]]);
    expect(streamsOf(s(), "web:42")).toEqual([
      { id: "web:42\u0000/w/web/logs/app.log", appKey: "web:42", path: "/w/web/logs/app.log", key: "tail:/w/web/logs/app.log", source: "web · app.log" },
    ]);
    expect(s().busy).toEqual([]);
  });

  it("tails a container by its id", async () => {
    await expect(startStream(DOCKER, null)).resolves.toBe("pg · docker");
    expect(cmds()).toEqual([["logstream_tail_docker", { id: "abc123" }]]);
    expect(streamsOf(s(), "c:abc")[0].key).toBe("tail:docker");
  });

  it("refuses a second start while the first is in flight, and once it is streaming", async () => {
    const first = startStream(APP, "/a.log");
    expect(s().busy).toEqual(["web:42\u0000/a.log"]);
    await expect(startStream(APP, "/a.log")).resolves.toBeNull();
    await first;
    await expect(startStream(APP, "/a.log")).resolves.toBeNull();
    expect(ipc.calls("logstream_tail_app")).toHaveLength(1);
  });

  it("refuses what cannot be tailed: a file without a pid, docker without a container", async () => {
    await expect(startStream({ ...APP, pid: null }, "/a.log")).resolves.toBeNull();
    await expect(startStream({ ...DOCKER, containerId: null }, null)).resolves.toBeNull();
    expect(ipc.calls()).toEqual([]);
    expect(s().busy).toEqual([]);
  });

  it("puts a failed tail on the app, and a later success clears it", async () => {
    ipc.handle("logstream_tail_app", () => {
      throw new Error("not open by pid 42");
    });
    await expect(startStream(APP, "/a.log")).resolves.toBeNull();
    expect(s().streamErrors).toEqual({ "web:42": "Could not stream: not open by pid 42" });
    expect(s().busy).toEqual([]);
    expect(s().streams).toEqual([]);
    ipc.handle("logstream_tail_app", () => ({ key: "k", source: "web · a.log" }));
    await startStream(APP, "/a.log");
    expect(s().streamErrors).toEqual({});
  });

  it("stops by Rust's key and forgets the stream", async () => {
    await startStream(APP, "/a.log");
    const id = "web:42\u0000/a.log";
    const stopping = stopStream(id);
    expect(s().busy).toEqual([id]);
    // A second Stop while the first is in flight sends nothing.
    await stopStream(id);
    await stopping;
    expect(ipc.calls("logstream_untail").map((c) => c.args)).toEqual([{ key: "tail:/a.log" }]);
    expect(s().streams).toEqual([]);
    expect(s().busy).toEqual([]);
  });

  it("Rust answering `false` (the tail had already ended on its own) is a stop too: the stream is forgotten", async () => {
    ipc.handle("logstream_untail", () => false);
    await startStream(APP, "/a.log");
    await stopStream("web:42\u0000/a.log");
    expect(s().streams).toEqual([]);
    expect(s().streamErrors).toEqual({});
  });

  it("ignores a stop for a stream it never started", async () => {
    await stopStream("nope");
    expect(ipc.calls("logstream_untail")).toEqual([]);
  });

  it("keeps the stream and reports a failed stop", async () => {
    await startStream(APP, "/a.log");
    ipc.handle("logstream_untail", () => {
      throw new Error("gone");
    });
    await stopStream("web:42\u0000/a.log");
    expect(s().streams).toHaveLength(1);
    expect(s().busy).toEqual([]);
    expect(s().streamErrors["web:42"]).toBe("Could not stop: gone");
    dismissStreamError("web:42");
    expect(s().streamErrors).toEqual({});
  });

  it("pick → tail the picked path; a cancelled pick tails nothing", async () => {
    ipc.handle("logstream_pick_file", () => null);
    await expect(pickAndStream(APP)).resolves.toBeNull();
    expect(ipc.calls("logstream_tail_app")).toEqual([]);
    ipc.handle("logstream_pick_file", () => "/picked/x.log");
    await expect(pickAndStream(APP)).resolves.toBe("web · app.log");
    expect(ipc.calls("logstream_tail_app").map((c) => c.args)).toEqual([{ pid: 42, path: "/picked/x.log" }]);
  });

  it("reports a failed pick", async () => {
    ipc.handle("logstream_pick_file", () => {
      throw new Error("no window");
    });
    await expect(pickAndStream(APP)).resolves.toBeNull();
    expect(s().streamErrors["web:42"]).toBe("Could not pick a file: no window");
  });
});

describe("restart in the IDE", () => {
  const PREPARED = { token: "tok-1", summary: { name: "web", cwd: "/w/web", argv: ["node", "server.js"] } };
  beforeEach(() => {
    ipc.handle("procs_restart_prepare", () => PREPARED);
    ipc.handle("procs_restart_in_ide", () => ({ terminalId: "term-7" }));
  });

  it("confirm → prepare(pid) → restart(token) → the terminal id, and the flow closes", async () => {
    requestRestart("web:42");
    expect(s().restart).toEqual({ appKey: "web:42", phase: "confirm", error: null });
    const p = confirmRestart(APP);
    expect(s().restart?.phase).toBe("running");
    await expect(p).resolves.toBe("term-7");
    expect(cmds()).toEqual([
      ["procs_restart_prepare", { pid: 42 }],
      ["procs_restart_in_ide", { token: "tok-1" }],
    ]);
    expect(s().restart).toBeNull();
  });

  it("does nothing without a confirm open for THIS app, or without a pid", async () => {
    await expect(confirmRestart(APP)).resolves.toBeNull();
    requestRestart("other");
    await expect(confirmRestart(APP)).resolves.toBeNull();
    requestRestart("web:42");
    await expect(confirmRestart({ ...APP, pid: null })).resolves.toBeNull();
    expect(ipc.calls()).toEqual([]);
  });

  it("cancel closes the confirm and sends nothing", () => {
    requestRestart("web:42");
    cancelRestart();
    expect(s().restart).toBeNull();
    expect(ipc.calls()).toEqual([]);
  });

  it("a running restart can be neither cancelled nor replaced", async () => {
    let release: (v: typeof PREPARED) => void = () => {};
    ipc.handle("procs_restart_prepare", () => new Promise((r) => (release = r)));
    requestRestart("web:42");
    const p = confirmRestart(APP);
    cancelRestart();
    requestRestart("other");
    expect(s().restart).toEqual({ appKey: "web:42", phase: "running", error: null });
    // And a second confirm while running sends nothing more.
    await expect(confirmRestart(APP)).resolves.toBeNull();
    release(PREPARED);
    await p;
    expect(ipc.calls("procs_restart_prepare")).toHaveLength(1);
  });

  it("stops before restarting when the pid now belongs to another program", async () => {
    ipc.handle("procs_restart_prepare", () => ({ ...PREPARED, summary: { ...PREPARED.summary, name: "sshd" } }));
    requestRestart("web:42");
    await expect(confirmRestart(APP)).resolves.toBeNull();
    expect(ipc.calls("procs_restart_in_ide")).toEqual([]);
    expect(s().restart).toEqual({
      appKey: "web:42",
      phase: "failed",
      error: "pid 42 is now sshd, not web — nothing was stopped.",
    });
  });

  it("a failed prepare or restart is shown, and dismissable", async () => {
    ipc.handle("procs_restart_in_ide", () => {
      throw new Error("permission denied");
    });
    requestRestart("web:42");
    await expect(confirmRestart(APP)).resolves.toBeNull();
    expect(s().restart).toEqual({ appKey: "web:42", phase: "failed", error: "Could not restart: permission denied" });
    cancelRestart();
    expect(s().restart).toBeNull();
  });
});

describe("resetProcsStore", () => {
  it("cancels a pending stop so no stale timer fires into the next test", async () => {
    vi.useFakeTimers();
    ipc.handle("procs_list", () => LIST);
    acquireProcs();
    releaseProcs();
    resetProcsStore();
    await vi.advanceTimersByTimeAsync(10_000);
    // Only the immediate poll from acquire; the interval died with the reset.
    expect(ipc.calls("procs_list")).toHaveLength(1);
    // And a fresh acquire starts again from zero holders.
    acquireProcs();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.calls("procs_list")).toHaveLength(2);
  });
});

describe("runtime sections (the Apps group)", () => {
  it("default: open exactly while it has apps; a toggle flips what is shown NOW and is kept; reset forgets it", () => {
    const s = () => useProcsStore.getState();
    expect(runtimeSectionOpen(s(), "rust", 2)).toBe(true);
    expect(runtimeSectionOpen(s(), "go", 0)).toBe(false);
    toggleRuntimeSection("rust", 2);
    toggleRuntimeSection("go", 0);
    expect(s().runtimeOpen).toEqual({ rust: false, go: true });
    // The user's choice wins over the count from then on.
    expect(runtimeSectionOpen(s(), "rust", 5)).toBe(false);
    expect(runtimeSectionOpen(s(), "go", 0)).toBe(true);
    toggleRuntimeSection("rust", 5);
    expect(s().runtimeOpen.rust).toBe(true);
    resetProcsStore();
    expect(s().runtimeOpen).toEqual({});
  });
});
