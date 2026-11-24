/**
 * Real layout: the Columns popover must open INSIDE the panel. Anchored to the button's
 * right edge it ran off the panel's left side and was clipped to a blank box (it showed
 * as an oddly formatted popover). Falsified: `left: 0` → `right: 0` in columns.css makes
 * `left` negative here and this goes red.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/components/columns`
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ColumnsMenu, type ColumnDef } from ".";

const DEFS: ColumnDef[] = [
  { id: "time", label: "Time", width: 80, required: true },
  { id: "host", label: "Host", width: 200 },
];
afterEach(cleanup);

describe("ColumnsMenu placement", () => {
  it("the popover's left edge sits at the button's left edge and stays inside the panel", () => {
    render(
      <div style={{ width: 400, overflow: "hidden", padding: 8 }} data-testid="panel">
        <ColumnsMenu viewKey="browser.cols" defs={DEFS} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Columns ▾" });
    fireEvent.click(button);
    const pop = screen.getByRole("menu").getBoundingClientRect();
    const btn = button.getBoundingClientRect();
    const panel = screen.getByTestId("panel").getBoundingClientRect();
    expect(pop.left).toBeCloseTo(btn.left, 0);
    expect(pop.left).toBeGreaterThanOrEqual(panel.left);
    expect(pop.width).toBeGreaterThanOrEqual(180);
  });
});
