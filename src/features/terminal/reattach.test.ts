/**
 * The reattach seam — re-subscribing to a PTY that outlived a webview reload.
 *
 * After a full reload the Rust supervisor + PTYs (with the running `claude`s)
 * are alive but the JS store is gone. `bridge.ts` re-fetches `fleet_snapshot`
 * and `store.rebuildTerminalTabs` rebuilds a tab per terminal, marked
 * `reattach`. The registry must then call **`terminal_reattach`** — NOT
 * `terminal_open` (which errors on an id that is already open) and NOT
 * `agent_spawn` (which would start a second claude). This pins that routing plus
 * the exited-PTY handling.
 *
 * jsdom, like `agentSpawn.test.ts`: `ensureTerminal` opens the PTY without ever
 * calling `term.open()`, so no layout is needed; xterm's buffer still reflects
 * bytes written to it, which is all the streaming assertions read.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAgentId, asTerminalId } from "../../app/types";
import { channelIdOf, installTauriMock, type ChannelDriver, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, ensureTerminal, getTerminal, getTerminalMeta } from "./TerminalRegistry";

const AGENT_ID = asAgentId("01J0AGENT0000000000000000");
const AGENT_TERMINAL_ID = asTerminalId(AGENT_ID);
const SHELL_TERMINAL_ID = asTerminalId("01J0SHELL0000000000000000");
const CWD = "/projects/proj";

/** `openPty` is deferred one task (`scheduleOpen`); let it and its await land. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function reattachMeta(args: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: args.terminalId,
    kind: "terminal",
    title: "sh",
    cwd: CWD,
    cols: 100,
    rows: 30,
    status: "live",
    ...over,
  };
}

function screenText(terminalId: typeof SHELL_TERMINAL_ID): string {
  const term = getTerminal(terminalId);
  if (!term) return "";
  const buf = term.buffer.active;
  let out = "";
  for (let i = 0; i < buf.length; i++) out += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
  return out;
}

describe("TerminalRegistry — terminal_reattach routing", () => {
  let ipc: TauriMock;
  let pty: ChannelDriver;

  beforeEach(() => {
    ipc = installTauriMock();
    pty = ipc.channel();
    ipc
      .handle("terminal_reattach", (args) => {
        pty.capture(args.onOutput);
        return reattachMeta(args);
      })
      .handle("terminal_open", (args) => reattachMeta(args))
      .handle("agent_spawn", (args) => ({ ...reattachMeta({ terminalId: args.agentId }), agentId: args.agentId, kind: "agent-terminal" }))
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("routes a reattach terminal to terminal_reattach, never open or spawn", async () => {
    ensureTerminal(SHELL_TERMINAL_ID, CWD, { reattach: true });
    await flush();

    expect(ipc.calls("terminal_reattach")).toHaveLength(1);
    expect(ipc.calls("terminal_open")).toHaveLength(0);
    expect(ipc.calls("agent_spawn")).toHaveLength(0);
  });

  it("reattaches an AGENT terminal WITHOUT a runtime (nothing is being launched)", async () => {
    // The agent's PTY already runs — reattach must skip the runtime check that
    // `agent_spawn` enforces, and must not spawn a second claude.
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { reattach: true, agentId: AGENT_ID });
    await flush();

    expect(ipc.calls("terminal_reattach")).toHaveLength(1);
    expect(ipc.calls("agent_spawn")).toHaveLength(0);
    // No "agentId but no runtime" error surfaced into the terminal.
    expect(screenText(AGENT_TERMINAL_ID)).not.toMatch(/Failed to start/);
    expect(getTerminalMeta(AGENT_TERMINAL_ID)?.status).toBe("live");
  });

  it("passes the terminalId and a real output Channel to terminal_reattach", async () => {
    ensureTerminal(SHELL_TERMINAL_ID, CWD, { reattach: true });
    await flush();

    const args = ipc.lastCall("terminal_reattach")!;
    expect(args.terminalId).toBe(SHELL_TERMINAL_ID);
    expect(channelIdOf(args.onOutput)).toBeTypeOf("number");
    // reattach takes no program/args/cwd/rows/cols — the PTY already exists.
    expect(args).not.toHaveProperty("program");
    expect(args).not.toHaveProperty("rows");
  });

  it("streams PTY output over the swapped-in Channel after reattach", async () => {
    ensureTerminal(SHELL_TERMINAL_ID, CWD, { reattach: true });
    await flush();

    // Rust replays scrollback / streams live output over the new Channel.
    pty.send("restored-scrollback\r\n");
    await flush();

    expect(screenText(SHELL_TERMINAL_ID)).toContain("restored-scrollback");
  });

  it("marks an exited PTY ended and refuses input", async () => {
    ipc = installTauriMock();
    pty = ipc.channel();
    ipc
      .handle("terminal_reattach", (args) => {
        pty.capture(args.onOutput);
        return reattachMeta(args, { status: "exited", exitCode: 0 });
      })
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);

    ensureTerminal(SHELL_TERMINAL_ID, CWD, { reattach: true });
    await flush();

    expect(getTerminalMeta(SHELL_TERMINAL_ID)?.status).toBe("exited");
    // A visible marker so the reloaded tab reads as over, not blank/live.
    expect(screenText(SHELL_TERMINAL_ID)).toMatch(/process exited/i);
    // Typing into a dead PTY writes nothing — the guard in `send`.
    getTerminal(SHELL_TERMINAL_ID)!.input("ls\r");
    await flush();
    expect(ipc.calls("terminal_write")).toHaveLength(0);
  });

  it("surfaces a reattach failure in the terminal (unknown id → Err)", async () => {
    ipc = installTauriMock();
    ipc
      .handle("terminal_reattach", () => {
        throw new Error("no such terminal");
      })
      .handle("terminal_close", () => null);

    ensureTerminal(SHELL_TERMINAL_ID, CWD, { reattach: true });
    await flush();

    expect(screenText(SHELL_TERMINAL_ID)).toMatch(/Failed to start terminal.*no such terminal/);
  });
});
