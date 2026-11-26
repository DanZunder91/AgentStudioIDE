/** Pane/TabBar wiring for the api-request tab (`TabView` case + kind icon), gated with the
 * feature. Other tab bodies are mocked as in `Pane.test.tsx`; the api view itself is real. */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal", () => terminal);
vi.mock("../../features/terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("../../features/fleet/fleetIpc", () => ({
  subagentActivity: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../features/editor", () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));

// The API view hydrates its durable store on mount; keep that off Tauri in jsdom.
vi.mock("./apiStoreIpc", () => ({
  loadApiStore: vi.fn().mockResolvedValue({
    collections: [],
    environments: [],
    activeEnvironmentId: null,
  }),
  saveApiStore: vi.fn().mockResolvedValue(undefined),
}));

import { findNode, leavesOf, useAppStore } from "../../app/store";
import type { LeafNode, PaneId } from "../../app/types";
import { Pane } from "../../components/Pane";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";

/** Mirrors how <PaneTree> feeds <Pane>: the live node for this PaneId. */
function LivePane({ paneId }: { paneId: PaneId }) {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <Pane node={node} />;
}

const leaf = (): LeafNode => leavesOf(useAppStore.getState().layout)[0];

beforeEach(() => {
  resetStore();
  resetFleetStore();
});
afterEach(() => cleanup());

describe("api-request tab wiring", () => {
  it("draws a globe-iconned strip tab and routes the body to the ApiRequestView", () => {
    useAppStore.getState().layoutActions.openApiRequestTab();
    render(<LivePane paneId={leaf().id} />);

    // Header: the tab strip shows the request with the globe kind-icon (an <svg>).
    const tab = screen.getByRole("tab");
    expect(tab).toHaveTextContent("New request");
    expect(tab.querySelector(".pane-tab__icon svg")).toBeInTheDocument();

    // Body: TabView routed to the real ApiRequestView.
    expect(screen.getByTestId("api-request")).toBeInTheDocument();
    expect(screen.getByLabelText("HTTP method")).toBeInTheDocument();
  });
});
