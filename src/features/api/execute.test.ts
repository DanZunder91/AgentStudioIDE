/**
 * execute — the shared HTTP send path (M6). `httpIpc` and the persistence modules are
 * mocked at the module boundary (the real ones cross Tauri). What's under test: the
 * `{{VAR}}` resolution onto the WIRE request, that response/error land on the
 * request, and — the follow-on's point — that every execution is RECORDED in history
 * with the LITERAL (pre-substitution) request, so a secret is never logged.
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
import { executeGrpcRequest, executeHttpRequest } from "./execute";
import type { HttpResponse } from "./httpIpc";
import type { GrpcResponse } from "./grpcIpc";

const api = () => useAppStore.getState().apiActions;
const reqOf = (id: string) => useAppStore.getState().apiRequests[id];

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

/** A request whose url/header carry `{{VAR}}` placeholders, plus an active env. */
function setup(): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, { method: "GET", url: "https://api.test/{{PATH}}" });
  api().addHeader(id);
  const hid = reqOf(id).headers[0].id;
  api().updateHeader(id, hid, { name: "Authorization", value: "Bearer {{TOKEN}}" });
  const envId = api().addEnvironment("prod");
  api().setEnvVar(envId, "TOKEN", "sk-secret");
  api().setEnvVar(envId, "PATH", "users");
  api().setActiveEnvironment(envId);
  return id;
}

/** Flush the resolved/rejected-promise microtasks the send path chains on. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("executeHttpRequest", () => {
  beforeEach(() => {
    resetStore();
    httpIpc.sendHttp.mockReset();
    historyIpc.saveApiHistory.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves {{VAR}} onto the WIRE request but records the LITERAL in history", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = setup();

    executeHttpRequest(id);
    await flush();

    // The wire request carried the resolved secret + path.
    const sent = httpIpc.sendHttp.mock.calls[0][0];
    expect(sent.url).toBe("https://api.test/users");
    expect(sent.headers[0]).toEqual({ name: "Authorization", value: "Bearer sk-secret" });

    // The response landed on the request.
    expect(reqOf(id).response).toEqual(response());
    expect(reqOf(id).sending).toBe(false);

    // History recorded the LITERAL request (placeholders kept) + the outcome.
    const hist = useAppStore.getState().apiHistory;
    expect(hist).toHaveLength(1);
    expect(hist[0].url).toBe("https://api.test/{{PATH}}");
    expect(hist[0].headers[0]).toEqual({ name: "Authorization", value: "Bearer {{TOKEN}}" });
    expect(hist[0]).toMatchObject({ status: 200, statusText: "OK", error: null });
    expect(typeof hist[0].at).toBe("number");
  });

  it("records an error outcome (status null) when the send rejects, and surfaces it", async () => {
    httpIpc.sendHttp.mockRejectedValue(new Error("dns error"));
    const id = setup();

    executeHttpRequest(id);
    await flush();

    expect(reqOf(id).error).toBe("dns error");
    expect(reqOf(id).sending).toBe(false);
    const hist = useAppStore.getState().apiHistory;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ status: null, error: "dns error" });
    // Still the literal request, even on failure.
    expect(hist[0].headers[0].value).toBe("Bearer {{TOKEN}}");
  });

  it("is a no-op for an empty url, an in-flight send, or an unknown id (no send, no history)", async () => {
    // unknown id
    executeHttpRequest("nope");
    // empty url
    const empty = api().createApiRequest();
    executeHttpRequest(empty);
    // already sending
    const busy = api().createApiRequest();
    api().patchApiRequest(busy, { url: "https://x.test" });
    api().setApiSending(busy, true);
    executeHttpRequest(busy);

    await flush();
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
    expect(useAppStore.getState().apiHistory).toHaveLength(0);
  });

  it("sends the substituted body on POST (empty body → null)", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = api().createApiRequest();
    api().patchApiRequest(id, {
      method: "POST",
      url: "https://api.test",
      body: "token={{TOKEN}}",
    });
    const envId = api().addEnvironment("prod");
    api().setEnvVar(envId, "TOKEN", "sk-secret");
    api().setActiveEnvironment(envId);

    executeHttpRequest(id);
    await flush();

    const sent = httpIpc.sendHttp.mock.calls[0][0];
    expect(sent.body).toBe("token=sk-secret"); // wire: resolved
    // History keeps the literal body.
    expect(useAppStore.getState().apiHistory[0].body).toBe("token={{TOKEN}}");
  });

  it("sends a body even on GET when one is present (curl-style GET-with-body)", async () => {
    // A pasted request can be `--request GET --data '{…}'`; curl sends the
    // body, so we must too — the send is not gated on the method.
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "GET", url: "https://api.test", body: '{"a":1}' });
    executeHttpRequest(id);
    await flush();
    expect(httpIpc.sendHttp.mock.calls[0][0]).toMatchObject({
      method: "GET",
      body: '{"a":1}',
    });
  });

  it("sends null (no body) when the body is empty", async () => {
    httpIpc.sendHttp.mockResolvedValue(response());
    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "GET", url: "https://api.test" });
    executeHttpRequest(id);
    await flush();
    expect(httpIpc.sendHttp.mock.calls[0][0].body).toBeNull();
  });
});

const grpcResponse = (over: Partial<GrpcResponse> = {}): GrpcResponse => ({
  message: '{"greeting":"hi"}',
  statusCode: 0,
  statusName: "OK",
  error: null,
  ...over,
});

/** A gRPC request whose endpoint/metadata/message carry `{{VAR}}`, plus an env. */
function setupGrpc(): string {
  const id = api().createApiRequest();
  api().setApiProtocol(id, "grpc");
  api().patchApiRequest(id, {
    url: "{{HOST}}:50051",
    body: '{"name":"{{NAME}}"}',
  });
  api().setGrpcService(id, "greeter.Greeter");
  api().setGrpcMethod(id, "SayHello");
  api().addHeader(id);
  const hid = reqOf(id).headers[0].id;
  api().updateHeader(id, hid, {
    name: "authorization",
    value: "Bearer {{TOKEN}}",
  });
  const envId = api().addEnvironment("prod");
  api().setEnvVar(envId, "HOST", "localhost");
  api().setEnvVar(envId, "TOKEN", "sk-secret");
  api().setEnvVar(envId, "NAME", "world");
  api().setActiveEnvironment(envId);
  return id;
}

