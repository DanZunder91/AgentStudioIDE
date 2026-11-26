/** Overflow visibility is pure width math over the store's `rightRailWidth`, so jsdom tests it
 * all; whether the PIXELS fit is `src/e2e/railChrome.browser.test.tsx`'s claim. */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { RailTabs } from "./RailTabs";

/** Every tab id, written out — NOT read from the component's TABS table. */
const IDS = ["files", "vault", "history", "collections", "db", "tools", "git"] as const;
type Id = (typeof IDS)[number];

const tab = (name: Id) => screen.getByTestId(`rail-tab-${name}`);
const rightRailTab = () => useAppStore.getState().rightRailTab;
/** The decorative glyph inside a tab (there is exactly one). */
const icon = (name: Id) => tab(name).querySelector("svg");
/** Drive the ONE layout input the strip has: the store's rail width. */
const setWidth = (px: number) =>
  act(() => useAppStore.getState().uiActions.setRightRailWidth(px));

beforeEach(() => resetStore());
afterEach(cleanup);

describe("RailTabs", () => {
  it("defaults to Files selected, with Vault unselected; Find is not a rail tab", () => {
    render(<RailTabs />);
    expect(tab("files")).toHaveAttribute("aria-selected", "true");
    expect(tab("files")).toHaveClass("rail__tab--active");
    expect(tab("vault")).toHaveAttribute("aria-selected", "false");
    expect(tab("vault")).not.toHaveClass("rail__tab--active");
    // Find is a titlebar icon now — not present in the rail.
    expect(screen.queryByTestId("rail-tab-find")).toBeNull();
  });

  it("switches to the Vault panel and back to Files", () => {
    render(<RailTabs />);

    fireEvent.click(tab("vault"));
    expect(rightRailTab()).toBe("vault");
    expect(tab("vault")).toHaveAttribute("aria-selected", "true");
    expect(tab("vault")).toHaveClass("rail__tab--active");
    // Files is no longer the active panel.
    expect(tab("files")).toHaveAttribute("aria-selected", "false");
    expect(tab("files")).not.toHaveClass("rail__tab--active");

    fireEvent.click(tab("files"));
    expect(rightRailTab()).toBe("files");
    expect(tab("files")).toHaveAttribute("aria-selected", "true");
  });

  it("switches to the History panel", () => {
    render(<RailTabs />);
    expect(tab("history")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("history"));
    expect(rightRailTab()).toBe("history");
    expect(tab("history")).toHaveAttribute("aria-selected", "true");
    expect(tab("history")).toHaveClass("rail__tab--active");
    expect(tab("files")).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the Collections panel", () => {
    render(<RailTabs />);
    expect(tab("collections")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("collections"));
    expect(rightRailTab()).toBe("collections");
    expect(tab("collections")).toHaveAttribute("aria-selected", "true");
    expect(tab("collections")).toHaveClass("rail__tab--active");
    expect(tab("history")).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the DB panel", () => {
    render(<RailTabs />);
    expect(tab("db")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("db"));
    expect(rightRailTab()).toBe("db");
    expect(tab("db")).toHaveAttribute("aria-selected", "true");
    expect(tab("db")).toHaveClass("rail__tab--active");
    // Exactly one panel is selected at a time — the rail mounts one component.
    expect(tab("collections")).toHaveAttribute("aria-selected", "false");
    expect(tab("files")).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the Tools panel", () => {
    render(<RailTabs />);
    expect(tab("tools")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("tools"));
    expect(rightRailTab()).toBe("tools");
    expect(tab("tools")).toHaveAttribute("aria-selected", "true");
    expect(tab("tools")).toHaveClass("rail__tab--active");
    // The selection MOVED — it is not additive. `db` is the tab immediately before it
    // and the one a mis-wired `onClick` would most plausibly leave lit, so it is named
    // explicitly rather than trusted to the loop below.
    expect(tab("db")).toHaveAttribute("aria-selected", "false");
    expect(tab("db")).not.toHaveClass("rail__tab--active");
    expect(tab("files")).toHaveAttribute("aria-selected", "false");
    // Exactly one lit tab in the whole strip — the store holds ONE `rightRailTab`, and
    // this is the assertion that would catch a class that never gets cleared.
    expect(IDS.filter((id) => tab(id).classList.contains("rail__tab--active"))).toEqual([
      "tools",
    ]);
  });

  it("switches to the Git panel", () => {
    render(<RailTabs />);
    expect(tab("git")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("git"));
    expect(rightRailTab()).toBe("git");
    expect(tab("git")).toHaveAttribute("aria-selected", "true");
    expect(tab("git")).toHaveClass("rail__tab--active");
    // `tools` is the tab immediately before it — the copy-paste neighbour a mis-wired
    // `onClick` would most plausibly leave lit — so it is named explicitly.
    expect(tab("tools")).toHaveAttribute("aria-selected", "false");
    expect(tab("tools")).not.toHaveClass("rail__tab--active");
    expect(tab("files")).toHaveAttribute("aria-selected", "false");
    // Exactly one lit tab in the whole strip.
    expect(IDS.filter((id) => tab(id).classList.contains("rail__tab--active"))).toEqual([
      "git",
    ]);
  });

  it("renders exactly the seven tabs, in order, at the default 300px width", () => {
    render(<RailTabs />);
    // The width is the strip's ONE layout input, so it is set explicitly rather than
    // trusted to the harness default — this test's claim is "all seven at 300".
    setWidth(300);
    // Literal ids AND a literal count: a tab that silently stopped rendering would
    // otherwise only be caught by whichever test happened to name it.
    const rendered = Array.from(
      screen.getByLabelText("Workspace panels").querySelectorAll("button"),
    ).map((b) => b.getAttribute("data-testid"));
    expect(rendered).toEqual([
      "rail-tab-files",
      "rail-tab-vault",
      "rail-tab-history",
      "rail-tab-collections",
      "rail-tab-db",
      // Tools sits next to the database tab — position is part of the requirement,
      // so it is pinned here and not just counted.
      "rail-tab-tools",
      // Git is last because it is newest: `RightRailTab`'s union order is the display
      // order, and new members append.
      "rail-tab-git",
    ]);
    // All seven fit at 300 (179px of tabs+gaps inside 279px), so NO overflow trigger.
    expect(screen.queryByTestId("rail-tab-overflow")).toBeNull();
  });
});

