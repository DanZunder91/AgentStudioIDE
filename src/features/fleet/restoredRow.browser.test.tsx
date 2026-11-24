/**
 * Layer 5 — the "↻ Resumed" marker on a rail row is COMPLETE at the default rail width.
 *
 * An earlier, longer wording was cut off mid-word in real layout:
 * "Reopened after restart · new conversati". Two things were wrong, and only real
 * layout can see either:
 *   1. the words were longer than the room beside the status pill;
 *   2. the status line was inline flow, so the marker WRAPPED onto a line of its own and ran
 *      off the rail's edge — its `text-overflow: ellipsis` never applied (an inline box has no
 *      width of its own to overflow).
 * jsdom has no layout (every width is 0), so this is the only tier where "it fits" is a claim.
 *
 * What is asserted, per marker, for every outcome the restore can produce, beside the pill it
 * actually sits next to (Idle, Error for a dormant one, and the widest, Waiting):
 *   - at the default width: it is NOT truncated (its text is not wider than its box), it sits
 *     on the PILL'S line (the wrap that pushed it under the pill is the bug), it ends inside its
 *     row, and it carries the tab's `↻` — as generated content, so its text stays exactly the
 *     label the tab's glyph is named by;
 *   - two-sided: the same measurement on the old wording ("Reopened after restart · new
 *     conversation") finds it wrapped or cut — otherwise the room it measures proves nothing;
 *   - at the narrowest width the rail allows: the words move under the pill, still whole, and
 *     words too long even for a line of their own end in an ellipsis inside the row (with the
 *     sentence on hover) — never cut at the rail's edge.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../App";
import { RAIL_MIN_W, useAppStore } from "../../app/store";
import { asAgentId, type AgentId, type AgentStatus, type RestoreOutcome } from "../../app/types";
import { disposeAll } from "../terminal";
import { wireAgent } from "../../test/fleet-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";

async function settle(ms = 150): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

/** The E2E fixture folder — a realistic depth for the row's subtitle, which shares nothing with the status line. */
const CWD = "/repo/e2e/fixtures/workspace";

const ROWS: { id: AgentId; status: AgentStatus; outcome: RestoreOutcome; wasWorking: boolean | null }[] = [
  { id: asAgentId("01J0ROWFIT00000000000000A"), status: "idle", outcome: "resumed", wasWorking: true },
  { id: asAgentId("01J0ROWFIT00000000000000B"), status: "idle", outcome: "fresh", wasWorking: false },
  { id: asAgentId("01J0ROWFIT00000000000000C"), status: "error", outcome: "dormant", wasWorking: null },
  { id: asAgentId("01J0ROWFIT00000000000000D"), status: "waiting_input", outcome: "resumed", wasWorking: true },
  { id: asAgentId("01J0ROWFIT00000000000000E"), status: "idle", outcome: "resumed", wasWorking: null },
];

interface Fit {
  text: string;
  glyph: string;
  truncated: boolean;
  onPillLine: boolean;
  insideRow: boolean;
  /** Pixels between the pill's right edge and the marker, when they share a line. */
  gapAfterPill: number;
  /** Its words' middle level with the pill's (±1.5 px), when they share a line. */
  centred: boolean;
}

/** The rail row titled `title` (rows carry no id attribute; the title is what the user reads). */
function rowTitled(title: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="left-rail"] li.fleet-row')).find(
    (li) => li.querySelector(".fleet-row__title")?.textContent?.trim() === title,
  );
  if (!row) throw new Error(`no rail row titled ${title}`);
  return row;
}

function measure(title: string): Fit {
  const row = rowTitled(title);
  const marker = row.querySelector<HTMLElement>(".fleet-row__restored");
  const pill = row.querySelector<HTMLElement>(".fleet-row__status > .fleet-pill");
  if (!marker || !pill) throw new Error(`row ${title} has no marker or no pill`);
  const m = marker.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  // The WORDS' box, not the element's: a stretched flex item is as tall as the pill whatever
  // its text does, so only the text's own rectangle shows whether the words sit level with it.
  const range = document.createRange();
  range.selectNodeContents(marker);
  const t = range.getBoundingClientRect();
  return {
    text: marker.textContent ?? "",
    glyph: getComputedStyle(marker, "::before").content,
    // A box narrower than its text is a truncated (ellipsised or clipped) one.
    truncated: marker.scrollWidth > marker.clientWidth,
    // Same line = vertically overlapping the pill. Under it = wrapped.
    onPillLine: m.top < p.bottom && m.bottom > p.top,
    insideRow: m.right <= r.right,
    gapAfterPill: Math.round(m.left - p.right),
    centred: Math.abs((t.top + t.bottom) / 2 - (p.top + p.bottom) / 2) <= 1.5,
  };
}

