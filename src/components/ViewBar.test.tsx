/**
 * ViewBar — the top-level strip of views.
 *
 * Driven through the REAL store slice (`views` / `activeViewId` /
 * `layoutActions.{createView,activateView,renameView,closeView,moveTabToView,
 * reorderViews}`), because the questions worth asking here are integration
 * questions: does switching swap the whole arrangement, and does the work
 * inside it survive?
 *
 * The three seams that can actually be wrong, and are falsified here:
 *   1. switching renders the TARGET view's tree and not the previous one;
 *   2. a terminal is NOT re-created across a switch — same xterm instance, same
 *      PTY, same scrollback (the reason inactive views need no keep-alive);
 *   3. the close confirmation reports the TRUE tab count, read live for the
 *      active view rather than from its stale snapshot — and says what actually
 *      happens to those tabs (`closeView` rescues them; it does not kill them).
 *
 * The pure gesture cases drive `<ViewBarView>` with props instead: rename,
 * reorder and the confirmation wording are presentation, and a store adds
 * nothing to proving them.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asViewId, useAppStore, type ViewId, type ViewSnapshot } from "../app/store";
import type { TabId, TerminalId } from "../app/types";
import { disposeAll, getTerminal } from "../features/terminal";
import { fireDragAt, makeDataTransfer, stubRect } from "../test/dnd";
import { resetStore } from "../test/store-harness";
import { installTauriMock, type ChannelDriver, type TauriMock } from "../test/tauri-mock";
import { PaneTreeRoot } from "./PaneTree";
import { TAB_DND_MIME } from "./TabBar";
import {
  VIEW_DND_MIME,
  ViewBar,
  ViewBarView,
  closeLabel,
  rescueTargetName,
  type ViewChip,
  type ViewBarViewProps,
} from "./ViewBar";

const store = () => useAppStore.getState();
const actions = () => useAppStore.getState().layoutActions;

/** Chip labels, in strip order. */
const chipTitles = () =>
  [...document.querySelectorAll(".view-tab__title")].map((el) => el.textContent);
/** Chip tab-count badges, in strip order. */
const chipCounts = () =>
  [...document.querySelectorAll(".view-tab__count")].map((el) => el.textContent);
/** Tab titles inside the PANE strips (the sub-level), not the view strip. */
const paneTabTitles = () =>
  [...document.querySelectorAll(".pane-tab__title")].map((el) => el.textContent ?? "");

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

/* ─────────────────── the strip, over the real store ─────────────────── */

