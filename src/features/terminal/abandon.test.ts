/** Tear-off's terminal half (docs/design/tab-tearoff.md §3). A reattached terminal must not
 * resize before its first fit: xterm's 24×80 default would reflow a live TUI. jsdom works because
 * `ensureTerminal` opens the PTY without `term.open()`. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  abandon,
  configureTerminal,
  dispose,
  disposeAll,
  ensureTerminal,
  getTerminalMeta,
  hasTerminal,
  setRemoteDisposer,
} from "./TerminalRegistry";

const ID = asTerminalId("01J0TERM000000000000000000");
const CWD = "/projects/proj";

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const meta = (args: Record<string, unknown>) => ({
  id: args.terminalId,
  kind: "terminal",
  title: "sh",
  cwd: CWD,
  cols: 100,
  rows: 30,
  status: "live",
});

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
  ipc
    .handle("terminal_open", (args) => meta(args))
    .handle("terminal_reattach", (args) => meta(args))
    .handle("terminal_write", () => null)
    .handle("terminal_resize", () => null)
    .handle("terminal_close", () => null);
});
afterEach(() => {
  setRemoteDisposer(null);
  disposeAll();
  ipc.reset();
});

describe("abandon — leave the PTY running", () => {
  it("drops this window's terminal and never sends terminal_close", async () => {
    ensureTerminal(ID, CWD);
    await flush();
    expect(hasTerminal(ID)).toBe(true);

    abandon(ID);
    await flush();
    expect(hasTerminal(ID)).toBe(false);
    expect(ipc.calls("terminal_close")).toHaveLength(0);
  });

  it("is the ONLY difference from dispose, which does kill it", async () => {
    ensureTerminal(ID, CWD);
    await flush();
    dispose(ID);
    await flush();
    expect(ipc.lastCall("terminal_close")).toEqual({ terminalId: ID });
  });

  it("forgets the spawn configuration, so a later dispose here does not reach the PTY", async () => {
    configureTerminal(ID, { reattach: true });
    abandon(ID); // never mounted, but configured — the tab left before it was shown
    dispose(ID);
    await flush();
    expect(ipc.calls("terminal_close")).toHaveLength(0);
  });

  it("is harmless for a terminal this window never had", () => {
    expect(() => abandon(asTerminalId("unknown"))).not.toThrow();
  });
});

describe("dispose — a terminal this window never mounted", () => {
  it("kills a never-shown REATTACH terminal's PTY instead of leaking it — once", async () => {
    // A tab rebuilt after a reload (or adopted from another window) that was closed before
    // anyone looked at it: its child is alive in Rust and nothing else will ever kill it.
    configureTerminal(ID, { reattach: true, cwd: CWD });
    dispose(ID);
    await flush();
    expect(ipc.calls("terminal_close")).toEqual([{ cmd: "terminal_close", args: { terminalId: ID } }]);
    dispose(ID);
    await flush();
    expect(ipc.calls("terminal_close"), "a second dispose stays a no-op").toHaveLength(1);
  });

  it("does not try to close a terminal that was configured to SPAWN but never opened", async () => {
    configureTerminal(ID, { cwd: CWD });
    dispose(ID);
    await flush();
    expect(ipc.calls("terminal_close")).toHaveLength(0);
  });

  it("hands the close to the window holding it, when one does", async () => {
    const remote = vi.fn(() => true);
    setRemoteDisposer(remote);
    dispose(ID);
    expect(remote).toHaveBeenCalledWith(ID);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    // A mounted terminal is this window's own: closed here, never handed off.
    remote.mockClear();
    ensureTerminal(ID, CWD);
    await flush();
    dispose(ID);
    expect(remote).not.toHaveBeenCalled();
  });

  it("a never-mounted reattach terminal is closed here, not handed off", async () => {
    const remote = vi.fn(() => true);
    setRemoteDisposer(remote);
    configureTerminal(ID, { reattach: true });
    dispose(ID);
    await flush();
    expect(remote).not.toHaveBeenCalled();
    expect(ipc.calls("terminal_close")).toHaveLength(1);
  });

  it("does nothing more once the hand-off is unset", () => {
    const remote = vi.fn(() => true);
    setRemoteDisposer(remote);
    setRemoteDisposer(null);
    dispose(ID);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("a reattached terminal sends no size before it is fitted", () => {
  it("does not push xterm's 24×80 default at a live PTY that is 100×30", async () => {
    // A tab arriving in a window whose pane has no layout yet: the reattach lands before any
    // fit. Rust says the PTY is 100×30; the unfitted xterm says 80×24 — a guess.
    ensureTerminal(ID, CWD, { reattach: true });
    await flush();
    expect(getTerminalMeta(ID)?.status).toBe("live");
    expect(ipc.calls("terminal_resize")).toHaveLength(0);
  });
});
