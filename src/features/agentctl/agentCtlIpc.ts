/** Agent actions via the `agent-studio` command or MCP tools (Rust `agent_ctl`), one event each
 * on `agent-ctl://event`; only this module knows that name and envelope. Kinds: `dispatch.ts`. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `agent_ctl::EVENT`. */
export const AGENT_CTL_EVENT = "agent-ctl://event";

/** Mirrors `agent_ctl::CtlEvent`: `kind`, the agent's terminal (its id IS the agent's id), and
 * the kind's own fields. */
export type AgentCtlEvent = { kind: string; terminalId: string } & Record<string, unknown>;

/** Subscribe for the process's lifetime. A payload without a string `kind` is dropped. */
export function listenAgentCtl(handler: (event: AgentCtlEvent) => void): Promise<UnlistenFn> {
  return listen<AgentCtlEvent>(AGENT_CTL_EVENT, (event) => {
    const p = event.payload as Partial<AgentCtlEvent> | null;
    if (p !== null && typeof p.kind === "string" && typeof p.terminalId === "string") {
      handler(p as AgentCtlEvent);
    }
  });
}
