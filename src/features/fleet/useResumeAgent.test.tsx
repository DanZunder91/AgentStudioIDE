/**
 * "↻ Resume": a finished root continues its saved
 * conversation through the existing `resumeSessionId` launch path; a refusal is
 * written into the ended agent's own terminal, in plain words.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ agentResumeSession: vi.fn() }));
vi.mock("./fleetIpc", () => ipc);
const launch = vi.hoisted(() => vi.fn(() => "new-agent"));
vi.mock("./useLaunchAgent", () => ({ useLaunchAgent: () => launch }));
const reg = vi.hoisted(() => ({ writeTerminalNotice: vi.fn() }));
vi.mock("../terminal/TerminalRegistry", () => reg);

import { asAgentId } from "../../app/types";
import { resumeRefusal, useResumeAgent } from "./useResumeAgent";

describe("useResumeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the agent's own saved session in the same folder", async () => {
    ipc.agentResumeSession.mockResolvedValue("sess-123");
    const { result } = renderHook(() => useResumeAgent());
    const id = await result.current(asAgentId("old"), "/projects/gazelle");
    expect(ipc.agentResumeSession).toHaveBeenCalledWith("old");
    expect(launch).toHaveBeenCalledWith("/projects/gazelle", { resumeSessionId: "sess-123" });
    expect(id).toBe("new-agent");
  });

  it("a refusal is shown in the ended agent's terminal and nothing launches", async () => {
    ipc.agentResumeSession.mockRejectedValue("no-session");
    const { result } = renderHook(() => useResumeAgent());
    expect(await result.current(asAgentId("old"), "/projects")).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(reg.writeTerminalNotice).toHaveBeenCalledWith(
      "old",
      "Can't resume: this agent has no saved conversation yet.",
    );
  });
});

describe("resumeRefusal", () => {
  it("maps every Rust code, and falls back to the raw text", () => {
    expect(resumeRefusal("not-finished")).toMatch(/still running/);
    expect(resumeRefusal(new Error("not-a-root"))).toMatch(/Only a root agent/);
    expect(resumeRefusal("supervisor dropped the reply")).toBe(
      "Can't resume: supervisor dropped the reply",
    );
  });
});
