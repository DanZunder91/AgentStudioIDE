/**
 * `sessionsIpc` — the past-sessions command ("Recover session") at the wire.
 *
 * A thin wrapper, and thin wrappers are exactly where the command *name* and
 * the arg *shape* are the whole contract: get either wrong and Rust rejects at
 * runtime with types none the wiser (the `fleetIpc` lesson). The picker's real
 * exercise lives in `SessionPicker.test.tsx`; this pins the marshalling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { listClaudeSessions, type ClaudeSessionMeta } from "./sessionsIpc";

describe("sessionsIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("invokes list_claude_sessions with the cwd and returns the sessions Rust sent", async () => {
    const sessions: ClaudeSessionMeta[] = [
      {
        sessionId: "s-new",
        mtimeMs: 2_000,
        sizeBytes: 11_534_336,
        label: "Fix the flatten bug",
        resumable: true,
      },
      {
        sessionId: "s-old",
        mtimeMs: 1_000,
        sizeBytes: 42,
        label: "Explore the repo",
        resumable: false,
      },
    ];
    ipc.handle("list_claude_sessions", () => sessions);

    await expect(listClaudeSessions("/w/gazelle")).resolves.toEqual(sessions);
    expect(ipc.lastCall("list_claude_sessions")).toEqual({ cwd: "/w/gazelle" });
  });

  it("resolves an EMPTY list as-is — a folder that never ran claude is normal", async () => {
    ipc.handle("list_claude_sessions", () => []);
    await expect(listClaudeSessions("/w/fresh")).resolves.toEqual([]);
  });

  it("propagates a rejection to the caller rather than swallowing into []", async () => {
    // The picker turns this into a calm inline note; an empty list here would
    // lie "no sessions" and hide that the read actually failed.
    ipc.handle("list_claude_sessions", () => {
      throw new Error("cannot read ~/.claude/projects");
    });

    await expect(listClaudeSessions("/w/x")).rejects.toThrow(/cannot read/);
  });
});
