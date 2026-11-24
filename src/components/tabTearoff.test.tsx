/**
 * Tab tear-off from the thing the user touches (a store-level test cannot see
 * which action a BUTTON calls). Both ways:
 *
 *  - the COMMAND — the tab's right-click menu: "Move to New Window" / "Move to Main Window",
 *    offered only where they make sense, absent for kinds that cannot leave a window;
 *  - the GESTURE — a tab dragged and let go with no drop target asks whether it was released
 *    outside the window (`tearOffIfReleasedOutside`), and a tab from ANOTHER window dropped on
 *    a strip or a pane is asked for (`takeForeignDrop`) instead of "moved" by an id that means
 *    nothing here.
 *
 * The moves themselves are spied (their behaviour is `app/tearoff/handoff.test.ts`); the
 * store and the menu are real.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../features/terminal/TerminalView", () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => <div data-testid="terminal-view" data-terminal-id={terminalId} />,
}));
vi.mock("../features/editor", () => ({
  CodeEditor: ({ path }: { path: string }) => <div data-testid="code-editor" data-path={path} />,
  disposeEditorBuffer: vi.fn(),
}));

const moves = vi.hoisted(() => ({
  moveTabToNewWindow: vi.fn(async () => true),
  moveTabToMainWindow: vi.fn(async () => true),
}));
vi.mock("../app/tearoff/handoff", () => moves);

const gesture = vi.hoisted(() => ({
  tearOffIfReleasedOutside: vi.fn(async () => false),
  takeForeignDrop: vi.fn(() => false),
}));
vi.mock("../app/tearoff/gesture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/tearoff/gesture")>()),
  ...gesture,
}));

import { findNode, leavesOf, useAppStore } from "../app/store";
import type { PaneId, TabId } from "../app/types";
import { makeDataTransfer } from "../test/dnd";
import { resetFleetStore } from "../test/fleet-harness";
import { resetStore } from "../test/store-harness";
import { Pane } from "./Pane";
import { TAB_DND_MIME, TAB_WINDOW_MIME, tabWindowMenuItems, TabBar } from "./TabBar";

function LiveTabBar({ paneId }: { paneId: PaneId }) {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <TabBar paneId={paneId} tabIds={node.tabIds} activeTabId={node.activeTabId} />;
}
function LivePane({ paneId }: { paneId: PaneId }) {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <Pane node={node} />;
}

const actions = () => useAppStore.getState().layoutActions;
const paneId = () => leavesOf(useAppStore.getState().layout)[0].id;
const tabs = () => screen.getAllByRole("tab");

function asWindow(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label } },
  };
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/* ─────────────────────────────── the command ─────────────────────────────── */

describe("tabWindowMenuItems", () => {
  const go = () => undefined;
  it("offers each destination only when it applies", () => {
    const labels = (newWindow: boolean, mainWindow: boolean) =>
      tabWindowMenuItems({ newWindow, mainWindow, toNewWindow: go, toMainWindow: go }).map(
        (i) => (i as { label: string }).label,
      );
    expect(labels(true, false)).toEqual(["Move to New Window"]);
    expect(labels(true, true)).toEqual(["Move to New Window", "Move to Main Window"]);
    expect(labels(false, true)).toEqual(["Move to Main Window"]);
    expect(labels(false, false)).toEqual([]);
  });
});

