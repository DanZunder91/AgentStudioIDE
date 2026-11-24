/**
 * Layer 5 — pointing at the terminal owns the keyboard, in every mode.
 *
 * ## Background
 *
 * The symptom: arrows work in a plain terminal but not inside claude. The
 * browser tier proves the *encoding* is fine — xterm forwards the correct arrow
 * bytes for ↑ in the full claude context, as long as the terminal is focused.
 * (Real claude sets NO DECCKM — verified from a PTY capture of its startup — so
 * ↑ is legacy CSI `ESC [ A`, not SS3. The one-time SS3/DECCKM theory was a red
 * herring.) The remaining hypothesis was focus loss on click under mouse
 * tracking; the actual root cause was no auto-focus at all (see
 * autoFocus.browser.test.tsx).
 *
 * ## What is actually true about focus (verified)
 *
 * xterm 6 already calls `this.focus()` unconditionally in its own mousedown
 * handler, before it reports the mouse event to the app — confirmed in the
 * bundle and by the "realistic path" tests below, which pass with OR without our
 * own handler. So on the `.xterm-screen`, focus is not lost in Chromium, and a
 * JS `term.focus()` behaves the same in any engine.
 *
 * Our added handler is therefore defence-in-depth, and the one test that pins it
 * exercises the gap it genuinely closes: a pointer-down that lands on the host
 * *outside* xterm's screen element (padding/scrollbar), which xterm's own
 * screen-level listener never sees. That test fails without our handler and
 * passes with it. The realistic-path tests are invariant guards, not proof of
 * our handler — labelled as such.
 *
 * ## Synthetic mousedown, not a real CDP click
 *
 * A real `userEvent.click` under mouse tracking deadlocked the run. We only need
 * the mousedown the fix listens for, and `document.activeElement` afterwards.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, getTerminal } from "./TerminalRegistry";
import { TerminalView } from "./TerminalView";

const ESC = 0x1b;
/**
 * claude's real terminal state, per a PTY capture of its startup: alt screen +
 * SGR mouse tracking + bracketed paste + focus reporting. Notably NO DECCKM
 * (`?1h`), so arrows are legacy CSI `ESC [ A`.
 */
const CLAUDE_CONTEXT = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h";

async function settle(ms = 120): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

function mousedown(target: Element): void {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

const textareaIsFocused = (): boolean =>
  document.activeElement?.classList.contains("xterm-helper-textarea") ?? false;

describe("terminal focus — pointing at the terminal owns the keyboard", () => {
  const TID = asTerminalId("01J0FOCUS0000000000000AA");
  let ipc: TauriMock;
  let host: HTMLDivElement;
  let pty: ReturnType<TauriMock["channel"]>;
  let writes: number[][];
  let sink: HTMLInputElement;

  beforeEach(() => {
    host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "300px";
    document.body.appendChild(host);
    sink = document.createElement("input");
    document.body.appendChild(sink);

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
    sink.remove();
  });

  async function mount() {
    render(<TerminalView terminalId={TID} />, { container: host });
    await settle();
    return getTerminal(TID)!;
  }

  // The registry's own container — the element our focus listener lives on.
  // (Both it and TerminalView's host carry data-terminal-id, so select by
  // structure: it is `.xterm`'s parent, distinct from the outer `.terminal-view`.)
  const container = (): HTMLElement => host.querySelector<HTMLElement>(".xterm")!.parentElement!;
  const screen = (): HTMLElement => host.querySelector<HTMLElement>(".xterm-screen")!;

  it("focuses on a pointer-down the host catches but xterm's screen does not (the fix)", async () => {
    // The gap our handler closes: a mousedown whose target is the host container
    // itself (padding / scrollbar gutter), not `.xterm-screen`. xterm's own
    // mousedown listener is on the screen element, so it never fires here — only
    // our capture-phase host listener does. Remove the handler and this fails.
    await mount();
    sink.focus();
    expect(textareaIsFocused()).toBe(false);

    mousedown(container());
    await settle(30);

    expect(textareaIsFocused()).toBe(true);
  });

  it("[invariant] a click on the screen focuses the textarea, plain shell", async () => {
    // Passes with or without our handler — xterm focuses on mousedown too. Kept
    // as a guard against a future regression that breaks focus on the realistic
    // click path, in either xterm or our code.
    await mount();
    sink.focus();

    mousedown(screen());
    await settle(30);

    expect(textareaIsFocused()).toBe(true);
  });

  it("[invariant] a click on the screen focuses the textarea inside claude", async () => {
    // Same guard, in the alt-buffer + mouse-tracking state where the focus
    // problem lives. (Also passes without our handler in Chromium — the point is
    // that focus is NOT lost here, which narrows the real cause to WKWebView.)
    const term = await mount();
    pty.send(CLAUDE_CONTEXT);
    await settle(40);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).not.toBe("none");

    sink.focus();
    mousedown(screen());
    await settle(30);

    expect(textareaIsFocused()).toBe(true);
  });

  it("once focused, ↑ reaches the PTY as CSI inside claude", async () => {
    // The outcome that matters: with the textarea focused, the arrow the user
    // presses forwards. claude sets no DECCKM, so it is legacy CSI `ESC [ A` —
    // byte-for-byte what claude (and a native terminal) expects for history nav.
    await mount();
    pty.send(CLAUDE_CONTEXT);
    await settle(40);

    sink.focus();
    mousedown(container());
    await settle(30);
    expect(textareaIsFocused()).toBe(true);

    writes.length = 0;
    await userEvent.keyboard("{ArrowUp}");
    await settle(50);
    expect(writes.flat()).toEqual([ESC, 0x5b, 0x41]); // ESC [ A (CSI)
  });
});
