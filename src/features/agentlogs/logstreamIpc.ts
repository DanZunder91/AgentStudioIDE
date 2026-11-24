/**
 * Agent Logs IPC — the ONE `invoke`/`listen` seam for the feature.
 *
 * Feature-local (not `app/ipc.ts`) so the wire types live next to their feature. Tests mock
 * exactly this module's two Tauri imports and nothing else.
 *
 * Neither command swallows: a failed snapshot is information the panel shows
 * ("could not read the log stream"), so the rejection passes through to the store.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  LOGSTREAM_CLEAR,
  LOGSTREAM_LINES_EVENT,
  LOGSTREAM_SNAPSHOT,
  SYSLOG_APPS,
  SYSLOG_SET,
  SYSLOG_STATUS,
  type LogLine,
  type RunningApp,
  type SyslogFilter,
  type SyslogStatus,
} from "./agentLogsTypes";

/** `logstream_snapshot` — the whole Rust ring (≤ 20 000 lines), oldest first. */
export function logstreamSnapshot(): Promise<LogLine[]> {
  return invoke<LogLine[]>(LOGSTREAM_SNAPSHOT);
}

/** `logstream_clear` — empties the Rust ring. Ids keep increasing afterwards. */
export function logstreamClear(): Promise<void> {
  return invoke<void>(LOGSTREAM_CLEAR);
}

/** Subscribe to `logstream://lines` batches. Resolves to the unsubscribe fn. */
export function onLogstreamLines(handler: (lines: LogLine[]) => void): Promise<UnlistenFn> {
  return listen<LogLine[]>(LOGSTREAM_LINES_EVENT, (event) => handler(event.payload));
}

/** `syslog_status` — the system-apps source: availability, what is active, the live rate. */
export function syslogStatus(): Promise<SyslogStatus> {
  return invoke<SyslogStatus>(SYSLOG_STATUS);
}

/** `syslog_set` — apply a whole filter; Rust (re)starts/stops its children and answers the new status. */
export function syslogSet(filter: SyslogFilter): Promise<SyslogStatus> {
  return invoke<SyslogStatus>(SYSLOG_SET, { filter });
}

/** `syslog_apps` — the processes running now, grouped by name, apps first. */
export function syslogApps(): Promise<RunningApp[]> {
  return invoke<RunningApp[]>(SYSLOG_APPS);
}
