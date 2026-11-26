/** Both directions: SHAPE tables typed `Record<keyof T, Json>` cannot drift from the TS types, and
 * each Rust-written golden object must have exactly their keys and JSON types; union spellings
 * must be in the exhaustive TS list. Expectations are written by hand, never from the goldens. */

import { describe, expect, it } from "vitest";

import type {
  LogKind,
  LogLevel,
  LogLine,
  RunningApp,
  SyslogBackend,
  SyslogFilter,
  SyslogLevel,
  SyslogStatus,
} from "../../features/agentlogs/agentLogsTypes";
import type {
  BypassInfo,
  FlowBody,
  FlowClient,
  FlowDetail,
  FlowProto,
  FlowState,
  FlowSummary,
  MachineApp,
  MachineBackend,
  MachineConn,
  MachineProto,
  MachineSample,
  MachineStatus,
  NetcapStatus,
} from "../../features/network/networkTypes";
import { RAW } from "./goldens";

type Json =
  | "number"
  | "string"
  | "boolean"
  | "object"
  | "array"
  | "number|null"
  | "string|null"
  | "object|null"
  | "array|null"
  // An OPTIONAL key: Rust omits it (`skip_serializing_if`) on most payloads.
  | "object|null|absent"
  | "boolean|absent";

type WsCounts = NonNullable<FlowSummary["wsMessages"]>;

const FLOW_SUMMARY: Record<keyof FlowSummary, Json> = {
  id: "number",
  startedMs: "number",
  proto: "string",
  method: "string",
  host: "string",
  port: "number",
  path: "string",
  status: "number|null",
  grpcStatus: "number|null",
  contentType: "string|null",
  reqBytes: "number",
  resBytes: "number",
  durationMs: "number|null",
  state: "string",
  error: "string|null",
  terminalId: "string|null",
  httpVersion: "string",
  wsMessages: "object|null",
  client: "object|null",
  note: "string|null",
  // Only on a `bypass` row (`netcap::types::BypassInfo`); omitted on every proxied flow.
  bypass: "object|null|absent",
};

/** `FlowSummary.bypass` — `method` / `url` are `Option` in Rust, so always present (maybe null). */
const BYPASS_INFO: Record<keyof BypassInfo, Json> = {
  command: "string",
  method: "string|null",
  url: "string|null",
  // The agent-attribution fields: who ran it, which transcript call, what bypassed, and
  // whether the shim undid it.
  agentId: "string|null",
  toolUseId: "string|null",
  reasons: "array",
  neutralized: "boolean",
};

/** `FlowSummary.client` — checked whenever a golden has one. */
const FLOW_CLIENT: Record<keyof FlowClient, Json> = { pid: "number", name: "string", path: "string|null" };

const WS_COUNTS: Record<keyof WsCounts, Json> = { up: "number", down: "number" };

const FLOW_BODY: Record<keyof FlowBody, Json> = {
  size: "number",
  truncated: "boolean",
  text: "string|null",
  base64: "string|null",
};

const FLOW_DETAIL: Record<keyof FlowDetail, Json> = {
  summary: "object",
  requestHeaders: "array",
  responseHeaders: "array",
  responseTrailers: "array",
  requestBody: "object|null",
  responseBody: "object|null",
};

const NETCAP_STATUS: Record<keyof NetcapStatus, Json> = {
  running: "boolean",
  port: "number|null",
  enabled: "boolean",
  decrypt: "boolean",
  caPath: "string|null",
  skippedReason: "string|null",
  passthroughHosts: "array",
  flowCount: "number",
  // The per-app decrypt opt-ins, and the moved-port notice.
  decryptApps: "array",
  portChanged: "object|null",
  // The "Capture agent curls even with --noproxy" pref — optional until Rust reports it.
  strictAgentCapture: "boolean|absent",
};

/** `NetcapStatus.portChanged` — checked whenever a golden has one. */
const PORT_CHANGED: Record<keyof NonNullable<NetcapStatus["portChanged"]>, Json> = { from: "number", to: "number" };

const LOG_LINE: Record<keyof LogLine, Json> = {
  id: "number",
  tsMs: "number",
  terminalId: "string|null",
  agentId: "string|null",
  source: "string",
  kind: "string",
  level: "string",
  text: "string",
  detail: "string|null",
  // The transcript's tool_use id on `tool` / `tool-result` lines, null elsewhere.
  toolUseId: "string|null",
};

