/**
 * PaneTree + SplitContainer — the recursive render of the layout tree onto
 * `allotment` (ARCHITECTURE §4).
 *
 * Note on jsdom: allotment mounts and renders its full DOM here (split-view
 * container, views, sashes), but jsdom has **no layout engine**, so every
 * element measures 0x0 and allotment computes no pixel sizes. The *structure*
 * contract is therefore testable here and the *pixel* contract is not — the
 * store→allotment direction is asserted on the props SplitContainer passes, and
 * the allotment→`onChange`→`resizePane` direction is asserted in `store.test.ts`
 * against the pixel arrays allotment emits. Real-drag behaviour belongs to the
 * in-app tier.
 */

import { Children, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

vi.mock("../features/terminal/TerminalView", () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-view" data-terminal-id={terminalId} />
  ),
}));

/**
 * Spy on what <SplitContainer> hands allotment, while still rendering the real
 * thing. allotment consumes `defaultSizes`/`minSize` internally and — having no
 * layout to apply them to — never reflects them into the jsdom DOM, so the
 * props are the only observable surface for that half of the contract.
 */
const allotmentProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("allotment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("allotment")>();
  const Real = actual.Allotment;
  const Wrapped = (props: ComponentProps<typeof Real>) => {
    allotmentProps.calls.push(props as unknown as Record<string, unknown>);
    return <Real {...props} />;
  };
  // Identity matters: allotment inspects its children for this exact component.
  Wrapped.Pane = Real.Pane;
  return { ...actual, Allotment: Wrapped };
});

import { findNode, fractionalRectOfLeaf, leavesOf, useAppStore } from "../app/store";
import type { LeafNode, PaneId, SplitNode, TabId } from "../app/types";
import { fireDragAt, fireDragLeave, makeDataTransfer, stubRect } from "../test/dnd";
import { resetStore } from "../test/store-harness";
import { PaneTree, PaneTreeRoot } from "./PaneTree";
import { TABBAR_CLASS, TAB_DND_MIME } from "./TabBar";

const actions = () => useAppStore.getState().layoutActions;
const store = () => useAppStore.getState();
const leaf = (): LeafNode => leavesOf(store().layout)[0];

const splitViews = (root: ParentNode) =>
  [...root.querySelectorAll('[data-testid="split-view-view"]')] as HTMLElement[];

/** Every allotment root rendered, outermost first. */
const splitRoots = (root: ParentNode) =>
  [...root.querySelectorAll(".split-view")] as HTMLElement[];

/** The most recent Allotment render's props. (No `.at(-1)`: tsconfig is ES2020.) */
const lastProps = () =>
  allotmentProps.calls[allotmentProps.calls.length - 1] as
    | Record<string, unknown>
    | undefined;
const lastDefaultSizes = () => lastProps()?.defaultSizes as number[] | undefined;

/** The `minSize` on each `<Allotment.Pane>` SplitContainer wrapped a child in. */
const lastPaneMinSizes = () =>
  Children.toArray(lastProps()?.children as ReactNode).map(
    (child) => (child as ReactElement<{ minSize?: number }>).props.minSize,
  );

beforeEach(() => {
  resetStore();
  allotmentProps.calls.length = 0;
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
});

describe("PaneTree — leaf", () => {
  it("renders a bare pane with no allotment wrapper for a single leaf", () => {
    const { container } = render(<PaneTreeRoot />);

    expect(container.querySelectorAll(".pane")).toHaveLength(1);
    expect(splitRoots(container)).toHaveLength(0);
    expect(allotmentProps.calls).toHaveLength(0);
  });
});

