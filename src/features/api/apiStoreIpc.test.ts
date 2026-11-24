/**
 * `apiStoreIpc` — the API client's durable store, at the wire.
 *
 * A thin wrapper, so the command *name* and arg *shape* ARE the contract. What
 * matters most here is the two failure contracts the secret-safety design leans on: `loadApiStore`
 * NEVER throws (a dead backend yields an empty store so the UI still opens), and
 * `saveApiStore` swallows its failure (a dropped save must not break composing a
 * request). Both are pinned against the real `invoke`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  createApiFolder,
  deleteApiFolder,
  emptyApiStore,
  loadApiStore,
  moveRequestToFolder,
  readApiStore,
  renameApiFolder,
  reorderApiFolders,
  saveApiStore,
  type ApiStore,
} from "./apiStoreIpc";

const STORE: ApiStore = {
  collections: [
    { id: "c1", name: "GET things", method: "GET", url: "https://x.test", headers: [], body: "" },
  ],
  environments: [{ id: "e1", name: "prod", variables: [{ key: "TOKEN", value: "secret" }] }],
  activeEnvironmentId: "e1",
  folders: [],
};

describe("apiStoreIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("loadApiStore invokes api_store_load with no args and returns Rust's store", async () => {
    ipc.handle("api_store_load", () => STORE);
    await expect(loadApiStore()).resolves.toEqual(STORE);
    expect(ipc.lastCall("api_store_load")).toEqual({});
  });

  it("loadApiStore returns a FRESH empty store (not throwing) when the backend fails", async () => {
    ipc.handle("api_store_load", () => {
      throw new Error("no backend");
    });
    const a = await loadApiStore();
    expect(a).toEqual({ collections: [], environments: [], activeEnvironmentId: null, folders: [] });
    // A distinct object each call — callers mutate their copy.
    const b = await loadApiStore();
    expect(b).not.toBe(a);
  });

  it("saveApiStore invokes api_store_save with the store under a `store` key", async () => {
    ipc.handle("api_store_save", () => null);
    await saveApiStore(STORE);
    expect(ipc.lastCall("api_store_save")).toEqual({ store: STORE });
  });

  it("saveApiStore swallows a backend failure rather than rejecting", async () => {
    ipc.handle("api_store_save", () => {
      throw new Error("disk full");
    });
    await expect(saveApiStore(STORE)).resolves.toBeUndefined();
  });

  /* ─────────────── folders: the commands ─────────────── */

  it("readApiStore answers null on failure — NOT an empty store", async () => {
    // The distinction is the whole reason this function exists next to
    // `loadApiStore`: a caller re-hydrating an existing mirror must be able to tell
    // "the file is empty" from "I could not read the file", or a transient failure
    // blanks the mirror and the next blob save writes that blank to disk.
    ipc.handle("api_store_load", () => {
      throw new Error("no backend");
    });
    await expect(readApiStore()).resolves.toBeNull();
    expect(emptyApiStore()).toEqual({
      collections: [],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
  });

  /**
   * The command NAME and the argument KEYS are the contract Rust's
   * `#[tauri::command]` signatures declare — `requestId` → `request_id`,
   * `folderId` → `folder_id`. Asserted one wrapper at a time, with literals, rather
   * than looped over a table: a loop reading its expectation from the same source
   * proves the plumbing and nothing about the values.
   */
  it("each folder command invokes the name and arg keys Rust declares", async () => {
    for (const cmd of [
      "api_folder_create",
      "api_folder_rename",
      "api_folder_delete",
      "api_folder_reorder",
      "api_request_move",
    ]) {
      ipc.handle(cmd, () => STORE);
    }

    await expect(createApiFolder("Widget")).resolves.toEqual(STORE);
    expect(ipc.lastCall("api_folder_create")).toEqual({ name: "Widget" });

    await renameApiFolder("f-1", "Maestro");
    expect(ipc.lastCall("api_folder_rename")).toEqual({ id: "f-1", name: "Maestro" });

    await deleteApiFolder("f-1");
    expect(ipc.lastCall("api_folder_delete")).toEqual({ id: "f-1" });

    await reorderApiFolders(["f-2", "f-1"]);
    expect(ipc.lastCall("api_folder_reorder")).toEqual({ ids: ["f-2", "f-1"] });

    await moveRequestToFolder("c-1", "f-1");
    expect(ipc.lastCall("api_request_move")).toEqual({
      requestId: "c-1",
      folderId: "f-1",
    });

    // `null`, not `""` and not an omitted key — the root, as `Option<String>`.
    await moveRequestToFolder("c-1", null);
    expect(ipc.lastCall("api_request_move")).toEqual({
      requestId: "c-1",
      folderId: null,
    });
  });

  it("a rejected folder command answers null instead of throwing at a click handler", async () => {
    // These are called straight out of React event handlers, where a rejection has
    // nowhere to be caught. `null` is "it did not happen"; the caller keeps the rail
    // showing what is really on disk.
    ipc.handle("api_folder_create", () => {
      throw new Error("Could not write the API store: disk full");
    });
    await expect(createApiFolder("Widget")).resolves.toBeNull();
  });
});
