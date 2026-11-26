/** Pane: one leaf (tab strip + toolbar + active view). Both terminal entry points are mocked;
 * the TerminalView stub records `terminalId` to assert PTY-to-tab wiring without xterm. */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

vi.mock("../features/terminal/TerminalView", () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-view" data-terminal-id={terminalId} />
  ),
}));

// A sub-agent's activity tab renders <ActivityView>, which polls this wrapper;
// stub it so the pane test never crosses Tauri.
const fleetIpc = vi.hoisted(() => ({
  subagentActivity: vi.fn().mockResolvedValue([]),
}));
vi.mock("../features/fleet/fleetIpc", () => fleetIpc);

// An editor tab renders <CodeEditor>, which mounts CodeMirror 6 — no layout
// engine under jsdom, so stub it (the real thing has its own browser-tier test).
vi.mock("../features/editor", () => ({
  CodeEditor: ({ path }: { path: string }) => (
    <div data-testid="code-editor" data-path={path} />
  ),
  // The store's closeTab/closePane call this on editor tabs (buffer teardown).
  disposeEditorBuffer: vi.fn(),
}));

// A session-picker tab renders <SessionPicker>, which fetches over Tauri on
// mount; stub it and assert the pane hands it the right cwd (its own tests
// drive the real thing — same division as CodeEditor above).
vi.mock("../features/sessions/SessionPicker", () => ({
  SessionPicker: ({ cwd }: { cwd: string }) => (
    <div data-testid="session-picker" data-cwd={cwd} />
  ),
}));

// DbConsoleTab mounts CodeMirror and the db slice, so it is stubbed; the stub records
// connectionId. Real behaviour: `features/db/console/DbConsoleTab.test.tsx`.
vi.mock("../features/db/console/DbConsoleTab", () => ({
  DbConsoleTab: ({ connectionId }: { connectionId: string }) => (
    <div data-testid="db-console-tab" data-connection-id={connectionId} />
  ),
}));

// DiffView builds a real @codemirror/merge view and calls `git_file_diff`, so it is stubbed;
// the stub records the path. Real behaviour: `features/git/DiffView.test.tsx`.
vi.mock("../features/git/DiffView", () => ({
  DiffView: ({ path }: { path: string }) => <div data-testid="diff-view" data-path={path} />,
}));
vi.mock("../features/api", () => ({
  ApiRequestView: ({ requestId }: { requestId: string }) => (
    <div data-testid="api-request-view" data-request={requestId} />
  ),
  SequenceView: ({ sequenceId }: { sequenceId: string }) => (
    <div data-testid="sequence-view" data-sequence={sequenceId} />
  ),
}));

import { findNode, leavesOf, useAppStore } from "../app/store";
import {
  asTabId,
  type AgentId,
  type LeafNode,
  type PaneId,
  type SplitNode,
  type TabId,
} from "../app/types";
import { fireDragAt, fireDragLeave, makeDataTransfer, stubRect } from "../test/dnd";
import { resetFleetStore } from "../test/fleet-harness";
import { resetStore } from "../test/store-harness";
import { Pane } from "./Pane";
import { TABBAR_CLASS, TAB_DND_MIME } from "./TabBar";

/** Mirrors how <PaneTree> feeds <Pane>: the live node for this PaneId. */
function LivePane({ paneId }: { paneId: PaneId }) {
  const node = useAppStore((s) => findNode(s.layout, paneId));
  if (!node || node.type !== "leaf") return null;
  return <Pane node={node} />;
}

const actions = () => useAppStore.getState().layoutActions;
const store = () => useAppStore.getState();
const leaf = (): LeafNode => leavesOf(store().layout)[0];
const leafById = (id: PaneId) => findNode(store().layout, id) as LeafNode;
const renderPane = (paneId: PaneId = leaf().id) =>
  render(<LivePane paneId={paneId} />);

/* ───────────────── drag-to-edge: geometry + event plumbing ─────────────────
 * jsdom has no layout (0×0 rects: `zoneFor` says "center") and no DragEvent (clientX/Y dropped),
 * so the rect is stubbed and coordinates are defined onto the event explicitly. */

