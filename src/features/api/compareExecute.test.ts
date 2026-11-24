/**
 * compareExecute — the A/B dual-send path. `httpIpc`
 * and the persistence modules are mocked at the module boundary, exactly like
 * execute.test.ts. What's under test: the two wires (A = the request's own
 * method/url, B = compare's, BOTH carrying the same substituted headers/body),
 * true simultaneity (both fired before the function returns), each side settling
 * independently in real time, BOTH executions recorded in history with the
 * LITERAL (pre-substitution) request — a secret never logged — and `sending`
 * flipping false only once both sides have settled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpIpc = vi.hoisted(() => ({ sendHttp: vi.fn() }));
vi.mock("./httpIpc", () => httpIpc);
const grpcIpc = vi.hoisted(() => ({
  grpcSend: vi.fn(),
  grpcReflect: vi.fn(),
}));
vi.mock("./grpcIpc", () => grpcIpc);
const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("./historyIpc", () => historyIpc);
const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { executeCompareRequest } from "./compareExecute";
import type { HttpResponse } from "./httpIpc";

const api = () => useAppStore.getState().apiActions;
const reqOf = (id: string) => useAppStore.getState().apiRequests[id];
const compareOf = (id: string) => reqOf(id).compare;
const historyOf = () => useAppStore.getState().apiHistory;

const response = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [],
  body: '{"ok":true}',
  durationMs: 128,
  sizeBytes: 1229,
  truncated: false,
  ...over,
});

/** A promise settled by hand — how the tests control WHICH side lands WHEN. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A compare-enabled request whose urls/header/body carry `{{VAR}}` placeholders,
 * plus an active env holding the secret. The header rows also exercise the wire
 * filter: row 2 is disabled, row 3 enabled but unnamed — neither may travel.
 */
function setup(): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, {
    method: "GET",
    url: "https://api.test/{{PATH}}",
    body: "token={{TOKEN}}",
  });
  api().addHeader(id);
  api().addHeader(id);
  api().addHeader(id);
  const [h1, h2, h3] = reqOf(id).headers;
  api().updateHeader(id, h1.id, { name: "Authorization", value: "Bearer {{TOKEN}}" });
  api().updateHeader(id, h2.id, { name: "X-Off", value: "nope", enabled: false });
  api().updateHeader(id, h3.id, { name: "  ", value: "scaffolding" });
  api().setCompareEnabled(id, true);
  api().patchCompare(id, { method: "POST", url: "https://beta.test/{{PATH}}" });
  const envId = api().addEnvironment("prod");
  api().setEnvVar(envId, "TOKEN", "sk-secret");
  api().setEnvVar(envId, "PATH", "users");
  api().setActiveEnvironment(envId);
  return id;
}

