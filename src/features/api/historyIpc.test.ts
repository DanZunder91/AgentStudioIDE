/** loadApiHistory never throws (a dead backend yields an empty log); saveApiHistory swallows. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { loadApiHistory, saveApiHistory, type HistoryStore } from "./historyIpc";

const STORE: HistoryStore = {
  entries: [
    {
      id: "h1",
      method: "GET",
      url: "https://x.test",
      headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
      body: "",
      status: 200,
      statusText: "OK",
      durationMs: 12,
      sizeBytes: 34,
      error: null,
      at: 1_700_000_000_000,
    },
  ],
};

describe("historyIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  it("loadApiHistory invokes api_history_load with no args and returns Rust's log", async () => {
    ipc.handle("api_history_load", () => STORE);
    await expect(loadApiHistory()).resolves.toEqual(STORE);
    expect(ipc.lastCall("api_history_load")).toEqual({});
  });

  it("loadApiHistory returns a FRESH empty log (not throwing) when the backend fails", async () => {
    ipc.handle("api_history_load", () => {
      throw new Error("no backend");
    });
    const a = await loadApiHistory();
    expect(a).toEqual({ entries: [] });
    const b = await loadApiHistory();
    expect(b).not.toBe(a); // a distinct object each call
  });

  it("saveApiHistory invokes api_history_save with the store under a `store` key", async () => {
    ipc.handle("api_history_save", () => null);
    await saveApiHistory(STORE);
    expect(ipc.lastCall("api_history_save")).toEqual({ store: STORE });
  });

  it("saveApiHistory swallows a backend failure rather than rejecting", async () => {
    ipc.handle("api_history_save", () => {
      throw new Error("disk full");
    });
    await expect(saveApiHistory(STORE)).resolves.toBeUndefined();
  });
});