describe("executeGrpcRequest", () => {
  beforeEach(() => {
    resetStore();
    grpcIpc.grpcSend.mockReset();
    historyIpc.saveApiHistory.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves {{VAR}} in endpoint/metadata/message onto the WIRE, but records the LITERAL", async () => {
    grpcIpc.grpcSend.mockResolvedValue(grpcResponse());
    const id = setupGrpc();

    executeGrpcRequest(id);
    await flush();

    // The wire request carried the resolved endpoint, metadata, and message.
    const sent = grpcIpc.grpcSend.mock.calls[0][0];
    expect(sent).toEqual({
      endpoint: "localhost:50051",
      service: "greeter.Greeter",
      method: "SayHello",
      message: '{"name":"world"}',
      metadata: [{ name: "authorization", value: "Bearer sk-secret" }],
      plaintext: true,
    });

    // The response landed on the request's grpc sub-state.
    expect(reqOf(id).grpc.response).toEqual(grpcResponse());
    expect(reqOf(id).grpc.sending).toBe(false);

    // History recorded ONE entry with the LITERAL request + the mapped columns.
    const hist = useAppStore.getState().apiHistory;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      protocol: "grpc",
      grpcService: "greeter.Greeter",
      method: "SayHello",
      url: "{{HOST}}:50051",
      body: '{"name":"{{NAME}}"}',
      status: 0,
      statusText: "OK",
      durationMs: null,
      sizeBytes: null,
      error: null,
    });
    expect(hist[0].headers[0]).toEqual({
      name: "authorization",
      value: "Bearer {{TOKEN}}",
    });
  });

  it("records a non-OK status as a RESOLVED outcome (status code + name:message)", async () => {
    grpcIpc.grpcSend.mockResolvedValue(
      grpcResponse({
        message: "{}",
        statusCode: 5,
        statusName: "NOT_FOUND",
        error: "no such user",
      }),
    );
    const id = setupGrpc();

    executeGrpcRequest(id);
    await flush();

    expect(reqOf(id).grpc.response?.statusCode).toBe(5);
    expect(reqOf(id).grpc.error).toBeNull(); // NOT a transport error
    const hist = useAppStore.getState().apiHistory;
    expect(hist[0]).toMatchObject({
      status: 5,
      statusText: "NOT_FOUND: no such user",
      error: null,
    });
  });

  it("records an error outcome (status null) when the call rejects (transport failure)", async () => {
    grpcIpc.grpcSend.mockRejectedValue(new Error("connection refused"));
    const id = setupGrpc();

    executeGrpcRequest(id);
    await flush();

    expect(reqOf(id).grpc.error).toBe("connection refused");
    expect(reqOf(id).grpc.sending).toBe(false);
    const hist = useAppStore.getState().apiHistory;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      protocol: "grpc",
      status: null,
      statusText: null,
      error: "connection refused",
    });
    // Still the literal metadata, even on failure.
    expect(hist[0].headers[0].value).toBe("Bearer {{TOKEN}}");
  });

  it("is a no-op for an unknown id, an empty endpoint, no service/method, or an in-flight call", async () => {
    // unknown id
    executeGrpcRequest("nope");
    // empty endpoint
    const emptyUrl = api().createApiRequest();
    api().setApiProtocol(emptyUrl, "grpc");
    api().setGrpcService(emptyUrl, "S");
    api().setGrpcMethod(emptyUrl, "M");
    executeGrpcRequest(emptyUrl);
    // no service/method
    const noMethod = api().createApiRequest();
    api().patchApiRequest(noMethod, { url: "localhost:50051" });
    executeGrpcRequest(noMethod);
    // already sending
    const busy = api().createApiRequest();
    api().patchApiRequest(busy, { url: "localhost:50051" });
    api().setGrpcService(busy, "S");
    api().setGrpcMethod(busy, "M");
    api().setGrpcSending(busy, true);
    executeGrpcRequest(busy);

    await flush();
    expect(grpcIpc.grpcSend).not.toHaveBeenCalled();
    expect(useAppStore.getState().apiHistory).toHaveLength(0);
  });

  it("re-runs a gRPC history entry through loadHistoryIntoRequest (restores protocol/service/method)", async () => {
    grpcIpc.grpcSend.mockResolvedValue(grpcResponse());
    const id = setupGrpc();
    executeGrpcRequest(id);
    await flush();

    const entryId = useAppStore.getState().apiHistory[0].id;
    const fresh = api().createApiRequest();
    api().loadHistoryIntoRequest(entryId, fresh);

    const r = reqOf(fresh);
    expect(r.protocol).toBe("grpc");
    expect(r.grpc.service).toBe("greeter.Greeter");
    expect(r.grpc.method).toBe("SayHello");
    expect(r.url).toBe("{{HOST}}:50051"); // literal endpoint
    expect(r.body).toBe('{"name":"{{NAME}}"}'); // literal message
    expect(r.headers[0]).toMatchObject({
      name: "authorization",
      value: "Bearer {{TOKEN}}",
    });
  });
});
