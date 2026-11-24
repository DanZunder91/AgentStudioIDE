//! The LSP `#[tauri::command]` surface (`docs/design/code-intelligence.md` §6).
//!
//! Thin glue over [`LspHandle`], mirroring `terminal_open`: a per-server
//! `Channel<String>` captured on start (server→client deframed JSON bodies), and
//! low-frequency commands in. Tauri maps JS camelCase args → snake_case params, so
//! the UI calls `invoke('lsp_start', { languageId, rootUri, onMessage })`,
//! `invoke('lsp_send', { serverId, message })`, `invoke('lsp_stop', { serverId })`.

use tauri::ipc::Channel;
use tauri::State;

use crate::lsp::LspHandle;
use crate::model::LspStartInfo;

/// Resolve + spawn the language server for `language_id`, streaming its output to
/// `on_message`. An absent server returns `Ok` with `status: "not_installed"` and an
/// `installHint` (the calm degrade path); a genuine spawn failure is an `Err`.
#[tauri::command]
pub async fn lsp_start(
    lsp: State<'_, LspHandle>,
    language_id: String,
    root_uri: String,
    on_message: Channel<String>,
) -> Result<LspStartInfo, String> {
    lsp.start(language_id, root_uri, on_message).await
}

/// One client→server JSON-RPC body (the Transport's `send`). Low frequency.
#[tauri::command]
pub async fn lsp_send(
    lsp: State<'_, LspHandle>,
    server_id: String,
    message: String,
) -> Result<(), String> {
    lsp.send(server_id, message).await
}

/// Terminate a server. Stopping an unknown/already-dead server is a no-op `Ok`.
#[tauri::command]
pub async fn lsp_stop(lsp: State<'_, LspHandle>, server_id: String) -> Result<(), String> {
    lsp.stop(server_id).await
}
