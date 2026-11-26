/** Under mouse tracking xterm gives the wheel to the app; on the normal buffer it must still scroll
 * scrollback, while the alternate buffer keeps it the app's. Real CDP wheel events: synthetic
 * ones lack `wheelDeltaY`, which xterm's `StandardWheelEvent` reads. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

/** DECSET: enable button-event mouse tracking (?1002) + SGR encoding (?1006). */
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
/** DECSET ?1049h: switch to the alternate screen buffer (full-screen TUIs). */
const ENTER_ALT = "\x1b[?1049h";

async function settle(ms = 250): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("terminal scrollback — reachable by wheel under mouse tracking", () => {
  const TID = asTerminalId("01J0SCROLLBACK0000000000");
  let ipc: TauriMock;
  let host: HTMLDivElement;
  let pty: ReturnType<TauriMock["channel"]>;
  let appWrites: number;

  beforeEach(() => {
    host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "300px";
    document.body.appendChild(host);

    appWrites = 0;
    ipc = installTauriMock();
    pty = ipc.channel();
    ipc
      .handle("terminal_open", (a) => {
        pty.capture(a.onOutput);
        return { id: a.terminalId, kind: "terminal", title: "sh", cwd: a.cwd, cols: a.cols, rows: a.rows, status: "live" };
      })
      // A mouse event forwarded to the app arrives here as a keystroke write.
      .handle("terminal_write", () => {
        appWrites++;
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

  /** Render, and fill the buffer past the viewport so there is scrollback. */
  async function terminalWithScrollback() {
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();
    const term = getTerminal(TID)!;
    let out = "";
    for (let i = 0; i < 200; i++) out += `line-${i}\r\n`;
    pty.send(out);
    await settle();
    expect(term.buffer.active.baseY, "sanity: scrollback must be populated").toBeGreaterThan(50);
    return term;
  }

  const screen = () => host.querySelector(".xterm-screen") as HTMLElement;

  it("scrolls scrollback on wheel-up even with mouse tracking on (the fix)", async () => {
    const term = await terminalWithScrollback();

    pty.send(ENABLE_MOUSE);
    await settle();
    expect(term.modes.mouseTrackingMode, "mouse tracking must be active").not.toBe("none");
    expect(term.buffer.active.type).toBe("normal");

    term.scrollToBottom();
    const before = term.buffer.active.viewportY;
    appWrites = 0;

    await userEvent.wheel(screen(), { direction: "up", times: 5 } as unknown as { delta: { y: number } });
    await settle(150);

    // Scrollback moved up — scroll-up works.
    expect(term.buffer.active.viewportY, "wheel-up must scroll the scrollback").toBeLessThan(before);
    // And the wheel was NOT also forwarded to the app: on the normal buffer the
    // scroll belongs to the terminal, so the app sees nothing.
    expect(appWrites, "wheel must not leak to the app on the normal buffer").toBe(0);
  });

  it("still scrolls with the wheel when no app has grabbed the mouse", async () => {
    // Guard the untouched path: a plain shell must behave exactly as before.
    const term = await terminalWithScrollback();
    expect(term.modes.mouseTrackingMode).toBe("none");

    term.scrollToBottom();
    const before = term.buffer.active.viewportY;
    await userEvent.wheel(screen(), { direction: "up", times: 5 } as unknown as { delta: { y: number } });
    await settle(150);

    expect(term.buffer.active.viewportY).toBeLessThan(before);
  });

  it("leaves the wheel to the app on the alternate buffer (claude's TUI keeps it)", async () => {
    const term = await terminalWithScrollback();

    pty.send(ENTER_ALT + ENABLE_MOUSE);
    await settle();
    expect(term.buffer.active.type).toBe("alternate");

    appWrites = 0;
    await userEvent.wheel(screen(), { direction: "up", times: 3 } as unknown as { delta: { y: number } });
    await settle(150);

    // The app received the wheel (as mouse events) — its own scrolling still
    // works. Stealing it here would break full-screen interaction.
    expect(appWrites, "the app must still receive the wheel on the alt buffer").toBeGreaterThan(0);
  });
});
