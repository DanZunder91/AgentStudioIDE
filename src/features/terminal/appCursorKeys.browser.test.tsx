/** DECCKM (`ESC[?1h`/`ESC[?1l`) picks SS3 vs CSI arrows. Guards that xterm buffers partial
 * escapes across writes, even one byte at a time, so the Rust coalescer splitting `?1h` cannot
 * break arrows inside a TUI. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, focusTerminal, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

const SS3_UP = [27, 79, 65]; // ESC O A
const CSI_UP = [27, 91, 65]; // ESC [ A

async function settle(ms = 80): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("arrow encoding vs DECCKM (application cursor keys)", () => {
  const TID = asTerminalId("01J0APPCURSOR00000000000A");
  let ipc: TauriMock;
  let host: HTMLDivElement;
  let pty: ReturnType<TauriMock["channel"]>;
  let writes: number[][];

  beforeEach(() => {
    host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "300px";
    document.body.appendChild(host);

    writes = [];
    ipc = installTauriMock();
    pty = ipc.channel();
    ipc
      .handle("terminal_open", (a) => {
        pty.capture(a.onOutput);
        return { id: a.terminalId, kind: "terminal", title: "sh", cwd: a.cwd, cols: a.cols, rows: a.rows, status: "live" };
      })
      .handle("terminal_write", (a) => {
        writes.push(Array.from(a.data as number[]));
        return null;
      })
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
    host.remove();
  });

  async function mountFocused() {
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();
    focusTerminal(TID);
    await settle(30);
    return getTerminal(TID)!;
  }

  async function arrowUpBytes(): Promise<number[]> {
    writes.length = 0;
    await userEvent.keyboard("{ArrowUp}");
    await settle(40);
    return writes.flat();
  }

  it("sends CSI when DECCKM is off (the default / claude-in-our-app state)", async () => {
    const term = await mountFocused();
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    expect(await arrowUpBytes()).toEqual(CSI_UP);
  });

  it("sends SS3 once the app enables DECCKM (ESC[?1h)", async () => {
    const term = await mountFocused();
    pty.send("\x1b[?1h");
    await settle(30);
    expect(term.modes.applicationCursorKeysMode).toBe(true);
    expect(await arrowUpBytes()).toEqual(SS3_UP);
  });

  it("applies DECCKM even when ESC[?1h is split across two writes (coalescer-safe)", async () => {
    const term = await mountFocused();
    // Exactly what the Rust coalescer could do: flush mid-sequence.
    pty.send("\x1b[?1");
    await settle(20);
    pty.send("h");
    await settle(20);
    expect(term.modes.applicationCursorKeysMode, "xterm must buffer the partial escape").toBe(true);
    expect(await arrowUpBytes()).toEqual(SS3_UP);
  });

  it("applies DECCKM even when ESC[?1h is delivered one byte per write", async () => {
    const term = await mountFocused();
    for (const ch of "\x1b[?1h") {
      pty.send(ch);
      await settle(10);
    }
    expect(term.modes.applicationCursorKeysMode).toBe(true);
    expect(await arrowUpBytes()).toEqual(SS3_UP);
  });

  it("keeps DECCKM across an alternate-buffer switch (claude uses the alt buffer)", async () => {
    const term = await mountFocused();
    pty.send("\x1b[?1h"); // DECCKM on
    await settle(20);
    pty.send("\x1b[?1049h"); // enter alt buffer
    await settle(20);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.applicationCursorKeysMode, "alt-buffer switch must not reset DECCKM").toBe(true);
    expect(await arrowUpBytes()).toEqual(SS3_UP);
  });

  it("resets DECCKM to off on a soft reset (ESC[!p) — arrows fall back to CSI", async () => {
    // Documents a way a TUI could end up in CSI after enabling DECCKM: any soft
    // (DECSTR) or full (RIS) reset clears it.
    const term = await mountFocused();
    pty.send("\x1b[?1h");
    await settle(20);
    pty.send("\x1b[!p"); // DECSTR soft reset
    await settle(20);
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    expect(await arrowUpBytes()).toEqual(CSI_UP);
  });
});