describe("ViewBar — chips", () => {
  it("renders one chip per view, in order, with the active one marked", () => {
    actions().renameView(store().activeViewId, "Agents");
    actions().createView("Logs");
    actions().createView("Review");
    actions().activateView(store().views[1].id);

    render(<ViewBar />);

    expect(chipTitles()).toEqual(["Agents", "Logs", "Review"]);
    const chips = screen.getAllByRole("tab");
    expect(chips.map((c) => c.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    // Focusable only where focus should land — the tab strip's own rule.
    expect(chips.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("shows each view's tab count, taken LIVE for the active view", () => {
    // The active view's snapshot is stale BY CONTRACT: it is refreshed only on
    // the way out. So a bar that counted from `views[i].layout` would report the
    // count from whenever the view was last left — here, zero.
    actions().openTerminalTab({ cwd: "/w/a" });
    actions().openTerminalTab({ cwd: "/w/b" });
    const second = actions().createView("Logs"); // switches; writes 2 tabs back
    actions().openTerminalTab({ cwd: "/w/c" });
    expect(store().activeViewId).toBe(second);

    render(<ViewBar />);
    expect(chipCounts()).toEqual(["2", "1"]);
  });

  it("clicking a chip activates that view", () => {
    const second = actions().createView("Logs");
    actions().activateView(store().views[0].id);
    render(<ViewBar />);

    fireEvent.click(screen.getByRole("tab", { name: /Logs/ }));
    expect(store().activeViewId).toBe(second);
  });

  it("the + creates a view and switches to it", () => {
    render(<ViewBar />);
    const before = store().activeViewId;

    fireEvent.click(screen.getByRole("button", { name: "New view" }));

    expect(store().views).toHaveLength(2);
    expect(store().activeViewId).not.toBe(before);
    expect(chipTitles()).toEqual(["View 1", "View 2"]);
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("renames a view from the bar, and refuses an empty name", () => {
    render(<ViewBar />);

    fireEvent.doubleClick(screen.getByText("View 1"));
    const input = screen.getByRole("textbox", { name: "Rename view View 1" });
    fireEvent.change(input, { target: { value: "Agents" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store().views[0].name).toBe("Agents");

    fireEvent.doubleClick(screen.getByText("Agents"));
    const again = screen.getByRole("textbox", { name: "Rename view Agents" });
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(store().views[0].name).toBe("Agents");
  });

  it("closes a view from the bar, rescuing its tabs", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/a" });
    actions().createView("Logs"); // now active
    render(<ViewBar />);

    fireEvent.click(screen.getByRole("button", { name: "Close view View 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Close “View 1”/ }));

    expect(store().views.map((v) => v.name)).toEqual(["Logs"]);
    // Rescued, not killed: the tab record survives and lives in the survivor.
    expect(store().tabs[tabId]).toBeDefined();
    expect(chipCounts()).toEqual(["1"]);
  });

  it("moves a tab into another view when it is dropped on that view's chip", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/a" });
    const target = actions().createView("Logs");
    actions().activateView(store().views[0].id);

    render(<ViewBar />);

    const chip = screen.getByRole("tab", { name: /Logs/ });
    const dt = makeDataTransfer({ [TAB_DND_MIME]: tabId });
    fireDragAt(chip, "dragOver", [10, 10], dt);
    fireDragAt(chip, "drop", [10, 10], dt);

    // The tab record is untouched — only which pane holds its id moved.
    expect(store().tabs[tabId]).toBeDefined();
    expect(
      store().views.find((v) => v.id === target)?.layout,
    ).toMatchObject({ tabIds: [tabId] });
  });

  it("reorders the strip by dragging a chip", () => {
    actions().createView("Logs");
    actions().createView("Review");
    render(<ViewBar />);

    const chips = screen.getAllByRole("tab");
    // jsdom has no layout engine: without real rects every drop reads as
    // "append" and the position assertion below would be vacuous.
    chips.forEach((chip, i) => stubRect(chip, { left: i * 100, top: 0, width: 100, height: 32 }));

    const dt = makeDataTransfer();
    fireDragAt(chips[2], "dragStart", [250, 10], dt);
    fireDragAt(screen.getByTestId("view-bar"), "drop", [10, 10], dt);

    expect(store().views.map((v) => v.name)).toEqual(["Review", "View 1", "Logs"]);
  });
});

/* ────────────────── the strip, as pure presentation ────────────────── */

describe("ViewBarView — gestures", () => {
  const chip = (id: string, name: string, tabCount = 0): ViewChip => ({
    id: asViewId(id),
    name,
    tabCount,
  });

  const props = (overrides: Partial<ViewBarViewProps> = {}): ViewBarViewProps => ({
    views: [chip("a", "Agents", 3), chip("b", "Logs", 1)],
    activeViewId: asViewId("a"),
    onActivate: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onMoveTabToView: vi.fn(),
    rescueTargetOf: () => "Logs",
    ...overrides,
  });

  it("F2 on a chip starts the rename", () => {
    const onRename = vi.fn();
    render(<ViewBarView {...props({ onRename })} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: /Agents/ }), { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Rename view Agents" });
    fireEvent.change(input, { target: { value: "  Fleet  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("a", "Fleet");
  });

  it("Esc cancels a rename", () => {
    const onRename = vi.fn();
    render(<ViewBarView {...props({ onRename })} />);

    fireEvent.doubleClick(screen.getByText("Agents"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename view Agents" }), {
      key: "Escape",
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("Enter and Space on a chip activate it", () => {
    const onActivate = vi.fn();
    render(<ViewBarView {...props({ onActivate })} />);

    const logs = screen.getByRole("tab", { name: /Logs/ });
    fireEvent.keyDown(logs, { key: "Enter" });
    fireEvent.keyDown(logs, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenLastCalledWith("b");
  });

  it("leaves every other key to the browser", () => {
    // The chip is a `role="tab"`, so arrow keys and type-ahead belong to the
    // surrounding widget, not to it. Swallowing them (or worse, activating on
    // them) would make the strip unusable from the keyboard.
    const onActivate = vi.fn();
    const onRename = vi.fn();
    render(<ViewBarView {...props({ onActivate, onRename })} />);

    const logs = screen.getByRole("tab", { name: /Logs/ });
    // `fireEvent` returns false when the handler called `preventDefault()`.
    expect(fireEvent.keyDown(logs, { key: "ArrowRight" })).toBe(true);
    expect(fireEvent.keyDown(logs, { key: "l" })).toBe(true);
    expect(fireEvent.keyDown(logs, { key: "Enter" })).toBe(false); // the control

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("refuses to close the last view", () => {
    const onClose = vi.fn();
    render(<ViewBarView {...props({ views: [chip("a", "Agents", 3)], onClose })} />);

    const close = screen.getByRole("button", { name: "Close view Agents" });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the confirmation names the true count and where those tabs go", () => {
    const onClose = vi.fn();
    render(<ViewBarView {...props({ onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: "Close view Agents" }));
    const menu = screen.getByRole("menu", { name: "Close view Agents?" });
    const item = within(menu).getByText("Close “Agents” — its 3 tabs move to “Logs”");

    fireEvent.click(item);
    expect(onClose).toHaveBeenCalledWith("a");
  });

  it("“Keep it” dismisses without closing", () => {
    const onClose = vi.fn();
    render(<ViewBarView {...props({ onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: "Close view Logs" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Keep it"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("worded for one tab and for none", () => {
    expect(closeLabel("Logs", 1, "Agents")).toBe("Close “Logs” — its 1 tab move to “Agents”");
    expect(closeLabel("Logs", 0, "Agents")).toBe("Close “Logs” — it is empty");
    expect(closeLabel("Logs", 4, "Agents")).toBe("Close “Logs” — its 4 tabs move to “Agents”");
  });

  it("hovering a dragged tab marks the chip, and leaving clears it", () => {
    const onMoveTabToView = vi.fn();
    render(<ViewBarView {...props({ onMoveTabToView })} />);

    const logs = screen.getByRole("tab", { name: /Logs/ });
    const dt = makeDataTransfer({ [TAB_DND_MIME]: "tab-7" });
    fireDragAt(logs, "dragOver", [10, 10], dt);
    expect(logs.className).toContain("view-tab--tab-target");
    expect(dt.dropEffect).toBe("move");

    fireEvent.dragLeave(logs);
    expect(logs.className).not.toContain("view-tab--tab-target");

    fireDragAt(logs, "drop", [10, 10], dt);
    expect(onMoveTabToView).toHaveBeenCalledWith("tab-7", "b");
  });

  it("ignores a drag carrying neither a tab nor a view", () => {
    const onMoveTabToView = vi.fn();
    const onReorder = vi.fn();
    render(<ViewBarView {...props({ onMoveTabToView, onReorder })} />);

    const chipEl = screen.getByRole("tab", { name: /Logs/ });
    const dt = makeDataTransfer({ "text/plain": "hello" });
    fireDragAt(chipEl, "dragOver", [10, 10], dt);
    fireDragAt(chipEl, "drop", [10, 10], dt);
    fireDragAt(screen.getByTestId("view-bar"), "dragOver", [10, 10], dt);
    fireDragAt(screen.getByTestId("view-bar"), "drop", [10, 10], dt);

    expect(onMoveTabToView).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });

  /**
   * A `dataTransfer` can advertise a type and carry nothing under it — this app
   * does it deliberately elsewhere (the API panel's self-drop marker), and a drag
   * that starts outside the app can too. So "the type is in the list" is not "there
   * is an id here": acting on the empty string would move tab `""` or reorder view
   * `""`, and the strip would be left lit as if something had happened.
   */
  it("ignores a chip drop that advertises a tab but carries no id", () => {
    const onMoveTabToView = vi.fn();
    render(<ViewBarView {...props({ onMoveTabToView })} />);

    const logs = screen.getByRole("tab", { name: /Logs/ });
    const empty = makeDataTransfer({ [TAB_DND_MIME]: "" });
    fireDragAt(logs, "dragOver", [10, 10], empty);
    expect(logs.className).toContain("view-tab--tab-target");

    fireDragAt(logs, "drop", [10, 10], empty);

    expect(onMoveTabToView).not.toHaveBeenCalled();
    expect(logs.className).not.toContain("view-tab--tab-target");
  });

  it("ignores a strip drop that advertises a view but carries no id", () => {
    const onReorder = vi.fn();
    render(<ViewBarView {...props({ onReorder })} />);
    const chips = screen.getAllByRole("tab");
    chips.forEach((c, i) => stubRect(c, { left: i * 100, top: 0, width: 100, height: 32 }));
    const bar = screen.getByTestId("view-bar");
    const empty = makeDataTransfer({ [VIEW_DND_MIME]: "" });

    fireDragAt(bar, "dragOver", [10, 10], empty);
    expect(chips[0].className).toContain("view-tab--insert-before");

    fireDragAt(bar, "drop", [10, 10], empty);

    expect(onReorder).not.toHaveBeenCalled();
    expect(chips[0].className).not.toContain("view-tab--insert-before");
  });

  it("drops onto the chip it would land before, and onto null past the end", () => {
    const onReorder = vi.fn();
    render(<ViewBarView {...props({ onReorder })} />);
    const chips = screen.getAllByRole("tab");
    chips.forEach((c, i) => stubRect(c, { left: i * 100, top: 0, width: 100, height: 32 }));
    const bar = screen.getByTestId("view-bar");
    const dt = makeDataTransfer({ [VIEW_DND_MIME]: "b" });

    fireDragAt(bar, "dragOver", [10, 10], dt);
    expect(chips[0].className).toContain("view-tab--insert-before");
    fireDragAt(bar, "drop", [10, 10], dt);
    expect(onReorder).toHaveBeenLastCalledWith("b", "a");

    // Past the last midpoint → append, which `reorderViews` spells as `null`.
    fireDragAt(bar, "dragOver", [900, 10], dt);
    expect(chips[1].className).toContain("view-tab--insert-after");
    fireDragAt(bar, "drop", [900, 10], dt);
    expect(onReorder).toHaveBeenLastCalledWith("b", null);
  });

  it("clears the insertion line on drag-leave, but not into a descendant", () => {
    render(<ViewBarView {...props()} />);
    const chips = screen.getAllByRole("tab");
    chips.forEach((c, i) => stubRect(c, { left: i * 100, top: 0, width: 100, height: 32 }));
    const bar = screen.getByTestId("view-bar");
    const dt = makeDataTransfer({ [VIEW_DND_MIME]: "b" });

    fireDragAt(bar, "dragOver", [10, 10], dt);
    const inner = new Event("dragleave", { bubbles: true });
    Object.defineProperty(inner, "relatedTarget", { value: chips[0] });
    fireEvent(bar, inner);
    expect(chips[0].className).toContain("view-tab--insert-before");

    fireEvent.dragLeave(bar);
    expect(chips[0].className).not.toContain("view-tab--insert-before");
  });
});

/* ─────────────── where a close would rescue the tabs to ─────────────── */

describe("rescueTargetName — mirrors closeView's survivor rule", () => {
  const view = (id: string, name: string): ViewSnapshot =>
    ({ id: asViewId(id), name }) as ViewSnapshot;
  const three = [view("a", "A"), view("b", "B"), view("c", "C")];

  it("hands the ACTIVE view over to the next one, else the previous", () => {
    expect(rescueTargetName(three, asViewId("a"), asViewId("a"))).toBe("B");
    expect(rescueTargetName(three, asViewId("c"), asViewId("c"))).toBe("B");
  });

  it("lands an inactive view's tabs in the active view", () => {
    expect(rescueTargetName(three, asViewId("b"), asViewId("a"))).toBe("B");
    expect(rescueTargetName(three, asViewId("b"), asViewId("c"))).toBe("B");
  });

  it("is null when the close would be refused", () => {
    expect(rescueTargetName([view("a", "A")], asViewId("a"), asViewId("a"))).toBeNull();
    expect(rescueTargetName(three, asViewId("a"), asViewId("zz") as ViewId)).toBeNull();
  });

  it("is what the bar actually quotes", () => {
    // The store's rule and the bar's wording, end to end: closing the ACTIVE
    // "View 1" hands over to "Logs", so that is the name in the confirmation.
    actions().openTerminalTab({ cwd: "/w/a" });
    actions().createView("Logs");
    actions().activateView(store().views[0].id);
    render(<ViewBar />);

    fireEvent.click(screen.getByRole("button", { name: "Close view View 1" }));
    expect(
      screen.getByRole("menuitem", { name: "Close “View 1” — its 1 tab move to “Logs”" }),
    ).toBeInTheDocument();
  });
});

/* ──────────────────── switching: the decisive seams ──────────────────── */

describe("switching a view", () => {
  let ipc: TauriMock;
  const ptys = new Map<string, ChannelDriver>();

  const terminalIdOf = (tabId: TabId): TerminalId => {
    const ref = store().tabs[tabId].ref;
    if (ref.kind !== "terminal" && ref.kind !== "agent-terminal")
      throw new Error("not a terminal tab");
    return ref.terminalId;
  };

  /** Let the registry's `await openTerminal(...)` settle, then xterm's writes. */
  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function scrollbackOf(terminalId: TerminalId): string {
    const term = getTerminal(terminalId);
    if (!term) return "";
    const out: string[] = [];
    for (let i = 0; i < term.buffer.active.length; i++) {
      out.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
    }
    return out.join("\n");
  }

  beforeEach(() => {
    ptys.clear();
    ipc = installTauriMock();
    ipc.handle("terminal_open", (args) => {
      ptys.set(args.terminalId as string, ipc.channel().capture(args.onOutput));
      return {
        id: args.terminalId,
        kind: "terminal",
        title: "sh",
        cwd: "/w/gazelle",
        cols: 80,
        rows: 24,
        status: "live",
      };
    });
    ipc.handle("terminal_write", () => null);
    ipc.handle("terminal_resize", () => null);
    ipc.handle("terminal_close", () => null);
  });

  afterEach(() => {
    cleanup();
    disposeAll();
    ipc.reset();
  });

  it("renders the target view's tree and NOT the previous one", async () => {
    const first = store().activeViewId;
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    actions().renameTab(tabId, "gazelle");

    render(<PaneTreeRoot />);
    await settle();
    expect(paneTabTitles()).toEqual(["gazelle"]);

    const second = actions().createView("Logs");
    await settle();

    // View 1's tab is gone from the DOM — not hidden, not duplicated. Only the
    // active view's tree is ever rendered; inactive views are pure data.
    expect(store().activeViewId).toBe(second);
    expect(paneTabTitles()).toEqual([]);
    expect(document.querySelectorAll(".pane")).toHaveLength(1);

    await act(async () => actions().activateView(first));
    await settle();
    expect(paneTabTitles()).toEqual(["gazelle"]);
  });

  it("keeps the SAME xterm instance, its PTY and its scrollback across a switch", async () => {
    // The decisive architectural fact: `TerminalRegistry` owns the emulator and
    // the PTY outside React, so unmounting an inactive view's tree costs
    // nothing. If this ever goes red, views need a keep-alive scheme — and this
    // is the test that would say so.
    const first = store().activeViewId;
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const termId = terminalIdOf(tabId);

    render(<PaneTreeRoot />);
    await settle();

    const instanceBefore = getTerminal(termId);
    expect(instanceBefore).toBeDefined();
    ptys.get(termId)?.send(new TextEncoder().encode("precious-scrollback-42\r\n"));
    await settle();
    expect(scrollbackOf(termId)).toContain("precious-scrollback-42");

    const opens = () => ipc.calls("terminal_open").filter((c) => c.args.terminalId === termId);
    expect(opens()).toHaveLength(1);

    const second = actions().createView("Logs");
    await settle();
    // Unmounted, but never disposed: the emulator and its PTY are still alive.
    expect(getTerminal(termId)).toBe(instanceBefore);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    await act(async () => actions().activateView(first));
    await settle();

    expect(getTerminal(termId)).toBe(instanceBefore);
    expect(scrollbackOf(termId)).toContain("precious-scrollback-42");
    expect(opens()).toHaveLength(1);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    // Still wired to the hot plane after the round trip.
    ptys.get(termId)?.send(new TextEncoder().encode("still-connected\r\n"));
    await settle();
    expect(scrollbackOf(termId)).toContain("still-connected");

    // And the second view really was a separate, empty arrangement.
    await act(async () => actions().activateView(second));
    await settle();
    expect(paneTabTitles()).toEqual([]);
  });

  it("re-attaches the emulator's DOM into the returning view's pane", async () => {
    // Re-attach is what triggers the refit: `attach()` fits synchronously and
    // re-observes the host, so a tree that comes back at a different size is
    // measured against the NEW geometry rather than the view you just left.
    // (The fit ITSELF is unmeasurable in jsdom — no layout engine — and is
    // pinned by `features/terminal/terminalFit.browser.test.tsx`.)
    const first = store().activeViewId;
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const termId = terminalIdOf(tabId);

    const { container } = render(<PaneTreeRoot />);
    await settle();

    actions().createView("Logs");
    await settle();
    expect(container.querySelector(`[data-terminal-id="${termId}"]`)).toBeNull();

    await act(async () => actions().activateView(first));
    await settle();

    const host = container.querySelector(`[data-terminal-id="${termId}"]`) as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.querySelector(".xterm")).toBeTruthy();
    expect(container.contains(host)).toBe(true);
  });

  it("a tab dragged onto another view's chip keeps its terminal alive there", async () => {
    // Switching to another view holding two more terminals — proven at the
    // level that matters: the PTY is never reopened or closed.
    const first = store().activeViewId;
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const termId = terminalIdOf(tabId);
    const second = actions().createView("Logs");
    actions().activateView(first);

    render(
      <>
        <ViewBar />
        <PaneTreeRoot />
      </>,
    );
    await settle();
    const instanceBefore = getTerminal(termId);
    ptys.get(termId)?.send(new TextEncoder().encode("moved-me\r\n"));
    await settle();

    const chip = screen.getByRole("tab", { name: /Logs/ });
    const dt = makeDataTransfer({ [TAB_DND_MIME]: tabId });
    await act(async () => {
      fireDragAt(chip, "drop", [10, 10], dt);
    });
    await settle();

    // It left this view…
    expect(paneTabTitles()).toEqual([]);
    // …and the terminal was neither reopened nor closed on the way.
    expect(getTerminal(termId)).toBe(instanceBefore);
    expect(ipc.calls("terminal_open").filter((c) => c.args.terminalId === termId)).toHaveLength(1);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    await act(async () => actions().activateView(second));
    await settle();
    expect(getTerminal(termId)).toBe(instanceBefore);
    expect(scrollbackOf(termId)).toContain("moved-me");
  });
});
