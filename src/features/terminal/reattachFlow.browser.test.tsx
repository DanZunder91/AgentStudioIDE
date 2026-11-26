/** A webview reload end to end: the bridge's `applyFleetSnapshot` then `rebuildTerminalTabs`, the
 * real `<App>`, and the terminal calling `terminal_reattach` with output streaming in. Unit tests
 * pin each link; this proves they connect. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../App";
import { useAppStore } from "../../app/store";
import { disposeAll, getTerminal } from "../../features/terminal";
import { asAgentId, asTerminalId, type AgentNode, type TerminalMeta } from "../../app/types";
import { installTauriMock, type ChannelDriver, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";

const AGENT_ID = asAgentId("01J0RELOAD00000000000000A");

async function settle(ms = 200): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

const runningAgent = (): AgentNode => ({
  id: AGENT_ID,
  parentId: null,
  kind: "orchestrator",
  title: "claude",
  status: "running",
  branch: "trunk",
  cwd: "/projects/proj",
  runtime: "claude-code",
  startedAt: 1,
  finishedAt: null,
  lastActivityAt: 1,
  childIds: [],
  sessionId: null,
  expanded: true,
  unread: 0,
});

const agentTerminal = (): TerminalMeta => ({
  id: asTerminalId(AGENT_ID), // an agent terminal's id IS its agentId
  kind: "agent-terminal",
  title: "claude",
  cwd: "/projects/proj",
  cols: 100,
  rows: 30,
  status: "live",
  agentId: AGENT_ID,
});

describe("reattach flow — reloaded window recovers its agent terminal", () => {
  let ipc: TauriMock;
  let pty: ChannelDriver;

  beforeEach(() => {
    resetStore();
    ipc = installTauriMock();
    pty = ipc.channel();
    ipc
      .handle("terminal_reattach", (args) => {
        pty.capture(args.onOutput);
        return {
          id: args.terminalId,
          kind: "agent-terminal",
          title: "claude",
          cwd: "/projects/proj",
          cols: 100,
          rows: 30,
          status: "live",
          agentId: args.terminalId,
        };
      })
      .handle("terminal_open", () => {
        throw new Error("reload must reattach, not terminal_open");
      })
      .handle("agent_spawn", () => {
        throw new Error("reload must reattach, not agent_spawn");
      })
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("rebuilds the tab, reattaches on select, and streams output", async () => {
    // ── the bridge's post-reload sequence: agents first, then terminals ──
    act(() => {
      useAppStore.getState().agentActions.applyFleetSnapshot([runningAgent()]);
      useAppStore.getState().layoutActions.rebuildTerminalTabs([agentTerminal()]);
    });

    render(<App />);
    await settle();

    // The tab exists again (the rail is no longer tabs-less).
    const agentTab = Object.values(useAppStore.getState().tabs).find(
      (t) => t.ref.kind === "agent-terminal" && t.ref.agentId === AGENT_ID,
    );
    expect(agentTab, "a tab must have been rebuilt for the running agent").toBeTruthy();

    // ── selecting the agent activates its terminal tab (the click that did
    //    nothing before this fix) ──
    act(() => {
      useAppStore.getState().agentActions.selectAgent(AGENT_ID);
    });
    await settle();

    // ── the terminal mounted and reattached, not reopened ──
    expect(ipc.calls("terminal_reattach"), "must reattach the live PTY").toHaveLength(1);
    expect(ipc.calls("terminal_reattach")[0].args.terminalId).toBe(AGENT_ID);
    expect(ipc.calls("terminal_open")).toHaveLength(0);
    expect(ipc.calls("agent_spawn")).toHaveLength(0);

    const term = getTerminal(asTerminalId(AGENT_ID));
    expect(term, "the reattached xterm exists").toBeTruthy();

    // ── PTY output streams over the swapped-in Channel ──
    pty.send("welcome back — scrollback replayed\r\n");
    await settle(60);

    const buf = term!.buffer.active;
    let text = "";
    for (let i = 0; i < buf.length; i++) text += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
    expect(text).toContain("welcome back — scrollback replayed");
  });
});
