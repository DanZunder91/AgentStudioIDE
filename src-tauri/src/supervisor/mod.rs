//! `SessionSupervisor` — the actor that owns every `TerminalRuntime` and the
//! agent forest.
//!
//! **Concurrency model** (ARCHITECTURE §3): one task owns the registry, driven by
//! an mpsc command loop. Tauri commands, waiter threads and (from M3) transcript
//! tailers all just send it messages. No `Arc<Mutex<HashMap>>`, no contention.
//!
//! **Governing invariant:** the hot byte path does *not* go through here. Reader
//! thread → coalescer → `Channel` is lock-free per terminal; the supervisor only
//! sits on the low-frequency control path (open/write/resize/close/exit/spawn).
//!
//! **M2 adds agents.** An agent is a terminal plus a node in the forest: the PTY
//! path below is shared verbatim with plain terminals, and the only difference is
//! *who chose the argv* (an `AgentAdapter`) and that we keep an `AgentNode` beside
//! the `TerminalRuntime`.
//!
//! **M3 adds the fan-out tree.** Each root starts a tailer task
//! ([`start_fanout_tailer`]) that polls its session's transcript and reports
//! sub-agents as [`SupervisorMsg::FanoutDelta`]; those become `Subagent` nodes and
//! `agent://event` `SubagentSpawned`/`Status` payloads. Sub-agents have no PTY —
//! `terminal_id` is `None` — and cascade-remove with their root.

pub mod commands;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{mpsc, oneshot};

use crate::agent::adapter::{AgentAdapter, SessionKey, SpawnRequest};
use crate::agent::hook::{
    SessionEvent, SessionEventKind, ENV_HOOK_TOKEN, ENV_HOOK_URL, ENV_TERMINAL_ID,
};
use crate::events::EventSink;
use crate::hook_listener::HookConfig;
use crate::logstream::{source_label, LineDraft, LogHub, LogKind, LogLevel};
use crate::model::{
    AgentEvent, AgentId, AgentKind, AgentNode, AgentStatus, FleetSnapshot, TerminalId,
    TerminalKind, TerminalMeta, TerminalStatus,
};
use crate::open_agents::{self, OpenAgent, Registry, RestoreOutcome, RestoredAgent, ShutdownFlag};
use crate::pinned_agents::PinnedAgent;
use crate::procscan::ide::{IdeTerminal, IdeTerminals};
use crate::pty::{self, PtyHandle, SpawnSpec};
use crate::stream::coalesce::{pump_to_ui_tapped, PumpControl};

/// Command-channel depth. The control plane is low-frequency; this is slack, not
/// throughput.
const SUPERVISOR_QUEUE: usize = 1024;

/// Arguments for `terminal_open`, as they arrive from the UI.
#[derive(Debug)]
pub struct OpenSpec {
    pub terminal_id: TerminalId,
    /// `None` → the user's `$SHELL` (see [`pty::default_shell`]).
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
}

/// Arguments for `agent_spawn` (ARCHITECTURE §2.4).
#[derive(Debug)]
pub struct AgentSpawnSpec {
    /// Minted by the UI (a ULID). Distinct from the runtime's own `SessionKey`.
    pub agent_id: AgentId,
    /// Selects the `AgentAdapter`, e.g. `"claude-code"`.
    pub runtime: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    /// Optional seed prompt. M2's command passes `None`.
    pub prompt: Option<String>,
    /// A persisted session id to **resume** instead of minting a fresh one.
    /// `Some` only on boot-restore of a pinned root; `None` for every
    /// interactive `+`/⚡ spawn. Threaded into the adapter's [`SpawnRequest`] so the
    /// same conversation + transcript are re-anchored (`claude --resume <id>`).
    pub resume_session_id: Option<String>,
}

/// The internal facts needed to persist a pinned root, gathered from
/// live supervisor state so the **session id never crosses the JS wire**: the
/// `pin_agent` command asks for this in-process, builds the store entry, and writes
/// it. Only ever produced for a **root** agent (sub-agents are not pinnable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnableAgent {
    pub agent_id: AgentId,
    pub cwd: String,
    pub runtime: String,
    /// The runtime's own session identity (the minted `--session-id`) — the key to
    /// `claude --resume`. Internal; deliberately not on any wire type.
    pub session_id: String,
    /// The user-renamed label, or `None` when the agent still wears its adapter
    /// default title (nothing to preserve).
    pub custom_title: Option<String>,
    /// The root's process has exited (`done`/`error`) — gates "Resume conversation".
    pub finished: bool,
}

// ── "Would closing this terminal lose work?" (close confirmation) ──
//
// Closing a terminal that is running `claude` first asks for
// confirmation. The frontend asks this once, at the moment of the close
// gesture, and throws the answer away — see `src/features/terminal/terminalBusyIpc.ts`
// for why it is asked rather than pushed (any pushed field would be stale by
// construction, and a stale "not busy" is exactly the answer that loses the session).

/// Why a terminal counts as busy. Drives the dialog's wording, not its logic.
///
/// Wire contract: serialises to `"agent"` / `"command"` — the `BusyReason` string
/// union in `src/features/terminal/terminalBusyIpc.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BusyReason {
    /// Tier 1: a live runtime session is bound to this terminal. Exact, all
    /// platforms.
    Agent,
    /// Tier 2: a foreground command owns the shell's tty (Unix), or the shell has a
    /// console child (Windows — `PtyHandle::foreground_command_running`).
    Command,
}

/// One busy terminal, as `terminals_busy` reports it.
///
/// Wire contract: `interface BusyTerminal { id: TerminalId; reason: BusyReason;
/// label: string }`. Only busy terminals appear in the result — idle, exited and
/// unknown ids are simply absent, never an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBusy {
    pub id: TerminalId,
    pub reason: BusyReason,
    /// A short human label for the dialog: the agent's title, or the terminal's.
    /// Never scraped from the byte stream — we do not read it, and half a line of
    /// output would be worse than no label.
    pub label: String,
}

/// Everything the supervisor sends itself or is sent by commands/threads.
pub enum SupervisorMsg {
    OpenTerminal {
        spec: OpenSpec,
        channel: Channel<InvokeResponseBody>,
        reply: oneshot::Sender<Result<TerminalMeta, String>>,
    },
    /// `OpenTerminal` with extra env on top of the inherited one (before the hook + proxy
    /// env, which still win) — Restart in the IDE hands the
    /// restarted app its captured environment this way. Never logged.
    OpenTerminalWithEnv {
        spec: OpenSpec,
        env: Vec<(String, String)>,
        channel: Channel<InvokeResponseBody>,
        reply: oneshot::Sender<Result<TerminalMeta, String>>,
    },
    SpawnAgent {
        spec: AgentSpawnSpec,
        channel: Channel<InvokeResponseBody>,
        reply: oneshot::Sender<Result<TerminalMeta, String>>,
    },
    Write {
        id: TerminalId,
        data: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resize {
        id: TerminalId,
        rows: u16,
        cols: u16,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Close {
        id: TerminalId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Snapshot {
        reply: oneshot::Sender<FleetSnapshot>,
    },
    /// Which of `ids` are busy right now — the terminal-close confirmation. Answered
    /// from live actor state (the binding table + each PTY's foreground group), so it
    /// is never a cached field that could have gone stale.
    TerminalsBusy {
        ids: Vec<TerminalId>,
        reply: oneshot::Sender<Vec<TerminalBusy>>,
    },
    /// Re-bind a live terminal to a fresh output `Channel` after a webview reload.
    /// Live → swap + replay + resize-nudge; exited → meta only; missing
    /// → error.
    Reattach {
        id: TerminalId,
        channel: Channel<InvokeResponseBody>,
        reply: oneshot::Sender<Result<TerminalMeta, String>>,
    },
    /// From the per-terminal waiter thread.
    ChildExited { id: TerminalId, code: Option<i32> },
    /// A runtime's session hook phoned home. The listener has already
    /// checked the token; `body` is the raw payload, parsed here via the adapter.
    HookReceived {
        terminal_id: TerminalId,
        body: Vec<u8>,
    },
    /// A fan-out tailer observed a sub-agent change (M3). Off the actor thread; the
    /// tailer polls transcripts and sends these in.
    FanoutDelta {
        delta: crate::agent::fanout::FanoutDelta,
    },
    /// A fan-out tailer read new tool calls/results off its transcripts (Agent Logs).
    /// Routed through the actor so each line is labelled from
    /// the live forest (a sub-agent's title, its root's terminal).
    ToolEvents {
        events: Vec<crate::agent::tools::ToolEvent>,
    },
    /// A tailer read lines off its background-task files. Routed through the actor so
    /// each gets its agent's root terminal.
    TaskLines {
        lines: Vec<crate::logstream::LineDraft>,
    },
    /// A tailer read Bash calls that route around the capture proxy. Routed
    /// through the actor so each gets its agent's root terminal, then into the netcap ring
    /// as `bypass` rows.
    Bypasses {
        events: Vec<crate::agent::tools::BypassEvent>,
    },
    /// Install the ad-hoc-detection hook for a workspace `root` opened without
    /// spawning a terminal (the multi-root Files "Open a folder").
    /// Terminal/agent spawn already installs it; this covers a folder the user
    /// opens but never launches a terminal in. Idempotent + non-fatal.
    EnsureAgentHooks {
        root: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// A terminal's shell `cd`'d into a new directory. Sent by that
    /// terminal's cwd poller ([`spawn_cwd_poller`]) each time the polled cwd
    /// *changes*, so the actor can install the ad-hoc hook at the new cwd's git root
    /// — extending detection to repos the app never explicitly opened, as the user
    /// moves around. Carries only the cwd (like `EnsureAgentHooks`/`FanoutDelta`,
    /// not the terminal id): the install is keyed purely by cwd→git-root and is
    /// idempotent, and the poller's own lifetime — aborted on close/exit — is what
    /// scopes it to a live terminal. Fire-and-forget; no reply.
    CwdChanged { cwd: String },
    /// Read the internal facts needed to pin a root agent. Answered from
    /// live state so the `pin_agent` command can write the store WITHOUT the session
    /// id ever crossing the JS wire. `None` when the id is unknown or not a pinnable
    /// root (a sub-agent).
    DescribeAgent {
        agent_id: AgentId,
        reply: oneshot::Sender<Option<PinnableAgent>>,
    },
    /// Every Claude session id the IDE owns (the Agent Village): each root's
    /// `session_key` plus every live binding. Answered in-process so
    /// `list_external_agents` can leave the IDE's own sessions out of the "outside
    /// the IDE" list WITHOUT those ids ever crossing the JS wire.
    OwnedSessionIds {
        reply: oneshot::Sender<std::collections::HashSet<String>>,
    },
    /// Re-open the agents of the last session (`open_agents::restore_on_boot`): the
    /// registry's open entries plus `pins`, once each, minus `already_running` (empty in
    /// phase 1), each down the restore ladder. Enqueued synchronously from `setup`,
    /// before the webview can ask for a snapshot — the FIFO is what guarantees the first
    /// snapshot has them.
    Restore {
        pins: Vec<PinnedAgent>,
        already_running: std::collections::HashSet<String>,
    },
    /// The app is quitting (sent by [`SupervisorHandle::begin_shutdown`], AFTER the
    /// shutting-down flag is raised): record which open agents were working, in one
    /// write, and confirm. A `std` channel because the caller is the event-loop thread,
    /// blocking with a budget — not an async task.
    Shutdown {
        reply: std::sync::mpsc::SyncSender<()>,
    },
    /// The "Resumed after restart" markers still standing (see [`Restart::restored`]).
    RestoredAgents {
        reply: oneshot::Sender<Vec<RestoredAgent>>,
    },
}

/// Internal live state — **not** part of the wire contract (ARCHITECTURE §2.5).
struct TerminalRuntime {
    meta: TerminalMeta,
    /// `None` once the child has exited: the PTY is torn down but the metadata
    /// (status/exitCode) survives for the UI.
    pty: Option<PtyHandle>,
    /// The coalescer. Ends by itself when the reader's mpsc closes; held so we
    /// can abort it on an explicit close.
    pump: tauri::async_runtime::JoinHandle<()>,
    /// Control channel to the pump: `terminal_reattach` sends `Reattach(new)` here
    /// to swap the output sink after a webview reload. Dropped on
    /// teardown, which ends the pump.
    pump_ctrl: mpsc::Sender<crate::stream::coalesce::PumpControl>,
    /// The per-terminal cwd poller: watches the shell child's working
    /// directory and, on each change, sends [`SupervisorMsg::CwdChanged`] so the
    /// hook is (re)installed at the new git root. Aborted on child exit and on
    /// close — a dropped tokio `JoinHandle` *detaches* (keeps polling a dead pid
    /// forever), it does not cancel, exactly like the fan-out tailer.
    cwd_poll: tauri::async_runtime::JoinHandle<()>,
}

/// One agent: its wire node plus the internals the wire must not carry.
struct AgentRuntime {
    node: AgentNode,
    /// The terminal this agent's process runs in, for a **root** (spawned or
    /// ad-hoc): `TerminalId ↔ AgentId` is a recorded fact that lets `ChildExited`
    /// update the right node. **`None` for a sub-agent** (M3) — sub-agents are
    /// pure forest records with no PTY of their own, so no terminal maps to them.
    terminal_id: Option<TerminalId>,
    /// The runtime's own session identity. For a **spawned** agent this is the
    /// minted `--session-id`; for an **ad-hoc** one it is the
    /// `session_id` the hook reported. Either way it is M3's foundation: the tailer
    /// is handed the exact transcript identity rather than inferring it from the
    /// cwd (which cannot tell two agents in one directory apart). Unread until M3.
    #[allow(dead_code)]
    session_key: SessionKey,
    /// Absolute transcript path, when a hook told us (always for ad-hoc; for
    /// spawned only once its own `SessionStart` arrives). M3's tailer reads this
    /// directly instead of computing a path — the cwd→dir mangling is dead.
    #[allow(dead_code)]
    transcript_path: Option<String>,
    /// `true` for an agent detected from a typed `claude` (ad-hoc); `false` for
    /// one spawned via `+`. The distinction matters at session end: an ad-hoc
    /// agent's `claude` is a *child inside the shell*, so when it ends only the
    /// hook's `SessionEnd` tells us (the PTY child — the shell — lives on). A
    /// spawned agent's `claude` *is* the PTY child, so `on_child_exited` owns its
    /// status with the real exit code, and `SessionEnd` must not pre-empt it.
    is_ad_hoc: bool,
    /// The fan-out tailer task for a **root** (M3): polls this session's transcript
    /// and reports sub-agents via `SupervisorMsg::FanoutDelta`. `None` for a
    /// sub-agent (they don't own a tailer — their root's tailer sees them). Aborted
    /// when the agent is removed, or it would outlive its node.
    tailer: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Cheap to clone into Tauri's managed state.
#[derive(Clone)]
pub struct SupervisorHandle {
    tx: mpsc::Sender<SupervisorMsg>,
    /// The live terminal table the actor publishes for dev-app discovery.
    ide: IdeTerminals,
    /// The registry's shutting-down flag — the ONLY part of the registry the handle
    /// holds (the actor is its one writer). Raised by [`Self::begin_shutdown`]; once up,
    /// no PTY exit or close removes an agent from `open-agents.json`.
    shutdown: ShutdownFlag,
}

impl SupervisorHandle {
    /// The table of live terminals (PTY child pid → terminal, title, tty, bound agent)
    /// that dev-app discovery reads to say "this app runs in IDE terminal X, started by
    /// agent Y". Lock-cheap and never touched by the actor
    /// loop except for a pointer swap when it changes — see [`publish_ide_terminals`].
    pub fn ide_terminals(&self) -> IdeTerminals {
        self.ide.clone()
    }

    async fn send(&self, msg: SupervisorMsg) -> Result<(), String> {
        self.tx
            .send(msg)
            .await
            .map_err(|_| "supervisor is not running".to_string())
    }

    pub async fn open_terminal(
        &self,
        spec: OpenSpec,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<TerminalMeta, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::OpenTerminal {
            spec,
            channel,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    /// [`SupervisorHandle::open_terminal`] with `env` added to the child's environment
    /// (see [`SupervisorMsg::OpenTerminalWithEnv`]).
    pub async fn open_terminal_with_env(
        &self,
        spec: OpenSpec,
        env: Vec<(String, String)>,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<TerminalMeta, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::OpenTerminalWithEnv {
            spec,
            env,
            channel,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    /// Re-bind a live terminal to a fresh output `Channel` after a webview reload.
    /// See [`reattach_terminal`] for the live/exited/missing semantics.
    pub async fn reattach(
        &self,
        id: TerminalId,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<TerminalMeta, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::Reattach { id, channel, reply })
            .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    pub async fn spawn_agent(
        &self,
        spec: AgentSpawnSpec,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<TerminalMeta, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::SpawnAgent {
            spec,
            channel,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    pub async fn write(&self, id: TerminalId, data: Vec<u8>) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::Write { id, data, reply }).await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    pub async fn resize(&self, id: TerminalId, rows: u16, cols: u16) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::Resize {
            id,
            rows,
            cols,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    pub async fn close(&self, id: TerminalId) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::Close { id, reply }).await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    /// Initial paint and restart re-attach (ARCHITECTURE §2.4).
    pub async fn snapshot(&self) -> Result<FleetSnapshot, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::Snapshot { reply }).await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())
    }

    /// Which of `ids` are busy right now (the close confirmation). Only busy
    /// terminals come back; idle, exited and unknown ids are absent rather than an
    /// error — the UI is about to close them either way, and a hard error here would
    /// strand the user in a tab they cannot close.
    pub async fn terminals_busy(&self, ids: Vec<TerminalId>) -> Result<Vec<TerminalBusy>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::TerminalsBusy { ids, reply })
            .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())
    }

    /// Install the ad-hoc-detection hook for a workspace `root` that was opened
    /// without spawning a terminal. Idempotent + non-fatal: resolves
    /// `Ok` even when the write was skipped, so a failure never breaks the UI.
    pub async fn ensure_agent_hooks(&self, root: String) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::EnsureAgentHooks { root, reply })
            .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())?
    }

    /// The internal facts needed to pin `agent_id`, or `None` if it is
    /// unknown or not a pinnable root. Used by the `pin_agent` command so the
    /// session id is read in-process and never crosses the JS wire.
    pub async fn describe_pinnable(
        &self,
        agent_id: AgentId,
    ) -> Result<Option<PinnableAgent>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::DescribeAgent { agent_id, reply })
            .await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())
    }

    /// The session ids of every agent the IDE runs (see
    /// [`SupervisorMsg::OwnedSessionIds`]) — for the Agent Village's external scan,
    /// which must not show an IDE agent twice. Never sent to the UI.
    pub async fn owned_session_ids(&self) -> Result<std::collections::HashSet<String>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::OwnedSessionIds { reply }).await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())
    }

    /// Re-open the last session's agents (`open_agents::restore_on_boot`). **Synchronous
    /// on purpose**: called from `setup`, it puts the restore in the actor's queue before
    /// the webview exists, so no `fleet_snapshot` can overtake it (the actor is a FIFO).
    ///
    /// `already_running`: agents that must NOT be launched because they are alive
    /// elsewhere — always empty in phase 1; phase 2's host passes its live agents.
    pub fn restore(
        &self,
        pins: Vec<PinnedAgent>,
        already_running: std::collections::HashSet<String>,
    ) -> Result<(), String> {
        self.tx
            .try_send(SupervisorMsg::Restore {
                pins,
                already_running,
            })
            .map_err(|e| format!("supervisor refused the restore: {e}"))
    }

    /// The app is shutting down. Raises the shutting-down flag FIRST — synchronously,
    /// so every PTY exit or close the actor handles from now on leaves the agent in
    /// `open-agents.json` (phase 1 of "agents survive a restart") — then asks the actor
    /// to record which agents were working and waits up to `budget` for that one write.
    ///
    /// Idempotent: only the first call does anything (the main window's destruction,
    /// `ExitRequested` and `Exit` can all arrive for one quit). Returns whether THIS
    /// call saw the write confirmed. Blocking — call it from the event-loop thread, not
    /// from inside the async runtime the actor runs on.
    pub fn begin_shutdown(&self, budget: std::time::Duration) -> bool {
        if !self.shutdown.raise() {
            return false;
        }
        let (reply, rx) = std::sync::mpsc::sync_channel(1);
        if self.tx.try_send(SupervisorMsg::Shutdown { reply }).is_err() {
            return false;
        }
        rx.recv_timeout(budget).is_ok()
    }

    /// The agents the boot restore brought back whose marker still stands (see
    /// [`Restart::restored`]). For the `restored_agents` command; ordered by id.
    pub async fn restored_agents(&self) -> Result<Vec<RestoredAgent>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(SupervisorMsg::RestoredAgents { reply }).await?;
        rx.await
            .map_err(|_| "supervisor dropped the reply".to_string())
    }

    /// Deliver a token-checked hook POST (from the listener) — fire-and-forget.
    ///
    /// Non-blocking `try_send`: the hook path must never stall (the `curl` on the
    /// far side has a short timeout), and the control queue is deep, so a rare drop
    /// under impossible load is preferable to backpressuring a session's `curl`.
    pub fn deliver_hook(&self, terminal_id: TerminalId, body: Vec<u8>) {
        let _ = self
            .tx
            .try_send(SupervisorMsg::HookReceived { terminal_id, body });
    }

    /// Inject a fan-out delta directly (bypassing the tailer). The tailer uses the
    /// internal `tx`; this exists so the wiring — `Spawned` → `SubagentSpawned` + a
    /// node, `StatusChanged` → `Status` — is testable without the real transcript
    /// polling loop and its `~/.claude` glob.
    pub async fn deliver_fanout_delta(
        &self,
        delta: crate::agent::fanout::FanoutDelta,
    ) -> Result<(), String> {
        self.send(SupervisorMsg::FanoutDelta { delta }).await
    }
}

