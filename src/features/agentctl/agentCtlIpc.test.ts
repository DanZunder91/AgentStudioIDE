import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriEvent = vi.hoisted(() => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

import { AGENT_CTL_EVENT, listenAgentCtl, type AgentCtlEvent } from "./agentCtlIpc";

type Delivered = (e: { payload: unknown }) => void;

beforeEach(() => {
  tauriEvent.listen.mockReset();
  tauriEvent.listen.mockResolvedValue(() => undefined);
});

describe("listenAgentCtl", () => {
  it("listens on the event Rust emits (agent_ctl::EVENT)", async () => {
    await listenAgentCtl(() => undefined);
    expect(AGENT_CTL_EVENT).toBe("agent-ctl://event");
    expect(tauriEvent.listen).toHaveBeenCalledWith("agent-ctl://event", expect.any(Function));
  });

  it("hands a database-connection event to the handler, and drops kinds it does not know", async () => {
    const handler = vi.fn();
    await listenAgentCtl(handler);
    const deliver = tauriEvent.listen.mock.calls[0][1] as Delivered;
    const event: AgentCtlEvent = {
      kind: "dbConnection",
      connectionId: "c9",
      terminalId: "t1",
      created: true,
    };
    deliver({ payload: event });
    deliver({ payload: { kind: "httpRequest", id: "x" } });
    deliver({ payload: null });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });
});
