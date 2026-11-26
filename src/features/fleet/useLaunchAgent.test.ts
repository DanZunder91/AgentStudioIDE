/** Real store; `./fleetIpc` and `../terminal` are mocked (the terminal mock also serves the
 * store's own `openTerminalTab`, as in `AgentRow.test.tsx`). */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../terminal", () => terminal);

const fleetIpc = vi.hoisted(() => ({
  pushRecentProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./fleetIpc", () => fleetIpc);

import { useAppStore } from "../../app/store";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { useLaunchAgent } from "./useLaunchAgent";

const state = () => useAppStore.getState();

function launcher() {
  return renderHook(() => useLaunchAgent()).result.current;
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  fleetIpc.pushRecentProject.mockReset();
  fleetIpc.pushRecentProject.mockResolvedValue(undefined);
});

describe("useLaunchAgent — plain launch", () => {
  it("creates an agent in the folder and records it recent, in store AND Rust", () => {
    const launch = launcher();

    const agentId = launch("/w/gazelle");

    const agent = state().agents[agentId];
    expect(agent).toBeDefined();
    expect(agent.cwd).toBe("/w/gazelle");
    expect(agent.kind).toBe("orchestrator");
    expect(state().recentProjects[0]).toBe("/w/gazelle");
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/w/gazelle");
  });

  it("a failed recents persist never blocks the launch (best-effort)", async () => {
    fleetIpc.pushRecentProject.mockRejectedValue(new Error("disk full"));
    const launch = launcher();

    const agentId = launch("/w/gazelle");
    // Flush the rejected push — the catch must swallow it (no unhandled).
    await Promise.resolve();

    expect(state().agents[agentId]).toBeDefined();
  });

  it("does NOT touch the spawn options beyond the store's own pre-registration", () => {
    const launch = launcher();

    const agentId = launch("/w/gazelle");

    // Exactly one configureTerminal call — the store's (cwd/agentId/runtime).
    // No resume patch: a plain launch must start a FRESH session.
    expect(terminal.configureTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.configureTerminal).toHaveBeenCalledWith(agentId, {
      cwd: "/w/gazelle",
      agentId,
      runtime: "claude-code",
    });
  });
});

describe("useLaunchAgent — resume", () => {
  it("merges { resumeSessionId } into the new agent's spawn options", () => {
    const launch = launcher();

    const agentId = launch("/w/gazelle", { resumeSessionId: "sess-42" });

    // Second call, keyed by the SAME id (an agent terminal's TerminalId is its
    // AgentId) so the registry merges it into the store's pre-registration.
    expect(terminal.configureTerminal).toHaveBeenCalledTimes(2);
    expect(terminal.configureTerminal).toHaveBeenLastCalledWith(agentId, {
      resumeSessionId: "sess-42",
    });
    // Still a full launch: agent created, recents recorded.
    expect(state().agents[agentId]?.cwd).toBe("/w/gazelle");
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/w/gazelle");
  });

  it("an empty opts object behaves exactly like a plain launch", () => {
    const launch = launcher();

    launch("/w/gazelle", {});

    expect(terminal.configureTerminal).toHaveBeenCalledTimes(1);
  });
});
