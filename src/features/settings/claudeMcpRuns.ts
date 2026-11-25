/**
 * The Settings item's runs of Claude Code's `claude mcp`, kept across popover opens.
 *
 * The item ("Add Agent Studio to Claude Code") mounts only while the popover is open, but a run
 * outlives it: an add or a removal takes seconds, and `claude mcp get` starts this app's binary
 * for its health check. So the run in flight and the last answer live here, at module level:
 *
 * - One run at a time. Opening the menu while a run is going joins it instead of starting another,
 *   so a reopened popover shows "Adding…" rather than an old state with the button enabled.
 *   (Rust refuses a second add or removal as busy as well: `agent_ctl::mcp::Gate`.)
 * - The last answer is shown again for `FRESH_MS` without asking, so opening and closing the menu
 *   does not start a `claude mcp get` each time. An action's answer replaces it, since it says
 *   what Claude Code has now, and is shown on the next open even when it arrived after the menu
 *   closed. A failed status is not kept: the next open asks again.
 */
import {
  claudeMcpInstall,
  claudeMcpStatus,
  claudeMcpUninstall,
  type ClaudeMcpReport,
} from "./claudeMcpIpc";

export type ClaudeMcpAction = "install" | "uninstall";

export interface ClaudeMcpAnswer {
  report: ClaudeMcpReport;
  /** The action that produced it; `null` for a status. */
  after: ClaudeMcpAction | null;
}

export interface ClaudeMcpRun {
  /** What is running; `null` for a status. */
  action: ClaudeMcpAction | null;
  promise: Promise<ClaudeMcpAnswer>;
}

/** How long an answer is shown again without asking Claude Code. */
export const FRESH_MS = 30_000;

let last: { answer: ClaudeMcpAnswer; at: number } | null = null;
let running: ClaudeMcpRun | null = null;

/** The answer to show without asking, when there is a recent one. */
export function recentAnswer(): ClaudeMcpAnswer | null {
  return last !== null && Date.now() - last.at < FRESH_MS ? last.answer : null;
}

/** The run in flight, if any. */
export function currentRun(): ClaudeMcpRun | null {
  return running;
}

/** Start `action` (`null`: ask for the status), or join the run already going. */
export function startRun(action: ClaudeMcpAction | null): Promise<ClaudeMcpAnswer> {
  if (running !== null) return running.promise;
  const ask =
    action === null ? claudeMcpStatus() : action === "install" ? claudeMcpInstall() : claudeMcpUninstall();
  // The IPC wrappers never reject, so `running` is always cleared.
  const promise = ask.then((report) => {
    const answer = { report, after: action };
    last = action === null && !report.ok ? null : { answer, at: Date.now() };
    running = null;
    return answer;
  });
  running = { action, promise };
  return promise;
}

/** Forget the last answer and any run (tests start from nothing). */
export function forgetClaudeMcpRuns(): void {
  last = null;
  running = null;
}
