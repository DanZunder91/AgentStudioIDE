/** Wire contract mirroring `procscan::DevApp` / `ProcsList` (serde camelCase); choices it leaves
 * open are marked DECIDED. Not types-only on purpose, so v8 measures it (vitest.config.ts
 * excludes types-only files by name). */

/** `shell` = a shell script whose stdout/stderr goes to a file (`procscan::Runtime::Shell`);
 * plain interactive shells are never listed. */
export type DevRuntime = "jvm" | "node" | "rust" | "python" | "go" | "docker" | "shell";

/** `terminal`/`pipe`: owned by another program, unreadable here; `file`: also in `logFiles`;
 * `none`: `/dev/null`/`NUL` or closed; `ide-terminal`: an IDE terminal's PTY (`terminalId`),
 * already that terminal's stream, so the card offers "Open terminal", never a Restart. */
export type ConsoleKind = "terminal" | "pipe" | "file" | "none" | "ide-terminal";

/** `ide` = a descendant of the IDE's process tree (an IDE terminal or its agent started it). */
export type AppOrigin = "ide" | "external";

export interface DevLogFile {
  path: string;
  /** `stdout` / `stderr` = fd 1 / fd 2 redirected here; `log` = an open log-looking file. */
  kind: "stdout" | "stderr" | "log";
}

export interface DevApp {
  /** Stable identity across polls (Rust: pid + start time, or the container id). */
  key: string;
  /** Null for a Docker container (it has no host pid we may signal). */
  pid: number | null;
  runtime: DevRuntime;
  /** Project dir basename, jar, main class or script — the display name, and the log `source` prefix. */
  name: string;
  exe: string | null;
  /** 🔴 Already MASKED by Rust (`--password=…` → `--password=•••`). The UI renders it as-is, never more. */
  argv: string[];
  cwd: string | null;
  startedMs: number | null;
  /** Listening TCP ports. */
  ports: number[];
  console: ConsoleKind;
  logFiles: DevLogFile[];
  containerId: string | null;
  /** The sidebar lists `ide` apps first, and never offers them a Restart. */
  origin: AppOrigin;
  /** The IDE terminal whose shell is its ancestor; null for an external app. */
  terminalId: string | null;
  /** The ROOT agent bound to that terminal, if one is — how an agent row counts "N apps". */
  agentId: string | null;
  /** Display label of who started it — the agent's or the terminal's title (`claude · gazelle`). */
  launchedBy: string | null;
  /** `origin: "ide"` only: `true` = its env points at the IDE's capture proxy; `false` = it does
   * not (offer Restart with capture); `null` = unknown or external. Rust sends only this boolean:
   * the env never crosses the wire. */
  captured: boolean | null;
}

/** Discovery runs on macOS, Linux and Windows; `available: false` (with the reason) only comes
 * from an OS with none (`procscan::unavailable_list`). */
export interface ProcsList {
  available: boolean;
  reason: string | null;
  apps: DevApp[];
}

/** DECIDED: the hub `key` (the only handle `logstream_untail` accepts) and the `source` label its
 * lines will carry, so the Logs view can solo the new stream at once instead of guessing. */
export interface TailStarted {
  key: string;
  source: string;
}

/** `procs_restart_prepare` — a one-shot token bound to the pid Rust re-read, and what it will run. */
export interface RestartPrepared {
  token: string;
  summary: { name: string; cwd: string | null; argv: string[] };
}

/** `procs_restart_in_ide` — the IDE terminal now running the command. */
export interface RestartStarted {
  terminalId: string;
}

/** Tauri command names — pinned literally by `procsIpc.test.ts`. */
export const PROCS_LIST = "procs_list";
export const LOGSTREAM_TAIL_APP = "logstream_tail_app";
export const LOGSTREAM_TAIL_DOCKER = "logstream_tail_docker";
export const LOGSTREAM_UNTAIL = "logstream_untail";
export const LOGSTREAM_PICK_FILE = "logstream_pick_file";
export const PROCS_RESTART_PREPARE = "procs_restart_prepare";
export const PROCS_RESTART_IN_IDE = "procs_restart_in_ide";

/** Polled every 3 s while the view is open. */
export const PROCS_POLL_MS = 3_000;

/** The badge text per runtime: JVM / Node / Rust / Python / Go / Docker, + Shell. */
export const RUNTIME_LABELS: Readonly<Record<DevRuntime, string>> = {
  jvm: "JVM",
  node: "Node",
  rust: "Rust",
  python: "Python",
  go: "Go",
  docker: "Docker",
  shell: "Shell",
};
