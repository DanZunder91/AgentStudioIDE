/**
 * The fleet rail: rows, selection, disclosure — and the re-render budget.
 *
 * The render-count suite at the bottom is the point of this file. cmux shipped a
 * sidebar where every row subscribed to a store and it span a core at 100%
 * (issue #2586); we have the same shape plus live telemetry. Rendering correctly
 * is table stakes — rendering *only what changed* is the requirement, and it is
 * invisible to every other kind of assertion.
 */

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../terminal", () => terminal);

// LeftRail's `+` opens the native folder picker; mock it (default: cancelled).
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
// The launch controls push to the persisted recents; stub the IPC wrapper.
const fleetIpc = vi.hoisted(() => ({ pushRecentProject: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./fleetIpc", () => fleetIpc);
// The rail mounts <UsageLimits/>, which subscribes to its own store and
// starts a 5s poller on mount — a hidden test-mock requirement for EVERY test in
// this file. Unmocked, each render here would fire a real `invoke`
// and leave a live timer behind, so the render-count suite below would be timing
// against a component doing background work. Stubbed to the empty-loading state:
// the panel's own behaviour is `UsageLimits.test.tsx`'s job, not this file's.
const usageStore = vi.hoisted(() => {
  const state = { snapshot: null, error: null, loading: true, refresh: vi.fn() };
  return {
    USAGE_POLL_MS: 5000,
    USAGE_BACKOFF_MS: [5000, 15_000, 30_000, 60_000] as readonly number[],
    useUsageStore: <T,>(selector: (s: typeof state) => T): T => selector(state),
    startUsagePolling: vi.fn(() => vi.fn()),
  };
});
vi.mock("../usage/usageStore", () => usageStore);

import { useAppStore } from "../../app/store";
import type { AgentEvent, AgentId } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { LeftRail } from "./LeftRail";

const state = () => useAppStore.getState();
const fleet = () => useAppStore.getState().agentActions;
const id = (s: string) => s as AgentId;

const started = (agentId: string, title = agentId): AgentEvent => ({
  t: "agent_started",
  agentId: id(agentId),
  parentId: null,
  title,
  cwd: "/w/gazelle",
  branch: "trunk",
  runtime: "claude-code",
});

const spawn = (parent: string, child: string): AgentEvent => ({
  t: "subagent_spawned",
  parentId: id(parent),
  childAgentId: id(child),
  title: child,
  cwd: "/w/gazelle",
  branch: "trunk",
  runtime: "claude-code",
});

/** Agent rows only — folder-group headers are also treeitems. */
const rows = () => screen.queryAllByRole("treeitem").filter((el) => el.classList.contains("fleet-row"));

/** Open every agent — the tree defaults COLLAPSED, so tests about nested rows
 *  expand first. Run after building the forest, before render. */
const expandAll = () =>
  act(() => {
    useAppStore.setState((s) => {
      for (const a of Object.values(s.agents)) a.expanded = true;
    });
  });

/**
 * The row whose TITLE is exactly `title`.
 *
 * Deliberately not `getByRole("treeitem", { name: /…/ })`: a row's accessible
 * name concatenates title + status + "branch • cwd", so a title that appears
 * anywhere in another row's status or path matches both. Anchoring on the title
 * element makes the lookup exact.
 */
const rowFor = (title: string) =>
  screen
    .getByText(title, { selector: ".fleet-row__title" })
    .closest(".fleet-row") as HTMLElement;

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  dialog.open.mockReset();
  fleetIpc.pushRecentProject.mockClear();
  // Reset (not just clear): the polling test reads `mock.results[0]`, so a
  // carried-over result from a previous render would let it assert the wrong stop.
  usageStore.startUsagePolling.mockReset();
  usageStore.startUsagePolling.mockImplementation(() => vi.fn());
});

describe("LeftRail — rendering", () => {
  it("names the quick-launch TARGET FOLDER, since the titlebar no longer does", async () => {
    // The titlebar used to show one project name even when two projects were
    // open. It was `basename(workspaceRoot)` — a single value in a
    // deliberately multi-root app, so it named one project arbitrarily and scoped
    // nothing. It was removed; the one useful thing it hinted at (where a NEW agent
    // starts) moved onto the control that decides it. These assertions are what stop
    // that information from being lost again.
    const user = userEvent.setup();

    // Falls back to workspaceRoot when there are no recents…
    act(() => {
      useAppStore.setState((s) => {
        s.workspaceRoot = "/Users/me/projects/data-warehouse";
        s.recentProjects = [];
      });
    });
    render(<LeftRail />);
    expect(
      screen.getByRole("button", { name: "Quick-launch an agent in data-warehouse" }),
    ).toBeInTheDocument();
    cleanup();

    // …and prefers the most-recent project when there is one, because that is what
    // `quickLaunch` actually passes to `launchAgent`.
    act(() => {
      useAppStore.setState((s) => {
        s.recentProjects = ["/Users/me/projects/orders-api"];
      });
    });
    render(<LeftRail />);
    const btn = screen.getByRole("button", {
      name: "Quick-launch an agent in orders-api",
    });
    await user.click(btn);
    // The tooltip is not decoration: it must name the folder we really launch in.
    expect(terminal.configureTerminal).toHaveBeenCalled();
    expect(state().recentProjects[0]).toBe("/Users/me/projects/orders-api");
  });

  it("survives a launch target that is only separators (the basename fallback)", () => {
    // Covers `basename`'s `|| path` branch, which once shipped uncovered —
    // caught by a coverage measurement, not by review. A path of only
    // separators strips to "", whose basename is "" (falsy), so the helper falls back
    // to the path itself rather than rendering "Quick-launch an agent in ".
    // Reachable in practice: a persisted recents entry of "/" from an older build.
    act(() => {
      useAppStore.setState((s) => {
        s.recentProjects = ["///"];
        s.workspaceRoot = null;
      });
    });
    render(<LeftRail />);
    expect(
      screen.getByRole("button", { name: "Quick-launch an agent in ///" }),
    ).toBeInTheDocument();
  });

  it("the titlebar carries no project label any more", () => {
    // Asserted from the rail's side by absence of the old contract: nothing in the
    // rail should reintroduce a single "current project" caption. The titlebar itself
    // is covered in App.test.tsx.
    act(() => {
      useAppStore.setState((s) => {
        s.workspaceRoot = "/Users/me/projects/data-warehouse";
      });
    });
    render(<LeftRail />);
    // The folder name appears as a GROUP header only when an agent lives there —
    // never as a standalone caption. With no agents, it must not appear at all.
    expect(screen.queryByText("data-warehouse")).not.toBeInTheDocument();
  });

  it("mounts the usage panel as the rail's FOOTER, after the agents list", () => {
    // The usage strip is the rail's footer, NOT a header. Asserted by DOCUMENT
    // ORDER (and that it is the rail's last element child) rather than by a class
    // name, so a future restyle cannot quietly move it back to the top and stay
    // green. The bottom PINNING itself is `margin-top:auto` in fleet.css — jsdom
    // has no layout engine, so order is the honest thing to assert here; the
    // visual pin is verified in the real app (DoD rule 3).
    act(() => {
      fleet().applyAgentEvent(started("a1"));
    });
    const view = render(<LeftRail />);

    const panel = screen.getByTestId("usage-panel");
    const header = screen.getByText("Agents");
    const tree = screen.getByRole("tree");
    expect(panel).toBeInTheDocument();
    // Node.DOCUMENT_POSITION_PRECEDING (2) — both the header and the agents tree
    // come BEFORE the panel.
    expect(panel.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(panel.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByTestId("left-rail").lastElementChild).toBe(panel);

    // Mounting the rail is the whole integration: the panel owns its cadence, so
    // the rail must neither start a second poller nor leak this one on unmount.
    const stop = usageStore.startUsagePolling.mock.results[0]?.value as () => void;
    expect(usageStore.startUsagePolling).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state before any agent exists", () => {
    render(<LeftRail />);
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it("renders a row per agent with title, status and branch • cwd", () => {
    // The three things every agent row shows.
    act(() => {
      fleet().applyAgentEvent(started("a1", "Pull latest changes")); // born idle…
      fleet().applyAgentEvent({ t: "status", agentId: id("a1"), status: "running" }); // …turn starts
    });
    render(<LeftRail />);

    const row = rowFor("Pull latest changes");
    expect(within(row).getByText("Pull latest changes")).toBeInTheDocument();
    expect(within(row).getByText("Running")).toBeInTheDocument();
    expect(row.querySelector(".fleet-row__meta")).toHaveTextContent(/^trunk • \/w\/gazelle$/);
  });

  it("reflects each status in its pill", () => {
    act(() => {
      fleet().applyAgentEvent(started("run"));
      fleet().applyAgentEvent(started("wait"));
      fleet().applyAgentEvent(started("ok"));
      fleet().applyAgentEvent(started("bad"));
      // Roots are born idle; a submitted turn makes "run" running (what its pill shows).
      fleet().applyAgentEvent({ t: "status", agentId: id("run"), status: "running" });
      fleet().applyAgentEvent({ t: "status", agentId: id("wait"), status: "waiting_input" });
      fleet().applyAgentEvent({ t: "exited", agentId: id("ok"), code: 0 });
      fleet().applyAgentEvent({ t: "exited", agentId: id("bad"), code: 143 });
    });
    render(<LeftRail />);

    expect(within(rowFor("run")).getByText("Running")).toBeInTheDocument();
    expect(within(rowFor("wait")).getByText("Waiting")).toBeInTheDocument();
    expect(within(rowFor("ok")).getByText("Done")).toBeInTheDocument();
    expect(within(rowFor("bad")).getByText("Error")).toBeInTheDocument();
  });

  it("appears live when telemetry says so — no refetch, no remount", () => {
    render(<LeftRail />);
    expect(rows()).toHaveLength(0);

    act(() => fleet().applyAgentEvent(started("a1", "Refactor API layer")));

    expect(rows()).toHaveLength(1);
    expect(screen.getByText("Refactor API layer")).toBeInTheDocument();
  });

  it("renders a title change in place", () => {
    act(() => fleet().applyAgentEvent(started("a1", "before")));
    render(<LeftRail />);
    act(() => fleet().applyAgentEvent({ t: "title", agentId: id("a1"), title: "after" }));
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.queryByText("before")).not.toBeInTheDocument();
  });
});

describe("LeftRail — the recursive tree (M3's shape, rendered flat)", () => {
  it("nests a sub-agent under its parent with aria depth", () => {
    // M2 only produces roots; this is the shape M3 turns on. Assert it now, or
    // discover it the day the headline feature ships.
    act(() => {
      fleet().applyAgentEvent(started("root", "Pull latest changes"));
      fleet().applyAgentEvent(spawn("root", "explore-codebase"));
    });
    expandAll();
    render(<LeftRail />);

    expect(rows()).toHaveLength(2);
    expect(rowFor("Pull latest changes")).toHaveAttribute("aria-level", "1");
    expect(rowFor("explore-codebase")).toHaveAttribute("aria-level", "2");
  });

  it("indents by depth, to arbitrary depth", () => {
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "mid"));
      fleet().applyAgentEvent(spawn("mid", "deep"));
    });
    expandAll();
    render(<LeftRail />);

    // Depth drives padding — the flat model's substitute for DOM nesting.
    const pad = (title: string) =>
      parseInt((rowFor(title) as HTMLElement).style.paddingLeft, 10);
    expect(pad("mid")).toBeGreaterThan(pad("root"));
    expect(pad("deep")).toBeGreaterThan(pad("mid"));
    expect(rowFor("deep")).toHaveAttribute("aria-level", "3");
  });

  it("collapses a subtree out of the list entirely", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "kid"));
    });
    expandAll();
    render(<LeftRail />);
    expect(rows()).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Collapse root" }));

    // Not hidden — gone. The row count IS what a virtualizer will window over.
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText("kid")).not.toBeInTheDocument();
    expect(rowFor("root")).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Expand root" }));
    expect(rows()).toHaveLength(2);
  });

  it("shows a caret only where there is something to disclose", () => {
    act(() => {
      fleet().applyAgentEvent(started("parent"));
      fleet().applyAgentEvent(spawn("parent", "kid"));
      fleet().applyAgentEvent(started("lonely"));
    });
    expandAll();
    render(<LeftRail />);

    expect(within(rowFor("parent")).getByRole("button", { name: /Collapse/ })).toBeInTheDocument();
    // No caret on a childless row — but every row carries a dismiss ✕, so scope
    // the negative to the disclosure control.
    expect(
      within(rowFor("lonely")).queryByRole("button", { name: /Collapse|Expand/ }),
    ).not.toBeInTheDocument();
    expect(rowFor("lonely")).not.toHaveAttribute("aria-expanded");
  });

  it("disclosure is not selection", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "kid"));
      fleet().applyAgentEvent(started("other"));
    });
    act(() => fleet().selectAgent(id("other")));
    expandAll();
    render(<LeftRail />);

    await user.click(screen.getByRole("button", { name: "Collapse root" }));

    // Clicking the caret must not steal the selection out from under you.
    expect(state().selection.selectedAgentId).toBe(id("other"));
  });

  it("draws the fan-out connector on sub-agents, not roots", () => {
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "kid"));
    });
    expandAll();
    render(<LeftRail />);

    expect(within(rowFor("root")).queryByText("↳")).not.toBeInTheDocument();
    expect(within(rowFor("kid")).getByText("↳")).toBeInTheDocument();
  });
});

