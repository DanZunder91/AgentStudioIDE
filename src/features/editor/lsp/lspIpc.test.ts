/** The command names and arg shapes are the whole contract with the Rust relay. */

import { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { channelIdOf, installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { lspProjectRoot, lspSend, lspStart, lspStop } from "./lspIpc";

describe("lspIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  describe("lspStart", () => {
    it("invokes lsp_start with languageId, rootUri, and the message Channel", async () => {
      const meta = { serverId: "srv-1", languageId: "rust", status: "running" as const };
      ipc.handle("lsp_start", () => meta);
      const channel = new Channel<string>();

      await expect(lspStart("rust", "file:///w", channel)).resolves.toEqual(meta);
      const args = ipc.lastCall("lsp_start")!;
      expect(args.languageId).toBe("rust");
      expect(args.rootUri).toBe("file:///w");
      expect(channelIdOf(args.onMessage)).toBe(channel.id);
    });

    it("surfaces the calm 'unavailable' result (server not installed)", async () => {
      const meta = {
        serverId: "",
        languageId: "rust",
        status: "unavailable" as const,
        installHint: "rustup component add rust-analyzer",
      };
      ipc.handle("lsp_start", () => meta);

      await expect(lspStart("rust", "file:///w", new Channel<string>())).resolves.toMatchObject({
        status: "unavailable",
        installHint: "rustup component add rust-analyzer",
      });
    });
  });

  describe("lspSend / lspStop", () => {
    it("lsp_send passes the serverId and the raw JSON-RPC body", async () => {
      ipc.handle("lsp_send", () => null);
      await lspSend("srv-1", '{"jsonrpc":"2.0"}');
      expect(ipc.lastCall("lsp_send")).toEqual({ serverId: "srv-1", message: '{"jsonrpc":"2.0"}' });
    });

    it("lsp_stop passes the serverId", async () => {
      ipc.handle("lsp_stop", () => null);
      await lspStop("srv-1");
      expect(ipc.lastCall("lsp_stop")).toEqual({ serverId: "srv-1" });
    });
  });

  describe("lspProjectRoot", () => {
    it("invokes lsp_project_root with languageId and the FILE path, returning the root", async () => {
      ipc.handle("lsp_project_root", () => "/w/proj/crates/core");

      await expect(lspProjectRoot("rust", "/w/proj/crates/core/src/lib.rs")).resolves.toBe(
        "/w/proj/crates/core",
      );
      const args = ipc.lastCall("lsp_project_root")!;
      expect(args.languageId).toBe("rust");
      expect(args.path).toBe("/w/proj/crates/core/src/lib.rs");
    });

    it("passes a rejection through untouched (the caller owns the fallback)", async () => {
      ipc.handle("lsp_project_root", () => {
        throw "path does not exist";
      });

      await expect(lspProjectRoot("rust", "/gone.rs")).rejects.toBe("path does not exist");
    });
  });
});
