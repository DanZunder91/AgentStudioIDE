/**
 * `wsIpc` — the WebSocket relay at the wire. Thin wrappers, so the
 * command *names*, arg *shapes*, and the JSON-frame → `WsEvent` parse are the
 * whole contract with the Rust `ws_*` commands. Mirrors `lspIpc.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  channelIdOf,
  installTauriMock,
  type TauriMock,
} from "../../test/tauri-mock";
import { wsClose, wsConnect, wsSend, type WsEvent } from "./wsIpc";

describe("wsIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  describe("wsConnect", () => {
    it("invokes ws_connect with the url + a Channel, and resolves the connectionId", async () => {
      ipc.handle("ws_connect", () => "conn-7");

      const onEvent = vi.fn();
      await expect(wsConnect("wss://echo.test", onEvent)).resolves.toBe(
        "conn-7",
      );

      const args = ipc.lastCall("ws_connect")!;
      expect(args.url).toBe("wss://echo.test");
      // The channel is a real Tauri Channel handle (serialized "__CHANNEL__:<id>").
      expect(typeof channelIdOf(args.onEvent)).toBe("number");
    });

    it("passes handshake headers as {name, value} rows", async () => {
      ipc.handle("ws_connect", () => "conn-h");

      await wsConnect("wss://echo.test", vi.fn(), [
        { name: "Authorization", value: "Bearer abc" },
        { name: "X-Scope", value: "read" },
      ]);

      expect(ipc.lastCall("ws_connect")!.headers).toEqual([
        { name: "Authorization", value: "Bearer abc" },
        { name: "X-Scope", value: "read" },
      ]);
    });

    // 🔴 The secret-safety guarantee, at the boundary it is about. Rust resolves the
    // Vault (`ws.rs` → `db::secret::resolve`); if this wrapper — or any caller —
    // ever pre-substituted, the real token would be sitting in this payload.
    it("sends the LITERAL {{VAR}} template — the resolved secret never crosses IPC", async () => {
      ipc.handle("ws_connect", () => "conn-v");

      await wsConnect("wss://echo.test", vi.fn(), [
        { name: "Authorization", value: "Bearer {{TOKEN}}" },
      ]);

      const args = ipc.lastCall("ws_connect")!;
      expect(args.headers).toEqual([
        { name: "Authorization", value: "Bearer {{TOKEN}}" },
      ]);
      // Nothing anywhere in the payload looks like a resolved value: the whole
      // arg object is searched, not just the header we happen to read back.
      expect(JSON.stringify(args)).toContain("{{TOKEN}}");
      expect(JSON.stringify(args)).not.toMatch(/s3cr3t/i);
    });

    // The negative control. Without this, an implementation that
    // ALWAYS sent `headers` (even `[]`) would pass every test above, while making
    // Rust take the Vault path on every ordinary connect.
    it("omits the headers KEY entirely when there are none — byte for byte the pre-header call", async () => {
      ipc.handle("ws_connect", () => "conn-n");

      await wsConnect("wss://echo.test", vi.fn());
      expect(Object.keys(ipc.lastCall("ws_connect")!).sort()).toEqual([
        "onEvent",
        "url",
      ]);

      // An EMPTY list is the same as no list — the console always passes an
      // array, so this is the branch a header-less connect actually takes.
      await wsConnect("wss://echo.test", vi.fn(), []);
      const args = ipc.lastCall("ws_connect")!;
      expect(Object.keys(args).sort()).toEqual(["onEvent", "url"]);
      expect("headers" in args).toBe(false);
    });

    it("parses each raw JSON frame into a typed WsEvent and forwards it to onEvent", async () => {
      const driver = ipc.channel();
      ipc.handle("ws_connect", (a) => {
        driver.capture(a.onEvent);
        return "conn-1";
      });

      const events: WsEvent[] = [];
      await wsConnect("ws://x", (e) => events.push(e));

      // Rust pushes each event as a JSON STRING on the Channel<string>.
      driver.sendRaw(JSON.stringify({ kind: "open" }));
      driver.sendRaw(JSON.stringify({ kind: "message", data: "hello" }));
      driver.sendRaw(
        JSON.stringify({ kind: "closed", code: 1000, reason: "bye" }),
      );
      driver.sendRaw(JSON.stringify({ kind: "error", message: "boom" }));

      expect(events).toEqual([
        { kind: "open" },
        { kind: "message", data: "hello" },
        { kind: "closed", code: 1000, reason: "bye" },
        { kind: "error", message: "boom" },
      ]);
    });
  });

  describe("wsSend / wsClose", () => {
    it("ws_send passes the connectionId and the message body", async () => {
      ipc.handle("ws_send", () => null);
      await wsSend("conn-1", "ping");
      expect(ipc.lastCall("ws_send")).toEqual({
        connectionId: "conn-1",
        message: "ping",
      });
    });

    it("ws_close passes the connectionId", async () => {
      ipc.handle("ws_close", () => null);
      await wsClose("conn-1");
      expect(ipc.lastCall("ws_close")).toEqual({ connectionId: "conn-1" });
    });
  });
});
