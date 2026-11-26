/** The one place an agent is started in a folder, for every launch surface: records the folder
 * as recent (store now, Rust best-effort) and creates the agent there. */

import { useCallback } from "react";

import { useAppStore } from "../../app/store";
import { asTerminalId, type AgentId } from "../../app/types";
import { configureTerminal, type TerminalSpawnOptions } from "../terminal";
import { pushRecentProject } from "./fleetIpc";

/** Optional launch modifiers. Plain launches pass nothing. */
export interface LaunchAgentOptions {
  /** Resume this Claude session; reaches `agent_spawn` via `SpawnOptionsWithResume`. */
  resumeSessionId?: string;
}

/** `configureTerminal` stores the key and `openAgentPty` forwards it to `spawnAgent`. Identical to
 * `TerminalSpawnOptions` (which has the field), but keeps the call typed either way. */
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
        // Merged into the options `createAgent` pre-registered (TerminalId = AgentId). Safe:
        // the PTY opens when <TerminalView> first mounts, after this synchronous handler.
        const patch: SpawnOptionsWithResume = { resumeSessionId };
        configureTerminal(asTerminalId(agentId), patch);
      }
      return agentId;
    },
    [createAgent, addRecentProject],
  );
}
