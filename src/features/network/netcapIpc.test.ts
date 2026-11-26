/** Command names and argument shapes are the Rust contract, pinned literally: a rename on either
 * side must fail here, not leave a user's table empty. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

const ev = vi.hoisted(() => ({
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: ev.listen }));

import {
  listenFlows,
  NETCAP_FLOW_EVENT,
  netcapClear,
  netcapFlow,
  netcapSet,
  netcapSetAppDecrypt,
  netcapSnapshot,
  netcapStatus,
} from "./netcapIpc";

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
});
afterEach(() => ipc.reset());

const STATUS = {
  running: true,
  port: 5555,
  enabled: true,
  decrypt: false,
  caPath: null,
  skippedReason: null,
  passthroughHosts: [],
  flowCount: 0,
  decryptApps: [],
  portChanged: null,
};

describe("netcap commands", () => {
  it("netcap_status takes no args and returns the status", async () => {
    ipc.handle("netcap_status", () => STATUS);
    await expect(netcapStatus()).resolves.toEqual(STATUS);
    expect(ipc.calls()).toEqual([{ cmd: "netcap_status", args: {} }]);
  });

  it("netcap_set sends ONLY the keys given — an absent key is not a false", async () => {
    ipc.handle("netcap_set", () => STATUS);
    await netcapSet({ decrypt: true });
    await netcapSet({ enabled: false });
    await netcapSet({ enabled: true, decrypt: false });
    // The bypass rows' "Capture agent curls even with --noproxy" (the curl shim's pref), same
    // command.
    await netcapSet({ strictAgentCapture: true });
    expect(ipc.calls("netcap_set").map((c) => c.args)).toEqual([
      { decrypt: true },
      { enabled: false },
      { enabled: true, decrypt: false },
      { strictAgentCapture: true },
    ]);
  });

  it("netcap_set_app_decrypt sends exactly { app, on } and returns what Rust answers", async () => {
    const answered = { ...STATUS, decryptApps: ["Postman"] };
    ipc.handle("netcap_set_app_decrypt", () => answered);
    await expect(netcapSetAppDecrypt("Postman", true)).resolves.toEqual(answered);
    await netcapSetAppDecrypt("Insomnia", false);
    expect(ipc.calls().map((c) => [c.cmd, c.args])).toEqual([
      ["netcap_set_app_decrypt", { app: "Postman", on: true }],
      ["netcap_set_app_decrypt", { app: "Insomnia", on: false }],
    ]);
  });

  it("netcap_snapshot, netcap_flow {id}, netcap_clear", async () => {
    ipc.handle("netcap_snapshot", () => []);
    ipc.handle("netcap_flow", (a) => ({ id: a.id }));
    ipc.handle("netcap_clear", () => null);
    await expect(netcapSnapshot()).resolves.toEqual([]);
    await expect(netcapFlow(42)).resolves.toEqual({ id: 42 });
    await netcapClear();
    expect(ipc.calls().map((c) => [c.cmd, c.args])).toEqual([
      ["netcap_snapshot", {}],
      ["netcap_flow", { id: 42 }],
      ["netcap_clear", {}],
    ]);
  });

  it("does not swallow a rejection", async () => {
    ipc.handle("netcap_flow", () => {
      throw new Error("not-found");
    });
    await expect(netcapFlow(1)).rejects.toThrow("not-found");
  });
});

describe("netcap://flow", () => {
  it("subscribes to the literal event name and hands the payload through", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    ev.listen.mockImplementation(async (_name: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return ev.unlisten;
    });
    const onBatch = vi.fn();
    const un = await listenFlows(onBatch);
    expect(NETCAP_FLOW_EVENT).toBe("netcap://flow");
    expect(ev.listen).toHaveBeenCalledWith("netcap://flow", expect.any(Function));
    handler?.({ payload: [{ id: 1 }] });
    expect(onBatch).toHaveBeenCalledWith([{ id: 1 }]);
    expect(un).toBe(ev.unlisten);
  });
});