describe("rail row — the restored marker is complete at the default rail width", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    resetStore();
    ipc = installTauriMock();
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  function mount(): void {
    act(() => {
      const fleet = useAppStore.getState().agentActions;
      fleet.applyFleetSnapshot(
        ROWS.map((r, i) => wireAgent({ id: r.id, title: `agent-${"ABCDE"[i]}`, status: r.status, cwd: CWD })),
      );
      fleet.applyRestoredAgents(ROWS.map((r) => ({ agentId: r.id, outcome: r.outcome, wasWorking: r.wasWorking })));
    });
    render(<App />);
  }

  it("every outcome's words fit beside its pill, whole, with the tab's ↻ in front", async () => {
    mount();
    await settle();
    // The rail really is at its default width — the width a real-sized window has.
    expect(useAppStore.getState().leftRailWidth).toBe(260);
    expect(Math.round(document.querySelector<HTMLElement>('[data-testid="left-rail"]')!.getBoundingClientRect().width)).toBe(260);

    const seen = Object.fromEntries(ROWS.map((_, i) => ["ABCDE"[i], measure(`agent-${"ABCDE"[i]}`)]));
    const whole = {
      truncated: false,
      onPillLine: true,
      insideRow: true,
      gapAfterPill: 8,
      centred: true,
      glyph: '"↻\u00a0"', // the ↻ and a no-break space
    };
    expect(seen).toEqual({
      A: { text: "Resumed · was working", ...whole },
      B: { text: "Reopened · new chat", ...whole },
      C: { text: "Not reopened", ...whole },
      D: { text: "Resumed · was working", ...whole },
      E: { text: "Resumed", ...whole },
    });
  });

  it("the same measurement finds the OLD words cut — so the room it measures is real", async () => {
    mount();
    await settle();
    // Agent B came back fresh: put the first wording back on its marker, nothing else changed.
    const marker = rowTitled("agent-B").querySelector<HTMLElement>(".fleet-row__restored");
    expect(marker?.textContent).toBe("Reopened · new chat");
    marker!.textContent = "Reopened after restart · new conversation";
    const old = measure("agent-B");
    // Wrapped under the pill, or cut: either is the bug.
    expect(old.truncated || !old.onPillLine).toBe(true);
  });

  it("in the narrowest rail the words move under the pill, whole — and words too long even for that end in an ellipsis, never cut at the edge", async () => {
    mount();
    act(() => useAppStore.getState().uiActions.setLeftRailWidth(RAIL_MIN_W));
    await settle();
    expect(Math.round(document.querySelector<HTMLElement>('[data-testid="left-rail"]')!.getBoundingClientRect().width)).toBe(RAIL_MIN_W);
    // Where the real words no longer fit beside the pill, they move UNDER it, whole — the row
    // keeps "was working" readable rather than cutting it beside the pill.
    const real = Object.fromEntries(
      ROWS.map((_, i) => {
        const { truncated, insideRow } = measure(`agent-${"ABCDE"[i]}`);
        return ["ABCDE"[i], { truncated, insideRow }];
      }),
    );
    const whole = { truncated: false, insideRow: true };
    expect(real).toEqual({ A: whole, B: whole, C: whole, D: whole, E: whole });
    // …and at least the longest did have to move: this width really is narrower than its line.
    expect(measure("agent-D").onPillLine).toBe(false);
    // The worst case the marker can meet: long words (the first wording) beside the widest pill.
    const marker = rowTitled("agent-D").querySelector<HTMLElement>(".fleet-row__restored")!;
    marker.textContent = "Reopened after restart · new conversation";
    const narrow = measure("agent-D");
    expect(narrow, "shrunk to an ellipsis, inside its row").toMatchObject({ truncated: true, insideRow: true });
    expect(getComputedStyle(marker).textOverflow).toBe("ellipsis");
    // What the ellipsis hides is on hover, whole.
    expect(marker.title).toBe(
      "Resumed after restart — same conversation. Agent Studio was closed while it was working — tell it to continue.",
    );
  });
});
