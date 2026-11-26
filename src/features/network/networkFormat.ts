/** Pure cell formatters for the Network table, so a test can pin one value at a time. */

import type { FlowProto, FlowSummary } from "./networkTypes";

const KB = 1024;
const MB = 1024 * 1024;

/** `93B`, `4.0KB`, `45.5KB`, `1.2MB`. */
export function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes}B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)}KB`;
  return `${(bytes / MB).toFixed(1)}MB`;
}

/** `601ms`, `1.3s`, `30.0s`. Rounded first, so 999.6 ms reads `1.0s`, never `1000ms`. */
export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** At most 5 glyphs, so a tunnel's two directions fit one narrow Size cell (`↑1023K ↓1023K`).
 * The exact counts are in the Path cell and the detail. */
export function formatSizeShort(bytes: number): string {
  if (bytes < KB) return `${bytes}B`;
  if (bytes < 10 * KB) return `${(bytes / KB).toFixed(1)}K`;
  if (bytes < MB) return `${Math.floor(bytes / KB)}K`;
  if (bytes < 10 * MB) return `${(bytes / MB).toFixed(1)}M`;
  return `${Math.floor(bytes / MB)}M`;
}

/** `HH:MM:SS`, local time. */
export function formatTime(unixMs: number): string {
  const d = new Date(unixMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const PROTO_LABEL: Record<FlowProto, string> = {
  http: "HTTP",
  https: "HTTPS",
  ws: "WS",
  wss: "WSS",
  grpc: "gRPC",
  tunnel: "TUNNEL",
  bypass: "BYPASS",
};

export function protoLabel(proto: FlowProto): string {
  return PROTO_LABEL[proto];
}

export type StatusBucket = "pending" | "none" | "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "open" | "closed" | "bypass";

/** Only a tunnel / bypass row needs its proto to be told apart; older callers may omit it. */
type WithProto = { proto?: FlowProto };
type WithBypass = Partial<Pick<FlowSummary, "bypass">>;

/** A finished flow with no HTTP status (error before any response) is `none`, not waiting. A tunnel
 * has no HTTP status (the proxy never reads it), so its bucket is its connection state: `open`
 * (live, pulsing), `closed`, or `none` when it failed. A bypassed command is `bypass`. */
export function statusBucket(f: Pick<FlowSummary, "status" | "state"> & WithProto & WithBypass): StatusBucket {
  if (f.proto === "bypass") return f.bypass?.neutralized === true ? "none" : "bypass";
  if (f.proto === "tunnel") return f.state === "pending" ? "open" : f.state === "done" ? "closed" : "none";
  if (f.status === null) return f.state === "pending" ? "pending" : "none";
  if (f.status >= 500) return "5xx";
  if (f.status >= 400) return "4xx";
  if (f.status >= 300) return "3xx";
  if (f.status >= 200) return "2xx";
  return "1xx";
}

export type Tone = "fast" | "mid" | "slow";

/** green < 500 ms, yellow < 1 s, magenta ≥ 1 s. */
export function durationTone(ms: number): Tone {
  if (ms < 500) return "fast";
  if (ms < 1000) return "mid";
  return "slow";
}

export type MethodTone = "get" | "post" | "delete";

/** Proto/method are green, POST yellow, DELETE red. */
export function methodTone(method: string): MethodTone {
  const m = method.toUpperCase();
  if (m === "POST") return "post";
  if (m === "DELETE") return "delete";
  return "get";
}

/** The Host cell — a tunnel has no path, so its port is the only other thing it knows. */
export function hostCell(f: Pick<FlowSummary, "proto" | "host" | "port">): string {
  if (f.host === "") return "—"; // a bypassed command whose URL could not be parsed
  return f.proto === "tunnel" ? `${f.host}:${f.port}` : f.host;
}

/** `encrypted · 1.2KB ↑ 45.5KB ↓` — what a tunnel's Path cell says instead of a path it never saw. */
export function tunnelBytes(f: Pick<FlowSummary, "reqBytes" | "resBytes">): string {
  return `${formatSize(f.reqBytes)} ↑ ${formatSize(f.resBytes)} ↓`;
}

/** A tunnel never saw a path, so it shows what it did see: `encrypted · n ↑ m ↓` (`—` if it failed
 * to connect; the error is in Type). A bypassed command shows its parsed path, else the command;
 * `—` for an empty path. */
export function pathCell(
  f: Pick<FlowSummary, "proto" | "path"> & Partial<Pick<FlowSummary, "reqBytes" | "resBytes" | "bypass" | "state">>,
): string {
  if (f.proto === "tunnel" && f.state === "error") return "—";
  if (f.proto === "tunnel") return `encrypted · ${tunnelBytes({ reqBytes: f.reqBytes ?? 0, resBytes: f.resBytes ?? 0 })}`;
  if (f.proto === "bypass" && f.path === "") return f.bypass?.command ?? "—";
  return f.path === "" ? "—" : f.path;
}

/** The Status cell's text — a tunnel's is its state (`open` / `closed` / `failed`), never `—`. */
export function statusCell(f: Pick<FlowSummary, "status" | "state" | "grpcStatus"> & WithProto & WithBypass): string {
  // Neutralised: the curl shim ran it through the proxy anyway — its request is its own row.
  if (f.proto === "bypass") return f.bypass?.neutralized === true ? "via proxy" : "not captured";
  if (f.proto === "tunnel") return f.state === "pending" ? "open" : f.state === "done" ? "closed" : "failed";
  if (f.status === null) return f.state === "pending" ? "…" : "—";
  if (f.grpcStatus !== null && f.grpcStatus !== 0) return `${f.status} g${f.grpcStatus}`;
  return String(f.status);
}

/** A non-zero gRPC status is a failed call even under an HTTP 200. */
export function grpcFailed(f: Pick<FlowSummary, "grpcStatus">): boolean {
  return f.grpcStatus !== null && f.grpcStatus !== 0;
}

export type TypeCell =
  | { kind: "error"; text: string }
  | { kind: "type"; text: string }
  | { kind: "dim"; text: string }
  | { kind: "note"; text: string };

/** The error (red) on an error row; else the proxy's note, dimmed; else the media type without
 * params. */
export function typeCell(f: Pick<FlowSummary, "state" | "error" | "contentType" | "proto" | "note">): TypeCell {
  if (f.error !== null) return { kind: "error", text: f.error };
  if (f.note !== null && f.note !== "") return { kind: "note", text: f.note };
  if (f.proto === "bypass") return { kind: "note", text: "skipped the IDE proxy" };
  if (f.state === "pending") return { kind: "dim", text: "…" };
  if (f.proto === "tunnel") return { kind: "dim", text: "[encrypted]" };
  if (f.contentType !== null && f.contentType.trim() !== "") {
    return { kind: "type", text: f.contentType.split(";")[0].trim() };
  }
  // Proxelar's wording: no content-type is `[no content]`, even with bytes (its table reads
  // `502 [no content] 11B`) — the Size column already says how much came back.
  return { kind: "dim", text: "[no content]" };
}

/** The response size; for a tunnel each direction (`↑1.2K ↓45K`: up vs back is most of what a
 * tunnel can tell); `—` for a bypassed command (nothing went through the proxy). */
export function sizeCell(f: Pick<FlowSummary, "proto" | "reqBytes" | "resBytes">): string {
  if (f.proto === "bypass") return "—";
  if (f.proto === "tunnel") return `↑${formatSizeShort(f.reqBytes)} ↓${formatSizeShort(f.resBytes)}`;
  return formatSize(f.resBytes);
}

/** The Process cell: the client executable's name, or `—` when the proxy could not resolve it. */
export function processCell(f: Pick<FlowSummary, "client">): { text: string; title: string; known: boolean } {
  const c = f.client;
  if (c === null) return { text: "—", title: "The proxy could not tell which process opened this connection.", known: false };
  return { text: c.name, title: `${c.path ?? c.name} · pid ${c.pid}`, known: true };
}

/** "tls rejected → passthrough": the client refused the IDE's certificate. */
export function isTlsRejected(f: Pick<FlowSummary, "error">): boolean {
  return f.error !== null && f.error.startsWith("tls rejected");
}

/** Who made the call, in a sentence: the client's name, or a neutral subject. */
export function clientName(f: Pick<FlowSummary, "client">): string {
  return f.client?.name ?? "The client";
}