describe("PaneTree — split structure", () => {
  it("a 'row' split renders one horizontal allotment with two views", () => {
    actions().splitPane(leaf().id, "row");
    const { container } = render(<PaneTreeRoot />);

    const [root] = splitRoots(container);
    // types.ts: 'row' = side-by-side, which is allotment's NON-vertical mode.
    expect(root).toHaveClass("split-view-horizontal");
    expect(root).not.toHaveClass("split-view-vertical");
    expect(lastProps()?.vertical).toBe(false);
    expect(splitViews(container)).toHaveLength(2);
    expect(container.querySelectorAll(".pane")).toHaveLength(2);
  });

  it("a 'column' split renders a vertical allotment", () => {
    actions().splitPane(leaf().id, "column");
    const { container } = render(<PaneTreeRoot />);

    expect(splitRoots(container)[0]).toHaveClass("split-view-vertical");
    expect(lastProps()?.vertical).toBe(true);
  });

  it("renders panes in the tree's visual order", () => {
    const origin = leaf().id;
    actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    const created = actions().splitPane(origin, "row");
    actions().openTerminalTab({ paneId: created, cwd: "/w/api" });

    const { container } = render(<PaneTreeRoot />);

    const titles = splitViews(container).map(
      (view) => view.querySelector(".pane-tab__title")?.textContent,
    );
    expect(titles).toEqual(["gazelle", "api"]);
  });

  it("nests a cross-orientation split inside its parent's view", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row"); // root: row
    actions().splitPane(origin, "column"); // origin becomes a column split

    const { container } = render(<PaneTreeRoot />);

    const roots = splitRoots(container);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toHaveClass("split-view-horizontal");
    expect(roots[1]).toHaveClass("split-view-vertical");
    // The nested split lives inside the outer split's FIRST view.
    expect(splitViews(roots[0])[0]).toContainElement(roots[1]);
    expect(container.querySelectorAll(".pane")).toHaveLength(3);
  });

  it("renders a flattened same-orientation split as ONE allotment of three", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    actions().splitPane(origin, "row"); // canonicalize flattens: one row of 3

    const { container } = render(<PaneTreeRoot />);

    expect(splitRoots(container)).toHaveLength(1);
    expect(splitViews(container)).toHaveLength(3);
    // Three panes, two sashes — a real 3-way split, not a nested pair.
    expect(container.querySelectorAll('[data-testid="sash"]')).toHaveLength(2);
  });

  it("wraps every child in an Allotment.Pane with a minimum size", () => {
    actions().splitPane(leaf().id, "row");
    render(<PaneTreeRoot />);

    // Guards the sliver-pane failure mode: every pane keeps a pixel floor.
    const minSizes = lastPaneMinSizes();
    expect(minSizes).toHaveLength(2);
    for (const min of minSizes) expect(min).toBeGreaterThan(0);
    expect(lastProps()?.proportionalLayout).toBe(true);
  });
});

describe("SplitContainer — sizes", () => {
  it("seeds allotment's defaultSizes from the store, scaled off the 30px floor", () => {
    actions().splitPane(leaf().id, "row");
    render(<PaneTreeRoot />);

    // Fractions summing to 1 would collide with allotment's default 30px
    // minimum during construction, so SplitContainer scales them up first.
    expect(lastDefaultSizes()).toEqual([500, 500]);
  });

  it("seeds the store's persisted fractions after a resize", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    const splitId = (store().layout as SplitNode).id;
    actions().resizePane(splitId, [750, 250]);

    render(<PaneTreeRoot />);
    expect(lastDefaultSizes()).toEqual([750, 250]);
  });

  it("never seeds a zero size, even for a pane squeezed to nothing", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    actions().resizePane((store().layout as SplitNode).id, [1, 0]);

    render(<PaneTreeRoot />);

    // Math.max(1, …): a literal 0 would make allotment drop the pane entirely.
    expect(lastDefaultSizes()).toEqual([1000, 1]);
  });

  /**
   * The other half of the contract: allotment → store. A real sash drag needs
   * layout, which jsdom has none of, so allotment never emits `onChange` here.
   * We invoke the handler with the pixel array allotment would have emitted —
   * that is precisely the boundary this suite mocks, and it pins the wiring
   * (right split id, pixels normalized, no-ops dropped) that a silent typo in
   * SplitContainer would otherwise break with no test noticing.
   */
  it("writes a sash drag back to the store, normalizing pixels to fractions", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    const splitId = (store().layout as SplitNode).id;
    render(<PaneTreeRoot />);

    const onChange = lastProps()?.onChange as (sizes: number[]) => void;
    act(() => onChange([720, 240])); // what allotment emits: pixels

    const split = store().layout as SplitNode;
    expect(split.id).toBe(splitId);
    expect(split.sizes).toEqual([0.75, 0.25]);
  });

  it("drops allotment's no-op onChange fired on container resize", () => {
    actions().splitPane(leaf().id, "row");
    render(<PaneTreeRoot />);
    const onChange = lastProps()?.onChange as (sizes: number[]) => void;

    act(() => onChange([500, 500]));
    const settled = store().layout;

    // The window got wider: same ratio, different pixels. Must not churn state.
    act(() => onChange([900, 900]));
    expect(store().layout).toBe(settled);
  });
});

