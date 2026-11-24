/**
 * `terminalsBusy` — the one IPC the close gate asks before it kills a terminal.
 *
 * Three behaviours, and only one of them is the happy path. The other two are
 * the reason the wrapper exists at all:
 *
 *   - **the empty short circuit** — a pane with no terminals must not cost a
 *     round trip, and (more importantly) must not reach Rust with an empty id
 *     list, where "none of these are busy" and "I could not tell" look alike;
 *   - **the rejection arm** — a backend hiccup resolves to `[]`, i.e. "nothing
 *     is busy", so a broken IPC can never strand the user in a tab that refuses
 *     to close. The wrapper's own header states that track: the cost of being
 *     wrong here is one lost terminal, the cost of the other failure mode is an
 *     app that stops responding to its own ✕.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The wrapper's ONLY dependency — mocked at the Tauri boundary, exactly as
// `layoutPrefsIpc.test.ts` does it. (This factory is a frozen copy
// of the module's surface; `invoke` is the only export this module imports, so
// if that ever changes, this factory has to change with it.)
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
    // The pane ✕ on a pane of editor tabs computes `[]`. Asking Rust "are any of
    // these zero terminals busy?" is a round trip whose only possible answer is
    // the one we already have — and it is on the path of a click the user is
    // waiting on.
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
