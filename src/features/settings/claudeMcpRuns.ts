/** Module-level `claude mcp` runs, outliving the popover (an add takes seconds). One run at a time:
 * a reopen joins it (Rust's `agent_ctl::mcp::Gate` refuses a second too). The last answer is reused
 * for `FRESH_MS`; an action's answer replaces it; a failed status is not kept. */
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
