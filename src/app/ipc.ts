/**
 * IPC — typed wrappers over the Rust command surface (ARCHITECTURE §2.4).
 *
 * This module is the ONLY place `invoke()` is called for the terminal
 * lifecycle. It carries the *control* plane (open/write/resize/close) and hands
 * the caller the *hot* plane handle (`Channel<ArrayBuffer>`), which Rust fills
 * with coalesced raw PTY bytes.
 *
 * Governing invariant (ARCHITECTURE §1): the bytes that arrive on `onOutput`
 * must never enter React state or the Zustand store — they go straight to
 * `xterm.write()`. See `features/terminal/TerminalRegistry.ts`, the single
 * landing site.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { TerminalId, TerminalMeta } from "./types";

export { Channel };

/**
 * A raw-bytes frame as it can arrive from a Tauri `Channel`.
 *
 * Rust sends `InvokeResponseBody::Raw`, which normally surfaces as an
 * `ArrayBuffer`. Under the postMessage IPC fallback (and for very small
 * frames) Tauri may hand over a plain number array instead, so consumers must
 * normalize — see `toBytes()`.
 */
export type RawFrame = ArrayBuffer | Uint8Array | number[];

/**
 * Brand check rather than `instanceof`: this is an IPC boundary, and
 * `instanceof` compares against *this* realm's constructor. A buffer minted in
 * another realm is still an ArrayBuffer, and misreading one here would drop
 * terminal output.
 */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/**
 * Normalize whatever a raw `Channel` frame arrived as into bytes.
 *
 * Ordered by likelihood, and deliberately total: an unrecognized shape throws
 * rather than degrading. The tempting `Uint8Array.from(frame)` catch-all is a
 * trap — handed an ArrayBuffer it returns an *empty* array instead of failing,
 * so a frame shape we did not anticipate would silently swallow PTY output
 * instead of surfacing a bug.
 */
export function toBytes(frame: RawFrame): Uint8Array {
  // Widened to `unknown` on purpose. RawFrame describes what Tauri is *meant*
  // to hand us, and narrowing against it would collapse the guards below to
  // `never` — but the whole job of this function is to be right when the value
  // does not match the declared type.
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

/**
 * `terminal_write` — keystrokes to the child's stdin.
 *
 * Tauri's IPC serializer turns a nested `Uint8Array` into a JSON number array,
 * which deserializes into Rust's `Vec<u8>`. Keystroke volume is tiny, so the
 * JSON path is fine here; the *output* firehose is the one that must be raw,
 * and it is (see `onOutput`).
 */
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

/**
 * `terminal_reattach` — re-subscribe to a PTY that outlived a webview reload.
 *
 * The Rust supervisor and its PTYs (with the running `claude`s) survive a
 * full webview reload; only the JS store is reset. This swaps in a fresh output
 * `Channel`, replays the scrollback ring, and resize-nudges so a TUI (claude /
 * Ink) repaints. Distinct from `terminal_open`, which *errors* on an id that is
 * already open. A live PTY returns `status: "live"`; one whose child already
 * exited returns `Ok` with `status: "exited"`; an unknown id rejects.
 */
export function reattachTerminal(
  terminalId: TerminalId,
  onOutput: Channel<ArrayBuffer>,
): Promise<TerminalMeta> {
  return invoke<TerminalMeta>("terminal_reattach", { terminalId, onOutput });
}
