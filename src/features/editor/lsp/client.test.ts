import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../../app/store";
import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { resetStore } from "../../../test/store-harness";
import { ensureClient, onShowMessage, resetClients } from "./client";
import { useLogStore } from "../../logs/logStore";

const running = { serverId: "srv-1", languageId: "rust", status: "running" as const };

describe("ensureClient", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    resetStore();
    resetClients();
    ipc = installTauriMock();
    ipc.handle("lsp_send", () => null);
  });
  afterEach(() => {
    resetClients();
    ipc.reset();
  });

  it("starts the server once per (root, language) and returns a live client", async () => {
    ipc.handle("lsp_start", () => running);

    const client = await ensureClient("rust", "/w/proj");
    expect(client).not.toBeNull();
    const args = ipc.lastCall("lsp_start")!;
    expect(args.languageId).toBe("rust");
    expect(args.rootUri).toBe("file:///w/proj"); // rootUri = uriFromPath(root)

    // Cached: a second open of the same language reuses the client, no re-start.
    const again = await ensureClient("rust", "/w/proj");
    expect(again).toBe(client);
    expect(ipc.calls("lsp_start")).toHaveLength(1);
  });

  it("degrades to a calm install hint when the server is unavailable", async () => {
    ipc.handle("lsp_start", () => ({
      serverId: "",
      languageId: "rust",
      status: "unavailable",
      installHint: "rustup component add rust-analyzer",
    }));

    const client = await ensureClient("rust", "/w/proj");
    expect(client).toBeNull();
    expect(useAppStore.getState().lspInstallHints.rust).toBe(
      "rustup component add rust-analyzer",
    );
  });

  it("falls back to a generic hint when Rust sends none", async () => {
    ipc.handle("lsp_start", () => ({ serverId: "", languageId: "rust", status: "unavailable" }));

    await ensureClient("rust", "/w/proj");
    expect(useAppStore.getState().lspInstallHints.rust).toMatch(/language server/i);
  });

  it("resetClients clears the cache so the next open re-starts", async () => {
    ipc.handle("lsp_start", () => running);
    await ensureClient("rust", "/w/proj");
    resetClients();
    await ensureClient("rust", "/w/proj");
    expect(ipc.calls("lsp_start")).toHaveLength(2);
  });
});

describe("onShowMessage — the dialog-spam guard", () => {
  // rust-analyzer repeats "Failed to discover workspace" per open file: every message is logged,
  // only the first (language, text) pair reaches the dialog (false = the library shows it).

  beforeEach(() => {
    resetClients(); // also clears the dedupe set
    useLogStore.setState({ entries: [], visible: false });
  });

  const DISCOVER = "Failed to discover workspace. Consider adding the `Cargo.toml`…";

  it("lets the FIRST occurrence dialog and logs it as an error", () => {
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(false);
    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].source).toBe("lsp");
    expect(entries[0].message).toContain(DISCOVER);
  });

  it("suppresses every REPEAT of the same message while still logging it", () => {
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(false);
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(true);
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(true);
    expect(useLogStore.getState().entries).toHaveLength(3); // the log keeps the full record
  });

  it("dedupes per (language, text): another language or another text dialogs again", () => {
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(false);
    expect(onShowMessage("typescript", { type: 1, message: DISCOVER })).toBe(false);
    expect(onShowMessage("rust", { type: 1, message: "another problem" })).toBe(false);
  });

  it("maps warning and info types to their log levels", () => {
    onShowMessage("rust", { type: 2, message: "w" });
    onShowMessage("rust", { type: 3, message: "i" });
    const levels = useLogStore.getState().entries.map((e) => e.level);
    expect(levels).toEqual(["warn", "info"]);
  });

  it("drops debug chatter (type > 3) and empty messages without logging, like the default", () => {
    expect(onShowMessage("rust", { type: 4, message: "log noise" })).toBe(true);
    expect(onShowMessage("rust", { type: 1, message: "" })).toBe(true);
    expect(onShowMessage("rust", undefined)).toBe(true);
    expect(useLogStore.getState().entries).toHaveLength(0);
  });

  it("resetClients clears the dedupe so a fresh window can surface anew", () => {
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(false);
    resetClients();
    expect(onShowMessage("rust", { type: 1, message: DISCOVER })).toBe(false);
  });
});
