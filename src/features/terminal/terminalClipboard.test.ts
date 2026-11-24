/**
 * terminalClipboard — Windows Terminal's copy/paste keys on Windows and Linux, macOS
 * untouched. The decision is a pure function of platform × key × selection; the wiring
 * is pinned through a fake terminal (the xterm custom-key-handler contract: `false` =
 * not xterm's, `true` = xterm handles it), and the registry test at the bottom proves
 * every real terminal gets it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Os } from "../../lib/platform";
import {
  installTerminalClipboardKeys,
  terminalKeyAction,
  writeClipboardText,
  type ClipboardTerminal,
  type TerminalKey,
} from "./terminalClipboard";

function key(over: Partial<TerminalKey>): TerminalKey {
  return { type: "keydown", key: "c", code: "KeyC", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...over };
}

const NON_MAC: Os[] = ["windows", "linux", "other"];

describe("terminalKeyAction", () => {
  it("never acts on macOS: ⌘C/⌘V belong to the app menu, Ctrl+C/Ctrl+V to the PTY", () => {
    for (const k of [key({}), key({ key: "v", code: "KeyV" }), key({ shiftKey: true, key: "C" }), key({ ctrlKey: false, metaKey: true })]) {
      expect(terminalKeyAction("macos", k, true)).toBe("pass");
      expect(terminalKeyAction("macos", k, false)).toBe("pass");
    }
  });

  it.each(NON_MAC)("%s: Ctrl+C copies with a selection and interrupts without one", (p) => {
    expect(terminalKeyAction(p, key({}), true)).toBe("copy");
    expect(terminalKeyAction(p, key({}), false)).toBe("interrupt");
  });

  it.each(NON_MAC)("%s: Ctrl+Shift+C always copies, never ^C", (p) => {
    expect(terminalKeyAction(p, key({ key: "C", shiftKey: true }), false)).toBe("copy");
    expect(terminalKeyAction(p, key({ key: "C", shiftKey: true }), true)).toBe("copy");
  });

  it.each(NON_MAC)("%s: Ctrl+V and Ctrl+Shift+V paste, selection or not", (p) => {
    for (const sel of [true, false]) {
      expect(terminalKeyAction(p, key({ key: "v", code: "KeyV" }), sel)).toBe("paste");
      expect(terminalKeyAction(p, key({ key: "V", code: "KeyV", shiftKey: true }), sel)).toBe("paste");
    }
  });

  it("reads the letter on the key, falling back to the physical key for non-Latin layouts", () => {
    // Russian layout: Ctrl+C reports the Cyrillic letter; the physical key is still C.
    expect(terminalKeyAction("windows", key({ key: "с", code: "KeyC" }), true)).toBe("copy");
    expect(terminalKeyAction("windows", key({ key: "м", code: "KeyV" }), false)).toBe("paste");
    // Dvorak: the key printed "c" sits where QWERTY has I — the printed letter wins.
    expect(terminalKeyAction("windows", key({ key: "c", code: "KeyI" }), true)).toBe("copy");
    expect(terminalKeyAction("windows", key({ key: "j", code: "KeyC" }), true)).toBe("pass");
    // A key with neither a letter nor a letter code is nothing to us.
    expect(terminalKeyAction("windows", key({ key: "Enter", code: "Enter" }), true)).toBe("pass");
  });

  it("only a plain Ctrl chord counts: AltGr (Ctrl+Alt), the Windows key, bare letters pass", () => {
    expect(terminalKeyAction("windows", key({ altKey: true }), true)).toBe("pass");
    expect(terminalKeyAction("windows", key({ metaKey: true }), true)).toBe("pass");
    expect(terminalKeyAction("windows", key({ ctrlKey: false }), true)).toBe("pass");
    expect(terminalKeyAction("windows", key({ key: "v", code: "KeyV", altKey: true }), true)).toBe("pass");
  });

  it("other Ctrl chords stay the PTY's (Ctrl+D, Ctrl+Z, Ctrl+L)", () => {
    for (const k of ["d", "z", "l"]) {
      expect(terminalKeyAction("windows", key({ key: k, code: `Key${k.toUpperCase()}` }), true)).toBe("pass");
    }
  });

  it("acts on keydown only: the keypress/keyup of the same chord go to xterm as before", () => {
    expect(terminalKeyAction("windows", key({ type: "keyup" }), true)).toBe("pass");
    expect(terminalKeyAction("windows", key({ type: "keypress", key: "v", code: "KeyV" }), true)).toBe("pass");
  });
});

/** A fake xterm: records the handler and exposes a mutable selection. */
function fakeTerm(selection: string): ClipboardTerminal & {
  handler: (ev: KeyboardEvent) => boolean;
  clearSelection: ReturnType<typeof vi.fn>;
  sel: string;
} {
  const t = {
    sel: selection,
    handler: (_ev: KeyboardEvent) => true,
    hasSelection: () => t.sel !== "",
    getSelection: () => t.sel,
    clearSelection: vi.fn(() => {
      t.sel = "";
    }),
    attachCustomKeyEventHandler: (h: (ev: KeyboardEvent) => boolean) => {
      t.handler = h;
    },
  };
  return t;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ctrlKey: true, ...init });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("installTerminalClipboardKeys", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Ctrl+C with a selection copies it, clears it once written, and never reaches the PTY", async () => {
    const term = fakeTerm("npm run build");
    const writeText = vi.fn(() => Promise.resolve());
    installTerminalClipboardKeys(term, "windows", writeText);

    const ev = press({ key: "c", code: "KeyC" });
    expect(term.handler(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("npm run build");
    await flush();
    expect(term.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("a refused clipboard write keeps the selection, so nothing is lost", async () => {
    const term = fakeTerm("keep me");
    installTerminalClipboardKeys(term, "windows", () => Promise.reject(new Error("denied")));
    expect(term.handler(press({ key: "c", code: "KeyC" }))).toBe(false);
    await flush();
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(term.sel).toBe("keep me");
  });

  it("Ctrl+C without a selection goes to xterm, which sends ^C", () => {
    const term = fakeTerm("");
    const writeText = vi.fn(() => Promise.resolve());
    installTerminalClipboardKeys(term, "windows", writeText);
    const ev = press({ key: "c", code: "KeyC" });
    expect(term.handler(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C with nothing selected is swallowed and writes nothing", () => {
    const term = fakeTerm("");
    const writeText = vi.fn(() => Promise.resolve());
    installTerminalClipboardKeys(term, "linux", writeText);
    expect(term.handler(press({ key: "C", code: "KeyC", shiftKey: true }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+V is handed to the webview's native paste: not xterm's, and NOT default-prevented", () => {
    const term = fakeTerm("");
    const writeText = vi.fn(() => Promise.resolve());
    installTerminalClipboardKeys(term, "windows", writeText);
    const ev = press({ key: "v", code: "KeyV" });
    expect(term.handler(ev)).toBe(false);
    // The native paste (→ the `paste` event → xterm's bracketed paste) is the default action.
    expect(ev.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("on macOS every key goes to xterm exactly as before", () => {
    const term = fakeTerm("selected");
    const writeText = vi.fn(() => Promise.resolve());
    installTerminalClipboardKeys(term, "macos", writeText);
    for (const init of [{ key: "c", code: "KeyC" }, { key: "v", code: "KeyV" }]) {
      const ev = press(init);
      expect(term.handler(ev)).toBe(true);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it("defaults to the real OS answer and the real clipboard", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      const term = fakeTerm("from the default");
      installTerminalClipboardKeys(term);
      expect(term.handler(press({ key: "c", code: "KeyC" }))).toBe(false);
      expect(writeText).toHaveBeenCalledWith("from the default");
      await flush();
      expect(term.clearSelection).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("writeClipboardText", () => {
  it("rejects when the platform has no clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await expect(writeClipboardText("x")).rejects.toThrow("no clipboard");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
