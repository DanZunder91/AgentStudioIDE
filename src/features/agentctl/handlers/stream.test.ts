import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("../../api/historyIpc", () => ipc);

import { useAppStore } from "../../../app/store";
import { resetStore } from "../../../test/store-harness";
import type { HistoryEntry } from "../../api/historyIpc";
import { dispatchAgentCtl, HANDLERS } from "../dispatch";
import { grpcHistoryEntry, recordGrpcCall, STREAM_HANDLERS } from "./stream";

/** The event Rust's `grpc_call` emits for an answered call. */
const answered = {
  kind: "grpcCall",
  terminalId: "t1",
  target: "127.0.0.1:50051",
  service: "test.v1.Echo",
  method: "Say",
  body: '{"text":"hi"}',
  headers: [{ name: "x-tenant", value: "acme" }],
  plaintext: true,
  statusCode: 0,
  statusName: "OK",
  error: null,
  transportError: null,
  durationMs: 12,
};

const saved: HistoryEntry = {
  id: "h1",
  method: "GET",
  url: "https://example.test/",
  headers: [],
  body: "",
  status: 200,
  statusText: "OK",
  durationMs: 5,
  sizeBytes: 2,
  error: null,
  at: 1,
};

/** Let the handler's awaited load and the record after it run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetStore();
  ipc.loadApiHistory.mockReset();
  ipc.saveApiHistory.mockReset();
  ipc.saveApiHistory.mockResolvedValue(undefined);
});

describe("grpcHistoryEntry", () => {
  it("records an answered call the way the gRPC console does", () => {
    expect(grpcHistoryEntry(answered, 99)).toEqual({
      protocol: "grpc",
      grpcService: "test.v1.Echo",
      method: "Say",
      url: "127.0.0.1:50051",
      headers: [{ name: "x-tenant", value: "acme" }],
      body: '{"text":"hi"}',
      at: 99,
      status: 0,
      statusText: "OK",
      durationMs: 12,
      sizeBytes: null,
      error: null,
    });
  });

  it("keeps a non-OK status as an answer, with its message", () => {
    const e = grpcHistoryEntry(
      { ...answered, statusCode: 5, statusName: "NotFound", error: "no such echo" },
      1,
    );
    expect([e.status, e.statusText, e.error]).toEqual([5, "NotFound: no such echo", null]);
  });

  it("records a call that never got an answer as an error", () => {
    const e = grpcHistoryEntry(
      { ...answered, statusCode: null, statusName: null, transportError: "could not connect" },
      1,
    );
    expect([e.status, e.statusText, e.error]).toEqual([null, null, "could not connect"]);
  });

  it("drops what is not the shape it expects instead of storing it", () => {
    const e = grpcHistoryEntry(
      {
        kind: "grpcCall",
        terminalId: "t1",
        target: 5,
        headers: [{ name: "ok", value: "1" }, { name: 2, value: "x" }, null, "x: y"],
        durationMs: "soon",
      },
      1,
    );
    expect(e).toMatchObject({
      url: "",
      method: "",
      grpcService: "",
      body: "",
      headers: [{ name: "ok", value: "1" }],
      status: null,
      statusText: null,
      durationMs: null,
      error: null,
    });
    expect(grpcHistoryEntry({ kind: "grpcCall", terminalId: "t", headers: "x" }, 1).headers).toEqual(
      [],
    );
  });
});

describe("recordGrpcCall", () => {
  it("appends to a loaded History without loading it again", async () => {
    useAppStore.getState().apiActions.hydrateApiHistory({ entries: [saved] });
    await recordGrpcCall(answered);
    expect(ipc.loadApiHistory).not.toHaveBeenCalled();
    const log = useAppStore.getState().apiHistory;
    expect(log.map((e) => e.url)).toEqual(["https://example.test/", "127.0.0.1:50051"]);
    expect(ipc.saveApiHistory).toHaveBeenLastCalledWith({ entries: log });
  });

  it("loads History first when nothing has, so the saved log is kept", async () => {
    ipc.loadApiHistory.mockResolvedValue({ entries: [saved] });
    await recordGrpcCall(answered);
    expect(ipc.loadApiHistory).toHaveBeenCalledTimes(1);
    const state = useAppStore.getState();
    expect(state.apiHistoryLoaded).toBe(true);
    expect(state.apiHistory.map((e) => e.id === "h1" || e.protocol === "grpc")).toEqual([
      true,
      true,
    ]);
    expect(ipc.saveApiHistory.mock.calls.at(-1)?.[0].entries).toHaveLength(2);
  });

  it("keeps the History panel's copy when it loaded first", async () => {
    let release: (v: { entries: HistoryEntry[] }) => void = () => undefined;
    ipc.loadApiHistory.mockReturnValue(new Promise((r) => (release = r)));
    const pending = recordGrpcCall(answered);
    useAppStore.getState().apiActions.hydrateApiHistory({ entries: [saved] });
    release({ entries: [] });
    await pending;
    expect(useAppStore.getState().apiHistory.map((e) => e.url)).toEqual([
      "https://example.test/",
      "127.0.0.1:50051",
    ]);
  });
});

describe("STREAM_HANDLERS", () => {
  it("routes grpcCall from the dispatcher into History", async () => {
    expect(HANDLERS.grpcCall).toBe(STREAM_HANDLERS.grpcCall);
    ipc.loadApiHistory.mockResolvedValue({ entries: [] });
    dispatchAgentCtl(answered);
    await settle();
    expect(useAppStore.getState().apiHistory).toEqual([
      expect.objectContaining({ protocol: "grpc", grpcService: "test.v1.Echo", status: 0 }),
    ]);
  });
});

describe("wsOpen / grpcOpen", () => {
  /** The newest API request and the title of its tab. */
  const newest = () => {
    const s = useAppStore.getState();
    const ids = Object.keys(s.apiRequests);
    return s.apiRequests[ids[ids.length - 1]];
  };
  const titles = (): string[] =>
    Object.values(useAppStore.getState().tabs).map((t) => t.customTitle ?? t.title);

  it("opens a WebSocket console tab filled in, not connected", () => {
    const before = Object.keys(useAppStore.getState().apiRequests).length;
    dispatchAgentCtl({
      kind: "wsOpen",
      terminalId: "t1",
      url: "wss://echo.example.test/socket",
      headers: [{ name: "X-Client", value: "agent" }],
      message: '{"hello":true}',
      title: "WS echo.example.test/socket",
    });
    expect(Object.keys(useAppStore.getState().apiRequests)).toHaveLength(before + 1);
    const r = newest();
    expect(r.protocol).toBe("ws");
    expect(r.url).toBe("wss://echo.example.test/socket");
    expect(JSON.stringify(r)).toContain('{\\"hello\\":true}');
    expect(titles()).toContain("WS echo.example.test/socket");
  });

  it("opens a gRPC console tab with target, method, body and metadata, not sent", () => {
    dispatchAgentCtl({
      kind: "grpcOpen",
      terminalId: "t1",
      target: "localhost:50051",
      plaintext: true,
      service: "greet.Greeter",
      method: "SayHello",
      body: '{\n  "name": "ada"\n}',
      headers: [{ name: "x-trace", value: "1" }],
      title: "gRPC SayHello",
    });
    const r = newest();
    expect(r.protocol).toBe("grpc");
    expect(r.url).toBe("localhost:50051");
    expect(JSON.stringify(r)).toContain("greet.Greeter");
    expect(JSON.stringify(r)).toContain("SayHello");
    expect(titles()).toContain("gRPC SayHello");
  });

  it("opens nothing for a tab naming a Vault variable, however it is spelled", () => {
    const before = Object.keys(useAppStore.getState().apiRequests).length;
    STREAM_HANDLERS.wsOpen({ kind: "wsOpen", terminalId: "t1", url: "wss://h/{{T}}" });
    STREAM_HANDLERS.wsOpen({
      kind: "wsOpen",
      terminalId: "t1",
      url: "wss://h",
      message: "\\u007b\\u007bT}}",
    });
    STREAM_HANDLERS.grpcOpen({
      kind: "grpcOpen",
      terminalId: "t1",
      target: "h:1",
      headers: [{ name: "authorization", value: "%7B%7BT}}" }],
    });
    expect(Object.keys(useAppStore.getState().apiRequests)).toHaveLength(before);
  });

  it("leaves the message box and method alone when the event has none", () => {
    dispatchAgentCtl({ kind: "wsOpen", terminalId: "t1", url: "ws://h:1/x" });
    expect(newest().protocol).toBe("ws");
    dispatchAgentCtl({ kind: "grpcOpen", terminalId: "t1", target: "h:1" });
    expect(newest().protocol).toBe("grpc");
    expect(HANDLERS).toHaveProperty("wsOpen");
    expect(HANDLERS).toHaveProperty("grpcOpen");
  });
});
