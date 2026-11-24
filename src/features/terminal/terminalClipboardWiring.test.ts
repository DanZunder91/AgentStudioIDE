/**
 * Every real terminal the registry creates gets the Windows/Linux copy/paste keys
 * (`terminalClipboard.ts`), driven through the real xterm `Terminal` API. jsdom, like
 * `reattach.test.ts`: `ensureTerminal` builds the xterm instance without `term.open()`.
 */

import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asTerminalId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll, ensureTerminal } from "./TerminalRegistry";

const ID = asTerminalId("01J0CLIPBOARD000000000000");

function ua(userAgent: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

function ctrl(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, cancelable: true });
}

describe("TerminalRegistry — copy/paste keys", () => {
  let ipc: TauriMock;
  let attach: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ipc = installTauriMock();
    ipc
      .handle("terminal_open", (args) => ({ id: args.terminalId, kind: "terminal", title: "sh", cwd: "/", cols: 80, rows: 24, status: "live" }))
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
    attach = vi.spyOn(Terminal.prototype, "attachCustomKeyEventHandler");
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
    vi.restoreAllMocks();
  });

  function installedHandler(): (ev: KeyboardEvent) => boolean {
    ensureTerminal(ID, "/");
    expect(attach).toHaveBeenCalledTimes(1);
    return attach.mock.calls[0][0] as (ev: KeyboardEvent) => boolean;
  }

  it("on Windows, Ctrl+V goes to the webview's paste and Ctrl+C (nothing selected) to the PTY", () => {
    ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0.0.0");
    const handler = installedHandler();
    expect(handler(ctrl("v"))).toBe(false);
    expect(handler(ctrl("c"))).toBe(true);
  });

  it("on macOS, Ctrl+V still goes to the PTY, as it always did", () => {
    ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    const handler = installedHandler();
    expect(handler(ctrl("v"))).toBe(true);
  });
});
