/**
 * The netmachine IPC seam: command and event names are the contract with the Rust side,
 * pinned literally — a rename on either side must
 * red this file, not leave the Whole-computer table silently empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

const ev = vi.hoisted(() => ({ unlisten: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ev.listen }));

import {
  listenSamples,
  NETMACHINE_SAMPLE_EVENT,
  netmachineStart,
  netmachineStatus,
  netmachineStop,
} from "./netmachineIpc";

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
});
afterEach(() => ipc.reset());

const STATUS = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };

describe("netmachine commands", () => {
  it("status, start and stop take no args and return the status", async () => {
    ipc.handle("netmachine_status", () => ({ ...STATUS, running: false }));
    ipc.handle("netmachine_start", () => STATUS);
    ipc.handle("netmachine_stop", () => ({ ...STATUS, running: false }));
    await expect(netmachineStatus()).resolves.toEqual({ ...STATUS, running: false });
    await expect(netmachineStart()).resolves.toEqual(STATUS);
    await expect(netmachineStop()).resolves.toEqual({ ...STATUS, running: false });
    expect(ipc.calls().map((c) => [c.cmd, c.args])).toEqual([
      ["netmachine_status", {}],
      ["netmachine_start", {}],
      ["netmachine_stop", {}],
    ]);
  });

  it("does not swallow a rejection", async () => {
    ipc.handle("netmachine_start", () => {
      throw new Error("nettop missing");
    });
    await expect(netmachineStart()).rejects.toThrow("nettop missing");
  });
});

describe("netmachine://sample", () => {
  it("subscribes to the literal event name and hands the payload through", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    ev.listen.mockImplementation(async (_name: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return ev.unlisten;
    });
    const onSample = vi.fn();
    const un = await listenSamples(onSample);
    expect(NETMACHINE_SAMPLE_EVENT).toBe("netmachine://sample");
    expect(ev.listen).toHaveBeenCalledWith("netmachine://sample", expect.any(Function));
    handler?.({ payload: { tsMs: 1, apps: [] } });
    expect(onSample).toHaveBeenCalledWith({ tsMs: 1, apps: [] });
    expect(un).toBe(ev.unlisten);
  });
});
