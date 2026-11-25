/**
 * Agent Studio's tools in Claude Code: the IPC behind the Settings menu's "Add Agent Studio to
 * Claude Code".
 *
 * Rust (`agent_ctl::mcp`) runs Claude Code's own `claude mcp get|add|remove`, so Claude writes
 * its own config, and only on the user's action; the same three exist on the command line as
 * `agent-studio mcp status|install|uninstall`.
 *
 * These wrappers never reject. A failed IPC becomes a `failed` report whose message says what
 * went wrong, so the menu item always has a reason to show instead of a spinner that never ends.
 */
import { invoke } from "@tauri-apps/api/core";

/** Mirrors `agent_ctl::mcp::McpState`. */
export type ClaudeMcpState =
  /** Added, and it runs this app's binary. */
  | "installed"
  | "notInstalled"
  /** An `agent-studio` entry runs something else (another copy of the app). */
  | "different"
  /** No `claude` to ask. */
  | "claudeMissing"
  /** `claude` did not say, or the action failed: `message` says why. */
  | "failed";

/** Mirrors `agent_ctl::mcp::McpReport`. */
export interface ClaudeMcpReport {
  /** Whether the action did what was asked; for the status, whether it could be read. */
  ok: boolean;
  state: ClaudeMcpState;
  /** A sentence for the user. */
  message: string;
  /** What Claude Code's `agent-studio` entry runs, when there is one. */
  configured: string | null;
  /** The scope Claude Code names for it. */
  scope: string | null;
  /** This app's binary: what an install points Claude Code at. */
  exe: string;
}

async function ask(command: string): Promise<ClaudeMcpReport> {
  try {
    return await invoke<ClaudeMcpReport>(command);
  } catch (e) {
    return {
      ok: false,
      state: "failed",
      message: `Agent Studio could not ask Claude Code (${String(e)}).`,
      configured: null,
      scope: null,
      exe: "",
    };
  }
}

/** Whether Claude Code has Agent Studio (`claude mcp get agent-studio`). */
export function claudeMcpStatus(): Promise<ClaudeMcpReport> {
  return ask("claude_mcp_status");
}

/** Add it (`claude mcp add --scope user agent-studio -- <this app> mcp`). */
export function claudeMcpInstall(): Promise<ClaudeMcpReport> {
  return ask("claude_mcp_install");
}

/** Remove it (`claude mcp remove --scope user agent-studio`). */
export function claudeMcpUninstall(): Promise<ClaudeMcpReport> {
  return ask("claude_mcp_uninstall");
}