describe("PaneTree — reconciliation", () => {
  /**
   * The load-bearing detail from SplitContainer's header: allotment reads
   * `defaultSizes` on mount ONLY. <PaneTree> keys the container by the split's
   * *structure*, so structural edits remount it (re-seeding sizes from the
   * store) while sizes-only edits must NOT — a remount mid-drag would kill the
   * drag and tear down every terminal's DOM host.
   */
  it("a sizes-only change does not remount the split or its panes", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    const splitId = (store().layout as SplitNode).id;

    const { container } = render(<PaneTreeRoot />);
    const splitBefore = splitRoots(container)[0];
    const paneBefore = container.querySelector(".pane");

    act(() => actions().resizePane(splitId, [700, 300]));

    expect(splitRoots(container)[0]).toBe(splitBefore);
    expect(container.querySelector(".pane")).toBe(paneBefore);
  });

  it("a structural change remounts the split so allotment re-seeds", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");

    const { container } = render(<PaneTreeRoot />);
    const splitBefore = splitRoots(container)[0];

    act(() => void actions().splitPane(origin, "row")); // now a 3-way row

    expect(splitRoots(container)[0]).not.toBe(splitBefore);
    expect(splitViews(container)).toHaveLength(3);
  });

  it("keeps a pane's identity when an unrelated sibling changes tabs", () => {
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row");

    const { container } = render(<PaneTreeRoot />);
    const originView = splitViews(container)[0];

    act(() => void actions().openTerminalTab({ paneId: created, cwd: "/w/api" }));

    expect(splitViews(container)[0]).toBe(originView);
  });

  it("PaneTreeRoot follows the store live, with no props", async () => {
    const user = userEvent.setup();
    const { container } = render(<PaneTreeRoot />);
    expect(splitRoots(container)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Split pane right" }));
    expect(splitRoots(container)).toHaveLength(1);

    // ...and collapses back when the split is undone.
    await user.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
    expect(splitRoots(container)).toHaveLength(0);
    expect(container.querySelectorAll(".pane")).toHaveLength(1);
  });

  it("renders a subtree directly when handed a node (the recursive case)", () => {
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    actions().splitPane(origin, "column");
    const nested = (store().layout as SplitNode).children[0];

    const { container } = render(<PaneTree node={nested} />);

    expect(splitRoots(container)).toHaveLength(1);
    expect(splitRoots(container)[0]).toHaveClass("split-view-vertical");
    expect(container.querySelectorAll(".pane")).toHaveLength(2);
  });
});

/* ═════════════════════════════ drop preview ═════════════════════════════
 * The preview is owned by <PaneTreeRoot>, not <Pane>, and that is the fix for
 * this bug:
 *
 *   With the screen split vertically or horizontally, dragging a terminal toward
 *   any edge previewed only half of the screen. It happened only when exactly
 *   two terminals were open.
 *
 * A drop prunes the source leaf when it empties, which collapses the now
 * single-child split, which lets the survivor expand to fill the whole
 * container. Drawn inside the hovered pane, the preview could never show that —
 * it showed half. With 3+ panes nothing collapses, so the lie went unnoticed.
 *
 * These assertions are NOT vacuous under jsdom, and that is the point of the
 * design: the preview's rect is computed from the TREE (a split's `sizes` are
 * its children's shares, recursively), not measured from the DOM. So the
 * percentages are fully checkable here with no layout engine. What still needs
 * real Chromium is that those percentages land on the same pixels allotment
 * lays out — `dropPreview.browser.test.tsx` owns that.
 */

