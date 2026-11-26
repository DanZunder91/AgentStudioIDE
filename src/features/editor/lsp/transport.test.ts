import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { makeConnection } from "./transport";

describe("makeConnection", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
    ipc.handle("lsp_send", () => null);
  });
  afterEach(() => {
    ipc.reset();
  });

  it("fans incoming channel messages out to every subscriber", () => {
    const conn = makeConnection();
    const a = vi.fn();
    const b = vi.fn();
    conn.transport.subscribe(a);
    conn.transport.subscribe(b);

    conn.deliver('{"id":1}');
    expect(a).toHaveBeenCalledWith('{"id":1}');
    expect(b).toHaveBeenCalledWith('{"id":1}');

    conn.transport.unsubscribe(a);
    conn.deliver('{"id":2}');
    expect(a).toHaveBeenCalledTimes(1); // gone after unsubscribe
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("wires the channel's onmessage to the same fan-out", () => {
    const conn = makeConnection();
    const handler = vi.fn();
    conn.transport.subscribe(handler);

    conn.channel.onmessage('{"from":"channel"}');
    expect(handler).toHaveBeenCalledWith('{"from":"channel"}');
  });

  it("drops sends until a server id is bound, then relays via lsp_send", async () => {
    const conn = makeConnection();

    conn.transport.send('{"early":true}'); // before bind → dropped, never throws
    expect(ipc.calls("lsp_send")).toHaveLength(0);

    conn.bind("srv-9");
    conn.transport.send('{"jsonrpc":"2.0"}');
    // `send` is fire-and-forget; let the invoke microtask settle.
    await Promise.resolve();
    expect(ipc.lastCall("lsp_send")).toEqual({ serverId: "srv-9", message: '{"jsonrpc":"2.0"}' });
  });

  it("swallows a send failure — a gone relay never becomes an unhandled rejection", async () => {
    // The relay is gone (server exited / webview torn down): `lsp_send` rejects.
    ipc.handle("lsp_send", () => {
      throw new Error("relay gone");
    });
    const conn = makeConnection();
    conn.bind("srv-1");
    // Fire-and-forget must not throw synchronously, and the rejection must be
    // caught (otherwise this test itself would surface an unhandled rejection).
    expect(() => conn.transport.send('{"jsonrpc":"2.0"}')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
