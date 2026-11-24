/**
 * The dev-apps IPC seam: command names AND argument shapes are the contract with the Rust side,
 * pinned as literals — never read back from `procsTypes.ts` (an expectation derived from the
 * code under test cannot fail).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

import { pickLogFile, procsList, restartInIde, restartPrepare, tailApp, tailDocker, untail } from "./procsIpc";

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
});
afterEach(() => ipc.reset());

const LIST = { available: true, reason: null, apps: [] };

describe("procs IPC", () => {
  it("sends every command under its literal name with exactly its args, and returns Rust's value", async () => {
    ipc.handle("procs_list", () => LIST);
    ipc.handle("logstream_tail_app", () => ({ key: "k1", source: "web · app.log" }));
    ipc.handle("logstream_tail_docker", () => ({ key: "k2", source: "db · docker" }));
    ipc.handle("logstream_untail", () => true);
    ipc.handle("logstream_pick_file", () => "/tmp/x.log");
    ipc.handle("procs_restart_prepare", () => ({ token: "t", summary: { name: "web", cwd: "/w", argv: ["node"] } }));
    ipc.handle("procs_restart_in_ide", () => ({ terminalId: "term-9" }));

    await expect(procsList()).resolves.toEqual(LIST);
    await expect(tailApp(42, "/w/app.log")).resolves.toEqual({ key: "k1", source: "web · app.log" });
    await expect(tailDocker("abc123")).resolves.toEqual({ key: "k2", source: "db · docker" });
    await expect(untail("k1")).resolves.toBe(true);
    await expect(pickLogFile()).resolves.toBe("/tmp/x.log");
    await expect(restartPrepare(42)).resolves.toEqual({ token: "t", summary: { name: "web", cwd: "/w", argv: ["node"] } });
    await expect(restartInIde("t")).resolves.toEqual({ terminalId: "term-9" });

    expect(ipc.calls().map((c) => [c.cmd, c.args])).toEqual([
      ["procs_list", {}],
      ["logstream_tail_app", { pid: 42, path: "/w/app.log" }],
      ["logstream_tail_docker", { id: "abc123" }],
      ["logstream_untail", { key: "k1" }],
      ["logstream_pick_file", {}],
      ["procs_restart_prepare", { pid: 42 }],
      ["procs_restart_in_ide", { token: "t" }],
    ]);
  });

  it("passes a cancelled pick through as null", async () => {
    ipc.handle("logstream_pick_file", () => null);
    await expect(pickLogFile()).resolves.toBeNull();
  });

  it("does not swallow a rejection", async () => {
    ipc.handle("procs_list", () => {
      throw new Error("not on windows");
    });
    await expect(procsList()).rejects.toThrow("not on windows");
  });
});
