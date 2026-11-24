/**
 * Reusable mock of the Tauri IPC boundary.
 *
 * There is no Rust process behind a Vitest run, so `invoke()` would reject with
 * "window.__TAURI_INTERNALS__ is undefined". `@tauri-apps/api/mocks` solves the
 * *control* plane by installing a fake `__TAURI_INTERNALS__` — it works fine on
 * v2 under jsdom (verified; it only needs `window.crypto.getRandomValues`).
 *
 * The *hot* plane needs more. Our PTY bytes do not come back as a command's
 * return value: they stream in over a `tauri::ipc::Channel` (ARCHITECTURE §2.4,
 * `src/app/ipc.ts`). The JS `Channel` is constructed client-side, registers a
 * callback in `__TAURI_INTERNALS__.callbacks`, and serializes into the invoke
 * args as the string `"__CHANNEL__:<id>"`. Rust later pushes frames by invoking
 * that callback id. `mockIPC` alone gives you no way to drive that — hence
 * `ChannelDriver` below.
 *
 * ── Usage: control plane ─────────────────────────────────────────────────────
 *
 *   const ipc = installTauriMock();
 *   ipc.handle("terminal_open", (args) => ({ id: args.terminalId, ... }));
 *   afterEach(() => ipc.reset());
 *
 *   expect(ipc.calls("terminal_write")).toHaveLength(1);
 *
 * ── Usage: streaming Channel (the PTY firehose) ──────────────────────────────
 *
 *   const ipc = installTauriMock();
 *   const pty = ipc.channel();                 // captures the next Channel
 *   ipc.handle("terminal_open", (args) => {
 *     pty.capture(args.onOutput);              // "__CHANNEL__:<id>"
 *     return meta;
 *   });
 *
 *   await openTerminal({ ..., onOutput: new Channel<ArrayBuffer>() });
 *   pty.send(new TextEncoder().encode("hello\r\n"));  // → xterm.write()
 *   pty.close();                                       // Rust dropped the tx
 *
 * `send()` accepts bytes and delivers a real `ArrayBuffer`, matching what
 * `InvokeResponseBody::Raw` surfaces as (see `toBytes()` in `app/ipc.ts` for
 * the number[] fallback the postMessage path can produce — `sendRaw()` lets a
 * test exercise that branch too). Frame ordering is handled: `Channel` only
 * dispatches a message when its index matches the next expected one, so the
 * driver tracks and increments the index for you.
 */

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

/** One recorded `invoke()` call. */
export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** What a mocked command returns. May be a value or a promise. */
export type IpcHandler = (args: Record<string, unknown>) => unknown;

/**
 * Minimal shape of the mock internals we reach into. Not exported by the Tauri
 * API's public types (they describe the real bridge), so declared here.
 */
interface TauriMockInternals {
  runCallback?: (id: number, data: unknown) => void;
  callbacks?: Map<number, (data: unknown) => void>;
}

function internals(): TauriMockInternals {
  const win = window as unknown as { __TAURI_INTERNALS__?: TauriMockInternals };
  const found = win.__TAURI_INTERNALS__;
  if (!found?.runCallback) {
    throw new Error(
      "Tauri IPC mock is not installed — call installTauriMock() first.",
    );
  }
  return found;
}

/** Parse the `"__CHANNEL__:<id>"` token a serialized `Channel` becomes. */
export function channelIdOf(serialized: unknown): number {
  if (typeof serialized === "string") {
    const m = /^__CHANNEL__:(\d+)$/.exec(serialized);
    if (m) return Number(m[1]);
  }
  // A Channel instance handed over un-serialized (e.g. read straight off the
  // options object rather than through invoke's serializer).
  if (serialized && typeof serialized === "object" && "id" in serialized) {
    const id = (serialized as { id: unknown }).id;
    if (typeof id === "number") return id;
  }
  throw new Error(
    `Not a Tauri Channel handle: ${JSON.stringify(serialized)}. ` +
      `Expected "__CHANNEL__:<id>" or a Channel instance.`,
  );
}

