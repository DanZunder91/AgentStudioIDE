/** "↻ Resume conversation" for a root whose `claude` ended: Rust resolves its saved session and a
 * new agent starts via the `resumeSessionId` path, same folder. A refusal is written into the
 * ended agent's terminal, not swallowed. */
import { useCallback } from "react";

import { asTerminalId, type AgentId } from "../../app/types";
import { logWarn } from "../logs/logStore";
import { writeTerminalNotice } from "../terminal/TerminalRegistry";
import { agentResumeSession } from "./fleetIpc";
import { useLaunchAgent } from "./useLaunchAgent";

/** Plain-language reasons, keyed by the Rust error code. */
export const RESUME_REFUSALS: Record<string, string> = {
  "no-session": "Can't resume: this agent has no saved conversation yet.",
  "not-finished": "This agent is still running — there is nothing to resume.",
  "not-a-root": "Only a root agent can be resumed; its sub-agents come back with it.",
};

export function resumeRefusal(err: unknown): string {
  const code = String(err instanceof Error ? err.message : err).split(":")[0].trim();
  return RESUME_REFUSALS[code] ?? `Can't resume: ${String(err)}`;
}

export function useResumeAgent(): (agentId: AgentId, cwd: string) => Promise<AgentId | null> {
  const launch = useLaunchAgent();
  return useCallback(
    async (agentId: AgentId, cwd: string): Promise<AgentId | null> => {
      try {
        const resumeSessionId = await agentResumeSession(agentId);
        return launch(cwd, { resumeSessionId });
      } catch (err) {
        const text = resumeRefusal(err);
        writeTerminalNotice(asTerminalId(agentId), text);
        logWarn("fleet", text, String(err));
        return null;
      }
    },
    [launch],
  );
}