/// Everything the actor owns.
struct Fleet {
    terminals: HashMap<TerminalId, TerminalRuntime>,
    agents: HashMap<AgentId, AgentRuntime>,
    /// **The binding table**: `terminal_id → live root session_id`.
    /// A spawned agent's terminal is bound at spawn; an ad-hoc one on its first
    /// `SessionStart`. Presence of a *different* session on a terminal is exactly
    /// what marks a nested `claude` as a phantom root to suppress. Unbound on the
    /// union of `SessionEnd` and PTY child exit.
    bindings: HashMap<TerminalId, String>,
    /// Every session id the IDE has owned this run — grows only, never pruned on
    /// close, exit, evict or rebind. The Agent Village's external scan subtracts it,
    /// so a session the user just closed here (its transcript still inside the
    /// village window) never comes back as an "outside the IDE" character.
    owned_sessions: std::collections::HashSet<String>,
    adapters: Vec<Arc<dyn AgentAdapter>>,
    sink: Arc<dyn EventSink>,
    /// Listener URL + token to inject into every PTY, when a listener is running.
    /// `None` in tests that exercise the fleet without the hook pipeline.
    hook: Option<HookConfig>,
    /// The Agent Logs hub. `None` runs the fleet without it —
    /// no tap in any pump, no transcript tool tail.
    logs: Option<LogHub>,
    /// The terminal table dev-app discovery reads, republished after every
    /// message by [`publish_ide_terminals`].
    ide: IdeTerminals,
    /// Open agents come back after a restart (`open_agents.rs`): the registry this
    /// actor is the one writer of, and the restore markers.
    restart: Restart,
}

/// The actor's half of "open agents come back after a restart" (phase 1,
/// `open_agents.rs`). `Default` is the inert form every test fleet uses: a registry with
/// no path, so nothing is ever written.
#[derive(Default)]
struct Restart {
    /// `open-agents.json` behind its small writer API. Inert (no path) for every
    /// `cargo test` supervisor and any headless use; only `lib.rs`'s real boot gives it a
    /// path (no store I/O in a path the test suite drives with a real dir).
    registry: Registry,
    /// One "Resumed after restart" marker per agent the boot restore brought back. Taken
    /// down when the agent starts its next turn (the user talked to it), when it ends, or
    /// when it is closed — so a webview reload re-reads the truth, never a stale marker.
    restored: HashMap<AgentId, RestoredAgent>,
}

impl Fleet {
    fn adapter(&self, runtime: &str) -> Result<&Arc<dyn AgentAdapter>, String> {
        self.adapters
            .iter()
            .find(|a| a.id() == runtime)
            .ok_or_else(|| {
                let known: Vec<&str> = self.adapters.iter().map(|a| a.id()).collect();
                format!("unknown runtime: {runtime} (known: {})", known.join(", "))
            })
    }

    /// `fleet_snapshot`'s payload. Ordered by id so the UI paints deterministically
    /// (ids are ULIDs, so this is also creation order).
    fn snapshot(&self) -> FleetSnapshot {
        let mut agents: Vec<AgentNode> = self.agents.values().map(|a| a.node.clone()).collect();
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        let mut terminals: Vec<TerminalMeta> =
            self.terminals.values().map(|t| t.meta.clone()).collect();
        terminals.sort_by(|a, b| a.id.cmp(&b.id));
        FleetSnapshot { agents, terminals }
    }
}

/// Spawn the supervisor actor. Register the returned handle as managed state:
/// `app.manage(spawn_supervisor(sink, adapters, hook))`.
///
/// `sink`, `adapters` and `hook` are injected rather than constructed here so the
/// whole agent lifecycle is testable: the tests pass a recording sink and a stub
/// adapter and never spawn a real `claude` (which would need auth and a network).
/// `hook` is the running listener's config, or `None` to run the fleet without the
/// ad-hoc pipeline.
pub fn spawn_supervisor(
    sink: Arc<dyn EventSink>,
    adapters: Vec<Arc<dyn AgentAdapter>>,
    hook: Option<HookConfig>,
) -> SupervisorHandle {
    spawn_supervisor_with_logs(sink, adapters, hook, None)
}

/// [`spawn_supervisor`] plus the Agent Logs hub: every PTY's pump gets a tap, bound
/// sessions suppress their terminal's output lines, lifecycle becomes `system` lines,
/// and each root's fan-out tailer also tails tool calls.
pub fn spawn_supervisor_with_logs(
    sink: Arc<dyn EventSink>,
    adapters: Vec<Arc<dyn AgentAdapter>>,
    hook: Option<HookConfig>,
    logs: Option<LogHub>,
) -> SupervisorHandle {
    spawn_supervisor_with_store(sink, adapters, hook, logs, None)
}

/// [`spawn_supervisor_with_logs`] plus the open-agents registry (`open_agents.rs`):
/// with `Some(path)`, every spawned root is recorded there and comes back on the next
/// launch. The path is injected so the tests point it at a temp dir; `lib.rs` passes
/// the real app-config file.
pub fn spawn_supervisor_with_store(
    sink: Arc<dyn EventSink>,
    adapters: Vec<Arc<dyn AgentAdapter>>,
    hook: Option<HookConfig>,
    logs: Option<LogHub>,
    open_agents_store: Option<PathBuf>,
) -> SupervisorHandle {
    let (tx, mut rx) = mpsc::channel::<SupervisorMsg>(SUPERVISOR_QUEUE);
    let ide = IdeTerminals::default();
    let registry = open_agents_store.map_or_else(Registry::inert, Registry::at);
    let handle = SupervisorHandle {
        tx: tx.clone(),
        ide: ide.clone(),
        shutdown: registry.shutdown_flag(),
    };

    tauri::async_runtime::spawn(async move {
        let mut fleet = Fleet {
            terminals: HashMap::new(),
            agents: HashMap::new(),
            bindings: HashMap::new(),
            owned_sessions: std::collections::HashSet::new(),
            adapters,
            sink,
            hook,
            logs,
            ide,
            restart: Restart {
                registry,
                restored: HashMap::new(),
            },
        };

        while let Some(msg) = rx.recv().await {
            match msg {
                SupervisorMsg::OpenTerminal {
                    spec,
                    channel,
                    reply,
                } => {
                    let res = open_plain_terminal(&mut fleet, &tx, spec, Vec::new(), channel);
                    let _ = reply.send(res);
                }

                SupervisorMsg::OpenTerminalWithEnv {
                    spec,
                    env,
                    channel,
                    reply,
                } => {
                    let res = open_plain_terminal(&mut fleet, &tx, spec, env, channel);
                    let _ = reply.send(res);
                }

                SupervisorMsg::SpawnAgent {
                    spec,
                    channel,
                    reply,
                } => {
                    let res = spawn_agent(&mut fleet, &tx, spec, channel);
                    let _ = reply.send(res);
                }

                SupervisorMsg::Write { id, data, reply } => {
                    let res = match fleet.terminals.get_mut(&id) {
                        Some(rt) => match rt.pty.as_mut() {
                            Some(pty) => pty.write_input(&data).map_err(|e| e.to_string()),
                            // Writing to an exited terminal is a no-op, not an
                            // error: a keystroke can race the child's exit.
                            None => Ok(()),
                        },
                        None => Err(format!("unknown terminal: {id}")),
                    };
                    let _ = reply.send(res);
                }

                SupervisorMsg::Resize {
                    id,
                    rows,
                    cols,
                    reply,
                } => {
                    let res = match fleet.terminals.get(&id) {
                        Some(rt) => match rt.pty.as_ref() {
                            Some(pty) => pty.resize(rows, cols).map_err(|e| e.to_string()),
                            None => Ok(()),
                        },
                        None => Err(format!("unknown terminal: {id}")),
                    };
                    if let Some(rt) = fleet.terminals.get_mut(&id) {
                        if res.is_ok() {
                            rt.meta.rows = rows;
                            rt.meta.cols = cols;
                            if let Some(hub) = &fleet.logs {
                                hub.resize(&id, rows, cols);
                            }
                        }
                    }
                    let _ = reply.send(res);
                }

                SupervisorMsg::Reattach { id, channel, reply } => {
                    let res = reattach_terminal(&mut fleet, &id, channel);
                    let _ = reply.send(res);
                }

                SupervisorMsg::ChildExited { id, code } => {
                    on_child_exited(&mut fleet, &id, code);
                }

                SupervisorMsg::HookReceived { terminal_id, body } => {
                    on_hook_received(&mut fleet, &tx, &terminal_id, &body);
                }

                SupervisorMsg::FanoutDelta { delta } => {
                    on_fanout_delta(&mut fleet, delta);
                }

                SupervisorMsg::ToolEvents { events } => {
                    on_tool_events(&fleet, events);
                }

                SupervisorMsg::TaskLines { lines } => {
                    on_task_lines(&fleet, lines);
                }

                SupervisorMsg::Bypasses { events } => {
                    on_bypasses(&fleet, events);
                }

                SupervisorMsg::EnsureAgentHooks { root, reply } => {
                    // A folder opened without a terminal. Install the
                    // git-root-aware hook so a `claude` typed in a terminal opened
                    // here later is detected. Gated on a live listener (the hook is
                    // inert without one) and best-effort — always reply Ok, even when
                    // the write is skipped (home dir, symlink, or no listener).
                    if fleet.hook.is_some() {
                        install_ad_hoc_hooks(&fleet, &root);
                    }
                    let _ = reply.send(Ok(()));
                }

                SupervisorMsg::CwdChanged { cwd } => {
                    on_cwd_changed(&fleet, &cwd);
                }

                SupervisorMsg::DescribeAgent { agent_id, reply } => {
                    let _ = reply.send(describe_pinnable(&fleet, &agent_id));
                }

                SupervisorMsg::OwnedSessionIds { reply } => {
                    let _ = reply.send(owned_session_ids(&fleet));
                }

                SupervisorMsg::Restore {
                    pins,
                    already_running,
                } => {
                    let plan = fleet
                        .restart
                        .registry
                        .entries_to_restore(&pins, &already_running);
                    restore_agents(&mut fleet, &tx, plan);
                }

                SupervisorMsg::Shutdown { reply } => {
                    fleet
                        .restart
                        .registry
                        .record_working(&working_at_shutdown(&fleet));
                    let _ = reply.send(());
                }

                SupervisorMsg::RestoredAgents { reply } => {
                    let mut list: Vec<RestoredAgent> =
                        fleet.restart.restored.values().cloned().collect();
                    list.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
                    let _ = reply.send(list);
                }

                SupervisorMsg::Snapshot { reply } => {
                    let _ = reply.send(fleet.snapshot());
                }

                SupervisorMsg::TerminalsBusy { ids, reply } => {
                    let _ = reply.send(busy_terminals(&fleet, &ids));
                }

                SupervisorMsg::Close { id, reply } => {
                    // Dropping the runtime kills the child (PtyHandle::drop) and
                    // closes the PTY; the reader thread and coalescer unwind on
                    // their own. Abort the pump so nothing lingers if the child
                    // ignored the kill.
                    let res = match fleet.terminals.remove(&id) {
                        Some(rt) => {
                            drop(rt.pty);
                            rt.pump.abort();
                            // Stop the cwd poller too, or a detached (not cancelled)
                            // tokio handle would keep polling the now-dead pid.
                            rt.cwd_poll.abort();
                            // A close is the user saying "gone, for good" — so
                            // *remove* the agent from the forest rather than keeping
                            // it as a `done` node. A later `fleet_snapshot` must not
                            // bring it back. (A natural exit takes the other path,
                            // `on_child_exited`, and is retained for inspection.)
                            // No-op for a plain terminal: it has no agent.
                            fleet.bindings.remove(&id);
                            if let Some(hub) = &fleet.logs {
                                let source = log_source_of(hub, &id, &rt.meta.title, &rt.meta.cwd);
                                hub.push(LineDraft::system(
                                    Some(&id),
                                    rt.meta.agent_id.as_deref(),
                                    &source,
                                    LogLevel::Info,
                                    "terminal closed",
                                ));
                                hub.forget(&id);
                            }
                            remove_agent_for_terminal(&mut fleet, &id);
                            // The user closed it: it does not come back next launch
                            // (unless the app is the one closing — `Registry::remove`).
                            // A plain console was never recorded: a no-op, no write.
                            fleet.restart.registry.remove(&id);
                            fleet.restart.restored.remove(&id);
                            Ok(())
                        }
                        None => Err(format!("unknown terminal: {id}")),
                    };
                    let _ = reply.send(res);
                }
            }
            // Whatever that message did to terminals, bindings or titles, the table
            // dev-app discovery reads follows it. After the reply, so a caller
            // never waits on it; a scan polled 3 s apart cannot tell the microseconds.
            publish_ide_terminals(&fleet);
            // Same "after every message" rule for the run-scoped owned-session set:
            // whatever bound or created a root, it is remembered before any later
            // close/evict can take it out of the fleet.
            remember_owned_sessions(&mut fleet);
        }
    });

    handle
}

/// Rebuild the `{ PTY child pid → terminal }` table dev-app discovery reads
/// and publish it **only when it changed**.
///
/// Run after every message, keystrokes included, on purpose: enumerating "the messages
/// that can change a terminal, a binding or a title" is a list a future message would
/// silently fall off. The rebuild is a walk over the live terminals (a handful) and a
/// comparison under a read lock; the write lock is taken — for a pointer swap — only on
/// open / exit / close / bind / unbind / rename. procscan's side holds the read lock for
/// one `Arc` clone, so the actor loop never waits on a scan.
///
/// A terminal whose child has exited (`pty: None`) is not in the table: its pid is free
/// for the OS to reuse, and a stranger's process must never be attributed to it. The
/// agent is the **bound** root (the binding table) — a terminal whose session
/// ended keeps its `agent_id` in the meta but no longer lends it to what runs there.
fn publish_ide_terminals(fleet: &Fleet) {
    let table: HashMap<u32, IdeTerminal> = fleet
        .terminals
        .iter()
        .filter_map(|(id, rt)| {
            let pty = rt.pty.as_ref()?;
            let pid = pty.child_pid()?;
            let agent_id = rt
                .meta
                .agent_id
                .clone()
                .filter(|_| fleet.bindings.contains_key(id));
            let agent_title = agent_id
                .as_ref()
                .and_then(|a| fleet.agents.get(a))
                .map(|a| a.node.title.clone());
            Some((
                pid,
                IdeTerminal {
                    terminal_id: id.clone(),
                    title: rt.meta.title.clone(),
                    tty: pty.tty_name(),
                    agent_id,
                    agent_title,
                },
            ))
        })
        .collect();
    fleet.ide.publish(table);
}

