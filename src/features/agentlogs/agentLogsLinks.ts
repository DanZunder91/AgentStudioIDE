/** "→ open <service> stream": link a command block naming a file the IDE already tails. Streamed
 * paths come only from `task` details (`logstream/tasks.rs`); a token matches the exact path or a
 * whole-component relative tail; Windows paths match any spelling, ignoring case. */

import { endsWithSegments, isAbsolutePath, isWindowsPath, msysToWindows, samePath } from "../../lib/paths";
import type { ToolBlock } from "./agentLogsStream";
import type { LogLine } from "./agentLogsTypes";

/** Streamed path → the source (wire label) whose stream tails it. */
export type ServicePaths = ReadonlyMap<string, string>;

/** The paths every service tails, from the task lines in the ring (the first line is the command). */
export function servicePaths(lines: readonly LogLine[]): ServicePaths {
  const out = new Map<string, string>();
  for (const line of lines) {
    if (line.detail === null) continue;
    const isTask = line.kind === "task" || (line.kind === "system" && line.text.startsWith("background task started · "));
    if (!isTask) continue;
    const paths = line.detail.split("\n").slice(1);
    for (const raw of paths) {
      const p = raw.trim();
      if (p !== "") out.set(p, line.source);
    }
  }
  return out;
}

/** Candidate path tokens: split on whitespace and shell separators (incl. `=`, for `S=/tmp/x`),
 * strip trailing punctuation; only tokens with `/`, `\` or `.` can be files. */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s'"`;|&()<>=]+/)) {
    const t = raw.replace(/[:,.)\]'"]+$/, "");
    if (t !== "" && /[/\\.]/.test(t)) out.push(t);
  }
  return out;
}

/** `token` names `path`: equal, or a component-wise relative tail. An absolute token must be the
 * path exactly (POSIX) or any spelling of it (Windows: `C:/x`, `c:\x`, Git Bash's `/c/x`). */
export function namesPath(token: string, path: string): boolean {
  if (token === path) return true;
  if (token === "") return false;
  if (isAbsolutePath(token)) return isWindowsPath(path) && samePath(msysToWindows(token), path);
  return endsWithSegments(path, token);
}

/** The service (wire label) whose streamed file the block's command or output names, or null. */
export function streamLinkFor(block: Pick<ToolBlock, "tool" | "result">, paths: ServicePaths): string | null {
  if (paths.size === 0) return null;
  const texts: string[] = [];
  if (block.tool !== null) {
    texts.push(block.tool.text);
    if (block.tool.detail !== null) texts.push(block.tool.detail);
  }
  if (block.result !== null && block.result.detail !== null) texts.push(block.result.detail);
  for (const text of texts) {
    for (const token of pathTokens(text)) {
      for (const [path, source] of paths) {
        if (namesPath(token, path)) return source;
      }
    }
  }
  return null;
}
