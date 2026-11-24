/**
 * Layer 5 (testing-strategy §1) — the usage strip's FOOTER geometry, in real pixels.
 *
 * These are the claims jsdom cannot check: the strip belongs in the rail's FOOTER,
 * not at its TOP, and that placement is easy to get wrong. Document order is
 * pinned in `LeftRail.test.tsx`; being pinned to the BOTTOM is a layout fact —
 * `margin-top:auto` inside a flex column — and under jsdom every box here would
 * be 0×0, which makes the assertion vacuous rather than wrong.
 *
 * Three things are measured:
 *  1. The strip sits at the bottom of the rail, not directly under the last agent
 *     row (i.e. the flex column + `margin-top:auto` actually took effect).
 *  2. It does not overflow the ~260px rail horizontally — the rail-clipping regression, and
 *     the reason `.rail` carries `overflow-x: hidden`. A percentage chip plus a
 *     label is exactly the kind of two-column row that broke Vault.
 *  3. It renders real numbers from the (mocked) command, coloured per band.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import {
  CANNED_USAGE,
  installE2EHarness,
  resetE2E,
  settle,
  teardownE2E,
  type E2EHarness,
} from "./harness";

describe("usage strip — real browser geometry", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });
  afterEach(() => {
    teardownE2E(h.ipc);
  });

  it("is pinned to the BOTTOM of the left rail, not stacked under the agents list", async () => {
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const rail = screen.getByTestId("left-rail");
    const panel = await screen.findByTestId("usage-panel");

    const railBox = rail.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();

    // Sanity: with a real layout engine these are non-degenerate. Without this,
    // every comparison below would pass trivially on a 0×0 box.
    expect(railBox.height).toBeGreaterThan(100);
    expect(panelBox.height).toBeGreaterThan(0);

    // THE assertion: the strip's bottom edge is flush with the rail's bottom
    // (1px of tolerance for sub-pixel rounding), which can only be true if
    // `margin-top:auto` pushed it down past the empty agents area.
    expect(Math.abs(railBox.bottom - panelBox.bottom)).toBeLessThanOrEqual(1);

    // And it is genuinely in the LOWER half — the failure mode we are guarding
    // against (a top placement) would put it at railBox.top.
    expect(panelBox.top).toBeGreaterThan(railBox.top + railBox.height / 2);
  });

  it("never overflows the rail horizontally (the rail-clipping regression)", async () => {
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const rail = screen.getByTestId("left-rail");
    const panel = await screen.findByTestId("usage-panel");

    // The rail itself must not gain a horizontal scroll…
    expect(rail.scrollWidth).toBeLessThanOrEqual(rail.clientWidth);
    // …and neither may the strip, whose rows are a label + a right-aligned chip
    // (exactly the two-column shape that broke the Vault panel at this width).
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);

    // Every row stays inside the rail's content box.
    const railBox = rail.getBoundingClientRect();
    for (const row of screen.getAllByTestId("usage-row")) {
      const box = row.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(railBox.left - 1);
      expect(box.right).toBeLessThanOrEqual(railBox.right + 1);
    }
  });

  it("renders the command's real numbers, one row per window, coloured by band", async () => {
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const rows = await screen.findAllByTestId("usage-row");
    expect(rows).toHaveLength(CANNED_USAGE.windows.length);

    // Labels + percentages come from the command, in its order.
    for (const [i, w] of CANNED_USAGE.windows.entries()) {
      expect(rows[i]).toHaveTextContent(w.label);
      expect(rows[i]).toHaveTextContent(`${w.usedPct}% used`);
    }

    // The fixture straddles all three bands (41 / 62 / 96), so this proves the
    // tone plumbing survives the real CSS as well as the unit tests.
    const tones = screen.getAllByTestId("usage-chip").map((c) => c.getAttribute("data-tone"));
    expect(tones).toEqual(["ok", "warn", "danger"]);

    // And the three tones are visually DISTINCT once the real stylesheet is
    // applied — a colour that failed to load would collapse them to one value.
    const colours = screen
      .getAllByTestId("usage-chip")
      .map((c) => getComputedStyle(c).color);
    expect(new Set(colours).size).toBe(3);
  });
});
