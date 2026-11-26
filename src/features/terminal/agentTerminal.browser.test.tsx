/** The whole journey in real pixels (create → attach → fit → resize → dispose), addressed by the
 * id Rust keyed it under. Driven via `TerminalView` + `configureTerminal`, not the store:
 * `store.openTerminalTab` does not yet forward `agentId` to the registry. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAgentId, asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { configureTerminal, disposeAll, dispose, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

/** An agent terminal's TerminalId IS its AgentId (Rust keys the PTY that way). */
const AGENT_ID = asAgentId("01J0AGENTBROWSER00000000");
const TERMINAL_ID = asTerminalId(AGENT_ID);
const RUNTIME = "claude-code";
const CWD = "/projects/proj";

const FIT_MIN_COLS = 2;
const FIT_MIN_ROWS = 1;

async function settle(ms = 300): Promise<void> {
  await act(async () => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("agent terminal — the full journey, in real pixels", () => {
  let ipc: TauriMock;
  let host: HTMLDivElement;
  /** Every sizing command Rust would have seen, in order. */
  let sizing: { cmd: string; terminalId: string; rows: number; cols: number }[];

  beforeEach(() => {
    sizing = [];
    host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "400px";
    document.body.appendChild(host);

    ipc = installTauriMock();
    ipc
      .handle("agent_spawn", (args) => {
        sizing.push({
          cmd: "agent_spawn",
          terminalId: String(args.agentId),
          rows: Number(args.rows),
          cols: Number(args.cols),
        });
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
      })
      .handle("terminal_open", () => {
        throw new Error("terminal_open must not be called for an agent terminal");
      })
      .handle("terminal_resize", (args) => {
        sizing.push({
          cmd: "terminal_resize",
          terminalId: String(args.terminalId),
          rows: Number(args.rows),
          cols: Number(args.cols),
        });
        return null;
      })
      .handle("terminal_write", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
    host.remove();
  });

  it("spawns via agent_spawn, fits, resizes and disposes — all under the agent's id", async () => {
    configureTerminal(TERMINAL_ID, { cwd: CWD, agentId: AGENT_ID, runtime: RUNTIME });

    // ── create + attach ──
    render(<TerminalView terminalId={TERMINAL_ID} />, { container: host });
    await settle();

    expect(ipc.calls("agent_spawn"), "must spawn through the adapter seam").toHaveLength(1);
    expect(ipc.calls("terminal_open"), "must never open a shell").toHaveLength(0);
    expect(getTerminal(TERMINAL_ID), "xterm instance must exist").toBeTruthy();

    // The PTY was born at the pane's real size, not xterm's 24x80 default.
    const spawn = sizing[0];
    expect(spawn.cmd).toBe("agent_spawn");
    expect(spawn.cols).toBeGreaterThan(20);
    expect(spawn.rows).toBeGreaterThan(5);

    // ── resize: the hardened fit chain must work identically ──
    await act(async () => {
      host.style.width = "500px";
      host.style.height = "250px";
    });
    await settle();

    const resizes = sizing.filter((c) => c.cmd === "terminal_resize");
    expect(resizes.length, "a real resize must reach the PTY").toBeGreaterThan(0);

    // Every sizing command must address the id Rust keyed the PTY under. If the
    // registry sent its own TerminalId here, output would still stream and the
    // keyboard would be silently dead.
    for (const c of sizing) {
      expect(c.terminalId, `${c.cmd} addressed the wrong terminal`).toBe(AGENT_ID);
    }

    // ── the 2-column guards must protect agent terminals too ──
    const degenerate = sizing.filter((c) => c.cols <= FIT_MIN_COLS || c.rows <= FIT_MIN_ROWS);
    expect(
      degenerate,
      `agent terminal saw a degenerate size:\n${sizing.map((c) => `${c.cmd} ${c.cols}x${c.rows}`).join("\n")}`,
    ).toEqual([]);

    // ── dispose ──
    dispose(TERMINAL_ID);
    await settle(50);

    expect(ipc.lastCall("terminal_close")).toEqual({ terminalId: AGENT_ID });
    expect(getTerminal(TERMINAL_ID), "dispose must free the instance").toBeUndefined();
  });

  it("keeps the agent's xterm instance alive across a remount (scrollback survives)", async () => {
    // Same guarantee a shell gets: unmount detaches, it does not dispose. An
    // agent's scrollback is its transcript — losing it on a split would be worse
    // than for a shell.
    configureTerminal(TERMINAL_ID, { cwd: CWD, agentId: AGENT_ID, runtime: RUNTIME });

    const view = render(<TerminalView terminalId={TERMINAL_ID} />, { container: host });
    await settle();

    const before = getTerminal(TERMINAL_ID);
    expect(before).toBeTruthy();

    view.unmount();
    await settle(50);

    expect(getTerminal(TERMINAL_ID), "unmount must not dispose").toBe(before);
    expect(ipc.calls("terminal_close"), "unmount must not kill the agent").toHaveLength(0);

    // A different host, as a pane remount does; also required because RTL caches one React
    // root per container and the old one is dead after unmount.
    const host2 = document.createElement("div");
    host2.style.width = "640px";
    host2.style.height = "320px";
    document.body.appendChild(host2);
    try {
      render(<TerminalView terminalId={TERMINAL_ID} />, { container: host2 });
      await settle();

      expect(getTerminal(TERMINAL_ID), "re-attach must reuse the instance").toBe(before);
      expect(ipc.calls("agent_spawn"), "re-attach must not respawn the agent").toHaveLength(1);
      expect(host2.querySelector(".xterm"), "the xterm DOM must move to the new host").toBeTruthy();
    } finally {
      host2.remove();
    }
  });
});
