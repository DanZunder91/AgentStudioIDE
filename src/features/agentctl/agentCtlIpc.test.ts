import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriEvent = vi.hoisted(() => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

import { AGENT_CTL_EVENT, listenAgentCtl } from "./agentCtlIpc";

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

  it("passes on every event with a kind and a terminal, and drops anything else", async () => {
    const handler = vi.fn();
    await listenAgentCtl(handler);
    const deliver = tauriEvent.listen.mock.calls[0][1] as Delivered;
    const event = { kind: "dbConnection", terminalId: "t1", connectionId: "c9", created: true };
    deliver({ payload: event });
    deliver({ payload: { kind: "anything", terminalId: "t2" } });
    deliver({ payload: { kind: 5, terminalId: "t1" } });
    deliver({ payload: { kind: "x" } });
    deliver({ payload: null });
    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      event,
      { kind: "anything", terminalId: "t2" },
    ]);
  });
});
