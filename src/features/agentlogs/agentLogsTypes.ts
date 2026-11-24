/**
 * Agent Logs — the wire contract.
 *
 * Mirrors `logstream::LogLine` in `src-tauri/src/logstream/` (serde camelCase). If a
 * field is not in this interface, Rust never sent it — the UI-only view state lives in
 * `agentLogsStore.ts`, never here (the `AgentNodeWire` rule in `app/types.ts`).
 */

export type LogLevel = "error" | "warn" | "info" | "debug";
/**
 * `machine` = a line from another app on the computer (`syslog/`).
 * `task` = a line from a background task an agent started — e.g. the service Claude ran with
 * `run_in_background`, tailed from its output file. Its `source` is
 * `<program> · bg`, `detail` the full command + the output path. It is IDE content: it came
 * from an agent, so the "IDE terminals & agents" switch covers it.
 * `app` = a line from a dev app's log the user chose to Stream from its card
 * (a file the process writes, or a container's `docker logs -f`). Its `source` is
 * `<app name> · <file basename>` / `<container> · docker`, `detail` where it comes from
 * (the file's path — see `src/test/contract/goldens/app-lines.json`). Raw like a service. It is NOT IDE content — the user picked it on this
 * machine, like a Mac app — so the "IDE terminals & agents" switch leaves it on screen.
 */
export type LogKind = "output" | "tool" | "tool-result" | "system" | "machine" | "task" | "app";

export interface LogLine {
  /** Monotonic u64 per app run; the UI dedupes and orders on it. */
  id: number;
  /** Unix ms when the line completed. */
  tsMs: number;
  terminalId: string | null;
  /** The agent that produced it (a sub-agent for its own tool calls). */
  agentId: string | null;
  /** Display label: terminal title / agent title, e.g. "claude · gazelle". */
  source: string;
  kind: LogKind;
  level: LogLevel;
  /** ANSI-stripped, ≤ 4 KiB. */
  text: string;
  /** E.g. a Bash `description`, or the full multi-line result. */
  detail: string | null;
  /**
   * The transcript's `tool_use.id`, set on `tool` and `tool-result` lines:
   * the key that pairs a call with its result into one command block — never a guess.
   * Null on every other kind. A line from a Rust build that predates the field arrives
   * without it; `pairToolLines` tolerates that (nearest preceding unpaired call of the same
   * agent), so the view degrades to a heuristic rather than to no blocks at all.
   */
  toolUseId: string | null;
}

/** Tauri command names — pinned by `logstreamIpc.test.ts`. */
export const LOGSTREAM_SNAPSHOT = "logstream_snapshot";
export const LOGSTREAM_CLEAR = "logstream_clear";
/** Tauri event carrying `LogLine[]` batches (≤ 1 emit / 100 ms, ≤ 2 000 lines). */
export const LOGSTREAM_LINES_EVENT = "logstream://lines";

/** The ring's capacity in Rust — the UI keeps the same cap. */
export const LOG_CAP = 20_000;

/* ───────────────────── system apps (`src-tauri/src/syslog/`) ───────────────────── */

/** The OS log level floor. macOS `default` hides debug/info noise; journald and the Windows Event Log map onto it. */
export type SyslogLevel = "debug" | "info" | "default" | "error";

/** Mirrors `syslog::SyslogFilter` (serde camelCase). */
export interface SyslogFilter {
  /** The "System apps" source (default false — high volume, opt-in). */
  enabled: boolean;
  /** Process names (Windows: Event Log provider names); `null` = ALL apps. */
  apps: string[] | null;
  /** macOS subsystem prefix, e.g. "com.example.demo"; Linux: systemd unit; Windows: one extra Event Log channel. */
  subsystem: string | null;
  minLevel: SyslogLevel;
  /** macOS only. */
  simulator: boolean;
  /** `null` = all simulator processes. */
  simulatorApps: string[] | null;
}

export type SyslogBackend = "macos-unified-log" | "linux-journald" | "windows-eventlog";

/** Mirrors `syslog::SyslogStatus`. */
export interface SyslogStatus {
  available: boolean;
  backend: SyslogBackend | null;
  /** Why it is unavailable, or a partial note ("only your own journal — …"). */
  reason: string | null;
  running: boolean;
  /** What is active (persisted by Rust in `<app config>/syslog/prefs.json`). */
  filter: SyslogFilter;
  simulator: { available: boolean; reason: string | null; running: boolean };
  linesPerSec: number;
  droppedPerSec: number;
}

/** Mirrors `syslog::RunningApp` — current processes grouped by name (Windows: Event Log providers that wrote recently, no pids). */
export interface RunningApp {
  /** The grouping key — what goes into `SyslogFilter.apps`. */
  name: string;
  pids: number[];
  path: string | null;
  /** macOS: inside a .app bundle; Windows: a provider outside `Microsoft-Windows-*` (listed first in the picker). */
  isApp: boolean;
}

/** Tauri command names — pinned by `logstreamIpc.test.ts`. */
export const SYSLOG_STATUS = "syslog_status";
export const SYSLOG_SET = "syslog_set";
export const SYSLOG_APPS = "syslog_apps";

/** How often the panel re-reads `syslog_status` while mounted (lines/s, running, reason). */
export const SYSLOG_POLL_MS = 2_000;
