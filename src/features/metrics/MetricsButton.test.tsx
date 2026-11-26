/** The button is the only UI route to the tab, so a mount that does nothing must fail here. */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../terminal", () => terminal);

import { useAppStore } from "../../app/store";
import { asAgentId, type AgentId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { MetricsButton } from "./MetricsButton";

const state = () => useAppStore.getState();
const aid = (s: string): AgentId => asAgentId(s);

const startRoot = (id: string, cwd: string): void =>
  state().agentActions.applyAgentEvent({
    t: "agent_started",
    agentId: aid(id),
    parentId: null,
    title: id,
    cwd,
    branch: "trunk",
    runtime: "claude-code",
  });

beforeEach(() => {
  resetStore();
  cleanup();
});

describe("MetricsButton", () => {
  it("opens exactly one metrics tab, and re-opening re-focuses rather than duplicating", async () => {
    const user = userEvent.setup();
    render(<MetricsButton />);

    await user.click(screen.getByTestId("titlebar-metrics"));
    const tabs = Object.values(state().tabs).filter((t) => t.kind === "metrics");
    expect(tabs).toHaveLength(1);

    // Clicking again must not open a second dashboard — the action is a singleton, and
    // two dashboards showing the same numbers is the kind of thing nobody notices in a
    // unit test but everybody notices in the app.
    await user.click(screen.getByTestId("titlebar-metrics"));
    expect(Object.values(state().tabs).filter((t) => t.kind === "metrics")).toHaveLength(1);
  });

  it("scopes the dashboard to the SELECTED agent's project", async () => {
    const user = userEvent.setup();
    startRoot("a", "/w/data-warehouse");
    startRoot("b", "/w/orders-api");
    state().agentActions.selectAgent(aid("b"));

    render(<MetricsButton />);
    await user.click(screen.getByTestId("titlebar-metrics"));

    const tab = Object.values(state().tabs).find((t) => t.kind === "metrics");
    expect(tab?.ref).toEqual({ kind: "metrics", cwd: "/w/orders-api" });
  });

  it("resolves a SUB-agent to its root's cwd, since a sub-agent has none of its own", async () => {
    const user = userEvent.setup();
    startRoot("boss", "/w/data-warehouse");
    state().agentActions.applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid("boss"),
      childAgentId: aid("kid"),
      title: "kid",
      cwd: "/ignored-by-design",
      branch: "trunk",
      runtime: "claude-code",
    });
    state().agentActions.selectAgent(aid("kid"));

    render(<MetricsButton />);
    await user.click(screen.getByTestId("titlebar-metrics"));

    const tab = Object.values(state().tabs).find((t) => t.kind === "metrics");
    // The child's own `cwd` field is meaningless (the fan-out wire carries a placeholder);
    // the root's is the project. Same resolution the focus-follows-agent collapse uses.
    expect(tab?.ref).toEqual({ kind: "metrics", cwd: "/w/data-warehouse" });
  });

  it("passes null when nothing is selected, rather than inventing a project", async () => {
    const user = userEvent.setup();
    startRoot("a", "/w/data-warehouse");
    // Starting a root AUTO-SELECTS it (the rail pivots to a newly spawned agent), so
    // "nothing selected" has to be made explicitly — asserting null against an
    // auto-selected agent would fail on the store's behaviour, not on a bug in the button.
    useAppStore.setState((st) => {
      st.selection.selectedAgentId = null;
    });
    // The honest answer with no selection is "no project scope", which the panel labels.
    // Defaulting to *some* project would silently show one project's numbers under
    // another's name — the same class of bug as a titlebar label naming the wrong project.
    render(<MetricsButton />);
    await user.click(screen.getByTestId("titlebar-metrics"));

    const tab = Object.values(state().tabs).find((t) => t.kind === "metrics");
    expect(tab?.ref).toEqual({ kind: "metrics", cwd: null });
  });

  it("passes null for a selected id with no agent record (a phantom selection)", async () => {
    const user = userEvent.setup();
    // The selected agent's record can be gone or not yet arrived: `rootOf` is then null, and the
    // button must fall back to no scope rather than throw.
    useAppStore.setState((st) => {
      st.selection.selectedAgentId = aid("ghost");
    });

    render(<MetricsButton />);
    await user.click(screen.getByTestId("titlebar-metrics"));

    const tab = Object.values(state().tabs).find((t) => t.kind === "metrics");
    expect(tab?.ref).toEqual({ kind: "metrics", cwd: null });
  });

  it("has an accessible name that says what it opens", () => {
    render(<MetricsButton />);
    expect(
      screen.getByRole("button", { name: "Claude usage metrics" }),
    ).toBeInTheDocument();
  });
});
