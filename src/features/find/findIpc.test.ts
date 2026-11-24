/**
 * `findIpc` — the search half of the command surface, at the wire.
 *
 * A thin wrapper, and thin wrappers are exactly where the command *name* and the
 * arg *shape* are the whole contract: get either wrong and Rust rejects the call
 * at runtime with types none the wiser. `findInFiles`' real exercise is driven
 * through `<FindInFiles>` (with the module mocked); this pins the marshalling
 * against the real `invoke`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  cancelFind,
  findFiles,
  findInFiles,
  newSearchId,
  type FindFilesOptions,
  type FindFilesResult,
  type FindOptions,
  type FindResult,
} from "./findIpc";

const OPTS: FindOptions = { regex: false, caseSensitive: false, wholeWord: false, glob: "" };

describe("findIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("invokes find_in_files with root, query AND options, returning Rust's result", async () => {
    const result: FindResult = {
      matches: [
        { file: "/w/a.ts", line: 3, col: 5, lineText: "  const x = 1", matchStart: 8, matchEnd: 9 },
      ],
      truncated: false,
    };
    ipc.handle("find_in_files", () => result);

    const options: FindOptions = { regex: true, caseSensitive: true, wholeWord: true, glob: "*.ts" };
    await expect(findInFiles("/w", "x", options)).resolves.toEqual(result);
    // The whole contract: command name + the three argument keys + the nested
    // option shape. A rename or a dropped key fails silently against Rust.
    expect(ipc.lastCall("find_in_files")).toEqual({ root: "/w", query: "x", options });
  });

  it("passes the default (all-off) options through untouched", async () => {
    ipc.handle("find_in_files", () => ({ matches: [], truncated: false }));

    await findInFiles("/w", "todo", OPTS);
    expect(ipc.lastCall("find_in_files")).toEqual({ root: "/w", query: "todo", options: OPTS });
  });

  it("propagates an invalid-regex rejection to the caller rather than resolving empty", async () => {
    // The panel turns this Err into a calm inline error; an empty result set
    // would masquerade as "no matches" and hide the broken pattern.
    ipc.handle("find_in_files", () => {
      throw new Error("regex parse error: unclosed group");
    });

    await expect(findInFiles("/w", "(", { ...OPTS, regex: true })).rejects.toThrow(
      /unclosed group/,
    );
  });

  it("invokes find_files with root, query AND options, returning Rust's result", async () => {
    const result: FindFilesResult = {
      files: [{ path: "src/store.ts", name: "store.ts" }],
      truncated: false,
    };
    ipc.handle("find_files", () => result);

    const options: FindFilesOptions = { caseSensitive: true };
    await expect(findFiles("/w", "store", options)).resolves.toEqual(result);
    // The whole contract: command name + the three argument keys + the option shape.
    expect(ipc.lastCall("find_files")).toEqual({ root: "/w", query: "store", options });
  });

  it("propagates a find_files rejection to the caller", async () => {
    ipc.handle("find_files", () => {
      throw new Error("search backend unavailable");
    });

    await expect(findFiles("/w", "x", { caseSensitive: false })).rejects.toThrow(
      /backend unavailable/,
    );
  });
});

/**
 * Cancellation. A slow search used to freeze the whole window; Rust moved the
 * walk off the event-loop thread, and this is the handle that stops it.
 * Marshalling only — the panels' use of it is driven through `<FindInFiles>` /
 * `<FindFiles>`.
 */
describe("findIpc — cancellation", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("carries the searchId on find_in_files, so a cancel has something to name", async () => {
    ipc.handle("find_in_files", () => ({ matches: [], truncated: false }));

    await findInFiles("/w", "todo", OPTS, "search-1");
    expect(ipc.lastCall("find_in_files")).toEqual({
      root: "/w",
      query: "todo",
      options: OPTS,
      searchId: "search-1",
    });
  });

  it("carries the searchId on find_files too", async () => {
    ipc.handle("find_files", () => ({ files: [], truncated: false }));

    await findFiles("/w", "store", { caseSensitive: false }, "search-2");
    expect(ipc.lastCall("find_files")).toEqual({
      root: "/w",
      query: "store",
      options: { caseSensitive: false },
      searchId: "search-2",
    });
  });

  it("invokes find_cancel with the id and returns Rust's verdict", async () => {
    ipc.handle("find_cancel", () => true);

    await expect(cancelFind("search-1")).resolves.toBe(true);
    expect(ipc.lastCall("find_cancel")).toEqual({ searchId: "search-1" });
  });

  it("reports false when Rust knows no such search — not an error", async () => {
    ipc.handle("find_cancel", () => false);
    await expect(cancelFind("already-finished")).resolves.toBe(false);
  });

  it("NEVER throws: a failed cancel resolves false instead of rejecting", async () => {
    // Best-effort cleanup. The search settles on its own either way, and a
    // rejection here would surface as a spurious error on a panel the user has
    // already walked away from — so it is swallowed at the wrapper, on purpose.
    ipc.handle("find_cancel", () => {
      throw new Error("no such search");
    });

    await expect(cancelFind("gone")).resolves.toBe(false);
  });

  it("mints a fresh, non-empty id every call", () => {
    const a = newSearchId();
    const b = newSearchId();
    expect(a).not.toBe("");
    expect(b).not.toBe(a);
  });
});