describe("PaneTree — drop preview", () => {
  /** The target pane's body rect, as if laid out: 400x300 below a 34px strip. */
  const BODY_RECT = { left: 0, top: 34, width: 400, height: 300 };

  /** Points landing in each zone of BODY_RECT (edge band = the outer 25%). */
  const AT = {
    center: [200, 184],
    left: [10, 184],
    right: [390, 184],
    top: [200, 44],
    bottom: [200, 324],
    tabBar: [200, 10], // above the body — over the tab strip
  } as const;

  /**
   * The failing setup: two panes side by side, one terminal each. We drag
   * `dragged` (alone in the RIGHT pane) onto the LEFT pane — so the right pane
   * empties, is pruned, and the root split collapses.
   */
  function twoPanes() {
    const targetPaneId = leaf().id;
    const stay = actions().openTerminalTab({ paneId: targetPaneId, cwd: "/w/gazelle" });
    const sourcePaneId = actions().splitPane(targetPaneId, "row");
    const dragged = actions().openTerminalTab({ paneId: sourcePaneId, cwd: "/w/api" });

    const view = render(<PaneTreeRoot />);
    const panes = [...view.container.querySelectorAll<HTMLElement>(".pane")];
    const targetPane = panes[0];
    stubRect(targetPane.querySelector(".pane__body") as HTMLElement, BODY_RECT);

    const dataTransfer = makeDataTransfer({ [TAB_DND_MIME]: dragged });
    // Start the drag for real. The preview cannot read the tab id off
    // `dataTransfer` during dragover (the drag data store is in protected mode
    // until the drop), so the SOURCE publishes it on dragstart — and a dragover
    // without a preceding dragstart is not a state a browser can produce.
    const draggedTab = [...view.container.querySelectorAll<HTMLElement>(".pane-tab")].find(
      (t) => t.title === "api",
    ) as HTMLElement;
    fireDragAt(draggedTab, "dragStart", [0, 0], dataTransfer);

    return { ...view, targetPane, targetPaneId, sourcePaneId, stay, dragged, dataTransfer, draggedTab };
  }

  const overlay = (root: ParentNode) =>
    root.querySelector<HTMLElement>("[data-testid='drop-zone']");
  const zoneShown = (root: ParentNode) => overlay(root)?.getAttribute("data-zone") ?? null;
  /** The preview's box, as the percentages of the work area it is drawn with. */
  const previewBox = (root: ParentNode) => {
    const el = overlay(root);
    if (!el) return null;
    return {
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      height: el.style.height,
    };
  };

  /** A live leaf's box, in the same percentage form the preview is drawn with. */
  const rectAsPercent = (paneId: PaneId) => {
    const rect = fractionalRectOfLeaf(store().layout, paneId);
    if (!rect) return null;
    return {
      left: `${rect.left * 100}%`,
      top: `${rect.top * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    };
  };

  it.each([
    // The source pane is pruned and the root collapses, so the survivor fills
    // the container — every one of these spans a FULL axis, never half of the
    // hovered pane. That full span IS the bug fix.
    ["left", { left: "0%", top: "0%", width: "50%", height: "100%" }],
    ["right", { left: "50%", top: "0%", width: "50%", height: "100%" }],
    ["top", { left: "0%", top: "0%", width: "100%", height: "50%" }],
    ["bottom", { left: "0%", top: "50%", width: "100%", height: "50%" }],
  ] as const)("previews the %s zone as the box the tab will actually occupy", (zone, box) => {
    const { container, targetPane, dataTransfer } = twoPanes();

    fireDragAt(targetPane, "dragOver", AT[zone], dataTransfer);

    expect(zoneShown(container)).toBe(zone);
    expect(targetPane).toHaveClass("pane--drop-target");
    // Before the fix this was drawn inside the hovered pane — i.e. half the
    // width for top/bottom, and offset into the wrong half for left/right.
    expect(previewBox(container)).toEqual(box);
  });

  it("previews a centre drop as the whole work area, not the hovered pane", () => {
    // Centre = `moveTab` into the target. The source still empties and the root
    // still collapses, so the survivor — which is where the tab lands — is the
    // entire container.
    const { container, targetPane, dataTransfer } = twoPanes();

    fireDragAt(targetPane, "dragOver", AT.center, dataTransfer);

    expect(zoneShown(container)).toBe("center");
    expect(previewBox(container)).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
  });

  it("reads the tab strip as center — dropping on tabs joins the group", () => {
    const { container, targetPane, dataTransfer } = twoPanes();
    fireDragAt(targetPane, "dragOver", AT.tabBar, dataTransfer);
    expect(zoneShown(container)).toBe("center");
  });

  it("follows the cursor from zone to zone within one drag", () => {
    const { container, targetPane, dataTransfer } = twoPanes();

    fireDragAt(targetPane, "dragOver", AT.center, dataTransfer);
    expect(zoneShown(container)).toBe("center");
    fireDragAt(targetPane, "dragOver", AT.right, dataTransfer);
    expect(zoneShown(container)).toBe("right");
    fireDragAt(targetPane, "dragOver", AT.bottom, dataTransfer);
    expect(zoneShown(container)).toBe("bottom");
  });

  it("shows no preview for a drag that is not one of our tabs", () => {
    const { container, targetPane } = twoPanes();
    // e.g. a file dragged in from Finder.
    fireDragAt(
      targetPane,
      "dragOver",
      AT.right,
      makeDataTransfer({ "text/uri-list": "file:///tmp/x" }),
    );
    expect(zoneShown(container)).toBeNull();
  });

  it("clears on drop, on leaving the pane, and on a cancelled drag", () => {
    const { container, targetPane, dataTransfer } = twoPanes();

    fireDragAt(targetPane, "dragOver", AT.right, dataTransfer);
    expect(zoneShown(container)).toBe("right");
    fireDragLeave(targetPane, document.body);
    expect(zoneShown(container)).toBeNull();

    fireDragAt(targetPane, "dragOver", AT.right, dataTransfer);
    fireDragAt(targetPane, "drop", AT.right, dataTransfer);
    expect(zoneShown(container)).toBeNull();

    // A drag abandoned outside any pane fires only dragend — without which the
    // preview would be left painted over the app.
    resetStore();
    const second = twoPanes();
    fireDragAt(second.targetPane, "dragOver", AT.right, second.dataTransfer);
    expect(zoneShown(second.container)).toBe("right");
    fireDragAt(second.draggedTab, "dragEnd", [0, 0], second.dataTransfer);
    expect(zoneShown(second.container)).toBeNull();
  });

  /**
   * A pane's only tab dropped on its OWN edge no-ops in the store (it would
   * split, empty, prune and collapse straight back). Two wrong answers here,
   * and this repo has now shipped both:
   *
   *   - a SPLIT preview — promises something the drop will not deliver;
   *   - NO preview — reads as a dead app, and since the cursor crosses the
   *     dragged tab's own pane first, it blanks the first half of every drag
   *     (the blue drop highlight went missing mid-drag).
   *
   * The right answer is the honest one: the terminal ends up where it already
   * is, so preview that box.
   */
  it.each(["left", "center"] as const)(
    "previews a no-op %s drop as the box the tab already occupies",
    (zone) => {
      const { container, sourcePaneId, dataTransfer } = twoPanes();
      const sourcePane = [...container.querySelectorAll<HTMLElement>(".pane")][1];
      stubRect(sourcePane.querySelector(".pane__body") as HTMLElement, BODY_RECT);

      fireDragAt(sourcePane, "dragOver", AT[zone], dataTransfer);

      // The source pane is the right half of the row — the whole of it, not the
      // half a split would have carved out of it.
      expect(previewBox(container)).toEqual({
        left: "50%",
        top: "0%",
        width: "50%",
        height: "100%",
      });
      expect(previewBox(container)).toEqual(rectAsPercent(sourcePaneId));
    },
  );

  /**
   * The dragged tab can genuinely vanish mid-gesture: `closeTab` is driven from
   * Rust event callbacks (bridge.ts), so an agent terminal whose PTY exits is
   * closed under the user's hand while they are still dragging it. There is
   * nothing left to preview then — and, more importantly, nothing to crash on.
   */
  it("survives the dragged tab being closed mid-drag", () => {
    const { container, dragged } = twoPanes();
    const targetPane = [...container.querySelectorAll<HTMLElement>(".pane")][0];
    fireDragAt(targetPane, "dragOver", AT.left, makeDataTransfer({ [TAB_DND_MIME]: dragged }));
    expect(zoneShown(container)).toBe("left");

    // The PTY exited: Rust closed the tab out from under the drag.
    act(() => actions().closeTab(dragged));

    const survivor = container.querySelector<HTMLElement>(".pane") as HTMLElement;
    stubRect(survivor.querySelector(".pane__body") as HTMLElement, BODY_RECT);
    fireDragAt(survivor, "dragOver", AT.left, makeDataTransfer({ [TAB_DND_MIME]: dragged }));

    // No preview — the tab it described no longer exists — and no throw.
    expect(zoneShown(container)).toBeNull();
    expect(container.querySelectorAll(".pane")).toHaveLength(1);
  });

  it("is inert: the overlay carries no pointer target and no a11y noise", () => {
    // It sits under the cursor mid-drag — if it could receive events it would
    // fire dragleave on the pane and flicker itself out of existence. (The
    // pointer-events:none itself lives in CSS, which jsdom does not load; what
    // is assertable here is that it is not a focusable/labelled thing.)
    const { container, targetPane, dataTransfer } = twoPanes();
    fireDragAt(targetPane, "dragOver", AT.center, dataTransfer);

    expect(overlay(container)).toHaveAttribute("aria-hidden", "true");
    expect(overlay(container)).toBeEmptyDOMElement();
  });

  it("yields to the tab strip: no split preview while reordering", () => {
    // Both are drop targets and the strip is INSIDE the pane, so its events
    // bubble here. If the pane also previewed, the user would see a split
    // preview while actually reordering.
    const { container, targetPane, dataTransfer } = twoPanes();
    const strip = targetPane.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;

    fireDragAt(targetPane, "dragOver", AT.right, dataTransfer);
    expect(zoneShown(container)).toBe("right");

    fireDragAt(strip, "dragOver", AT.tabBar, dataTransfer);
    expect(zoneShown(container)).toBeNull();
    expect(targetPane).not.toHaveClass("pane--drop-target");
  });

  /**
   * The invariant, end to end and in one test: the box the preview drew is the
   * box the tab lands in. The browser tier asserts this in real pixels; here it
   * is asserted against the tree, which is the thing the preview is derived
   * from — so a fix that broke the derivation would fail here first.
   */
  it.each(["left", "right", "top", "bottom", "center"] as const)(
    "the %s drop lands exactly where the preview said it would",
    (zone) => {
      const { container, targetPane, dragged, dataTransfer } = twoPanes();

      fireDragAt(targetPane, "dragOver", AT[zone], dataTransfer);
      const previewed = previewBox(container);
      expect(previewed).not.toBeNull();

      fireDragAt(targetPane, "drop", AT[zone], dataTransfer);

      // Where the dragged tab actually ended up, measured the same way.
      const landed = leavesOf(store().layout).find((l) => l.tabIds.includes(dragged as TabId));
      expect(landed).toBeDefined();
      const rect = fractionalRectOfLeaf(store().layout, landed!.id);
      expect(rect).not.toBeNull();
      expect({
        left: `${rect!.left * 100}%`,
        top: `${rect!.top * 100}%`,
        width: `${rect!.width * 100}%`,
        height: `${rect!.height * 100}%`,
      }).toEqual(previewed);
    },
  );
});

describe("PaneTree — end-to-end through the toolbar", () => {
  it("split right, then split down, builds the nested structure on screen", async () => {
    const user = userEvent.setup();
    const { container } = render(<PaneTreeRoot />);

    await user.click(screen.getByRole("button", { name: "Split pane right" }));
    // The new (focused, empty) pane is second; split that one downwards.
    await user.click(screen.getAllByRole("button", { name: "Split pane down" })[1]);

    const roots = splitRoots(container);
    expect(roots[0]).toHaveClass("split-view-horizontal");
    expect(roots[1]).toHaveClass("split-view-vertical");
    expect(container.querySelectorAll(".pane")).toHaveLength(3);

    // The DOM agrees with the model.
    const root = store().layout as SplitNode;
    expect(root.orientation).toBe("row");
    expect((root.children[1] as SplitNode).orientation).toBe("column");
  });

  it("a '+' click opens a terminal in the pane that owns the button", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    render(<PaneTreeRoot />);

    await user.click(screen.getByRole("button", { name: "Split pane right" }));
    const created: PaneId = store().focusedPaneId;

    // Click the FIRST pane's + while focus sits on the second: this proves the
    // button targets its own pane rather than `focusedPaneId`.
    await user.click(screen.getAllByRole("button", { name: "New terminal tab" })[0]);

    expect((findNode(store().layout, origin) as LeafNode).tabIds).toHaveLength(1);
    expect((findNode(store().layout, created) as LeafNode).tabIds).toHaveLength(0);
    expect(screen.getAllByTestId("terminal-view")).toHaveLength(1);
  });

  it("closing the last tab of a split pane collapses the layout on screen", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    const created = actions().splitPane(origin, "row");
    actions().openTerminalTab({ paneId: created, cwd: "/w/api" });

    const { container } = render(<PaneTreeRoot />);
    expect(splitRoots(container)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Close api" }));

    expect(splitRoots(container)).toHaveLength(0);
    expect(container.querySelectorAll(".pane")).toHaveLength(1);
    expect(screen.getByText("gazelle")).toBeInTheDocument();
  });
});
