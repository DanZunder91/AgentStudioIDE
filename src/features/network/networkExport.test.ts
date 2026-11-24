/**
 * Flow → cURL / API-client request. Nothing is redacted: credentials
 * are exported verbatim so the replay is the request that was sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { parseCurl } from "../api/curlParse";
import {
  exportable,
  flowCurl,
  flowUrl,
  openInApiClient,
  rawCopyable,
  rawRequest,
  rawResponse,
  requestLine,
  responseBodyText,
  statusLine,
} from "./networkExport";
import type { FlowDetail, FlowSummary } from "./networkTypes";

function flow(o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: 1,
    startedMs: 0,
    proto: "https",
    method: "POST",
    host: "api.example.com",
    port: 443,
    path: "/v1/items?x=1",
    status: 200,
    grpcStatus: null,
    contentType: "application/json",
    reqBytes: 10,
    resBytes: 10,
    durationMs: 10,
    state: "done",
    error: null,
    terminalId: null,
    httpVersion: "HTTP/1.1",
    wsMessages: null,
    client: null,
    note: null,
    ...o,
  };
}

function detail(o: Partial<FlowDetail> = {}, s: FlowSummary = flow()): FlowDetail {
  return {
    summary: s,
    requestHeaders: [
      ["Host", "api.example.com"],
      ["content-type", "application/json"],
      ["Authorization", "Bearer sk-live-4f9a"],
      ["x-api-key", "key_1234abcd"],
      ["Content-Length", "13"],
      [":authority", "api.example.com"],
      ["Accept", "*/*"],
    ],
    responseHeaders: [],
    responseTrailers: [],
    requestBody: { size: 13, truncated: false, text: '{"name":"a"}', base64: null },
    responseBody: null,
    ...o,
  };
}

beforeEach(() => resetStore());

describe("flowUrl", () => {
  it.each([
    [{ proto: "https", host: "a.com", port: 443, path: "/x" }, "https://a.com/x"],
    [{ proto: "https", host: "a.com", port: 8443, path: "/x" }, "https://a.com:8443/x"],
    [{ proto: "http", host: "a.com", port: 80, path: "/" }, "http://a.com/"],
    [{ proto: "http", host: "a.com", port: 3000, path: "/" }, "http://a.com:3000/"],
    [{ proto: "wss", host: "a.com", port: 443, path: "/s" }, "wss://a.com/s"],
    [{ proto: "ws", host: "a.com", port: 80, path: "/s" }, "ws://a.com/s"],
    [{ proto: "grpc", host: "g.com", port: 443, path: "/p.S/M" }, "https://g.com/p.S/M"],
    [{ proto: "http", host: "::1", port: 8080, path: "/" }, "http://[::1]:8080/"],
  ] as const)("%j → %s", (f, url) => expect(flowUrl(f)).toBe(url));
});

describe("exportable", () => {
  it("keeps every header verbatim — credentials included — and drops only connection headers", () => {
    const e = exportable(flow(), detail());
    expect(e).toEqual({
      ok: true,
      request: {
        method: "POST",
        url: "https://api.example.com/v1/items?x=1",
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "Authorization", value: "Bearer sk-live-4f9a" },
          { name: "x-api-key", value: "key_1234abcd" },
          { name: "Accept", value: "*/*" },
        ],
        body: '{"name":"a"}',
      },
    });
  });

  it("no body / empty body → null", () => {
    const a = exportable(flow({ method: "GET" }), detail({ requestBody: null }));
    const b = exportable(flow({ method: "GET" }), detail({ requestBody: { size: 0, truncated: false, text: "", base64: null } }));
    expect(a.ok && a.request.body).toBeNull();
    expect(b.ok && b.request.body).toBeNull();
  });

  it.each([
    [flow({ proto: "tunnel", method: "CONNECT", path: "" }), detail(), /Encrypted tunnel.*Decrypt HTTPS/],
    // A rejected TLS handshake: an https row with method CONNECT and no request behind it.
    [flow({ proto: "https", method: "CONNECT", path: "", state: "error" }), detail(), /No request was captured/],
    [flow({ proto: "wss" }), detail(), /WebSocket/],
    [flow({ proto: "ws" }), detail(), /WebSocket/],
    [flow({ proto: "grpc" }), detail(), /gRPC/],
    [flow(), null, /Loading/],
    [flow(), detail({ requestBody: { size: 99, truncated: false, text: null, base64: "AAE=" } }), /binary \(99 bytes\)/],
    [flow(), detail({ requestBody: { size: 2_000_000, truncated: true, text: "{", base64: null } }), /truncated at the 1 MiB/],
  ])("disabled with a reason (%#)", (s, d, reason) => {
    const e = exportable(s, d);
    expect(e.ok).toBe(false);
    expect(!e.ok && e.reason).toMatch(reason);
  });
});

