/** "Resumed after restart" wording, shared by rail row and tab. Restored agents are reopened, not
 * kept running (`open_agents.rs`), so the copy says when a quit interrupted a turn. The label is
 * short to fit beside the pill; `↻` is not in it (the label is the tab glyph's a11y name). */

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
