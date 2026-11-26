/** Rail chrome in real pixels (testing-strategy §1): panel toggles really hide/show the rails,
 * and the right rail never scrolls horizontally. jsdom has no layout, so widths would be 0. */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import { RAIL_MIN_W, useAppStore } from "../app/store";
import { installE2EHarness, resetE2E, settle, teardownE2E, type E2EHarness } from "./harness";

/** Real computed `display` of the first element matching `sel`. */
const displayOf = (sel: string) => {
  const el = document.querySelector(sel);
  return el ? getComputedStyle(el).display : "(absent)";
};

describe("rail chrome — real browser geometry", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });
  afterEach(() => {
    teardownE2E(h.ipc);
  });

  it("collapses and re-expands the left and right rails from the titlebar toggles", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    // Both rails start visible (laid out, not display:none).
    expect(displayOf(".rail--left")).not.toBe("none");
    expect(displayOf(".rail--right")).not.toBe("none");

    // Collapse the left rail.
    await user.click(screen.getByTestId("rail-toggle-left"));
    await settle();
    expect(displayOf(".rail--left")).toBe("none");
    expect(displayOf(".rail--right")).not.toBe("none"); // right untouched
    expect(screen.getByTestId("rail-toggle-left")).toHaveAttribute("aria-pressed", "false");

    // Collapse the right rail too (independent — both can be collapsed at once).
    await user.click(screen.getByTestId("rail-toggle-right"));
    await settle();
    expect(displayOf(".rail--right")).toBe("none");
    expect(displayOf(".rail--left")).toBe("none");

    // Re-expand both.
    await user.click(screen.getByTestId("rail-toggle-left"));
    await user.click(screen.getByTestId("rail-toggle-right"));
    await settle();
    expect(displayOf(".rail--left")).not.toBe("none");
    expect(displayOf(".rail--right")).not.toBe("none");
    expect(screen.getByTestId("rail-toggle-left")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the Find-in-Files overlay from the titlebar magnifying-glass icon", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    // Find is a titlebar icon now (not a rail tab).
    expect(screen.queryByTestId("rail-tab-find")).toBeNull();
    await user.click(screen.getByTestId("titlebar-find"));
    await settle();
    // The scoped Find-in-Files overlay opened.
    expect(document.querySelector('[data-testid="find-in-files"]')).not.toBeNull();
  });

  it("keeps the CENTER pane full-width when a rail collapses (no shift into the gap)", async () => {
    // The bug: collapsing a rail with display:none dropped it from the grid,
    // so the center slid into the now-0px left column and vanished. Explicit
    // grid-column pins the center to column 2 regardless.
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const centerWidth = () =>
      (document.querySelector(".center") as HTMLElement).getBoundingClientRect().width;
    const before = centerWidth();
    expect(before).toBeGreaterThan(300); // center is the wide middle column

    // Collapse the LEFT rail — the center must GROW (take the freed space), never shrink to ~0.
    await user.click(screen.getByTestId("rail-toggle-left"));
    await settle();
    expect(centerWidth()).toBeGreaterThan(before);

    // Collapse the RIGHT rail too — center still full, never a sliver.
    await user.click(screen.getByTestId("rail-toggle-right"));
    await settle();
    expect(centerWidth()).toBeGreaterThan(before);
  });

  it("resizes the left rail by dragging its divider (real pixels)", async () => {
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const rail = document.querySelector(".rail--left") as HTMLElement;
    const before = rail.getBoundingClientRect().width;

    // Grab the left divider and drag it 80px to the right.
    const handle = screen.getByTestId("rail-resizer-left");
    const box = handle.getBoundingClientRect();
    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: box.x + 3, bubbles: true }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: box.x + 83, bubbles: true }),
      );
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await settle();

    const after = (document.querySelector(".rail--left") as HTMLElement).getBoundingClientRect()
      .width;
    expect(after).toBeGreaterThan(before + 40); // widened by ~80px (allow slack)
    // The drag must have cleaned up its global no-select guard.
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("keeps the Vault environments editor inside the rail — no horizontal overflow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    // Open Vault and add an environment (its add-variable row — KEY input, value,
    // and the `+ Add` button — is exactly what used to overflow the 300px rail).
    await user.click(screen.getByTestId("rail-tab-vault"));
    await user.click(await screen.findByTestId("vault-add-env"));
    await settle();

    const panel = screen.getByTestId("vault-panel");
    // The content fits the panel's own width: nothing extends past it, so no
    // horizontal scrollbar and nothing (the `+ Add` button) is clipped. +1px for
    // sub-pixel rounding.
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);

    // And the rail itself does not scroll horizontally.
    const rail = document.querySelector(".rail--right") as HTMLElement;
    expect(rail.scrollWidth).toBeLessThanOrEqual(rail.clientWidth + 1);
  });

  it("keeps the tab strip ONE row at every width — seven tabs at 300px, five + the ⋯ trigger at the drag-min", async () => {
    // `.rail` is `overflow-x:hidden`, so over-wide content is CLIPPED. Tab visibility is budget
    // math over `rightRailWidth` (`src/features/workspace/railTabsLayout.ts`), extras fold behind
    // "⋯"; the unit tier proves the arithmetic, this re-derives it from live boxes.
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    await settle();

    const rail = () => document.querySelector(".rail--right") as HTMLElement;
    const strip = () => document.querySelector(".rail__tabs") as HTMLElement;
    /** Every button IN the strip row: panel tabs + (when present) the ⋯ trigger. */
    const stripButtons = () =>
      Array.from(strip().querySelectorAll("button.rail__tab")) as HTMLElement[];
    const panelTabs = () =>
      stripButtons().filter((t) => !t.classList.contains("rail__tab--overflow"));
    const trigger = () =>
      strip().querySelector<HTMLElement>('[data-testid="rail-tab-overflow"]');

    // Sanity: non-degenerate boxes, or every assertion below passes trivially.
    expect(strip().getBoundingClientRect().width).toBeGreaterThan(100);

    /** Every strip button is laid out, named, glyph-only, and inside the rail. */
    const assertNothingClipped = () => {
      const railBox = rail().getBoundingClientRect();
      // The rail must not gain a horizontal scroll, and neither may the strip.
      expect(rail().scrollWidth).toBeLessThanOrEqual(rail().clientWidth + 1);
      expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);

      for (const t of stripButtons()) {
        const svg = t.querySelector("svg") as SVGElement;
        // The icon renders at its real 13px…
        expect(svg.getBoundingClientRect().width).toBeGreaterThan(8);
        // …there is no text taking width back (the trigger included)…
        expect(t.textContent).toBe("");
        // …and still NAMED (icon-only UI's usual miss); a visible label creeping back would pass
        // the unit test's textContent check only if it also dropped the aria-label.
        expect(t.getAttribute("aria-label")).toBeTruthy();
        // …and the whole button sits inside the rail's box (1px sub-pixel slack).
        const box = t.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(railBox.left - 1);
        expect(box.right).toBeLessThanOrEqual(railBox.right + 1);
      }
    };

    // Budget re-derived from live boxes ("needed ≤ available" names the fix). The wrap safety net
    // is gone ON PURPOSE (`nowrap`): over-budget means clipping, and these numbers go red first.
    const assertBudget = () => {
      const cs = getComputedStyle(strip());
      const btns = stripButtons();
      const needed =
        btns.reduce((sum, t) => sum + t.getBoundingClientRect().width, 0) +
        (btns.length - 1) * parseFloat(cs.columnGap);
      const available =
        strip().clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      expect(needed).toBeLessThanOrEqual(available);
    };

    const oneRow = () =>
      new Set(stripButtons().map((t) => Math.round(t.getBoundingClientRect().top))).size;

    // 1. At the DEFAULT 300px rail: ALL SEVEN tabs (179px of tabs+gaps inside
    //    279px), NO trigger, nothing clipped, one row, inside budget.
    expect(panelTabs()).toHaveLength(7);
    expect(trigger()).toBeNull();
    assertNothingClipped();
    assertBudget();
    expect(oneRow()).toBe(1);

    // 2. At its NARROWEST: visibleTabCount(180, 7) = 5, five tabs + the trigger (152px of 159).
    //    Ids asserted literally so a tab that stops rendering cannot make the fit vacuous.
    act(() => {
      useAppStore.getState().uiActions.setRightRailWidth(RAIL_MIN_W);
    });
    await settle();
    expect(rail().getBoundingClientRect().width).toBeLessThanOrEqual(RAIL_MIN_W + 1);
    expect(panelTabs().map((t) => t.getAttribute("data-testid"))).toEqual([
      "rail-tab-files",
      "rail-tab-vault",
      "rail-tab-history",
      "rail-tab-collections",
      "rail-tab-db",
    ]);
    expect(trigger()).not.toBeNull();
    // Tools and Git are FOLDED, not clipped: absent from the DOM, reachable below.
    expect(screen.queryByTestId("rail-tab-tools")).toBeNull();
    expect(screen.queryByTestId("rail-tab-git")).toBeNull();
    assertNothingClipped();
    assertBudget();
    expect(oneRow()).toBe(1);

    // 3. The overflow MENU at the drag-min lists the two folded tabs and fits inside the rail
    //    (`overflow-x:hidden` would clip it). Numbers parsed from live boxes.
    await user.click(trigger() as HTMLElement);
    await settle();
    const menu = document.querySelector('[data-testid="rail-overflow-menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent),
    ).toEqual(["Tools", "Git"]);
    const railBox = rail().getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    expect(menuBox.width).toBeGreaterThan(50); // non-degenerate, or the fit is vacuous
    expect(menuBox.left).toBeGreaterThanOrEqual(railBox.left - 1);
    expect(menuBox.right).toBeLessThanOrEqual(railBox.right + 1);
    // And opening it did not give the rail a horizontal scroll.
    expect(rail().scrollWidth).toBeLessThanOrEqual(rail().clientWidth + 1);
  });

  it("keeps the History panel inside the rail — no horizontal overflow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    await user.click(screen.getByTestId("rail-tab-history"));
    await settle();

    // Empty log here (the harness returns no entries), but the panel + note must
    // still fit; a regression that forced width would show even empty.
    const panel = screen.getByTestId("history-panel");
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    const rail = document.querySelector(".rail--right") as HTMLElement;
    expect(rail.scrollWidth).toBeLessThanOrEqual(rail.clientWidth + 1);
  });

  it("keeps the Tools panel inside the rail at BOTH widths, with its widest content", async () => {
    // The Tools epoch converter is the rail's worst case (unbreakable 19-digit tokens at 180px);
    // typed like a user, with the NANOSECOND stamp: the longest token, all four readings shown.
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    await user.click(screen.getByTestId("rail-tab-tools"));
    await settle();

    const panel = () => screen.getByTestId("tools-panel");
    const rail = () => document.querySelector(".rail--right") as HTMLElement;

    await user.type(
      screen.getByLabelText("Epoch or date to convert"),
      "1755412486123456789",
    );
    await settle();

    // Sanity first: a panel that rendered nothing would pass every fit assertion
    // trivially. The result block and all three alternate readings must be on screen.
    expect(screen.getByTestId("epoch-result")).not.toBeNull();
    expect(screen.getAllByTestId("epoch-other")).toHaveLength(3);
    expect(panel().getBoundingClientRect().width).toBeGreaterThan(100);

    const assertFits = () => {
      // Nothing extends past the panel's own width — so no horizontal scrollbar, and
      // nothing clipped by `.rail`'s `overflow-x: hidden`. +1px for sub-pixel rounding.
      expect(panel().scrollWidth).toBeLessThanOrEqual(panel().clientWidth + 1);
      expect(rail().scrollWidth).toBeLessThanOrEqual(rail().clientWidth + 1);
      // Every VALUE box sits inside the rail (catches left/absolute overflow `scrollWidth` misses).
      // The selector lists the three raw-value classes; a new one must be added here.
      const railBox = rail().getBoundingClientRect();
      const values = Array.from(
        panel().querySelectorAll(".epoch-row__value, .epoch-other__utc, .epoch-other__iso"),
      );
      expect(values.length).toBeGreaterThan(4); // not a vacuous loop
      for (const v of values) {
        const box = v.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(railBox.left - 1);
        expect(box.right).toBeLessThanOrEqual(railBox.right + 1);
      }
    };

    // 1. The default 300px rail.
    assertFits();

    // 2. Dragged to its narrowest — the case that happens in practice, and the one a
    //    fixed pixel width in a value row would fail.
    act(() => {
      useAppStore.getState().uiActions.setRightRailWidth(RAIL_MIN_W);
    });
    await settle();
    expect(rail().getBoundingClientRect().width).toBeLessThanOrEqual(RAIL_MIN_W + 1);
    assertFits();
  });
});
