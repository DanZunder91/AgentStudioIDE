/**
 * `claudeMcpIpc` — the three IPCs behind "Add Agent Studio to Claude Code".
 *
 * Two things matter: each wrapper asks its own Rust command (a swapped name would install when
 * the user asked for the status), and none of them ever rejects — a failed bridge must become a
 * report the menu item can show, or the item would sit on "Checking…" forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  claudeMcpInstall,
  claudeMcpStatus,
  claudeMcpUninstall,
  type ClaudeMcpReport,
} from "./claudeMcpIpc";

const installed: ClaudeMcpReport = {
  ok: true,
  state: "installed",
  message: "Agent Studio is added to Claude Code.",
  configured: "/opt/agent-studio",
  scope: "User config (available in all your projects)",
  exe: "/opt/agent-studio",
};

beforeEach(() => {
  invoke.mockReset();
});

describe("claudeMcpIpc", () => {
  it("asks each action's own command, with no arguments, and returns Rust's report", async () => {
    invoke.mockResolvedValue(installed);
    await expect(claudeMcpStatus()).resolves.toEqual(installed);
    await expect(claudeMcpInstall()).resolves.toEqual(installed);
    await expect(claudeMcpUninstall()).resolves.toEqual(installed);
    expect(invoke.mock.calls).toEqual([
      ["claude_mcp_status"],
      ["claude_mcp_install"],
      ["claude_mcp_uninstall"],
    ]);
  });

  it("never rejects: a failed IPC is a failed report that says why", async () => {
    invoke.mockRejectedValue(new Error("bridge down"));
    for (const ask of [claudeMcpStatus, claudeMcpInstall, claudeMcpUninstall]) {
      const report = await ask();
      expect(report).toMatchObject({ ok: false, state: "failed", configured: null, scope: null, exe: "" });
      expect(report.message).toContain("bridge down");
    }
  });
});
