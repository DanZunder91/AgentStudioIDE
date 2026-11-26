/** TabBar, with `features/terminal` mocked (the real one builds xterm and opens PTYs over IPC). */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

import { findNode, leavesOf, useAppStore } from "../app/store";
import {
  asTabId,
  type AgentId,
  type LeafNode,
  type PaneId,
  type TabId,
} from "../app/types";
import { resetFleetStore } from "../test/fleet-harness";
import { resetStore } from "../test/store-harness";
import { TAB_DND_MIME, TabBar } from "./TabBar";

/** Feeds TabBar its leaf's live `tabIds`/`activeTabId` from the store, as <Pane> does. */
function LiveTabBar({ paneId }: { paneId: PaneId }) {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return (
    <TabBar paneId={paneId} tabIds={node.tabIds} activeTabId={node.activeTabId} />
  );
}

const actions = () => useAppStore.getState().layoutActions;
const leaf = (): LeafNode => leavesOf(useAppStore.getState().layout)[0];
const renderTabBar = () => render(<LiveTabBar paneId={leaf().id} />);
const tabs = () => screen.queryAllByRole("tab");

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
});

describe("TabBar — rendering", () => {
  it("renders one tab per tabId, in order, titled from the store", () => {
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    actions().openTerminalTab({ cwd: "/w/api" });
    renderTabBar();

    expect(tabs().map((t) => t.textContent)).toEqual(["gazelle", "api"]);
  });

  it("marks only the active tab selected and keyboard-reachable", () => {
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    actions().openTerminalTab({ cwd: "/w/api" });
    renderTabBar();

    const [first, second] = tabs();
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(first).toHaveAttribute("tabindex", "-1");
    // Roving tabindex: exactly one tab is in the tab order.
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("tabindex", "0");
  });

  it("renders an empty strip (just the + button) for a leaf with no tabs", () => {
    renderTabBar();
    expect(tabs()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "New terminal tab" })).toBeInTheDocument();
  });

  it("shows a dirty marker only for a dirty tab", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();
    expect(screen.queryByLabelText("Unsaved")).not.toBeInTheDocument();

    // Written the way bridge.ts writes it: imperatively, outside React.
    act(() => {
      useAppStore.setState((s) => {
        s.tabs[tabId].dirty = true;
      });
    });

    expect(screen.getByLabelText("Unsaved")).toBeInTheDocument();
    expect(tabs()[0]).toHaveClass("pane-tab--dirty");
  });

  it("renders nothing for a tabId whose record was already removed", () => {
    // Guards the `if (!tab) return null` race: the leaf still lists the id for
    // one render after the record is gone.
    render(
      <TabBar
        paneId={leaf().id}
        tabIds={[asTabId("ghost")]}
        activeTabId={asTabId("ghost")}
      />,
    );
    expect(tabs()).toHaveLength(0);
  });

  it("re-renders only the changed tab's title, sourced from the store", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    act(() => {
      useAppStore.setState((s) => {
        s.tabs[tabId].title = "renamed";
      });
    });

    expect(screen.getByRole("tab")).toHaveTextContent("renamed");
    expect(screen.getByRole("tab")).toHaveAttribute("title", "renamed");
  });
});