/// `terminal_open`: a plain shell terminal, no agent attached.
fn open_plain_terminal(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    spec: OpenSpec,
    env: Vec<(String, String)>,
    channel: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    let program = spec.program.unwrap_or_else(pty::default_shell);
    let title = program_title(&program);
    // Windows PowerShell: `curl` must be the real curl (see `pty::shell_startup_args`).
    let args = pty::shell_startup_args(&program, spec.args, cfg!(windows));

    // Never let a stray "." / empty cwd reach the PTY — it resolves to the app
    // binary's dir (the wrong-project / no-history bug). Substitute the default
    // workspace.
    let cwd = crate::workspace::resolve_cwd(&spec.cwd);

    // Install the ad-hoc binding hook in this cwd BEFORE the shell starts, so a
    // `claude` the user types immediately picks it up. Best-effort and
    // non-fatal: a failure just means this terminal's ad-hoc `claude`s won't be
    // auto-detected — the terminal still opens normally.
    if fleet.hook.is_some() {
        install_ad_hoc_hooks(fleet, &cwd);
    }

    open_terminal(
        fleet,
        tx,
        OpenParams {
            terminal_id: spec.terminal_id,
            kind: TerminalKind::Terminal,
            title,
            agent_id: None,
            spec: SpawnSpec {
                program,
                args,
                cwd: cwd.clone().into(),
                env,
                rows: spec.rows,
                cols: spec.cols,
            },
            cwd,
        },
        channel,
    )
}

/// `agent_spawn`: an agent terminal plus its node in the forest.
///
/// Deliberately built on the same [`open_terminal`] as a plain terminal — an agent
/// is *a terminal whose argv an adapter chose*, not a second PTY implementation.
fn spawn_agent(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    spec: AgentSpawnSpec,
    channel: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    if fleet.agents.contains_key(&spec.agent_id) {
        return Err(format!("agent already exists: {}", spec.agent_id));
    }

    let adapter = fleet.adapter(&spec.runtime)?.clone();
    // Same cwd hygiene as a plain terminal: a stray "." must not resolve to the
    // binary dir. Resolve once, before the adapter spawns in it.
    let cwd = crate::workspace::resolve_cwd(&spec.cwd);
    let cwd_path = std::path::PathBuf::from(&cwd);

    // The adapter resolves its binary and mints (or, on restore, imposes) the
    // session identity. Failing here (e.g. `claude` not installed) must leave
    // nothing behind.
    let resume = spec
        .resume_session_id
        .as_ref()
        .map(|s| SessionKey(s.clone()));
    let spawned = adapter
        .spawn(&SpawnRequest {
            agent_id: &spec.agent_id,
            cwd: &cwd_path,
            prompt: spec.prompt.as_deref(),
            resume_session_id: resume.as_ref(),
            rows: spec.rows,
            cols: spec.cols,
        })
        .map_err(|e| format!("{e:#}"))?;

    // The agent's terminal shares the id space with plain terminals; the UI holds
    // both in one map.
    let terminal_id = spec.agent_id.clone();
    let title = adapter.default_title().to_string();
    let branch = crate::git::current_branch(&cwd_path);

    let meta = open_terminal(
        fleet,
        tx,
        OpenParams {
            terminal_id: terminal_id.clone(),
            kind: TerminalKind::AgentTerminal,
            title: title.clone(),
            agent_id: Some(spec.agent_id.clone()),
            spec: spawned.spec,
            cwd: cwd.clone(),
        },
        channel,
    )?;

    let now = now_ms();
    let node = AgentNode {
        id: spec.agent_id.clone(),
        // M2 only creates roots. M3's tailer supplies sub-agent edges.
        parent_id: None,
        kind: AgentKind::Orchestrator,
        title,
        // Born IDLE, not Running: a just-spawned `claude` sits at its prompt and
        // has not processed a turn yet. `UserPromptSubmit` flips it to Running;
        // `Stop` back to Idle (turn hooks). A `Running` default was a latch that never
        // cleared for a session that never runs a turn — a fresh welcome screen
        // never emits `Stop`, so it showed "Running" forever.
        status: AgentStatus::Idle,
        branch: branch.clone(),
        cwd: cwd.clone(),
        runtime: adapter.id().to_string(),
        started_at: Some(now),
        finished_at: None,
        last_activity_at: now,
        error: None,
    };

    // Bind the terminal to its session AT SPAWN. This is what
    // neutralises the phantom-root trap: when this agent later shells out
    // `claude -p`, that nested `SessionStart` lands on an already-bound terminal
    // with a *different* session id and is suppressed, instead of forging a
    // second root. `session_key` == the `--session-id` we minted == the
    // `session_id` claude reports.
    fleet
        .bindings
        .insert(terminal_id.clone(), spawned.session_key.0.clone());
    fleet.owned_sessions.insert(spawned.session_key.0.clone());
    sync_log_suppression(fleet, &terminal_id);

    // Start the fan-out tailer for this root, keyed off the session we minted (M3).
    // Selected by the runtime we actually spawned, so it starts immediately even
    // though `claude`'s transcript does not exist yet.
    let tailer = start_fanout_tailer(
        fleet,
        tx,
        &spec.agent_id,
        &spawned.session_key.0,
        adapter.id(),
    );

    // Written on spawn (phase 1 of "agents survive a restart"): this root comes back
    // on the next launch until the user closes it or its own process ends. A restore's
    // fresh fallback lands here too, which is what replaces the dead session id.
    let entry = OpenAgent {
        agent_id: spec.agent_id.clone(),
        cwd: cwd.clone(),
        runtime: adapter.id().to_string(),
        session_id: spawned.session_key.0.clone(),
        was_working: None,
    };
    if let Err(e) = fleet.restart.registry.record(entry) {
        eprintln!(
            "open-agents: could not record {} (non-fatal): {e}",
            spec.agent_id
        );
    }

    fleet.agents.insert(
        spec.agent_id.clone(),
        AgentRuntime {
            node: node.clone(),
            terminal_id: Some(terminal_id),
            session_key: spawned.session_key,
            transcript_path: None,
            is_ad_hoc: false,
            tailer,
        },
    );

    fleet.sink.emit(&AgentEvent::AgentStarted {
        agent_id: node.id.clone(),
        parent_id: None,
        title: node.title.clone(),
        cwd: node.cwd.clone(),
        branch,
        runtime: node.runtime.clone(),
    });
    log_agent_started(fleet, &node.id);

    Ok(meta)
}

/// The source label a terminal's lines carry: the one the hub gave it at `tap` (unique among
/// open terminals), else the plain `"<title> · <cwd basename>"`.
fn log_source_of(hub: &LogHub, terminal_id: &str, title: &str, cwd: &str) -> String {
    hub.source_of(terminal_id)
        .unwrap_or_else(|| source_label(title, cwd))
}

/// Everything [`open_terminal`] needs, whichever caller chose it.
struct OpenParams {
    terminal_id: TerminalId,
    kind: TerminalKind,
    title: String,
    agent_id: Option<AgentId>,
    spec: SpawnSpec,
    /// The cwd as the UI spelled it, for `TerminalMeta` (which is a `String`).
    cwd: String,
}

/// Open one terminal: PTY → reader thread → coalescer → the UI's `Channel`.
/// Synchronous by design — nothing here awaits, so the actor loop never stalls.
///
/// The single PTY path, shared by plain terminals and agents alike.
fn open_terminal(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    mut params: OpenParams,
    channel: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    if fleet.terminals.contains_key(&params.terminal_id) {
        return Err(format!("terminal already open: {}", params.terminal_id));
    }

    // Inject the ad-hoc-detection env into EVERY PTY: whatever the user
    // runs — including a `claude` they type — inherits our terminal id, callback
    // URL and token, so it can phone home. Harmless to a plain shell; the hook that
    // reads these is inert unless they are set.
    inject_hook_env(fleet, &params.terminal_id, &mut params.spec);
    // …and the capture-proxy env: every PTY's HTTP/WS/gRPC
    // traffic is attributable to it in the Network tab. Empty when capture is off or
    // the user's environment already names a proxy.
    params
        .spec
        .env
        .extend(crate::netcap::pty_env(&params.terminal_id));
    // …and the `agent-studio` command (agent_ctl::tools). Last, because it prepends to the
    // PATH the capture env may have just set.
    crate::agent_ctl::tools::apply_env(&mut params.spec.env);

    let rows = params.spec.rows;
    let cols = params.spec.cols;
    let spawn = pty::spawn_pty(&params.spec).map_err(|e| format!("{e:#}"))?;

    let pty::PtySpawn {
        handle,
        reader,
        mut child,
    } = spawn;

    // The shell child's pid, recorded on the handle at spawn (see
    // `PtyHandle::child_pid`) — read here rather than off `child`, which is about to
    // be moved into the waiter thread. The cwd poller needs it to read the process's
    // working directory, and the close-confirmation's tier 2 compares it against the
    // tty's foreground process group. A `None` (portable-pty could not report one)
    // just means no cwd tracking and no foreground check for this terminal.
    let child_pid = handle.child_pid();

    // Hot path, off the actor: blocking reader thread → bounded mpsc(256) →
    // coalescer → Channel. The `pump_ctrl` channel is how a later
    // `terminal_reattach` swaps in a fresh Channel after a webview reload;
    // depth 1 is enough (re-attach is rare and one-at-a-time per terminal).
    // The Agent Logs tap. An agent terminal starts
    // suppressed: its session is bound from birth (`spawn_agent` binds right after
    // this returns), and suppressing only then would leak the runtime's first paint.
    // The "opened" line is queued BEFORE the reader starts, so it always precedes the
    // terminal's first output line in the log.
    // The tap is registered first: it settles the terminal's source label (unique among open
    // terminals — `LogHub::tap`), which the "opened" line must carry too. The hub also learns
    // the PTY size (the Windows screen model needs it — `logstream::screen`).
    let tap = fleet.logs.as_ref().map(|hub| {
        let tap = hub.tap(
            &params.terminal_id,
            &source_label(&params.title, &params.cwd),
            params.agent_id.is_some(),
        );
        hub.resize(&params.terminal_id, rows, cols);
        hub.push(LineDraft::system(
            Some(&params.terminal_id),
            params.agent_id.as_deref(),
            &log_source_of(hub, &params.terminal_id, &params.title, &params.cwd),
            LogLevel::Info,
            format!("terminal opened · {} in {}", params.title, params.cwd),
        ));
        tap
    });
    let rx = crate::pty::reader::start_reader(reader);
    let (pump_ctrl, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    let pump = tauri::async_runtime::spawn(pump_to_ui_tapped(rx, ctrl_rx, channel, tap));

    // Waiter: a dedicated thread parked in the blocking `wait()`. We hold the
    // killer separately (in PtyHandle), so a close can still terminate the child.
    let exit_tx = tx.clone();
    let exit_id = params.terminal_id.clone();
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => Some(status.exit_code() as i32),
            Err(_) => None,
        };
        // Fails only if the supervisor is already gone — nothing to report to.
        let _ = exit_tx.blocking_send(SupervisorMsg::ChildExited { id: exit_id, code });
    });

    // The cwd poller: as the user `cd`s the shell around, install the
    // ad-hoc hook at each new repo's git root. Off the actor thread; it only reads
    // the process cwd and routes changes back as `CwdChanged`. Aborted on child exit
    // / close so it never polls a dead pid forever.
    let cwd_poll = spawn_cwd_poller(tx.clone(), child_pid);

    let meta = TerminalMeta {
        id: params.terminal_id.clone(),
        kind: params.kind,
        title: params.title,
        cwd: params.cwd,
        cols,
        rows,
        status: TerminalStatus::Live,
        exit_code: None,
        agent_id: params.agent_id,
    };

    fleet.terminals.insert(
        params.terminal_id,
        TerminalRuntime {
            meta: meta.clone(),
            pty: Some(handle),
            pump,
            pump_ctrl,
            cwd_poll,
        },
    );

    Ok(meta)
}

/// Re-bind a live terminal to a fresh output `Channel` after a webview reload.
/// Returns the terminal's meta:
/// - **live** → swap the pump's sink, replay the scrollback ring, resize-nudge to
///   force a TUI repaint; status is `live`.
/// - **exited** → the pump is already gone (child exited); return the meta with
///   status `exited` so the frontend shows "session ended" rather than a blank
///   pane. No replay is possible.
/// - **missing** → `Err` (unknown terminal), distinct from an exited one.
fn reattach_terminal(
    fleet: &mut Fleet,
    id: &TerminalId,
    channel: Channel<InvokeResponseBody>,
) -> Result<TerminalMeta, String> {
    let Some(rt) = fleet.terminals.get(id) else {
        return Err(format!("unknown terminal: {id}"));
    };
    // Exited: nothing to attach to. Hand back the meta; the frontend distinguishes
    // by `status == exited`.
    if rt.pty.is_none() {
        return Ok(rt.meta.clone());
    }

    let (rows, cols) = (rt.meta.rows, rt.meta.cols);
    // Swap the pump's sink and replay the ring. If the pump has already ended
    // (raced with child exit), fall through to returning the meta — the next
    // snapshot/exit event will reconcile.
    if rt
        .pump_ctrl
        .try_send(PumpControl::Reattach(channel))
        .is_err()
    {
        return Ok(rt.meta.clone());
    }

    // Resize-nudge: replaying the ring cannot reconstruct an alt-screen (claude/
    // Ink). A one-column jitter forces the child to `SIGWINCH`-repaint the full
    // alt-buffer into the fresh Channel. End at the real size.
    if let Some(pty) = fleet.terminals.get(id).and_then(|rt| rt.pty.as_ref()) {
        let nudged = if cols > 1 { cols - 1 } else { cols + 1 };
        let _ = pty.resize(rows, nudged);
        let _ = pty.resize(rows, cols);
    }

    Ok(fleet.terminals[id].meta.clone())
}

// ── The close confirmation: which terminals are busy? ────────────────────────
//
// Closing a terminal that is running `claude` first asks for confirmation.
//
// Two tiers, each blind exactly where the other sees — which is why it takes both:
//
//  1. **A bound session** (all platforms, exact). For a terminal the app spawned an
//     agent into, `claude` **is** the PTY child — there is no shell — so a
//     foreground-process check can never see it: the foreground group is always the
//     child itself. [`Fleet::bindings`] is the authority here, and it is a recorded
//     fact rather than an inference.
//  2. **A foreground command** (Unix and Windows). For a terminal the user typed into,
//     the shell is the child and a running command takes the tty's foreground process
//     group — on Windows (no process groups) the shell has a console child instead —
//     see [`PtyHandle::foreground_command_running`]. This catches a hand-typed
//     `claude` that tier 1 never saw (ad-hoc detection is workspace-scoped, so a
//     `claude` in a folder the app never opened is invisible to it), and it catches a
//     long build or a dev server, which is the same hazard in different clothes.
//
// 🔴 Tier 1 is deliberately **not** gated on `status == Running`: a root
// is born `Idle`, and a session parked at its prompt never emits `Stop` — so a
// running-only test would wave through exactly the session most likely to be lost. The
// question is "is a session bound and alive", not "is it mid-turn".

/// Which of `ids` are busy. Absent = not busy; unknown and exited ids are absent
/// too, never an error (the caller is about to close them either way).
fn busy_terminals(fleet: &Fleet, ids: &[TerminalId]) -> Vec<TerminalBusy> {
    ids.iter()
        .filter_map(|id| terminal_busy(fleet, id))
        .collect()
}

/// One terminal's answer, gathering both tiers' facts and handing them to
/// [`classify_busy`].
fn terminal_busy(fleet: &Fleet, id: &TerminalId) -> Option<TerminalBusy> {
    // An id we have never heard of is simply not busy.
    let rt = fleet.terminals.get(id)?;
    // Exited: `on_child_exited` dropped the PTY and unbound the session, but kept
    // the meta so the UI can still paint the dead tab. Nothing can be running in it,
    // and there is no master fd left to ask.
    let pty = rt.pty.as_ref()?;
    classify_busy(
        id,
        bound_session_label(fleet, id, &rt.meta.title),
        pty.foreground_command_running(),
        &rt.meta.title,
    )
}

/// Tier 1: `Some(label)` when a live runtime session is bound to `id`.
///
/// The binding table is the authority; the forest only supplies the *name*. A
/// binding whose agent node has already been removed still counts as busy and
/// borrows `fallback` (the terminal's title) — we would rather warn about a session
/// we can no longer name than close one silently.
fn bound_session_label(fleet: &Fleet, id: &TerminalId, fallback: &str) -> Option<String> {
    fleet.bindings.get(id)?;
    let named = fleet
        .agents
        .values()
        .find(|a| a.terminal_id.as_deref() == Some(id.as_str()))
        .map(|a| a.node.title.as_str())
        .filter(|title| !title.is_empty());
    Some(named.unwrap_or(fallback).to_string())
}

/// The per-terminal decision, as a pure function of what the two tiers found — so
/// the precedence rule is unit-testable without a live PTY.
///
/// `agent_label` is tier 1 (`Some` ⇒ a session is bound). `foreground_running` is
/// tier 2 (`None` ⇒ unknown: `tcgetpgrp` or the Windows process snapshot had no answer).
///
/// Tier 2 is consulted **only** when tier 1 is silent. An agent terminal has no
/// shell, so its foreground group is always the child itself — asking tier 2 there
/// would produce a flat "idle" that contradicts a fact we already hold.
fn classify_busy(
    id: &TerminalId,
    agent_label: Option<String>,
    foreground_running: Option<bool>,
    terminal_title: &str,
) -> Option<TerminalBusy> {
    if let Some(label) = agent_label {
        return Some(TerminalBusy {
            id: id.clone(),
            reason: BusyReason::Agent,
            label,
        });
    }
    // Unknown is NOT busy, on purpose (and that is why this compares to `Some(true)`
    // rather than unwrapping): a dialog that fires on nothing is what teaches people
    // to click straight through the one that matters.
    if foreground_running == Some(true) {
        return Some(TerminalBusy {
            id: id.clone(),
            reason: BusyReason::Command,
            label: terminal_title.to_string(),
        });
    }
    None
}

/// Sentinel `exited.code` for "the outcome is genuinely unknown".
///
/// `AgentEvent::Exited.code` is a required `number` on the wire, but a failed
/// `wait()` has no status to report. Rather than invent a plausible-looking number
/// (`-1` reads to a user as "exited with code -1", which no process returns),
/// unknown is spelled the same way every time and paired with a `status` that
/// carries the real meaning.
const EXIT_CODE_UNKNOWN: i32 = -1;