describe("RailTabs — icons on the labels", () => {
  it("renders the icon ONLY, with the label as the tooltip and the accessible name", () => {
    render(<RailTabs />);

    // Icon-only: with no text node, `aria-label` is the ONLY thing giving these buttons a name.
    for (const [id, label] of [
      ["files", "Files"],
      ["vault", "Vault"],
      ["history", "History"],
      ["collections", "Collections"],
      // "DB", not "Database": the short form is fixed, and the tooltip is now
      // the only place the word appears at all.
      ["db", "DB"],
      // Capital T — it is the tooltip AND the a11y name.
      ["tools", "Tools"],
      // Short form again: "Git", the tool's own name, not "Source control".
      ["git", "Git"],
    ] as const) {
      expect(icon(id)).not.toBeNull();
      // No visible words — asserted on textContent so a label hidden by CSS would still
      // fail (a visually-hidden span would re-introduce the width it cost us).
      expect(tab(id).textContent).toBe("");
      expect(tab(id).querySelector(".rail__tab-label")).toBeNull();
      // …but the name and the tooltip are both the label.
      expect(tab(id)).toHaveAttribute("aria-label", label);
      expect(tab(id)).toHaveAttribute("title", label);
    }
  });

  it("keeps the icons out of the accessible name — no 'folder Files'", () => {
    render(<RailTabs />);

    // Every glyph is decoration: aria-hidden and not focusable.
    for (const id of IDS) {
      expect(icon(id)).toHaveAttribute("aria-hidden", "true");
      expect(icon(id)).toHaveAttribute("focusable", "false");
    }

    // …so the accessible name is still exactly the tab's own text. A leaked glyph
    // name would make these role+name lookups miss (or match "folder Files").
    expect(screen.getByRole("button", { name: "Files" })).toBe(tab("files"));
    expect(screen.getByRole("button", { name: "Vault" })).toBe(tab("vault"));
    expect(screen.getByRole("button", { name: "History" })).toBe(tab("history"));
    expect(screen.getByRole("button", { name: "Collections" })).toBe(tab("collections"));
    expect(screen.getByRole("button", { name: "DB" })).toBe(tab("db"));
    expect(screen.getByRole("button", { name: "Tools" })).toBe(tab("tools"));
    expect(screen.getByRole("button", { name: "Git" })).toBe(tab("git"));
    // And the strip still names itself for assistive tech.
    expect(screen.getByLabelText("Workspace panels")).toHaveClass("rail__tabs");
  });

  it("gives each tab its OWN glyph — folder / lock / clock / bookmark / database / wrench / branch", () => {
    render(<RailTabs />);

    // Literal expectations, not read from TABS: swapped icons or one shared placeholder fail.
    expect(icon("files")).toHaveAttribute("data-icon", "folder");
    expect(icon("vault")).toHaveAttribute("data-icon", "lock");
    expect(icon("history")).toHaveAttribute("data-icon", "clock");
    expect(icon("collections")).toHaveAttribute("data-icon", "bookmark");
    expect(icon("db")).toHaveAttribute("data-icon", "database");
    expect(icon("tools")).toHaveAttribute("data-icon", "wrench");
    // Asserted by NAME: the likely mistake is a copy-pasted `Icon:` still naming its neighbour.
    expect(icon("git")).toHaveAttribute("data-icon", "git-branch");

    // Belt and braces: seven DISTINCT shapes (a shared placeholder would collapse
    // this set even if the seven assertions above were kept in sync with it).
    const shapes = IDS.map((id) => icon(id)?.getAttribute("data-icon"));
    expect(new Set(shapes).size).toBe(7);
  });

  it("draws the icons with currentColor so they inherit the tab's colour state", () => {
    render(<RailTabs />);

    fireEvent.click(tab("history")); // one active tab, six dim ones
    for (const id of IDS) {
      // No hard-coded colour: the glyph takes the button's `color`, so the active text carries it.
      expect(icon(id)).toHaveAttribute("stroke", "currentColor");
      expect(icon(id)).toHaveAttribute("width", "13");
      expect(icon(id)).toHaveAttribute("height", "13");
    }
    // The colour state itself is still class-driven, exactly as before.
    expect(tab("history")).toHaveClass("rail__tab--active");
    expect(tab("files")).not.toHaveClass("rail__tab--active");
  });
});

