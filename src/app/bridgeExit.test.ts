/** The bridge un-sticks an agent's terminal when the agent exits. */
import { describe, expect, it, vi } from "vitest";

const reg = vi.hoisted(() => ({ noteAgentExited: vi.fn() }));
vi.mock("../features/terminal/TerminalRegistry", () => reg);

import { onTerminalSideOf } from "./bridge";
import { asAgentId } from "./types";

describe("onTerminalSideOf", () => {
  it("an exited agent resets its terminal (agent id IS the terminal id)", () => {
    onTerminalSideOf({ t: "exited", agentId: asAgentId("a1"), code: 137 });
    expect(reg.noteAgentExited).toHaveBeenCalledWith("a1", 137);
  });

  it("every other event leaves terminals alone", () => {
    reg.noteAgentExited.mockClear();
    onTerminalSideOf({ t: "status", agentId: asAgentId("a1"), status: "running" });
    expect(reg.noteAgentExited).not.toHaveBeenCalled();
  });
});
