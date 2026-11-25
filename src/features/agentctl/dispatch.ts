/**
 * Routes each agent-control event to the handler for its `kind`. Each area of the app keeps its
 * handlers in its own file under `handlers/`, so adding a tool never edits another area's code.
 */
import type { AgentCtlEvent } from "./agentCtlIpc";
import { DB_HANDLERS } from "./handlers/db";
import { HTTP_HANDLERS } from "./handlers/http";

export type AgentCtlHandler = (event: AgentCtlEvent) => void;

export const HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  ...DB_HANDLERS,
  ...HTTP_HANDLERS,
};

/** Run the handler for `event.kind`. An unknown kind (a newer app than this webview) is ignored. */
export function dispatchAgentCtl(event: AgentCtlEvent): void {
  const handler = Object.hasOwn(HANDLERS, event.kind) ? HANDLERS[event.kind] : undefined;
  handler?.(event);
}
