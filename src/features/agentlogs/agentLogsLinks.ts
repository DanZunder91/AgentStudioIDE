/**
 * Agent Logs — "→ open <service> stream". Pure: no React, no store.
 *
 * What happens in practice: a user keeps reading the agent's `grep … gazelle.log | tail -5`
 * block, output folded to three lines, while the IDE is already tailing the whole file as the
 * `gazelle` service stream two rows up in the sidebar. So when a command block's output came
 * from a file the IDE streams, its header links to that stream.
 *
 * Which files the IDE streams: every `task` line (and a task's `background task started`
 * announce) carries a `detail` of `<command>\n<path>[\n<path>…]` — the command on the first
 * line, then the file(s) Rust tails for that source (`logstream/tasks.rs`). Those paths, per
 * source, are the only "streamed files" there are; nothing is guessed from the command.
 *
 * Which blocks link: the call's text and detail (the command, its description, the multi-line
 * form) and the result's detail (the invocation line and the output — the result of the Bash
 * that STARTED a service names its output file, which puts the link on the block that started
 * it). A token names a streamed path when it is that path exactly, or is a relative path whose
 * every component matches the path's tail (`gazelle.log` or `logs/gazelle.log` for
 * `/work/gazelle/logs/gazelle.log`): a relative spelling is the same file seen from a cwd we do
 * not know. A token never matches on a partial component (`zelle.log` is not `gazelle.log`).
 *
 * On Windows the streamed paths are `C:\Users\me\AppData\Local\Temp\claude\…\tasks\b1.output`,
 * and an agent names them every way Windows allows: `C:/…`, `c:\…`, and — since
 * Claude Code runs its Bash tool in Git Bash — `/c/Users/…`. All of those are the same file;
 * either separator divides components, and Windows paths compare without case.
 */

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

/**
 * The candidate path tokens of a command / output: split on whitespace and on the shell's
 * own separators (quotes, `;`, `|`, `&`, `(`, `)`, `<`, `>`, backtick, `=` — `S=/tmp/x` names
 * `/tmp/x`), then stripped of trailing punctuation a sentence or a `grep -n` hit leaves on a
 * path (`:`, `,`, `.`, `)`, `]`, `'`, `"`). Only tokens with a separator (`/` or Windows' `\`)
 * or a `.` can be a file.
 */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s'"`;|&()<>=]+/)) {
    const t = raw.replace(/[:,.)\]'"]+$/, "");
    if (t !== "" && /[/\\.]/.test(t)) out.push(t);
  }
  return out;
}

/**
 * `token` names `path`: equal, or a relative path that is the tail of `path` component-wise.
 * An absolute token must be the path itself — exactly, for a POSIX path; for a Windows path,
 * any spelling of it (`C:/x`, `c:\x`, Git Bash's `/c/x`).
 */
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
