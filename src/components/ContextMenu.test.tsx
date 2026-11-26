/** jsdom rects are 0×0, so clamp and submenu geometry tests stub rects against the 1024×768
 * viewport (real pixels: `contextMenuSubmenu.browser.test.tsx`). Guards: submenus render INSIDE
 * the root (else outside-click dismisses), and only the root holds global listeners. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextMenu, MENU_MARGIN, type ContextMenuItem } from "./ContextMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const menuEl = () => screen.getByRole("menu");
const items = () => screen.getAllByRole("menuitem");

describe("ContextMenu — rendering", () => {
  it("renders each item as a menuitem, separators as dividers, under a labelled menu", () => {
    const menuItems: ContextMenuItem[] = [
      { label: "New File", onSelect: vi.fn() },
      { label: "New Folder", onSelect: vi.fn() },
      { separator: true },
      { label: "Rename", onSelect: vi.fn() },
      { label: "Delete", onSelect: vi.fn(), danger: true },
    ];
    render(<ContextMenu items={menuItems} x={10} y={10} onClose={vi.fn()} ariaLabel="Actions for w" />);

    expect(menuEl()).toHaveAttribute("aria-label", "Actions for w");
    expect(items().map((b) => b.textContent)).toEqual(["New File", "New Folder", "Rename", "Delete"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    // The danger item carries the destructive class; the others do not.
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("is-danger");
    expect(screen.getByRole("menuitem", { name: "Rename" })).not.toHaveClass("is-danger");
  });

  it("anchors at (x, y) with fixed positioning when it fits", () => {
    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={10} y={20} onClose={vi.fn()} ariaLabel="m" />);
    const el = menuEl();
    expect(el.style.left).toBe("10px");
    expect(el.style.top).toBe("20px");
  });
});

describe("ContextMenu — selection", () => {
  it("clicking an item fires onSelect then onClose", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "New File", onSelect }]} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    await userEvent.setup().click(screen.getByRole("menuitem", { name: "New File" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a disabled item does nothing when clicked", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        items={[{ label: "Rename", onSelect, disabled: true }]}
        x={0}
        y={0}
        onClose={onClose}
        ariaLabel="m"
      />,
    );

    const btn = screen.getByRole("menuitem", { name: "Rename" });
    expect(btn).toBeDisabled();
    await userEvent.setup().click(btn);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ContextMenu — dismissal", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    fireEvent.keyDown(menuEl(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside mousedown, but not on a click inside", async () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    // A mousedown INSIDE the menu keeps it open (target is contained).
    fireEvent.mouseDown(menuEl());
    expect(onClose).not.toHaveBeenCalled();

    // A mousedown elsewhere closes it.
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when a contextmenu opens elsewhere, but stays for a right-click on itself", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    // Right-clicking the menu itself is swallowed (default prevented, stays open).
    const notPrevented = fireEvent.contextMenu(menuEl());
    expect(notPrevented).toBe(false); // preventDefault ran
    expect(onClose).not.toHaveBeenCalled();

    // A contextmenu elsewhere (opening another menu) closes this one.
    fireEvent.contextMenu(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on scroll and on resize", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ContextMenu — keyboard navigation", () => {
  it("focuses the first enabled item, wraps with arrows, and activates with Enter", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        items={[
          { label: "A", onSelect: onA },
          { label: "B", onSelect: onB },
          { label: "C", onSelect: onC },
        ]}
        x={0}
        y={0}
        onClose={onClose}
        ariaLabel="m"
      />,
    );

    const [a, b, c] = items();
    // First enabled item is focused on open.
    expect(document.activeElement).toBe(a);

    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(b);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(c);
    await user.keyboard("{ArrowDown}"); // wraps to the top
    expect(document.activeElement).toBe(a);
    await user.keyboard("{ArrowUp}"); // wraps to the bottom
    expect(document.activeElement).toBe(c);

    // Enter activates the focused item (native button activation) and closes.
    await user.keyboard("{Enter}");
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips disabled items when moving focus with arrows", async () => {
    render(
      <ContextMenu
        items={[
          { label: "A", onSelect: vi.fn() },
          { label: "B", onSelect: vi.fn(), disabled: true },
          { label: "C", onSelect: vi.fn() },
        ]}
        x={0}
        y={0}
        onClose={vi.fn()}
        ariaLabel="m"
      />,
    );
    const [a, , c] = items();
    expect(document.activeElement).toBe(a);

    await userEvent.setup().keyboard("{ArrowDown}"); // skips the disabled B
    expect(document.activeElement).toBe(c);
  });

  it("is inert with no enabled items: nothing focused, arrows are a no-op", () => {
    render(
      <ContextMenu
        items={[{ label: "A", onSelect: vi.fn(), disabled: true }]}
        x={0}
        y={0}
        onClose={vi.fn()}
        ariaLabel="m"
      />,
    );
    // No enabled item → focus stays on the body, arrows do not throw.
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(menuEl(), { key: "ArrowDown" });
    fireEvent.keyDown(menuEl(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(document.body);
  });
});

// ── Submenus ────────────────────────────────────────────────────────────────

/** The workspace tree's Git entry shape: a parent with `items`, between rows and a separator. */
function gitMenu(opts: { onCompare?: () => void; onRevert?: () => void; disabled?: boolean } = {}): ContextMenuItem[] {
  return [
    { label: "Rename", onSelect: vi.fn() },
    { separator: true },
    {
      label: "Git",
      disabled: opts.disabled,
      items: [
        { label: "Compare with HEAD", onSelect: opts.onCompare ?? vi.fn() },
        { label: "Revert changes…", onSelect: opts.onRevert ?? vi.fn(), danger: true },
      ],
    },
    { label: "Delete", onSelect: vi.fn(), danger: true },
  ];
}

