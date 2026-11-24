/**
 * useLaunchAgent — the one place an agent is started in a folder.
 *
 * Every launch surface (the rail header `+` picker, the ⚡ quick-launch, a
 * folder header's `+`, the session picker's "recover") funnels through
 * here so they cannot drift:
 *   - record the folder as recent, in the store (immediate) AND in Rust
 *     (persisted `push_recent_project`), so ⚡ and folder ordering track usage;
 *   - create the agent in that folder.
 *
 * The Rust push is best-effort — a failure must not stop the agent launching.
 */

import { useCallback } from "react";

import { useAppStore } from "../../app/store";
import { asTerminalId, type AgentId } from "../../app/types";
import { configureTerminal, type TerminalSpawnOptions } from "../terminal";
import { pushRecentProject } from "./fleetIpc";

/** Optional launch modifiers. Plain launches pass nothing. */
export interface LaunchAgentOptions {
  /**
   * Resume an existing Claude session instead of starting fresh ("Recover
   * session"). Forwarded to `agent_spawn` via the registry's
   * pre-registration seam — see the note on `SpawnOptionsWithResume`.
   */
  resumeSessionId?: string;
}

/**
 * `TerminalSpawnOptions` plus the resume key.
 *
 * `configureTerminal` STORES the key (it merges options verbatim) and
 * `openAgentPty` passes `resumeSessionId: spawn.resumeSessionId` to
 * `spawnAgent`. `TerminalSpawnOptions` declares the optional field itself, so
 * this alias is redundant-but-identical; it keeps the call typed either way.
 */
type SpawnOptionsWithResume = TerminalSpawnOptions & { resumeSessionId?: string };

export function useLaunchAgent(): (cwd: string, opts?: LaunchAgentOptions) => AgentId {
  const createAgent = useAppStore((s) => s.agentActions.createAgent);
  const addRecentProject = useAppStore((s) => s.workspaceActions.addRecentProject);

  return useCallback(
    (cwd: string, opts?: LaunchAgentOptions): AgentId => {
      addRecentProject(cwd);
      void pushRecentProject(cwd).catch(() => {
        // Persisting recents is a nicety; never block the launch on it.
      });
      const agentId = createAgent({ cwd });
      const resumeSessionId = opts?.resumeSessionId;
      if (resumeSessionId) {
        // Merge the resume key into the spawn options `createAgent` just
        // pre-registered (an agent terminal's TerminalId IS its AgentId, and
        // `configureTerminal` merges `{...previous, ...opts}`). Ordering is
        // safe by construction: the PTY opens lazily when <TerminalView>
        // first mounts — strictly after this synchronous handler — so the
        // merge always lands before `agent_spawn` fires.
        const patch: SpawnOptionsWithResume = { resumeSessionId };
        configureTerminal(asTerminalId(agentId), patch);
      }
      return agentId;
    },
    [createAgent, addRecentProject],
  );
}
