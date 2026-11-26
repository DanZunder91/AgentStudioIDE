/** Browser tier: the key path (DOM → xterm's textarea → parser → `onData` → `terminal_write`)
 * does not exist in jsdom. Guards against a handler swallowing keys such as ↑ (history recall). */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, focusTerminal, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

const ESC = 0x1b;

async function settle(ms = 120): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("terminal key input — arrow/special keys reach the PTY", () => {
  const TID = asTerminalId("01J0KEYINPUT00000000000A");
  let ipc: TauriMock;
  let host: HTMLDivElement;
  let pty: ReturnType<TauriMock["channel"]>;
  /** Every byte sequence the UI sent to the PTY, in order. */
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
    await settle(40);
    return getTerminal(TID)!;
  }

  /** Flatten all bytes written since the last reset into one array. */
  const sentBytes = (): number[] => writes.flat();
  const resetWrites = () => {
    writes.length = 0;
  };

  it("forwards the four arrow keys as CSI sequences (normal cursor mode)", async () => {
    await mountFocused();

    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(50);
    // ↑ in a readline shell = ESC [ A — the "recall previous command" key.
    expect(sentBytes()).toEqual([ESC, 0x5b, 0x41]); // ESC [ A

    resetWrites();
    await userEvent.keyboard("{ArrowDown}{ArrowRight}{ArrowLeft}");
    await settle(50);
    expect(sentBytes()).toEqual([
      ESC, 0x5b, 0x42, // ESC [ B
      ESC, 0x5b, 0x43, // ESC [ C
      ESC, 0x5b, 0x44, // ESC [ D
    ]);
  });

  it("switches to SS3 sequences in application-cursor-keys mode (DECCKM)", async () => {
    // readline/TUIs enable DECCKM (ESC [ ? 1 h); ↑ then becomes ESC O A, and a
    // shell that requested that mode expects exactly those bytes back.
    await mountFocused();

    pty.send("\x1b[?1h");
    await settle(40);

    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(50);
    expect(sentBytes()).toEqual([ESC, 0x4f, 0x41]); // ESC O A
  });

  it("recalls the previous command end-to-end (↑ against a shell with history)", async () => {
    // The everyday action exactly, on a STABLE terminal. A tiny mock shell holds
    // one line of history and, like readline, redraws it when it receives ↑.
    // Proves the whole loop: keystroke → PTY → shell response → visible text.
    const term = await mountFocused();

    let history = "";
    let line = "";
    const prompt = "$ ";
    pty.send(prompt);

    // Drive the shell from the PTY side in response to what the UI writes.
    ipc.handle("terminal_write", (a) => {
      writes.push(Array.from(a.data as number[]));
      const s = new TextDecoder().decode(Uint8Array.from(a.data as number[]));
      if (s === "\r") {
        history = line;
        line = "";
        pty.send("\r\n" + prompt); // newline + fresh prompt
      } else if (s === "\x1b[A") {
        // Recall: clear the line and echo the remembered command.
        pty.send("\r\x1b[K" + prompt + history);
        line = history;
      } else {
        line += s;
        pty.send(s); // local echo
      }
      return null;
    });

    await userEvent.keyboard("echo hello");
    await settle(60);
    await userEvent.keyboard("{Enter}");
    await settle(60);

    // Fresh prompt, empty line: the command is now in history, not on screen.
    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(80);

    // ↑ was sent as ESC [ A ...
    expect(sentBytes()).toEqual([ESC, 0x5b, 0x41]);
    // ... and the shell redrew the previous command, so it is on screen again.
    const screen = term.buffer.active;
    let visible = "";
    for (let i = 0; i <= screen.baseY + term.rows; i++) {
      visible += (screen.getLine(i)?.translateToString(true) ?? "") + "\n";
    }
    expect(visible).toContain("echo hello");
  });

  it("still forwards ↑ while an app holds the mouse (the wheel fix is wheel-only)", async () => {
    // Directly rules out my scrollback wheel handler as a key-swallower: enable
    // mouse tracking (its trigger) and confirm ↑ still reaches the PTY.
    await mountFocused();

    pty.send("\x1b[?1002h\x1b[?1006h");
    await settle(40);

    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(50);
    expect(sentBytes()).toEqual([ESC, 0x5b, 0x41]); // ESC [ A, unaffected
  });

  it("keystrokes only reach the PTY once the terminal is focused", async () => {
    // Focus is the other way the Up arrow silently dies: if the click landed on the
    // pane/rail instead, the textarea never sees the key.
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();

    // Move focus away from the terminal.
    const sink = document.createElement("input");
    document.body.appendChild(sink);
    sink.focus();
    expect(document.activeElement).toBe(sink);

    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(40);
    expect(sentBytes(), "unfocused terminal must not receive keys").toEqual([]);

    // Focus it and try again — now it forwards.
    focusTerminal(TID);
    await settle(40);
    resetWrites();
    await userEvent.keyboard("{ArrowUp}");
    await settle(50);
    expect(sentBytes()).toEqual([ESC, 0x5b, 0x41]);

    sink.remove();
  });
});
