/**
 * What an agent did through the `agent-studio` command or MCP tools (Rust `agent_ctl`), as the
 * webview hears it. Rust emits one event per action on `agent-ctl://event`; this module is the
 * only place that knows the event's name and envelope. What each `kind` means is its handler's
 * business (`dispatch.ts`).
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `agent_ctl::EVENT`. */
export const AGENT_CTL_EVENT = "agent-ctl://event";

/**
 * Mirrors `agent_ctl::CtlEvent`: a `kind`, the terminal the agent runs in (an agent's id IS its
 * terminal's id), and the kind's own fields beside them.
 */
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