describe("flowCurl", () => {
  it("round-trips through the API client's own parser, credentials included", () => {
    const e = exportable(flow(), detail());
    if (!e.ok) throw new Error("expected exportable");
    const cmd = flowCurl(e.request);
    expect(cmd).toBe(
      `curl -X POST 'https://api.example.com/v1/items?x=1' -H 'content-type: application/json' -H 'Authorization: Bearer sk-live-4f9a' -H 'x-api-key: key_1234abcd' -H 'Accept: */*' --data '{"name":"a"}'`,
    );
    expect(parseCurl(cmd)).toEqual({
      method: "POST",
      url: "https://api.example.com/v1/items?x=1",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "Authorization", value: "Bearer sk-live-4f9a" },
        { name: "x-api-key", value: "key_1234abcd" },
        { name: "Accept", value: "*/*" },
      ],
      body: '{"name":"a"}',
    });
  });

  it("does not resolve {{VAR}} — a captured request has none, a literal stays literal", () => {
    expect(flowCurl({ method: "GET", url: "https://a.com/{{x}}", headers: [], body: null })).toBe("curl 'https://a.com/{{x}}'");
  });

  it("on Windows it is written for PowerShell — the IDE's terminal shell there, where bash's `'\\''` breaks", () => {
    const ua = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    try {
      const cmd = flowCurl({ method: "GET", url: "https://a.com/x", headers: [{ name: "X-Q", value: "it's" }], body: null });
      // `curl.exe`, never PowerShell 5.1's `curl` alias; a quote doubles inside '…' (PowerShell), not `'\''`.
      expect(cmd.startsWith("curl.exe ")).toBe(true);
      expect(cmd).toContain("'X-Q: it''s'");
      expect(cmd).not.toContain("'\\''");
    } finally {
      ua.mockRestore();
    }
  });
});

describe("openInApiClient", () => {
  it("seeds a NEW request with method/url/headers/body and opens its tab", () => {
    const e = exportable(flow(), detail());
    if (!e.ok) throw new Error("expected exportable");
    const id = openInApiClient(e.request);
    const s = useAppStore.getState();
    const req = s.apiRequests[id];
    expect(req).toMatchObject({ method: "POST", url: "https://api.example.com/v1/items?x=1", body: '{"name":"a"}', protocol: "http" });
    expect(req.headers.map((h) => [h.name, h.value, h.enabled])).toEqual([
      ["content-type", "application/json", true],
      ["Authorization", "Bearer sk-live-4f9a", true],
      ["x-api-key", "key_1234abcd", true],
      ["Accept", "*/*", true],
    ]);
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "api-request");
    expect(tab?.ref).toEqual({ kind: "api-request", requestId: id });
    // Not sent: nothing in flight, no response.
    expect(req.sending).toBe(false);
    expect(req.response).toBeNull();
  });

  it("a null body seeds an empty body", () => {
    const id = openInApiClient({ method: "GET", url: "http://a.com/", headers: [], body: null });
    expect(useAppStore.getState().apiRequests[id]).toMatchObject({ method: "GET", body: "", headers: [] });
  });
});