describe("LeftRail — roll-up + attention (the collapsed-subtree payoff)", () => {
  /** root with children of mixed status; return a handle to collapse it. */
  function mixedSubtree() {
    act(() => {
      fleet().applyAgentEvent(started("root", "Pull latest changes"));
      fleet().applyAgentEvent(spawn("root", "a"));
      fleet().applyAgentEvent(spawn("root", "b"));
      fleet().applyAgentEvent(spawn("root", "c"));
      fleet().applyAgentEvent({ t: "exited", agentId: id("b"), code: 0 }); // done
      fleet().applyAgentEvent({ t: "exited", agentId: id("c"), code: 1 }); // error
    });
  }

  it("shows the roll-up summary and an attention dot when collapsed", async () => {
    const user = userEvent.setup();
    mixedSubtree();
    expandAll();
    render(<LeftRail />);

    // Expanded: no summary (the children are right there with their own pills).
    expect(within(rowFor("Pull latest changes")).queryByText(/running · /)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse Pull latest changes" }));

    // Collapsed: the subtree health is summarized on the root.
    const root = rowFor("Pull latest changes");
    expect(within(root).getByText("1 running · 1 done · 1 error")).toBeInTheDocument();
    // And the error surfaces as an attention dot.
    expect(within(root).getByLabelText("Attention needed below")).toBeInTheDocument();
    expect(root).toHaveClass("fleet-row--attention");
  });

  it("no attention dot when the collapsed subtree is healthy", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "a"));
      fleet().applyAgentEvent({ t: "exited", agentId: id("a"), code: 0 }); // done, no error
    });
    expandAll();
    render(<LeftRail />);

    await user.click(screen.getByRole("button", { name: "Collapse root" }));

    const root = rowFor("root");
    expect(within(root).getByText("1 done")).toBeInTheDocument();
    expect(within(root).queryByLabelText("Attention needed below")).not.toBeInTheDocument();
    expect(root).not.toHaveClass("fleet-row--attention");
  });

  it("surfaces a DEEP error on the collapsed root — bubbles from depth 2", () => {
    // The headline: a blocked/errored grandchild is visible from the collapsed
    // root, without expanding a thing. The tree defaults collapsed, so this is
    // the state on first paint — no toggle needed.
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "mid"));
      fleet().applyAgentEvent(spawn("mid", "deep"));
      fleet().applyAgentEvent({ t: "exited", agentId: id("deep"), code: 1 }); // deep error
    });
    render(<LeftRail />);

    // Only the root is visible, and it is already flagging the deep error.
    expect(rows()).toHaveLength(1);
    expect(within(rowFor("root")).getByLabelText("Attention needed below")).toBeInTheDocument();
  });
});

