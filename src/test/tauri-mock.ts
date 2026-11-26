/** IPC mock: `@tauri-apps/api/mocks` covers commands; `ChannelDriver` drives the hot plane, where
 * PTY bytes stream over a `Channel` sent as `"__CHANNEL__:<id>"` (ARCHITECTURE §2.4). `send()`
 * delivers a real `ArrayBuffer`; `sendRaw()` covers `toBytes()`'s number[] branch. */

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

/** One recorded `invoke()` call. */
export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** What a mocked command returns. May be a value or a promise. */
export type IpcHandler = (args: Record<string, unknown>) => unknown;

/** The mock internals we reach into; the public types describe the real bridge. */
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

/** Drives one `Channel` from the "Rust" side and owns the message index: `Channel` buffers a frame
 * whose index runs ahead, so always sending 0 would deliver one message and queue the rest. */
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

  /** Pushes PTY bytes as a real `ArrayBuffer`, as `InvokeResponseBody::Raw` surfaces them. */
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

/** Unhandled commands reject loudly: a silent `undefined` passes tests for the wrong reason. */
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