const menus = () => screen.queryAllByRole("menu");
const item = (name: string) => screen.getByRole("menuitem", { name });
const noItem = (name: string) => screen.queryByRole("menuitem", { name });

describe("ContextMenu — submenus", () => {
  it("renders a parent as a haspopup menuitem, closed, with its children absent from the DOM", async () => {
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={vi.fn()} ariaLabel="m" />);

    const git = item("Git");
    expect(git).toHaveAttribute("aria-haspopup", "menu");
    expect(git).toHaveAttribute("aria-expanded", "false");
    expect(git).toHaveTextContent("▸"); // the chevron, aria-hidden so the name stays "Git"
    expect(git).toHaveClass("has-submenu");
    // The row wrapper that will hold the child surface stays out of the a11y
    // tree — a `menu` may only own menuitems, groups and separators.
    expect(git.closest(".context-menu__row")).toHaveAttribute("role", "none");
    // A plain row carries none of that.
    expect(item("Rename")).not.toHaveAttribute("aria-haspopup");
    expect(item("Rename")).not.toHaveAttribute("aria-expanded");
    expect(item("Rename")).not.toHaveTextContent("▸");
    // Closed: one surface, and the children are nowhere.
    expect(menus()).toHaveLength(1);
    expect(noItem("Compare with HEAD")).toBeNull();

    await userEvent.setup().hover(git);

    // Two-sided: the very same menu, opened, DOES put them there.
    expect(git).toHaveAttribute("aria-expanded", "true");
    expect(menus()).toHaveLength(2);
    expect(screen.getByRole("menu", { name: "Git" })).toBeInTheDocument();
    expect(item("Compare with HEAD")).toBeInTheDocument();
    expect(item("Revert changes…")).toHaveClass("is-danger");
  });

  it("opening a submenu does NOT dismiss the root menu — the child subtree counts as inside", async () => {
    const onClose = vi.fn();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    await userEvent.setup().hover(item("Git"));
    expect(onClose).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(2);

    // A mousedown INSIDE the child must not read as "outside" the menu tree.
    fireEvent.mouseDown(screen.getByRole("menu", { name: "Git" }));
    fireEvent.mouseDown(item("Compare with HEAD"));
    expect(onClose).not.toHaveBeenCalled();

    // ...and one truly outside still closes the whole thing.
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the global dismissal listeners on the ROOT only — one scroll closes once", async () => {
    const onClose = vi.fn();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    await userEvent.setup().hover(item("Git"));
    expect(menus()).toHaveLength(2); // the child is mounted, so a second copy could exist

    window.dispatchEvent(new Event("scroll"));
    expect(onClose).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("resize"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("hover opens the submenu; hovering a sibling closes it and takes the focus ring", async () => {
    const user = userEvent.setup();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={vi.fn()} ariaLabel="m" />);

    await user.hover(item("Git"));
    expect(item("Compare with HEAD")).toBeInTheDocument();

    await user.hover(item("Rename"));
    expect(noItem("Compare with HEAD")).toBeNull();
    expect(menus()).toHaveLength(1);
    expect(item("Git")).toHaveAttribute("aria-expanded", "false");
    // Focus followed the mouse, so keys still reach a menu (not the body).
    expect(document.activeElement).toBe(item("Rename"));
  });

  it("keeps exactly ONE submenu open per level", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        items={[
          { label: "Git", items: [{ label: "Compare", onSelect: vi.fn() }] },
          { label: "Refactor", items: [{ label: "Rename symbol", onSelect: vi.fn() }] },
        ]}
        x={0}
        y={0}
        onClose={vi.fn()}
        ariaLabel="m"
      />,
    );

    await user.hover(item("Git"));
    expect(screen.getByRole("menu", { name: "Git" })).toBeInTheDocument();

    await user.hover(item("Refactor"));
    expect(screen.queryByRole("menu", { name: "Git" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Refactor" })).toBeInTheDocument();
    expect(menus()).toHaveLength(2); // root + exactly one child
  });

  it("clicking a submenu parent opens it instead of selecting — the root stays open", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    // fireEvent, not userEvent: a real click also hovers, and this asserts the
    // CLICK path (Enter/Space are the same native button activation).
    fireEvent.click(item("Git"));

    expect(onClose).not.toHaveBeenCalled();
    expect(item("Compare with HEAD")).toBeInTheDocument();
    expect(item("Git")).toHaveAttribute("aria-expanded", "true");
  });

  it("ArrowRight opens the submenu and focuses its first item; ArrowLeft closes it and refocuses the parent", async () => {
    const user = userEvent.setup();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={vi.fn()} ariaLabel="m" />);

    await user.keyboard("{ArrowDown}"); // Rename → Git (the separator is skipped)
    const git = item("Git");
    expect(document.activeElement).toBe(git);

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(item("Compare with HEAD"));

    await user.keyboard("{ArrowLeft}");
    expect(noItem("Compare with HEAD")).toBeNull();
    expect(document.activeElement).toBe(git);
  });

  it("Escape closes the submenu only; a second Escape closes the whole menu", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    await user.hover(item("Git"));
    expect(document.activeElement).toBe(item("Compare with HEAD"));

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled(); // ONE layer peeled
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(item("Git"));

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selecting an item inside a submenu fires its onSelect AND the root onClose", async () => {
    const onCompare = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu items={gitMenu({ onCompare })} x={0} y={0} onClose={onClose} ariaLabel="m" />);

    const user = userEvent.setup();
    await user.hover(item("Git"));
    await user.click(item("Compare with HEAD"));

    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1); // the WHOLE tree closes, not just the child
  });

  it("a submenu's own focus ring behaves like the root's, and its keys never reach the root", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        items={[
          {
            label: "Git",
            items: [
              { label: "Stage", onSelect: vi.fn(), disabled: true },
              { label: "Compare", onSelect: vi.fn() },
              { label: "Revert", onSelect: vi.fn(), danger: true },
            ],
          },
          { label: "Delete", onSelect: vi.fn() },
        ]}
        x={0}
        y={0}
        onClose={vi.fn()}
        ariaLabel="m"
      />,
    );

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(item("Compare")); // first ENABLED, not "Stage"

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Revert"));
    await user.keyboard("{ArrowDown}"); // wraps, skipping the disabled "Stage"
    expect(document.activeElement).toBe(item("Compare"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("Revert"));

    // The root's own ring never moved: its roving tabindex is still on "Git".
    expect(item("Git")).toHaveAttribute("tabindex", "0");
    expect(item("Delete")).toHaveAttribute("tabindex", "-1");
  });

  it("a disabled submenu never opens — on hover, on click, or from the keyboard", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ContextMenu items={gitMenu({ disabled: true })} x={0} y={0} onClose={vi.fn()} ariaLabel="m" />,
    );

    const git = item("Git");
    expect(git).toBeDisabled();
    expect(git).toHaveAttribute("aria-expanded", "false");
    // The focus ring never lands on it, so ArrowRight can never reach it either.
    expect(document.activeElement).toBe(item("Rename"));

    await user.hover(git);
    fireEvent.mouseOver(git); // a raw mouseover too, not only userEvent's gesture
    await user.click(git);
    fireEvent.click(git);
    expect(noItem("Compare with HEAD")).toBeNull();
    expect(menus()).toHaveLength(1);

    await user.keyboard("{ArrowDown}"); // skips the disabled "Git"
    expect(document.activeElement).toBe(item("Delete"));
    await user.keyboard("{ArrowRight}"); // on a leaf: a no-op
    expect(noItem("Compare with HEAD")).toBeNull();

    unmount();

    // Two-sided: the SAME menu with the parent enabled does open,
    // so the assertions above are about `disabled` and not about a typo.
    render(<ContextMenu items={gitMenu()} x={0} y={0} onClose={vi.fn()} ariaLabel="m" />);
    await user.hover(item("Git"));
    expect(item("Compare with HEAD")).toBeInTheDocument();
  });

  it("ArrowRight is a no-op with nothing focusable, and ArrowLeft is a no-op at the root", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        items={[{ label: "A", onSelect: vi.fn(), disabled: true }]}
        x={0}
        y={0}
        onClose={onClose}
        ariaLabel="m"
      />,
    );

    fireEvent.keyDown(menuEl(), { key: "ArrowRight" }); // activeIndex === -1
    fireEvent.keyDown(menuEl(), { key: "ArrowLeft" }); // the root has no parent to return to
    expect(menus()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves a flat menu exactly as it was — no nested surface, no haspopup, no chevron", () => {
    render(
      <ContextMenu
        items={[
          { label: "New File", onSelect: vi.fn() },
          { separator: true },
          { label: "Delete", onSelect: vi.fn(), danger: true },
        ]}
        x={0}
        y={0}
        onClose={vi.fn()}
        ariaLabel="m"
      />,
    );

    expect(menus()).toHaveLength(1);
    for (const b of items()) {
      expect(b).not.toHaveAttribute("aria-haspopup");
      expect(b).not.toHaveClass("has-submenu");
      expect(b.querySelector(".context-menu__chevron")).toBeNull();
    }
  });
});