/* ── system-app logs, whole-computer network ── */

const SYSLOG_FILTER: Record<keyof SyslogFilter, Json> = {
  enabled: "boolean",
  apps: "array|null",
  subsystem: "string|null",
  minLevel: "string",
  simulator: "boolean",
  simulatorApps: "array|null",
};

type SimulatorStatus = SyslogStatus["simulator"];
const SIMULATOR_STATUS: Record<keyof SimulatorStatus, Json> = {
  available: "boolean",
  reason: "string|null",
  running: "boolean",
};

const SYSLOG_STATUS: Record<keyof SyslogStatus, Json> = {
  available: "boolean",
  backend: "string|null",
  reason: "string|null",
  running: "boolean",
  filter: "object",
  simulator: "object",
  linesPerSec: "number",
  droppedPerSec: "number",
};

const RUNNING_APP: Record<keyof RunningApp, Json> = {
  name: "string",
  pids: "array",
  path: "string|null",
  isApp: "boolean",
};

const MACHINE_CONN: Record<keyof MachineConn, Json> = {
  proto: "string",
  local: "string",
  remote: "string|null",
  remoteHost: "string|null",
  state: "string",
  bytesIn: "number|null",
  bytesOut: "number|null",
  rateIn: "number|null",
  rateOut: "number|null",
};

const MACHINE_APP: Record<keyof MachineApp, Json> = {
  key: "string",
  name: "string",
  pid: "number",
  user: "string|null",
  bytesIn: "number|null",
  bytesOut: "number|null",
  rateIn: "number|null",
  rateOut: "number|null",
  connections: "array",
};

const MACHINE_SAMPLE: Record<keyof MachineSample, Json> = { tsMs: "number", apps: "array" };

const MACHINE_STATUS: Record<keyof MachineStatus, Json> = {
  available: "boolean",
  backend: "string|null",
  reason: "string|null",
  running: "boolean",
  hasBytes: "boolean",
};

/** Exhaustive by construction: `Record<Union, true>` fails to compile if a member is missing or extra. */
const PROTOS: Record<FlowProto, true> = { http: true, https: true, ws: true, wss: true, grpc: true, tunnel: true, bypass: true };
const STATES: Record<FlowState, true> = { pending: true, done: true, error: true };
const LEVELS: Record<LogLevel, true> = { error: true, warn: true, info: true, debug: true };
const KINDS: Record<LogKind, true> = { output: true, tool: true, "tool-result": true, system: true, machine: true, task: true, app: true };
const SYSLOG_LEVELS: Record<SyslogLevel, true> = { debug: true, info: true, default: true, error: true };
const SYSLOG_BACKENDS: Record<SyslogBackend, true> = { "macos-unified-log": true, "linux-journald": true, "windows-eventlog": true };
const MACHINE_PROTOS: Record<MachineProto, true> = { tcp4: true, tcp6: true, udp4: true, udp6: true };
const MACHINE_BACKENDS: Record<MachineBackend, true> = { "macos-nettop": true, "linux-proc": true, "windows-iphlpapi": true };
const MACHINE_USERS: Record<NonNullable<MachineApp["user"]>, true> = { self: true, other: true };

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** The failures for one object against one table, as readable lines (empty = conforms). */
function conform(where: string, value: unknown, shape: Record<string, Json>): string[] {
  if (jsonType(value) !== "object") return [`${where}: expected an object, got ${jsonType(value)}`];
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) out.push(`${where}.${key}: Rust sends it, the TS type does not declare it`);
  }
  for (const [key, want] of Object.entries(shape)) {
    if (!(key in obj)) {
      if (!want.endsWith("|absent")) out.push(`${where}.${key}: the TS type declares it, Rust never sends it`);
      continue;
    }
    const got = jsonType(obj[key]);
    if (!want.split("|").includes(got)) out.push(`${where}.${key}: expected ${want}, got ${got}`);
  }
  return out;
}

function conformSummary(where: string, s: unknown): string[] {
  const out = conform(where, s, FLOW_SUMMARY);
  const o = s as Record<string, unknown>;
  if (o.wsMessages !== null && o.wsMessages !== undefined) out.push(...conform(`${where}.wsMessages`, o.wsMessages, WS_COUNTS));
  if (o.client !== null && o.client !== undefined) out.push(...conform(`${where}.client`, o.client, FLOW_CLIENT));
  if (o.bypass !== null && o.bypass !== undefined) out.push(...conform(`${where}.bypass`, o.bypass, BYPASS_INFO));
  if (!(String(o.proto) in PROTOS)) out.push(`${where}.proto: "${String(o.proto)}" is not a FlowProto`);
  if (!(String(o.state) in STATES)) out.push(`${where}.state: "${String(o.state)}" is not a FlowState`);
  return out;
}

