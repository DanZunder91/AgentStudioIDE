/** The empty short circuit and the rejection arm (→ `[]`) are why the wrapper exists. */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Factory mock: a frozen copy of the module's surface (`invoke` only); grow it if imports grow.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { terminalsBusy } from "./terminalBusyIpc";
import { asTerminalId } from "../../app/types";

const t1 = asTerminalId("term-1");
const t2 = asTerminalId("term-2");

beforeEach(() => {
  invoke.mockReset();
});

describe("terminalsBusy", () => {
  it("short-circuits an empty id list WITHOUT invoking", async () => {
    // Zero terminals: no round trip on the path of a click the user is waiting on.
    await expect(terminalsBusy([])).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the ids through and returns what Rust reports", async () => {
    const busy = [{ id: t2, reason: "agent" as const, label: "Fix the parser" }];
    invoke.mockResolvedValue(busy);

    await expect(terminalsBusy([t1, t2])).resolves.toEqual(busy);
    // The command name and the argument SHAPE are the wire contract with
    // `terminals_busy` in Rust; a rename on either side has to break here.
    expect(invoke).toHaveBeenCalledWith("terminals_busy", { ids: [t1, t2] });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when Rust says nothing is busy", async () => {
    // The ordinary case: the gate reads `[]` as "close it", so this arm is what
    // makes an idle terminal close on the first click.
    invoke.mockResolvedValue([]);
    await expect(terminalsBusy([t1])).resolves.toEqual([]);
  });

  it("🔴 resolves to [] when the invoke REJECTS — never rethrows", async () => {
    // Load-bearing, per the module header. If this rethrew, the rejection would
    // escape `gateTerminalClose`'s `await` as an unhandled rejection and the
    // close would neither happen nor prompt: a ✕ that does nothing at all.
    invoke.mockRejectedValue(new Error("terminals_busy: no such command"));

    await expect(terminalsBusy([t1, t2])).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