/// The child died **on its own** (finished or crashed): record it and tell the UI.
///
/// This is the *retain* path. Contrast [`remove_agent_for_terminal`], the *remove*
/// path taken when the user closes the tab. The two are deliberately separate
/// functions rather than one function branching on a cause — the actions they take
/// (retain-as-`done`/`error` vs. delete-from-forest) share nothing.
fn on_child_exited(fleet: &mut Fleet, id: &TerminalId, code: Option<i32>) {
    if let Some(rt) = fleet.terminals.get_mut(id) {
        rt.meta.status = TerminalStatus::Exited;
        rt.meta.exit_code = code;
        // Drop the PTY: closes the fds → the reader thread sees EOF → its mpsc
        // closes → the coalescer does its final flush and ends. The meta stays
        // for the UI, and `fleet_snapshot` is what finally makes it readable.
        rt.pty = None;
        // The shell child is gone, so its pid is stale. A natural exit RETAINS the
        // runtime (unlike close, which removes it), so abort the cwd poller here or
        // it would keep sampling a dead pid forever (a detached tokio handle does
        // not cancel — same lesson as the fan-out tailer).
        rt.cwd_poll.abort();
    }
    // Unbind: the PTY child is gone, so any session it hosted is over. This is the
    // half of "unbind on SessionEnd ∪ PTY exit" that we own (SessionEnd is not
    // guaranteed on a hard kill).
    fleet.bindings.remove(id);
    sync_log_suppression(fleet, id);
    if let (Some(hub), Some(rt)) = (&fleet.logs, fleet.terminals.get(id)) {
        let (level, text) = match code {
            Some(0) => (LogLevel::Info, "terminal exited (code 0)".to_string()),
            Some(c) => (LogLevel::Warn, format!("terminal exited (code {c})")),
            None => (
                LogLevel::Warn,
                "terminal exited (status unavailable)".to_string(),
            ),
        };
        hub.push(LineDraft::system(
            Some(id),
            rt.meta.agent_id.as_deref(),
            &log_source_of(hub, id, &rt.meta.title, &rt.meta.cwd),
            level,
            text,
        ));
    }
    finish_agent_for_terminal(fleet, id, code);
    // The agent's OWN process ended (`/exit`, a crash): the user is done with it, so it
    // does not come back next launch. An exit caused by the app quitting is not this —
    // `Registry::remove` is a no-op once the shutting-down flag is up. A plain shell
    // exiting was never recorded, so this is a read and no write.
    fleet.restart.registry.remove(id);
    fleet.restart.restored.remove(id);
}

/// Move the agent owning `terminal_id` (if any) into a terminal state after a
/// natural exit, and tell the UI.
///
/// M2's status model is deliberately minimal: `running` until the process ends,
/// then `done`/`error`. `waiting_input` and `idle` require telemetry that only
/// M3's tailer provides — guessing at them from byte traffic would be exactly the
/// kind of heuristic this design avoids.
///
/// **`error` must mean something.** It is reserved for an agent that failed on its
/// own. The user closing a tab is not a failure and never reaches this function —
/// it takes the remove path — so `error` cannot fire on a normal close. If it
/// could, the user would learn to ignore red, and a genuinely broken agent in
/// an M3 tree would go unnoticed.
///
/// Only ever called with a child's own exit code, so there is no `CloseRequested`
/// case to handle: a signal-derived code from *our* kill (143 = SIGTERM, 137 =
/// SIGKILL) never gets here to be mistaken for the agent's outcome.
fn finish_agent_for_terminal(fleet: &mut Fleet, terminal_id: &TerminalId, code: Option<i32>) {
    let Some(agent) = fleet
        .agents
        .values_mut()
        .find(|a| a.terminal_id.as_deref() == Some(terminal_id.as_str()))
    else {
        return;
    };
    // Already finished: if a `ChildExited` somehow arrives twice, the first record
    // wins and we do not emit a second `exited`.
    if agent.node.finished_at.is_some() {
        return;
    }

    let now = now_ms();
    agent.node.finished_at = Some(now);
    agent.node.last_activity_at = now;

    let (status, error, code) = match code {
        // A clean exit on its own terms.
        Some(0) => (AgentStatus::Done, None, 0),

        // Died on its own with a non-zero code — a real failure, and the badge
        // must show it. This includes a self-inflicted Ctrl-C (130): the agent
        // ended abnormally and we did not ask it to.
        Some(code) => (
            AgentStatus::Error,
            Some(format!("exited with code {code}")),
            code,
        ),

        // `wait()` itself failed: we could not reap a status. Report the
        // uncertainty instead of inventing "exited with code -1" for a process
        // that never returned -1.
        None => (
            AgentStatus::Error,
            Some("exit status unavailable".to_string()),
            EXIT_CODE_UNKNOWN,
        ),
    };

    agent.node.status = status;
    agent.node.error = error;
    // The root finished: its transcript is now static, so the fan-out tailer has
    // nothing left to observe. Abort it — a dropped tokio `JoinHandle` detaches, not
    // cancels, so a retained tailer would re-parse the static transcript every
    // `FANOUT_POLL` forever. The node stays (retained for inspection); only its
    // tailer dies.
    if let Some(t) = agent.tailer.take() {
        t.abort();
    }
    let agent_id = agent.node.id.clone();
    let error_text = agent.node.error.clone();

    fleet.sink.emit(&AgentEvent::Exited {
        agent_id: agent_id.clone(),
        code,
    });
    fleet.sink.emit(&AgentEvent::Status {
        agent_id: agent_id.clone(),
        status,
    });
    let (level, text) = match error_text {
        Some(e) => (LogLevel::Error, format!("agent exited · {e}")),
        None => (LogLevel::Info, "agent exited (code 0)".to_string()),
    };
    log_agent_line(fleet, &agent_id, level, text);
    stop_unfinished_descendants(fleet, &agent_id);
}

/// A root's process is gone, so every sub-agent it was still running is gone too —
/// they run *inside* that `claude` process. Without this the tree kept showing
/// "5 running" under a dead root forever, because the
/// tailer that would have reported their end was just aborted.
///
/// Each still-unfinished descendant becomes `error` ("stopped: its root agent
/// exited"), not `done`: it did not finish its work. Already-finished ones keep
/// their own record. Natural exits only — the user's close takes the remove path.
fn stop_unfinished_descendants(fleet: &mut Fleet, root: &AgentId) {
    let mut ids = vec![root.clone()];
    let mut scanned = 0;
    while scanned < ids.len() {
        let parent = ids[scanned].clone();
        for a in fleet.agents.values() {
            if a.node.parent_id.as_deref() == Some(parent.as_str()) {
                ids.push(a.node.id.clone());
            }
        }
        scanned += 1;
    }
    let now = now_ms();
    for id in ids.into_iter().skip(1) {
        let Some(a) = fleet.agents.get_mut(&id) else {
            continue;
        };
        if matches!(a.node.status, AgentStatus::Done | AgentStatus::Error) {
            continue;
        }
        a.node.status = AgentStatus::Error;
        a.node.error = Some("stopped: its root agent exited".to_string());
        a.node.finished_at.get_or_insert(now);
        a.node.last_activity_at = now;
        fleet.sink.emit(&AgentEvent::Status {
            agent_id: id.clone(),
            status: AgentStatus::Error,
        });
    }
}

/// Remove the agent whose terminal this is (and its whole sub-tree) from the
/// forest. The **remove** path — taken only when the user closes the tab.
///
/// The model: a closed agent is gone and will not be opened again, so a later
/// `fleet_snapshot` must not resurrect it. Contrast a *natural* exit, which retains
/// the node as `done`/`error` for inspection ([`finish_agent_for_terminal`]).
///
/// **A plain terminal has no agent**, so `find` matches nothing and this is a
/// no-op — correct, because `TerminalId == AgentId` holds for agent terminals
/// only. Closing a shell must not delete an agent that happens to be nearby.
///
/// **The crash-then-close collision resolves in favour of remove.** If an agent
/// crashed and the user *then* closes its tab, the node is removed, not kept as
/// `error`. The crash was retained *until the user dismissed it*, and the close is
/// that dismissal — the explicit user action wins over the retained record. (The
/// frontend, which issued the close, drops the node from its store in lockstep, so
/// no `removed` event is needed in M2; see the summary for the M3 caveat.)
fn remove_agent_for_terminal(fleet: &mut Fleet, terminal_id: &TerminalId) {
    let Some(root) = fleet
        .agents
        .values()
        .find(|a| a.terminal_id.as_deref() == Some(terminal_id.as_str()))
        .map(|a| a.node.id.clone())
    else {
        return;
    };
    remove_agent_subtree(&mut fleet.agents, &root);
}

/// Remove `root` and every descendant (by `parentId` edge) from the forest.
///
/// **The M3 cascade**: dismissing a root drops its
/// whole sub-tree, which the client never opened. Sub-agents are pure forest
/// records with no PTY, so removing them from the map is complete — but a *root*
/// owns a fan-out tailer task, which must be aborted or it outlives its node and
/// keeps re-emitting a resurrected tree.
fn remove_agent_subtree(agents: &mut HashMap<AgentId, AgentRuntime>, root: &AgentId) {
    // Breadth-first collect, then delete: mutating the map mid-walk would
    // invalidate the borrow, and the fleet is tiny (a handful of agents) so the
    // O(n) child scan per node is free.
    let mut to_remove = vec![root.clone()];
    let mut scanned = 0;
    while scanned < to_remove.len() {
        let parent = to_remove[scanned].clone();
        for a in agents.values() {
            if a.node.parent_id.as_deref() == Some(parent.as_str()) {
                to_remove.push(a.node.id.clone());
            }
        }
        scanned += 1;
    }
    for id in &to_remove {
        if let Some(rt) = agents.remove(id) {
            // Stop the tailer, or it keeps polling and re-inserting the sub-tree.
            if let Some(tailer) = rt.tailer {
                tailer.abort();
            }
        }
    }
}

/// Evict any agent already parked under `terminal_id`, aborting its fan-out tailer
/// before a fresh root re-inserts there.
///
/// Sequential ad-hoc `claude`s in one shell land under the same `terminal_id`
/// repeatedly. A dropped `tauri::async_runtime::JoinHandle` (tokio) *detaches* the
/// task, it does **not** cancel it — so overwriting the map entry without this would
/// leave the old tailer polling `~/.claude` forever.
///
/// Defense-in-depth: every unbind path (`on_session_end`, `on_child_exited`) already
/// aborts the tailer before this runs, so in practice `prev.tailer` is `None` here.
/// But this mirrors the guards in `spawn_agent` / `on_fanout_delta` and keeps the
/// re-insert safe even if a future unbind path forgets to abort.
fn evict_prev_root(agents: &mut HashMap<AgentId, AgentRuntime>, terminal_id: &TerminalId) {
    if let Some(prev) = agents.remove(terminal_id) {
        if let Some(tailer) = prev.tailer {
            tailer.abort();
        }
    }
}

/// Wall-clock milliseconds — the unit `types.ts` uses for `startedAt` etc.
/// Gather the facts needed to pin `agent_id` from live state, or `None`
/// if it is unknown or **not a pinnable root**.
///
/// ROOT-only is a hard constraint: a sub-agent
/// has no PTY and no process of its own, so there is nothing to re-spawn — it
/// re-materialises from the transcript when its root's `claude` resumes. We gate on
/// `parent_id.is_none() && kind == Orchestrator`.
///
/// `custom_title` is `Some` only when the node has been renamed away from its
/// adapter default (a user/telemetry rename worth preserving); an untouched
/// default title persists as `None` so restore can re-derive it.
fn describe_pinnable(fleet: &Fleet, agent_id: &str) -> Option<PinnableAgent> {
    let rt = fleet.agents.get(agent_id)?;
    if rt.node.parent_id.is_some() || rt.node.kind != AgentKind::Orchestrator {
        return None;
    }
    // A rename is preserved; the bare adapter default is not (nothing to restore).
    let default_title = fleet
        .adapter(&rt.node.runtime)
        .ok()
        .map(|a| a.default_title());
    let custom_title = match default_title {
        Some(dt) if rt.node.title == dt => None,
        _ if rt.node.title.is_empty() => None,
        _ => Some(rt.node.title.clone()),
    };
    Some(PinnableAgent {
        agent_id: rt.node.id.clone(),
        cwd: rt.node.cwd.clone(),
        runtime: rt.node.runtime.clone(),
        session_id: rt.session_key.0.clone(),
        custom_title,
        finished: rt.node.finished_at.is_some(),
    })
}

/// Every session id the IDE owns: each ROOT's `session_key` (spawned → the minted
/// `--session-id`, ad-hoc → the hook's) — kept after its PTY exits, since the node is
/// still in the rail — plus every live binding (a terminal re-bound to a newer session),
/// plus every session the IDE has *ever* owned this run ([`Fleet::owned_sessions`]) so
/// a closed, evicted or rebound session is still excluded from the external scan.
/// A sub-agent's `session_key` is its own agent id, not a session, so it is left out.
fn owned_session_ids(fleet: &Fleet) -> std::collections::HashSet<String> {
    fleet
        .agents
        .values()
        .filter(|rt| rt.node.parent_id.is_none())
        .map(|rt| rt.session_key.0.clone())
        .chain(fleet.bindings.values().cloned())
        .chain(fleet.owned_sessions.iter().cloned())
        .collect()
}

/// Fold the fleet's current roots and bindings into the run-scoped, grow-only
/// [`Fleet::owned_sessions`]. Run after every message.
fn remember_owned_sessions(fleet: &mut Fleet) {
    let current = owned_session_ids(fleet);
    fleet.owned_sessions.extend(current);
}

// ── Open agents come back after a restart (phase 1, `open_agents.rs`) ────────

/// Re-open the last session's agents, each down the restore ladder (`choose_rung`):
/// resume its conversation, else a fresh `claude` in the same folder, else a dormant
/// row that says why. Every agent comes back under its OWN id — that id is the key the
/// center layout persisted its view, pane, tab and name under.
///
/// The transcript lookup asks the agent's ADAPTER (the supervisor knows no
/// Claude paths); an unknown runtime simply has none, takes the fresh rung, and its
/// spawn's refusal turns it dormant with the reason. Each restored agent gets a
/// detached output sink: the pump fills the scrollback ring until the frontend's
/// `terminal_reattach` swaps in the real channel and replays it.
fn restore_agents(fleet: &mut Fleet, tx: &mpsc::Sender<SupervisorMsg>, agents: Vec<OpenAgent>) {
    for agent in agents {
        // Restore runs once, into the empty fleet of a fresh boot. An id that is already
        // here is left alone — re-spawning it would be a second process on one session.
        if fleet.agents.contains_key(&agent.agent_id)
            || fleet.terminals.contains_key(&agent.agent_id)
        {
            continue;
        }
        let transcript = fleet
            .adapter(&agent.runtime)
            .ok()
            .and_then(|a| a.locate_transcript(&agent.session_id))
            .is_some();
        let rung = open_agents::choose_rung(std::path::Path::new(&agent.cwd).is_dir(), transcript);
        let outcome = if rung == RestoreOutcome::Dormant {
            restore_dormant(
                fleet,
                &agent,
                format!("its folder no longer exists: {}", agent.cwd),
            );
            RestoreOutcome::Dormant
        } else {
            let spec = AgentSpawnSpec {
                agent_id: agent.agent_id.clone(),
                runtime: agent.runtime.clone(),
                cwd: agent.cwd.clone(),
                // Placeholders: the frontend's re-attach resizes to the real pane.
                rows: 24,
                cols: 80,
                prompt: None,
                resume_session_id: (rung == RestoreOutcome::Resumed)
                    .then(|| agent.session_id.clone()),
            };
            match spawn_agent(fleet, tx, spec, Channel::new(|_| Ok(()))) {
                Ok(_) => rung,
                Err(e) => {
                    restore_dormant(fleet, &agent, format!("it could not start: {e}"));
                    RestoreOutcome::Dormant
                }
            }
        };
        fleet.restart.restored.insert(
            agent.agent_id.clone(),
            RestoredAgent {
                agent_id: agent.agent_id,
                outcome,
                was_working: agent.was_working,
            },
        );
    }
}

/// The ladder's last rung: an agent that could not be re-launched comes back as an
/// ENDED root — an `error` row whose `error` says why, and an exited terminal so the
/// layout restore still puts its tab back where it was. Never silently dropped: the
/// user would lose track of an agent they did not close.
///
/// It stays in `open-agents.json` (the folder may be on a drive that is not mounted
/// yet) until the user closes it — the close is the ordinary `terminal_close` of its
/// tab or row, which `Registry::remove` turns into the removal.
fn restore_dormant(fleet: &mut Fleet, agent: &OpenAgent, reason: String) {
    let id = agent.agent_id.clone();
    let title = fleet
        .adapter(&agent.runtime)
        .map(|a| a.default_title().to_string())
        .unwrap_or_else(|_| agent.runtime.clone());
    // A terminal with no process: `pty: None` is exactly how an exited terminal looks
    // (`on_child_exited`), so re-attach answers `exited`, the close confirmation finds
    // nothing running and dev-app discovery skips it. The pump and cwd poller are
    // already-finished tasks, so the close path's `abort()`s have nothing to stop.
    let (pump_ctrl, _) = mpsc::channel::<PumpControl>(1);
    fleet.terminals.insert(
        id.clone(),
        TerminalRuntime {
            meta: TerminalMeta {
                id: id.clone(),
                kind: TerminalKind::AgentTerminal,
                title: title.clone(),
                cwd: agent.cwd.clone(),
                cols: 80,
                rows: 24,
                status: TerminalStatus::Exited,
                exit_code: None,
                agent_id: Some(id.clone()),
            },
            pty: None,
            pump: tauri::async_runtime::spawn(async {}),
            pump_ctrl,
            cwd_poll: tauri::async_runtime::spawn(async {}),
        },
    );
    let now = now_ms();
    let node = AgentNode {
        id: id.clone(),
        parent_id: None,
        kind: AgentKind::Orchestrator,
        title: title.clone(),
        // Finished, so nothing can revive it (`on_activity`'s "finished is final") and
        // the row offers ↻ Resume where a conversation exists.
        status: AgentStatus::Error,
        branch: String::new(),
        cwd: agent.cwd.clone(),
        runtime: agent.runtime.clone(),
        started_at: None,
        finished_at: Some(now),
        last_activity_at: now,
        error: Some(format!("not reopened after the restart: {reason}")),
    };
    fleet.agents.insert(
        id.clone(),
        AgentRuntime {
            node,
            terminal_id: Some(id.clone()),
            session_key: SessionKey(agent.session_id.clone()),
            transcript_path: None,
            is_ad_hoc: false,
            tailer: None,
        },
    );
    fleet.sink.emit(&AgentEvent::AgentStarted {
        agent_id: id.clone(),
        parent_id: None,
        title,
        cwd: agent.cwd.clone(),
        branch: String::new(),
        runtime: agent.runtime.clone(),
    });
    fleet.sink.emit(&AgentEvent::Status {
        agent_id: id.clone(),
        status: AgentStatus::Error,
    });
    log_agent_line(
        fleet,
        &id,
        LogLevel::Warn,
        format!("not reopened after the restart: {reason}"),
    );
}