describe("the tab's right-click menu", () => {
  it("in the main window: Move to New Window — which moves THIS tab", async () => {
    actions().openTerminalTab({ cwd: "/w/a" });
    const second = actions().openTerminalTab({ cwd: "/w/b" });
    render(<LiveTabBar paneId={paneId()} />);
    fireEvent.contextMenu(tabs()[1], { clientX: 40, clientY: 12 });

    const menu = screen.getByRole("menu", { name: "Move b" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Move to New Window"]);
    // A sibling of the tab, never inside it (a drag or middle-click on an item would hit the tab).
    expect(tabs()[1].contains(menu)).toBe(false);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to New Window" }));
    expect(moves.moveTabToNewWindow).toHaveBeenCalledWith(second);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("in a detached window: both destinations; Move to Main Window sends it home", async () => {
    asWindow("tearoff-1");
    const first = actions().openVillageTab();
    actions().openNetworkTab();
    render(<LiveTabBar paneId={paneId()} />);
    fireEvent.contextMenu(tabs()[0]);
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Move to New Window", "Move to Main Window"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to Main Window" }));
    expect(moves.moveTabToMainWindow).toHaveBeenCalledWith(first);
    expect(moves.moveTabToNewWindow).not.toHaveBeenCalled();
  });

  it("the only tab of a detached window can only go home — it already has its own window", () => {
    asWindow("tearoff-1");
    actions().openVillageTab();
    render(<LiveTabBar paneId={paneId()} />);
    fireEvent.contextMenu(tabs()[0]);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Move to Main Window"]);
  });

  it("a kind that cannot leave its window has no menu — and still no webview page menu", () => {
    actions().openApiRequestTab();
    render(<LiveTabBar paneId={paneId()} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void tabs()[0].dispatchEvent(event));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it("Escape closes the menu without moving anything", async () => {
    actions().openVillageTab();
    render(<LiveTabBar paneId={paneId()} />);
    fireEvent.contextMenu(tabs()[0]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(moves.moveTabToNewWindow).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────── the gesture ─────────────────────────────── */

describe("dragging a tab", () => {
  it("names the window it comes from on the drag, beside the tab id", () => {
    asWindow("tearoff-4");
    const id = actions().openVillageTab();
    render(<LiveTabBar paneId={paneId()} />);
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(tabs()[0], { dataTransfer });
    expect(dataTransfer.getData(TAB_DND_MIME)).toBe(id);
    expect(dataTransfer.getData(TAB_WINDOW_MIME)).toBe("tearoff-4");
  });

  it("let go where no drop target took it: asks whether that was OUTSIDE the window", () => {
    const id = actions().openVillageTab();
    render(<LiveTabBar paneId={paneId()} />);
    const dataTransfer = { ...makeDataTransfer(), dropEffect: "none" };
    fireEvent.dragEnd(tabs()[0], { dataTransfer });
    expect(gesture.tearOffIfReleasedOutside).toHaveBeenCalledWith(id);
  });

  it("a drop a target accepted is an ordinary move — no tear-off question", () => {
    actions().openVillageTab();
    render(<LiveTabBar paneId={paneId()} />);
    fireEvent.dragEnd(tabs()[0], { dataTransfer: { ...makeDataTransfer(), dropEffect: "move" } });
    fireEvent.dragEnd(tabs()[0]); // a synthetic dragend with no DataTransfer at all
    expect(gesture.tearOffIfReleasedOutside).not.toHaveBeenCalled();
  });

  it("a tab from ANOTHER window dropped on the strip is asked for, not moved by a foreign id", () => {
    const own = actions().openVillageTab();
    actions().openNetworkTab();
    render(<LiveTabBar paneId={paneId()} />);
    gesture.takeForeignDrop.mockReturnValue(true);
    const strip = screen.getByRole("tablist");
    const dataTransfer = makeDataTransfer({ [TAB_DND_MIME]: own, [TAB_WINDOW_MIME]: "tearoff-2" });
    fireEvent.drop(strip, { dataTransfer });
    expect(gesture.takeForeignDrop).toHaveBeenCalledWith(own, "tearoff-2");
    // The local reorder did NOT run: the strip's order is untouched.
    expect(leavesOf(useAppStore.getState().layout)[0].tabIds[0]).toBe(own);
  });

  it("this window's own tab dropped on the strip still reorders", () => {
    const first = actions().openVillageTab();
    actions().openNetworkTab();
    render(<LiveTabBar paneId={paneId()} />);
    gesture.takeForeignDrop.mockReturnValue(false);
    fireEvent.drop(screen.getByRole("tablist"), {
      dataTransfer: makeDataTransfer({ [TAB_DND_MIME]: first, [TAB_WINDOW_MIME]: "main" }),
    });
    expect(gesture.takeForeignDrop).toHaveBeenCalledWith(first, "main");
    // jsdom rects are 0×0, so the drop index is "append": the first tab moved to the end.
    expect(leavesOf(useAppStore.getState().layout)[0].tabIds[1]).toBe(first);
  });

  it("a tab from another window dropped on a PANE is asked for too — the zone does not apply", () => {
    const id = actions().openVillageTab();
    const { container } = render(<LivePane paneId={paneId()} />);
    gesture.takeForeignDrop.mockReturnValue(true);
    const body = container.querySelector(".pane__body") as HTMLElement;
    const before = useAppStore.getState().layout;
    fireEvent.drop(body, {
      dataTransfer: makeDataTransfer({ [TAB_DND_MIME]: "foreign-tab", [TAB_WINDOW_MIME]: "tearoff-3" }),
    });
    expect(gesture.takeForeignDrop).toHaveBeenCalledWith("foreign-tab", "tearoff-3");
    expect(useAppStore.getState().layout).toBe(before);
    expect(useAppStore.getState().tabs[id as TabId]).toBeDefined();
  });
});
