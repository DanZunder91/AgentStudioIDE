/**
 * Fleet IPC — typed wrappers for the agent half of the command surface
 * (ARCHITECTURE §2.4).
 *
 * ── Why this is not in `app/ipc.ts` ──────────────────────────────────────────
 * ARCHITECTURE §4 puts every `invoke()` wrapper in `app/ipc.ts`. Kept
 * feature-local so the wire types live next to their feature.
 */

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

/**
 * `default_workspace` — the folder to open agents/terminals in at startup.
 *
 * Rust returns an absolute path: the git root of where the app was launched,
 * else the user's home. Used once by `bridge.ts` to seed `workspaceRoot`.
 */
export function defaultWorkspace(): Promise<string> {
  return invoke<string>("default_workspace", {});
}

/**
 * `recent_projects` — recently-opened project folders, most-recent first
 * (recent projects). Read once on startup to seed the store's `recentProjects`.
 */
export function recentProjects(): Promise<string[]> {
  return invoke<string[]>("recent_projects", {});
}

/**
 * `push_recent_project` — record that `path` was just used, so it moves to the
 * front of the persisted recents. Fire-and-forget from the UI's view.
 */
export function pushRecentProject(path: string): Promise<void> {
  return invoke<void>("push_recent_project", { path });
}

/**
 * `ensure_agent_hooks` — install the ad-hoc-detection hook for a workspace `root`
 * opened without spawning a terminal (the multi-root Files "Open a folder").
 * Terminal/agent spawn installs it too; this covers a merely-opened folder
 * so a `claude` typed in a terminal there later is still detected (ad-hoc agent
 * detection). Best-effort on the UI side (`void ...catch()`): Rust resolves `Ok` even
 * when the write is skipped, so a failure never breaks the UI.
 */
export function ensureAgentHooks(root: string): Promise<void> {
  return invoke<void>("ensure_agent_hooks", { root });
}

/**
 * `subagent_activity` — a sub-agent's transcript so far (M3). Sub-agents run
 * in-process with no PTY, so this read-only feed is how the UI reveals what one
 * is doing. Polled while an activity view is mounted (the agent may be running).
 */
export function subagentActivity(agentId: AgentId): Promise<ActivityEntry[]> {
  return invoke<ActivityEntry[]>("subagent_activity", { agentId });
}

/**
 * `agent_spawn` — spawn a runtime in a PTY + start its fan-out tailer
 * (ARCHITECTURE §2.4).
 *
 * NOTE: the UI names a `runtime` ("claude-code"), never a program. Which binary
 * to launch is `AgentAdapter::spawn_spec`'s business on the Rust side — that
 * seam is what keeps Claude-specific knowledge out of the frontend (Claude Code
 * first, behind an adapter).
 *
 * ⚠️ Not reachable from the UI yet: PTYs are created by `TerminalRegistry`,
 * which unconditionally calls `terminal_open`. Routing agent terminals here needs
 * one change in the terminal registry, not in fleet code.
 */
export interface SpawnAgentOptions {
  /**
   * Also this terminal's `TerminalId` — a requirement, not a convention
   * (ARCHITECTURE §2.4). `agent_spawn` takes no terminalId: Rust keys the PTY
   * by the agentId itself.
   */
  agentId: AgentId;
  /** An AgentAdapter id ("claude-code"), never a program. */
  runtime: string;
  /** Seed the agent with a task. M3 uses this; Rust's arg is `Option<String>`. */
  prompt?: string;
  /**
   * Resume an existing Claude session instead of minting a fresh one
   * ("Recover session"). Rust's arg is `Option<String>`
   * (`resume_session_id`; camelCase on the wire) — absent/null means a fresh
   * session, so plain spawns are untouched.
   */
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
    // `prompt`, not `presetId`. Serde ignores unknown fields, so sending a name
    // Rust does not read fails as silence, not as an error — it would surface
    // at M3 as "why does my seed prompt do nothing?". Agent presets do not
    // exist; if they ever do, they arrive as an addition, not a rename.
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

/* ──────────────────────────────── agent pinning ────────────────────────────────
 * The three commands the pin feature rides on. Only ROOT agents are pinnable;
 * Rust owns the durable registry (`pinned-agents.json`) and auto-spawns pinned
 * roots on boot so they arrive through `fleet_snapshot()` + the webview-reload
 * re-attach — the frontend just toggles the pin and marks restored rows.
 */

/**
 * A pinned root agent as Rust reports it on boot (`pinned_agents()`). The wire
 * shape is intentionally small: everything needed to reconcile the pin registry
 * against the fleet snapshot (which row is pinned) is carried, but the durable
 * details (session id, order, pinnedAt) stay Rust-side — the frontend never sees
 * a `claude` session id (the session id never crosses the wire).
 */
export interface PinnedAgentView {
  agentId: AgentId;
  cwd: string;
  title: string;
}

/**
 * `pin_agent` — persist a pin for a root agent. Best-effort (like `saveApiStore`):
 * the store write is the optimistic source of truth for the session, and a
 * dropped persist is re-issued by the next mutation, so a failure is swallowed
 * rather than surfaced. Rust keys the registry by `agentId`.
 */
export async function pinAgent(agentId: AgentId): Promise<void> {
  try {
    await invoke<void>("pin_agent", { agentId });
  } catch {
    /* swallowed — a dropped save is not fatal (the saveApiStore pattern) */
  }
}

/**
 * `unpin_agent` — drop a pin by id. Best-effort, and idempotent on the Rust side,
 * so dismissing a never-pinned agent (or a double-unpin) is harmless.
 */
export async function unpinAgent(agentId: AgentId): Promise<void> {
  try {
    await invoke<void>("unpin_agent", { agentId });
  } catch {
    /* swallowed */
  }
}

/**
 * `pinned_agents` — the durable pin registry, read once on boot to reconcile the
 * `pinned` flag onto the snapshot's rows. NEVER throws: a missing/broken registry
 * yields `[]` (like `loadApiStore`), so boot never fails on persistence.
 */
export async function pinnedAgents(): Promise<PinnedAgentView[]> {
  try {
    return await invoke<PinnedAgentView[]>("pinned_agents", {});
  } catch {
    return [];
  }
}

/**
 * One agent the boot restore brought back (`restored_agents()`, `open_agents.rs`): the
 * rung it came back on and whether the quit interrupted it. Like `PinnedAgentView`, no
 * session id — it never crosses the wire.
 */
export interface RestoredAgentView {
  agentId: AgentId;
  outcome: RestoreOutcome;
  wasWorking: boolean | null;
}

/**
 * `restored_agents` — the "Resumed after restart" markers still standing, read once on
 * boot (Rust drops each at that agent's next turn, end or close, so a webview reload
 * reads the same truth). NEVER throws: a failure yields `[]` — a missing marker is a
 * missing courtesy, never a broken boot.
 */
export async function restoredAgents(): Promise<RestoredAgentView[]> {
  try {
    return await invoke<RestoredAgentView[]>("restored_agents", {});
  } catch {
    return [];
  }
}

/**
 * `agent_resume_session` — the Claude session id to resume a FINISHED root agent
 * with ("↻ Resume"). Rejects with `"not-finished"`,
 * `"not-a-root"` or `"no-session"` (no saved transcript). Same exposure as
 * `list_claude_sessions` (Recover session…), and only for an agent that has ended.
 */
export function agentResumeSession(agentId: AgentId): Promise<string> {
  return invoke<string>("agent_resume_session", { agentId });
}

