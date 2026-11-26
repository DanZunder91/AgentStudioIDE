/** Typed wrappers for the agent half of the command surface (ARCHITECTURE §2.4). Feature-local,
 * not in `app/ipc.ts`, so the wire types live next to their feature. */

import { invoke } from "@tauri-apps/api/core";
import type {
  ActivityEntry,
  AgentId,
  AgentNode,
  RestoreOutcome,
  TerminalMeta,
} from "../../app/types";

/** `fleet_snapshot` — initial paint / restart re-attach (ARCHITECTURE §2.4). */
export interface FleetSnapshot {
  agents: AgentNode[];
  terminals: TerminalMeta[];
}

export function fleetSnapshot(): Promise<FleetSnapshot> {
  return invoke<FleetSnapshot>("fleet_snapshot", {});
}

/** Absolute path to open agents/terminals in at startup: the launch dir's git root, else home.
 * `bridge.ts` reads it once to seed `workspaceRoot`. */
export function defaultWorkspace(): Promise<string> {
  return invoke<string>("default_workspace", {});
}

/** Recently opened project folders, most recent first; read once at startup. */
export function recentProjects(): Promise<string[]> {
  return invoke<string[]>("recent_projects", {});
}

/** Move `path` to the front of the persisted recents. Fire-and-forget. */
export function pushRecentProject(path: string): Promise<void> {
  return invoke<void>("push_recent_project", { path });
}

/** Install the ad-hoc agent-detection hook for a folder opened without a terminal, so a `claude`
 * typed there later is detected. Rust resolves `Ok` even when it skips the write. */
export function ensureAgentHooks(root: string): Promise<void> {
  return invoke<void>("ensure_agent_hooks", { root });
}

/** A sub-agent's transcript so far: sub-agents have no PTY, so this read-only feed shows what one
 * is doing. Polled while an activity view is mounted. */
export function subagentActivity(agentId: AgentId): Promise<ActivityEntry[]> {
  return invoke<ActivityEntry[]>("subagent_activity", { agentId });
}

/** `agent_spawn` options. The UI names a runtime, never a program: the Rust `AgentAdapter` picks
 * the binary. Not reachable from the UI yet: `TerminalRegistry` always calls `terminal_open`. */
export interface SpawnAgentOptions {
  /** Also this terminal's `TerminalId` (ARCHITECTURE §2.4): Rust keys the PTY by the agentId. */
  agentId: AgentId;
  /** An AgentAdapter id ("claude-code"), never a program. */
  runtime: string;
  /** Seed the agent with a task. M3 uses this; Rust's arg is `Option<String>`. */
  prompt?: string;
  /** Resume this Claude session instead of a fresh one; absent/null spawns fresh. */
  resumeSessionId?: string;
  cwd: string;
  rows: number;
  cols: number;
  /** Hot plane: Rust pushes coalesced raw PTY bytes here. */
  onOutput: unknown;
}

export function spawnAgent(opts: SpawnAgentOptions): Promise<TerminalMeta> {
  return invoke<TerminalMeta>("agent_spawn", {
    agentId: opts.agentId,
    runtime: opts.runtime,
    // `prompt`, not `presetId`: serde ignores unknown fields, so a misnamed key fails silently.
    prompt: opts.prompt ?? null,
    // Same null-not-undefined rule as `prompt`: an omitted key would be
    // dropped by the serializer, and the NAME is the contract (serde reads
    // `resumeSessionId` and silently ignores anything else).
    resumeSessionId: opts.resumeSessionId ?? null,
    cwd: opts.cwd,
    rows: opts.rows,
    cols: opts.cols,
    onOutput: opts.onOutput,
  });
}

/* ── agent pinning ──
 * Only root agents are pinnable. Rust owns `pinned-agents.json` and respawns pinned roots on
 * boot; the frontend toggles pins and marks restored rows. */

/** A pinned root agent from `pinned_agents()`. Durable details (session id, order, pinnedAt)
 * stay in Rust; a `claude` session id never crosses the wire. */
export interface PinnedAgentView {
  agentId: AgentId;
  cwd: string;
  title: string;
}

/** Persist a pin for a root agent. Best-effort, like `saveApiStore`: the store is the source of
 * truth and the next mutation re-issues a dropped persist. */
export async function pinAgent(agentId: AgentId): Promise<void> {
  try {
    await invoke<void>("pin_agent", { agentId });
  } catch {
    /* swallowed — a dropped save is not fatal (the saveApiStore pattern) */
  }
}

/** Drop a pin by id. Best-effort and idempotent in Rust. */
export async function unpinAgent(agentId: AgentId): Promise<void> {
  try {
    await invoke<void>("unpin_agent", { agentId });
  } catch {
    /* swallowed */
  }
}

/** The pin registry, read once on boot. Never throws: a missing/broken registry yields `[]`. */
export async function pinnedAgents(): Promise<PinnedAgentView[]> {
  try {
    return await invoke<PinnedAgentView[]>("pinned_agents", {});
  } catch {
    return [];
  }
}

/** An agent the boot restore brought back (`open_agents.rs`): its rung and whether the quit
 * interrupted it. No session id. */
export interface RestoredAgentView {
  agentId: AgentId;
  outcome: RestoreOutcome;
  wasWorking: boolean | null;
}

/** Standing "Resumed after restart" markers, read once on boot (Rust drops each at that agent's
 * next turn, end or close). Never throws: a failure yields `[]`. */
export async function restoredAgents(): Promise<RestoredAgentView[]> {
  try {
    return await invoke<RestoredAgentView[]>("restored_agents", {});
  } catch {
    return [];
  }
}

/** The session id to resume a finished root agent with. Rejects `"not-finished"`,
 * `"not-a-root"` or `"no-session"`; same exposure as `list_claude_sessions`. */
export function agentResumeSession(agentId: AgentId): Promise<string> {
  return invoke<string>("agent_resume_session", { agentId });
}