describe("LeftRail — selection (the pivot)", () => {
  it("clicking a row selects it, and only it", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("a1"));
      fleet().applyAgentEvent(started("a2"));
    });
    render(<LeftRail />);

    await user.click(rowFor("a2"));

    expect(state().selection.selectedAgentId).toBe(id("a2"));
    expect(rowFor("a2")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("a1")).toHaveAttribute("aria-selected", "false");
    expect(rowFor("a2")).toHaveClass("fleet-row--selected");
  });

  it("is keyboard reachable", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("a1"));
      fleet().applyAgentEvent(started("a2"));
    });
    act(() => fleet().selectAgent(id("a1")));
    render(<LeftRail />);

    rowFor("a2").focus();
    await user.keyboard("{Enter}");

    expect(state().selection.selectedAgentId).toBe(id("a2"));
  });

  it("shows the bubbled unread badge, and clears it on open", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "kid"));
      fleet().applyAgentEvent({ t: "status", agentId: id("kid"), status: "waiting_input" });
    });
    expandAll(); // so `kid` is a visible row to click below
    render(<LeftRail />);

    // Visible from the trunk — the whole point of bubbling.
    expect(within(rowFor("root")).getByLabelText("1 unread")).toBeInTheDocument();

    await user.click(rowFor("kid"));

    expect(within(rowFor("root")).queryByLabelText(/unread/)).not.toBeInTheDocument();
  });
});

