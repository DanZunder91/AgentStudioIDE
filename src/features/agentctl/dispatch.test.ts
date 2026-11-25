import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { HANDLERS, dispatchAgentCtl } from "./dispatch";

beforeEach(() => resetStore());

describe("dispatchAgentCtl", () => {
  it("routes a dbConnection event to the DB panel's agent notice", () => {
    const show = vi.fn();
    useAppStore.setState((s) => {
      s.dbActions.showAgentDbConnection = show;
    });
    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t1", connectionId: "c9", created: true });
    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t2", connectionId: 7, created: "yes" });
    expect(show.mock.calls).toEqual([
      [{ connectionId: "c9", terminalId: "t1", created: true }],
      [{ connectionId: "7", terminalId: "t2", created: false }],
    ]);
  });

  it("ignores a kind it has no handler for, including inherited property names", () => {
    expect(() => dispatchAgentCtl({ kind: "fromTheFuture", terminalId: "t1" })).not.toThrow();
    expect(() => dispatchAgentCtl({ kind: "toString", terminalId: "t1" })).not.toThrow();
    expect(Object.keys(HANDLERS)).toContain("dbConnection");
  });
});
