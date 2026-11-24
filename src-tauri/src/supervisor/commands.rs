//! The `#[tauri::command]` surface (ARCHITECTURE §2.4). These are thin: they
//! translate an invoke into a `SupervisorMsg` and await the reply.
//!
//! Tauri v2 maps JS camelCase args → Rust snake_case params, so the UI calls
//! `invoke('terminal_open', { terminalId, program, args, cwd, rows, cols, onOutput })`.
//!
//! M1 = terminals only. `agent_spawn` / `fleet_snapshot` / `read_dir` land later.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::model::{FleetSnapshot, TerminalMeta};
use crate::supervisor::{AgentSpawnSpec, OpenSpec, SupervisorHandle, TerminalBusy};

/// Open a plain shell PTY and start streaming its output to `on_output`.
///
/// `program` defaults to the user's `$SHELL`. The returned `TerminalMeta` is the
/// UI's record of the terminal; bytes arrive out-of-band on the channel as raw
/// `ArrayBuffer`s.
// clippy::too_many_arguments (8/7) is not applicable here: these parameters *are*
// the wire contract. Tauri derives the JS argument names from them, so the
// signature is exactly the `invoke('terminal_open', { terminalId, program, args,
// cwd, rows, cols, onOutput })` call in ARCHITECTURE §2.4. Collapsing them into a
// struct would nest the JS payload one level deeper and break the frontend — the
// lint's suggested refactor is the only thing here that would be a behavior
// change.
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

/// Re-bind a live terminal to a fresh output channel after a webview reload.
/// The frontend rebuilds its tabs from `fleet_snapshot().terminals`
/// and calls this per terminal with a new `onOutput` channel.
///
/// The returned `TerminalMeta.status` tells the frontend what happened: `live` →
/// the pane is now streaming again (scrollback replayed + repainted); `exited` →
/// the session ended (show that, offer restart). A missing id is an `Err`.
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

/// Spawn an agent runtime in a PTY and register it in the fan-out forest.
///
/// `agentId` is minted by the UI (a ULID) and doubles as the terminal's id — the
/// agent's terminal and its node are 1:1 in v1. `runtime` selects the
/// `AgentAdapter` (e.g. `"claude-code"`); an unknown one is an error listing what
/// is available, never a silent no-op.
///
/// The adapter also mints the runtime's *own* session identity and imposes it on
/// the process, so the transcript binding is a fact rather than a guess
/// — that is what M3's tailer will key off.
///
/// `resumeSessionId` is `None` for every interactive spawn; the pinned-
/// agent boot-restore is the only caller that sets it, to **resume** a persisted
/// conversation (`claude --resume <id>`) rather than start a fresh one. Keeping it
/// one optional argument means a single spawn command serves both paths.
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

/// The whole fleet: every agent node and every terminal, live or dead.
///
/// Initial paint, and the restart/re-attach path. This is also what makes a
/// terminal's death visible at all: `TerminalMeta.status`/`exitCode` are written
/// on child exit, but until this command existed no caller could read them back.
#[tauri::command]
pub async fn fleet_snapshot(
    supervisor: State<'_, SupervisorHandle>,
) -> Result<FleetSnapshot, String> {
    supervisor.snapshot().await
}

/// Which of `ids` are running something the user would hate to lose.
///
/// Closing a terminal that is running `claude` first asks
/// for confirmation. The UI calls this once, at the moment of the
/// close gesture, and throws the answer away — a pushed field would be stale by
/// construction, and a stale "not busy" is the answer that loses the session. It is
/// **batched** because `closePane` kills every terminal in a pane in one click.
///
/// Returns **only the busy ones**: idle, exited and unknown ids are absent from the
/// array rather than an error. See [`crate::supervisor::TerminalBusy`] for the two
/// tiers and why neither can cover the other's blind spot.
#[tauri::command]
pub async fn terminals_busy(
    supervisor: State<'_, SupervisorHandle>,
    ids: Vec<String>,
) -> Result<Vec<TerminalBusy>, String> {
    supervisor.terminals_busy(ids).await
}

/// Install the ad-hoc-detection hook for a workspace `root` opened without
/// spawning a terminal — the multi-root Files "Open a folder" path.
///
/// Terminal/agent spawn already installs the hook in its cwd's git root; this
/// covers a folder the user merely *opens* (no PTY), so a `claude` they later type
/// in a terminal there is still detected. git-root-aware,
/// idempotent, and non-fatal — it returns `Ok` even when the write is skipped (the
/// home dir, a symlinked `.claude`, or no listener), so the UI never breaks on it.
#[tauri::command]
pub async fn ensure_agent_hooks(
    supervisor: State<'_, SupervisorHandle>,
    root: String,
) -> Result<(), String> {
    supervisor.ensure_agent_hooks(root).await
}