describe("RailTabs — the overflow menu", () => {
  // Everything below is store-driven width math (railTabsLayout.ts): no layout reads,
  // so jsdom decides it all. The PIXEL truth (152 ≤ 159 at the drag-min, one row,
  // the menu inside the rail) is the browser tier's job.
  const trigger = () => screen.getByTestId("rail-tab-overflow");
  const menu = () => screen.queryByTestId("rail-overflow-menu");
  /** The strip's buttons in DOM order, by testid — includes the trigger when present. */
  const stripIds = () =>
    Array.from(screen.getByLabelText("Workspace panels").querySelectorAll("button"))
      .filter((b) => b.getAttribute("role") !== "menuitem")
      .map((b) => b.getAttribute("data-testid"));

  const FIVE_PLUS_TRIGGER = [
    "rail-tab-files",
    "rail-tab-vault",
    "rail-tab-history",
    "rail-tab-collections",
    "rail-tab-db",
    "rail-tab-overflow",
  ];

  it("folds Tools and Git behind the ⋯ trigger at RAIL_MIN_W", () => {
    render(<RailTabs />);
    setWidth(180);

    // visibleTabCount(180, 7) = 5: the first five stay, Tools and Git fold away, and
    // the trigger takes the sixth slot (5×17 + 4×10 + 10 + 17 = 152 ≤ 159).
    expect(stripIds()).toEqual(FIVE_PLUS_TRIGGER);
    expect(screen.queryByTestId("rail-tab-tools")).toBeNull();
    expect(screen.queryByTestId("rail-tab-git")).toBeNull();

    // The trigger is a real, named popover control — ellipsis glyph, no text.
    expect(trigger()).toHaveAttribute("aria-label", "More panels");
    expect(trigger()).toHaveAttribute("title", "More panels");
    expect(trigger()).toHaveAttribute("aria-haspopup", "true");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "ellipsis");
    expect(trigger().textContent).toBe("");
    // Closed by default.
    expect(menu()).toBeNull();
    // Files (visible) is the active panel, so the trigger is NOT lit.
    expect(trigger()).not.toHaveClass("rail__tab--active");
  });

  it("opens a labeled menu of the hidden tabs; choosing one selects the panel and closes", () => {
    render(<RailTabs />);
    setWidth(180);

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    // role="menu"/"menuitem", NOT role="tab" — the center TabBar owns that role and
    // smoke-core asserts a single getByRole("tab").
    const m = screen.getByRole("menu", { name: "More panels" });
    const items = within(m).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("data-testid"))).toEqual([
      "rail-menu-tools",
      "rail-menu-git",
    ]);
    // In the MENU the labels are VISIBLE text (unlike the strip) and are the
    // accessible names; each row keeps its own glyph.
    expect(within(m).getByRole("menuitem", { name: "Tools" })).toBe(items[0]);
    expect(within(m).getByRole("menuitem", { name: "Git" })).toBe(items[1]);
    expect(items[0].querySelector("svg")).toHaveAttribute("data-icon", "wrench");
    expect(items[1].querySelector("svg")).toHaveAttribute("data-icon", "git-branch");

    fireEvent.click(screen.getByTestId("rail-menu-git"));
    expect(rightRailTab()).toBe("git");
    expect(menu()).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("selection does NOT reorder the strip: a hidden active tab stays hidden and the trigger lights up", () => {
    render(<RailTabs />);
    setWidth(180);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("rail-menu-git"));
    expect(rightRailTab()).toBe("git");

    // Visibility is width math ALONE — selecting Git does not promote it into the
    // strip or evict anyone. Same five tabs, same order, same trigger.
    expect(stripIds()).toEqual(FIVE_PLUS_TRIGGER);
    expect(screen.queryByTestId("rail-tab-git")).toBeNull();
    // …but the selection is not visually lost: the trigger stands in for it.
    expect(trigger()).toHaveClass("rail__tab--active");
    expect(tab("files")).not.toHaveClass("rail__tab--active");

    // Re-open: the active row is marked (checkmark + class) — the menu's stand-in
    // for aria-selected, which is invalid on a menuitem.
    fireEvent.click(trigger());
    expect(screen.getByTestId("rail-menu-git")).toHaveClass("rail-tabs__item--current");
    expect(screen.getByTestId("rail-menu-git").querySelector(".rail-tabs__item-check")).not.toBeNull();
    expect(screen.getByTestId("rail-menu-tools")).not.toHaveClass("rail-tabs__item--current");
    expect(screen.getByTestId("rail-menu-tools").querySelector(".rail-tabs__item-check")).toBeNull();
  });

  it("closes on Escape (and ignores other keys)", () => {
    render(<RailTabs />);
    setWidth(180);
    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();

    fireEvent.keyDown(window, { key: "a" });
    expect(menu()).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    // Escape dismisses the MENU, not the selection.
    expect(rightRailTab()).toBe("files");
  });

  it("closes on an outside click but not on a click inside the menu", () => {
    render(<RailTabs />);
    setWidth(180);
    fireEvent.click(trigger());
    const m = menu();
    expect(m).not.toBeNull();

    // Inside (the menu's own padding): stays open.
    fireEvent.mouseDown(m as HTMLElement);
    expect(menu()).not.toBeNull();

    // Outside: closes. A visible tab is outside the trigger+menu cluster, so clicking
    // it both dismisses the menu (mousedown) and switches panels (click) — the
    // behaviour a user actually gets from one physical click.
    fireEvent.mouseDown(tab("vault"));
    expect(menu()).toBeNull();
    fireEvent.click(tab("vault"));
    expect(rightRailTab()).toBe("vault");
    // Still narrow: the trigger is still there, unlit (vault is visible).
    expect(screen.getByTestId("rail-tab-overflow")).not.toHaveClass("rail__tab--active");
  });

  it("dissolves back into the strip when the rail widens, closing an open menu", () => {
    render(<RailTabs />);
    setWidth(180);
    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();

    // Wide again: all seven in the strip, no trigger, no menu.
    setWidth(300);
    expect(screen.queryByTestId("rail-tab-overflow")).toBeNull();
    expect(menu()).toBeNull();
    expect(tab("tools")).toBeInTheDocument();
    expect(tab("git")).toBeInTheDocument();

    // Narrow again: the trigger returns CLOSED — the open state did not linger
    // across the round trip (the visible-count effect reset it).
    setWidth(180);
    expect(screen.getByTestId("rail-tab-overflow")).toHaveAttribute("aria-expanded", "false");
    expect(menu()).toBeNull();
  });

  it("follows railTabsLayout's exact boundary: 199px → five + trigger, 200px → all seven", () => {
    render(<RailTabs />);

    // 200 is where all seven fit (available 179 = exactly 7×17 + 6×10) — and because
    // the trigger costs exactly one tab, six-plus-trigger costs the same 179px, so the
    // strip never shows six of seven: it steps from 5+trigger straight to 7.
    setWidth(200);
    expect(stripIds()).toHaveLength(7);
    expect(screen.queryByTestId("rail-tab-overflow")).toBeNull();

    setWidth(199);
    expect(stripIds()).toEqual(FIVE_PLUS_TRIGGER);
  });
});
