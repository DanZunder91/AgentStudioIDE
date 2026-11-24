/**
 * Sessions IPC — typed wrapper for the past-Claude-sessions command
 * ("Recover session").
 *
 * Kept feature-local so the wire types live next to their feature.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * One past Claude session of a folder, as Rust reports it (newest-first).
 * Read-only metadata from `~/.claude/projects/<mangled-cwd>/*.jsonl` — reading
 * there is fine; the app must never WRITE to `~/.claude`.
 */
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

/**
 * `list_claude_sessions` — that folder's past sessions, newest-first.
 *
 * An empty list is NORMAL (the folder never ran claude) and renders as a calm
 * empty state. A rejection (unreadable dir, bad scope) must reach the caller —
 * the picker shows it as a calm inline note, never a crash — so this wrapper
 * propagates rather than swallowing into `[]`, which would lie "no sessions".
 */
export function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_claude_sessions", { cwd });
}
