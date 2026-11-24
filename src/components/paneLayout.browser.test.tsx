/**
 * Layer 5 (testing-strategy §1, §7.5) — the pane tree, in real pixels.
 *
 * The bug:
 *
 *   With the screen split vertically or horizontally, dragging a terminal toward
 *   any edge showed only half of the screen. It happened only when exactly two
 *   terminals were open; with more, it was fine.
 *
 * i.e. 2 panes, drag the only tab out of one pane onto the other pane's edge →
 * half the screen goes dead. With 3+ panes the same gesture is fine.
 *
 * This CANNOT be tested under jsdom, and that is not a preference. `allotment`
 * never reads `clientWidth`/`getBoundingClientRect` — verified: zero such reads
 * in its bundle. It learns its container size from **`ResizeObserver` and
 * nothing else**, and jsdom's RO (our own stub, `src/test/setup.ts`) never
 * fires. So under jsdom allotment lays out *nothing*, every pane is 0x0, and
 * every assertion below is vacuously true. Real Chromium is the only place
 * these facts exist.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import { useAppStore } from "../app/store";
import { disposeAll } from "../features/terminal";
import type { PaneId, TabId } from "../app/types";
import { installTauriMock, type TauriMock } from "../test/tauri-mock";
import {
  bodyOf,
  dragTabToEdge,
  geometryOf,
  leafPaneIds,
  paneOfTab,
  panes,
  rootSplitView,
  tabElement,
  terminalIdOfTab,
  terminalSize,
  type Edge,
} from "../test/layout-browser";
import { resetStore } from "../test/store-harness";

/** TerminalRegistry's fit debounce (RESIZE_DEBOUNCE_MS) plus real headroom. */
const FIT_DEBOUNCE_MS = 50;

/**
 * Let the browser actually lay out, then let every async consequence land.
 *
 * The chain under test is genuinely asynchronous and every link is real:
 *   rAF (style+layout) → ResizeObserver delivery → allotment `layout()` →
 *   the registry's own RO → `scheduleFit()`'s 50ms debounce → `fit()`.
 *
 * So this waits on frames *and* wall-clock, generously. It is not a "sleep
 * until green" fudge: the assertions that follow are about the settled state,
 * and a bug that survives 400ms of settling is a bug the user sees.
 */