/// Which spawned roots are mid-turn right now — the facts the shutdown write records.
/// `running` and `waiting_input` both mean a turn the quit will interrupt. Ad-hoc roots
/// and sub-agents are not in the registry, so they are left out.
fn working_at_shutdown(fleet: &Fleet) -> HashMap<String, bool> {
    fleet
        .agents
        .values()
        .filter(|a| a.node.parent_id.is_none() && !a.is_ad_hoc)
        .map(|a| {
            let working = matches!(
                a.node.status,
                AgentStatus::Running | AgentStatus::WaitingInput
            );
            (a.node.id.clone(), working)
        })
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Ad-hoc agent detection ───────────────────────────────────────────────────

/// Append the ad-hoc-detection env to a PTY's spawn spec, if a listener is running.
///
/// Every PTY gets these — a plain shell too — so whatever the user runs inherits
/// them. `TERM`/`AGENTSTUDIO` are already set by `pty::spawn_pty`; these are the
/// three the binding hook reads.
fn inject_hook_env(fleet: &Fleet, terminal_id: &TerminalId, spec: &mut SpawnSpec) {
    let Some(hook) = &fleet.hook else {
        return;
    };
    spec.env
        .push((ENV_TERMINAL_ID.to_string(), terminal_id.clone()));
    spec.env
        .push((ENV_HOOK_URL.to_string(), hook.base_url.clone()));
    spec.env
        .push((ENV_HOOK_TOKEN.to_string(), hook.token.clone()));
}

/// Write each adapter's ad-hoc hook into `<git-root>/.claude/settings.local.json`,
/// merging with anything already there. Best-effort: any failure is swallowed (the
/// terminal must still open), so this returns nothing.
///
/// **Installs at the git ROOT, not the raw `cwd`**. `claude` walks up
/// from the session's cwd to find `.claude/`, so a hook at the repo root covers
/// every subdirectory the user might `cd` into before typing `claude`. Without
/// this, a hook written only in the terminal's spawn cwd was invisible the moment
/// the user changed directory. A non-repo cwd falls back to the cwd itself (the
/// prior behavior).
///
/// **Guards the user's global config.** If the resolved target is the home
/// directory, `<target>/.claude/` *is* `~/.claude/`, and writing there would touch
/// the user's global Claude config — which is never done without explicit
/// consent. So we skip the home dir entirely; a `claude` typed straight in `~`
/// (or in a repo rooted at `~`) simply isn't auto-detected (a stated limitation),
/// never a silent global write. The guard checks the **resolved** target,
/// because a `git init` in the home directory would make the git root be `~`.
fn install_ad_hoc_hooks(fleet: &Fleet, cwd: &str) {
    let cwd_path = std::path::Path::new(cwd);
    let target = crate::git::git_root(cwd_path).unwrap_or_else(|| cwd_path.to_path_buf());
    if is_home_dir(&target) || forbidden_hook_target(&target, home_dir().as_deref()) {
        return;
    }

    for adapter in &fleet.adapters {
        let (Some(additions), Some(marker)) =
            (adapter.ad_hoc_hook_settings(), adapter.hook_marker())
        else {
            continue;
        };
        let _ = write_merged_settings(&target, &additions, marker);
    }
}

// ── Terminal cwd tracking ────────────────────────────────────────────────────
//
// Ad-hoc detection stays **workspace-scoped**: we install the hook at a
// repo's git root, never in `~/.claude`. On spawn we install at the terminal's
// launch cwd; folder-open installs via `ensure_agent_hooks`. Both miss a `claude`
// the user types after `cd`ing into a repo the app never opened. This closes that
// gap **without** any new global write: each terminal's shell cwd is polled, and on
// every change the SAME git-root/home-guarded/symlink-safe/idempotent installer runs
// for the new cwd. Nothing here writes to `~/.claude`.

/// How often the per-terminal cwd poller samples the shell's working directory.
/// A `cd` is a human action, so ~1.2 s of latency before the hook lands is
/// imperceptible, and reading one process's vnode-path info that often is trivially
/// cheap (the same "polling is fine for cold-plane telemetry" reasoning as the
/// fan-out tailer). Overridable via `AGENTSTUDIO_CWD_POLL_MS` — a test seam so the
/// poller test runs in tens of milliseconds, never a user knob.
const CWD_POLL_DEFAULT_MS: u64 = 1200;

fn cwd_poll_interval() -> std::time::Duration {
    let ms = std::env::var("AGENTSTUDIO_CWD_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(CWD_POLL_DEFAULT_MS);
    std::time::Duration::from_millis(ms)
}

/// The per-poll decision, extracted as a **pure function** so it is
/// unit-testable with injected cwds instead of a live process. Given the cwd we last
/// asked the actor to install for (`last`) and the one just polled (`current`),
/// return `Some(new)` — the cwd to install at and to remember as the new `last` —
/// **only when the reading changed**; `None` otherwise.
///
/// A `None` reading (`current` is `None`: unreadable/dead pid, or an unsupported
/// platform) is deliberately never treated as a change: a transient read failure
/// must not fire a redundant install nor discard the last-known-good cwd.
fn cwd_moved(
    last: Option<&std::path::Path>,
    current: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    match current {
        Some(cur) if last != Some(cur) => Some(cur.to_path_buf()),
        _ => None,
    }
}

/// Spawn a terminal's cwd poller. Returns the task handle so the
/// supervisor can `.abort()` it on child exit / close (a dropped tokio `JoinHandle`
/// *detaches* — it keeps polling a dead pid — it does not cancel; the same trap the
/// fan-out tailer documents).
///
/// A `None` `child_pid` (portable-pty could not report one) yields a task that ends
/// immediately: there is nothing to poll, and the spawn-cwd install already ran.
fn spawn_cwd_poller(
    tx: mpsc::Sender<SupervisorMsg>,
    child_pid: Option<u32>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let Some(pid) = child_pid else {
            return;
        };
        let interval = cwd_poll_interval();
        // The cwd we last routed for. `None` until the first successful read; we do
        // NOT seed it with the spawn cwd, so the first reading confirms coverage of
        // wherever the shell actually is (the install is idempotent, so re-affirming
        // the spawn cwd is a cheap no-op).
        let mut last: Option<std::path::PathBuf> = None;
        loop {
            tokio::time::sleep(interval).await;
            let current = crate::pty::cwd::process_cwd(pid);
            if let Some(new_cwd) = cwd_moved(last.as_deref(), current.as_deref()) {
                let cwd = new_cwd.to_string_lossy().into_owned();
                if tx.send(SupervisorMsg::CwdChanged { cwd }).await.is_err() {
                    return; // supervisor gone
                }
                last = Some(new_cwd);
            }
        }
    })
}

/// A terminal's shell `cd`'d somewhere new. Install the ad-hoc hook at
/// the new cwd's git root, exactly as spawn and folder-open do — so a `claude` typed
/// after the `cd`, in a repo the app never explicitly opened, is still detected.
///
/// **No new settings-writing path.** It reuses [`install_ad_hoc_hooks`], which
/// installs at the git ROOT ([`git_root`]), refuses the home directory
/// ([`is_home_dir`]), is symlink-safe ([`write_merged_settings`]) and idempotent (by
/// marker) — so it **never touches `~/.claude`**. Gated on a live listener
/// (the hook is inert without one), exactly like `EnsureAgentHooks`. Re-affirming a
/// repo already installed is a cheap idempotent no-op.
fn on_cwd_changed(fleet: &Fleet, cwd: &str) {
    if fleet.hook.is_some() {
        install_ad_hoc_hooks(fleet, cwd);
    }
}

/// A hook POST arrived (token already checked by the listener). Parse it via an
/// adapter and apply the binding rule.
fn on_hook_received(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    terminal_id: &TerminalId,
    body: &[u8],
) {
    // First adapter that recognises the payload wins. Capture WHICH adapter it was
    // (its id is the ad-hoc agent's runtime, and what selects its fan-out tailer —
    // never a hardcoded constant). Owned result, so the immutable borrow of
    // `adapters` ends before we mutate the fleet.
    let parsed: Option<(String, SessionEvent)> = fleet
        .adapters
        .iter()
        .find_map(|a| a.parse_session_event(body).map(|e| (a.id().to_string(), e)));
    let Some((runtime_id, event)) = parsed else {
        return;
    };
    match event.kind {
        SessionEventKind::Start => on_session_start(fleet, tx, terminal_id, &runtime_id, event),
        SessionEventKind::End => on_session_end(fleet, terminal_id, &event.session_id),
        // Turn/activity hooks → the bound root's live status.
        SessionEventKind::Busy => {
            on_activity(fleet, terminal_id, &event.session_id, AgentStatus::Running)
        }
        SessionEventKind::Idle => {
            on_activity(fleet, terminal_id, &event.session_id, AgentStatus::Idle)
        }
        SessionEventKind::AwaitingInput => on_activity(
            fleet,
            terminal_id,
            &event.session_id,
            AgentStatus::WaitingInput,
        ),
    }
}

/// A turn/activity hook reported the status of the root running in this
/// terminal — emit a `Status` for its agent.
///
/// Two guards, both load-bearing:
///   - **Session match** — the same phantom-root protection as `classify_session_start`:
///     the status applies ONLY when the reporting `session_id` is the one currently
///     bound to this terminal. A nested `claude -p`'s `Stop`/`UserPromptSubmit` carries
///     a *different* session, so it can never flip the real root's pill.
///   - **Finished is final** — a `done`/`error` agent is left alone, so a late turn
///     hook arriving after the process exited cannot resurrect it to `idle`/`running`.
///
/// A no-op transition (already in `status`) emits nothing, keeping the event stream
/// quiet. Sub-agents have no terminal and no hook of their own (they run in-process),
/// so their transcript-derived status is untouched by this path.
fn on_activity(fleet: &mut Fleet, terminal_id: &TerminalId, session_id: &str, status: AgentStatus) {
    if fleet.bindings.get(terminal_id).map(String::as_str) != Some(session_id) {
        return;
    }
    let Some(agent) = fleet.agents.get_mut(terminal_id) else {
        return;
    };
    if matches!(agent.node.status, AgentStatus::Done | AgentStatus::Error)
        || agent.node.status == status
    {
        return;
    }
    agent.node.status = status;
    let agent_id = agent.node.id.clone();
    // A new turn is the user talking to it again: the "Resumed after restart" marker
    // has said what it had to say.
    if status == AgentStatus::Running {
        fleet.restart.restored.remove(&agent_id);
    }
    fleet.sink.emit(&AgentEvent::Status { agent_id, status });
}

/// The binding discriminator, as a pure function so it can be exhaustively unit- and
/// mutation-tested. **This is the crux of ad-hoc detection** — the phantom-root trap lives
/// or dies here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindDecision {
    /// Unbound terminal → a genuine ad-hoc root. Create the node.
    CreateRoot,
    /// Bound to a *different* live session → a nested `claude` (phantom root).
    /// Do **not** create a node; the tailer owns the real sub-tree (M3).
    Suppress,
    /// Bound to the *same* session → the already-known agent re-announcing (e.g. a
    /// spawned agent's own `SessionStart`). No new node; record its transcript.
    ReAnnounce,
    /// Not one of our PTYs → ignore (defensive; only our PTYs carry the env, so a
    /// stray/forged POST for an unknown terminal binds nothing).
    Ignore,
}

fn classify_session_start(
    is_known_terminal: bool,
    current_binding: Option<&str>,
    incoming_session: &str,
) -> BindDecision {
    if !is_known_terminal {
        return BindDecision::Ignore;
    }
    match current_binding {
        None => BindDecision::CreateRoot,
        Some(bound) if bound == incoming_session => BindDecision::ReAnnounce,
        Some(_) => BindDecision::Suppress,
    }
}

fn on_session_start(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    terminal_id: &TerminalId,
    runtime_id: &str,
    event: SessionEvent,
) {
    let decision = classify_session_start(
        fleet.terminals.contains_key(terminal_id),
        fleet.bindings.get(terminal_id).map(String::as_str),
        &event.session_id,
    );
    match decision {
        BindDecision::Ignore | BindDecision::Suppress => {}
        BindDecision::ReAnnounce => {
            // Opportunistically record the transcript path for M3's tailer.
            if let (Some(agent), Some(tp)) = (
                fleet.agents.get_mut(terminal_id),
                event.transcript_path.clone(),
            ) {
                agent.transcript_path = Some(tp);
            }
        }
        BindDecision::CreateRoot => create_adhoc_root(fleet, tx, terminal_id, runtime_id, event),
    }
}

/// Promote the plain terminal to an ad-hoc root agent.
///
/// **`AgentId == TerminalId`** — the terminal's id *is* the agent's identity,
/// exactly as spawned agents work. The terminal already exists; we upgrade it
/// (`kind → agent-terminal`, `agentId` set) and add a forest node beside it.
///
/// Upsert on purpose: a *sequential* `claude` in the same terminal (the previous
/// one having ended and unbound) lands here again with the same id and replaces the
/// prior — now finished — node with a fresh running one. One node per terminal,
/// representing whatever `claude` is currently in it.
fn create_adhoc_root(
    fleet: &mut Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    terminal_id: &TerminalId,
    runtime_id: &str,
    event: SessionEvent,
) {
    fleet
        .bindings
        .insert(terminal_id.clone(), event.session_id.clone());
    fleet.owned_sessions.insert(event.session_id.clone());
    sync_log_suppression(fleet, terminal_id);

    // Title the agent by its RUNTIME, not the promoted shell. Inheriting the
    // terminal's title labelled ad-hoc agents "zsh" in the rail, which is wrong —
    // it's a `claude` now. Use the adapter's display title (falling back to the
    // runtime id). Read before the mutable borrow of `terminals` below.
    let title = fleet
        .adapter(runtime_id)
        .map(|a| a.default_title().to_string())
        .unwrap_or_else(|_| runtime_id.to_string());

    // Anchor the agent to where `claude` is ACTUALLY running — the payload's `cwd`
    // — not the terminal's spawn cwd: the user may have `cd`'d into another repo
    // before typing `claude`. Fall back to the terminal's meta cwd when
    // the payload omits it. Promote the terminal's metadata (kind/agent_id) and
    // sync its cwd to the chosen one, so a re-attach snapshot is consistent.
    let cwd = match fleet.terminals.get_mut(terminal_id) {
        Some(rt) => {
            rt.meta.kind = TerminalKind::AgentTerminal;
            rt.meta.agent_id = Some(terminal_id.clone());
            let cwd = event.cwd.clone().unwrap_or_else(|| rt.meta.cwd.clone());
            rt.meta.cwd = cwd.clone();
            cwd
        }
        // classify() only returns CreateRoot for a known terminal, so this is
        // unreachable; be defensive rather than panic.
        None => return,
    };

    // The runtime is the adapter that recognised the hook — never a hardcoded
    // constant. This is also what selects the fan-out tailer below.
    let runtime = runtime_id.to_string();
    let branch = crate::git::current_branch(std::path::Path::new(&cwd));
    let now = now_ms();
    let node = AgentNode {
        id: terminal_id.clone(),
        parent_id: None,
        kind: AgentKind::Orchestrator,
        // Titled by the runtime (e.g. "claude"), not the promoted shell name.
        title,
        // Born IDLE: `SessionStart` means `claude` just opened and is parked at its
        // prompt, not processing a turn. The turn/activity hooks drive it from here
        // (`UserPromptSubmit` → Running, `Stop` → Idle). Defaulting to Running
        // latched the pill on forever for a session that never ran a turn (a fresh
        // welcome screen never emits `Stop`): an idle agent shown as Running.
        status: AgentStatus::Idle,
        branch: branch.clone(),
        cwd: cwd.clone(),
        runtime: runtime.clone(),
        started_at: Some(now),
        finished_at: None,
        last_activity_at: now,
        error: None,
    };

    // Start the fan-out tailer for this ad-hoc root, keyed off the session id the
    // hook reported and the runtime that recognised it (M3). Same pipeline as a
    // spawned root from here on.
    let tailer = start_fanout_tailer(fleet, tx, terminal_id, &event.session_id, runtime_id);

    // Sequential ad-hoc `claude`s in one shell land here repeatedly under the same
    // `terminal_id`. Abort the previous entry's tailer before overwriting it, or a
    // detached (not cancelled) tokio handle would poll `~/.claude` forever.
    evict_prev_root(&mut fleet.agents, terminal_id);

    fleet.agents.insert(
        terminal_id.clone(),
        AgentRuntime {
            node,
            terminal_id: Some(terminal_id.clone()),
            session_key: SessionKey(event.session_id),
            transcript_path: event.transcript_path,
            is_ad_hoc: true,
            tailer,
        },
    );

    fleet.sink.emit(&AgentEvent::AgentStarted {
        agent_id: terminal_id.clone(),
        parent_id: None,
        title: fleet.agents[terminal_id].node.title.clone(),
        cwd,
        branch,
        runtime,
    });
    log_agent_started(fleet, terminal_id);
}

