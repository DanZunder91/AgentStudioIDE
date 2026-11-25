/** API-client tool events (Rust `agent_ctl::commands::http` and `::stream`). */
import type { AgentCtlHandler } from "../dispatch";

export const HTTP_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {};
