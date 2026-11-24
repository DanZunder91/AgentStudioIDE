/**
 * The two fleet-view TABS (Agent Logs, Network) —
 * the store actions, the titlebar buttons that call them, and `<Pane>`'s routing.
 *
 * Pinned: both are **singletons** (a second click re-focuses, never mints a twin),
 * each button calls ITS action (a store test cannot see which action a
 * button calls), and `<Pane>` renders the right panel for each kind.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/agentlogs/AgentLogsPanel", () => ({
  AgentLogsPanel: () => <div data-testid="agent-logs-stub" />,
}));
vi.mock("../features/network/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="network-stub" />,
}));
vi.mock("../features/terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../features/terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

import { Pane } from "../components/Pane";
import { AgentLogsButton } from "../features/agentlogs";
import { NetworkButton } from "../features/network";
import { findNode, useAppStore } from "./store";
import type { PaneId } from "./types";
import { resetStore } from "../test/store-harness";

function LivePane({ paneId }: { paneId: PaneId }): React.JSX.Element | null {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <Pane node={node} />;
}

const tabsOf = (kind: string) =>
  Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === kind);

beforeEach(() => resetStore());

describe.each([
  { kind: "agent-logs", title: "Logs", open: () => useAppStore.getState().layoutActions.openAgentLogsTab(), stub: "agent-logs-stub", Button: AgentLogsButton, label: "Agent logs" },
  { kind: "network", title: "Network", open: () => useAppStore.getState().layoutActions.openNetworkTab(), stub: "network-stub", Button: NetworkButton, label: "Network traffic" },
])("the $kind tab", ({ kind, title, open, stub, Button, label }) => {
  it("opens once, activates, and a second open re-focuses the same tab", () => {
    let first = "";
    act(() => { first = open(); });
    const s = useAppStore.getState();
    expect(s.tabs[first as keyof typeof s.tabs]).toMatchObject({ kind, title, ref: { kind } });
    // Move focus away with a terminal-free second tab, then re-open.
    let other = "";
    act(() => { other = useAppStore.getState().layoutActions.openMetricsTab(null); });
    const leafId = s.focusedPaneId;
    const leaf = () => findNode(useAppStore.getState().layout, leafId);
    expect(leaf()).toMatchObject({ activeTabId: other });
    let second = "";
    act(() => { second = open(); });
    expect(second).toBe(first);
    expect(tabsOf(kind)).toHaveLength(1);
    expect(leaf()).toMatchObject({ activeTabId: first });
  });

  it("the titlebar button calls this action", () => {
    render(<Button />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(tabsOf(kind)).toHaveLength(1);
    // And not the sibling's.
    expect(tabsOf(kind === "network" ? "agent-logs" : "network")).toHaveLength(0);
  });

  it("<Pane> renders its panel", () => {
    act(() => open());
    render(<LivePane paneId={useAppStore.getState().focusedPaneId} />);
    expect(screen.getByTestId(stub)).toBeInTheDocument();
  });
});
