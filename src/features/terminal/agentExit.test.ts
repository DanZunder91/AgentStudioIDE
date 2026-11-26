/** A dead `claude` never turns its mouse tracking off, so xterm keeps routing drags to it and
 * selection breaks. Asserted on xterm's real parsed state (`term.modes`), not the bytes written. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAgentId, asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  describeAgentExit,
  disposeAll,
  ensureTerminal,
  getTerminal,
  noteAgentExited,
  TERMINAL_MODE_RESET,
  writeTerminalNotice,
} from "./TerminalRegistry";

const AGENT = asTerminalId(asAgentId("01J0AGENTEXIT00000000000000"));
const SHELL = asTerminalId("01J0SHELLEXIT00000000000000");

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
/** Resolve once xterm has parsed everything written so far. */
function parsed(id: typeof AGENT): Promise<void> {
  return new Promise((r) => getTerminal(id)!.write("", () => r()));
}
/** The emulator's buffer as text (serializeTerminal needs a DOM-opened terminal). */
function text(id: typeof AGENT): string {
  const b = getTerminal(id)!.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
  return out.join("\n");
}
const meta = (args: Record<string, unknown>, kind: string) => ({
  id: args.agentId ?? args.terminalId,
  kind,
  title: "t",
  cwd: args.cwd,
  cols: args.cols,
  rows: args.rows,
  status: "live",
  agentId: args.agentId,
});

describe("noteAgentExited", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock()
      .handle("agent_spawn", (a) => meta(a, "agent-terminal"))
      .handle("terminal_open", (a) => meta(a, "terminal"))
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });
  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("turns off the mouse tracking a killed TUI left on, so drag selects again", async () => {
    ensureTerminal(AGENT, "/projects", { agentId: asAgentId(AGENT), runtime: "claude-code" });
    await flush();
    const term = getTerminal(AGENT)!;
    term.write("\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l"); // what claude turns on
    await parsed(AGENT);
    expect(term.modes.mouseTrackingMode).toBe("drag");
    expect(term.modes.bracketedPasteMode).toBe(true);

    noteAgentExited(AGENT, 137);
    await parsed(AGENT);

    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(term.modes.bracketedPasteMode).toBe(false);
    expect(text(AGENT)).toContain("claude exited with code 137 (killed — SIGKILL)");
    expect(text(AGENT)).toContain("Resume");
  });

  it("makes an agent tab read-only: typing reaches no dead PTY", async () => {
    ensureTerminal(AGENT, "/projects", { agentId: asAgentId(AGENT), runtime: "claude-code" });
    await flush();
    noteAgentExited(AGENT, 1);
    getTerminal(AGENT)!.input("hello");
    await flush();
    expect(ipc.calls("terminal_write")).toHaveLength(0);
  });

  it("a shell that hosted the agent stays usable: modes reset, nothing printed, input flows", async () => {
    ensureTerminal(SHELL, "/projects");
    await flush();
    const term = getTerminal(SHELL)!;
    term.write("\x1b[?1000h");
    await parsed(SHELL);
    const before = text(SHELL);

    noteAgentExited(SHELL, 137);
    await parsed(SHELL);

    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(text(SHELL)).toBe(before);
    term.input("ls\r");
    await flush();
    expect(ipc.calls("terminal_write").length).toBeGreaterThan(0);
  });

  it("is a no-op for an unknown terminal and fires once per terminal", async () => {
    expect(() => noteAgentExited(asTerminalId("nope"), 1)).not.toThrow();
    ensureTerminal(AGENT, "/projects", { agentId: asAgentId(AGENT), runtime: "claude-code" });
    await flush();
    noteAgentExited(AGENT, 0);
    noteAgentExited(AGENT, 0);
    await parsed(AGENT);
    const shown = text(AGENT);
    expect(shown.split("[claude exited]").length - 1).toBe(1);
  });

  it("writeTerminalNotice prints into a terminal, and ignores unknown ids", async () => {
    expect(() => writeTerminalNotice(asTerminalId("nope"), "x")).not.toThrow();
    ensureTerminal(SHELL, "/projects");
    await flush();
    writeTerminalNotice(SHELL, "Can't resume: no saved conversation.");
    await parsed(SHELL);
    expect(text(SHELL)).toContain("Can't resume: no saved conversation.");
  });
});

describe("describeAgentExit", () => {
  it("names signals the way a person reads them", () => {
    expect(describeAgentExit(0)).toBe("claude exited");
    expect(describeAgentExit(1)).toBe("claude exited with code 1");
    expect(describeAgentExit(130)).toBe("claude exited with code 130 (killed — SIGINT)");
    expect(describeAgentExit(143)).toBe("claude exited with code 143 (killed — SIGTERM)");
    expect(describeAgentExit(139)).toBe("claude exited with code 139 (killed — SIGSEGV)");
    expect(describeAgentExit(200)).toBe("claude exited with code 200");
  });

  it("the reset turns off every mouse encoding it claims to", () => {
    for (const m of ["9", "1000", "1002", "1003", "1005", "1006", "1015", "1016", "2004", "1004"]) {
      expect(TERMINAL_MODE_RESET).toContain(`\x1b[?${m}l`);
    }
  });
});
