/** The one `invoke` seam for procs; its own file because a `vi.mock` factory of `logstreamIpc.ts`
 * would silently lack new exports. Nothing swallows; names are pinned by `procsIpc.test.ts`. Tail
 * commands only name a path Rust can check (a listed process has it open, or Rust's own picker). */

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

/** `true` = a tail was stopped; `false` = none ran under that key any more (it ended on its own).
 * Either way nothing is tailing it now. */
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