describe("TabBar — activation", () => {
  it("clicking a tab activates it and focuses its pane", async () => {
    const user = userEvent.setup();
    const a = actions().openTerminalTab({ cwd: "/w/gazelle" });
    actions().openTerminalTab({ cwd: "/w/api" });
    const paneId = leaf().id;
    // Move focus away so we can prove the click brings it back.
    actions().splitPane(paneId, "row");
    expect(useAppStore.getState().focusedPaneId).not.toBe(paneId);

    render(<LiveTabBar paneId={paneId} />);
    await user.click(screen.getByText("gazelle"));

    expect(findNode(useAppStore.getState().layout, paneId)).toMatchObject({
      activeTabId: a,
    });
    expect(useAppStore.getState().focusedPaneId).toBe(paneId);
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("TabBar — closing", () => {
  it("the close button removes the tab and disposes its terminal", async () => {
    const user = userEvent.setup();
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const ref = useAppStore.getState().tabs[tabId].ref;
    renderTabBar();

    await user.click(screen.getByRole("button", { name: "Close gazelle" }));

    expect(tabs()).toHaveLength(0);
    expect(useAppStore.getState().tabs[tabId]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(
      ref.kind === "terminal" || ref.kind === "agent-terminal" ? ref.terminalId : undefined,
    );
  });

  it("closing an inactive tab does not activate it on the way out", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    const b = actions().openTerminalTab({ cwd: "/w/api" });
    renderTabBar();

    // `gazelle` is inactive; its close button must stopPropagation so the tab's
    // own onClick (setActiveTab) never runs.
    await user.click(screen.getByRole("button", { name: "Close gazelle" }));

    expect(leaf().activeTabId).toBe(b);
    expect(tabs().map((t) => t.textContent)).toEqual(["api"]);
  });

  it("middle-click closes a tab", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    actions().openTerminalTab({ cwd: "/w/api" });
    renderTabBar();

    await user.pointer({
      target: screen.getByText("gazelle"),
      keys: "[MouseMiddle]",
    });

    expect(tabs().map((t) => t.textContent)).toEqual(["api"]);
  });

  it("closing a DIRTY editor tab raises the unsaved-changes confirm, not an outright close", async () => {
    const user = userEvent.setup();
    const state = () => useAppStore.getState();
    const tabId = state().layoutActions.openEditorTab("/w/notes.md");
    act(() => state().editorActions.setEditorDirty("/w/notes.md", true));
    renderTabBar();

    await user.click(screen.getByRole("button", { name: "Close notes.md" }));

    // Routed through requestCloseTab: pending confirm, tab still open.
    expect(state().confirmCloseTab).toBe(tabId);
    expect(state().tabs[tabId]).toBeDefined();
    expect(tabs()).toHaveLength(1);
  });

  it("other mouse buttons do not close a tab", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    await user.pointer({
      target: screen.getByText("gazelle"),
      keys: "[MouseRight]",
    });

    expect(tabs()).toHaveLength(1);
  });
});

describe("TabBar — 'Resumed after restart' on a restored agent's tab", () => {
  const fleet = () => useAppStore.getState().agentActions;

  it("points at the row's words with the same sentence, until the agent's next turn", () => {
    const agentId = fleet().createAgent({ cwd: "/w/gazelle" });
    act(() => fleet().applyRestoredAgents([{ agentId, outcome: "resumed", wasWorking: true }]));
    renderTabBar();

    const glyph = within(screen.getByRole("tab")).getByRole("img", {
      name: "Resumed · was working",
    });
    expect(glyph).toHaveAttribute(
      "title",
      "Resumed after restart — same conversation. Agent Studio was closed while it was working — tell it to continue.",
    );
    // The tab still reads as the agent's name; the glyph only points at the row.
    expect(screen.getByRole("tab")).toHaveAttribute("title", "gazelle");

    act(() => fleet().applyAgentEvent({ t: "status", agentId, status: "running" }));
    expect(within(screen.getByRole("tab")).queryByRole("img")).toBeNull();
  });

  it("tells a dormant agent's reason on its tab too, and never marks a plain terminal", () => {
    const agentId = fleet().createAgent({ cwd: "/w/gone" });
    act(() => {
      useAppStore.setState((s) => {
        s.agents[agentId].error = "not reopened after the restart: its folder no longer exists: /w/gone";
      });
      fleet().applyRestoredAgents([{ agentId, outcome: "dormant", wasWorking: null }]);
    });
    actions().openTerminalTab();
    renderTabBar();

    const marked = screen.getAllByRole("img", { name: "Not reopened" });
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAttribute(
      "title",
      "Not reopened after the restart: its folder no longer exists: /w/gone. Close it and it will not come back next time.",
    );
  });
});

describe("TabBar — the + button", () => {
  it("opens a terminal tab in ITS OWN pane, not merely the focused one", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row"); // focus moves to `created`
    expect(useAppStore.getState().focusedPaneId).toBe(created);

    render(<LiveTabBar paneId={origin} />);
    await user.click(screen.getByRole("button", { name: "New terminal tab" }));

    const originLeaf = findNode(useAppStore.getState().layout, origin) as LeafNode;
    expect(originLeaf.tabIds).toHaveLength(1);
    expect(
      (findNode(useAppStore.getState().layout, created) as LeafNode).tabIds,
    ).toHaveLength(0);
    // ...and opening a tab pulls focus to that pane.
    expect(useAppStore.getState().focusedPaneId).toBe(origin);
  });

  it("appends to the strip and activates the new tab", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    await user.click(screen.getByRole("button", { name: "New terminal tab" }));

    expect(tabs()).toHaveLength(2);
    expect(tabs()[1]).toHaveAttribute("aria-selected", "true");
  });

  it("opens with no cwd, so the terminal feature is not pre-configured", async () => {
    const user = userEvent.setup();
    renderTabBar();
    await user.click(screen.getByRole("button", { name: "New terminal tab" }));

    // The + button knows no cwd; the registry default applies (M2 supplies one).
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole("tab")).toHaveTextContent(/^Terminal \d+$/);
  });
});

