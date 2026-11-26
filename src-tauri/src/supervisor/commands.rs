//! The thin `#[tauri::command]` surface (ARCHITECTURE §2.4): invoke → `SupervisorMsg` → reply.
//! Tauri v2 maps JS camelCase args to Rust snake_case params.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::model::{FleetSnapshot, TerminalMeta};
use crate::supervisor::{AgentSpawnSpec, OpenSpec, SupervisorHandle, TerminalBusy};

/// Open a shell PTY (default `$SHELL`) streaming raw `ArrayBuffer`s to `on_output`.
// too_many_arguments: the params ARE the `invoke('terminal_open', …)` wire contract (§2.4).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn terminal_open(
    supervisor: State<'_, SupervisorHandle>,
    terminal_id: String,
    program: Option<String>,
    args: Vec<String>,
    cwd: String,
    rows: u16,
    cols: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    supervisor
        .open_terminal(
            OpenSpec {
                terminal_id,
                program,
                args,
                cwd,
                rows,
                cols,
            },
            on_output,
        )
        .await
}

/// Keystrokes → the child's stdin. `data` is a `Uint8Array` on the JS side.
#[tauri::command]
pub async fn terminal_write(
    supervisor: State<'_, SupervisorHandle>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    supervisor.write(terminal_id, data).await
}

/// SIGWINCH the child. Debounced ~50 ms UI-side.
#[tauri::command]
pub async fn terminal_resize(
    supervisor: State<'_, SupervisorHandle>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    supervisor.resize(terminal_id, rows, cols).await
}

/// Re-bind a live terminal to a fresh `onOutput` channel after a webview reload. Status `live`
/// means scrollback was replayed, `exited` that the session ended; a missing id is an `Err`.
#[tauri::command]
pub async fn terminal_reattach(
    supervisor: State<'_, SupervisorHandle>,
    terminal_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    supervisor.reattach(terminal_id, on_output).await
}

/// Kill the child and tear down the PTY, reader thread and coalescer.
#[tauri::command]
pub async fn terminal_close(
    supervisor: State<'_, SupervisorHandle>,
    terminal_id: String,
) -> Result<(), String> {
    supervisor.close(terminal_id).await
}

/// Spawn an agent runtime in a PTY and register it; `agentId` (UI-minted ULID) is also the
/// terminal id. An unknown `runtime` errors with the available ones. `resumeSessionId` is set
/// only by pinned-agent boot-restore (`claude --resume`).
#[allow(clippy::too_many_arguments)] // same reason as `terminal_open` above.
#[tauri::command]
pub async fn agent_spawn(
    supervisor: State<'_, SupervisorHandle>,
    agent_id: String,
    runtime: String,
    cwd: String,
    rows: u16,
    cols: u16,
    prompt: Option<String>,
    resume_session_id: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    supervisor
        .spawn_agent(
            AgentSpawnSpec {
                agent_id,
                runtime,
                cwd,
                rows,
                cols,
                prompt,
                resume_session_id,
            },
            on_output,
        )
        .await
}

/// The whole fleet, live or dead: initial paint, re-attach, and the only reader of exit status.
#[tauri::command]
pub async fn fleet_snapshot(
    supervisor: State<'_, SupervisorHandle>,
) -> Result<FleetSnapshot, String> {
    supervisor.snapshot().await
}

/// Which of `ids` are busy enough to confirm before closing; returns only the busy ones. Asked
/// at the close gesture (a pushed value would be stale). See [`crate::supervisor::TerminalBusy`].
#[tauri::command]
pub async fn terminals_busy(
    supervisor: State<'_, SupervisorHandle>,
    ids: Vec<String>,
) -> Result<Vec<TerminalBusy>, String> {
    supervisor.terminals_busy(ids).await
}

/// Install the ad-hoc-detection hook at a folder opened without a terminal (git-root-aware,
/// idempotent). Returns `Ok` even when the write is skipped (home dir, symlinked `.claude`).
#[tauri::command]
pub async fn ensure_agent_hooks(
    supervisor: State<'_, SupervisorHandle>,
    root: String,
) -> Result<(), String> {
    supervisor.ensure_agent_hooks(root).await
}
