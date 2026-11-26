/** A wasteful rail and a frugal one produce identical DOM, so count renders: the mocked,
 * un-memoized `<AgentStatusPill>` is created only when `AgentRowImpl`'s body runs, so one spy
 * call = one row render. Everything else is real. */

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../terminal", () => terminal);

/** Fires once per <AgentRow> body execution. See the header. */
const pill = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock("./AgentStatusPill", () => ({
  AgentStatusPill: ({ status }: { status: string }) => {
    pill.rendered(status);
    return <span data-testid="pill">{status}</span>;
  },
}));

import { useAppStore } from "../../app/store";
import type { AgentEvent, AgentId } from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { LeftRail } from "./LeftRail";

const fleet = () => useAppStore.getState().agentActions;
const id = (s: string) => s as AgentId;

const started = (agentId: string): AgentEvent => ({
  t: "agent_started",
  agentId: id(agentId),
  parentId: null,
  title: agentId,
  cwd: "/w/gazelle",
  branch: "trunk",
  runtime: "claude-code",
});

/** How many rows rendered since the last reset. */
const rowRenders = () => pill.rendered.mock.calls.length;

function seedFleet(n: number) {
  act(() => {
    for (let i = 0; i < n; i++) fleet().applyAgentEvent(started(`a${i}`));
  });
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  pill.rendered.mockClear();
});

describe("render budget — the measurement itself", () => {
  it("counts one row render per agent on first paint", () => {
    // Guards the instrument: if this ever reads 0, every assertion below would
    // pass vacuously.
    seedFleet(3);
    render(<LeftRail />);
    expect(rowRenders()).toBe(3);
  });

  it("re-renders a row when its own status changes", () => {
    // The other half of the instrument: it must be capable of counting a render.
    seedFleet(3);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "status", agentId: id("a1"), status: "waiting_input" }));

    expect(rowRenders()).toBe(1);
    expect(pill.rendered).toHaveBeenCalledWith("waiting_input");
  });
});

describe("render budget — one event, one row", () => {
  it("one agent's status change re-renders exactly ONE row out of 20", () => {
    // THE requirement. With a per-row store subscription and no memo, this is
    // 20 — and at M3 it is 20 per agent per tick, which is the spin loop.
    seedFleet(20);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "status", agentId: id("a7"), status: "done" }));

    expect(rowRenders()).toBe(1);
  });

  it("a title change re-renders exactly one row", () => {
    seedFleet(20);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "title", agentId: id("a3"), title: "renamed" }));

    expect(rowRenders()).toBe(1);
  });

  it("selection re-renders only the two rows whose selected-ness changed", () => {
    seedFleet(20);
    act(() => fleet().selectAgent(id("a1")));
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().selectAgent(id("a2")));

    // a1 deselects, a2 selects. The other 18 are unaffected.
    expect(rowRenders()).toBe(2);
  });
});

describe("render budget — the activity firehose", () => {
  it("an activity tick re-renders NOTHING", () => {
    // `activity` only moves `lastActivityAt`, shown by no row: scalar selects mean zero renders.
    seedFleet(20);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "activity", agentId: id("a5"), at: 999 }));

    expect(rowRenders()).toBe(0);
  });

  it("600 activity ticks across a 30-agent fleet re-render NOTHING", () => {
    // The M3 steady state. This is the exact shape of cmux's 100%-CPU sidebar:
    // if the budget is per-tick-per-row, this is 18,000 renders. It must be 0.
    seedFleet(30);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => {
      for (let tick = 0; tick < 20; tick++) {
        for (let i = 0; i < 30; i++) {
          fleet().applyAgentEvent({ t: "activity", agentId: id(`a${i}`), at: tick });
        }
      }
    });

    expect(rowRenders()).toBe(0);
  });

  it("a status change still lands amid the firehose", () => {
    // The frugal path must not be a dead path: prove the budget is 0 because
    // nothing visible changed, not because the rail stopped listening.
    seedFleet(30);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => {
      for (let i = 0; i < 30; i++) {
        fleet().applyAgentEvent({ t: "activity", agentId: id(`a${i}`), at: 1 });
      }
      fleet().applyAgentEvent({ t: "status", agentId: id("a9"), status: "error" });
      for (let i = 0; i < 30; i++) {
        fleet().applyAgentEvent({ t: "activity", agentId: id(`a${i}`), at: 2 });
      }
    });

    expect(rowRenders()).toBe(1);
    expect(pill.rendered).toHaveBeenCalledWith("error");
  });
});

describe("render budget — a wide + deep fan-out tree", () => {
  const spawn = (parent: string, child: string) =>
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: id(parent),
      childAgentId: id(child),
      title: child,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  /** root → 19 depth-1 children → 5 depth-2 grandchildren (the Rust fixture). */
  function buildTree() {
    act(() => {
      fleet().applyAgentEvent(started("root"));
      for (let i = 0; i < 19; i++) spawn("root", `c${i}`);
      for (let i = 0; i < 5; i++) spawn("c0", `g${i}`);
    });
    // Agents default COLLAPSED; these budget tests measure the fully-open tree
    // (25 mounted rows). Expand before render — the render-count mockClear comes
    // after, so this setup does not skew the measurements.
    act(() => {
      useAppStore.setState((s) => {
        for (const a of Object.values(s.agents)) a.expanded = true;
      });
    });
  }

  it("first paint renders each of the 25 nodes exactly once", () => {
    buildTree();
    render(<LeftRail />);
    expect(rowRenders()).toBe(25);
  });

  it("an activity tick anywhere in the tree re-renders NOTHING", () => {
    // The steady state: sub-agents tick continuously. `activity` moves no field
    // any row displays and no roll-up count, so at depth this must still be 0 —
    // the selector-scoped subscriptions and the memoized rollup props hold.
    buildTree();
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => {
      for (let tick = 0; tick < 20; tick++) {
        for (let i = 0; i < 19; i++) fleet().applyAgentEvent({ t: "activity", agentId: id(`c${i}`), at: tick });
        for (let i = 0; i < 5; i++) fleet().applyAgentEvent({ t: "activity", agentId: id(`g${i}`), at: tick });
      }
    });

    expect(rowRenders()).toBe(0); // 480 ticks across 24 nodes → 0 renders
  });

  it("a deep status change re-renders only the node and its ancestors, not the fleet", () => {
    // A grandchild's status change re-renders its ancestor chain (3 rows): bounded by depth, not N.
    buildTree();
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "exited", agentId: id("g0"), code: 0 }));

    // g0 (status), c0 (rollup), root (rollup) = 3. Never the whole fleet.
    expect(rowRenders()).toBe(3);
  });

  it("a status change on a LEAF sibling touches only itself", () => {
    // c1 has no children and no descendants, so nothing rolls up through it and
    // it has no ancestor but the root... whose rollup DOES change. So c1 + root.
    buildTree();
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent({ t: "exited", agentId: id("c1"), code: 1 }));

    // c1 (its own status) + root (its rollup gained an error). = 2, not 25.
    expect(rowRenders()).toBe(2);
  });
});

describe("render budget — structural changes", () => {
  it("adding an agent re-renders only the new row", () => {
    // The existing rows' props and subscriptions are untouched; only the list
    // grew. Without memo, every row would re-render on every new agent.
    seedFleet(10);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().applyAgentEvent(started("newcomer")));

    expect(rowRenders()).toBe(1);
  });

  it("removing an agent re-renders no surviving row", () => {
    seedFleet(10);
    render(<LeftRail />);
    pill.rendered.mockClear();

    act(() => fleet().removeAgent(id("a4")));

    expect(rowRenders()).toBe(0);
  });
});