describe("LeftRail — launch controls", () => {
  // The accessible name now NAMES the target folder: the titlebar's
  // project label was removed for being arbitrary in a multi-root app, and this
  // button is where "where will a new agent start" actually belongs. Matched by
  // prefix so the folder-specific assertions below stay the ones that pin the name.
  const quickLaunch = () =>
    screen.getByRole("button", { name: /^Quick-launch an agent in / });
  const openProject = () => screen.getByRole("button", { name: "Open project folder" });

  it("⚡ quick-launches an agent, opens its tab and selects it", async () => {
    const user = userEvent.setup();
    act(() => state().workspaceActions.setWorkspaceRoot("/w/gazelle"));
    render(<LeftRail />);

    await user.click(quickLaunch());

    expect(rows()).toHaveLength(1);
    const agentId = state().rootAgentIds[0];
    expect(state().selection.selectedAgentId).toBe(agentId);
    const tabs = Object.values(state().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("agent-terminal");
    expect(tabs[0].ref).toMatchObject({ agentId });
  });

  it("⚡ spawns in the most-recent project (recentProjects[0])", async () => {
    const user = userEvent.setup();
    act(() => {
      state().workspaceActions.setRecentProjects(["/w/api", "/w/gazelle"]);
    });
    render(<LeftRail />);

    await user.click(quickLaunch());

    expect(state().agents[state().rootAgentIds[0]].cwd).toBe("/w/api");
  });

  it("⚡ falls back to the workspace root when there are no recents", async () => {
    const user = userEvent.setup();
    act(() => state().workspaceActions.setWorkspaceRoot("/w/gazelle"));
    render(<LeftRail />);
    await user.click(quickLaunch());
    expect(state().agents[state().rootAgentIds[0]].cwd).toBe("/w/gazelle");
  });

  it("⚡ falls back to '.' with neither recents nor workspace root", async () => {
    const user = userEvent.setup();
    render(<LeftRail />);
    await user.click(quickLaunch());
    expect(state().agents[state().rootAgentIds[0]].cwd).toBe(".");
  });

  it("any launch records the folder as recent (store + Rust)", async () => {
    const user = userEvent.setup();
    act(() => state().workspaceActions.setWorkspaceRoot("/w/gazelle"));
    render(<LeftRail />);

    await user.click(quickLaunch());

    expect(state().recentProjects[0]).toBe("/w/gazelle");
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/w/gazelle");
  });

  it("+ opens the folder picker → opens that folder as a project with an agent", async () => {
    const user = userEvent.setup();
    dialog.open.mockResolvedValue("/w/chosen");
    render(<LeftRail />);

    await user.click(openProject());

    expect(dialog.open).toHaveBeenCalledWith({ directory: true, multiple: false });
    // The chosen folder becomes the workspace root AND gets a first agent.
    expect(state().workspaceRoot).toBe("/w/chosen");
    const agentId = state().rootAgentIds[0];
    expect(agentId).toBeDefined();
    expect(state().agents[agentId].cwd).toBe("/w/chosen");
    expect(state().recentProjects[0]).toBe("/w/chosen");
  });

  it("+ cancelled (null) launches nothing", async () => {
    const user = userEvent.setup();
    dialog.open.mockResolvedValue(null);
    render(<LeftRail />);

    await user.click(openProject());

    expect(state().rootAgentIds).toHaveLength(0);
    expect(state().workspaceRoot).toBeNull();
  });
});

describe("LeftRail — hostile telemetry", () => {
  it("renders a cyclic forest instead of hanging", () => {
    // `flattenFleet`'s seen-set is what stands between malformed telemetry and
    // a frozen window. If this test hangs, it has failed.
    act(() => {
      fleet().applyAgentEvent(started("a"));
      fleet().applyAgentEvent(started("b"));
    });
    act(() => {
      useAppStore.setState((s) => {
        s.agents[id("a")].childIds = [id("b")];
        s.agents[id("b")].childIds = [id("a")];
        s.agents[id("b")].parentId = id("a");
        s.rootAgentIds = [id("a")];
      });
    });
    expandAll(); // walk into the cycle so the seen-set guard is exercised

    render(<LeftRail />);

    expect(rows()).toHaveLength(2);
    cleanup();
  });

  it("skips an agent whose record vanishes under it", () => {
    act(() => {
      fleet().applyAgentEvent(started("a1"));
      fleet().applyFleetSnapshot([wireAgent({ id: id("a2") })]);
    });
    render(<LeftRail />);
    expect(rows()).toHaveLength(2);

    act(() => fleet().removeAgent(id("a1")));

    expect(rows()).toHaveLength(1);
  });
});

describe("LeftRail — project style (Settings → Interface)", () => {
  const tree = () => screen.getByRole("tree", { name: "Agents" });

  beforeEach(() => {
    useAppStore.setState((s) => {
      s.railGroupStyle = "card";
    });
  });

  it("draws projects as framed cards by default", () => {
    act(() => fleet().applyAgentEvent(started("a")));
    render(<LeftRail />);
    expect(tree()).toHaveClass("fleet-tree", "fleet-tree--groups-card");
  });

  it("switches the whole rail's style with the setting, one class on the tree", () => {
    act(() => fleet().applyAgentEvent(started("a")));
    render(<LeftRail />);

    for (const style of ["well", "divider", "pinned", "card"] as const) {
      act(() => state().workspaceActions.setRailGroupStyle(style));
      const classes = [...tree().classList].filter((c) => c.startsWith("fleet-tree--groups-"));
      expect(classes).toEqual([`fleet-tree--groups-${style}`]);
    }
  });
});
