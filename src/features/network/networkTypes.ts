/**
 * The capture proxy's wire types — an exact mirror of `netcap::*` (serde camelCase).
 * Change the Rust side and this mirror together; the contract tests pin both.
 */

/**
 * `bypass` is not traffic the proxy saw: an agent command that skipped it (`curl --noproxy`,
 * `NO_PROXY=*`), recorded from the command itself — see {@link BypassInfo}.
 */
export type FlowProto = "http" | "https" | "ws" | "wss" | "grpc" | "tunnel" | "bypass";
export type FlowState = "pending" | "done" | "error";

export interface FlowSummary {
  /** Monotonic per app run. */
  id: number;
  /** Unix ms. */
  startedMs: number;
  proto: FlowProto;
  /** "GET"… ; "CONNECT" for a tunnel. */
  method: string;
  host: string;
  port: number;
  /** "" for a tunnel; "/pkg.Svc/Method" for gRPC. */
  path: string;
  /** HTTP status; null while pending / for a tunnel. */
  status: number | null;
  grpcStatus: number | null;
  /** Response content-type. */
  contentType: string | null;
  reqBytes: number;
  resBytes: number;
  /** Null while pending. */
  durationMs: number | null;
  state: FlowState;
  /** e.g. "tls rejected → passthrough", "upstream: connection refused". */
  error: string | null;
  /** From the proxy userinfo; null = unattributed. */
  terminalId: string | null;
  /** "HTTP/1.1" | "HTTP/2" | "". */
  httpVersion: string;
  wsMessages: { up: number; down: number } | null;
  /**
   * The process on the other end of the proxy socket — resolved from
   * the accepted socket's pid. Null = could not resolve.
   */
  client: FlowClient | null;
  /**
   * Why the proxy did what it did with this flow, in words — e.g.
   * "not decrypted: gazelle doesn't read the IDE's CA". Null = nothing to explain.
   */
  note: string | null;
  /**
   * Only on a `proto: "bypass"` row (Rust omits the key otherwise, so it is optional here):
   * the command that skipped the proxy, and what could be parsed from it.
   */
  bypass?: BypassInfo | null;
}

/**
 * An agent command that bypassed the capture proxy (`netcap::types::BypassInfo`). `method` /
 * `url` are parsed from a `curl` command line; null when it was not one or could not be read.
 */
export interface BypassInfo {
  /** Verbatim, as the agent ran it. */
  command: string;
  method?: string | null;
  url?: string | null;
  /*
   * Rust always sends these four on a bypass row; optional here
   * only so hand-written UI fixtures may leave them out.
   */
  /** The agent whose transcript held the command; the row's `terminalId` is its root terminal. */
  agentId?: string | null;
  /** The transcript's `tool_use.id` — the same id as the Agent Logs line (`LogLine.toolUseId`). */
  toolUseId?: string | null;
  /**
   * What bypassed, in command order: "--noproxy", "-x ''", "NO_PROXY=*", "NO_PROXY=",
   * "*_PROXY=''", "unset *_proxy", "env -u *_proxy", "env -i", "--no-proxy".
   */
  reasons?: string[];
  /**
   * True = the IDE's curl shim undid it (strict agent capture on, every reason a curl's own):
   * the request itself IS captured as a normal row. False = it really was not captured.
   */
  neutralized?: boolean;
}

/** The client process of one flow. */
export interface FlowClient {
  pid: number;
  /** Executable name, e.g. "gazelle", "node". */
  name: string;
  /** Full executable path; null when unreadable. */
  path: string | null;
}

export interface FlowBody {
  size: number;
  truncated: boolean;
  text: string | null;
  base64: string | null;
}

export interface FlowDetail {
  summary: FlowSummary;
  /** Exactly as captured — nothing is redacted. */
  requestHeaders: [string, string][];
  /** Exactly as captured — nothing is redacted. */
  responseHeaders: [string, string][];
  responseTrailers: [string, string][];
  requestBody: FlowBody | null;
  /** Decoded (gzip/br/deflate) when possible. */
  responseBody: FlowBody | null;
}

export interface NetcapStatus {
  running: boolean;
  port: number | null;
  enabled: boolean;
  decrypt: boolean;
  caPath: string | null;
  /** e.g. "HTTPS_PROXY already set in your environment". */
  skippedReason: string | null;
  passthroughHosts: string[];
  flowCount: number;
  /**
   * Apps the user opted in to HTTPS decryption from the capture guide: the
   * `.app` bundle name for a bundled app, else the executable name. Persisted by Rust.
   */
  decryptApps: string[];
  /**
   * Set when the persisted proxy port was taken at startup and a new one was bound — every app
   * configured by hand still points at `from`. Null otherwise.
   */
  portChanged: { from: number; to: number } | null;
  /**
   * "Capture agent curls even with --noproxy": the agent's `curl` is captured even when the
   * command bypasses the proxy (the curl shim's pref). Optional: a Rust side that does not
   * report it yet leaves the switch explained and disabled rather than guessing.
   */
  strictAgentCapture?: boolean;
}

/** `netcap_set`'s argument — only the keys present are changed. */
export interface NetcapPatch {
  enabled?: boolean;
  decrypt?: boolean;
  strictAgentCapture?: boolean;
}

/* ── Whole computer — an exact mirror of `netmachine::*` ─────────────────────────── */

export type MachineProto = "tcp4" | "tcp6" | "udp4" | "udp6";

export interface MachineConn {
  proto: MachineProto;
  /** "10.0.0.5:50000" / "[::1]:8000". */
  local: string;
  /** Null for a listener / unconnected UDP. */
  remote: string | null;
  /** Reverse DNS, cached; null until resolved or when none. */
  remoteHost: string | null;
  /** "Established", "Listen", "SynSent", … ("" for UDP). */
  state: string;
  /** Null when the backend cannot see bytes. */
  bytesIn: number | null;
  bytesOut: number | null;
  /** Bytes/s over the last sample. */
  rateIn: number | null;
  rateOut: number | null;
}

export interface MachineApp {
  /** `${name}:${pid}`. */
  key: string;
  name: string;
  /** 0 = unknown (Linux: another user's socket). */
  pid: number;
  user: "self" | "other" | null;
  bytesIn: number | null;
  bytesOut: number | null;
  rateIn: number | null;
  rateOut: number | null;
  connections: MachineConn[];
}

export interface MachineSample {
  tsMs: number;
  apps: MachineApp[];
}

export type MachineBackend = "macos-nettop" | "linux-proc" | "windows-iphlpapi";

export interface MachineStatus {
  available: boolean;
  backend: MachineBackend | null;
  /** Unavailable, or partial ("other users' sockets have no process…"). */
  reason: string | null;
  running: boolean;
  hasBytes: boolean;
}
