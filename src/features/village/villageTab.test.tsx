/** Feature-local on purpose, not in the shared `store.test.ts` / `Pane.test.tsx`, though it covers
 * their village lines. */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("openVillageTab", () => {
  it("opens one tab, titles it and activates it in the focused leaf", () => {
    const id = useAppStore.getState().layoutActions.openVillageTab();

    const tab = useAppStore.getState().tabs[id];
    expect(tab.kind).toBe("village");
    expect(tab.title).toBe("Village");
    expect(tab.ref).toEqual({ kind: "village" });
    expect(rootLeaf().tabIds).toContain(id);
    expect(rootLeaf().activeTabId).toBe(id);
  });

  it("🔴 is a SINGLETON — a second open re-focuses the same tab, it does not add one", () => {
    const first = useAppStore.getState().layoutActions.openVillageTab();
    const other = useAppStore.getState().layoutActions.openEditorTab("/work/proj/a.ts");
    expect(rootLeaf().activeTabId).toBe(other);

    const second = useAppStore.getState().layoutActions.openVillageTab();

    expect(second).toBe(first);
    expect(
      Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "village"),
    ).toHaveLength(1);
    expect(rootLeaf().activeTabId).toBe(first);
  });

  it("is closable like any other tab, and can then be opened afresh", () => {
    const first = useAppStore.getState().layoutActions.openVillageTab();
    useAppStore.getState().layoutActions.closeTab(first);

    expect(useAppStore.getState().tabs[first]).toBeUndefined();
    const second = useAppStore.getState().layoutActions.openVillageTab();
    expect(second).not.toBe(first);
    expect(useAppStore.getState().tabs[second].kind).toBe("village");
  });
});

describe("the pane's TabView case", () => {
  it("renders the village panel, and the tab strip shows the house glyph", () => {
    useAppStore.getState().layoutActions.openVillageTab();
    const { container } = render(<LivePane paneId={rootLeaf().id} />);

    expect(screen.getByTestId("village-panel")).toBeInTheDocument();
    // The glyph is what separates "Village" from a terminal someone renamed "Village".
    expect(container.querySelector('[data-icon="village"]')).not.toBeNull();
  });
});
