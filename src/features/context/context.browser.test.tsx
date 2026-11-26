/** Real-pixel geometry jsdom can't check: segment widths, marker position, the 20x10 grid, legend
 * wrapping. Uses the harness's canned context_usage, which also proves that mock is registered.
 * Browser tier: run with --config vitest.browser.config.ts. */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../../App.css";
import { useAppStore } from "../../app/store";
import { asAgentId } from "../../app/types";
import {
  CANNED_CONTEXT_USAGE,
  installE2EHarness,
  resetE2E,
  teardownE2E,
  type E2EHarness,
} from "../../e2e/harness";
import { wireAgent } from "../../test/fleet-harness";
import { ContextCard, ContextGrid, ContextStackedBar } from "./ContextBar";

const NOW = CANNED_CONTEXT_USAGE.measuredAtMs + 60_000;

function Host({ width, children }: { width: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid="host" style={{ width: `${width}px`, display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

/** A selected root agent — the card measures it by agent id. */
function selectRoot(): void {
  const id = asAgentId("root-a");
  act(() => {
    useAppStore.setState((s) => {
      s.agents[id] = {
        ...wireAgent({ id, cwd: "/projects/fixture" }),
        childIds: [],
        sessionId: null,
        expanded: false,
        unread: 0,
      };
      s.rootAgentIds = [id];
      s.selection.selectedAgentId = id;
    });
  });
}

describe("context-window card — real browser geometry", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });
  afterEach(() => {
    teardownE2E(h.ipc);
  });

  it.each([600, 260])("at %ipx each bar segment is tokens / window of the bar's width", (width) => {
    render(
      <Host width={width}>
        <ContextStackedBar usage={CANNED_CONTEXT_USAGE} />
      </Host>,
    );
    const bar = screen.getByTestId("context-bar").getBoundingClientRect();
    expect(bar.width).toBeCloseTo(width, 0); // full-width, and non-degenerate

    const segs = screen.getAllByTestId("context-seg");
    CANNED_CONTEXT_USAGE.categories.forEach((c, i) => {
      const box = segs[i].getBoundingClientRect();
      const expected = (c.tokens / CANNED_CONTEXT_USAGE.windowTokens) * bar.width;
      expect(Math.abs(box.width - expected), `${c.key} width`).toBeLessThan(0.5);
      // ...and they are laid end to end in printed order.
      if (i > 0) expect(Math.abs(box.left - segs[i - 1].getBoundingClientRect().right)).toBeLessThan(0.5);
    });
    // Messages vs system tools, as a ratio: the eye compares segments, not pixels.
    const ratio = segs[5].getBoundingClientRect().width / segs[1].getBoundingClientRect().width;
    expect(ratio).toBeCloseTo(257_900 / 20_400, 1);
  });

  it("the compaction marker sits exactly where the hatched buffer begins (= window − 33k)", () => {
    render(
      <Host width={500}>
        <ContextStackedBar usage={CANNED_CONTEXT_USAGE} />
      </Host>,
    );
    const bar = screen.getByTestId("context-bar").getBoundingClientRect();
    const marker = screen.getByTestId("context-marker").getBoundingClientRect();
    const buffer = screen
      .getAllByTestId("context-seg")
      .find((s) => s.dataset.key === "autocompact-buffer")!
      .getBoundingClientRect();
    const markerCentre = marker.left + marker.width / 2;
    expect(Math.abs(markerCentre - buffer.left)).toBeLessThan(1);
    expect(Math.abs(markerCentre - bar.left - 0.967017 * bar.width)).toBeLessThan(1);
    expect(marker.height).toBeCloseTo(bar.height, 0);
  });

  it.each([400, 160])("at %ipx the grid is 20 columns × 10 rows and never wider than its pane", (width) => {
    render(
      <Host width={width}>
        <ContextGrid usage={CANNED_CONTEXT_USAGE} />
      </Host>,
    );
    const cells = screen.getAllByTestId("context-cell");
    expect(cells).toHaveLength(200);
    const lefts = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left)));
    const tops = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(lefts.size).toBe(20);
    expect(tops.size).toBe(10);

    const host = screen.getByTestId("host").getBoundingClientRect();
    const grid = screen.getByTestId("context-grid");
    const rightmost = Math.max(...cells.map((c) => c.getBoundingClientRect().right));
    expect(rightmost).toBeLessThanOrEqual(host.right + 0.5);
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth + 1);
    // Cells stay square and visible even when squeezed.
    const box = cells[0].getBoundingClientRect();
    expect(box.width).toBeGreaterThan(2);
    expect(Math.abs(box.width - box.height)).toBeLessThan(0.5);
  });

  it("in a narrow pane the whole card wraps — legend on several lines, no horizontal scroll", async () => {
    selectRoot();
    render(
      <Host width={220}>
        <ContextCard nowMs={NOW} />
      </Host>,
    );
    // The harness's canned answer, not the "unmocked command" error.
    expect(await screen.findByTestId("context-bar")).toBeInTheDocument();
    expect(h.ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });

    const card = screen.getByTestId("context-card");
    const cardBox = card.getBoundingClientRect();
    expect(cardBox.width).toBeCloseTo(220, 0);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);

    const items = screen.getAllByTestId("context-legend-item");
    const rows = new Set(items.map((li) => Math.round(li.getBoundingClientRect().top)));
    expect(rows.size).toBeGreaterThan(2);
    for (const el of [...items, screen.getByTestId("context-refresh"), screen.getByTestId("context-chip")]) {
      expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(cardBox.right + 0.5);
    }
  });

  it("in a wide pane the header is one row and the legend fits on few lines", async () => {
    selectRoot();
    render(
      <Host width={900}>
        <ContextCard nowMs={NOW} />
      </Host>,
    );
    await screen.findByTestId("context-bar");
    const brand = screen.getByText("context").getBoundingClientRect();
    const chip = screen.getByTestId("context-chip").getBoundingClientRect();
    // Same row: vertical centres within a few pixels; chip at the right.
    expect(Math.abs(brand.top + brand.height / 2 - (chip.top + chip.height / 2))).toBeLessThan(4);
    expect(chip.left).toBeGreaterThan(brand.right);
    const rows = new Set(
      screen.getAllByTestId("context-legend-item").map((li) => Math.round(li.getBoundingClientRect().top)),
    );
    expect(rows.size).toBeLessThanOrEqual(2);
  });
});
