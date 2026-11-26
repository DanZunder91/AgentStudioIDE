/** Typed wrapper for the past-Claude-sessions command, feature-local next to its wire types. */

import { invoke } from "@tauri-apps/api/core";

/** Read-only metadata from `~/.claude/projects/<mangled-cwd>/*.jsonl`, newest-first. Reading
 * there is fine; the app must never write to `~/.claude`. */
export interface ClaudeSessionMeta {
  /** The Claude session id — what `agent_spawn`'s `resumeSessionId` accepts. */
  sessionId: string;
  /** Transcript mtime (ms since epoch) — "when this session last ran". */
  mtimeMs: number;
  /** Transcript size on disk. */
  sizeBytes: number;
  /** A human label derived from the transcript (e.g. its first user prompt). */
  label: string;
  /** False → `claude --resume` cannot revive it; the row is inert. */
  resumable: boolean;
}

/** Empty is normal (claude never ran there). A rejection propagates rather than becoming `[]`,
 * which would falsely say "no sessions". */
export function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_claude_sessions", { cwd });
}
