/** Subscribes to nothing: the parent row already reads the status, and a second subscription
 * would double work on the hottest render path. */

import type { AgentStatus } from "../../app/types";
import "./fleet.css";

/** Glyph + label per status: 🤖 idle (parked at its prompt), ⚡ running. */
const PRESENTATION: Record<AgentStatus, { label: string; glyph: string }> = {
  idle: { label: "Idle", glyph: "🤖" },
  running: { label: "Running", glyph: "⚡" },
  waiting_input: { label: "Waiting", glyph: "⏳" },
  done: { label: "Done", glyph: "✓" },
  error: { label: "Error", glyph: "✕" },
};

export function AgentStatusPill({ status }: { status: AgentStatus }) {
  const { label, glyph } = PRESENTATION[status];
  // Every status now carries a glyph, so it always renders — no `glyph &&`
  // guard, which would be a dead (never-false) branch now that idle has the robot.
  return (
    <span className={`fleet-pill fleet-pill--${status}`}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
