/** Windows Terminal copy/paste on Windows and Linux; macOS untouched (menu accelerators). No OS
 * permission prompt: paste is the webview's native paste (`clipboard.readText()` prompts in
 * WebView2/WKWebView); copy uses `navigator.clipboard.writeText()` (a gesture write never does). */

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

/** `ev.key` (the letter printed on the user's layout), else the physical key for non-Latin
 * layouts (Russian Ctrl+C has `key === "с"`), as Windows Terminal does. */
function chordLetter(ev: TerminalKey): string {
  const key = ev.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const m = /^Key([A-Z])$/.exec(ev.code);
  return m ? m[1].toLowerCase() : "";
}

/** Pure. Only a plain Ctrl chord counts: AltGr is Ctrl+Alt on Windows; Meta is Windows/Super. */
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

/** `platform`/`writeText` are injectable for tests. Handler returns follow xterm: `false` = not
 * xterm's (neither sent to the PTY nor cancelled), `true` = xterm handles it. */
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
