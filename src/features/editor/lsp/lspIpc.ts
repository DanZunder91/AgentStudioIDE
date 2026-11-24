/**
 * LSP IPC — typed wrappers for the language-server relay (M5).
 *
 * Feature-local (like `workspaceIpc.ts`) so the wire types live next to their
 * feature. Rust is a thin framed-byte relay: it spawns the
 * server, does Content-Length framing, and streams server→client bodies over a
 * per-server `Channel<String>`; JS owns the JSON-RPC protocol.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * The result of asking Rust to start a server for a language.
 * `status: "unavailable"` is the calm "not installed" case (mirrors `read_file`
 * degradation), NOT an error — the editor just runs without code intelligence.
 */
export interface LspServerMeta {
  serverId: string;
  languageId: string;
  status: "running" | "unavailable";
  /** Present when unavailable: e.g. "rustup component add rust-analyzer". */
  installHint?: string;
  /** e.g. "rust-analyzer" — for the indexing indicator + hint copy. */
  serverName?: string;
}

/**
 * `lsp_start` — resolve + spawn the server for `languageId`, cwd = `rootUri`'s
 * path. `onMessage` receives server→client JSON-RPC bodies (deframed strings).
 */
export function lspStart(
  languageId: string,
  rootUri: string,
  onMessage: Channel<string>,
): Promise<LspServerMeta> {
  return invoke<LspServerMeta>("lsp_start", { languageId, rootUri, onMessage });
}

/** `lsp_send` — one client→server JSON-RPC body (the Transport's `send`). */
export function lspSend(serverId: string, message: string): Promise<void> {
  return invoke<void>("lsp_send", { serverId, message });
}

/**
 * `lsp_project_root` — the directory the server should be rooted at for this
 * FILE: the outermost ancestor holding the language's project marker
 * (rust → `Cargo.toml`, so a cargo workspace beats its member crate), bounded
 * by the file's own containing workspace root; that root when no marker
 * exists. Fixes rust-analyzer "Failed to discover workspace" for crates in
 * subfolders, and the multi-root wrong-project case for every language.
 */
export function lspProjectRoot(languageId: string, path: string): Promise<string> {
  return invoke<string>("lsp_project_root", { languageId, path });
}

/** `lsp_stop` — terminate the server child + drop its framing task. */
export function lspStop(serverId: string): Promise<void> {
  return invoke<void>("lsp_stop", { serverId });
}