describe("TabBar — drag source", () => {
  it("puts the TabId on the dataTransfer under our private MIME type", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("draggable", "true");

    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      effectAllowed: "",
    };
    // fireEvent (not user-event): jsdom implements no drag-and-drop, and
    // user-event deliberately does not emulate it.
    fireEvent.dragStart(tab, { dataTransfer });

    expect(data.get(TAB_DND_MIME)).toBe(tabId);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(tab).toHaveClass("pane-tab--dragging");

    fireEvent.dragEnd(tab);
    expect(screen.getByRole("tab")).not.toHaveClass("pane-tab--dragging");
  });
});

describe("TabBar — tab kinds", () => {
  it("renders an editor tab with its title alongside terminal tabs", () => {
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    const paneId = leaf().id;
    const docTab = asTabId("doc-1");
    useAppStore.setState((s) => {
      const node = findNode(s.layout, paneId) as LeafNode;
      s.tabs[docTab] = {
        id: docTab,
        kind: "editor",
        title: "Cargo.toml",
        ref: { kind: "editor", path: "/w/notes.md" },
      };
      node.tabIds.push(docTab);
    });

    renderTabBar();

    const editorTab = screen.getByTitle("Cargo.toml");
    expect(within(editorTab).getByText("Cargo.toml")).toBeInTheDocument();
    expect(tabs()).toHaveLength(2);
  });

  it("renders a session-picker tab with its title and the history (clock) icon", () => {
    actions().openSessionPickerTab("/w/gazelle");
    renderTabBar();

    const tab = screen.getByRole("tab");
    expect(within(tab).getByText("Sessions — gazelle")).toBeInTheDocument();
    // The kind-derived icon branch: the clock, not the terminal/file/globe glyph.
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="history"]')).not.toBeNull();
  });

  it("renders a db-console tab with the database (cylinder) icon", () => {
    actions().openDbConsoleTab("c1");
    renderTabBar();

    const tab = screen.getByRole("tab");
    // Without this branch a database console falls through to the TERMINAL glyph and
    // reads as a shell — and the tab strip is the one place a wrong icon is most
    // confusing, because it is often the only thing distinguishing two short titles.
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="database"]')).not.toBeNull();
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="terminal"]')).toBeNull();
  });

  it("renders a diff tab with the diff (+/−) icon, not the file or terminal glyph", () => {
    // A diff tab sits beside the same file's editor tab: the icon and the "↔ HEAD" suffix tell
    // them apart, so both are asserted.
    actions().openDiffTab("/w/src/main.rs");
    renderTabBar();

    const tab = screen.getByRole("tab");
    expect(within(tab).getByText("main.rs ↔ HEAD")).toBeInTheDocument();
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="diff"]')).not.toBeNull();
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="terminal"]')).toBeNull();
  });

  it("renders a sequence tab with its own icon, not the terminal glyph", () => {
    // A sequence tab is titled by the sequence's NAME, so without its own arm
    // here it would be indistinguishable from a terminal named the same thing.
    // The fourth sighting of this trap, after metrics, db-console and diff.
    const seqId = useAppStore.getState().sequenceActions.createSequence();
    useAppStore.getState().sequenceActions.setSequenceName(seqId, "Auth flow");
    actions().openSequenceTab(seqId);
    renderTabBar();

    const tab = screen.getByRole("tab");
    expect(within(tab).getByText("Auth flow")).toBeInTheDocument();
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="sequence"]')).not.toBeNull();
    expect(tab.querySelector('.pane-tab__icon svg[data-icon="terminal"]')).toBeNull();
  });

  it("prefers an explicit tab.icon over the kind-derived icon", () => {
    const tabId: TabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    useAppStore.setState((s) => {
      s.tabs[tabId].icon = "🚀";
    });
    renderTabBar();

    expect(screen.getByRole("tab")).toHaveTextContent("🚀");
  });
});