/// A session ended. Acts **only on the session actually bound to this terminal** —
/// a stale or duplicate `SessionEnd` for a session that was already superseded must
/// touch nothing, or it would wrongly finish the newer `claude` that rebound the
/// terminal (regression-tested).
///
/// For the bound session: unbind (so the next `claude` here is a fresh root). For
/// an **ad-hoc** agent, this is also the only signal its `claude` is over — the
/// shell lives on — so mark it `done`. A **spawned** agent is left to
/// `on_child_exited`, which has the real exit code; `SessionEnd` must not pre-empt
/// it into a code-less `done`.
fn on_session_end(fleet: &mut Fleet, terminal_id: &TerminalId, session_id: &str) {
    // The ended session must be the one we have bound here. Otherwise it is stale
    // (an End for a session that already ended and was replaced) — ignore it whole.
    if fleet.bindings.get(terminal_id).map(String::as_str) != Some(session_id) {
        return;
    }
    fleet.bindings.remove(terminal_id);
    sync_log_suppression(fleet, terminal_id);

    let Some(agent) = fleet.agents.get(terminal_id) else {
        return;
    };
    if !agent.is_ad_hoc || agent.node.finished_at.is_some() {
        return;
    }
    // A clean `SessionEnd` with no exit code: treat the ad-hoc agent as `done`.
    // (Status refinement from the transcript is M3's job.)
    if let Some(agent) = fleet.agents.get_mut(terminal_id) {
        let now = now_ms();
        agent.node.finished_at = Some(now);
        agent.node.last_activity_at = now;
        agent.node.status = AgentStatus::Done;
        // The claude session ended → its transcript is static. Abort the tailer, or
        // it re-parses forever (a dropped JoinHandle detaches, not cancels). The
        // node is retained for inspection; only the tailer dies.
        if let Some(t) = agent.tailer.take() {
            t.abort();
        }
        let agent_id = agent.node.id.clone();
        fleet.sink.emit(&AgentEvent::Exited {
            agent_id: agent_id.clone(),
            code: 0,
        });
        fleet.sink.emit(&AgentEvent::Status {
            agent_id: agent_id.clone(),
            status: AgentStatus::Done,
        });
        log_agent_line(fleet, &agent_id, LogLevel::Info, "agent session ended");
        stop_unfinished_descendants(fleet, &agent_id);
    }
}

// ── Fan-out tailer (M3, ARCHITECTURE §5) ─────────────────────────────────────

/// How often a tailer re-scans its session's transcript. **Polling, not `notify`,
/// deliberately**: the fan-out is cold-plane telemetry,
/// re-scanning is *inherently rewrite-safe* (no byte offset to corrupt when
/// `claude` rewrites its transcript on interrupted exit), and stat-ing a
/// dir + a file every second is trivially cheap. An offset-based incremental reader
/// is the optimisation to add *if* fan-out volume ever demands it — and it would
/// then have to add the rewrite detection we get here for free.
const FANOUT_POLL_DEFAULT_MS: u64 = 1000;

