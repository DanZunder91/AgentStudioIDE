/** The registry's one decision: `agent_spawn` with an `agentId`, else `terminal_open`
 * (ARCHITECTURE §2.4). jsdom suffices: `ensureTerminal()` never calls `term.open()`. Assertions
 * are on the wire args, not "it got called": wrappers that "obviously work" have bitten before. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAgentId, asTerminalId } from "../../app/types";
import { channelIdOf, installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { configureTerminal, disposeAll, ensureTerminal, getTerminalMeta } from "./TerminalRegistry";

/** An agent's TerminalId is its AgentId: Rust keys the PTY that way (`supervisor/mod.rs`). */
const AGENT_ID = asAgentId("01J0AGENT0000000000000000");
const AGENT_TERMINAL_ID = asTerminalId(AGENT_ID);
const SHELL_TERMINAL_ID = asTerminalId("01J0SHELL0000000000000000");

const RUNTIME = "claude-code";
const CWD = "/projects/proj";

/** `openPty` is deferred one task (`scheduleOpen`); let it and its await land. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function agentMeta(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: args.agentId, // Rust returns the agentId as the TerminalId
    kind: "agent-terminal",
    title: "claude",
    cwd: args.cwd,
    cols: args.cols,
    rows: args.rows,
    status: "live",
    agentId: args.agentId,
  };
}

describe("TerminalRegistry — agent_spawn routing", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
    ipc
      .handle("agent_spawn", (args) => agentMeta(args))
      .handle("terminal_open", (args) => ({
        id: args.terminalId,
        kind: "terminal",
        title: "sh",
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        status: "live",
      }))
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("routes to agent_spawn when an agentId is set, and never opens a shell", async () => {
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    await flush();

    expect(ipc.calls("agent_spawn")).toHaveLength(1);
    // The whole point: "+ New agent" must not silently get you bash.
    expect(ipc.calls("terminal_open")).toHaveLength(0);
  });

  it("routes to terminal_open when there is no agentId", async () => {
    ensureTerminal(SHELL_TERMINAL_ID, CWD);
    await flush();

    expect(ipc.calls("terminal_open")).toHaveLength(1);
    expect(ipc.calls("agent_spawn")).toHaveLength(0);
  });

  it("marshals the full agent_spawn contract, not just the id", async () => {
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    await flush();

    const args = ipc.lastCall("agent_spawn")!;
    expect(args.agentId).toBe(AGENT_ID);
    expect(args.runtime).toBe(RUNTIME);
    expect(args.cwd).toBe(CWD);
    // Size must be real: Rust allocates the PTY at it, and a TUI lays its first
    // paint out against it.
    expect(args.rows).toBeGreaterThan(0);
    expect(args.cols).toBeGreaterThan(0);
    // `channelIdOf`, not a string match: mockIPC skips Tauri's serializer, so the Channel
    // arrives as an instance, not "__CHANNEL__:<id>".
    expect(channelIdOf(args.onOutput)).toBeTypeOf("number");
    // `agent_spawn` deliberately carries NO terminalId: Rust derives it from
    // the agentId. Sending one would imply the frontend gets to choose.
    expect(args).not.toHaveProperty("terminalId");
  });

  it("names a runtime, never a program — the adapter seam", async () => {
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    await flush();

    const args = ipc.lastCall("agent_spawn")!;
    // Which binary/flags "claude-code" means is agent/claude.rs's business. If
    // any of these ever appear, the frontend has learned something it must not.
    expect(args).not.toHaveProperty("program");
    expect(args).not.toHaveProperty("args");
    expect(JSON.stringify(args)).not.toMatch(/\bclaude\b(?!-code)/);
  });

  it("adopts the TerminalMeta agent_spawn returns", async () => {
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    await flush();

    const meta = getTerminalMeta(AGENT_TERMINAL_ID);
    expect(meta?.kind).toBe("agent-terminal");
    expect(meta?.agentId).toBe(AGENT_ID);
    expect(meta?.id).toBe(AGENT_TERMINAL_ID);
  });

  it("reads agentId/runtime pre-registered via configureTerminal", async () => {
    // The real path: the code that owns tab lifetime knows the agent; the component
    // that mounts it only knows a TerminalId.
    configureTerminal(AGENT_TERMINAL_ID, { cwd: CWD, agentId: AGENT_ID, runtime: RUNTIME });
    ensureTerminal(AGENT_TERMINAL_ID);
    await flush();

    expect(ipc.calls("agent_spawn")).toHaveLength(1);
    expect(ipc.lastCall("agent_spawn")!.runtime).toBe(RUNTIME);
    expect(ipc.calls("terminal_open")).toHaveLength(0);
  });

  it("refuses to fall back to a shell when the runtime is missing", async () => {
    // Silently opening bash is precisely the bug this seam exists to kill, so a
    // half-specified agent terminal must fail visibly rather than degrade.
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID });
    await flush();

    expect(ipc.calls("agent_spawn")).toHaveLength(0);
    expect(ipc.calls("terminal_open")).toHaveLength(0);
    expect(getTerminalMeta(AGENT_TERMINAL_ID)).toBeNull();
  });

  it("catches an id mismatch instead of leaving a dead keyboard", async () => {
    // If Rust's terminal_id and ours diverge, output still streams (the Channel
    // was handed over directly) but every write/resize/close misses. That must
    // surface as an error, not as a terminal that ignores typing.
    ipc.handle("agent_spawn", (args) => ({
      ...agentMeta(args),
      id: "some-other-id",
    }));

    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    await flush();

    expect(ipc.calls("agent_spawn")).toHaveLength(1);
    // Never marked ready → no writes are sent to an id Rust does not know.
    expect(getTerminalMeta(AGENT_TERMINAL_ID)).toBeNull();
  });

  it("keeps the two spawn paths in one registry, sharing one lifecycle", async () => {
    ensureTerminal(AGENT_TERMINAL_ID, CWD, { agentId: AGENT_ID, runtime: RUNTIME });
    ensureTerminal(SHELL_TERMINAL_ID, CWD);
    await flush();

    expect(ipc.calls("agent_spawn")).toHaveLength(1);
    expect(ipc.calls("terminal_open")).toHaveLength(1);
    expect(getTerminalMeta(AGENT_TERMINAL_ID)?.kind).toBe("agent-terminal");
    expect(getTerminalMeta(SHELL_TERMINAL_ID)?.kind).toBe("terminal");
  });
});
