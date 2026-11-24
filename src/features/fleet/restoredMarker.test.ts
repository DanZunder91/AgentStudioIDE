/**
 * The marker's words (`restoredMarker.ts`). Asserted against the literal sentences the
 * user reads, never against the module's own helpers: a wrong
 * build that swapped "was working" for "was idle" must go red here.
 *
 * The labels are short by requirement — they sit beside the status pill on a rail row
 * (longer ones were cut mid-word at the default rail width); the
 * "fits" half of that is measured in real layout by `restoredRow.browser.test.tsx`.
 */
import { describe, expect, it } from "vitest";

import { restoredMarkerCopy } from "./restoredMarker";

describe("restoredMarkerCopy", () => {
  it("a resumed agent the quit interrupted says so — and says who has to act", () => {
    expect(restoredMarkerCopy({ outcome: "resumed", wasWorking: true }, null)).toEqual({
      label: "Resumed · was working",
      tooltip:
        "Resumed after restart — same conversation. Agent Studio was closed while it was working — tell it to continue.",
    });
  });

  it("a resumed agent that was idle claims nothing more", () => {
    expect(restoredMarkerCopy({ outcome: "resumed", wasWorking: false }, null)).toEqual({
      label: "Resumed",
      tooltip: "Resumed after restart — same conversation. It was idle when Agent Studio closed.",
    });
  });

  it("after an unclean exit it admits nobody knows", () => {
    expect(restoredMarkerCopy({ outcome: "resumed", wasWorking: null }, undefined)).toEqual({
      label: "Resumed",
      tooltip:
        "Resumed after restart — same conversation. Agent Studio did not close cleanly, so it may have been working — if it was, tell it to continue.",
    });
  });

  it("a fresh one never pretends to be the same conversation", () => {
    expect(restoredMarkerCopy({ outcome: "fresh", wasWorking: false }, null)).toEqual({
      label: "Reopened · new chat",
      tooltip:
        "Reopened after restart in the same folder. Its earlier conversation was never saved, so this is a new one.",
    });
    // Unknown is not "working": only a recorded `true` adds the interruption.
    expect(restoredMarkerCopy({ outcome: "fresh", wasWorking: null }, null).tooltip).not.toContain(
      "while it was working",
    );
    expect(restoredMarkerCopy({ outcome: "fresh", wasWorking: true }, null).tooltip).toBe(
      "Reopened after restart in the same folder. Its earlier conversation was never saved, so this is a new one. Agent Studio was closed while it was working — tell it to continue.",
    );
  });

  it("a dormant one shows Rust's reason as a sentence, and how to make it go away", () => {
    expect(
      restoredMarkerCopy(
        { outcome: "dormant", wasWorking: true },
        "not reopened after the restart: its folder no longer exists: /w/gone",
      ),
    ).toEqual({
      label: "Not reopened",
      tooltip:
        "Not reopened after the restart: its folder no longer exists: /w/gone. Close it and it will not come back next time.",
    });
    expect(restoredMarkerCopy({ outcome: "dormant", wasWorking: null }, null).tooltip).toBe(
      "Agent Studio could not reopen it after the restart. Close it and it will not come back next time.",
    );
  });
});