describe("TabBar — rename", () => {
  const state = () => useAppStore.getState();
  const titleInput = () => screen.getByRole("textbox", { name: /Rename tab/ });

  it("renders a plain tab's custom name over its derived title", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    act(() => actions().renameTab(tabId, "Build logs"));
    renderTabBar();

    expect(screen.getByRole("tab")).toHaveTextContent("Build logs");
  });

  it("double-clicking the title → Enter saves a custom tab name", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    await user.dblClick(screen.getByText("gazelle"));
    await user.clear(titleInput());
    await user.type(titleInput(), "Renamed{Enter}");

    const tabId = leaf().tabIds[0];
    expect(state().tabs[tabId].customTitle).toBe("Renamed");
    expect(screen.getByRole("tab")).toHaveTextContent("Renamed");
  });

  it("Esc cancels without saving", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderTabBar();

    await user.dblClick(screen.getByText("gazelle"));
    await user.clear(titleInput());
    await user.type(titleInput(), "discard{Escape}");

    const tabId = leaf().tabIds[0];
    expect(state().tabs[tabId].customTitle ?? null).toBeNull();
    expect(screen.getByRole("tab")).toHaveTextContent("gazelle");
  });

  it("saving empty reverts to the derived title", async () => {
    const user = userEvent.setup();
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    act(() => actions().renameTab(tabId, "Custom"));
    renderTabBar();

    await user.dblClick(screen.getByText("Custom"));
    await user.clear(titleInput());
    await user.type(titleInput(), "{Enter}");

    expect(state().tabs[tabId].customTitle).toBeNull();
    expect(screen.getByRole("tab")).toHaveTextContent("gazelle");
  });

  it("an agent-terminal tab renames the AGENT, and reflects a rename made on the agent", async () => {
    const user = userEvent.setup();
    // createAgent opens an agent-terminal tab keyed by the agent.
    const agentId = state().agentActions.createAgent({ cwd: "/w/gazelle" });
    renderTabBar();

    // Rename via the tab → writes to the AGENT (one name per agent).
    await user.dblClick(screen.getByText("gazelle"));
    await user.clear(titleInput());
    await user.type(titleInput(), "My Agent{Enter}");
    expect(state().agents[agentId].customTitle).toBe("My Agent");
    expect(screen.getByRole("tab")).toHaveTextContent("My Agent");

    // A rename made elsewhere (the rail row) shows in the tab too.
    act(() => state().agentActions.renameAgent(agentId, "From the rail"));
    expect(screen.getByRole("tab")).toHaveTextContent("From the rail");
  });

  it("an agent-activity tab renames the SUB-AGENT; closing it does NOT dismiss the agent", async () => {
    const user = userEvent.setup();
    const fleet = state().agentActions;
    const root = "root" as AgentId;
    const kid = "kid" as AgentId;
    act(() => {
      fleet.applyAgentEvent({
        t: "agent_started",
        agentId: root,
        parentId: null,
        title: "root",
        cwd: "/w/gazelle",
        branch: "trunk",
        runtime: "claude-code",
      });
      fleet.applyAgentEvent({
        t: "subagent_spawned",
        parentId: root,
        childAgentId: kid,
        title: "explore",
        cwd: "/w/gazelle",
        branch: "trunk",
        runtime: "claude-code",
      });
      // Selecting a sub-agent opens its read-only activity tab (no PTY).
      fleet.selectAgent(kid);
    });
    renderTabBar();

    // The tab carries the sub-agent's derived name.
    expect(screen.getByRole("tab")).toHaveTextContent("explore");

    // Rename via the tab writes to the AGENT, exactly like an agent-terminal tab.
    await user.dblClick(screen.getByText("explore"));
    await user.clear(titleInput());
    await user.type(titleInput(), "Recon{Enter}");
    expect(state().agents[kid].customTitle).toBe("Recon");
    expect(screen.getByRole("tab")).toHaveTextContent("Recon");

    // Closing the tab removes the view but leaves the sub-agent in the fleet:
    // an activity tab owns no terminal, so there is nothing to dismiss.
    await user.click(screen.getByRole("button", { name: "Close Recon" }));
    expect(tabs()).toHaveLength(0);
    expect(state().agents[kid]).toBeDefined();
    expect(state().dismissedAgentIds).not.toContain(kid);
  });
});
