/**
 * terminalClipboard — copy and paste in the terminal on Windows and Linux, the Windows
 * Terminal way (platform-native: a native behaviour per OS, macOS untouched).
 *
 * macOS needs nothing from here: ⌘C / ⌘V are the app menu's Copy / Paste accelerators,
 * which fire the webview's own `copy` / `paste` DOM events, and xterm already handles
 * both. Ctrl+C stays the interrupt key there, as it always was.
 *
 * Windows and Linux have no such menu, so xterm saw Ctrl+C as ^C and Ctrl+V as ^V:
 * nothing could be copied and cmd could not paste. Windows Terminal's convention is:
 *   - Ctrl+C copies WHEN THERE IS A SELECTION (and clears it); otherwise it is ^C.
 *   - Ctrl+V pastes.
 *   - Ctrl+Shift+C / Ctrl+Shift+V always copy / paste (never ^C / ^V).
 *
 * How each half reaches the clipboard without an OS permission prompt (no OS permission
 * may be required):
 *   - PASTE is the webview's own: the key handler tells xterm "not yours" WITHOUT
 *     `preventDefault()`, so the webview performs its native paste into xterm's textarea,
 *     the `paste` event fires, and xterm's handler runs the same `paste()` routine as
 *     `term.paste()` — line endings to CR, bracketed-paste markers when the program asked
 *     for them. No `navigator.clipboard.readText()`: in WebView2 that is a permission
 *     request (wry only auto-allows it when the window is built with `clipboard: true`)
 *     and in WKWebView it is a "Paste" callout — exactly the prompt that is forbidden.
 *   - COPY writes the terminal's selection with `navigator.clipboard.writeText()`, the
 *     route every copy button in this app already takes (a user-gesture write never
 *     prompts). A refused write keeps the selection, so nothing is lost.
 */

import { os, type Os } from "../../lib/platform";

/** What one key press means to the terminal. `interrupt` and `pass` both go to xterm. */
export type TerminalKeyAction = "copy" | "paste" | "interrupt" | "pass";

/** The keyboard fields the decision reads — a structural subset of KeyboardEvent. */
export interface TerminalKey {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The letter a chord names: `ev.key` (so Dvorak/AZERTY users press the letter printed
 * on their key), falling back to the physical key when the layout's letter is not Latin
 * (a Russian layout's Ctrl+C has `key === "с"` but `code === "KeyC"`) — what Windows
 * Terminal does too.
 */
function chordLetter(ev: TerminalKey): string {
  const key = ev.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const m = /^Key([A-Z])$/.exec(ev.code);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Decide what a key press does: platform × key × "is anything selected?". Pure.
 *
 * Only a plain Ctrl chord counts: Alt is excluded because AltGr IS Ctrl+Alt on Windows
 * (a European layout types characters with it), and Meta is the Windows/Super key.
 */
export function terminalKeyAction(platform: Os, ev: TerminalKey, hasSelection: boolean): TerminalKeyAction {
  if (platform === "macos") return "pass";
  if (ev.type !== "keydown") return "pass";
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return "pass";
  const letter = chordLetter(ev);
  if (letter === "v") return "paste";
  if (letter !== "c") return "pass";
  if (ev.shiftKey || hasSelection) return "copy";
  return "interrupt";
}

/** The slice of xterm's `Terminal` this needs (a structural type, so tests can fake it). */
export interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  attachCustomKeyEventHandler(handler: (ev: KeyboardEvent) => boolean): void;
}

/** Write text to the system clipboard; rejects when the platform has no clipboard API. */
export function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard) return Promise.reject(new Error("no clipboard"));
  return navigator.clipboard.writeText(text);
}

/**
 * Install the copy/paste keys on one terminal. `platform` and `writeText` are injectable
 * for tests; production passes neither.
 *
 * The handler's return value is xterm's contract: `false` = "not yours" (xterm neither
 * sends the key to the PTY nor cancels it), `true` = xterm handles it as before.
 */
export function installTerminalClipboardKeys(
  term: ClipboardTerminal,
  platform: Os = os(),
  writeText: (text: string) => Promise<void> = writeClipboardText,
): void {
  term.attachCustomKeyEventHandler((ev) => {
    switch (terminalKeyAction(platform, ev, term.hasSelection())) {
      case "copy": {
        // Ours entirely: no ^C to the PTY, and no webview default (Ctrl+Shift+C is
        // "inspect element" wherever devtools are on).
        ev.preventDefault();
        const text = term.hasSelection() ? term.getSelection() : "";
        if (text) {
          void writeText(text).then(
            () => term.clearSelection(),
            () => undefined, // refused: keep the selection so nothing is lost
          );
        }
        return false;
      }
      case "paste":
        // Deliberately NO preventDefault: the webview's native paste is what delivers
        // the text (to xterm's `paste` handler) — see the header.
        return false;
      default:
        return true;
    }
  });
}
