/**
 * The status pill: 🤖 Idle / ⚡ Running / ⏳ Waiting / ✓ Done / ✕ Error.
 *
 * Subscribes to nothing — its parent row already reads the status it needs, and
 * a second subscription for the same field would double the re-render work on
 * the hottest path in the app (one pill per agent, per telemetry tick).
 */

import type { AgentStatus } from "../../app/types";
import "./fleet.css";

/**
 * Glyph + label per status — every state carries a distinct, at-a-glance icon
 * (turn hooks). `idle` is the robot 🤖 (agent parked at its prompt, nothing
 * running); `running` the ⚡ bolt (actively working). The bolt used to be latched
 * on forever because idle was never emitted — the turn hooks also wire the transition
 * (see the hook-driven status pipeline), so the robot actually appears now.
 */
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
