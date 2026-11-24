/**
 * Self-test for the Tauri IPC mock harness.
 *
 * This file exists because `tauri-mock.ts` is *infrastructure other suites will
 * build on* (the M1 terminal suite, the M3 fan-out suite). A harness that
 * silently half-works is worse than none: it yields tests that pass for the
 * wrong reason. So it is driven here against the REAL `@tauri-apps/api/core` —
 * real `invoke`, real `Channel`, real callback registry. Nothing about the
 * boundary under test is itself stubbed.
 *
 * Deliberately depends on nothing but `@tauri-apps/api` and `app/types` (THE
 * contract): the harness must stay provably green independently of the terminal
 * feature and `app/ipc.ts`, which are tested by the terminal feature's
 * own suite. The commands and payload shapes used below are the canonical ones
 * from ARCHITECTURE §2.4.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { asTerminalId, type TerminalMeta } from "../app/types";
import { channelIdOf, installTauriMock, type TauriMock } from "./tauri-mock";

let ipc: TauriMock | undefined;

const install = () => {
  ipc = installTauriMock();
  return ipc;
};

afterEach(() => {
  ipc?.reset();
  ipc = undefined;
});

const terminalId = asTerminalId("term-1");

const meta = (): TerminalMeta => ({
  id: terminalId,
  kind: "terminal",
  title: "gazelle",
  cwd: "/w/gazelle",
  cols: 80,
  rows: 24,
  status: "live",
});

/** What TerminalRegistry does with a frame, minus xterm. */
const decode = (frame: unknown): string => {
  const bytes = ArrayBuffer.isView(frame)
    ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    : frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : Uint8Array.from(frame as number[]);
  return new TextDecoder().decode(bytes);
};

describe("installTauriMock — control plane", () => {
  it("routes invoke() to the registered handler", async () => {
    install().handle("add", (args) => (args.a as number) + (args.b as number));
    await expect(invoke("add", { a: 12, b: 15 })).resolves.toBe(27);
  });

  it("awaits a handler that returns a promise", async () => {
    install().handle("slow", async () => "done");
    await expect(invoke("slow")).resolves.toBe("done");
  });

  it("rejects an unmocked command loudly rather than resolving undefined", async () => {
    install();
    // A silent `undefined` is how a test ends up passing for the wrong reason.
    await expect(invoke("terminal_open")).rejects.toThrow(
      /Unmocked Tauri command "terminal_open"/,
    );
  });

  it("records every call, in order, with its args", async () => {
    const mock = install().handle("terminal_write", () => null);
    await invoke("terminal_write", { terminalId, data: [108] });
    await invoke("terminal_write", { terminalId, data: [115] });

    expect(mock.calls("terminal_write")).toHaveLength(2);
    expect(mock.calls()).toHaveLength(2);
    expect(mock.lastCall("terminal_write")).toMatchObject({ data: [115] });
    expect(mock.lastCall("never_called")).toBeUndefined();
  });

  it("returns typed metadata for a control-plane command", async () => {
    install().handle("terminal_open", () => meta());
    const opened = await invoke<TerminalMeta>("terminal_open", {
      terminalId,
      cwd: "/w/gazelle",
      rows: 24,
      cols: 80,
    });
    expect(opened).toMatchObject({ id: terminalId, title: "gazelle", status: "live" });
  });

  it("reset() clears handlers, calls and the injected internals", async () => {
    const mock = install().handle("ping", () => "pong");
    await invoke("ping");
    expect(mock.calls()).toHaveLength(1);

    mock.reset();

    expect(mock.calls()).toEqual([]);
    // clearMocks() removed __TAURI_INTERNALS__.invoke, so we are back to the
    // "no Tauri here" baseline rather than leaking state into the next test.
    await expect(invoke("ping")).rejects.toThrow();
    ipc = undefined;
  });
});

describe("channelIdOf", () => {
  it("parses the serialized __CHANNEL__ token", () => {
    expect(channelIdOf("__CHANNEL__:42")).toBe(42);
  });

  it("accepts a Channel instance handed over un-serialized", () => {
    install();
    const channel = new Channel<ArrayBuffer>();
    // mockIPC hands the args object straight to the handler without running
    // Tauri's serializer, so a Channel arrives as an instance, not a token.
    expect(channelIdOf(channel)).toBe(channel.id);
  });

  it("throws a useful error on anything else", () => {
    expect(() => channelIdOf("nope")).toThrow(/Not a Tauri Channel handle/);
    expect(() => channelIdOf(undefined)).toThrow(/Not a Tauri Channel handle/);
  });
});

