/** Typed wrappers over the terminal commands (ARCHITECTURE §2.4); the only `invoke()` site for
 * the terminal lifecycle. Output bytes never enter React or the store: they go straight to
 * `xterm.write()` in `features/terminal/TerminalRegistry.ts` (ARCHITECTURE §1). */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { TerminalId, TerminalMeta } from "./types";

export { Channel };

/** A raw `Channel` frame: usually an `ArrayBuffer`, but the postMessage IPC fallback (and very
 * small frames) may give a number array, so normalize with `toBytes()`. */
export type RawFrame = ArrayBuffer | Uint8Array | number[];

/** Brand check, not `instanceof`: a buffer from another realm is still an ArrayBuffer, and
 * misreading one would drop terminal output. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/** Normalize a raw `Channel` frame into bytes; an unknown shape throws. Never `Uint8Array.from`
 * as a catch-all: given an ArrayBuffer it returns an empty array, silently dropping output. */
export function toBytes(frame: RawFrame): Uint8Array {
  // `unknown` on purpose: narrowing against RawFrame would collapse the guards below to `never`,
  // and this must be right when the value does not match the declared type.
  const value: unknown = frame;

  // `ArrayBuffer.isView` is a brand check, so it holds across realms and covers
  // Uint8Array plus every other view.
  if (ArrayBuffer.isView(value)) {
    // Same-realm Uint8Array: hand it straight back. This is the hot path — it
    // runs on every PTY flush of every terminal.
    if (value instanceof Uint8Array) return value;
    // Any other view (or a cross-realm one): re-view the same memory, honouring
    // byteOffset/byteLength. Still zero-copy.
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError(
    `Unsupported terminal frame: ${Object.prototype.toString.call(value)}. ` +
      `Expected ArrayBuffer, a typed-array view, or number[].`,
  );
}

export interface OpenTerminalOptions {
  terminalId: TerminalId;
  /** Defaults to the user's `$SHELL` on the Rust side when omitted. */
  program?: string;
  args?: string[];
  /** Absolute path. */
  cwd: string;
  rows: number;
  cols: number;
  /** Hot plane: Rust pushes coalesced raw PTY bytes here. */
  onOutput: Channel<ArrayBuffer>;
}

/** `terminal_open` — allocate a PTY, spawn the child, start the byte pump. */
export function openTerminal(opts: OpenTerminalOptions): Promise<TerminalMeta> {
  return invoke<TerminalMeta>("terminal_open", {
    terminalId: opts.terminalId,
    program: opts.program ?? null,
    args: opts.args ?? [],
    cwd: opts.cwd,
    rows: opts.rows,
    cols: opts.cols,
    onOutput: opts.onOutput,
  });
}

/** `terminal_write`: Tauri serializes the `Uint8Array` to a JSON number array (Rust `Vec<u8>`);
 * fine for keystroke volume, while output uses the raw channel (`onOutput`). */
export function writeTerminal(terminalId: TerminalId, data: Uint8Array): Promise<void> {
  return invoke<void>("terminal_write", { terminalId, data });
}

/** `terminal_resize` — SIGWINCH the child. Debounce ~50ms UI-side. */
export function resizeTerminal(terminalId: TerminalId, rows: number, cols: number): Promise<void> {
  return invoke<void>("terminal_resize", { terminalId, rows, cols });
}

/** `terminal_close` — kill the child, tear down the PTY and its tailer. */
export function closeTerminal(terminalId: TerminalId): Promise<void> {
  return invoke<void>("terminal_close", { terminalId });
}

/** `terminal_reattach`: after a webview reload, swap in a fresh output Channel, replay scrollback,
 * resize-nudge so a TUI repaints (`terminal_open` errors on an open id). Resolves `live` or
 * `exited`; an unknown id rejects. */
export function reattachTerminal(
  terminalId: TerminalId,
  onOutput: Channel<ArrayBuffer>,
): Promise<TerminalMeta> {
  return invoke<TerminalMeta>("terminal_reattach", { terminalId, onOutput });
}