describe("see and copy the request", () => {
  it("request line: method, path (\"/\" when empty), version (HTTP/1.1 when unknown)", () => {
    expect(requestLine(flow())).toBe("POST /v1/items?x=1 HTTP/1.1");
    expect(requestLine(flow({ method: "GET", path: "", httpVersion: "" }))).toBe("GET / HTTP/1.1");
    expect(requestLine(flow({ httpVersion: "HTTP/2" }))).toBe("POST /v1/items?x=1 HTTP/2");
  });

  it("status line: version + status, null with no response", () => {
    expect(statusLine(flow())).toBe("HTTP/1.1 200");
    expect(statusLine(flow({ httpVersion: "", status: 404 }))).toBe("HTTP/1.1 404");
    expect(statusLine(flow({ status: null }))).toBeNull();
  });

  it("Copy request: raw HTTP exactly as captured — credentials kept, pseudo-headers folded, body after a blank line", () => {
    expect(rawRequest(flow(), detail())).toBe(
      [
        "POST /v1/items?x=1 HTTP/1.1",
        "Host: api.example.com",
        "content-type: application/json",
        "Authorization: Bearer sk-live-4f9a",
        "x-api-key: key_1234abcd",
        "Content-Length: 13",
        "Accept: */*",
        "",
        '{"name":"a"}',
      ].join("\n"),
    );
  });

  it("Copy request: no host header → a Host line from the flow (port only when not the default); the proxy's own header is dropped", () => {
    const d = detail({
      requestHeaders: [
        [":authority", "localhost:8080"],
        ["proxy-authorization", "Basic dC0xOng="],
        ["accept", "*/*"],
      ],
      requestBody: null,
    });
    expect(rawRequest(flow({ proto: "http", method: "GET", host: "localhost", port: 8080, path: "/health" }), d)).toBe(
      "GET /health HTTP/1.1\nHost: localhost:8080\naccept: */*",
    );
    expect(rawRequest(flow({ proto: "http", method: "GET", host: "example.com", port: 80, path: "/" }), d)).toBe(
      "GET / HTTP/1.1\nHost: example.com\naccept: */*",
    );
  });

  it("Copy request: a binary body is a bracketed note; a truncated one says so after the text; an empty one is no body", () => {
    const bin = detail({ requestHeaders: [["host", "h"]], requestBody: { size: 6, truncated: false, text: null, base64: "AAECAwQF" } });
    expect(rawRequest(flow(), bin)).toBe("POST /v1/items?x=1 HTTP/1.1\nhost: h\n\n[binary body, 6 bytes]");
    const cut = detail({ requestHeaders: [["host", "h"]], requestBody: { size: 2000000, truncated: true, text: "abc", base64: null } });
    expect(rawRequest(flow(), cut)).toBe(
      "POST /v1/items?x=1 HTTP/1.1\nhost: h\n\nabc\n[truncated at the 1 MiB capture limit — 2000000 bytes on the wire]",
    );
    const empty = detail({ requestHeaders: [["host", "h"]], requestBody: { size: 0, truncated: false, text: "", base64: null } });
    expect(rawRequest(flow(), empty)).toBe("POST /v1/items?x=1 HTTP/1.1\nhost: h");
    const emptyBin = detail({ requestHeaders: [["host", "h"]], requestBody: { size: 0, truncated: false, text: null, base64: "" } });
    expect(rawRequest(flow(), emptyBin)).toBe("POST /v1/items?x=1 HTTP/1.1\nhost: h");
  });

  it("Copy response: status line, headers, blank line, body — then trailers; pseudo-headers dropped", () => {
    const d = detail({
      responseHeaders: [[":status", "200"], ["content-type", "application/json"], ["set-cookie", "sid=abc"]],
      responseBody: { size: 11, truncated: false, text: '{"ok":true}', base64: null },
    });
    expect(rawResponse(flow(), d)).toBe(
      'HTTP/1.1 200\ncontent-type: application/json\nset-cookie: sid=abc\n\n{"ok":true}',
    );
    const grpc = detail({
      responseHeaders: [["content-type", "application/grpc"]],
      responseTrailers: [["grpc-status", "3"], ["grpc-message", "bad name"]],
      responseBody: null,
    });
    expect(rawResponse(flow({ httpVersion: "HTTP/2" }), grpc)).toBe(
      "HTTP/2 200\ncontent-type: application/grpc\n\ngrpc-status: 3\ngrpc-message: bad name",
    );
    expect(rawResponse(flow({ status: null }), detail())).toBe("(no response)");
  });

  it("Copy body: the response text only; null for none, binary or empty", () => {
    expect(responseBodyText(detail({ responseBody: { size: 2, truncated: false, text: "hi", base64: null } }))).toBe("hi");
    expect(responseBodyText(detail({ responseBody: null }))).toBeNull();
    expect(responseBodyText(detail({ responseBody: { size: 2, truncated: false, text: null, base64: "AA==" } }))).toBeNull();
    expect(responseBodyText(detail({ responseBody: { size: 0, truncated: false, text: "", base64: null } }))).toBeNull();
  });

  it("copyable: every flow the proxy read; a tunnel / handshake says why; loading says so", () => {
    expect(rawCopyable(flow(), detail())).toEqual({ ok: true });
    expect(rawCopyable(flow({ proto: "grpc" }), detail())).toEqual({ ok: true });
    expect(rawCopyable(flow({ proto: "ws" }), detail())).toEqual({ ok: true });
    expect(rawCopyable(flow(), null)).toEqual({ ok: false, reason: "Loading the captured request…" });
    expect(rawCopyable(flow({ proto: "tunnel", method: "CONNECT", note: "not decrypted: gazelle doesn't read the IDE's CA" }), null)).toEqual({
      ok: false,
      reason: "Encrypted tunnel — the proxy never saw the request (not decrypted: gazelle doesn't read the IDE's CA).",
    });
    expect(rawCopyable(flow({ method: "CONNECT", path: "", error: "tls rejected → passthrough" }), null)).toEqual({
      ok: false,
      reason: "Nothing to replay — The client refused the IDE's certificate before sending a request.",
    });
  });
});