/**
 * Drives one streaming `Channel` from the "Rust" side.
 *
 * Owns the message index so frames arrive in order — `Channel` buffers any
 * frame whose index runs ahead of what it expects, so a driver that always sent
 * index 0 would deliver exactly one message and silently queue the rest.
 */
export class ChannelDriver {
  private id: number | null = null;
  private index = 0;

  /** Bind to the channel handle Rust would have received. */
  capture(serialized: unknown): this {
    this.id = channelIdOf(serialized);
    return this;
  }

  /** The registered callback id, once captured. */
  get channelId(): number {
    if (this.id === null) {
      throw new Error(
        "ChannelDriver has no channel yet — call capture(args.onOutput) " +
          "inside the command handler before sending frames.",
      );
    }
    return this.id;
  }

  /** Push one frame exactly as Rust's `Channel::send` would. */
  sendRaw(message: unknown): this {
    internals().runCallback?.(this.channelId, {
      index: this.index++,
      message,
    });
    return this;
  }

  /**
   * Push PTY bytes. Delivered as a real `ArrayBuffer` — what
   * `InvokeResponseBody::Raw` surfaces as on the happy path.
   */
  send(bytes: Uint8Array | ArrayBuffer | string): this {
    const buf =
      typeof bytes === "string"
        ? new TextEncoder().encode(bytes)
        : bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes);
    // Copy into a standalone ArrayBuffer so the frame owns its memory, the way
    // one that crossed a real IPC boundary would.
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return this.sendRaw(copy.buffer);
  }

  /** Signal end-of-stream (Rust dropped the sender), releasing the callback. */
  close(): this {
    internals().runCallback?.(this.channelId, { index: this.index++, end: true });
    return this;
  }
}

/** Handle returned by {@link installTauriMock}. */
export interface TauriMock {
  /** Register (or replace) the handler for one command. */
  handle(cmd: string, handler: IpcHandler): TauriMock;
  /** Every recorded call, or just those for `cmd`. */
  calls(cmd?: string): IpcCall[];
  /** The args of the last call to `cmd`, or undefined if never called. */
  lastCall(cmd: string): Record<string, unknown> | undefined;
  /** A fresh driver for a streaming Channel. `capture()` it in a handler. */
  channel(): ChannelDriver;
  /** Forget recorded calls + handlers, and uninstall `__TAURI_INTERNALS__`. */
  reset(): void;
}

/**
 * Install the IPC mock. Unhandled commands reject with a loud error rather than
 * resolving `undefined` — a silent `undefined` from an un-stubbed command is
 * how you get a test that passes for the wrong reason.
 */
export function installTauriMock(): TauriMock {
  const handlers = new Map<string, IpcHandler>();
  const recorded: IpcCall[] = [];

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    recorded.push({ cmd, args });
    const handler = handlers.get(cmd);
    if (!handler) {
      throw new Error(
        `Unmocked Tauri command "${cmd}". ` +
          `Add ipc.handle(${JSON.stringify(cmd)}, () => ...) to this test.`,
      );
    }
    return handler(args);
  });

  const mock: TauriMock = {
    handle(cmd, handler) {
      handlers.set(cmd, handler);
      return mock;
    },
    calls(cmd) {
      return cmd ? recorded.filter((c) => c.cmd === cmd) : [...recorded];
    },
    lastCall(cmd) {
      // Not `.at(-1)`: tsconfig targets ES2020, whose lib has no Array.at.
      const forCmd = recorded.filter((c) => c.cmd === cmd);
      return forCmd.length ? forCmd[forCmd.length - 1].args : undefined;
    },
    channel() {
      return new ChannelDriver();
    },
    reset() {
      handlers.clear();
      recorded.length = 0;
      clearMocks();
    },
  };

  return mock;
}
