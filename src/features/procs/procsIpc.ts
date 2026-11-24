/**
 * Dev-apps IPC — the ONE `invoke` seam for `src/features/procs/`.
 *
 * Its own file, not more exports on `agentlogs/logstreamIpc.ts`: the wire types live next to
 * their feature, and every test that `vi.mock`s that module with a factory would silently lack
 * these exports (a `vi.mock` factory does not grow new exports). Nothing here swallows — a
 * rejection is information the card shows.
 *
 * Command names and argument shapes are pinned literally by `procsIpc.test.ts`.
 *
 * 🔴 Tail commands only ever name a path Rust can check: one a listed process has open, or the
 * one the user just picked in Rust's own file dialog. The UI never invents one.
 */

import { invoke } from "@tauri-apps/api/core";

import {
  LOGSTREAM_PICK_FILE,
  LOGSTREAM_TAIL_APP,
  LOGSTREAM_TAIL_DOCKER,
  LOGSTREAM_UNTAIL,
  PROCS_LIST,
  PROCS_RESTART_IN_IDE,
  PROCS_RESTART_PREPARE,
  type ProcsList,
  type RestartPrepared,
  type RestartStarted,
  type TailStarted,
} from "./procsTypes";

/** `procs_list` — every same-user dev app, classified by runtime. */
export function procsList(): Promise<ProcsList> {
  return invoke<ProcsList>(PROCS_LIST);
}

/** `logstream_tail_app` — tail one of `pid`'s open log files (or a picked one) into the hub. */
export function tailApp(pid: number, path: string): Promise<TailStarted> {
  return invoke<TailStarted>(LOGSTREAM_TAIL_APP, { pid, path });
}

/** `logstream_tail_docker` — `docker logs -f --tail 500 <id>` into the hub. */
export function tailDocker(id: string): Promise<TailStarted> {
  return invoke<TailStarted>(LOGSTREAM_TAIL_DOCKER, { id });
}

/**
 * `logstream_untail` — stop a tail this UI started, by the key Rust gave it. `true` = a tail
 * was stopped; `false` = none ran under that key any more (it had ended on its own: the process
 * exited, the file went away, the container stopped). Either way nothing is tailing it now.
 */
export function untail(key: string): Promise<boolean> {
  return invoke<boolean>(LOGSTREAM_UNTAIL, { key });
}

/** `logstream_pick_file` — Rust's native open dialog; `null` when the user cancelled. */
export function pickLogFile(): Promise<string | null> {
  return invoke<string | null>(LOGSTREAM_PICK_FILE);
}

/** `procs_restart_prepare` — re-read `pid` in Rust and mint a one-shot restart token. */
export function restartPrepare(pid: number): Promise<RestartPrepared> {
  return invoke<RestartPrepared>(PROCS_RESTART_PREPARE, { pid });
}

/** `procs_restart_in_ide` — SIGTERM the original and run its argv + env in an IDE terminal. */
export function restartInIde(token: string): Promise<RestartStarted> {
  return invoke<RestartStarted>(PROCS_RESTART_IN_IDE, { token });
}
