//! Agent control: what an agent running in an Agent Studio terminal can ask the app to do.
//!
//! The user says "connect me to postgres://…" or "send this request" to whatever agent they are
//! talking to; the agent calls a tool — `agent-studio db connect <url>` on the command line
//! ([`cli`]) or the same tool over MCP — and the app does it, visibly. Every agent can, because
//! the only requirement is a process in one of our PTYs.
//!
//! # The channel
//!
//! No new server and no network exposure. Requests go to the hook listener that already exists
//! ([`crate::hook_listener`]), on `127.0.0.1`, as `POST /ctl` carrying the same per-launch token
//! and terminal id every PTY already has in its environment. A process without the token is
//! dropped before a byte of its body is read; the terminal id says who asked.
//!
//! # The tools
//!
//! Declared once in [`registry`] tables under [`commands`]; the CLI, its help and the MCP tool
//! list are generated from them. A request is `{"tool": "<name>", "args": {…}}`, validated
//! against the tool's parameters before it runs.
//!
//! # What an agent may and may not do
//!
//! The agent already holds whatever the user typed into the conversation. What it must never get
//! is the user's **saved** secrets: Vault values are never returned, and an agent-written URL or
//! request that names a Vault variable (`{{VAR}}`) is refused — otherwise an agent could send a
//! saved secret to a host of its choosing (ADR-0025 §5). Each command module states its own rules
//! on top of that.

pub mod cli;
pub mod commands;
pub mod mcp;
pub mod registry;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use registry::{ToolCtx, ToolOk, UiSink};

/// The path the listener routes to [`handle`].
pub const CTL_PATH: &str = "/ctl";

/// The Tauri event the webview listens on for what an agent just did.
pub const EVENT: &str = "agent-ctl://event";

/// One request: a tool and its arguments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CtlCall {
    pub tool: String,
    #[serde(default)]
    pub args: Map<String, Value>,
}

/// The reply. `message` is what the CLI prints; `data` is what `--json` and MCP return.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CtlResponse {
    pub ok: bool,
    pub message: String,
    #[serde(default)]
    pub data: Value,
}

impl CtlResponse {
    pub fn ok(message: impl Into<String>, data: Value) -> Self {
        Self {
            ok: true,
            message: message.into(),
            data,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            data: Value::Null,
        }
    }
}

/// What the webview is told: a `kind` its dispatcher routes on, the terminal that asked, and the
/// kind's own fields alongside (`{"kind":"dbConnection","terminalId":"…","connectionId":"…"}`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CtlEvent {
    pub kind: String,
    pub terminal_id: String,
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

/// Handle one authenticated request body: parse, find the tool, validate, run.
/// Returns the HTTP status and the reply.
pub async fn handle(ctx: ToolCtx, body: &[u8]) -> (u16, CtlResponse) {
    let call: CtlCall = match serde_json::from_slice(body) {
        Ok(c) => c,
        Err(e) => {
            return (
                400,
                CtlResponse::err(format!(
                    "Agent Studio did not understand that request ({e}). The `agent-studio` \
                     command and the app may be different versions: open a new terminal."
                )),
            )
        }
    };
    let Some(spec) = registry::find(&call.tool) else {
        return (
            404,
            CtlResponse::err(format!(
                "Agent Studio has no tool `{}`. Run `agent-studio help` for the list.",
                call.tool
            )),
        );
    };
    let args = match registry::validate(spec, call.args) {
        Ok(a) => a,
        Err(message) => return (422, CtlResponse::err(message)),
    };
    match (spec.run)(ctx, args).await {
        Ok(ok) => (200, CtlResponse::ok(ok.message, ok.data)),
        Err(message) => (422, CtlResponse::err(message)),
    }
}

/// The webview, as a [`UiSink`].
struct TauriUi(tauri::AppHandle);

impl UiSink for TauriUi {
    fn emit(&self, event: CtlEvent) {
        use tauri::Emitter as _;
        let _ = self.0.emit(EVENT, event);
    }
}

/// The listener's `/ctl` handler for the real app: [`handle`] against the real config dir, with
/// UI events going to the webview. Real boot only (`lib.rs`).
pub fn tauri_handler(app: tauri::AppHandle) -> std::sync::Arc<crate::hook_listener::CtlHandler> {
    use tauri::Manager as _;
    let dir = app.path().app_config_dir().unwrap_or_else(|_| {
        crate::agent::claude::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".config")
            .join("agent-studio")
    });
    let ui: std::sync::Arc<dyn UiSink> = std::sync::Arc::new(TauriUi(app));
    std::sync::Arc::new(move |terminal_id: String, body: Vec<u8>| {
        let ctx = ToolCtx {
            dir: dir.clone(),
            terminal_id,
            ui: ui.clone(),
        };
        Box::pin(async move {
            let (status, response) = handle(ctx, &body).await;
            (status, serde_json::to_vec(&response).unwrap_or_default())
        }) as crate::hook_listener::CtlFuture
    })
}

#[cfg(test)]
mod tests;