function conformPairs(where: string, pairs: unknown): string[] {
  const out: string[] = [];
  (pairs as unknown[]).forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") {
      out.push(`${where}[${i}]: expected a [string, string] pair, got ${JSON.stringify(p)}`);
    }
  });
  return out;
}

const entries = (v: unknown): [string, unknown][] => Object.entries(v as Record<string, unknown>);

describe("contract goldens conform to the TS wire types, key for key", () => {
  it("FlowDetail (netcap_flow) — and its summary, bodies, header pairs", () => {
    const failures: string[] = [];
    for (const [name, d] of entries(RAW.flows)) {
      failures.push(...conform(name, d, FLOW_DETAIL));
      const o = d as Record<string, unknown>;
      failures.push(...conformSummary(`${name}.summary`, o.summary));
      for (const side of ["requestBody", "responseBody"] as const) {
        if (o[side] !== null) failures.push(...conform(`${name}.${side}`, o[side], FLOW_BODY));
      }
      for (const h of ["requestHeaders", "responseHeaders", "responseTrailers"] as const) {
        failures.push(...conformPairs(`${name}.${h}`, o[h]));
      }
    }
    expect(failures).toEqual([]);
    // Coverage of the golden itself: the scenarios the other contract tests rely on exist.
    expect(Object.keys(RAW.flows as object).sort()).toEqual([
      "grpc-trailers",
      "http-binary-base64",
      "http-json-gzip-credentials",
      "http-truncated-request",
      "https-decrypted-json",
      "ide-api-client",
      "tls-rejected",
      "tunnel",
      "tunnel-not-decrypted",
      "upstream-refused",
      "ws-echo",
    ]);
  });

  it("FlowSummary (netcap://flow events, pending rows)", () => {
    const failures = entries(RAW.summaries).flatMap(([name, s]) => conformSummary(name, s));
    expect(failures).toEqual([]);
  });

  it("a bypass row — the JSON `netcap::types` tests pin for `FlowSummary::bypassed` — conforms, and a wrong one does not", () => {
    // Verbatim from `a_bypass_row_carries_the_command_and_its_parsed_request` (types.rs); no
    // proxy scenario produces one, so it has no golden.
    const row = {
      id: 7, startedMs: 1, proto: "bypass", method: "POST", host: "api.example.com", port: 8443, path: "/v1/items?x=1",
      status: null, grpcStatus: null, contentType: null, reqBytes: 0, resBytes: 0, durationMs: null, state: "done",
      error: null, terminalId: "t1", httpVersion: "", wsMessages: null, client: null, note: null,
      bypass: {
        command: "curl --noproxy '*' -X POST https://api.example.com:8443/v1/items?x=1", method: "POST", url: "https://api.example.com:8443/v1/items?x=1",
        agentId: null, toolUseId: null, reasons: [], neutralized: false,
      },
    };
    expect(conformSummary("bypass", row)).toEqual([]);
    expect(conformSummary("bad", { ...row, bypass: { command: 1 } })).toEqual([
      "bad.bypass.command: expected string, got number",
      "bad.bypass.method: the TS type declares it, Rust never sends it",
      "bad.bypass.url: the TS type declares it, Rust never sends it",
      "bad.bypass.agentId: the TS type declares it, Rust never sends it",
      "bad.bypass.toolUseId: the TS type declares it, Rust never sends it",
      "bad.bypass.reasons: the TS type declares it, Rust never sends it",
      "bad.bypass.neutralized: the TS type declares it, Rust never sends it",
    ]);
  });

  it("bypass rows from the real detector → record_bypass (netcap-summaries.json) conform, with every reason a string", () => {
    const rows = entries(RAW.summaries).filter(([, s]) => (s as { proto: string }).proto === "bypass");
    expect(rows.map(([name]) => name).sort()).toEqual(["bypass-curl-neutralized", "bypass-python"]);
    for (const [name, s] of rows) {
      const b = (s as { bypass: { reasons: unknown[] } }).bypass;
      expect(conformSummary(name, s)).toEqual([]);
      expect(b.reasons.every((r) => typeof r === "string")).toBe(true);
    }
    const curl = (RAW.summaries as Record<string, FlowSummary>)["bypass-curl-neutralized"];
    expect(curl.bypass).toEqual({
      command: "curl -s --noproxy '*' http://127.0.0.1:3000/api/v1/health | head -c 300",
      method: "GET",
      url: "http://127.0.0.1:3000/api/v1/health",
      agentId: "agent-gazelle",
      toolUseId: "toolu_01GazelleHealth",
      reasons: ["--noproxy"],
      neutralized: true,
    });
    expect([curl.host, curl.port, curl.path, curl.terminalId]).toEqual(["127.0.0.1", 3000, "/api/v1/health", "term-gazelle"]);
    const py = (RAW.summaries as Record<string, FlowSummary>)["bypass-python"];
    expect([py.bypass?.neutralized, py.bypass?.reasons, py.bypass?.url, py.host]).toEqual([false, ["NO_PROXY=*"], null, ""]);
  });

  it("NetcapStatus (netcap_status / netcap_set)", () => {
    const failures = entries(RAW.status).flatMap(([name, s]) => {
      const out = conform(name, s, NETCAP_STATUS);
      const hosts = (s as { passthroughHosts: unknown[] }).passthroughHosts;
      if (!hosts.every((h) => typeof h === "string")) out.push(`${name}.passthroughHosts: not all strings`);
      const o = s as { decryptApps?: unknown; portChanged?: unknown };
      if (Array.isArray(o.decryptApps) && !o.decryptApps.every((a) => typeof a === "string")) {
        out.push(`${name}.decryptApps: not all strings`);
      }
      if (o.portChanged !== null && typeof o.portChanged === "object") out.push(...conform(`${name}.portChanged`, o.portChanged, PORT_CHANGED));
      return out;
    });
    expect(failures).toEqual([]);
  });

  it("LogLine (logstream_snapshot / logstream://lines) — every kind and level is a TS union member", () => {
    const failures = (RAW.lines as unknown[]).flatMap((l, i) => {
      const out = conform(`lines[${i}]`, l, LOG_LINE);
      const o = l as Record<string, unknown>;
      if (!(String(o.kind) in KINDS)) out.push(`lines[${i}].kind: "${String(o.kind)}" is not a LogKind`);
      if (!(String(o.level) in LEVELS)) out.push(`lines[${i}].level: "${String(o.level)}" is not a LogLevel`);
      return out;
    });
    expect(failures).toEqual([]);
    // The golden exercises every IDE-side kind (including the background `task`) and every level
    // (so the checks above bite). `machine` lines have their own golden: syslog-lines.json.
    const lines = RAW.lines as LogLine[];
    expect([...new Set(lines.map((l) => l.kind))].sort()).toEqual(["output", "system", "task", "tool", "tool-result"]);
    expect([...new Set(lines.map((l) => l.level))].sort()).toEqual(["debug", "error", "info", "warn"]);
  });

  it("LogLine with kind `machine` (system-app lines + the hub's rate-limit line)", () => {
    const failures = (RAW.syslogLines as unknown[]).flatMap((l, i) => {
      const out = conform(`syslogLines[${i}]`, l, LOG_LINE);
      const o = l as Record<string, unknown>;
      if (!(String(o.kind) in KINDS)) out.push(`syslogLines[${i}].kind: "${String(o.kind)}" is not a LogKind`);
      if (!(String(o.level) in LEVELS)) out.push(`syslogLines[${i}].level: "${String(o.level)}" is not a LogLevel`);
      return out;
    });
    expect(failures).toEqual([]);
    const lines = RAW.syslogLines as LogLine[];
    expect([...new Set(lines.map((l) => l.kind))].sort()).toEqual(["machine", "system"]);
    expect([...new Set(lines.map((l) => l.level))].sort()).toEqual(["debug", "error", "info", "warn"]);
    // A system app's line is never attributed to an IDE terminal or agent.
    expect(lines.filter((l) => l.kind === "machine").every((l) => l.terminalId === null && l.agentId === null)).toBe(true);
  });

  it("SyslogStatus (syslog_status / syslog_set) — its filter, simulator block and enums", () => {
    const failures = entries(RAW.syslogStatus).flatMap(([name, s]) => {
      const out = conform(name, s, SYSLOG_STATUS);
      const o = s as Record<string, unknown>;
      out.push(...conform(`${name}.filter`, o.filter, SYSLOG_FILTER));
      out.push(...conform(`${name}.simulator`, o.simulator, SIMULATOR_STATUS));
      if (o.backend !== null && !(String(o.backend) in SYSLOG_BACKENDS)) out.push(`${name}.backend: "${String(o.backend)}" is not a SyslogBackend`);
      const f = o.filter as Record<string, unknown>;
      if (!(String(f.minLevel) in SYSLOG_LEVELS)) out.push(`${name}.filter.minLevel: "${String(f.minLevel)}" is not a SyslogLevel`);
      for (const k of ["apps", "simulatorApps"] as const) {
        const list = f[k];
        if (Array.isArray(list) && !list.every((x) => typeof x === "string")) out.push(`${name}.filter.${k}: not all strings`);
      }
      return out;
    });
    expect(failures).toEqual([]);
    const all = Object.values(RAW.syslogStatus as Record<string, SyslogStatus>);
    // Every backend and the null one are exercised, so the enum check bites.
    expect([...new Set(all.map((s) => String(s.backend)))].sort()).toEqual(["linux-journald", "macos-unified-log", "null", "windows-eventlog"]);
  });

  it("RunningApp[] (syslog_apps)", () => {
    const failures = (RAW.syslogApps as unknown[]).flatMap((a, i) => {
      const out = conform(`apps[${i}]`, a, RUNNING_APP);
      const pids = (a as { pids: unknown[] }).pids;
      if (!pids.every((p) => typeof p === "number")) out.push(`apps[${i}].pids: not all numbers`);
      return out;
    });
    expect(failures).toEqual([]);
  });

  it("MachineSample (netmachine://sample) — apps, connections, protos, users", () => {
    const failures = entries(RAW.machineSamples).flatMap(([name, s]) => {
      const out = conform(name, s, MACHINE_SAMPLE);
      (s as MachineSample).apps.forEach((a, i) => {
        const w = `${name}.apps[${i}]`;
        out.push(...conform(w, a, MACHINE_APP));
        if (a.user !== null && !(String(a.user) in MACHINE_USERS)) out.push(`${w}.user: "${String(a.user)}" is not self|other`);
        a.connections.forEach((c, j) => {
          out.push(...conform(`${w}.connections[${j}]`, c, MACHINE_CONN));
          if (!(String(c.proto) in MACHINE_PROTOS)) out.push(`${w}.connections[${j}].proto: "${String(c.proto)}" is not a MachineProto`);
        });
      });
      return out;
    });
    expect(failures).toEqual([]);
    const all = Object.values(RAW.machineSamples as Record<string, MachineSample>);
    const conns = all.flatMap((s) => s.apps.flatMap((a) => a.connections));
    expect([...new Set(conns.map((c) => c.proto))].sort()).toEqual(["tcp4", "tcp6", "udp4", "udp6"]);
    expect([...new Set(all.flatMap((s) => s.apps.map((a) => String(a.user))))].sort()).toEqual(["null", "other", "self"]);
  });

  it("MachineStatus (netmachine_status / _start / _stop)", () => {
    const failures = entries(RAW.machineStatus).flatMap(([name, s]) => {
      const out = conform(name, s, MACHINE_STATUS);
      const b = (s as MachineStatus).backend;
      if (b !== null && !(String(b) in MACHINE_BACKENDS)) out.push(`${name}.backend: "${String(b)}" is not a MachineBackend`);
      return out;
    });
    expect(failures).toEqual([]);
    const all = Object.values(RAW.machineStatus as Record<string, MachineStatus>);
    expect([...new Set(all.map((s) => String(s.backend)))].sort()).toEqual(["linux-proc", "macos-nettop", "null", "windows-iphlpapi"]);
  });

  it("the checker itself reports an extra key, a missing key and a wrong type (so a green run means something)", () => {
    const bad = { id: 1, tsMs: "x", terminalId: null, agentId: null, source: "s", kind: "tool", level: "info", text: "t", toolUseId: null, extra: 1 };
    expect(conform("l", bad, LOG_LINE)).toEqual([
      "l.extra: Rust sends it, the TS type does not declare it",
      "l.tsMs: expected number, got string",
      "l.detail: the TS type declares it, Rust never sends it",
    ]);
    expect(conformPairs("h", [["a", "b"], ["c"]])).toEqual(['h[1]: expected a [string, string] pair, got ["c"]']);
  });
});
