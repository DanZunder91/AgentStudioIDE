/** The Tauri command surface (`ipc.ts`). xterm-backed classes need a real browser (jsdom has no
 * layout or WebGL), so they live in the E2E tier. `mockIPC` bypasses Tauri's serializer, so only
 * our side of `terminal_write` is pinned: we hand it a real `Uint8Array`, never pre-converted. */

import { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeTerminal,
  openTerminal,
  resizeTerminal,
  toBytes,
  writeTerminal,
} from "./ipc";
import type { RawFrame } from "./ipc";
import { asTerminalId } from "./types";
import { installTauriMock } from "../test/tauri-mock";
import type { TauriMock } from "../test/tauri-mock";
import type { TerminalMeta } from "./types";

const TID = asTerminalId("01J0TERMINAL000000000000AA");

const META: TerminalMeta = {
  id: TID,
  kind: "terminal",
  title: "sh",
  cwd: "/projects/proj",
  cols: 80,
  rows: 24,
  status: "live",
};

let ipc: TauriMock;

beforeEach(() => {
  ipc = installTauriMock();
});

afterEach(() => {
  ipc.reset();
});

/* ────────────────────────── toBytes (hot plane) ────────────────────────── */

describe("toBytes", () => {
  it("unwraps an ArrayBuffer — the happy path for InvokeResponseBody::Raw", () => {
    const src = new TextEncoder().encode("hi");
    expect(toBytes(src.buffer)).toEqual(new Uint8Array([104, 105]));
  });

  it("passes a Uint8Array through without copying", () => {
    // Zero-copy matters: this runs on every PTY flush, for every terminal.
    const src = new Uint8Array([1, 2, 3]);
    expect(toBytes(src)).toBe(src);
  });

  it("converts the number[] the postMessage IPC fallback can produce", () => {
    expect(toBytes([104, 105])).toEqual(new Uint8Array([104, 105]));
  });

  it("handles a non-Uint8Array view without dropping its byteOffset", () => {
    // Defensive branch: the type says ArrayBuffer | Uint8Array | number[], but
    // this is an IPC boundary and a view arriving with an offset would silently
    // corrupt output if we read from the start of its backing buffer.
    const backing = new Uint8Array([9, 9, 104, 105, 9]).buffer;
    const view = new DataView(backing, 2, 2);
    expect(toBytes(view as unknown as RawFrame)).toEqual(new Uint8Array([104, 105]));
  });

  it("survives an empty frame", () => {
    expect(toBytes(new ArrayBuffer(0))).toEqual(new Uint8Array([]));
  });

  it("accepts a buffer minted in another realm", () => {
    // Not hypothetical in this repo: under jsdom, TextEncoder is Node-realm, so
    // its .buffer fails `instanceof ArrayBuffer` against the page's global.
    // A realm-sensitive check here would silently yield zero bytes.
    const foreign = new TextEncoder().encode("hi").buffer;
    expect(toBytes(foreign as RawFrame)).toEqual(new Uint8Array([104, 105]));
  });

  it("throws on an unrecognized frame instead of silently yielding no bytes", () => {
    expect(() => toBytes({ 0: 104, 1: 105 } as unknown as RawFrame)).toThrow(
      /Unsupported terminal frame/,
    );
  });
});

/* ──────────────────────────── terminal_open ──────────────────────────── */

describe("openTerminal", () => {
  it("invokes terminal_open with the canonical camelCase args", async () => {
    ipc.handle("terminal_open", () => META);

    const meta = await openTerminal({
      terminalId: TID,
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: new Channel<ArrayBuffer>(),
    });

    expect(meta).toEqual(META);
    const args = ipc.lastCall("terminal_open")!;
    expect(args.terminalId).toBe(TID);
    expect(args.cwd).toBe("/projects/proj");
    expect(args.rows).toBe(24);
    expect(args.cols).toBe(80);
  });

  it("defaults program to null so Rust's Option<String> picks $SHELL", async () => {
    ipc.handle("terminal_open", () => META);
    await openTerminal({
      terminalId: TID,
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: new Channel<ArrayBuffer>(),
    });

    // null, not undefined: an omitted key is fine for serde's Option, but null
    // is explicit and works whether or not the field carries #[serde(default)].
    expect(ipc.lastCall("terminal_open")!.program).toBeNull();
    // Vec<String> cannot deserialize from null — it must be an array.
    expect(ipc.lastCall("terminal_open")!.args).toEqual([]);
  });

  it("forwards an explicit program and args", async () => {
    ipc.handle("terminal_open", () => META);
    await openTerminal({
      terminalId: TID,
      program: "claude",
      args: ["--resume"],
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: new Channel<ArrayBuffer>(),
    });

    const args = ipc.lastCall("terminal_open")!;
    expect(args.program).toBe("claude");
    expect(args.args).toEqual(["--resume"]);
  });

  it("propagates a spawn failure to the caller", async () => {
    ipc.handle("terminal_open", () => {
      throw new Error("no such cwd");
    });

    await expect(
      openTerminal({
        terminalId: TID,
        cwd: "/nope",
        rows: 24,
        cols: 80,
        onOutput: new Channel<ArrayBuffer>(),
      }),
    ).rejects.toThrow(/no such cwd/);
  });
});

