/**
 * What an agent did through the `agent-studio` command (Rust `agent_ctl`), as the webview hears
 * it. Rust emits one event per action on `agent-ctl://event`; this module is the only place that
 * knows the event's name and shape.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `agent_ctl::EVENT`. */
export const AGENT_CTL_EVENT = "agent-ctl://event";

/** Mirrors `agent_ctl::CtlEvent` (serde `tag = "kind"`, camelCase). */
export type AgentCtlEvent = {
  kind: "dbConnection";
  connectionId: string;
  /** The terminal the agent runs in. An agent's id IS its terminal's id. */
  terminalId: string;
  /** `false`: the connection was already saved, and was only opened. */
  created: boolean;
};

/** Subscribe for the process's lifetime. Events of a kind this build does not know are dropped. */
export function listenAgentCtl(handler: (event: AgentCtlEvent) => void): Promise<UnlistenFn> {
  return listen<AgentCtlEvent>(AGENT_CTL_EVENT, (event) => {
    if (event.payload?.kind === "dbConnection") handler(event.payload);
  });
}
