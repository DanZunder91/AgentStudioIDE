/** Tear-off wrappers: names and arg shapes as `tearoff.rs` declares them (Tauri maps camelCase to
 * snake_case), and which of them swallow failure. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import type { TornTab } from "./contract";
import {
  tearoffClaim,
  tearoffClose,
  tearoffHoldings,
  tearoffOpen,
  tearoffReport,
  tearoffSend,
} from "./ipc";

const TERM: TornTab = { kind: "terminal", terminalId: "T1", title: "sh", customTitle: null };

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
});
afterEach(() => ipc.reset());

describe("tear-off IPC", () => {
  it("tearoff_open carries the tabs and the release point, and resolves the new label", async () => {
    ipc.handle("tearoff_open", () => "tearoff-1");
    await expect(tearoffOpen([TERM], { x: 10, y: 20 })).resolves.toBe("tearoff-1");
    expect(ipc.lastCall("tearoff_open")).toEqual({ tabs: [TERM], at: { x: 10, y: 20 } });
    await tearoffOpen([TERM], null);
    expect(ipc.lastCall("tearoff_open")).toEqual({ tabs: [TERM], at: null });
  });

  it("tearoff_open and tearoff_send REJECT — the caller must take the tab back", async () => {
    ipc.handle("tearoff_open", () => {
      throw new Error("no display");
    });
    ipc.handle("tearoff_send", () => {
      throw new Error("no window tearoff-9");
    });
    await expect(tearoffOpen([TERM], null)).rejects.toThrow("no display");
    await expect(tearoffSend("tearoff-9", { t: "focus", key: "terminal:T1" })).rejects.toThrow(
      "tearoff-9",
    );
  });

  it("tearoff_send addresses a window and carries one message", async () => {
    ipc.handle("tearoff_send", () => null);
    await tearoffSend("main", { t: "adopt", tabs: [TERM] });
    expect(ipc.lastCall("tearoff_send")).toEqual({ to: "main", mail: { t: "adopt", tabs: [TERM] } });
  });

  it("tearoff_claim resolves the caller's mail", async () => {
    ipc.handle("tearoff_claim", () => ({ tabs: [], mail: [{ t: "focus", key: "village" }] }));
    await expect(tearoffClaim()).resolves.toEqual({ tabs: [], mail: [{ t: "focus", key: "village" }] });
  });

  it("tearoff_report sends the holdings and swallows a failure", async () => {
    ipc.handle("tearoff_report", () => null);
    await tearoffReport([TERM]);
    expect(ipc.lastCall("tearoff_report")).toEqual({ tabs: [TERM] });
    ipc.handle("tearoff_report", () => {
      throw new Error("gone");
    });
    await expect(tearoffReport([TERM])).resolves.toBeUndefined();
  });

  it("tearoff_holdings resolves the ledger, and [] on failure", async () => {
    const ledger = [{ label: "tearoff-1", keys: ["terminal:T1"] }];
    ipc.handle("tearoff_holdings", () => ledger);
    await expect(tearoffHoldings()).resolves.toEqual(ledger);
    ipc.handle("tearoff_holdings", () => {
      throw new Error("gone");
    });
    await expect(tearoffHoldings()).resolves.toEqual([]);
  });

  it("tearoff_close asks for this window to go", async () => {
    ipc.handle("tearoff_close", () => null);
    await tearoffClose();
    expect(ipc.calls("tearoff_close")).toHaveLength(1);
  });
});