/* ───────────────────── the hot plane: Channel → bytes ───────────────────── */

describe("the output Channel", () => {
  it("delivers PTY bytes to onmessage as an ArrayBuffer", async () => {
    const pty = ipc.channel();
    ipc.handle("terminal_open", (args) => {
      pty.capture(args.onOutput);
      return META;
    });

    const seen: Uint8Array[] = [];
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (frame) => seen.push(toBytes(frame as RawFrame));

    await openTerminal({
      terminalId: TID,
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: channel,
    });

    pty.send("hello\r\n");

    expect(seen).toHaveLength(1);
    expect(new TextDecoder().decode(seen[0])).toBe("hello\r\n");
  });

  it("preserves frame order across a burst", async () => {
    // Ordering is the one thing a terminal may never get wrong: it is allowed
    // to lose ancient scrollback, never to reorder current output.
    const pty = ipc.channel();
    ipc.handle("terminal_open", (args) => {
      pty.capture(args.onOutput);
      return META;
    });

    let acc = "";
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (frame) => {
      acc += new TextDecoder().decode(toBytes(frame as RawFrame));
    };

    await openTerminal({
      terminalId: TID,
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: channel,
    });

    for (let i = 0; i < 50; i++) pty.send(`${i},`);

    expect(acc).toBe(Array.from({ length: 50 }, (_, i) => `${i},`).join(""));
  });

  it("survives a raw number[] frame (the postMessage fallback shape)", async () => {
    const pty = ipc.channel();
    ipc.handle("terminal_open", (args) => {
      pty.capture(args.onOutput);
      return META;
    });

    const seen: Uint8Array[] = [];
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (frame) => seen.push(toBytes(frame as RawFrame));

    await openTerminal({
      terminalId: TID,
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
      onOutput: channel,
    });

    pty.sendRaw([104, 105]);

    expect(new TextDecoder().decode(seen[0])).toBe("hi");
  });
});

/* ──────────────────────────── terminal_write ──────────────────────────── */

describe("writeTerminal", () => {
  it("hands the serializer a real Uint8Array under `data`", async () => {
    ipc.handle("terminal_write", () => undefined);
    await writeTerminal(TID, new TextEncoder().encode("ls"));

    const args = ipc.lastCall("terminal_write")!;
    expect(args.terminalId).toBe(TID);
    // Load-bearing: Tauri serializes a nested Uint8Array to a number array (serde `Vec<u8>`);
    // a plain object would become {"0":..}. `ArrayBuffer.isView`, not instanceof: jsdom's
    // TextEncoder is Node-realm.
    expect(ArrayBuffer.isView(args.data)).toBe(true);
    expect(Array.isArray(args.data)).toBe(false);
    expect(Array.from(args.data as Uint8Array)).toEqual([108, 115]);
  });

  it("round-trips bytes that are not valid UTF-8 on their own", async () => {
    // Keystrokes/paste can carry arbitrary bytes; the path must be binary-safe.
    ipc.handle("terminal_write", () => undefined);
    const raw = new Uint8Array([0x1b, 0x5b, 0x41, 0xff, 0x00]);
    await writeTerminal(TID, raw);

    expect(Array.from(ipc.lastCall("terminal_write")!.data as Uint8Array)).toEqual([
      0x1b, 0x5b, 0x41, 0xff, 0x00,
    ]);
  });
});

/* ─────────────────────── terminal_resize / close ─────────────────────── */

describe("resizeTerminal", () => {
  it("invokes terminal_resize with rows and cols", async () => {
    ipc.handle("terminal_resize", () => undefined);
    await resizeTerminal(TID, 40, 120);

    expect(ipc.lastCall("terminal_resize")).toEqual({
      terminalId: TID,
      rows: 40,
      cols: 120,
    });
  });
});

describe("closeTerminal", () => {
  it("invokes terminal_close with just the id", async () => {
    ipc.handle("terminal_close", () => undefined);
    await closeTerminal(TID);

    expect(ipc.lastCall("terminal_close")).toEqual({ terminalId: TID });
  });

  it("propagates a teardown failure rather than swallowing it", async () => {
    ipc.handle("terminal_close", () => {
      throw new Error("already gone");
    });
    await expect(closeTerminal(TID)).rejects.toThrow(/already gone/);
  });
});
