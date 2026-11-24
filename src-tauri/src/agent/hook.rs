//! Runtime-agnostic types for the ad-hoc-agent detection pipeline.
//!
//! The supervisor and the listener speak only these; anything Claude-specific (the
//! hook command string, the settings-file shape, the payload schema) stays behind
//! `AgentAdapter`. An aider/codex adapter supplies its own hook install
//! and its own parse, and reuses this vocabulary unchanged.
//!
//! # The env we inject into every PTY
//!
//! These names are **ours**, not any runtime's — a runtime's hook command reads
//! them, but the injection is generic infra (`supervisor` injects them on every
//! PTY, plain or agent). That is what lets a `claude` the user *types* into a
//! plain shell phone home: it inherits our env because we own the PTY.

/// The terminal's `TerminalId`. A hook echoes it back so we know which of our PTYs
/// the session is running in — the id we *dictate* (adapter.rs's philosophy), since
/// for a bare `claude` we cannot dictate the session id.
pub const ENV_TERMINAL_ID: &str = "AGENTSTUDIO_TERMINAL_ID";

/// This app instance's callback base URL (ephemeral port). Per-instance, so two
/// running apps never cross-bind (FM-2): each instance's PTYs phone home to that
/// instance's own listener.
pub const ENV_HOOK_URL: &str = "AGENTSTUDIO_HOOK_URL";

/// Per-launch secret. The hook echoes it; the listener rejects anything without
/// it. Without this, any local process could POST a phantom agent into the rail.
/// Verified against real `claude`: the hook reads this from the
/// injected env and sends it back.
pub const ENV_HOOK_TOKEN: &str = "AGENTSTUDIO_HOOK_TOKEN";

/// HTTP header the hook carries the token in.
pub const HEADER_TOKEN: &str = "X-AgentStudio-Token";
/// HTTP header the hook carries the terminal id in.
pub const HEADER_TERMINAL: &str = "X-AgentStudio-Terminal";

/// A runtime session-lifecycle event, parsed by an adapter from a hook payload.
///
/// This is the *whole* Claude-to-core contract for detection: the supervisor binds
/// and unbinds on these, and never sees the runtime's raw payload schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub kind: SessionEventKind,
    /// The runtime's own session id (for `claude`, the `session_id`). Becomes the
    /// bound value in the terminal→session table and the ad-hoc agent's
    /// `SessionKey`.
    pub session_id: String,
    /// Absolute path to the transcript the runtime is writing. Present on `Start`;
    /// may be absent on `End`. Stored for M3's tailer so it never has to *compute*
    /// a path (the cwd→dir mangling is dead — `claude` resolves symlinks).
    pub transcript_path: Option<String>,
    /// The session's own working directory, from the payload's `cwd`. This is the
    /// directory the runtime is **actually** running in — which is NOT necessarily
    /// the terminal's spawn cwd: a user may `cd` elsewhere before typing `claude`.
    /// The supervisor prefers this over the terminal's meta cwd when
    /// promoting an ad-hoc root, falling back to the meta cwd when it is absent.
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEventKind {
    /// Session birth — the bind signal. Fires once, carries stable identity, and
    /// (decisively) fires even under `--dangerously-skip-permissions`.
    Start,
    /// Session end — one of the two unbind signals (the other is PTY child exit,
    /// which we own, because `SessionEnd` is not guaranteed on a hard kill).
    End,
    /// A turn began — the user submitted a prompt, so the agent is now working
    /// (`UserPromptSubmit`). → `AgentStatus::Running` (the real idle/running signal).
    Busy,
    /// A turn ended — the agent finished responding and is parked at its prompt
    /// (`Stop`). → `AgentStatus::Idle`. This is the signal that was missing, so a
    /// root agent's pill was latched on "Running" forever.
    Idle,
    /// The agent is blocked awaiting the user — a permission prompt or an input
    /// request (`Notification`). → `AgentStatus::WaitingInput`.
    AwaitingInput,
}
