/** Without focus on activation the first keystroke goes to `<body>`, not xterm. `useTerminal`
 * focuses on mount and a pane renders only its active tab (mounting == activation), so a key
 * must reach the PTY with no manual click. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

const CSI_UP = [27, 91, 65]; // ESC [ A — what claude (and a default shell) expects

async function settle(ms = 120): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("terminal auto-focus on activation (no click needed)", () => {
  const TID = asTerminalId("01J0AUTOFOCUS0000000000A");
  let ipc: TauriMock;
  let host: HTMLDivElement;
  let writes: number[][];

  beforeEach(() => {
    host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "300px";
    document.body.appendChild(host);
    // Park focus somewhere else first, like the webview body / a tab button, so
    // the terminal must claim focus itself.
    document.body.focus();

    writes = [];
    ipc = installTauriMock();
    const pty = ipc.channel();
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

  it("focuses the xterm textarea on mount, with no click", async () => {
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();

    expect(getTerminal(TID)).toBeTruthy();
    expect(
      document.activeElement?.classList.contains("xterm-helper-textarea"),
      "the terminal must own the keyboard after activation, without a click",
    ).toBe(true);
  });

  it("the first keystroke after activation reaches the PTY (no click)", async () => {
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();

    // No mousedown, no focusTerminal call — straight to typing, as a user does.
    await userEvent.keyboard("{ArrowUp}");
    await settle(40);

    expect(writes.flat(), "↑ must reach the PTY as the first key").toEqual(CSI_UP);
  });

  it("re-focuses when the terminal is re-activated after being unmounted", async () => {
    // Tab-switch away and back: the pane unmounts the inactive tab's view and
    // remounts it on return, so the terminal must re-focus each time.
    const view = render(<TerminalView terminalId={TID} />, { container: host });
    await settle();
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true);

    view.unmount();
    await settle(40);
    document.body.focus();
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(false);

    // Re-activate in a fresh host (what a pane remount does).
    const host2 = document.createElement("div");
    host2.style.width = "640px";
    host2.style.height = "320px";
    document.body.appendChild(host2);
    try {
      render(<TerminalView terminalId={TID} />, { container: host2 });
      await settle();
      expect(
        document.activeElement?.classList.contains("xterm-helper-textarea"),
        "re-activating the terminal must re-focus it",
      ).toBe(true);
    } finally {
      host2.remove();
    }
  });
});