describe("ChannelDriver — the streaming PTY plane", () => {
  /**
   * The canonical `terminal_open` shape (ARCHITECTURE §2.4): the caller mints a
   * `Channel<ArrayBuffer>` and Rust pushes coalesced raw PTY bytes into it.
   */
  function openWithChannel() {
    const mock = install();
    const pty = mock.channel();
    mock.handle("terminal_open", (args) => {
      pty.capture(args.onOutput);
      return meta();
    });

    const frames: string[] = [];
    const onOutput = new Channel<ArrayBuffer>();
    // Exactly what TerminalRegistry does: bytes land here and go straight to
    // term.write(), never into React or the store (ARCHITECTURE §1).
    onOutput.onmessage = (buf) => frames.push(decode(buf));

    const opened = invoke<TerminalMeta>("terminal_open", {
      terminalId,
      cwd: "/w/gazelle",
      rows: 24,
      cols: 80,
      onOutput,
    });
    return { mock, pty, frames, opened };
  }

  it("delivers pushed bytes to the Channel's onmessage", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;

    pty.send("hello\r\n");

    expect(frames).toEqual(["hello\r\n"]);
  });

  it("hands over a real ArrayBuffer, as InvokeResponseBody::Raw surfaces as", async () => {
    const { pty, opened } = openWithChannel();
    await opened;
    const received: unknown[] = [];
    // Re-point onmessage to inspect the raw frame type rather than decode it.
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => received.push(buf);
    pty.capture(channel);

    pty.send("x");

    expect(received[0]).toBeInstanceOf(ArrayBuffer);
  });

  it("preserves order across many frames", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;

    // Channel buffers any frame whose index runs ahead of the next expected
    // one; a driver that did not track the index would deliver only the first
    // and silently queue the rest.
    for (const chunk of ["a", "b", "c", "d", "e"]) pty.send(chunk);

    expect(frames.join("")).toBe("abcde");
    expect(frames).toHaveLength(5);
  });

  it("accepts string, Uint8Array and ArrayBuffer payloads", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;

    pty.send("x");
    pty.send(new TextEncoder().encode("y"));
    pty.send(new TextEncoder().encode("z").buffer as ArrayBuffer);

    expect(frames.join("")).toBe("xyz");
  });

  it("gives the frame its own memory, as a real IPC crossing would", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;

    const source = new TextEncoder().encode("abc");
    pty.send(source);
    source.fill(0); // mutating the caller's array must not corrupt the frame

    expect(frames).toEqual(["abc"]);
  });

  it("sendRaw() can emulate the number[] postMessage fallback", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;

    // Tauri may hand over a plain number array instead of an ArrayBuffer under
    // the postMessage IPC fallback; sendRaw lets a consumer test that branch.
    pty.sendRaw([104, 105]);

    expect(frames).toEqual(["hi"]);
  });

  it("close() ends the stream and releases the callback", async () => {
    const { pty, frames, opened } = openWithChannel();
    await opened;
    pty.send("bye");

    pty.close();

    // Rust dropped the sender; the callback is unregistered, so later frames are
    // not delivered (Tauri warns rather than throwing).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pty.sendRaw(new ArrayBuffer(1));
    expect(frames).toEqual(["bye"]);
    warn.mockRestore();
  });

  it("gives a clear error when used before its channel is captured", () => {
    const pty = install().channel();
    expect(() => pty.send("x")).toThrow(/ChannelDriver has no channel yet/);
    expect(() => pty.channelId).toThrow(/ChannelDriver has no channel yet/);
  });

  it("supports several independent channels at once (a terminal fleet)", async () => {
    const mock = install();
    const a = mock.channel();
    const b = mock.channel();
    const seen: Record<string, string[]> = { a: [], b: [] };

    mock.handle("terminal_open", (args) => {
      (args.cwd === "/w/a" ? a : b).capture(args.onOutput);
      return meta();
    });

    for (const key of ["a", "b"] as const) {
      const onOutput = new Channel<ArrayBuffer>();
      onOutput.onmessage = (buf) => seen[key].push(decode(buf));
      await invoke("terminal_open", {
        terminalId: asTerminalId(key),
        cwd: `/w/${key}`,
        rows: 24,
        cols: 80,
        onOutput,
      });
    }

    a.send("from-a");
    b.send("from-b");

    // Each PTY's bytes reach only its own terminal — no cross-talk.
    expect(seen.a).toEqual(["from-a"]);
    expect(seen.b).toEqual(["from-b"]);
  });

  it("throws a helpful error if a driver is used with no mock installed", () => {
    const mock = installTauriMock();
    const pty = mock.channel();
    const channel = new Channel<ArrayBuffer>();
    pty.capture(channel);
    mock.reset(); // uninstall

    expect(() => pty.send("x")).toThrow(/Tauri IPC mock is not installed/);
  });
});
