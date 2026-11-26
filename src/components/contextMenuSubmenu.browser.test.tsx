/** Submenu placement in real pixels (testing-strategy §1, §7.5): right of the parent item,
 * top-aligned, flipped left on overflow, in the fixed 1280×800 viewport (jsdom rects are 0×0).
 * App.css is imported because its theme variables change the surface's box. */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../App.css";
import { ContextMenu, MENU_MARGIN, type ContextMenuItem } from "./ContextMenu";

/** The shape the workspace tree's Git entry uses: a parent carrying `items`. */
const ITEMS: ContextMenuItem[] = [
  { label: "New File", onSelect: vi.fn() },
  { label: "Rename", onSelect: vi.fn() },
  { separator: true },
  {
    label: "Git",
    items: [
      { label: "Compare with HEAD", onSelect: vi.fn() },
      { label: "Revert changes…", onSelect: vi.fn(), danger: true },
    ],
  },
  { label: "Delete", onSelect: vi.fn(), danger: true },
];

/** Render at (x, y), open the Git submenu, and hand back both real boxes. */
function openSubmenuAt(x: number, y: number): { parent: DOMRect; child: DOMRect; root: DOMRect } {
  render(<ContextMenu items={ITEMS} x={x} y={y} onClose={vi.fn()} ariaLabel="Actions for src" />);

  const root = screen.getByRole("menu", { name: "Actions for src" });
  const git = screen.getByRole("menuitem", { name: "Git" });
  fireEvent.click(git);

  const child = screen.getByRole("menu", { name: "Git" });
  // Sanity: the engine really laid the child out. A 0×0 box would make every
  // placement assertion below vacuously true — the exact jsdom failure mode.
  const childRect = child.getBoundingClientRect();
  expect(childRect.width).toBeGreaterThan(100);
  expect(childRect.height).toBeGreaterThan(20);

  return { parent: git.getBoundingClientRect(), child: childRect, root: root.getBoundingClientRect() };
}

describe("ContextMenu submenus — real geometry (Chromium)", () => {
  it("opens to the RIGHT of its parent item, top-aligned with it, inside the viewport", () => {
    const { parent, child } = openSubmenuAt(40, 60);

    expect(child.left).toBeCloseTo(parent.right, 0);
    expect(child.top).toBeCloseTo(parent.top, 0);
    // Right of the item, not on top of it or under it.
    expect(child.left).toBeGreaterThan(parent.left);
    expect(child.right).toBeLessThanOrEqual(window.innerWidth - MENU_MARGIN);
  });

  it("flips to the LEFT of its parent item when the menu is anchored near the right edge", () => {
    // Anchor hard against the right edge: the ROOT clamps back from it, and the
    // child's right-hand placement then has nowhere left to go.
    const { parent, child, root } = openSubmenuAt(window.innerWidth - 12, 60);

    // The root really did clamp — otherwise this would not be the flip case.
    expect(root.right).toBeCloseTo(window.innerWidth - MENU_MARGIN, 0);
    // Had it NOT flipped, the child would have started at the item's right edge
    // and run off the screen. This is the two-sided half of the test above.
    expect(parent.right + child.width).toBeGreaterThan(window.innerWidth - MENU_MARGIN);

    expect(child.right).toBeCloseTo(parent.left, 0);
    expect(child.top).toBeCloseTo(parent.top, 0);
    expect(child.right).toBeLessThan(parent.right);
    expect(child.left).toBeGreaterThanOrEqual(MENU_MARGIN);
  });
});
