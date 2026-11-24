/**
 * ActivityView — a sub-agent's read-only transcript in the center (M3).
 *
 * Sub-agents run in-process with no PTY, so selecting one opens this instead of
 * a terminal. It fetches `subagent_activity(agentId)` and polls while mounted
 * (the sub-agent may still be running), rendering entries chat-style. It never
 * writes: this is a window onto what the agent is doing, not a place to type.
 */

import { useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import type { ActivityEntry, AgentId, AgentStatus } from "../../app/types";
import { subagentActivity } from "./fleetIpc";
import "./fleet.css";

/** Poll cadence while mounted — the sub-agent may still be producing output. */
const POLL_MS = 1500;

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  running: "running",
  waiting_input: "waiting",
  done: "done",
  error: "error",
};

export function ActivityView({ agentId }: { agentId: AgentId }): React.JSX.Element {
  const status = useAppStore((s) => s.agents[agentId]?.status);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  // No synchronous reset on agentId change: the only mount site (<Pane>) keys
  // this view by agentId, so switching sub-agents REMOUNTS it and `entries`
  // starts empty again — which is why `agentId` need not be a dependency-driven
  // reset here. Keeping the dep is belt-and-braces for a future un-keyed caller.
  useEffect(() => {
    let active = true;
    const load = () => {
      subagentActivity(agentId)
        .then((data) => {
          if (active) setEntries(data);
        })
        .catch(() => {
          // A failed poll leaves the last-known transcript on screen; the next
          // tick retries. Never surface a transient IPC error into the view.
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [agentId]);

  return (
    <div className="activity-view" data-testid="activity-view">
      <header className="activity-view__header">
        <span className="activity-view__label">Activity</span>
        {status && (
          <span className={`activity-view__status activity-view__status--${status}`}>
            {STATUS_LABEL[status]}
          </span>
        )}
      </header>
      {entries.length === 0 ? (
        <div className="activity-view__empty">waiting for activity…</div>
      ) : (
        <ol className="activity-log">
          {entries.map((entry, i) => (
            <li key={i} className={`activity-entry activity-entry--${entry.role}`}>
              <span className="activity-entry__role">{entry.role}</span>
              {entry.tool && <span className="activity-entry__tool">{entry.tool}</span>}
              <span className="activity-entry__text">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
