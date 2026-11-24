/**
 * `httpIpc` — the API client's send command, at the wire.
 *
 * A thin wrapper, and thin wrappers are exactly where the command *name* and the
 * arg *shape* are the whole contract: get either wrong and Rust rejects at
 * runtime with types none the wiser. `sendHttp`'s real exercise is driven through
 * `<ApiRequestView>` (with the module mocked); this pins the marshalling against
 * the real `invoke`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { sendHttp, type HttpRequest, type HttpResponse } from "./httpIpc";

const REQUEST: HttpRequest = {
  method: "POST",
  url: "https://api.example.com/things",
  headers: [{ name: "Authorization", value: "Bearer t" }],
  body: '{"n":1}',
};

const RESPONSE: HttpResponse = {
  status: 201,
  statusText: "Created",
  headers: [{ name: "content-type", value: "application/json" }],
  body: '{"ok":true}',
  durationMs: 42,
  sizeBytes: 11,
  truncated: false,
};

describe("httpIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("invokes http_send with the request under a `request` key, returning Rust's response", async () => {
    ipc.handle("http_send", () => RESPONSE);

    await expect(sendHttp(REQUEST)).resolves.toEqual(RESPONSE);
    // The whole contract: command name + the single `request` argument key +
    // the exact request shape (method/url/headers/body).
    expect(ipc.lastCall("http_send")).toEqual({ request: REQUEST });
  });

  it("marshals a bodyless request (null body) through untouched", async () => {
    ipc.handle("http_send", () => ({ ...RESPONSE, status: 200, statusText: "OK" }));

    const get: HttpRequest = { method: "GET", url: "https://x.test", headers: [], body: null };
    await sendHttp(get);
    expect(ipc.lastCall("http_send")).toEqual({ request: get });
  });

  it("propagates a rejection (a transport failure) to the caller rather than resolving", async () => {
    // The panel turns this Err into a calm inline error; an empty resolve would
    // masquerade as a real response and hide the failure.
    ipc.handle("http_send", () => {
      throw new Error("error sending request: dns error");
    });

    await expect(sendHttp(REQUEST)).rejects.toThrow(/dns error/);
  });
});