async function settle(ms = FIT_DEBOUNCE_MS * 6): Promise<void> {
  await act(async () => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

/** Open a terminal tab in `paneId` (or the focused pane) via the real action. */
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

describe("pane layout — real browser geometry", () => {
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

  /**
   * Build the failing starting state: two panes side by side, one terminal
   * tab each, laid out and fitted.
   */
  async function twoPanes(): Promise<{ tabA: TabId; tabB: TabId }> {
    render(<App />);
    await settle();

    const rootLeaf = leafPaneIds()[0];
    const tabA = openTab(rootLeaf);
    const paneB = splitPane(rootLeaf, "row");
    const tabB = openTab(paneB);
    await settle();

    return { tabA, tabB };
  }

  it("baseline: 2 panes each fill half the container, and both terminals are fitted", async () => {
    const { tabA, tabB } = await twoPanes();

    const split = rootSplitView();
    expect(split, "root split view must be rendered").not.toBeNull();
    const container = geometryOf(split!);

    expect(container.width).toBeGreaterThan(200);
    expect(container.height).toBeGreaterThan(200);

    const rendered = panes();
    expect(rendered).toHaveLength(2);

    // Side by side: each ~half the width, full height, and together they cover
    // the container with no dead band.
    for (const pane of rendered) {
      const g = geometryOf(pane);
      expect(g.height).toBeCloseTo(container.height, 0);
      expect(g.width).toBeGreaterThan(container.width * 0.4);
    }
    const covered = rendered.reduce((sum, p) => sum + geometryOf(p).width, 0);
    expect(covered).toBeCloseTo(container.width, 0);

    // Real font metrics, real layout: a fitted terminal has a sane grid.
    for (const tabId of [tabA, tabB]) {
      const { cols, rows } = terminalSize(terminalIdOfTab(tabId));
      expect(cols).toBeGreaterThan(10);
      expect(rows).toBeGreaterThan(5);
    }
  });

  /**
   * THE BUG. Two panes; drag the only tab out of pane A onto pane B's edge.
   *
   * All four edges, because it happened in every direction — and
   * because two distinct store paths are involved:
   *   - left/right split `row`, which is the root's own orientation, so
   *     canonicalize FLATTENS (the root split is reused, id and all);
   *   - top/bottom split `column`, so the pruned root collapses into the new
   *     nested split (a brand-new root node).
   * Both must end with the survivors filling the container.
   */
  describe.each<Edge>(["left", "right", "top", "bottom"])(
    "2 panes → drag the only tab of pane A onto pane B's %s edge",
    (edge) => {
      it("leaves both panes filling the container, with fitted terminals", async () => {
        const { tabA, tabB } = await twoPanes();

        const targetBody = bodyOf(paneOfTab(tabB));
        await dragTabToEdge(tabElement(tabA), targetBody, edge);
        await settle();

        // The store did what it should: still exactly 2 leaves.
        expect(leafPaneIds()).toHaveLength(2);

        const split = rootSplitView();
        expect(split, "root split view must still be rendered").not.toBeNull();
        const container = geometryOf(split!);

        const rendered = panes();
        expect(rendered).toHaveLength(2);

        const vertical = edge === "top" || edge === "bottom";
        const axis = vertical ? "height" : "width";
        const cross = vertical ? "width" : "height";

        // Nothing is collapsed to nothing...
        for (const pane of rendered) {
          const g = geometryOf(pane);
          expect(g[cross], `pane ${cross} must span the container`).toBeCloseTo(container[cross], 0);
          expect(
            g[axis],
            `pane ${axis} ${g[axis]} collapsed (container ${axis} ${container[axis]})`,
          ).toBeGreaterThan(container[axis] * 0.3);
        }

        // ...and together they cover the whole container: no dead half.
        const covered = rendered.reduce((sum, p) => sum + geometryOf(p)[axis], 0);
        expect(
          covered,
          `panes cover ${covered}px of ${container[axis]}px along ${axis} — the dead-half bug`,
        ).toBeCloseTo(container[axis], 0);

        // And the terminals agree with their new boxes (testing-strategy §7.5:
        // a correct pane with a stale grid is the same bug to the user).
        for (const tabId of [tabA, tabB]) {
          const terminalId = terminalIdOfTab(tabId);
          const { cols, rows } = terminalSize(terminalId);
          const host = document.querySelector<HTMLElement>(`[data-terminal-id="${terminalId}"]`);
          expect(host, "the terminal's host must be in the visible tree").not.toBeNull();

          const hostBox = geometryOf(host!);
          expect(hostBox.width).toBeGreaterThan(0);
          expect(hostBox.height).toBeGreaterThan(0);

          const screen = host!.querySelector<HTMLElement>(".xterm-screen");
          expect(screen, "xterm must have rendered a screen").not.toBeNull();
          const screenBox = geometryOf(screen!);

          /**
           * The grid must fill its host — i.e. `cols`/`rows` are what a correct
           * fit computes for THIS box, not a stale count from the old one.
           *
           * The cell size is read off the rendered grid (`screenBox` is exactly
           * cols x cellW by construction), which makes it a real font
           * measurement; the assertion then compares against `hostBox`, which is
           * independent of it. So this is not circular: it genuinely says "the
           * grid matches the box it is in".
           *
           * The band accounts for the only two legitimate sources of slack:
           * xterm's viewport scrollbar (SCROLLBAR_MAX) and the sub-cell
           * remainder `fit()` floors away (< 1 cell).
           */
          const cellW = screenBox.width / cols;
          const cellH = screenBox.height / rows;
          const SCROLLBAR_MAX = 20;
          expect(
            cols,
            `${cols} cols draws ${screenBox.width}px into a ${hostBox.width}px host — stale grid`,
          ).toBeGreaterThanOrEqual(Math.floor((hostBox.width - SCROLLBAR_MAX) / cellW));
          expect(cols).toBeLessThanOrEqual(Math.floor(hostBox.width / cellW));
          expect(
            rows,
            `${rows} rows draws ${screenBox.height}px into a ${hostBox.height}px host — stale grid`,
          ).toBeGreaterThanOrEqual(Math.floor(hostBox.height / cellH) - 1);
          expect(rows).toBeLessThanOrEqual(Math.floor(hostBox.height / cellH));
        }
      });
    },
  );

  /**
   * The control. Same gesture, 3 panes — this case is fine, so
   * a fix that makes the 2-pane case pass must not have got there by breaking
   * this one, and a diagnosis that predicts breakage here is wrong.
   */
  it("3 panes → the same gesture keeps every pane filling the container", async () => {
    render(<App />);
    await settle();

    const rootLeaf = leafPaneIds()[0];
    const tabA = openTab(rootLeaf);
    const paneB = splitPane(rootLeaf, "row");
    const tabB = openTab(paneB);
    const paneC = splitPane(paneB, "row");
    openTab(paneC);
    await settle();

    expect(leafPaneIds()).toHaveLength(3);

    const targetBody = bodyOf(paneOfTab(tabB));
    await dragTabToEdge(tabElement(tabA), targetBody, "bottom");
    await settle();

    const split = rootSplitView();
    const container = geometryOf(split!);
    const rendered = panes();
    expect(rendered).toHaveLength(3);

    for (const pane of rendered) {
      const g = geometryOf(pane);
      expect(g.width, "pane collapsed to nothing").toBeGreaterThan(20);
      expect(g.height, "pane collapsed to nothing").toBeGreaterThan(20);
    }
    // The top-level row still spans the container.
    const topLevel = rendered.filter((p) => Math.abs(geometryOf(p).top - container.top) < 2);
    const covered = topLevel.reduce((sum, p) => sum + geometryOf(p).width, 0);
    expect(covered).toBeCloseTo(container.width, 0);
  });
});
