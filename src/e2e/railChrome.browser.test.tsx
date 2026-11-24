/**
 * Layer 5 (testing-strategy §1) — the rail chrome, in real pixels.
 *
 * Two user-facing behaviours that ONLY exist with a real layout engine (jsdom
 * has none, so every width here would be 0 and the assertions vacuous):
 *
 *  1. The titlebar panel toggles collapse/expand the left + right rails — the rail
 *     element actually goes `display:none` and comes back.
 *  2. The right rail no longer scrolls HORIZONTALLY. The bug: the Vault
 *     "Environments" editor overflowed the ~300px rail (a fixed 200px input) and
 *     the `+ Add` button was clipped, with a stray horizontal scrollbar. Here we
 *     add an environment and assert the panel's content fits its own width.
 */

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
    // Why this test's claim is strict rather than relaxed: four icon+label pairs needed
    // ~271px of a ~279px content box, so at RAIL_MIN_W=180 the strip wrapped and
    // "Collections" was clipped at the rail edge, because `.rail` is `overflow-x:hidden`
    // and over-wide content is CLIPPED, not scrolled (the rail-clipping failure mode).
    // The fix: drop the words, keep the glyph, label in the tooltip.
    //
    // A sixth (Tools) tab overflowed again: at a 14px gap the strip needed
    // 6×17 + 5×14 = 172px against 159px and wrapped to two rows. A 10px gap (152px) left
    // 7px of slack, but a SEVENTH tab does not fit at 10px — 7×17 + 6×10 = 179px — so a
    // smaller gap is not an answer; a smaller glyph or an overflow menu is.
    //
    // The seventh (Git) tab came with that answer: visibility is now
    // pure budget math over the store's `rightRailWidth`
    // (`src/features/workspace/railTabsLayout.ts` — no ResizeObserver; the rail's
    // width only ever changes through the store), and tabs past the cut fold behind
    // a tab-sized "⋯" trigger. So the one-row claim holds at EVERY width again, and
    // this test's job is to re-derive the budget from the LIVE boxes: the unit tier
    // proves the arithmetic, only a layout engine proves the pixels match it.
    // Only a real layout engine can decide this; under jsdom every box here is 0×0.
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
        // …and the button is still NAMED, which is the thing icon-only UI usually
        // gets wrong. Asserted here as well as in the unit test because a CSS change
        // that reintroduced a visible label would pass the unit test's textContent
        // check only if it also removed the aria-label.
        expect(t.getAttribute("aria-label")).toBeTruthy();
        // …and the whole button sits inside the rail's box (1px sub-pixel slack).
        const box = t.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(railBox.left - 1);
        expect(box.right).toBeLessThanOrEqual(railBox.right + 1);
      }
    };

    // The width BUDGET, re-derived from the live boxes so it tracks a CSS change
    // instead of restating a comment (assert the arithmetic, not the appearance —
    // "needed ≤ available" names the fix where "2 rows !== 1" does not).
    // With `flex-wrap: nowrap` this is also the assertion that catches a budget bug:
    // the wrap safety net is gone ON PURPOSE, so over-budget now means clipping, and
    // clipping means these numbers went red first.
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

    // 2. Dragged to its NARROWEST — the case that happens in practice. The math
    //    (visibleTabCount(180, 7) = 5) says five tabs + the trigger: 5×17 + 4×10 +
    //    10 + 17 = 152px inside the 159px content box. Asserted literally, ids and
    //    all, so a tab that silently stops rendering cannot make the fit claim vacuous.
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

    // 3. The overflow MENU at the drag-min: it lists the two folded tabs and its own
    //    box stays inside the rail — `.rail` is `overflow-x:hidden`, so a menu wider
    //    than the rail would be silently clipped (the rail-clipping failure mode
    //    again, one layer up). Numbers parsed from live boxes, never string-compared.
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
    // The Tools panel is the epoch ⇄ date converter, and it is the worst case this
    // rail has to hold: unbreakable 19-digit numbers, a full ISO
    // 8601 timestamp, an IANA zone name, and a four-row "also reads as" list — all in a
    // box that can be dragged to 180px. That is the rail-clipping failure mode's favourite
    // shape, and jsdom cannot see it: with no layout engine every box is 0×0, so
    // `scrollWidth <= clientWidth` is vacuously true in the unit tier no matter what the
    // CSS says. It can only be decided here.
    //
    // The input is driven the way a user drives it rather than by seeding
    // state, and it is given the NANOSECOND stamp on purpose: it is the longest single
    // token the tool can produce, it cannot be broken at a space, and every one of the
    // four unit readings is rendered at once.
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
      // And every VALUE box — the long, unbreakable ones — sits inside the rail.
      // `scrollWidth` alone can miss a child that overflows to the LEFT or is absolutely
      // positioned; this cannot. The selector names the three classes that carry a raw
      // value, so a new one added without `overflow-wrap` is only invisible to this test
      // if it is also a class nobody listed here.
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