describe("ContextMenu — submenu geometry (stubbed rects; real pixels live in the browser tier)", () => {
  /** A `DOMRect` can't be spread (its fields are prototype accessors), so build the literal. */
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;

  /** Every menu surface is `w`×`h`; every menuitem sits at the given box. */
  function stubLayout(surface: { w: number; h: number }, itemBox: DOMRect): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element): DOMRect {
      return this.classList.contains("context-menu__item") ? itemBox : rect(0, 0, surface.w, surface.h);
    });
  }

  const openGit = (): HTMLElement => {
    render(<ContextMenu items={gitMenu()} x={10} y={10} onClose={vi.fn()} ariaLabel="m" />);
    fireEvent.click(item("Git"));
    return screen.getByRole("menu", { name: "Git" });
  };

  it("sits to the RIGHT of its parent item, top-aligned with it", () => {
    stubLayout({ w: 200, h: 100 }, rect(50, 80, 190, 24));

    const child = openGit();

    // left = the item's right edge (50 + 190); top = the item's top.
    expect(Number.parseFloat(child.style.left)).toBe(240);
    expect(Number.parseFloat(child.style.top)).toBe(80);
    // ...and it still fits: 240 + 200 = 440 ≤ 1024 - 6.
    expect(240 + 200).toBeLessThanOrEqual(window.innerWidth - MENU_MARGIN);
  });

  it("flips to the LEFT of its parent item when the right-hand placement would overflow", () => {
    // right edge 990 + a 200-wide child = 1190, past 1024 - 6 → flip.
    stubLayout({ w: 200, h: 100 }, rect(800, 80, 190, 24));

    const child = openGit();

    // left = the item's LEFT edge minus the child's width (800 - 200).
    expect(Number.parseFloat(child.style.left)).toBe(600);
    expect(Number.parseFloat(child.style.top)).toBe(80);
    // The flipped surface ends exactly at the item's left edge, inside the viewport.
    expect(600 + 200).toBe(800);
    expect(600 + 200).toBeLessThanOrEqual(window.innerWidth - MENU_MARGIN);
  });

  it("clamps back from the bottom edge the same way the root does", () => {
    // top 700 + a 100-tall child = 800, past 768 - 6 → shift up to 768 - 6 - 100.
    stubLayout({ w: 200, h: 100 }, rect(50, 700, 190, 24));

    const child = openGit();

    expect(Number.parseFloat(child.style.top)).toBe(window.innerHeight - MENU_MARGIN - 100);
    expect(Number.parseFloat(child.style.top)).toBe(662);
    expect(Number.parseFloat(child.style.left)).toBe(240);
  });
});

describe("ContextMenu — viewport clamping", () => {
  it("shifts the surface back from the right and bottom edges", () => {
    // A 200×150 surface anchored near the bottom-right of the 1024×768 viewport.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 150,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    } as DOMRect);

    render(<ContextMenu items={[{ label: "A", onSelect: vi.fn() }]} x={1000} y={700} onClose={vi.fn()} ariaLabel="m" />);

    const el = menuEl();
    // left = innerWidth - MARGIN - width = 1024 - 6 - 200 = 818
    expect(el.style.left).toBe(`${window.innerWidth - MENU_MARGIN - 200}px`);
    // top = innerHeight - MARGIN - height = 768 - 6 - 150 = 612
    expect(el.style.top).toBe(`${window.innerHeight - MENU_MARGIN - 150}px`);
  });
});
