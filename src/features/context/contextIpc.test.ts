/**
 * `contextIpc` — the context-window wire. The command NAME, the exact argument object
 * (serde ignores a misspelt key, so a typo fails as silence), the rejection passthrough,
 * and the error-code splitter are the whole contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { contextUsage, parseContextError, splitContextError } from "./contextIpc";
import type { ContextUsage } from "./contextTypes";

const READING: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 290_700,
  windowTokens: 1_000_000,
  usedPercent: 29,
  categories: [{ key: "messages", label: "Messages", tokens: 257_900, percent: 25.8 }],
  measuredAtMs: 1_785_200_000_000,
};


describe("contextUsage", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes context_usage with exactly { agentId } and resolves the reading untouched", async () => {
    ipc.handle("context_usage", () => READING);

    await expect(contextUsage("root-a")).resolves.toEqual(READING);
    // The agent id and NOTHING else: no session id (it never crosses the wire) and
    // no cwd (Rust takes the live root's own).
    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });
  });

  it("passes the coded rejection through untouched — the store classifies it", async () => {
    ipc.handle("context_usage", () => Promise.reject("no-session: no conversation found"));

    await expect(contextUsage("root-a")).rejects.toBe("no-session: no conversation found");
  });
});

describe("splitContextError", () => {
  it.each([
    ["cli-missing", "cli-missing", null],
    ["bad-session: not a live root agent", "bad-session", "not a live root agent"],
    ["no-session: No conversation found with session ID x", "no-session", "No conversation found with session ID x"],
    ["cli-failed: exit 1: boom", "cli-failed", "exit 1: boom"],
    ["timeout", "timeout", null],
    ["parse: no table", "parse", "no table"],
    // Case and padding are forgiven on the head — the shared reader's rule.
    ["  TIMEOUT : late ", "timeout", "late"],
  ])("%j → %s", (raw, code, detail) => {
    expect(splitContextError(raw)).toEqual({ code, detail });
  });

  it("an Error carrying a coded message is read by its message (cross-realm safe)", () => {
    expect(splitContextError({ message: "parse: x" })).toEqual({ code: "parse", detail: "x" });
    expect(splitContextError(new Error("timeout"))).toEqual({ code: "timeout", detail: null });
  });

  it.each([
    ["invalid args `sessionId` for command `context_usage`"],
    ["unauthorized: 401"], // another feature's code is not ours
    [42],
    [null],
    [undefined],
  ])("an unclassifiable %j is unknown and loses its detail (raw CLI text never reaches the screen)", (raw) => {
    expect(splitContextError(raw)).toEqual({ code: "unknown", detail: null });
  });
});

describe("parseContextError", () => {
  it("is the code alone", () => {
    expect(parseContextError("no-session: whatever")).toBe("no-session");
    expect(parseContextError("nope")).toBe("unknown");
  });
});
