/** Real layout: anchored popovers flip to the trigger's right edge near the window's right edge
 * and stay left-anchored near the left edge, for both components. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import "../App.css";
import { AppPicker } from "./AppPicker";
import { ColumnsMenu } from "./columns";

afterEach(cleanup);

const at = (side: "left" | "right", node: React.ReactNode) => (
  <div style={{ position: "fixed", top: 20, [side]: 4, display: "flex" }}>{node}</div>
);

describe.each([
  {
    name: "AppPicker",
    ui: () => <AppPicker items={[{ id: "a", label: "localhost" }]} selected={null} onChange={() => {}} label="Filter by host" />,
    open: () => fireEvent.click(screen.getByRole("button", { name: "Filter by host" })),
    pop: () => screen.getByRole("listbox").parentElement as HTMLElement,
  },
  {
    name: "ColumnsMenu",
    ui: () => <ColumnsMenu viewKey="flip.test" defs={[{ id: "a", label: "Host", width: 100 }]} />,
    open: () => fireEvent.click(screen.getByRole("button", { name: "Columns ▾" })),
    pop: () => screen.getByRole("menu"),
  },
])("$name popover", ({ ui, open, pop }) => {
  it("at the window's right edge it flips and stays fully on screen", async () => {
    render(at("right", ui()));
    open();
    await new Promise((r) => requestAnimationFrame(r));
    const r = pop().getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(window.innerWidth);
    expect(r.left).toBeGreaterThanOrEqual(0);
  });

  it("inside a clipping pane whose right edge is near, it flips and stays inside the pane", async () => {
    render(
      <div data-testid="pane" style={{ position: "fixed", top: 20, left: 0, width: 320, height: 400, overflow: "hidden" }}>
        <div style={{ position: "absolute", right: 4, top: 4 }}>{ui()}</div>
      </div>,
    );
    open();
    await new Promise((r) => requestAnimationFrame(r));
    const pane = screen.getByTestId("pane").getBoundingClientRect();
    expect(pop().getBoundingClientRect().right).toBeLessThanOrEqual(pane.right);
  });

  it("at the window's left edge it stays left-anchored and on screen", async () => {
    render(at("left", ui()));
    open();
    await new Promise((r) => requestAnimationFrame(r));
    const r = pop().getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.left).toBeLessThan(40);
  });
});
