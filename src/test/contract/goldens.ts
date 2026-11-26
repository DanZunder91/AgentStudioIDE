/** Typed goldens, written by Rust (`src-tauri/tests/contract_goldens.rs`); casts are checked by
 * `wireShape.test.ts`. Never hand-edit; regenerate and read the diff:
 * `UPDATE_GOLDENS=1 cargo test --manifest-path src-tauri/Cargo.toml --test contract_goldens` */

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

/** Found by the reserved terminalId `ide-api-client`: Rust picks the key. Undefined if absent, and
 * the test that needs it skips BY NAME. Once the key is fixed, add it to `FlowScenario` and
 * wireShape's key list. */
export function apiClientScenario(): FlowDetail | undefined {
  return Object.values(FLOWS).find((d) => d.summary.terminalId === "ide-api-client");
}