/** Flush the settled-promise microtasks the dual-send path chains on. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("executeCompareRequest", () => {
  beforeEach(() => {
    resetStore();
    httpIpc.sendHttp.mockReset();
    historyIpc.saveApiHistory.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends A's method/url and B's method/url with the SAME substituted headers/body; history keeps the LITERAL", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = setup();

    executeCompareRequest(id);
    await flush();

    // Two wires: A = the request's own method+url, B = compare's — both carrying
    // the resolved secret in the SAME headers/body (only the disabled/unnamed
    // rows dropped).
    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(2);
    const [wireA] = httpIpc.sendHttp.mock.calls[0];
    const [wireB] = httpIpc.sendHttp.mock.calls[1];
    expect(wireA).toEqual({
      method: "GET",
      url: "https://api.test/users",
      headers: [{ name: "Authorization", value: "Bearer sk-secret" }],
      body: "token=sk-secret",
    });
    expect(wireB).toEqual({
      method: "POST",
      url: "https://beta.test/users",
      headers: [{ name: "Authorization", value: "Bearer sk-secret" }],
      body: "token=sk-secret",
    });

    // Both responses landed on their sides; the dual send is over.
    expect(compareOf(id).a.response).toEqual(response());
    expect(compareOf(id).b.response).toEqual(response());
    expect(compareOf(id).sending).toBe(false);

    // TWO history entries — both executions really happened — each the LITERAL
    // request (placeholders kept): A under its own url, B under
    // compare's, same literal headers/body, and NO resolved secret anywhere.
    const hist = historyOf();
    expect(hist).toHaveLength(2);
    const entryA = hist.find((h) => h.url === "https://api.test/{{PATH}}");
    const entryB = hist.find((h) => h.url === "https://beta.test/{{PATH}}");
    expect(entryA).toMatchObject({
      method: "GET",
      body: "token={{TOKEN}}",
      status: 200,
      statusText: "OK",
      durationMs: 128,
      sizeBytes: 1229,
      error: null,
    });
    expect(entryB).toMatchObject({ method: "POST", body: "token={{TOKEN}}" });
    expect(entryA?.headers).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    expect(entryB?.headers).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    expect(typeof entryA?.at).toBe("number");
    expect(JSON.stringify(hist)).not.toContain("sk-secret");
  });

  it("fires BOTH sends before returning (simultaneous, never sequential)", () => {
    // Never-resolving promises: if the implementation awaited A before firing B,
    // the second call could not have happened by the time the function returns.
    httpIpc.sendHttp.mockReturnValue(new Promise<never>(() => {}));
    const id = setup();

    executeCompareRequest(id);

    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(2);
  });

  it("renders A's response the moment it lands, while B is still in flight (then B settles → sending false)", async () => {
    const a = deferred<HttpResponse>();
    const b = deferred<HttpResponse>();
    httpIpc.sendHttp.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const id = setup();
    executeCompareRequest(id);
    expect(compareOf(id).sending).toBe(true);

    // Only A lands: its response is visible NOW, B untouched, still sending.
    a.resolve(response({ status: 201 }));
    await flush();
    expect(compareOf(id).a.response?.status).toBe(201);
    expect(compareOf(id).b).toEqual({ response: null, error: null });
    expect(compareOf(id).sending).toBe(true);
    expect(historyOf()).toHaveLength(1);

    // B lands: its response arrives and the dual send is over.
    b.resolve(response({ status: 404, statusText: "Not Found" }));
    await flush();
    expect(compareOf(id).b.response?.status).toBe(404);
    expect(compareOf(id).sending).toBe(false);
    expect(historyOf()).toHaveLength(2);
  });

  it("handles the mirrored order: B lands first, A still in flight, then A settles", async () => {
    const a = deferred<HttpResponse>();
    const b = deferred<HttpResponse>();
    httpIpc.sendHttp.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const id = setup();
    executeCompareRequest(id);

    b.resolve(response({ status: 204, statusText: "No Content" }));
    await flush();
    expect(compareOf(id).b.response?.status).toBe(204);
    expect(compareOf(id).a).toEqual({ response: null, error: null });
    expect(compareOf(id).sending).toBe(true);

    a.resolve(response());
    await flush();
    expect(compareOf(id).a.response?.status).toBe(200);
    expect(compareOf(id).sending).toBe(false);
  });

  it("lands a rejection on the right side while the other side's success still arrives", async () => {
    const a = deferred<HttpResponse>();
    const b = deferred<HttpResponse>();
    httpIpc.sendHttp.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const id = setup();
    executeCompareRequest(id);

    a.reject(new Error("dns error"));
    b.resolve(response());
    await flush();

    expect(compareOf(id).a).toEqual({ response: null, error: "dns error" });
    expect(compareOf(id).b.response).toEqual(response());
    expect(compareOf(id).sending).toBe(false);

    // Both executions recorded: A's entry an error outcome, B's a success.
    const hist = historyOf();
    expect(hist).toHaveLength(2);
    const entryA = hist.find((h) => h.url === "https://api.test/{{PATH}}");
    const entryB = hist.find((h) => h.url === "https://beta.test/{{PATH}}");
    expect(entryA).toMatchObject({
      status: null,
      statusText: null,
      durationMs: null,
      sizeBytes: null,
      error: "dns error",
    });
    expect(entryB).toMatchObject({ status: 200, error: null });
    // Still the literal header, even on failure.
    expect(entryA?.headers[0].value).toBe("Bearer {{TOKEN}}");
  });

  it("both reject → sending ends false, two error entries recorded", async () => {
    httpIpc.sendHttp
      .mockReturnValueOnce(Promise.reject(new Error("timeout")))
      .mockReturnValueOnce(Promise.reject(new Error("refused")));
    const id = setup();

    executeCompareRequest(id);
    await flush();

    expect(compareOf(id).a.error).toBe("timeout");
    expect(compareOf(id).b.error).toBe("refused");
    expect(compareOf(id).sending).toBe(false);
    const hist = historyOf();
    expect(hist).toHaveLength(2);
    expect(hist.filter((h) => h.error !== null)).toHaveLength(2);
  });

  it("is a silent no-op for unknown id / compare off / empty A url / empty B url / already sending", async () => {
    // unknown id
    executeCompareRequest("nope");
    // compare disabled (everything else valid)
    const off = api().createApiRequest();
    api().patchApiRequest(off, { url: "https://a.test" });
    api().patchCompare(off, { url: "https://b.test" });
    executeCompareRequest(off);
    // empty A url
    const noA = api().createApiRequest();
    api().setCompareEnabled(noA, true);
    api().patchCompare(noA, { url: "https://b.test" });
    executeCompareRequest(noA);
    // empty B url
    const noB = api().createApiRequest();
    api().patchApiRequest(noB, { url: "https://a.test" });
    api().setCompareEnabled(noB, true);
    executeCompareRequest(noB);
    // already sending
    const busy = api().createApiRequest();
    api().patchApiRequest(busy, { url: "https://a.test" });
    api().setCompareEnabled(busy, true);
    api().patchCompare(busy, { url: "https://b.test" });
    api().setCompareSending(busy, true);
    executeCompareRequest(busy);

    await flush();
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
    expect(historyOf()).toHaveLength(0);
    expect(compareOf(off).sending).toBe(false);
  });

  it("sends null (no body) for BOTH wires when the body is empty", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "GET", url: "https://a.test" });
    api().setCompareEnabled(id, true);
    api().patchCompare(id, { method: "GET", url: "https://b.test" });

    executeCompareRequest(id);
    await flush();

    expect(httpIpc.sendHttp.mock.calls[0][0].body).toBeNull();
    expect(httpIpc.sendHttp.mock.calls[1][0].body).toBeNull();
  });

  it("sends a GET body on BOTH wires when one is present (execute.ts's not-gated-on-method rule)", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = api().createApiRequest();
    api().patchApiRequest(id, {
      method: "GET",
      url: "https://a.test",
      body: '{"a":1}',
    });
    api().setCompareEnabled(id, true);
    api().patchCompare(id, { method: "GET", url: "https://b.test" });

    executeCompareRequest(id);
    await flush();

    expect(httpIpc.sendHttp.mock.calls[0][0]).toMatchObject({
      method: "GET",
      body: '{"a":1}',
    });
    expect(httpIpc.sendHttp.mock.calls[1][0]).toMatchObject({
      method: "GET",
      body: '{"a":1}',
    });
  });
});
