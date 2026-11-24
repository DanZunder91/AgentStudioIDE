/** Formatters — every expectation is a literal, written from Proxelar's layout and the wire. */

import { describe, expect, it } from "vitest";

import {
  durationTone,
  formatDuration,
  formatSize,
  formatSizeShort,
  formatTime,
  grpcFailed,
  hostCell,
  methodTone,
  pathCell,
  protoLabel,
  sizeCell,
  statusBucket,
  statusCell,
  typeCell,
  tunnelBytes,
} from "./networkFormat";

describe("formatSize", () => {
  it.each([
    [0, "0B"],
    [11, "11B"],
    [93, "93B"],
    [1023, "1023B"],
    [1024, "1.0KB"],
    [4096, "4.0KB"],
    [46592, "45.5KB"],
    [1048575, "1024.0KB"],
    [1048576, "1.0MB"],
    [5 * 1048576 + 262144, "5.3MB"],
  ])("%d → %s", (n, s) => expect(formatSize(n)).toBe(s));
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [601, "601ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [1300, "1.3s"],
    [30000, "30.0s"],
    [30049, "30.0s"],
  ])("%d → %s", (n, s) => expect(formatDuration(n)).toBe(s));
});

describe("formatTime", () => {
  it("is local HH:MM:SS, zero-padded", () => {
    const d = new Date(2026, 8, 24, 20, 5, 7, 999);
    expect(formatTime(d.getTime())).toBe("20:05:07");
    expect(formatTime(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe("00:00:00");
  });
});

describe("labels and tones", () => {
  it("proto labels", () => {
    expect(["http", "https", "ws", "wss", "grpc", "tunnel", "bypass"].map((p) => protoLabel(p as never))).toEqual([
      "HTTP",
      "HTTPS",
      "WS",
      "WSS",
      "gRPC",
      "TUNNEL",
      "BYPASS",
    ]);
  });

  it.each([
    [null, "pending", "pending"],
    [null, "done", "none"],
    [null, "error", "none"],
    [101, "done", "1xx"],
    [199, "done", "1xx"],
    [200, "done", "2xx"],
    [299, "done", "2xx"],
    [301, "done", "3xx"],
    [404, "done", "4xx"],
    [499, "done", "4xx"],
    [500, "done", "5xx"],
    [502, "done", "5xx"],
  ] as const)("status %s (%s) → %s", (status, state, bucket) =>
    expect(statusBucket({ status, state })).toBe(bucket),
  );

  it.each([
    [0, "fast"],
    [499, "fast"],
    [500, "mid"],
    [999, "mid"],
    [1000, "slow"],
    [30000, "slow"],
  ] as const)("duration %d → %s", (ms, tone) => expect(durationTone(ms)).toBe(tone));

  it.each([
    ["GET", "get"],
    ["post", "post"],
    ["POST", "post"],
    ["DELETE", "delete"],
    ["PUT", "get"],
    ["CONNECT", "get"],
  ] as const)("method %s → %s", (m, tone) => expect(methodTone(m)).toBe(tone));
});

describe("cells", () => {
  it("host/path: a tunnel shows host:port and what it saw instead of a path — encrypted · n ↑ m ↓", () => {
    expect(hostCell({ proto: "tunnel", host: "api.x.com", port: 443 })).toBe("api.x.com:443");
    expect(hostCell({ proto: "https", host: "api.x.com", port: 443 })).toBe("api.x.com");
    expect(hostCell({ proto: "bypass", host: "", port: 0 })).toBe("—");
    expect(pathCell({ proto: "tunnel", path: "", reqBytes: 1200, resBytes: 46_600 })).toBe("encrypted · 1.2KB ↑ 45.5KB ↓");
    expect(pathCell({ proto: "tunnel", path: "" })).toBe("encrypted · 0B ↑ 0B ↓");
    expect(pathCell({ proto: "tunnel", path: "", state: "error", reqBytes: 0, resBytes: 0 })).toBe("—");
    expect(tunnelBytes({ reqBytes: 10, resBytes: 2048 })).toBe("10B ↑ 2.0KB ↓");
    // A bypassed command: its parsed path, else the command itself.
    expect(pathCell({ proto: "bypass", path: "/v1/x" })).toBe("/v1/x");
    expect(pathCell({ proto: "bypass", path: "", bypass: { command: "NO_PROXY=* ./sync" } })).toBe("NO_PROXY=* ./sync");
    expect(pathCell({ proto: "bypass", path: "" })).toBe("—");
    expect(pathCell({ proto: "http", path: "" })).toBe("—");
    expect(pathCell({ proto: "grpc", path: "/pkg.Svc/M" })).toBe("/pkg.Svc/M");
  });

  it("status: a tunnel is its connection state (never —); a bypass is not captured", () => {
    const t = { status: null, grpcStatus: null, proto: "tunnel" } as const;
    expect(statusCell({ ...t, state: "pending" })).toBe("open");
    expect(statusCell({ ...t, state: "done" })).toBe("closed");
    expect(statusCell({ ...t, state: "error" })).toBe("failed");
    expect(statusBucket({ ...t, state: "pending" })).toBe("open");
    expect(statusBucket({ ...t, state: "done" })).toBe("closed");
    expect(statusBucket({ ...t, state: "error" })).toBe("none");
    expect(statusCell({ ...t, proto: "bypass", state: "done" })).toBe("not captured");
    expect(statusBucket({ ...t, proto: "bypass", state: "done" })).toBe("bypass");
    // Neutralised by the curl shim: the request is its own (captured) row.
    const shimmed = { command: "curl x", method: null, url: null, agentId: null, toolUseId: null, reasons: [], neutralized: true };
    expect(statusCell({ ...t, proto: "bypass", state: "done", bypass: shimmed })).toBe("via proxy");
    expect(statusBucket({ ...t, proto: "bypass", state: "done", bypass: shimmed })).toBe("none");
  });

  it("status: … pending, — none, grpc failures appended", () => {
    expect(statusCell({ status: null, state: "pending", grpcStatus: null })).toBe("…");
    expect(statusCell({ status: null, state: "done", grpcStatus: null })).toBe("—");
    expect(statusCell({ status: 502, state: "done", grpcStatus: null })).toBe("502");
    expect(statusCell({ status: 200, state: "done", grpcStatus: 0 })).toBe("200");
    expect(statusCell({ status: 200, state: "done", grpcStatus: 14 })).toBe("200 g14");
    expect(grpcFailed({ grpcStatus: 14 })).toBe(true);
    expect(grpcFailed({ grpcStatus: 0 })).toBe(false);
    expect(grpcFailed({ grpcStatus: null })).toBe(false);
  });

  it("type: error wins, params stripped, [no content], tunnel, pending", () => {
    const base = { state: "done", error: null, contentType: null, proto: "https", note: null } as const;
    expect(typeCell({ ...base, error: "upstream: connection refused", state: "error" })).toEqual({
      kind: "error",
      text: "upstream: connection refused",
    });
    expect(typeCell({ ...base, contentType: "application/json; charset=utf-8" })).toEqual({
      kind: "type",
      text: "application/json",
    });
    expect(typeCell(base)).toEqual({ kind: "dim", text: "[no content]" });
    expect(typeCell({ ...base, contentType: "  " })).toEqual({ kind: "dim", text: "[no content]" });
    expect(typeCell({ ...base, proto: "tunnel" })).toEqual({ kind: "dim", text: "[encrypted]" });
    expect(typeCell({ ...base, proto: "bypass" })).toEqual({ kind: "note", text: "skipped the IDE proxy" });
    expect(typeCell({ ...base, proto: "bypass", note: "not captured: --noproxy" })).toEqual({ kind: "note", text: "not captured: --noproxy" });
    expect(typeCell({ ...base, state: "pending" })).toEqual({ kind: "dim", text: "…" });
  });

  it("size: response bytes, or both directions for a tunnel", () => {
    expect(sizeCell({ proto: "https", reqBytes: 5000, resBytes: 11 })).toBe("11B");
    expect(sizeCell({ proto: "tunnel", reqBytes: 1000, resBytes: 3096 })).toBe("↑1000B ↓3.0K");
    expect(sizeCell({ proto: "bypass", reqBytes: 0, resBytes: 0 })).toBe("—");
  });

  it.each([
    [0, "0B"],
    [1023, "1023B"],
    [1024, "1.0K"],
    [10 * 1024 - 1, "10.0K"],
    [10 * 1024, "10K"],
    [1024 * 1024 - 1, "1023K"],
    [1024 * 1024, "1.0M"],
    [10 * 1024 * 1024, "10M"],
    [999 * 1024 * 1024, "999M"],
  ])("formatSizeShort(%d) = %s (≤ 5 glyphs, so a tunnel's two directions fit one cell)", (n, want) => {
    expect(formatSizeShort(n)).toBe(want);
    expect(want.length).toBeLessThanOrEqual(5);
  });
});