/// The poll interval, overridable via `AGENTSTUDIO_FANOUT_POLL_MS` so the tailer
/// integration test can run at ~50ms instead of a real second. Not a user knob —
/// a test seam.
fn fanout_poll() -> std::time::Duration {
    let ms = std::env::var("AGENTSTUDIO_FANOUT_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(FANOUT_POLL_DEFAULT_MS);
    std::time::Duration::from_millis(ms)
}

/// Start the fan-out tailer task for one root. Returns the handle so the
/// supervisor can abort it when the agent is removed.
///
/// **Selected by the RUNTIME id we spawned** (`runtime_id`), *not* by whether the
/// transcript already exists. The tailer must start the instant the agent does —
/// the process was just launched, so its `<session>.jsonl` does not exist yet; the
/// poll loop waits for it to appear. The old selection keyed off
/// `locate_transcript(...).is_some() || id == <hardcoded claude id>` and so started
/// **no tailer at all** for any runtime whose id wasn't that constant, when the
/// transcript didn't yet exist (reproduced by `fanout_production_order`). Claude
/// worked only by the accident that the constant equalled `"claude-code"`; this
/// fixes the general case for spawned AND ad-hoc agents alike.
///
/// `None` only if no registered adapter matches `runtime_id` — the same "unknown
/// runtime" condition `agent_spawn` already rejects, so in practice always `Some`.
fn start_fanout_tailer(
    fleet: &Fleet,
    tx: &mpsc::Sender<SupervisorMsg>,
    root_agent_id: &AgentId,
    session_id: &str,
    runtime_id: &str,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let adapter = fleet
        .adapters
        .iter()
        .find(|a| a.id() == runtime_id)?
        .clone();
    let tx = tx.clone();
    let root_agent_id = root_agent_id.clone();
    let session_id = session_id.to_string();
    // Agent Logs: the same poll also tails tool calls, but
    // only when a hub is listening — without one this loop is exactly the M3 tailer.
    let mut tools = fleet
        .logs
        .is_some()
        .then(|| crate::agent::tools::TranscriptToolTail::new(now_ms() - TOOL_HISTORY_SLACK_MS));
    // Background tasks the agent starts are tailed by the same loop; the
    // tails die with it, which is how a session ending stops them.
    // A tail still open when the loop is aborted closes with `session ended`, sent from
    // the drop (sync `try_send`: an abort cannot await).
    let drop_tx = tx.clone();
    let mut tasks = fleet.logs.as_ref().map(|hub| {
        crate::logstream::tasks::TaskTails::new(
            crate::logstream::tasks::claude_temp_roots(),
            hub.task_slots(),
        )
        .on_drop(Box::new(move |lines| {
            let _ = drop_tx.try_send(SupervisorMsg::TaskLines { lines });
        }))
    });

    Some(tauri::async_runtime::spawn(async move {
        // Per-agent last-emitted status, so we only send *changes*.
        let mut known: std::collections::HashMap<String, crate::agent::fanout::FanoutStatus> =
            std::collections::HashMap::new();
        let poll = fanout_poll();
        loop {
            tokio::time::sleep(poll).await;

            let Some(loc) = adapter.locate_transcript(&session_id) else {
                continue; // transcript not written yet; keep waiting
            };
            let result = adapter.parse_fanout(&loc, &root_agent_id);

            // A disagreement between the sidecar and the Agent-tool edge is logged,
            // never silently drawn.
            for (agent, sidecar_parent, edge_parent) in &result.edge_mismatches {
                eprintln!(
                    "fanout: edge mismatch for {agent}: sidecar parent {sidecar_parent}, \
                     tool-edge parent {edge_parent} (using sidecar)"
                );
            }

            for delta in crate::agent::fanout::diff_fanout(&known, &result.agents) {
                if tx.send(SupervisorMsg::FanoutDelta { delta }).await.is_err() {
                    return; // supervisor gone
                }
            }
            for a in &result.agents {
                known.insert(a.agent_id.clone(), a.status);
            }

            // After the deltas, so a sub-agent's node exists by the time its first
            // tool line is labelled.
            if let Some(tail) = tools.as_mut() {
                let files = adapter.tool_transcripts(&loc, &root_agent_id);
                let events = tail.poll(&files, |line| adapter.parse_tool_line(line));
                if !events.is_empty()
                    && tx.send(SupervisorMsg::ToolEvents { events }).await.is_err()
                {
                    return; // supervisor gone
                }
                let bypasses = tail.take_bypasses();
                if !bypasses.is_empty()
                    && tx
                        .send(SupervisorMsg::Bypasses { events: bypasses })
                        .await
                        .is_err()
                {
                    return; // supervisor gone
                }
                if let Some(tasks) = tasks.as_mut() {
                    let lines = poll_task_tails(tasks, tail.take_task_events(), |task_id| {
                        adapter.task_output_path(&loc, task_id)
                    });
                    if !lines.is_empty()
                        && tx.send(SupervisorMsg::TaskLines { lines }).await.is_err()
                    {
                        return; // supervisor gone
                    }
                }
            }
        }
    }))
}

/// Apply a tailer delta to the forest and emit the wire event.
fn on_fanout_delta(fleet: &mut Fleet, delta: crate::agent::fanout::FanoutDelta) {
    use crate::agent::fanout::FanoutDelta;
    match delta {
        FanoutDelta::Spawned(mut a) => {
            // A tailer can re-report a node it already emitted after a restart; only
            // the first `Spawned` creates it (and emits the wire event).
            if fleet.agents.contains_key(&a.agent_id) {
                return;
            }
            // `cwd`/`branch` come from the sub-agent's own transcript, which may not
            // exist yet (spawned sessions write `.meta.json` before —
            // or without — the sub-agent `.jsonl`). A sub-agent runs in its parent's
            // cwd, so inherit the parent's when ours is blank, rather than showing an
            // empty `branch • cwd` in the rail.
            if a.cwd.is_empty() || a.branch.is_empty() {
                if let Some(parent) = fleet.agents.get(&a.parent_id) {
                    if a.cwd.is_empty() {
                        a.cwd = parent.node.cwd.clone();
                    }
                    if a.branch.is_empty() {
                        a.branch = parent.node.branch.clone();
                    }
                }
            }
            let now = now_ms();
            let status = map_fanout_status(a.status);
            let node = AgentNode {
                id: a.agent_id.clone(),
                parent_id: Some(a.parent_id.clone()),
                kind: AgentKind::Subagent,
                title: a.title.clone(),
                status,
                branch: a.branch.clone(),
                cwd: a.cwd.clone(),
                runtime: crate::agent::claude::FANOUT_RUNTIME.to_string(),
                started_at: Some(now),
                finished_at: (status != AgentStatus::Running).then_some(now),
                last_activity_at: now,
                error: None,
            };
            fleet.agents.insert(
                a.agent_id.clone(),
                AgentRuntime {
                    node,
                    terminal_id: None, // sub-agents have no PTY
                    session_key: SessionKey(a.agent_id.clone()),
                    transcript_path: None,
                    is_ad_hoc: false,
                    tailer: None,
                },
            );
            let log_text = if a.kind.is_empty() {
                "sub-agent started".to_string()
            } else {
                format!("sub-agent started ({})", a.kind)
            };
            let child_id = a.agent_id.clone();
            fleet.sink.emit(&AgentEvent::SubagentSpawned {
                parent_id: a.parent_id,
                child_agent_id: a.agent_id,
                title: a.title,
                cwd: a.cwd,
                branch: a.branch,
                runtime: crate::agent::claude::FANOUT_RUNTIME.to_string(),
            });
            // First seen ALREADY ENDED — a resumed session's tailer re-reading sub-agents
            // that finished long ago (exactly what a restart's `claude --resume` does),
            // or one that started and ended inside one poll. `SubagentSpawned` carries
            // no status and the UI creates the row `running`, so without this the row
            // read "running" forever. The status follows on the event the
            // UI already applies every status change through, right after the row
            // exists — no wire change, one reducer for status, and a late subscriber
            // still gets it from the snapshot (the node above is created finished).
            if status != AgentStatus::Running {
                fleet.sink.emit(&AgentEvent::Status {
                    agent_id: child_id.clone(),
                    status,
                });
            }
            log_agent_line(fleet, &child_id, LogLevel::Info, log_text);
        }
        FanoutDelta::StatusChanged { agent_id, status } => {
            let Some(agent) = fleet.agents.get_mut(&agent_id) else {
                return;
            };
            let mapped = map_fanout_status(status);
            agent.node.status = mapped;
            agent.node.last_activity_at = now_ms();
            if mapped != AgentStatus::Running && agent.node.finished_at.is_none() {
                agent.node.finished_at = Some(now_ms());
            }
            fleet.sink.emit(&AgentEvent::Status {
                agent_id: agent_id.clone(),
                status: mapped,
            });
            match mapped {
                AgentStatus::Done => {
                    log_agent_line(fleet, &agent_id, LogLevel::Info, "sub-agent finished")
                }
                AgentStatus::Error => {
                    log_agent_line(fleet, &agent_id, LogLevel::Error, "sub-agent failed")
                }
                _ => {}
            }
        }
    }
    // NB: a child changing status NEVER touches its parent here — each delta is
    // scoped to one agent id. That is the structural guarantee behind the
    // parent-stays-running invariant.
}

// ── Agent Logs wiring ────────────────────────────────────────────────────────

/// Tool events older than the tailer's start minus this are history (a resumed
/// session's transcript) and are not replayed into the log.
const TOOL_HISTORY_SLACK_MS: i64 = 10_000;

/// Mirror the binding table into the hub: a bound terminal's PTY output is not
/// line-logged (the runtime's TUI is noise; its transcript is the signal), and
/// logging resumes the moment the binding goes. Called after every binding change.
fn sync_log_suppression(fleet: &Fleet, terminal_id: &TerminalId) {
    if let Some(hub) = &fleet.logs {
        hub.set_suppressed(terminal_id, fleet.bindings.contains_key(terminal_id));
    }
}

/// How an agent is named in the log: a root as `"<title> · <cwd basename>"` (like its
/// terminal), a sub-agent by its own title.
fn agent_source(node: &AgentNode) -> String {
    if node.parent_id.is_none() {
        source_label(&node.title, &node.cwd)
    } else {
        node.title.clone()
    }
}

/// The terminal an agent's work lands in: its own for a root, its root's for a
/// sub-agent (walked up the `parentId` chain; bounded against a cycle).
fn agent_terminal(fleet: &Fleet, agent_id: &str) -> Option<TerminalId> {
    let mut cur = fleet.agents.get(agent_id)?;
    for _ in 0..256 {
        if let Some(t) = &cur.terminal_id {
            return Some(t.clone());
        }
        cur = fleet.agents.get(cur.node.parent_id.as_deref()?)?;
    }
    None
}

fn log_agent_line(fleet: &Fleet, agent_id: &str, level: LogLevel, text: impl Into<String>) {
    let Some(hub) = &fleet.logs else {
        return;
    };
    let source = fleet
        .agents
        .get(agent_id)
        .map(|a| agent_source(&a.node))
        .unwrap_or_else(|| agent_id.to_string());
    let terminal = agent_terminal(fleet, agent_id);
    hub.push(LineDraft::system(
        terminal.as_deref(),
        Some(agent_id),
        &source,
        level,
        text,
    ));
}

fn log_agent_started(fleet: &Fleet, agent_id: &str) {
    let Some(agent) = fleet.agents.get(agent_id) else {
        return;
    };
    let text = format!(
        "agent started · {} in {}",
        agent.node.runtime, agent.node.cwd
    );
    log_agent_line(fleet, agent_id, LogLevel::Info, text);
}

/// Tool calls/results from a tailer → `tool` / `tool-result` lines, labelled from the
/// live forest. An agent the forest does not (yet) know keeps its id as the label.
fn on_tool_events(fleet: &Fleet, events: Vec<crate::agent::tools::ToolEvent>) {
    let Some(hub) = &fleet.logs else {
        return;
    };
    for ev in events {
        let source = fleet
            .agents
            .get(&ev.agent_id)
            .map(|a| agent_source(&a.node))
            .unwrap_or_else(|| ev.agent_id.clone());
        let level = if ev.is_error {
            LogLevel::Error
        } else {
            LogLevel::Info
        };
        hub.push(LineDraft {
            terminal_id: agent_terminal(fleet, &ev.agent_id),
            agent_id: Some(ev.agent_id),
            source,
            kind: if ev.is_result {
                LogKind::ToolResult
            } else {
                LogKind::Tool
            },
            level,
            text: ev.text,
            detail: ev.detail,
            ts_ms: ev.ts_ms,
            tool_use_id: Some(ev.tool_use_id),
        });
    }
}

/// Proxy-bypassing Bash calls → `bypass` rows in Network, attributed to the agent's root
/// terminal (the same terminal its proxied traffic carries).
fn on_bypasses(fleet: &Fleet, events: Vec<crate::agent::tools::BypassEvent>) {
    for ev in events {
        crate::netcap::record_bypass(bypass_input(agent_terminal(fleet, &ev.agent_id), ev));
    }
}

/// The netcap row input for one detected bypass (pure — the golden and the tests use it).
pub fn bypass_input(
    terminal_id: Option<String>,
    ev: crate::agent::tools::BypassEvent,
) -> crate::netcap::BypassInput {
    crate::netcap::BypassInput {
        terminal_id,
        agent_id: Some(ev.agent_id),
        tool_use_id: Some(ev.tool_use_id),
        ts_ms: ev.ts_ms,
        command: ev.command,
        reasons: ev.detected.reasons,
        shim_covers: ev.detected.shim_covers,
        curl: ev.detected.curl,
    }
}

/// Apply the transcript's task starts/stops to `tails`, then read them. A start whose
/// result named no output file gets the adapter's derived path (`derive`); one with
/// neither is not tailed.
pub fn poll_task_tails(
    tails: &mut crate::logstream::tasks::TaskTails,
    events: Vec<crate::agent::tools::TaskEvent>,
    derive: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> Vec<LineDraft> {
    use crate::agent::tools::TaskEvent;
    let now = tokio::time::Instant::now();
    let mut out = Vec::new();
    for ev in events {
        match ev {
            TaskEvent::Started {
                agent_id,
                task_id,
                command,
                output_path,
                cwd,
            } => {
                let Some(path) = output_path.or_else(|| derive(&task_id)) else {
                    continue;
                };
                out.extend(tails.start(
                    crate::logstream::tasks::TaskSpec {
                        agent_id,
                        task_id,
                        command,
                        path,
                        cwd,
                    },
                    now,
                ));
            }
            TaskEvent::Stopped { task_id } => out.extend(tails.stop(&task_id, now)),
        }
    }
    out.extend(tails.poll(now));
    out
}

/// Background-task lines → the hub, each on its launching agent's root terminal.
fn on_task_lines(fleet: &Fleet, mut lines: Vec<LineDraft>) {
    let Some(hub) = &fleet.logs else {
        return;
    };
    for l in &mut lines {
        if let Some(agent) = l.agent_id.as_deref() {
            l.terminal_id = agent_terminal(fleet, agent);
        }
    }
    hub.push_batch(lines);
}

fn map_fanout_status(s: crate::agent::fanout::FanoutStatus) -> AgentStatus {
    use crate::agent::fanout::FanoutStatus;
    match s {
        FanoutStatus::Running => AgentStatus::Running,
        FanoutStatus::Done => AgentStatus::Done,
        FanoutStatus::Error => AgentStatus::Error,
    }
}

/// Is `path` the user's home directory? Used to refuse writing our hook into
/// `~/.claude`. Compared canonically so `/Users/x`, `/Users/x/`, and a symlinked
/// home all match.
fn is_home_dir(path: &std::path::Path) -> bool {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let Some(home) = home else {
        return false;
    };
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(path) == canon(&home)
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// Directories the ad-hoc hook must never be written into, beyond `~` itself.
/// The cwd poller re-runs the installer on every `cd`,
/// and a non-repo cwd is its own target, so without this a `cd ~/.claude` (or into
/// `~/.claude/projects/…`) wrote `~/.claude/.claude/settings.local.json` — a write
/// inside the user's global Claude dir, which the app must never write. Refused:
/// * anything equal to or under the canonical `~/.claude`;
/// * (Unix) a directory other users can write to, or one we don't own — `/tmp`, a
///   shared mount — where another user could pre-plant or swap the `.claude` entry.
fn forbidden_hook_target(target: &std::path::Path, home: Option<&std::path::Path>) -> bool {
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let t = canon(target);
    if let Some(home) = home {
        if t.starts_with(canon(&home.join(".claude"))) {
            return true;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let Ok(meta) = std::fs::metadata(&t) else {
            return true;
        };
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid || meta.permissions().mode() & 0o002 != 0 {
            return true;
        }
    }
    false
}

/// Merge `additions` into `<cwd>/.claude/settings.local.json` and write it.
///
/// Idempotent (skips if `marker` is already present) and non-destructive (parses
/// and preserves the user's existing settings; refuses to clobber a file it cannot
/// parse). Errors are returned but callers treat installation as best-effort.
///
/// **Symlink guard (defense-in-depth).** `read`/`create_dir_all`/`write` all follow
/// symlinks, and the `is_home_dir` guard only checks the *source* cwd. A malicious
/// repo shipping `.claude -> ~/.claude` (or a symlinked `settings.local.json`) would
/// otherwise redirect the write into the user's global config, bypassing the
/// "never touch `~/.claude` without consent" rule. So if either `<cwd>/.claude` or the
/// target file is a symlink, we skip the install (non-fatal, like the home-dir
/// bail) rather than write through it.
fn write_merged_settings(
    cwd: &std::path::Path,
    additions: &serde_json::Value,
    marker: &str,
) -> std::io::Result<()> {
    let dir = cwd.join(".claude");
    let file = dir.join("settings.local.json");

    if is_symlink(&dir) || is_symlink(&file) {
        // Refuse to write through a symlink; do not follow it into (e.g.) ~/.claude.
        return Ok(());
    }

    let existing = std::fs::read_to_string(&file).ok();

    let merged =
        match crate::settings_merge::merge_hook_settings(existing.as_deref(), additions, marker) {
            crate::settings_merge::MergeOutcome::Write(content) => content,
            // Already installed, or the file is present-but-unparseable (never
            // clobber the user's file) → leave it alone.
            crate::settings_merge::MergeOutcome::AlreadyPresent
            | crate::settings_merge::MergeOutcome::SkipMalformed => return Ok(()),
        };

    std::fs::create_dir_all(&dir)?;
    // Write a fresh sibling (`create_new` = O_EXCL, which refuses a pre-planted
    // symlink or file) and `rename` it over the target. `rename` replaces the
    // directory entry itself, so a symlink or hardlink swapped in after the check
    // above is replaced, never written through.
    let tmp = dir.join(".settings.local.json.agentstudio-tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(merged.as_bytes())?;
    }
    std::fs::rename(&tmp, &file)
}

/// Is `path` itself a symlink? Uses `symlink_metadata` (does **not** follow the
/// link), so it detects the link rather than reporting on its target. A path that
/// doesn't exist is not a symlink.
fn is_symlink(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Tab title from the program path: `/bin/zsh` → `zsh`.
fn program_title(program: &str) -> String {
    std::path::Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| program.to_string())
}

#[cfg(test)]
mod tests {
    //! White-box tests for the forest-removal logic.
    //!
    //! `remove_agent_subtree`'s M3 cascade cannot be reached through the public
    //! API in M2 — nothing creates sub-agents yet — so it is exercised here by
    //! building the private `AgentRuntime` map directly. The integration tests in
    //! `tests/agent_lifecycle.rs` cover the single-node case through the real
    //! `agent_spawn`/`terminal_close` path.

    use super::*;
    use crate::agent::adapter::SessionKey;
    use crate::model::AgentKind;

    /// A bare forest node with a given id and parent — enough to test the walk.
    fn node(id: &str, parent: Option<&str>) -> AgentRuntime {
        AgentRuntime {
            node: AgentNode {
                id: id.to_string(),
                parent_id: parent.map(str::to_string),
                kind: AgentKind::Orchestrator,
                title: id.to_string(),
                status: AgentStatus::Running,
                branch: String::new(),
                cwd: "/tmp".to_string(),
                runtime: "stub".to_string(),
                started_at: Some(0),
                finished_at: None,
                last_activity_at: 0,
                error: None,
            },
            terminal_id: Some(id.to_string()),
            session_key: SessionKey(format!("key-{id}")),
            transcript_path: None,
            is_ad_hoc: false,
            tailer: None,
        }
    }

    fn forest(nodes: &[(&str, Option<&str>)]) -> HashMap<AgentId, AgentRuntime> {
        nodes
            .iter()
            .map(|(id, parent)| (id.to_string(), node(id, *parent)))
            .collect()
    }

    // ── Turn/activity hooks → the bound root's live status (`on_activity`) ──

    /// A one-agent fleet (`t1`) bound to `session`, with a NullSink — enough to
    /// assert `on_activity`'s state transitions without a Tauri app.
    fn fleet_with_bound_agent(status: AgentStatus, session: &str) -> Fleet {
        let mut agent = node("t1", None);
        agent.node.status = status;
        let mut agents = HashMap::new();
        agents.insert("t1".to_string(), agent);
        let mut bindings = HashMap::new();
        bindings.insert("t1".to_string(), session.to_string());
        Fleet {
            terminals: HashMap::new(),
            agents,
            bindings,
            owned_sessions: std::collections::HashSet::new(),
            adapters: vec![],
            sink: Arc::new(crate::events::NullSink),
            hook: None,
            logs: None,
            ide: IdeTerminals::default(),
            restart: Restart::default(),
        }
    }

    /// Regression: a root `claude` died and its row still read
    /// "5 running". A natural root exit now stops every unfinished descendant —
    /// they ran inside that process — and leaves finished ones alone.
    #[test]
    fn a_root_exit_stops_its_unfinished_sub_agents() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        for (id, parent, status) in [
            ("s1", "t1", AgentStatus::Running),
            ("s2", "t1", AgentStatus::Done),
            ("s3", "s1", AgentStatus::WaitingInput),
            ("other", "elsewhere", AgentStatus::Running),
        ] {
            let mut n = node(id, Some(parent));
            n.terminal_id = None;
            n.node.status = status;
            fleet.agents.insert(id.to_string(), n);
        }

        finish_agent_for_terminal(&mut fleet, &"t1".to_string(), Some(137));

        let st = |id: &str| fleet.agents[id].node.status;
        assert_eq!(st("t1"), AgentStatus::Error);
        assert_eq!(
            st("s1"),
            AgentStatus::Error,
            "a running child died with its root"
        );
        assert_eq!(st("s3"), AgentStatus::Error, "so did a grandchild");
        assert_eq!(
            st("s2"),
            AgentStatus::Done,
            "a finished child keeps its record"
        );
        assert_eq!(
            st("other"),
            AgentStatus::Running,
            "another tree is untouched"
        );
        assert_eq!(
            fleet.agents["s1"].node.error.as_deref(),
            Some("stopped: its root agent exited")
        );
        assert!(fleet.agents["s1"].node.finished_at.is_some());
    }

    #[test]
    fn owned_session_ids_are_the_roots_and_the_bindings_never_a_subagent() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-bound");
        fleet
            .agents
            .insert("child".to_string(), node("child", Some("t1")));
        let ids = owned_session_ids(&fleet);
        let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        ids.sort();
        // `key-t1` = the root's own session key; `sess-bound` = its live binding;
        // `key-child` (a sub-agent's id) must not be mistaken for a session.
        assert_eq!(ids, vec!["key-t1", "sess-bound"]);
    }

    /// A session the IDE owned stays owned after the user closes its tab (binding
    /// removed + agent taken out of the forest), after a second ad-hoc `claude`
    /// evicts it, and after its terminal is re-bound — or the village would show it
    /// as an "outside the IDE" character for the rest of its transcript window.
    #[test]
    fn owned_session_ids_survive_close_evict_and_rebind() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-bound");
        remember_owned_sessions(&mut fleet);

        // Close: what `SupervisorMsg::Close` does to the fleet.
        fleet.bindings.remove("t1");
        remove_agent_for_terminal(&mut fleet, &"t1".to_string());
        assert!(fleet.agents.is_empty() && fleet.bindings.is_empty());
        remember_owned_sessions(&mut fleet);
        let ids = owned_session_ids(&fleet);
        assert!(ids.contains("key-t1"), "closed root's session forgotten");
        assert!(ids.contains("sess-bound"), "closed binding forgotten");

        // Evict: a second ad-hoc `claude` on the same terminal replaces the root.
        fleet.agents.insert("t2".to_string(), node("t2", None));
        remember_owned_sessions(&mut fleet);
        evict_prev_root(&mut fleet.agents, &"t2".to_string());
        assert!(owned_session_ids(&fleet).contains("key-t2"));

        // Rebind: the terminal moves on to a newer session.
        fleet
            .bindings
            .insert("t3".to_string(), "sess-old".to_string());
        remember_owned_sessions(&mut fleet);
        fleet
            .bindings
            .insert("t3".to_string(), "sess-new".to_string());
        let ids = owned_session_ids(&fleet);
        assert!(ids.contains("sess-old") && ids.contains("sess-new"));
    }

    #[test]
    fn on_activity_transitions_the_bound_root() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        on_activity(&mut fleet, &"t1".to_string(), "sess-1", AgentStatus::Idle);
        assert_eq!(fleet.agents["t1"].node.status, AgentStatus::Idle);
    }

    #[test]
    fn on_activity_ignores_a_different_session_phantom_nested_claude() {
        // A nested `claude -p`'s Stop carries a DIFFERENT session id than the one
        // bound to this terminal → it must never flip the real root's status.
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        on_activity(
            &mut fleet,
            &"t1".to_string(),
            "other-sess",
            AgentStatus::Idle,
        );
        assert_eq!(fleet.agents["t1"].node.status, AgentStatus::Running);
    }

    #[test]
    fn on_activity_never_revives_a_finished_agent() {
        for finished in [AgentStatus::Done, AgentStatus::Error] {
            let mut fleet = fleet_with_bound_agent(finished, "sess-1");
            on_activity(
                &mut fleet,
                &"t1".to_string(),
                "sess-1",
                AgentStatus::Running,
            );
            assert_eq!(
                fleet.agents["t1"].node.status, finished,
                "a finished agent must stay finished"
            );
        }
    }

    #[test]
    fn on_activity_is_a_noop_when_already_in_that_status() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Idle, "sess-1");
        on_activity(&mut fleet, &"t1".to_string(), "sess-1", AgentStatus::Idle);
        assert_eq!(fleet.agents["t1"].node.status, AgentStatus::Idle);
    }

    #[test]
    fn on_activity_ignores_a_binding_with_no_agent() {
        // Bound terminal, but no agent record (a plain shell, or a torn-down agent):
        // the session matches, so we reach the `get_mut` guard — and it is a no-op.
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        fleet
            .bindings
            .insert("ghost".to_string(), "sess-1".to_string());
        on_activity(
            &mut fleet,
            &"ghost".to_string(),
            "sess-1",
            AgentStatus::Idle,
        );
        assert_eq!(fleet.agents["t1"].node.status, AgentStatus::Running);
        assert!(!fleet.agents.contains_key("ghost"));
    }

    // ── The close confirmation (`terminals_busy`) ────────────────────────────
    //
    // Tier 2 needs a live PTY and is proved two-sided against a real shell in
    // `tests/supervisor_terminal.rs`. What is unit-testable here — and worth
    // pinning here — is the wire shape, tier 1's lookup, and the precedence rule
    // between the tiers.

    /// The frontend is written against these exact literals
    /// (`src/features/terminal/terminalBusyIpc.ts`): camelCase fields, and a
    /// `reason` of `"agent"` / `"command"`. A rename on either side is a silently
    /// broken dialog, so pin the JSON itself rather than the Rust struct.
    #[test]
    fn terminal_busy_matches_the_ts_wire_contract() {
        let agent = TerminalBusy {
            id: "01J0".into(),
            reason: BusyReason::Agent,
            label: "claude".into(),
        };
        assert_eq!(
            serde_json::to_string(&agent).unwrap(),
            r#"{"id":"01J0","reason":"agent","label":"claude"}"#
        );
        let command = TerminalBusy {
            id: "01J1".into(),
            reason: BusyReason::Command,
            label: "zsh".into(),
        };
        assert_eq!(
            serde_json::to_string(&command).unwrap(),
            r#"{"id":"01J1","reason":"command","label":"zsh"}"#
        );
    }

    /// 🔴 A root is born **Idle** and a session parked at its prompt
    /// never emits `Stop`. Gating on `Running` would wave through exactly the
    /// session most likely to be lost — so tier 1 asks "is a session bound", never "is it
    /// mid-turn". Asserted across every status a live agent can wear.
    #[test]
    fn a_bound_session_is_busy_in_every_live_status() {
        for status in [
            AgentStatus::Idle,
            AgentStatus::Running,
            AgentStatus::WaitingInput,
        ] {
            let fleet = fleet_with_bound_agent(status, "sess-1");
            assert_eq!(
                bound_session_label(&fleet, &"t1".to_string(), "zsh").as_deref(),
                Some("t1"),
                "a bound session must be busy while {status:?}"
            );
        }
    }

    /// No binding = no tier-1 answer. This is the plain-shell case, and it is the
    /// half that fails against a build that calls everything busy.
    #[test]
    fn an_unbound_terminal_has_no_bound_session() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        fleet.bindings.clear();
        assert_eq!(bound_session_label(&fleet, &"t1".to_string(), "zsh"), None);
    }

    /// A binding whose agent node is already gone still counts as busy — we would
    /// rather warn about a session we can no longer name than close one silently —
    /// and borrows the terminal's own title as the label.
    #[test]
    fn a_binding_with_no_agent_node_is_busy_under_the_terminal_title() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        fleet
            .bindings
            .insert("ghost".to_string(), "sess-1".to_string());
        assert_eq!(
            bound_session_label(&fleet, &"ghost".to_string(), "zsh").as_deref(),
            Some("zsh")
        );
    }

    /// Tier 1 wins outright: an agent terminal has no shell, so tier 2's answer
    /// there is meaningless and must never overwrite the reason or the label.
    #[test]
    fn tier_1_takes_precedence_over_the_foreground_check() {
        for foreground in [None, Some(false), Some(true)] {
            let busy = classify_busy(
                &"t1".to_string(),
                Some("my agent".to_string()),
                foreground,
                "zsh",
            )
            .expect("a bound session is always busy");
            assert_eq!(busy.reason, BusyReason::Agent);
            assert_eq!(busy.label, "my agent");
        }
    }

    /// Tier 2 fires only when tier 1 is silent, and labels with the terminal title.
    #[test]
    fn a_foreground_command_is_busy_under_the_terminal_title() {
        let busy = classify_busy(&"t1".to_string(), None, Some(true), "zsh")
            .expect("a running foreground command is busy");
        assert_eq!(busy.id, "t1");
        assert_eq!(busy.reason, BusyReason::Command);
        assert_eq!(busy.label, "zsh");
    }

    /// A shell at its prompt is not busy — and neither is an **unknown** answer
    /// (a `tcgetpgrp` or a Windows process snapshot that had none). Warning about nothing is the
    /// failure that teaches people to click straight through the dialog.
    #[test]
    fn an_idle_or_unknown_foreground_is_not_busy() {
        assert_eq!(
            classify_busy(&"t1".to_string(), None, Some(false), "zsh"),
            None
        );
        assert_eq!(classify_busy(&"t1".to_string(), None, None, "zsh"), None);
    }

    /// No ids in, no ids out — and an id the supervisor has never heard of is
    /// absent from the result, never an error.
    #[test]
    fn empty_and_unknown_ids_yield_an_empty_result() {
        let fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        assert!(busy_terminals(&fleet, &[]).is_empty());
        assert!(busy_terminals(&fleet, &["no-such-terminal".to_string()]).is_empty());
        // Even a *bound* id is absent when no terminal backs it: the binding table
        // can outlive nothing, but the PTY is where the answer comes from.
        assert!(busy_terminals(&fleet, &["t1".to_string()]).is_empty());
    }

    /// M2's reality: a root with no children removes exactly itself.
    #[test]
    fn removing_a_childless_root_removes_only_it() {
        let mut agents = forest(&[("root", None), ("other-root", None)]);
        remove_agent_subtree(&mut agents, &"root".to_string());
        assert!(!agents.contains_key("root"));
        assert!(
            agents.contains_key("other-root"),
            "an unrelated root was removed"
        );
    }

    /// M3's cascade: closing a root drops its whole sub-tree, at any depth, while
    /// leaving sibling trees untouched.
    #[test]
    fn removing_a_root_cascades_to_the_whole_subtree() {
        // root ─ child_a ─ grandchild
        //      └ child_b
        // sibling (separate tree) must survive.
        let mut agents = forest(&[
            ("root", None),
            ("child_a", Some("root")),
            ("child_b", Some("root")),
            ("grandchild", Some("child_a")),
            ("sibling", None),
        ]);

        remove_agent_subtree(&mut agents, &"root".to_string());

        for gone in ["root", "child_a", "child_b", "grandchild"] {
            assert!(
                !agents.contains_key(gone),
                "{gone} should have been removed"
            );
        }
        assert!(
            agents.contains_key("sibling"),
            "an unrelated tree was removed"
        );
        assert_eq!(agents.len(), 1);
    }

    /// Removing a non-root only takes its own branch — the parent and siblings stay.
    #[test]
    fn removing_a_mid_tree_node_leaves_the_rest() {
        let mut agents = forest(&[
            ("root", None),
            ("child_a", Some("root")),
            ("child_b", Some("root")),
            ("grandchild", Some("child_a")),
        ]);

        remove_agent_subtree(&mut agents, &"child_a".to_string());

        assert!(agents.contains_key("root"));
        assert!(agents.contains_key("child_b"));
        assert!(!agents.contains_key("child_a"));
        assert!(
            !agents.contains_key("grandchild"),
            "the branch under child_a must go too"
        );
    }

    // ── The binding discriminator: ad-hoc root vs phantom root ───────────────
    //
    // This pure function is the crux — the phantom-root trap lives or dies here —
    // so its four cases are pinned directly, in addition to the end-to-end
    // integration tests.

    #[test]
    fn unbound_known_terminal_becomes_a_root() {
        assert_eq!(
            classify_session_start(true, None, "sess-1"),
            BindDecision::CreateRoot,
            "first claude in a plain terminal is an ad-hoc root"
        );
    }

    #[test]
    fn a_different_session_on_a_bound_terminal_is_suppressed() {
        // The phantom-root trap: a nested `claude -p` reports a NEW session on a
        // terminal already bound to its parent. Must NOT become a second root.
        assert_eq!(
            classify_session_start(true, Some("parent-sess"), "nested-sess"),
            BindDecision::Suppress
        );
    }

    #[test]
    fn the_same_session_re_announcing_is_a_no_op() {
        // A spawned agent's own SessionStart: terminal bound at spawn to this very
        // session. Not a new node — just re-announcing.
        assert_eq!(
            classify_session_start(true, Some("sess-1"), "sess-1"),
            BindDecision::ReAnnounce
        );
    }

    #[test]
    fn an_unknown_terminal_is_ignored() {
        // Only our PTYs carry the env; a POST for a terminal we don't have binds
        // nothing (defensive against a stale/forged terminal id).
        assert_eq!(
            classify_session_start(false, None, "sess-1"),
            BindDecision::Ignore
        );
        assert_eq!(
            classify_session_start(false, Some("x"), "sess-1"),
            BindDecision::Ignore
        );
    }

    /// **Re-insert must abort the previous root's tailer.**
    /// A dropped `JoinHandle` detaches, so `evict_prev_root` has to `.abort()` it. We
    /// prove the abort *lands* by watching a real tailer task: it bumps a counter
    /// each tick, and that must freeze once evicted.
    #[tokio::test]
    async fn evicting_a_prev_root_aborts_its_live_tailer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        let ticks = Arc::new(AtomicUsize::new(0));
        let counter = ticks.clone();
        // A stand-in for the fan-out tailer: a never-ending task on tauri's runtime
        // (exactly where `start_fanout_tailer` spawns the real one).
        let handle = tauri::async_runtime::spawn(async move {
            loop {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });

        let mut prev = node("term-1", None);
        prev.tailer = Some(handle);
        let mut agents: HashMap<AgentId, AgentRuntime> = HashMap::new();
        agents.insert("term-1".to_string(), prev);

        // It is actually running.
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(ticks.load(Ordering::SeqCst) > 0, "the tailer never ran");

        evict_prev_root(&mut agents, &"term-1".to_string());
        assert!(
            !agents.contains_key("term-1"),
            "the previous root was not evicted from the forest"
        );

        // Give the abort time to land at the task's next await, then confirm ticking
        // has stopped — a leaked (merely-dropped) handle would keep counting.
        tokio::time::sleep(Duration::from_millis(30)).await;
        let frozen = ticks.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            frozen,
            "the evicted tailer kept polling — abort did not cancel it"
        );
    }

    // ── Symlink guard on the ad-hoc hook write ───────────────────────────────
    //
    // Unix-only: they build symlinks. `read`/`create_dir_all`/`write` all follow
    // symlinks and `is_home_dir` only checks the *source* cwd, so a repo shipping
    // `.claude -> ~/.claude` (or a symlinked settings file) could redirect our
    // hook write into the user's global config. `write_merged_settings` must
    // refuse to write through a symlink (skip, non-fatal — like the home guard).

    /// Real settings under a temp cwd get written — the guard doesn't over-block.
    #[cfg(unix)]
    #[test]
    fn a_plain_claude_dir_is_written_normally() {
        let base =
            std::env::temp_dir().join(format!("agentstudio-symguard-plain-{}", ulid::Ulid::new()));
        let cwd = base.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();

        // The marker is a substring of our hook *command* (idempotency key), so it
        // must live inside the additions to appear in the written file.
        let additions = serde_json::json!({
            "hooks": { "SessionStart": [
                {"hooks": [{"type": "command", "command": "echo hi # MARKER-plain"}]}
            ]}
        });
        write_merged_settings(&cwd, &additions, "MARKER-plain").expect("write should succeed");

        let written = cwd.join(".claude/settings.local.json");
        assert!(written.exists(), "a plain .claude must be written");
        assert!(std::fs::read_to_string(&written)
            .unwrap()
            .contains("MARKER-plain"));

        std::fs::remove_dir_all(&base).ok();
    }

    /// A symlinked `.claude` **directory** (the global-config bypass) must not be
    /// followed: nothing is written to the link's target.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_claude_dir_is_never_written_through() {
        let base =
            std::env::temp_dir().join(format!("agentstudio-symguard-dir-{}", ulid::Ulid::new()));
        // `target` stands in for the victim (e.g. ~/.claude); `cwd/.claude` links to it.
        let target = base.join("victim-global");
        let cwd = base.join("repo");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        std::os::unix::fs::symlink(&target, cwd.join(".claude")).unwrap();

        let additions = serde_json::json!({ "hooks": { "SessionStart": [] } });
        // Non-fatal: the install just skips, exactly like the home-dir guard bails.
        write_merged_settings(&cwd, &additions, "MARKER-attack").expect("skip must not error");

        assert!(
            !target.join("settings.local.json").exists(),
            "wrote through a symlinked .claude into the link target!"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// A real `.claude` dir but a symlinked `settings.local.json` **file** must not
    /// be followed either — the guard checks the file, not only the directory.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_settings_file_is_never_written_through() {
        let base =
            std::env::temp_dir().join(format!("agentstudio-symguard-file-{}", ulid::Ulid::new()));
        let victim = base.join("victim.json");
        let cwd = base.join("repo");
        let dir = cwd.join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        // A real global settings file the attacker wants us to clobber.
        std::fs::write(&victim, "{\"untouched\":true}").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("settings.local.json")).unwrap();

        let additions = serde_json::json!({ "hooks": { "SessionStart": [] } });
        write_merged_settings(&cwd, &additions, "MARKER-file").expect("skip must not error");

        // The victim file is byte-for-byte untouched (no merge written through it).
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "{\"untouched\":true}",
            "wrote through a symlinked settings file"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ── Terminal cwd tracking: change detection + routed install ───────────────
    //
    // The poller reads a real process cwd (unit-tested in `pty::cwd`), then routes
    // *changes* to the actor, which installs at the new git root via the EXISTING
    // `install_ad_hoc_hooks` — never a new settings path, never `~/.claude`. The
    // change decision is a pure function (`cwd_moved`), and the routed install
    // (`on_cwd_changed`) is exercised against a temp repo below.

    use crate::agent::adapter::AgentSpawn;

    /// A minimal adapter that only carries an ad-hoc hook (the two methods
    /// `install_ad_hoc_hooks` reads). Its `spawn` is never called here.
    struct HookTestAdapter;
    impl AgentAdapter for HookTestAdapter {
        fn id(&self) -> &'static str {
            "cwd-hook-test"
        }
        fn default_title(&self) -> &'static str {
            "cwd-hook-test"
        }
        fn spawn(&self, _req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
            anyhow::bail!("HookTestAdapter::spawn is not used in these tests")
        }
        fn ad_hoc_hook_settings(&self) -> Option<serde_json::Value> {
            Some(serde_json::json!({
                "hooks": { "SessionStart": [
                    {"hooks": [{"type": "command", "command": "echo hi # cwd-hook-marker"}]}
                ]}
            }))
        }
        fn hook_marker(&self) -> Option<&'static str> {
            Some("cwd-hook-marker")
        }
    }

    /// A fleet with the ad-hoc pipeline enabled (a listener config + the hook
    /// adapter) but no terminals — enough to drive `on_cwd_changed`'s install.
    fn fleet_with_hook(hook: Option<HookConfig>) -> Fleet {
        Fleet {
            terminals: HashMap::new(),
            agents: HashMap::new(),
            bindings: HashMap::new(),
            owned_sessions: std::collections::HashSet::new(),
            adapters: vec![Arc::new(HookTestAdapter) as Arc<dyn AgentAdapter>],
            sink: Arc::new(crate::events::NullSink),
            hook,
            logs: None,
            ide: IdeTerminals::default(),
            restart: Restart::default(),
        }
    }

    /// The table dev-app discovery reads — keyed by the real PTY child's pid, the
    /// real slave tty, and the agent lent **only while the terminal is bound**.
    #[cfg(unix)]
    #[test]
    fn the_published_terminal_table_lends_the_agent_only_while_bound() {
        let mut fleet = fleet_with_hook(None);
        let (tx, _rx) = mpsc::channel(8);
        let cwd = std::env::temp_dir().display().to_string();
        let meta = open_terminal(
            &mut fleet,
            &tx,
            OpenParams {
                terminal_id: "t1".to_string(),
                kind: TerminalKind::AgentTerminal,
                title: "sh".to_string(),
                agent_id: Some("t1".to_string()),
                spec: SpawnSpec {
                    program: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), "sleep 30".to_string()],
                    cwd: cwd.clone().into(),
                    env: Vec::new(),
                    rows: 24,
                    cols: 80,
                },
                cwd,
            },
            Channel::new(|_| Ok(())),
        )
        .expect("open /bin/sh in a pty");
        let mut agent = node("t1", None);
        agent.node.title = "claude".to_string();
        fleet.agents.insert("t1".to_string(), agent);
        let pid = fleet.terminals[&meta.id]
            .pty
            .as_ref()
            .and_then(|p| p.child_pid())
            .expect("a child pid");

        publish_ide_terminals(&fleet);
        let snap = fleet.ide.snapshot();
        assert_eq!(snap.len(), 1);
        let t = &snap[&pid];
        assert_eq!(t.terminal_id, "t1");
        assert_eq!(t.title, "sh");
        assert!(
            t.tty.as_deref().is_some_and(|p| p.starts_with("/dev/")),
            "the slave device: {:?}",
            t.tty
        );
        assert_eq!(t.agent_id, None, "not bound: no agent lent");

        fleet.bindings.insert("t1".to_string(), "sess".to_string());
        publish_ide_terminals(&fleet);
        let t = fleet.ide.snapshot()[&pid].clone();
        assert_eq!(t.agent_id.as_deref(), Some("t1"));
        assert_eq!(t.agent_title.as_deref(), Some("claude"));

        // Child gone (`pty: None`): its pid may be reused — off the table.
        fleet.terminals.get_mut(&meta.id).unwrap().pty = None;
        publish_ide_terminals(&fleet);
        assert!(fleet.ide.snapshot().is_empty());
        if let Some(rt) = fleet.terminals.remove(&meta.id) {
            rt.pump.abort();
            rt.cwd_poll.abort();
        }
    }

    fn dummy_hook_config() -> HookConfig {
        HookConfig {
            base_url: "http://127.0.0.1:1".to_string(),
            token: "test-token".to_string(),
        }
    }

    /// The pure change decision: only a *different, readable* cwd is a change. A
    /// `None` reading (dead pid / unsupported platform) is never a change and never
    /// clobbers the last-known cwd.
    #[test]
    fn cwd_moved_reports_only_real_changes() {
        use std::path::{Path, PathBuf};
        let a = Path::new("/tmp/a");
        let b = Path::new("/tmp/b");
        // First reading (no prior) counts as a change.
        assert_eq!(cwd_moved(None, Some(a)), Some(PathBuf::from("/tmp/a")));
        // Same dir → not a change (the common per-tick case).
        assert_eq!(cwd_moved(Some(a), Some(a)), None);
        // Different dir → a change, reporting the new cwd.
        assert_eq!(cwd_moved(Some(a), Some(b)), Some(PathBuf::from("/tmp/b")));
        // A failed reading is never a change, whatever the prior state.
        assert_eq!(cwd_moved(Some(a), None), None);
        assert_eq!(cwd_moved(None, None), None);
    }

    /// **The cwd-tracking core:** a changed cwd installs the ad-hoc hook at the new
    /// cwd's **git root** (not the subdir), and re-reading the same cwd is not a
    /// change (so no redundant work). Everything lands in the temp repo — never
    /// `~/.claude`.
    #[test]
    fn a_cwd_change_installs_the_hook_at_its_git_root() {
        // A temp repo (a bare `.git` dir is enough — `git_root` reads it directly),
        // plus a nested subdir the shell `cd`s into. Canonicalize so the git walk-up
        // compares like-for-like (macOS /tmp → /private/tmp).
        let base = std::env::temp_dir().join(format!("agentstudio-cwd47-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let repo = base.join("repo");
        let nested = repo.join("crate/src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let fleet = fleet_with_hook(Some(dummy_hook_config()));
        let at_root = repo.join(".claude/settings.local.json");
        let at_subdir = nested.join(".claude/settings.local.json");

        // The poller starts with no last cwd; the user `cd`s into the nested subdir.
        let moved = cwd_moved(None, Some(&nested)).expect("first reading is a change");
        assert_eq!(moved, nested);
        on_cwd_changed(&fleet, &moved.to_string_lossy());

        assert!(
            at_root.is_file(),
            "the hook must be installed at the repo's git root"
        );
        assert!(
            !at_subdir.exists(),
            "the hook must NOT be installed in the subdir the shell is in"
        );
        assert!(std::fs::read_to_string(&at_root)
            .unwrap()
            .contains("cwd-hook-marker"));

        // Staying put is not a change → the poller would send nothing.
        assert!(
            cwd_moved(Some(&nested), Some(&nested)).is_none(),
            "an unchanged cwd must not be re-installed"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    /// Without a running listener the hook is inert, so a cwd change is a no-op — it
    /// must write nothing (mirrors `ensure_agent_hooks`'s no-listener contract).
    #[test]
    fn on_cwd_changed_without_a_listener_writes_nothing() {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-cwd47-nohook-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();

        let fleet = fleet_with_hook(None); // no listener
        on_cwd_changed(&fleet, &dir.to_string_lossy());

        assert!(
            !dir.join(".claude/settings.local.json").exists(),
            "no listener means no hook file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **Safety: a `cd` into `~` never writes the user's global config.** The cwd
    /// path reuses the same `is_home_dir` guard as spawn, so `<home>/.claude/` is
    /// never touched — the hard constraint behind cwd tracking.
    #[cfg(unix)]
    #[test]
    fn a_cwd_change_into_home_never_writes_global_config() {
        let home = std::env::var("HOME").expect("HOME set");
        let settings = std::path::Path::new(&home).join(".claude/settings.local.json");
        let before = std::fs::read_to_string(&settings).ok();

        let fleet = fleet_with_hook(Some(dummy_hook_config()));
        on_cwd_changed(&fleet, &home);

        let after = std::fs::read_to_string(&settings).ok();
        assert_eq!(
            before, after,
            "a cd into ~ touched the user's global Claude config"
        );
    }

    /// **Safety: nothing under `~/.claude` is ever a hook target** — a `cd ~/.claude`
    /// used to write `~/.claude/.claude/settings.local.json`. Driven with a fake home so
    /// the real one is never involved.
    #[test]
    fn nothing_under_dot_claude_is_a_hook_target() {
        let home = std::env::temp_dir().join(format!("agentstudio-fakehome-{}", ulid::Ulid::new()));
        let inside = home.join(".claude/projects/-x");
        let project = home.join("projects/todo-api");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&project).unwrap();

        assert!(forbidden_hook_target(&home.join(".claude"), Some(&home)));
        assert!(forbidden_hook_target(&inside, Some(&home)));
        assert!(!forbidden_hook_target(&project, Some(&home)));
        std::fs::remove_dir_all(&home).ok();
    }

    /// **Safety: a directory other users can write to is never a hook target** (the
    /// `/tmp/.claude` swap-in scenario).
    #[cfg(unix)]
    #[test]
    fn a_world_writable_dir_is_not_a_hook_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("agentstudio-ww-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!forbidden_hook_target(&dir, None));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(forbidden_hook_target(&dir, None));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The merged write replaces a symlink planted at the target instead of writing
    /// through it (it was already refused up front; this proves the rename path too).
    #[cfg(unix)]
    #[test]
    fn the_settings_write_never_follows_a_symlinked_temp_file() {
        let dir = std::env::temp_dir().join(format!("agentstudio-tmp-sym-{}", ulid::Ulid::new()));
        let victim = dir.join("victim.txt");
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(
            &victim,
            dir.join(".claude/.settings.local.json.agentstudio-tmp"),
        )
        .unwrap();

        let additions = serde_json::json!({"hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": "true # agentstudio-marker"}]}
        ]}});
        write_merged_settings(&dir, &additions, "agentstudio-marker").unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        assert!(dir.join(".claude/settings.local.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── open agents come back after a restart (phase 1, `open_agents.rs`) ────────

    /// The shutdown write's facts: a turn in flight is `running` OR `waiting_input`
    /// (blocked on a permission prompt — the quit interrupts it all the same). Ad-hoc
    /// roots and sub-agents are not in the registry, so they are not reported.
    #[test]
    fn working_at_shutdown_counts_turns_in_flight_on_spawned_roots_only() {
        let mut fleet = fleet_with_bound_agent(AgentStatus::Running, "sess-1");
        for (id, status) in [
            ("asking", AgentStatus::WaitingInput),
            ("idle", AgentStatus::Idle),
            ("done", AgentStatus::Done),
            ("failed", AgentStatus::Error),
        ] {
            let mut n = node(id, None);
            n.node.status = status;
            fleet.agents.insert(id.to_string(), n);
        }
        let mut adhoc = node("typed", None);
        adhoc.is_ad_hoc = true;
        fleet.agents.insert("typed".to_string(), adhoc);
        let mut sub = node("sub", Some("t1"));
        sub.terminal_id = None;
        fleet.agents.insert("sub".to_string(), sub);

        let got = working_at_shutdown(&fleet);
        let want: HashMap<String, bool> = [
            ("t1", true),
            ("asking", true),
            ("idle", false),
            ("done", false),
            ("failed", false),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        assert_eq!(got, want);
    }
}
