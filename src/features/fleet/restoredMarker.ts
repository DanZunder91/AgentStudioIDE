/**
 * The words on the "Resumed after restart" marker — one place, so the rail row and the
 * agent's tab can never say different things about the same agent.
 *
 * Agents are sometimes still working when the window or the app is closed, for example to
 * update, so the app reopens with every agent that was working before. Phase 1 re-opens
 * them (`src-tauri/src/open_agents.rs`); it does NOT keep them running. So the marker has
 * one job beyond "this came back": to say, honestly, when the quit INTERRUPTED a turn —
 * the agent is sitting at its prompt with half a task done, and only the user can tell it
 * to continue. We never send it a message on their behalf.
 *
 * Three facts decide the copy (say what is real):
 * - the rung it came back on (`resumed` / `fresh` / `dormant`);
 * - whether it was working when the app closed — `true`, `false`, or `null` when the app
 *   did not close cleanly and nobody recorded it;
 * - for a dormant agent, the reason Rust wrote on its row (`AgentNode.error`).
 *
 * The LABEL is short on purpose: it sits beside the status pill on a rail row at the default
 * rail width, and a longer wording ("Reopened after restart · new conversation") was cut off
 * mid-word there. The `↻` both the row and the tab draw in front
 * of it already says "after a restart", so the label only says which way it came back; the
 * tooltip carries the whole sentence. The glyph is NOT part of the label: the label is also the
 * tab glyph's accessible name, and a screen reader should hear "Resumed", not an arrow.
 */

import type { RestoredMarker } from "../../app/types";

export interface RestoredMarkerCopy {
  /** Short, visible on the row after its `↻` (and the tab's `↻` accessible name). */
  label: string;
  /** The whole sentence, on hover. */
  tooltip: string;
}

const INTERRUPTED = "Agent Studio was closed while it was working — tell it to continue.";
const UNKNOWN =
  "Agent Studio did not close cleanly, so it may have been working — if it was, tell it to continue.";

/** Capitalise the first letter: Rust's reasons are written to follow a colon. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function restoredMarkerCopy(
  marker: RestoredMarker,
  error: string | null | undefined,
): RestoredMarkerCopy {
  if (marker.outcome === "dormant") {
    const why = error ? sentence(error) : "Agent Studio could not reopen it after the restart";
    return {
      label: "Not reopened",
      tooltip: `${why}. Close it and it will not come back next time.`,
    };
  }
  if (marker.outcome === "fresh") {
    const tail = marker.wasWorking === true ? ` ${INTERRUPTED}` : "";
    return {
      label: "Reopened · new chat",
      tooltip:
        "Reopened after restart in the same folder. Its earlier conversation was never saved, " +
        `so this is a new one.${tail}`,
    };
  }
  if (marker.wasWorking === true) {
    return {
      label: "Resumed · was working",
      tooltip: `Resumed after restart — same conversation. ${INTERRUPTED}`,
    };
  }
  return {
    label: "Resumed",
    tooltip:
      marker.wasWorking === false
        ? "Resumed after restart — same conversation. It was idle when Agent Studio closed."
        : `Resumed after restart — same conversation. ${UNKNOWN}`,
  };
}
