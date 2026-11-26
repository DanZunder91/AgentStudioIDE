/** Drag math and listener lifecycle via real pointerdown + window pointermove/up, read back from
 * the store (clamp: `store.test.ts`; pixels: `src/e2e/railChrome.browser.test.tsx`). */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../app/store";
import { resetStore } from "../test/store-harness";
import { RailResizer } from "./RailResizer";

const move = (clientX: number) =>
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: true }));
  });
const up = () =>
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });

beforeEach(() => resetStore());
afterEach(cleanup);

describe("RailResizer", () => {
  it("left: dragging right widens the left rail; drag ends on pointerup", () => {
    render(<RailResizer side="left" />);
    expect(useAppStore.getState().leftRailWidth).toBe(260);

    fireEvent.pointerDown(screen.getByTestId("rail-resizer-left"), { clientX: 100 });
    move(150); // +50 → 310
    expect(useAppStore.getState().leftRailWidth).toBe(310);

    up();
    move(400); // ignored — listeners were removed on pointerup
    expect(useAppStore.getState().leftRailWidth).toBe(310);
  });

  it("right: dragging left widens the right rail (seam moves toward center)", () => {
    render(<RailResizer side="right" />);
    expect(useAppStore.getState().rightRailWidth).toBe(300);

    fireEvent.pointerDown(screen.getByTestId("rail-resizer-right"), { clientX: 500 });
    move(450); // dx = -50 → 300 - (-50) = 350
    expect(useAppStore.getState().rightRailWidth).toBe(350);
    up();
  });

  it("clamps a large drag to the max width", () => {
    render(<RailResizer side="left" />);
    fireEvent.pointerDown(screen.getByTestId("rail-resizer-left"), { clientX: 0 });
    move(5000); // way past the max
    expect(useAppStore.getState().leftRailWidth).toBe(560); // RAIL_MAX_W
    up();
  });

  it("suppresses text selection during the drag and restores it after", () => {
    render(<RailResizer side="left" />);
    expect(document.body.classList.contains("is-resizing")).toBe(false);

    fireEvent.pointerDown(screen.getByTestId("rail-resizer-left"), { clientX: 100 });
    // While dragging, `is-resizing` is on the body — the CSS turns off
    // (`-webkit-`)user-select globally so sweeping over labels can't select them.
    expect(document.body.classList.contains("is-resizing")).toBe(true);

    up();
    // Cleared after the drag ends.
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });
});
