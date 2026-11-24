/**
 * The contract goldens, typed — the TS half of the seam test.
 *
 * The JSON files in `./goldens/` are WRITTEN BY RUST (`src-tauri/tests/contract_goldens.rs`;
 * the whole-computer ones — `syslog-*`, `netmachine-*` — by its `contract_goldens/machine.rs` module)
 * from values produced by the real production code — a real capture proxy on loopback, the
 * real supervisor over real PTYs, the real transcript parser — and serialised exactly as
 * Tauri serialises them. The Rust test fails on any drift from these files; the tests next
 * to this one feed the very same files through the real TS stores and panels. So a value
 * only one side agrees on turns one side red.
 *
 * Never hand-edit a golden. Regenerate from Rust and read the diff:
 *   UPDATE_GOLDENS=1 cargo test --manifest-path src-tauri/Cargo.toml --test contract_goldens
 *
 * The casts below are checked, not trusted: `wireShape.test.ts` asserts every key and
 * every value's JSON type against the TS interfaces, both directions.
 */

import type { LogLine, RunningApp, SyslogStatus } from "../../features/agentlogs/agentLogsTypes";
import type {
  FlowDetail,
  FlowSummary,
  MachineSample,
  MachineStatus,
  NetcapStatus,
} from "../../features/network/networkTypes";
import flowsJson from "./goldens/netcap-flows.json";
import statusJson from "./goldens/netcap-status.json";
import summariesJson from "./goldens/netcap-summaries.json";
import linesJson from "./goldens/logstream-lines.json";
import machineSamplesJson from "./goldens/netmachine-samples.json";
import machineStatusJson from "./goldens/netmachine-status.json";
import syslogAppsJson from "./goldens/syslog-apps.json";
import syslogLinesJson from "./goldens/syslog-lines.json";
import syslogStatusJson from "./goldens/syslog-status.json";

export type FlowScenario =
  | "http-json-gzip-credentials"
  | "http-binary-base64"
  | "http-truncated-request"
  | "ws-echo"
  | "tunnel"
  | "upstream-refused"
  | "https-decrypted-json"
  | "grpc-trailers"
  | "tls-rejected"
  | "tunnel-not-decrypted"
  | "ide-api-client";

export type StatusScenario = "default" | "decrypt-passthrough" | "skipped-with-ca" | "stopped" | "port-changed-app-decrypt";
export type SummaryScenario = "http-pending" | "ws-live" | "bypass-curl-neutralized" | "bypass-python";

/* Whole computer — written by `src-tauri/tests/contract_goldens/machine.rs`. */
export type SyslogStatusState =
  | "macos-running-picked"
  | "macos-all-apps"
  | "macos-child-exited"
  | "macos-simulator-streaming"
  | "macos-simulator-exited"
  | "linux-partial"
  | "linux-no-journald"
  | "other-os-unavailable"
  | "windows-eventlog";
export type MachineSampleScenario =
  | "macos-first"
  | "macos-second"
  | "linux-first"
  | "linux-second"
  | "linux-no-ss"
  | "windows-first";
export type MachineStatusState =
  | "macos-idle"
  | "macos-running"
  | "macos-died"
  | "macos-nettop-missing"
  | "linux-partial-running"
  | "linux-no-ss"
  | "windows-idle"
  | "windows-running"
  | "other-os-unavailable";

/** Raw, untyped — for the structural check. */
export const RAW = {
  flows: flowsJson as unknown,
  status: statusJson as unknown,
  summaries: summariesJson as unknown,
  lines: linesJson as unknown,
  syslogLines: syslogLinesJson as unknown,
  syslogStatus: syslogStatusJson as unknown,
  syslogApps: syslogAppsJson as unknown,
  machineSamples: machineSamplesJson as unknown,
  machineStatus: machineStatusJson as unknown,
};

export const FLOWS = flowsJson as unknown as Record<FlowScenario, FlowDetail>;
export const STATUS = statusJson as unknown as Record<StatusScenario, NetcapStatus>;
export const SUMMARIES = summariesJson as unknown as Record<SummaryScenario, FlowSummary>;
export const LINES = linesJson as unknown as LogLine[];
export const SYSLOG_LINES = syslogLinesJson as unknown as LogLine[];
export const SYSLOG_STATUS = syslogStatusJson as unknown as Record<SyslogStatusState, SyslogStatus>;
export const SYSLOG_APPS = syslogAppsJson as unknown as RunningApp[];
export const MACHINE_SAMPLES = machineSamplesJson as unknown as Record<MachineSampleScenario, MachineSample>;
export const MACHINE_STATUS = machineStatusJson as unknown as Record<MachineStatusState, MachineStatus>;

/** What `netcap_snapshot` would answer after the Rust scenario ran: every summary, oldest first. */
export function snapshotOfFlows(): FlowSummary[] {
  return Object.values(FLOWS)
    .map((d) => d.summary)
    .sort((a, b) => a.id - b.id);
}

/** What `netcap_flow({ id })` answers, or the command's own `not-found` rejection. */
export function flowById(id: number): FlowDetail {
  const d = Object.values(FLOWS).find((f) => f.summary.id === id);
  if (!d) throw new Error("not-found");
  return d;
}

/**
 * The API-client scenario (`netcap::record`, terminalId `ide-api-client`) — found by that
 * reserved id rather than by a key, because the Rust side picks the key. Undefined if the golden
 * lacks it; the contract test that needs it then skips BY NAME, never silently. Once it has a
 * fixed key: add it to `FlowScenario` and to wireShape's key list. Its values are hand-pinned
 * in network.contract.test.tsx.
 */
export function apiClientScenario(): FlowDetail | undefined {
  return Object.values(FLOWS).find((d) => d.summary.terminalId === "ide-api-client");
}
