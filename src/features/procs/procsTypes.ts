/**
 * Dev apps on this machine — the wire contract.
 *
 * Mirrors `procscan::DevApp` / `procscan::ProcsList` in `src-tauri/src/procscan/` (serde
 * camelCase). The shapes below mirror that contract exactly; where it leaves a return type
 * open, the choice made is written next to it (search "DECIDED") so the Rust and TypeScript
 * sides can be compared line by line.
 *
 * Not types-only on purpose: the runtime labels and the poll cadence live here too, so v8
 * measures this file instead of reporting it as 0-of-0 (vitest.config.ts excludes types-only
 * files by name).
 */

/**
 * `shell` = a `sh -c …` / shell script whose stdout or stderr goes to a FILE (Rust's
 * `procscan::Runtime::Shell`): plain interactive shells are never listed, but a script writing
 * a log is something you may want to Stream.
 */
export type DevRuntime = "jvm" | "node" | "rust" | "python" | "go" | "docker" | "shell";

/**
 * Where the process's stdout/stderr go:
 * - `terminal` / `pipe` — a tty or pipe owned by another program: unreadable from here.
 * - `file` — redirected to a regular file, which is also listed in `logFiles`.
 * - `none` — `/dev/null` (`NUL` on Windows) or closed.
 * - `ide-terminal` — the PTY of an IDE terminal (`DevApp.terminalId`): its output IS that
 *   terminal's stream already, so the card offers "Open terminal", never a Restart.
 */
export type ConsoleKind = "terminal" | "pipe" | "file" | "none" | "ide-terminal";

/**
 * `ide` = a descendant of the IDE's process tree (an IDE terminal's shell, or an
 * agent running in one, started it — `cargo run` → `gazelle`); `external` = everything else.
 */
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
  /**
   * The capture guard (an agent can run a program with every proxy variable
   * stripped, so none of its calls reach Network, silently). `origin: "ide"` only: `true` =
   * its environment points at the IDE's capture proxy; `false` = it does not (stripped, another
   * port, `NO_PROXY=*`) — its HTTP cannot show in Network, and the UI says so with a "Restart
   * with capture"; `null` = unknown (the OS hides its env, the IDE injects no proxy) or an
   * external app. Rust reads the env and sends only this boolean — the env itself never
   * crosses the wire.
   */
  captured: boolean | null;
}

/**
 * `procs_list`. Discovery runs on macOS, Linux and Windows — on Windows too,
 * consoles report `file` / `pipe` and `logFiles` lists the files an app has open — so
 * `available: false` (with the reason) only comes from an OS with no discovery at all
 * (`procscan::unavailable_list`).
 */
export interface ProcsList {
  available: boolean;
  reason: string | null;
  apps: DevApp[];
}

/**
 * What `logstream_tail_app` / `logstream_tail_docker` resolve to.
 *
 * DECIDED (the contract named the commands, not their return): the tail's hub `key` — the only
 * handle `logstream_untail({ key })` accepts, so the UI never has to reconstruct Rust's key —
 * and the `source` label its `LogLine`s will carry (`<name> · <file>` / `<name> · docker`), so
 * the Logs view can solo the new stream the moment it starts instead of guessing the label.
 */
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
