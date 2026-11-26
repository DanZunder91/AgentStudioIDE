/** Typed wrappers for the LSP relay. Rust spawns the server and does Content-Length framing;
 * JS owns the JSON-RPC protocol. */

import { Channel, invoke } from "@tauri-apps/api/core";

/** `status: "unavailable"` means not installed, NOT an error: the editor runs without LSP. */
export interface LspServerMeta {
  serverId: string;
  languageId: string;
  status: "running" | "unavailable";
  /** Present when unavailable: e.g. "rustup component add rust-analyzer". */
  installHint?: string;
  /** e.g. "rust-analyzer" — for the indexing indicator + hint copy. */
  serverName?: string;
}

/** cwd is `rootUri`'s path; `onMessage` receives deframed server→client JSON-RPC bodies. */
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

/** Root for this file: the outermost ancestor with the language's marker (a cargo workspace beats
 * its member crate), bounded by the file's workspace root; that root when no marker exists. */
export function lspProjectRoot(languageId: string, path: string): Promise<string> {
  return invoke<string>("lsp_project_root", { languageId, path });
}

/** `lsp_stop` — terminate the server child + drop its framing task. */
export function lspStop(serverId: string): Promise<void> {
  return invoke<void>("lsp_stop", { serverId });
}
