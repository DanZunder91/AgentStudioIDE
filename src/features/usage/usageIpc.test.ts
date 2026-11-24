/**
 * `usageIpc` — the usage-limits wire. A thin wrapper, so the command *name*,
 * the (empty) arg shape, and the **rejection passthrough** are the whole contract.
 *
 * The passthrough is the part worth pinning: unlike `pinAgent`/`saveApiStore`, this
 * wrapper deliberately does NOT swallow. A failed usage fetch is information the
 * user needs ("not signed in", "offline"), and the store turns the raw string into a
 * code via `parseUsageError` — which only works if the string arrives untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { claudeUsage } from "./usageIpc";
import type { UsageSnapshot } from "./usageTypes";

const SNAPSHOT: UsageSnapshot = {
  windows: [
    { key: "five_hour", label: "Current session", usedPct: 24, resetsAtMs: 1_783_419_000_000 },
    { key: "seven_day", label: "All models", usedPct: 56, resetsAtMs: 1_783_600_000_000 },
    { key: "seven_day_fable", label: "Fable", usedPct: 76, resetsAtMs: 1_783_600_000_000 },
  ],
  fetchedAtMs: 1_783_400_000_000,
};

describe("usageIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes claude_usage with no arguments and resolves the snapshot untouched", async () => {
    ipc.handle("claude_usage", () => SNAPSHOT);

    await expect(claudeUsage()).resolves.toEqual(SNAPSHOT);
    // Empty args, not undefined: the command takes none, and sending a key Rust
    // does not read would fail as silence rather than as an error.
    expect(ipc.lastCall("claude_usage")).toEqual({});
  });

  it("passes a string rejection through untouched (the store parses the code out of it)", async () => {
    ipc.handle("claude_usage", () =>
      // Rust rejects with the stable `<code>[: detail]` string, never an Error.
      Promise.reject("unauthorized: 401"),
    );

    await expect(claudeUsage()).rejects.toBe("unauthorized: 401");
  });

  it("does not swallow a bare code either", async () => {
    ipc.handle("claude_usage", () => Promise.reject("no-credentials"));

    await expect(claudeUsage()).rejects.toBe("no-credentials");
  });
});
