/** Lives with the feature, not in the shared `store.test.ts` / `Pane.test.tsx`. `openMetricsTab`
 * is a singleton that re-points the existing tab to the new project (a stale label would mislabel
 * the numbers). */

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel itself fetches over Tauri on mount; stub it and assert the pane hands it
// the right cwd (its own suite drives the real thing — the same division Pane.test.tsx
// uses for CodeEditor and SessionPicker).
vi.mock("./MetricsPanel", () => ({
  MetricsPanel: ({ cwd }: { cwd: string | null }) => (
    <div data-testid="metrics-panel-stub" data-cwd={cwd ?? "(null)"} />
  ),
}));

vi.mock("../terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("../fleet/fleetIpc", () => ({ subagentActivity: vi.fn().mockResolvedValue([]) }));
vi.mock("../editor", () => ({ CodeEditor: () => <div data-testid="code-editor" /> }));
vi.mock("../sessions/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));

import { Pane } from "../../components/Pane";
import { findNode, useAppStore } from "../../app/store";
import type { LeafNode, PaneId } from "../../app/types";
import { resetStore } from "../../test/store-harness";

/** Mirrors how `<PaneTree>` feeds `<Pane>`: the live node for this PaneId. */
function LivePane({ paneId }: { paneId: PaneId }): React.JSX.Element | null {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <Pane node={node} />;
}

function rootLeaf(): LeafNode {
  const layout = useAppStore.getState().layout;
  if (layout.type !== "leaf") throw new Error("expected a single leaf");
  return layout;
}

beforeEach(() => {
  resetStore();
});

describe("openMetricsTab", () => {
  it("opens one tab, titles it and activates it in the focused leaf", () => {
    const id = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");

    const tab = useAppStore.getState().tabs[id];
    expect(tab.kind).toBe("metrics");
    expect(tab.title).toBe("Metrics");
    expect(tab.ref).toEqual({ kind: "metrics", cwd: "/work/proj" });
    expect(rootLeaf().tabIds).toContain(id);
    expect(rootLeaf().activeTabId).toBe(id);
  });

  it("🔴 is a SINGLETON — a second open re-focuses the same tab, it does not add one", () => {
    const first = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    // Move focus away so the re-focus is observable.
    const other = useAppStore.getState().layoutActions.openEditorTab("/work/proj/a.ts");
    expect(rootLeaf().activeTabId).toBe(other);

    const second = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");

    // There is one set of numbers about this machine, so a second dashboard would be
    // the same panel twice.
    expect(second).toBe(first);
    expect(
      Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "metrics"),
    ).toHaveLength(1);
    expect(rootLeaf().activeTabId).toBe(first);
  });

  it("re-points the existing tab at a NEW project rather than showing stale numbers", () => {
    const id = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    useAppStore.getState().layoutActions.openMetricsTab("/work/other");

    expect(useAppStore.getState().tabs[id].ref).toEqual({
      kind: "metrics",
      cwd: "/work/other",
    });
  });

  it("accepts a null project (no folder open yet) and re-points to and from it", () => {
    const id = useAppStore.getState().layoutActions.openMetricsTab(null);
    expect(useAppStore.getState().tabs[id].ref).toEqual({ kind: "metrics", cwd: null });

    useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    expect(useAppStore.getState().tabs[id].ref).toEqual({
      kind: "metrics",
      cwd: "/work/proj",
    });

    useAppStore.getState().layoutActions.openMetricsTab(null);
    expect(useAppStore.getState().tabs[id].ref).toEqual({ kind: "metrics", cwd: null });
  });

  it("is closable like any other tab, and can then be opened afresh", () => {
    const first = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    useAppStore.getState().layoutActions.closeTab(first);

    expect(useAppStore.getState().tabs[first]).toBeUndefined();
    const second = useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    expect(second).not.toBe(first);
    expect(useAppStore.getState().tabs[second].kind).toBe("metrics");
  });
});

describe("the pane's TabView case", () => {
  it("renders the metrics panel for a metrics tab, handing over the ref's cwd", () => {
    useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    render(<LivePane paneId={rootLeaf().id} />);

    const panel = screen.getByTestId("metrics-panel-stub");
    expect(panel.getAttribute("data-cwd")).toBe("/work/proj");
  });

  it("follows the tab when it is re-pointed, WITHOUT remounting", () => {
    useAppStore.getState().layoutActions.openMetricsTab("/work/proj");
    render(<LivePane paneId={rootLeaf().id} />);
    const before = screen.getByTestId("metrics-panel-stub");

    // `act` because the re-point happens outside React's event loop — the real caller
    // is a titlebar button, which React already wraps.
    act(() => {
      useAppStore.getState().layoutActions.openMetricsTab("/work/other");
    });

    const after = screen.getByTestId("metrics-panel-stub");
    expect(after.getAttribute("data-cwd")).toBe("/work/other");
    // Same DOM node: the view is deliberately NOT keyed by cwd, because remounting
    // would throw away the last good report and blank the panel mid-switch.
    expect(after).toBe(before);
  });

  it("passes a null cwd through as null, not as an empty string", () => {
    useAppStore.getState().layoutActions.openMetricsTab(null);
    render(<LivePane paneId={rootLeaf().id} />);

    expect(screen.getByTestId("metrics-panel-stub").getAttribute("data-cwd")).toBe("(null)");
  });
});
