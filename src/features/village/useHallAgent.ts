/**
 * Whose context window the Seats hall seats — the Village's Seats house and the City's hall under
 * the lounge: the agent selected in the rail. The reading is the Context card's (`contextStore`), taken the
 * card's own way and no other: on selection (and when the picture comes back on screen), and again
 * when the agent's turn ends (`noteAgentStatus`) — never on a timer. Each read is one local
 * `claude -p --resume … "/context"` (no model call, no tokens; read-only — the app never writes `~/.claude`), and the
 * store's single-flight folds the card's and the hall's reads of one agent into one process.
 */

import { useEffect, useMemo } from "react";

import { useAppStore } from "../../app/store";
import type { AgentNode } from "../../app/types";
import { noteAgentStatus, useContextStore } from "../context/contextStore";
import type { HallAgent } from "./capacityModel";

/** The rail's selection as the hall sees it: nothing, a sub-agent (no reading of its own), or a root it can read. */
export function hallAgentOf(agent: AgentNode | null): HallAgent {
  if (agent === null) return { kind: "none" };
  const label = agent.customTitle ?? agent.title;
  if (agent.parentId !== null) return { kind: "sub-agent", label };
  return { kind: "ready", agentId: agent.id, label };
}

/**
 * The hall's agent, reading its context while `enabled` (the Village or the City on screen). The
 * returned object is stable until the selection or its name changes.
 */
export function useHallAgent(enabled: boolean): HallAgent {
  // The agent OBJECT (a stable reference until it changes), never a freshly built one per call.
  const agent = useAppStore((s) => {
    const id = s.selection.selectedAgentId;
    return id === null ? null : (s.agents[id] ?? null);
  });
  const refresh = useContextStore((s) => s.refresh);
  const next = hallAgentOf(agent);
  const kind = next.kind;
  const label = next.kind === "none" ? "" : next.label;
  const agentId = next.kind === "ready" ? next.agentId : null;
  // "ready" is only ever made from a non-null agent (`hallAgentOf`).
  const status = next.kind === "ready" ? (agent as AgentNode).status : null;

  useEffect(() => {
    if (enabled && agentId !== null) void refresh(agentId);
  }, [enabled, agentId, refresh]);
  useEffect(() => {
    if (enabled && agentId !== null && status !== null) noteAgentStatus(agentId, status);
  }, [enabled, agentId, status]);

  return useMemo<HallAgent>(() => {
    if (kind === "none") return { kind };
    if (kind === "sub-agent") return { kind, label };
    return { kind, agentId: agentId as string, label };
  }, [kind, agentId, label]);
}
