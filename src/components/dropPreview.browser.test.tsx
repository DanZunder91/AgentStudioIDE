/** Drop preview in real pixels (testing-strategy §1, §7.5): the preview must equal the landing box,
 * which prunes the emptied source (with 2 panes the survivor fills the container). jsdom measures
 * 0x0, so only real Chromium can assert it; drive the whole drag path, not just the target. */

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import { useAppStore } from "../app/store";
import { disposeAll } from "../features/terminal";
import type { PaneId, TabId } from "../app/types";
import { installTauriMock, type TauriMock } from "../test/tauri-mock";
import {
  bodyOf,
  DragGesture,
  dropPreview,
  geometryOf,
  leafPaneIds,
  paneOfTab,
  panes,
  tabElement,
  type Edge,
  type Geometry,
} from "../test/layout-browser";
import { resetStore } from "../test/store-harness";

/** Let layout and async effects land: rAF → ResizeObserver → allotment `layout()` → the terminal
 * registry's RO → its 50ms fit debounce. */
async function settle(ms = 250): Promise<void> {
  await act(async () => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

function openTab(paneId?: PaneId): TabId {
  let id!: TabId;
  act(() => {
    id = useAppStore.getState().layoutActions.openTerminalTab(paneId ? { paneId } : undefined);
  });
  return id;
}

function splitPane(paneId: PaneId, orientation: "row" | "column"): PaneId {
  let id!: PaneId;
  act(() => {
    id = useAppStore.getState().layoutActions.splitPane(paneId, orientation);
  });
  return id;
}

/** Drag over the centre of `body` — the "join this group" zone. */
async function hoverCentre(gesture: DragGesture, body: HTMLElement): Promise<void> {
  const r = body.getBoundingClientRect();
  await act(async () => {
    body.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: gesture.dataTransfer,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  });
}

/** Two rects agree to within a pixel of rounding. */
function expectSameBox(actual: Geometry, expected: Geometry, what: string): void {
  for (const k of ["left", "top", "width", "height"] as const) {
    expect(
      actual[k],
      `${what}: ${k} — preview ${JSON.stringify(actual)} vs result ${JSON.stringify(expected)}`,
    ).toBeCloseTo(expected[k], 0);
  }
}

describe("drop preview — what you see is what you get", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    resetStore();
    ipc = installTauriMock();
    ipc
      .handle("terminal_open", (args) => ({
        id: args.terminalId,
        kind: "terminal",
        title: "sh",
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        status: "live",
      }))
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  /** N panes side by side, one terminal tab each, laid out and fitted. */
  async function build(n: number): Promise<TabId[]> {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await settle(150);

    let leaf = leafPaneIds()[0];
    const tabs = [openTab(leaf)];
    for (let i = 1; i < n; i++) {
      leaf = splitPane(leaf, "row");
      tabs.push(openTab(leaf));
    }
    await settle();
    expect(leafPaneIds()).toHaveLength(n);
    return tabs;
  }

  /** 2 panes (the collapse) and 3 (pruning still redistributes shares), so a fix that only
   * special-cases the collapse fails. */
  describe.each([2, 3])("%i panes", (n) => {
    describe.each<Edge>(["left", "right", "top", "bottom"])("drop on the %s edge", (edge) => {
      it("previews exactly the box the tab lands in", async () => {
        const tabs = await build(n);
        const [dragged, target] = tabs;

        const targetBody = bodyOf(paneOfTab(target));
        const gesture = await new DragGesture(tabElement(dragged)).start();
        await gesture.over(targetBody, edge);

        const overlay = dropPreview();
        expect(overlay, "a drag over a pane edge must preview where the tab lands").not.toBeNull();
        const previewBox = geometryOf(overlay!);
        expect(previewBox.width, "preview must have real geometry").toBeGreaterThan(0);
        expect(previewBox.height, "preview must have real geometry").toBeGreaterThan(0);

        await gesture.drop(targetBody, edge);
        await settle();

        // Where the dragged tab actually ended up.
        const landedBox = geometryOf(paneOfTab(dragged));
        expectSameBox(previewBox, landedBox, `${n} panes, ${edge} edge`);
      });
    });
  });

  /** Absolute numbers, not a relation: the failure names the bug; making BOTH wrong can't pass. */
  it("2 panes, drop on the bottom edge: the preview spans the FULL width, not the hovered pane's half", async () => {
    const [dragged, target] = await build(2);

    const container = geometryOf(document.querySelector(".center .split-view")!);
    const targetPaneBox = geometryOf(paneOfTab(target));
    // Precondition: the panes really are side by side, each half the width.
    expect(targetPaneBox.width).toBeCloseTo(container.width / 2, 0);

    const targetBody = bodyOf(paneOfTab(target));
    const gesture = await new DragGesture(tabElement(dragged)).start();
    await gesture.over(targetBody, "bottom");

    const previewBox = geometryOf(dropPreview()!);

    // The drop prunes the emptied source leaf, the root split collapses to its
    // one surviving child, and the survivor fills the container — so the tab
    // lands in the bottom half of the WHOLE work area, not of the hovered pane.
    expect(
      previewBox.width,
      "preview drew the hovered pane's half-width — the half-screen preview bug",
    ).toBeCloseTo(container.width, 0);
    expect(previewBox.height).toBeCloseTo(container.height / 2, 0);
    expect(previewBox.top).toBeCloseTo(container.top + container.height / 2, 0);

    await gesture.drop(targetBody, "bottom");
    await settle();
    expectSameBox(previewBox, geometryOf(paneOfTab(dragged)), "2-pane bottom-edge case");
  });

  /** A centre drop collapses the tree too: with 2 panes the hovered pane's `inset: 0` is half. */
  it("2 panes, centre drop: the preview spans the full container", async () => {
    const [dragged, target] = await build(2);

    const container = geometryOf(document.querySelector(".center .split-view")!);
    const targetBody = bodyOf(paneOfTab(target));

    const gesture = await new DragGesture(tabElement(dragged)).start();
    await hoverCentre(gesture, targetBody);

    const previewBox = geometryOf(dropPreview()!);
    expect(previewBox.width).toBeCloseTo(container.width, 0);
    expect(previewBox.height).toBeCloseTo(container.height, 0);
  });

  /** A hand crosses the dragged tab's own pane (all no-op drops) before the target; the preview
   * must not vanish there, so assert the whole path. */
  it("keeps the preview alive across the WHOLE drag, including over the source pane", async () => {
    const [dragged, target] = await build(2);

    const sourceBody = bodyOf(paneOfTab(dragged));
    const targetBody = bodyOf(paneOfTab(target));
    const gesture = await new DragGesture(tabElement(dragged)).start();

    const path: Array<[string, HTMLElement, Edge | "centre"]> = [
      ["source pane, centre", sourceBody, "centre"],
      ["source pane, left edge", sourceBody, "left"],
      ["source pane, bottom edge", sourceBody, "bottom"],
      ["target pane, centre", targetBody, "centre"],
      ["target pane, bottom edge", targetBody, "bottom"],
    ];

    for (const [where, body, edge] of path) {
      if (edge === "centre") await hoverCentre(gesture, body);
      else await gesture.over(body, edge);

      const overlay = dropPreview();
      expect(overlay, `${where}: the drag went dark — no preview`).not.toBeNull();

      // Present is not enough: it must be a real, visible box.
      const box = geometryOf(overlay!);
      expect(box.width, `${where}: preview has no width`).toBeGreaterThan(0);
      expect(box.height, `${where}: preview has no height`).toBeGreaterThan(0);

      const styles = getComputedStyle(overlay!);
      expect(styles.visibility, `${where}: preview is not visible`).toBe("visible");
      expect(Number(styles.opacity), `${where}: preview is transparent`).toBeGreaterThan(0);
      // The blue wash of the drop preview the user looks for — a box painted in
      // nothing is the same as no box.
      expect(styles.backgroundColor, `${where}: preview has no fill`).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  /** A no-op self-edge drop: the terminal stays put, so preview its current box (a split promises
   * too much; nothing reads as a dead app). */
  it("previews a no-op drop as the box the tab already occupies", async () => {
    const [dragged] = await build(2);

    const ownPane = paneOfTab(dragged);
    const paneBox = geometryOf(ownPane);
    const gesture = await new DragGesture(tabElement(dragged)).start();
    await gesture.over(bodyOf(ownPane), "left");

    const overlay = dropPreview();
    expect(overlay, "a no-op still has an answer: the tab stays here").not.toBeNull();
    // NOT half the pane (that would promise a split), and not nothing.
    expectSameBox(geometryOf(overlay!), paneBox, "no-op drop");

    // And the drop really is a no-op, so what was previewed is what happened.
    await gesture.drop(bodyOf(ownPane), "left");
    await settle();
    expectSameBox(geometryOf(paneOfTab(dragged)), paneBox, "no-op drop result");
  });

  /** The preview is transient: it must not survive the gesture. */
  it("clears the preview on drop and on drag end", async () => {
    const [dragged, target] = await build(2);
    const targetBody = bodyOf(paneOfTab(target));

    const gesture = await new DragGesture(tabElement(dragged)).start();
    await gesture.over(targetBody, "right");
    expect(dropPreview()).not.toBeNull();

    await gesture.drop(targetBody, "right");
    await settle(60);
    expect(dropPreview(), "the preview must not outlive the drop").toBeNull();
    expect(panes()).toHaveLength(2);
  });
});
