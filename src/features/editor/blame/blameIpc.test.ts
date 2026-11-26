/** The command name, arg shape and string-rejection passthrough are the whole Rust contract. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { gitBlame, type FileBlame } from "./blameIpc";

const BLAME: FileBlame = {
  relPath: "src/a.ts",
  commits: [
    {
      id: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
      author: "Max Turing",
      email: "max@example.com",
      timeMs: 1_780_000_000_000,
      summary: "feat: blame",
      message: "feat: blame\n\nbody\n",
    },
  ],
  lines: [0, 0, null],
};

describe("blameIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes git_blame with { path } and resolves the FileBlame untouched", async () => {
    ipc.handle("git_blame", () => BLAME);

    await expect(gitBlame("/w/src/a.ts")).resolves.toEqual(BLAME);
    expect(ipc.lastCall("git_blame")).toEqual({ path: "/w/src/a.ts" });
  });

  it("passes a string rejection through untouched (the calm-note input)", async () => {
    ipc.handle("git_blame", () =>
      // Rust rejects with a plain string message (the wire contract), not an Error.
      Promise.reject("/tmp/x.ts is not in a git repository"),
    );

    await expect(gitBlame("/tmp/x.ts")).rejects.toBe("/tmp/x.ts is not in a git repository");
  });
});