/** The pane body's rect, as if laid out: 400×300 below a 34px tab strip. */
const BODY_RECT = { left: 0, top: 34, width: 400, height: 300 };

/** Points that land in each zone of BODY_RECT (edge band = outer 25%). */
const AT = {
  center: [200, 184],
  left: [10, 184],
  right: [390, 184],
  top: [200, 44],
  bottom: [200, 324],
  tabBar: [200, 10], // above the body — over the tab strip
} as const;

/** Lay out the strip: tabs 100px wide from x=0, else `insertionIndexAt` always appends under
 * jsdom. Re-stub after any re-render (React replaces the nodes). */
const TAB_WIDTH = 100;
function stubTabRects(container: HTMLElement, width = TAB_WIDTH) {
  const tabs = [...container.querySelectorAll<HTMLElement>(".pane-tab")];
  tabs.forEach((tab, i) => {
    tab.getBoundingClientRect = () =>
      ({
        left: i * width,
        top: 0,
        width,
        height: 34,
        right: (i + 1) * width,
        bottom: 34,
        x: i * width,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return tabs;
}

function stubBodyRect(container: HTMLElement, rect = BODY_RECT) {
  return stubRect(container.querySelector(".pane__body") as HTMLElement, rect);
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
  fleetIpc.subagentActivity.mockClear();
});

describe("Pane — focus", () => {
  it("marks the focused pane, and only it", () => {
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row"); // focus → created

    const { container } = renderPane(origin);
    expect(container.querySelector(".pane")).not.toHaveClass("pane--focused");

    act(() => actions().focusPane(origin));
    expect(container.querySelector(".pane")).toHaveClass("pane--focused");
    expect(store().focusedPaneId).not.toBe(created);
  });

  it("focus follows a click anywhere inside the pane", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    actions().splitPane(origin, "row");
    expect(store().focusedPaneId).not.toBe(origin);

    const { container } = renderPane(origin);
    await user.click(container.querySelector(".pane__body") as HTMLElement);

    expect(store().focusedPaneId).toBe(origin);
  });

  it("focus is claimed on the capture phase, even when a child stops the event", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    // A second tab so closing the first cannot empty (and thus collapse) the
    // pane — this test is about focus, not about pruning.
    actions().openTerminalTab({ paneId: origin, cwd: "/w/api" });
    actions().splitPane(origin, "row");
    expect(store().focusedPaneId).not.toBe(origin);

    renderPane(origin);
    // The tab's close button calls stopPropagation(); onMouseDownCapture still
    // runs first, so the pane must have taken focus regardless.
    await user.click(screen.getByRole("button", { name: "Close gazelle" }));

    expect(store().focusedPaneId).toBe(origin);
    expect(leafById(origin)).toBeTruthy();
  });

  it("keyboard focus into the pane claims pane focus too", () => {
    const origin = leaf().id;
    actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    actions().splitPane(origin, "row");
    expect(store().focusedPaneId).not.toBe(origin);

    renderPane(origin);
    fireEvent.focus(screen.getByRole("tab"));

    expect(store().focusedPaneId).toBe(origin);
  });
});

describe("Pane — body", () => {
  it("renders the empty-leaf placeholder when there is no active tab", () => {
    renderPane();
    expect(screen.getByText("This pane is empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New terminal$/ })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("the placeholder's 'New terminal' opens a tab in THIS pane", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row"); // focus → created

    renderPane(origin);
    await user.click(screen.getByRole("button", { name: /New terminal$/ }));

    expect(leafById(origin).tabIds).toHaveLength(1);
    expect(leafById(created).tabIds).toHaveLength(0);
    // Placeholder is gone; the terminal view took its place.
    expect(screen.queryByText("This pane is empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });

  it("renders the active terminal tab's view, keyed to its TerminalId", () => {
    const tabId = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const ref = store().tabs[tabId].ref;
    renderPane();

    const view = screen.getByTestId("terminal-view");
    expect(view).toHaveAttribute(
      "data-terminal-id",
      ref.kind === "terminal" || ref.kind === "agent-terminal" ? ref.terminalId : "",
    );
  });

  it("swaps the view when the active tab changes, one terminal at a time", async () => {
    const user = userEvent.setup();
    const a = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const b = actions().openTerminalTab({ cwd: "/w/api" });
    const termOf = (tabId: TabId) => {
      const ref = store().tabs[tabId].ref;
      return ref.kind === "terminal" || ref.kind === "agent-terminal" ? ref.terminalId : "";
    };
    renderPane();

    expect(screen.getByTestId("terminal-view")).toHaveAttribute(
      "data-terminal-id",
      termOf(b),
    );

    await user.click(screen.getByText("gazelle"));

    // Exactly one view is mounted — inactive terminals are not rendered.
    expect(screen.getAllByTestId("terminal-view")).toHaveLength(1);
    expect(screen.getByTestId("terminal-view")).toHaveAttribute(
      "data-terminal-id",
      termOf(a),
    );
  });

  it("renders the code editor for an editor tab, keyed to its path (M4)", () => {
    const paneId = leaf().id;
    const tabId = asTabId("doc-1");
    useAppStore.setState((s) => {
      const node = findNode(s.layout, paneId) as LeafNode;
      s.tabs[tabId] = {
        id: tabId,
        kind: "editor",
        title: "Cargo.toml",
        ref: { kind: "editor", path: "/w/Cargo.toml" },
      };
      node.tabIds.push(tabId);
      node.activeTabId = tabId;
    });

    renderPane();

    const editor = screen.getByTestId("code-editor");
    expect(editor).toHaveAttribute("data-path", "/w/Cargo.toml");
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders a sub-agent's read-only activity view for an agent-activity tab", async () => {
    const paneId = leaf().id;
    const kid = "kid" as AgentId;
    const tabId = asTabId("act-1");
    useAppStore.setState((s) => {
      s.agents[kid] = {
        id: kid,
        parentId: null,
        kind: "subagent",
        title: "explore",
        status: "running",
        branch: "trunk",
        cwd: "/w",
        runtime: "claude-code",
        startedAt: 1,
        finishedAt: null,
        lastActivityAt: 1,
        childIds: [],
        sessionId: null,
        expanded: false,
        unread: 0,
      };
      const node = findNode(s.layout, paneId) as LeafNode;
      s.tabs[tabId] = {
        id: tabId,
        kind: "agent-activity",
        title: "explore",
        ref: { kind: "agent-activity", agentId: kid },
      };
      node.tabIds.push(tabId);
      node.activeTabId = tabId;
    });

    renderPane();

    // The activity view mounts (not a terminal) and polls for THIS sub-agent.
    expect(await screen.findByTestId("activity-view")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(fleetIpc.subagentActivity).toHaveBeenCalledWith(kid);
  });

  it("renders the session picker for a session-picker tab, keyed to its cwd", () => {
    actions().openSessionPickerTab("/w/gazelle");
    renderPane();

    const picker = screen.getByTestId("session-picker");
    expect(picker).toHaveAttribute("data-cwd", "/w/gazelle");
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders the query console for a db-console tab, keyed to its connection", () => {
    // Guards `TabView`'s `db-console` arm: both halves can pass their tests with an empty body.
    actions().openDbConsoleTab("conn-42");
    renderPane();

    expect(screen.getByTestId("db-console-tab")).toHaveAttribute("data-connection-id", "conn-42");
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders the HEAD↔working diff for a diff tab, keyed to its file", () => {
    // Guards `TabView`'s `diff` arm, the seam both fully tested halves miss.
    actions().openDiffTab("/w/src/main.rs");
    renderPane();

    expect(screen.getByTestId("diff-view")).toHaveAttribute("data-path", "/w/src/main.rs");
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders the sequence view for a sequence tab, keyed to its sequence", () => {
    // The same missing-arm trap as metrics/db-console/diff: `openSequenceTab`
    // can be perfect and `<SequenceView/>` at 100%, and the pane still shows an
    // empty box if `TabView`'s switch has no `sequence` case.
    const seqId = useAppStore.getState().sequenceActions.createSequence();
    actions().openSequenceTab(seqId);
    renderPane();

    expect(screen.getByTestId("sequence-view")).toHaveAttribute("data-sequence", seqId);
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("gives a file's editor and its diff SEPARATE bodies (same path, two tabs)", () => {
    // Both tabs exist for one path; the pane must render whichever is active,
    // never both and never the wrong one.
    const editor = actions().openEditorTab("/w/src/main.rs");
    actions().openDiffTab("/w/src/main.rs");
    renderPane();

    expect(screen.getByTestId("diff-view")).toBeInTheDocument();
    expect(screen.queryByTestId("code-editor")).not.toBeInTheDocument();

    act(() => {
      actions().setActiveTab(leaf().id, editor);
    });

    expect(screen.getByTestId("code-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("renders nothing in the body when the active tab's record has vanished", () => {
    const paneId = leaf().id;
    useAppStore.setState((s) => {
      const node = findNode(s.layout, paneId) as LeafNode;
      node.tabIds.push(asTabId("ghost"));
      node.activeTabId = asTabId("ghost");
    });

    const { container } = renderPane();
    expect(container.querySelector(".pane__body")).toBeEmptyDOMElement();
  });
});

describe("Pane — toolbar", () => {
  it("'Split right' produces a row split with this pane first", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    renderPane(origin);

    await user.click(screen.getByRole("button", { name: "Split pane right" }));

    const root = store().layout as SplitNode;
    expect(root.type).toBe("split");
    expect(root.orientation).toBe("row");
    expect(root.children[0].id).toBe(origin);
    expect(root.sizes).toEqual([0.5, 0.5]);
  });

  it("'Split down' produces a column split", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: "Split pane down" }));

    expect((store().layout as SplitNode).orientation).toBe("column");
  });

  it("'Close pane' removes this pane", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row");
    actions().openTerminalTab({ paneId: created });

    renderPane(created);
    await user.click(screen.getByRole("button", { name: "Close pane" }));

    expect(findNode(store().layout, created)).toBeNull();
    expect(store().layout.id).toBe(origin);
  });

  it("reads 'Close all tabs' while it is the only pane, 'Close pane' once split", async () => {
    const user = userEvent.setup();
    const origin = leaf().id;
    renderPane(origin);

    // Sole pane: closing it cannot remove it (rule e), so the label says so.
    expect(screen.getByRole("button", { name: "Close pane" })).toHaveAttribute(
      "title",
      "Close all tabs",
    );

    await user.click(screen.getByRole("button", { name: "Split pane right" }));

    expect(screen.getByRole("button", { name: "Close pane" })).toHaveAttribute(
      "title",
      "Close pane",
    );
  });

  it("closing the sole pane empties it but keeps it on screen", async () => {
    const user = userEvent.setup();
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    renderPane();

    await user.click(screen.getByRole("button", { name: "Close pane" }));

    expect(screen.getByText("This pane is empty")).toBeInTheDocument();
    expect(store().tabs).toEqual({});
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("Pane — drop target", () => {
  it("highlights while a tab is dragged over it, and clears on leave", () => {
    const origin = leaf().id;
    const created = actions().splitPane(origin, "row");
    const { container } = renderPane(created);
    const pane = container.querySelector(".pane") as HTMLElement;

    const dataTransfer = makeDataTransfer({ [TAB_DND_MIME]: "t1" });
    fireEvent.dragOver(pane, { dataTransfer });

    expect(pane).toHaveClass("pane--drop-target");
    // preventDefault + dropEffect are what make it a legal drop target at all.
    expect(dataTransfer.dropEffect).toBe("move");

    fireDragLeave(pane, document.body); // genuinely outside the pane
    expect(pane).not.toHaveClass("pane--drop-target");
  });

  it("ignores dragLeave while crossing its own descendants", () => {
    const { container } = renderPane();
    const pane = container.querySelector(".pane") as HTMLElement;
    const body = container.querySelector(".pane__body") as HTMLElement;

    fireEvent.dragOver(pane, {
      dataTransfer: makeDataTransfer({ [TAB_DND_MIME]: "t1" }),
    });
    // Dragging over a child fires dragleave on the pane; the highlight must
    // survive, or it would flicker across every inner element.
    fireDragLeave(pane, body);

    expect(pane).toHaveClass("pane--drop-target");
  });

  it("ignores drags that are not one of our tabs", () => {
    const { container } = renderPane();
    const pane = container.querySelector(".pane") as HTMLElement;

    // e.g. a file dragged in from Finder.
    fireEvent.dragOver(pane, {
      dataTransfer: makeDataTransfer({ "text/plain": "hello" }),
    });
    expect(pane).not.toHaveClass("pane--drop-target");

    fireEvent.drop(pane, {
      dataTransfer: makeDataTransfer({ "text/uri-list": "file:///tmp/x" }),
    });
    expect(leaf().tabIds).toHaveLength(0);
  });

  it("dropping a tab moves it into this pane", () => {
    const origin = leaf().id;
    const tabId = actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    actions().openTerminalTab({ paneId: origin, cwd: "/w/api" });
    const created = actions().splitPane(origin, "row");

    const { container } = renderPane(created);
    const pane = container.querySelector(".pane") as HTMLElement;
    fireEvent.drop(pane, {
      dataTransfer: makeDataTransfer({ [TAB_DND_MIME]: tabId }),
    });

    expect(leafById(created).tabIds).toEqual([tabId]);
    expect(leafById(origin).tabIds).not.toContain(tabId);
    expect(pane).not.toHaveClass("pane--drop-target");
    // A move is not a close: the PTY must survive.
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("ignores a drop carrying our MIME type but an empty payload", () => {
    const { container } = renderPane();
    const pane = container.querySelector(".pane") as HTMLElement;

    fireEvent.drop(pane, {
      dataTransfer: makeDataTransfer({ [TAB_DND_MIME]: "" }),
    });

    expect(leaf().tabIds).toHaveLength(0);
  });
});

/* ══════════════════════ drag a tab to an edge → split ══════════════════════ */

describe("Pane — drop zones", () => {
  /** A pane holding two tabs; dragging one is the case under test. */
  function twoTabPane() {
    const paneId = leaf().id;
    const stay = actions().openTerminalTab({ paneId, cwd: "/w/gazelle" });
    const drag = actions().openTerminalTab({ paneId, cwd: "/w/api" });
    const view = renderPane(paneId);
    stubBodyRect(view.container);
    const pane = view.container.querySelector(".pane") as HTMLElement;
    const dataTransfer = makeDataTransfer({ [TAB_DND_MIME]: drag });
    return { ...view, paneId, stay, drag, pane, dataTransfer };
  }

  describe("the drop itself", () => {
    it.each([
      ["right", "row", 1],
      ["left", "row", 0],
      ["bottom", "column", 1],
      ["top", "column", 0],
    ] as const)(
      "dropping on the %s edge splits %s and lands the tab at index %i",
      (zone, orientation, index) => {
        const { pane, drag, stay, dataTransfer } = twoTabPane();

        fireDragAt(pane, "drop", AT[zone], dataTransfer);

        const root = store().layout as SplitNode;
        expect(root.type).toBe("split");
        expect(root.orientation).toBe(orientation);
        expect((root.children[index] as LeafNode).tabIds).toEqual([drag]);
        expect((root.children[1 - index] as LeafNode).tabIds).toEqual([stay]);
      },
    );

    it("dropping on center moves the tab in, without splitting", () => {
      const origin = leaf().id;
      const tabId = actions().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
      actions().openTerminalTab({ paneId: origin, cwd: "/w/api" });
      const created = actions().splitPane(origin, "row");

      const { container } = renderPane(created);
      stubBodyRect(container);
      const pane = container.querySelector(".pane") as HTMLElement;

      fireDragAt(pane, "drop", AT.center, makeDataTransfer({ [TAB_DND_MIME]: tabId }));

      expect(leafById(created).tabIds).toEqual([tabId]);
      expect(leavesOf(store().layout)).toHaveLength(2); // no new pane
    });

    it("builds a third pane by dropping onto an edge — the point of the feature", () => {
      const origin = leaf().id;
      const a = actions().openTerminalTab({ paneId: origin });
      const b = actions().openTerminalTab({ paneId: origin });
      const c = actions().openTerminalTab({ paneId: origin });

      // First drop: 1 pane → 2.
      const first = renderPane(origin);
      stubBodyRect(first.container);
      fireDragAt(
        first.container.querySelector(".pane") as HTMLElement,
        "drop",
        AT.right,
        makeDataTransfer({ [TAB_DND_MIME]: b }),
      );
      expect(leavesOf(store().layout)).toHaveLength(2);
      cleanup();

      // Second drop onto the new pane's right edge: 2 panes → 3, still one row.
      const target = leavesOf(store().layout)[1].id;
      const second = renderPane(target);
      stubBodyRect(second.container);
      fireDragAt(
        second.container.querySelector(".pane") as HTMLElement,
        "drop",
        AT.right,
        makeDataTransfer({ [TAB_DND_MIME]: c }),
      );

      const root = store().layout as SplitNode;
      expect(root.children).toHaveLength(3);
      expect(root.orientation).toBe("row");
      expect(leavesOf(store().layout).map((l) => l.tabIds)).toEqual([[a], [b], [c]]);
    });

    it("dragging a pane's only tab onto its own edge does nothing", () => {
      const paneId = leaf().id;
      const tabId = actions().openTerminalTab({ paneId, cwd: "/w/gazelle" });
      const { container } = renderPane(paneId);
      stubBodyRect(container);
      const pane = container.querySelector(".pane") as HTMLElement;
      const settled = store();

      fireDragAt(pane, "drop", AT.right, makeDataTransfer({ [TAB_DND_MIME]: tabId }));

      expect(store()).toBe(settled); // by identity: nothing changed at all
      expect(store().layout.type).toBe("leaf");
    });

    it("never disposes the dragged tab's terminal — scrollback must survive", () => {
      const { pane, drag, dataTransfer } = twoTabPane();
      const ref = store().tabs[drag].ref;
      const terminalId =
        ref.kind === "terminal" || ref.kind === "agent-terminal" ? ref.terminalId : "";

      fireDragAt(pane, "drop", AT.bottom, dataTransfer);

      expect(terminal.dispose).not.toHaveBeenCalled();
      // Same tab record, same PTY — it was re-parented, not recreated.
      const after = store().tabs[drag].ref;
      expect(
        after.kind === "terminal" || after.kind === "agent-terminal" ? after.terminalId : "",
      ).toBe(terminalId);
    });
  });

  /* ── the tab strip wins over the pane's zones ── */

  describe("hit-test priority", () => {
    it("drops its highlight while over the tab strip", () => {
      // The strip sits INSIDE the pane, so its drag events bubble here; the pane must not also
      // claim them (preview: "yields to the tab strip" in PaneTree.test.tsx).
      const { container, pane, dataTransfer } = twoTabPane();
      const strip = container.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;

      // Over the body first: the pane owns this one.
      fireDragAt(pane, "dragOver", AT.right, dataTransfer);
      expect(pane).toHaveClass("pane--drop-target");

      // Now over the strip: the pane must yield, and clear what it had.
      fireDragAt(strip, "dragOver", AT.tabBar, dataTransfer);
      expect(pane).not.toHaveClass("pane--drop-target");
    });

    it("a drop on the strip reorders — it does not also move/split via the pane", () => {
      const { container, stay, drag, dataTransfer } = twoTabPane();
      const strip = container.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;
      stubTabRects(container);

      /** Body rect overlapped onto the strip (top: 0) on purpose: below it, a missing
       * `stopPropagation` reads "center" and no-ops silently; overlapped, it splits LEFT. */
      stubBodyRect(container, { left: 0, top: 0, width: 400, height: 300 });

      // Drop on the far left of the strip → index 0 → reorder to the front.
      fireDragAt(strip, "drop", [5, 10], dataTransfer);

      expect(leaf().tabIds).toEqual([drag, stay]);
      // Crucially: still ONE pane. If the pane's handler had also run, this
      // would be a split.
      expect(leavesOf(store().layout)).toHaveLength(1);
      expect(store().layout.type).toBe("leaf");
    });
  });
});

/* ═══════════════════ reorder tabs by dragging in the strip ═══════════════════ */

describe("TabBar — reorder", () => {
  /** Three tabs in one pane, rects laid out, strip ready to drag over. */
  function threeTabPane() {
    const paneId = leaf().id;
    const a = actions().openTerminalTab({ paneId, cwd: "/w/aaa" });
    const b = actions().openTerminalTab({ paneId, cwd: "/w/bbb" });
    const c = actions().openTerminalTab({ paneId, cwd: "/w/ccc" });
    const view = renderPane(paneId);
    const strip = view.container.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;
    stubTabRects(view.container);
    return { ...view, paneId, a, b, c, strip };
  }

  /** x-coordinates against tab midpoints 50 / 150 / 250. */
  const OVER = { beforeFirst: 5, beforeSecond: 120, beforeThird: 220, past: 400 } as const;

  describe("insertion indicator", () => {
    it("marks the tab it will land before", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });

      fireDragAt(strip, "dragOver", [OVER.beforeFirst, 10], dt);
      const tabs = () => container.querySelectorAll(".pane-tab");
      expect(tabs()[0]).toHaveClass("pane-tab--insert-before");
      expect(tabs()[1]).not.toHaveClass("pane-tab--insert-before");
    });

    it("moves with the cursor across the strip", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });
      const tabs = () => container.querySelectorAll(".pane-tab");

      fireDragAt(strip, "dragOver", [OVER.beforeSecond, 10], dt);
      // Past tab 0's midpoint (50) but before tab 1's (150) → lands before #1.
      expect(tabs()[1]).toHaveClass("pane-tab--insert-before");
      expect(tabs()[0]).not.toHaveClass("pane-tab--insert-before");
    });

    it("marks the LAST tab's trailing edge when appending past the end", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });

      fireDragAt(strip, "dragOver", [OVER.past, 10], dt);

      const tabs = container.querySelectorAll(".pane-tab");
      expect(tabs[2]).toHaveClass("pane-tab--insert-after");
      // Exactly one line, ever — an --insert-after on a non-final tab would
      // paint a second one mid-strip.
      expect(container.querySelectorAll(".pane-tab--insert-after")).toHaveLength(1);
      expect(container.querySelectorAll(".pane-tab--insert-before")).toHaveLength(0);
    });

    it("shows exactly one insertion line at a time", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });

      for (const x of [OVER.beforeFirst, OVER.beforeSecond, OVER.past]) {
        fireDragAt(strip, "dragOver", [x, 10], dt);
        const lines = container.querySelectorAll(
          ".pane-tab--insert-before, .pane-tab--insert-after",
        );
        expect(lines).toHaveLength(1);
      }
    });

    it("clears on leave and on drop", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });
      const lines = () =>
        container.querySelectorAll(
          ".pane-tab--insert-before, .pane-tab--insert-after",
        );

      fireDragAt(strip, "dragOver", [OVER.beforeFirst, 10], dt);
      expect(lines()).toHaveLength(1);
      fireDragLeave(strip, document.body);
      expect(lines()).toHaveLength(0);
    });

    it("stays put while the cursor crosses a tab's own children", () => {
      const { container, strip } = threeTabPane();
      const dt = makeDataTransfer({ [TAB_DND_MIME]: "whatever" });
      fireDragAt(strip, "dragOver", [OVER.beforeFirst, 10], dt);

      // Crossing the tab's label/× fires dragleave on the strip; the line must
      // survive or it would strobe as you move along the tabs.
      fireDragLeave(strip, container.querySelector(".pane-tab__title"));
      expect(container.querySelectorAll(".pane-tab--insert-before")).toHaveLength(1);
    });

    it("shows nothing for a foreign drag", () => {
      const { container, strip } = threeTabPane();
      fireDragAt(
        strip,
        "dragOver",
        [OVER.beforeFirst, 10],
        makeDataTransfer({ "text/uri-list": "file:///tmp/x" }),
      );
      expect(
        container.querySelectorAll(".pane-tab--insert-before, .pane-tab--insert-after"),
      ).toHaveLength(0);
    });
  });

  describe("the drop", () => {
    it("drags a tab to the front", () => {
      const { strip, a, b, c } = threeTabPane();
      fireDragAt(strip, "drop", [OVER.beforeFirst, 10], makeDataTransfer({ [TAB_DND_MIME]: c }));
      expect(leaf().tabIds).toEqual([c, a, b]);
    });

    it("drags a tab to the end", () => {
      const { strip, a, b, c } = threeTabPane();
      fireDragAt(strip, "drop", [OVER.past, 10], makeDataTransfer({ [TAB_DND_MIME]: a }));
      expect(leaf().tabIds).toEqual([b, c, a]);
    });

    it("drags a tab into the middle, honouring the strip the user sees", () => {
      const { strip, a, b, c } = threeTabPane();
      // Drop past b's midpoint → the line reads "before c" → index 2 on the
      // strip as drawn. Lifting `a` out shifts that to 1: [b, a, c]. This is
      // exactly the off-by-one the store's index adjustment exists for.
      fireDragAt(strip, "drop", [OVER.beforeThird, 10], makeDataTransfer({ [TAB_DND_MIME]: a }));
      expect(leaf().tabIds).toEqual([b, a, c]);
    });

    it("dropping just before the NEXT tab is also its own position — no-op", () => {
      // `a` sits at 0, so "before b" is where it already is. The user dragged
      // it a few pixels and let go; nothing should move.
      const { strip, a, b, c } = threeTabPane();
      const settled = store();

      fireDragAt(strip, "drop", [OVER.beforeSecond, 10], makeDataTransfer({ [TAB_DND_MIME]: a }));

      expect(store()).toBe(settled);
      expect(leaf().tabIds).toEqual([a, b, c]);
    });

    it("dropping a tab at its own position changes nothing at all", () => {
      const { strip, a, b, c } = threeTabPane();
      const settled = store();

      fireDragAt(strip, "drop", [OVER.beforeFirst, 10], makeDataTransfer({ [TAB_DND_MIME]: a }));

      expect(store()).toBe(settled); // identity: no re-render storm
      expect(leaf().tabIds).toEqual([a, b, c]);
    });

    it("activates the dragged tab and never disposes its terminal", () => {
      const { strip, c } = threeTabPane();
      fireDragAt(strip, "drop", [OVER.beforeFirst, 10], makeDataTransfer({ [TAB_DND_MIME]: c }));

      expect(leaf().activeTabId).toBe(c);
      expect(terminal.dispose).not.toHaveBeenCalled();
    });

    it("ignores an empty payload", () => {
      const { strip, a, b, c } = threeTabPane();
      fireDragAt(strip, "drop", [OVER.beforeFirst, 10], makeDataTransfer({ [TAB_DND_MIME]: "" }));
      expect(leaf().tabIds).toEqual([a, b, c]);
    });

    it("ignores a drop that is not one of our tabs — e.g. a file from Finder", () => {
      const { strip, a, b, c } = threeTabPane();
      fireDragAt(
        strip,
        "drop",
        [OVER.beforeFirst, 10],
        makeDataTransfer({ "text/uri-list": "file:///tmp/x" }),
      );
      expect(leaf().tabIds).toEqual([a, b, c]);
    });
  });

  describe("across panes", () => {
    it("dropping on another pane's strip inserts at that index, not the end", () => {
      // Pane A has the tab we drag; pane B has two of its own.
      const origin = leaf().id;
      const dragged = actions().openTerminalTab({ paneId: origin, cwd: "/w/dragged" });
      actions().openTerminalTab({ paneId: origin, cwd: "/w/stays" });
      const created = actions().splitPane(origin, "row");
      const x = actions().openTerminalTab({ paneId: created, cwd: "/w/xxx" });
      const y = actions().openTerminalTab({ paneId: created, cwd: "/w/yyy" });

      const { container } = renderPane(created);
      const strip = container.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;
      stubTabRects(container);

      // x=120 → between x and y.
      fireDragAt(strip, "drop", [OVER.beforeSecond, 10], makeDataTransfer({ [TAB_DND_MIME]: dragged }));

      expect(leafById(created).tabIds).toEqual([x, dragged, y]);
      expect(leafById(origin).tabIds).not.toContain(dragged);
      expect(terminal.dispose).not.toHaveBeenCalled();
    });
  });
});
