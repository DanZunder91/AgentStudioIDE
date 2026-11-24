/**
 * ActivityView — a sub-agent's read-only transcript in the center (M3).
 *
 * A sub-agent owns no PTY, so selecting one opens this instead of a terminal. It
 * fetches `subagent_activity(agentId)` and polls while mounted, because the agent
 * may still be producing output. The IPC wrapper is mocked at the module
 * boundary: the real one crosses Tauri, which does not belong in a jsdom unit
 * test, and the *cadence* (poll while mounted, stop on unmount) is the behaviour
 * under test here, not the wire.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fleetIpc = vi.hoisted(() => ({ subagentActivity: vi.fn() }));
vi.mock("./fleetIpc", () => fleetIpc);

import { useAppStore } from "../../app/store";
import type { ActivityEntry, AgentEvent, AgentId } from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { ActivityView } from "./ActivityView";

const kid = "kid" as AgentId;
const fleet = () => useAppStore.getState().agentActions;

const started = (agentId: AgentId): AgentEvent => ({
  t: "agent_started",
  agentId,
  parentId: null,
  title: agentId,
  cwd: "/w/gazelle",
  branch: "trunk",
  runtime: "claude-code",
});

/** Flush the pending poll promise (and any timers up to `ms`) inside act(). */
const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const listItems = () => screen.queryAllByRole("listitem");
const statusPill = () => document.querySelector(".activity-view__status");

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.useFakeTimers();
  fleetIpc.subagentActivity.mockReset();
  fleetIpc.subagentActivity.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ActivityView", () => {
  it("shows the calm waiting state — and no status pill — for an empty, unknown agent", async () => {
    render(<ActivityView agentId={"ghost" as AgentId} />);
    await flush();

    expect(screen.getByText("waiting for activity…")).toBeInTheDocument();
    expect(listItems()).toHaveLength(0);
    // No agent record → no status to reflect.
    expect(statusPill()).toBeNull();
    // It asked Rust for THIS agent's transcript.
    expect(fleetIpc.subagentActivity).toHaveBeenCalledWith("ghost");
  });

  it("fetches and renders the transcript chronologically, including a tool row", async () => {
    act(() => {
      fleet().applyAgentEvent(started(kid)); // born idle…
      fleet().applyAgentEvent({ t: "status", agentId: kid, status: "running" }); // …then a turn starts
    });
    const entries: ActivityEntry[] = [
      { role: "user", text: "explore the repo", timestamp: 1 },
      { role: "assistant", text: "reading files", tool: "Read", timestamp: 2 },
    ];
    fleetIpc.subagentActivity.mockResolvedValue(entries);

    render(<ActivityView agentId={kid} />);
    await flush();

    const rows = listItems();
    expect(rows).toHaveLength(2);
    // Chronological order, exactly as Rust sent them.
    expect(rows[0]).toHaveTextContent("user");
    expect(rows[0]).toHaveTextContent("explore the repo");
    // The tool call shows the tool name alongside its brief text.
    expect(rows[1]).toHaveTextContent("assistant");
    expect(rows[1]).toHaveTextContent("Read");
    expect(rows[1]).toHaveTextContent("reading files");
    expect(rows[1].querySelector(".activity-entry__tool")).toHaveTextContent("Read");
    // The header reflects the agent's live status.
    expect(statusPill()).toHaveTextContent("running");
  });

  it("reflects a status change (running → done) in the header", async () => {
    act(() => {
      fleet().applyAgentEvent(started(kid)); // born idle…
      fleet().applyAgentEvent({ t: "status", agentId: kid, status: "running" }); // …turn starts
    });
    render(<ActivityView agentId={kid} />);
    await flush();
    expect(statusPill()).toHaveTextContent("running");

    act(() => fleet().applyAgentEvent({ t: "exited", agentId: kid, code: 0 }));
    expect(statusPill()).toHaveTextContent("done");
  });

  it("polls ~1.5s while mounted, refreshing the transcript — and stops on unmount", async () => {
    fleetIpc.subagentActivity.mockResolvedValueOnce([
      { role: "assistant", text: "first", timestamp: 1 },
    ]);
    const { unmount } = render(<ActivityView agentId={kid} />);
    await flush();
    expect(screen.getByText("first")).toBeInTheDocument();

    // The sub-agent produced more; the next poll picks it up.
    fleetIpc.subagentActivity.mockResolvedValue([
      { role: "assistant", text: "first", timestamp: 1 },
      { role: "assistant", text: "second", timestamp: 2 },
    ]);
    await flush(1500);
    expect(screen.getByText("second")).toBeInTheDocument();

    // Once unmounted the interval is cleared — no further polling.
    const callsBefore = fleetIpc.subagentActivity.mock.calls.length;
    unmount();
    await flush(1500 * 3);
    expect(fleetIpc.subagentActivity.mock.calls.length).toBe(callsBefore);
  });

  it("ignores a poll that resolves after unmount — no state update on a dead view", async () => {
    let resolvePoll!: (v: ActivityEntry[]) => void;
    fleetIpc.subagentActivity.mockReturnValue(
      new Promise<ActivityEntry[]>((r) => {
        resolvePoll = r;
      }),
    );
    const { unmount } = render(<ActivityView agentId={kid} />);
    unmount();

    // The in-flight poll settles only after the view is gone; the `active` guard
    // must swallow it rather than setState on an unmounted component.
    await act(async () => {
      resolvePoll([{ role: "assistant", text: "too late", timestamp: 1 }]);
    });
    expect(screen.queryByText("too late")).toBeNull();
  });

  it("keeps the last-known transcript on screen when a poll fails", async () => {
    fleetIpc.subagentActivity.mockResolvedValueOnce([
      { role: "assistant", text: "survivor", timestamp: 1 },
    ]);
    render(<ActivityView agentId={kid} />);
    await flush();
    expect(screen.getByText("survivor")).toBeInTheDocument();

    // A transient IPC failure must never blank the view or surface an error.
    fleetIpc.subagentActivity.mockRejectedValue(new Error("supervisor blip"));
    await flush(1500);
    expect(screen.getByText("survivor")).toBeInTheDocument();
  });

  it("re-fetches for the new sub-agent when remounted by key (no stale transcript)", async () => {
    // <Pane> keys this view by agentId, so switching sub-agents remounts it.
    fleetIpc.subagentActivity.mockImplementation((agentId: AgentId) =>
      Promise.resolve(
        agentId === kid
          ? [{ role: "assistant", text: "kid work", timestamp: 1 }]
          : [{ role: "assistant", text: "sibling work", timestamp: 1 }],
      ),
    );

    const view = render(<ActivityView key={kid} agentId={kid} />);
    await flush();
    expect(screen.getByText("kid work")).toBeInTheDocument();

    const sibling = "sibling" as AgentId;
    view.rerender(<ActivityView key={sibling} agentId={sibling} />);
    await flush();

    expect(screen.queryByText("kid work")).toBeNull();
    expect(screen.getByText("sibling work")).toBeInTheDocument();
    expect(fleetIpc.subagentActivity).toHaveBeenCalledWith("sibling");
  });
});
